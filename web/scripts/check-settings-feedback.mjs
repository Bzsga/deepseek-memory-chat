import { customEndpointFixture, destination, customModel, openAdvancedChat } from './fixtures/custom-chat-ui.mjs'
import assert from 'node:assert/strict'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

// Run with a local production bundle and a Playwright installation.
const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const chatApiOnly = process.argv.includes('--chat-api-only')
const dist = resolve(process.argv.slice(2).find(arg => arg !== '--chat-api-only') || fileURLToPath(new URL('../dist', import.meta.url)))
const origin = 'https://feedback.example.test'
const user = { id: 'feedback-qa', username: '合成测试', role: 'user', managed_eligible: false }
const quota = { user_weekly_remaining: 20, reset_at: '2026-11-23T00:00:00Z' }
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }
let enabled = false
let generation = 0
let delay = 0
let scopes = { conversations: true, preferences: true }
const blocked = []
const forbiddenSync = []
const syncRequests = []
const apiKey = 'sk-00000000000000000000000000000000'
const phrase = 'synthetic restore phrase 123'
const wrongPhrase = 'different synthetic phrase 987'
const documents = new Map()
const custom = customEndpointFixture(apiKey)
async function localCredential(page) {
  return page.evaluate(async () => {
    const request = req => new Promise((ok, fail) => { req.onsuccess = () => ok(req.result); req.onerror = () => fail(req.error) })
    const dbName = (await indexedDB.databases()).find(db => db.name.endsWith('chat-provider-vault'))?.name
    if (!dbName) return null
    const db = await request(indexedDB.open(dbName))
    try {
      const store = db.transaction('entries').objectStore('entries')
      const [record, wrap] = await Promise.all([request(store.get('credential')), request(store.get('key'))])
      if (!record) return null
      const additionalData = new TextEncoder().encode(dbName + ':aes-gcm:v1')
      return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM', iv:record.iv, additionalData}, wrap.key, record.ciphertext))
    } finally { db.close() }
  })
}
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND'] })
async function checkSettingsFeedback() {
  const serve = async route => {
    const url = new URL(route.request().url())
    if (await custom.serve(route)) return
    const path = url.pathname
    const wire = JSON.stringify([url.href, route.request().headers(), route.request().postData()])
    assert.ok([apiKey, phrase, wrongPhrase].every(secret => !wire.includes(secret)), 'Fixture key or recovery phrase transmitted in clear')
    const json = data => route.fulfill({ json: data })
    if (url.origin === origin) {
      if (path.startsWith('/deepseek/')) {
        const file = resolve(dist, path.slice('/deepseek/'.length) || 'index.html')
        assert.ok(file.startsWith(dist + sep))
        return route.fulfill({ body: await readFile(file), contentType: mime[extname(file)] || 'application/octet-stream' })
      }
      if (path === '/deepseek-api/chat/api/runtime') return json({ provider: 'DeepSeek', model: 'synthetic', user, features: {}, weekly_quota: quota })
      if (path === '/deepseek-api/chat/api/quota') return json(quota)
      if (path === '/deepseek-api/chat/api/redeem-invite' && route.request().method() === 'POST') {
        assert.deepEqual(route.request().postDataJSON(), { invitation_code: 'SYNTHETIC-INVITE' })
        user.managed_eligible = true
        return json({ user, quota })
      }
      const syncPath = '/deepseek-api/chat/api/conversation-sync'
      const method = route.request().method()
      if (!user.managed_eligible && (
        path.startsWith(syncPath + '/') || (path === syncPath && method === 'PATCH' && route.request().postDataJSON().enabled)
      )) {
        forbiddenSync.push(path)
        return route.fulfill({status:403, json:{error:{code:'sync_invitation_required', message:'云同步需要邀请码资格。'}}})
      }
      if (path === syncPath) {
        if (method === 'PATCH') {
          const change = route.request().postDataJSON()
          assert.equal(change.expected_generation, generation)
          enabled = change.enabled
          scopes = change.scopes ?? scopes
          generation++
        }
        if (method === 'DELETE') { enabled = false; generation++; documents.clear() }
        return json({ eligible: user.managed_eligible, enabled, generation, sequence: 0, scopes })
      }
      if (['/deepseek-api/chat/api/conversation-sync/preferences', '/deepseek-api/chat/api/conversation-sync/key-envelope'].includes(path)) {
        syncRequests.push(path)
        if (path.endsWith('/preferences')) {
          assert.equal(scopes.preferences && enabled, true)
          await new Promise(resolveDelay => setTimeout(resolveDelay, delay))
        }
        const doc = documents.get(path) || { revision: 0, value: null }
        const change = route.request().postDataJSON()
        if (!enabled || Number(change?.generation ?? url.searchParams.get('generation')) !== generation || (change && change.expected_revision !== doc.revision)) return route.fulfill({status:409, json:{error:{message:'stale'}}})
        if (change) {
          doc.revision++
          doc.value = change.value ?? null
          documents.set(path, doc)
        }
        return json({generation, ...doc})
      }
      if (path === '/deepseek-api/chat/api/conversation-sync/index') {
        syncRequests.push(path)
        assert.equal(scopes.conversations && enabled, true)
        await new Promise(resolveDelay => setTimeout(resolveDelay, delay))
        return json({ generation, entries: [], cursor: 0, has_more: false })
      }
      if (path === '/favicon.ico') return route.fulfill({ status: 204 })
    }
    blocked.push(path)
    return route.abort()
  }
  async function newDevice(viewport) {
    const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block', viewport })
    await context.route('**/*', serve)
    return context.newPage()
  }
  async function newAndroidDevice() {
    const context = await browser.newContext({ ...devices['Pixel 7'], locale: 'zh-CN', serviceWorkers: 'block' })
    await context.route('**/*', serve)
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    return page
  }
  const guest = await newAndroidDevice()
  try {
    await guest.route(origin + '/deepseek-api/chat/api/runtime', route => route.fulfill({ status: 401 }))
    const officialMessages = 'https://api.deepseek.com/anthropic/v1/messages'
    await guest.route(officialMessages, route => route.fulfill({
      status: 401,
      json: { type: 'error', error: { type: 'authentication_error', message: 'Synthetic invalid API key' } },
    }))
    const chatPosts = []
    guest.on('request', request => {
      if (request.method() === 'POST' && /\/(?:messages|chat\/completions)$/.test(new URL(request.url()).pathname)) {
        chatPosts.push(request.url())
      }
    })
    await guest.goto(origin + '/deepseek/')
    const draft = guest.getByPlaceholder('请输入消息')
    const send = guest.getByRole('button', { name: '发送', exact: true })
    const dialog = guest.getByRole('dialog', { name: '聊天 API', exact: true })
    const close = dialog.getByRole('button', { name: '关闭', exact: true })
    const message = '在没有聊天 API 时保留这段草稿。'
    await draft.fill(message)
    await send.tap()
    await dialog.getByPlaceholder('输入个人 DeepSeek API Key').waitFor()
    assert.equal(await guest.getByRole('dialog').count(), 1)
    assert.equal(new URL(guest.url()).hash, '')
    assert.deepEqual(chatPosts, [])
    await close.tap()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await draft.inputValue(), message)

    await send.tap()
    await dialog.getByPlaceholder('输入个人 DeepSeek API Key').fill(apiKey)
    await dialog.getByRole('button', { name: '保存服务设置', exact: true }).tap()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await draft.inputValue(), message)
    assert.deepEqual(chatPosts, [])
    await send.tap()
    await dialog.getByPlaceholder('留空保留已保存的 Key').waitFor()
    assert.equal(await guest.getByRole('dialog').count(), 1)
    assert.deepEqual(chatPosts, [officialMessages])
    await close.tap()
    await dialog.waitFor({ state: 'hidden' })
    await guest.getByText('个人聊天 API 未通过验证，请检查或更换 API Key。', { exact: true }).first().waitFor()
    await guest.getByText(message, { exact: true }).first().waitFor()
    await draft.waitFor()
    assert.equal(await draft.inputValue(), '')
    assert.equal(new URL(guest.url()).pathname, '/deepseek/')
    assert.deepEqual(chatPosts, [officialMessages])
    assert.deepEqual(blocked, [])
    console.log('PASS: mobile guest missing chat API preserves the draft without POST; personal API 401 opens settings in chat and keeps the original message without replay')
  } finally {
    await guest.context().close()
  }

  const managed = await newAndroidDevice()
  try {
    const permissions = { chat_api: true, image_api: false, cloud_sync: false }
    await managed.route(origin + '/deepseek-api/chat/api/runtime', route => route.fulfill({
      json: { provider: 'DeepSeek', model: 'synthetic', user: { ...user, permissions }, features: {}, weekly_quota: quota },
    }))
    const failures = []
    let responseCode = 'synthetic_gateway_failure'
    await managed.route(origin + '/deepseek-api/chat/anthropic/v1/messages', route => {
      assert.equal(route.request().method(), 'POST')
      failures.push(responseCode)
      return route.fulfill({ status: 502, json: { error: { code: responseCode, message: 'Synthetic managed failure' } } })
    })
    await managed.goto(origin + '/deepseek/')
    const draft = managed.getByPlaceholder('请输入消息')
    const send = managed.getByRole('button', { name: '发送', exact: true })
    await draft.fill('普通 502 不应打开配置。')
    await send.tap()
    await managed.getByText('服务器繁忙，请稍后再试', { exact: true }).first().waitFor()
    assert.equal(await managed.getByRole('dialog').count(), 0)

    responseCode = 'managed_chat_unavailable'
    await draft.fill('配套聊天不可用时可以改用个人 API。')
    await send.tap()
    const dialog = managed.getByRole('dialog', { name: '聊天 API', exact: true })
    await dialog.getByText('配套聊天 API 暂不可用，你可以改用个人聊天 API。', { exact: true }).waitFor()
    await dialog.getByPlaceholder('输入个人 DeepSeek API Key').waitFor()
    assert.equal(await dialog.getByRole('radio', { name: '个人 DeepSeek', exact: true }).getAttribute('aria-checked'), 'true')
    assert.deepEqual(failures, ['synthetic_gateway_failure', 'managed_chat_unavailable'])
    assert.deepEqual(blocked, [])
    console.log('PASS: ordinary managed API 502 stays in chat; managed_chat_unavailable opens the personal API option')
  } finally {
    await managed.context().close()
  }
  if (chatApiOnly) return

  const mobile = await newDevice({width:390,height:844})
  await mobile.goto(origin + '/deepseek/')
  await mobile.getByRole('button', {name:'打开边栏',exact:true}).click()
  await mobile.getByRole('button', {name:'设置',exact:true}).click()
  assert.equal(await mobile.getByRole('dialog').count(), 1)
  await openAdvancedChat(mobile)
  assert.equal(await mobile.getByRole('dialog').count(), 1)
  const mobileBase = mobile.getByPlaceholder('https://api.deepseek.com')
  await mobileBase.fill('https://discard.invalid')
  const focusOutline = await mobileBase.evaluate(el => {
    const { outlineStyle, outlineWidth, outlineOffset } = getComputedStyle(el)
    return { style: outlineStyle, width: parseFloat(outlineWidth), offset: parseFloat(outlineOffset) }
  })
  assert.equal(focusOutline.style, 'solid')
  assert.ok(focusOutline.width > 0 && focusOutline.width + focusOutline.offset <= 0)
  await mobile.keyboard.press('Escape')
  const basic = mobile.getByRole('dialog', {name:'聊天 API',exact:true})
  await basic.waitFor()
  assert.equal(await mobile.getByRole('dialog').count(), 1)
  const advancedTrigger = basic.getByRole('button', {name:'高级 API 设置',exact:true})
  await advancedTrigger.and(mobile.locator(':focus')).waitFor()
  await advancedTrigger.click()
  assert.equal(await mobile.getByPlaceholder('https://api.deepseek.com').inputValue(), '')
  await mobile.keyboard.press('Escape')
  await advancedTrigger.and(mobile.locator(':focus')).waitFor()
  await mobile.keyboard.press('Escape')
  await mobile.getByRole('dialog', {name:'设置',exact:true}).waitFor()
  assert.equal(await mobile.getByRole('dialog').count(), 1)
  await mobile.context().close()
  const integration = await newDevice()
  integration.setDefaultTimeout(8000)
  await custom.exercise(integration, origin)
  await integration.context().close()
  const page = await newDevice()
  page.setDefaultTimeout(8000)
  const button = name => page.getByRole('button', { name, exact: true })
  const toast = text => page.getByRole('status').filter({ hasText: text }).and(page.locator('div')).filter({ has: page.locator('span') })
  await page.goto(origin + '/deepseek/')
  await button('设置').click()
  await page.getByText('数据管理', {exact:true}).click()
  const toggle = page.getByRole('switch', { name: '多端同步', exact:true })
  await page.getByText('此账号未开通云同步，可联系管理员。', {exact:true}).waitFor()
  assert.equal(await toggle.isDisabled(), true)
  assert.equal(await button('清除云端数据').count(), 0)
  await page.getByRole('tab', { name: '通用设置', exact: true }).click()
  const advanced = await openAdvancedChat(page)
  const keyField = advanced.getByPlaceholder('输入个人 DeepSeek API Key')
  assert.equal(await keyField.getAttribute('type'), 'text')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await keyField.focus()
  await page.evaluate(async () => {
    const viewport = window.visualViewport
    Object.defineProperty(viewport, 'height', { value: 320, configurable: true })
    viewport.dispatchEvent(new Event('resize'))
    await new Promise(requestAnimationFrame)
    document.activeElement.blur()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const duringKeyboardClose = await advanced.boundingBox()
  assert.ok(duringKeyboardClose && duringKeyboardClose.y + duringKeyboardClose.height <= 320)
  await page.evaluate(() => {
    delete window.visualViewport.height
    window.visualViewport.dispatchEvent(new Event('resize'))
  })
  await keyField.fill(apiKey)
  await advanced.getByPlaceholder('https://api.deepseek.com').fill(destination)
  await advanced.locator('input[list]').fill(customModel)
  await advanced.getByRole('button', { name: '保存服务设置', exact: true }).click()
  await toast('个人 API Key 已保存到本机').waitFor()
  await button('配置聊天 API').click()
  await page.getByRole('radio', { name: '使用邀请码' }).click()
  await page.getByLabel('邀请码', {exact:true}).fill('SYNTHETIC-INVITE')
  await button('兑换邀请码').click()
  await toast('邀请码已兑换，账号权限已更新。').waitFor()
  await page.getByRole('radio', {name:'深色'}).click()
  await page.getByText('数据管理', {exact:true}).click()
  await toggle.click()
  const chats = page.getByRole('checkbox', {name:/会话和附件/})
  const prefs = page.getByRole('checkbox', {name:/聊天偏好/})
  await chats.uncheck()
  await prefs.uncheck()
  assert.equal(await button('开启同步').isDisabled(), true)
  await prefs.check()
  await button('开启同步').click()
  await toast('云端同步完成').waitFor()
  await toast('云端同步完成').waitFor({state:'hidden'})
  delay = 1600
  await button('立即同步').click()
  await toast('正在同步云端数据…').waitFor()
  await toast('云端同步完成').waitFor()
  delay = 0
  assert.equal(documents.get('/deepseek-api/chat/api/conversation-sync/preferences').value.themePreference, 'dark')
  assert.deepEqual(scopes, { conversations: false, preferences: true })
  assert.ok(syncRequests.every(path => path.endsWith('/preferences')))
  assert.equal(await button('个人 API Key 备份').count(), 0)
  await button('同步设置').click()
  await button('个人 API Key 备份').click()
  await button('备份本机 Key').click()
  await page.getByLabel('独立恢复口令', {exact:true}).fill(phrase)
  await page.getByLabel('再次输入恢复口令', {exact:true}).fill(phrase)
  await button('备份本机 Key').click()
  await page.getByText('已保存加密备份。').waitFor()
  const envelope = documents.get('/deepseek-api/chat/api/conversation-sync/key-envelope').value
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext','iv','salt','version'])
  assert.notEqual(Buffer.from(envelope.ciphertext, 'base64').toString(), apiKey)
  const other = await newDevice({width:320,height:740})
  other.setDefaultTimeout(8000)
  await other.goto(origin + '/deepseek/')
  const otherSettings = other.getByRole('button', {name:'设置', exact:true})
  if (!await otherSettings.isVisible()) {
    await other.getByRole('button', {name:'打开边栏', exact:true}).click()
  }
  await otherSettings.click()
  await other.locator('[role=radio][aria-checked=true]').filter({hasText:'深色'}).waitFor()
  await other.getByText('数据管理', {exact:true}).click()
  await other.getByRole('button', {name:'同步设置', exact:true}).click()
  const chooser = other.getByRole('dialog', {name:'同步设置', exact:true})
  const bounds = await chooser.boundingBox()
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320 && bounds.height <= 740)
  assert.equal(await chooser.evaluate(el => getComputedStyle(el.parentElement).backdropFilter), 'none')
  await other.getByRole('button', { name:'个人 API Key 备份', exact:true }).click()
  const restore = other.getByRole('button', {name:'恢复并使用个人 Key', exact:true})
  assert.equal(await localCredential(other), null)
  for (const [password, notice] of [[wrongPhrase,'恢复失败，请核对恢复口令和云端备份后重试。'], [phrase,'已恢复并切换到个人 Key。']]) {
    await restore.click()
    await other.getByLabel('独立恢复口令', {exact:true}).fill(password)
    await restore.click()
    await other.getByText(notice, {exact:true}).waitFor()
    const stored = await localCredential(other)
    if (password === phrase) {
      assert.equal(stored[0], '\0')
      assert.deepEqual(JSON.parse(stored.slice(1)), {apiKey,baseUrl:destination,model:customModel})
    } else {assert.equal(stored, null)}
  }
  await page.getByRole('dialog', {name:'个人 API Key 备份'}).getByRole('button', {name:'关闭', exact:true}).click()
  await button('同步设置').click()
  await chats.check()
  await prefs.uncheck()
  await button('保存范围').click()
  await page.getByRole('dialog', {name:'同步设置',exact:true}).waitFor({state:'hidden'})
  assert.deepEqual(scopes, {conversations:true, preferences:false})
  await page.getByText('会话和附件', {exact:true}).waitFor()
  await toggle.click()
  await other.setViewportSize({width:1280,height:720})
  await other.reload()
  await other.locator('textarea:visible').first().waitFor()
  await other.keyboard.press('Escape')
  await other.locator('textarea:visible').first().fill('验证新设备恢复的服务地址。')
  await other.getByRole('button', {name:'发送', exact:true}).click()
  await other.getByText('子路径模型合成回复', {exact:true}).first().waitFor()
  await other.context().close()
  const date = '2026-11-18T00:00:00.000Z'
  const session = { id: 'synthetic-import', title: '合成导入', pinned: false, current_message_id: 0, inserted_at: date, updated_at: date, messages: [] }
  const backup = { format: 'deepseek-session', version: 1, manifest: {export_format_version:3}, session, files: [] }
  await page.locator('input[type=file][accept*=".zip"]').setInputFiles({ name:'feedback.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(backup)) })
  await button('确认导入').click()
  await toast('已导入 1 个对话').waitFor()
  await toast('已导入 1 个对话').waitFor({state:'hidden'})
  user.managed_eligible = false
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByText('此账号未开通云同步，可联系管理员。', {exact:true}).waitFor()
  assert.equal(await toggle.isDisabled(), true)
  await button('清除云端数据').click()
  await button('关闭并清除').click()
  await toast('云端数据已清除，同步已关闭。').waitFor()
  assert.equal(documents.size, 0)
  assert.deepEqual(forbiddenSync, [])
  assert.deepEqual(blocked, [])
  console.log('PASS: personal key, invitation-gated sync, revocation and privacy purge, fast and slow sync, import count, automatic dismissal, cross-device theme and encrypted key recovery including wrong phrase, custom root/subpath model selection and streamed replies, destination-bound credentials and explicit official defaults')
}
try {
  await checkSettingsFeedback()
} finally {
  await browser.close()
}
