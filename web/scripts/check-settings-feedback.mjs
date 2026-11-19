import { customEndpointFixture, destination, customModel, openAdvancedChat } from './fixtures/custom-chat-ui.mjs'
import assert from 'node:assert/strict'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

// Run with a local production bundle and a Playwright installation.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const dist = resolve(process.argv[2] || fileURLToPath(new URL('../dist', import.meta.url)))
const origin = 'https://feedback.example.test'
const user = { id: 'feedback-qa', username: '合成测试', role: 'user', managed_eligible: false }
const quota = { user_weekly_remaining: 20, reset_at: '2026-11-23T00:00:00Z' }
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }
let enabled = false
let generation = 0
let delay = 0
const blocked = []
const forbiddenSync = []
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
try {
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
        if (method === 'PATCH') { enabled = route.request().postDataJSON().enabled; generation++ }
        if (method === 'DELETE') { enabled = false; generation++; documents.clear() }
        return json({ eligible: user.managed_eligible, enabled, generation, sequence: 0 })
      }
      if (['/deepseek-api/chat/api/conversation-sync/preferences', '/deepseek-api/chat/api/conversation-sync/key-envelope'].includes(path)) {
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
        await new Promise(resolveDelay => setTimeout(resolveDelay, delay))
        return json({ generation, entries: [], cursor: 0, has_more: false })
      }
      if (path === '/favicon.ico') return route.fulfill({ status: 204 })
    }
    blocked.push(path)
    return route.abort()
  }
  async function newDevice() {
    const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block' })
    await context.route('**/*', serve)
    return context.newPage()
  }
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
  const toggle = page.getByRole('switch', { name: '多端同步会话' })
  await page.getByText('云同步仅向受邀账号开放，可在聊天 API 设置中兑换邀请码。', {exact:true}).waitFor()
  assert.equal(await toggle.isDisabled(), true)
  assert.equal(await button('清除云端数据').count(), 0)
  await page.getByRole('tab', { name: '通用设置', exact: true }).click()
  const advanced = await openAdvancedChat(page)
  await advanced.getByPlaceholder('输入个人 DeepSeek API Key').fill(apiKey)
  await advanced.getByPlaceholder('https://api.deepseek.com').fill(destination)
  await advanced.locator('input[list]').fill(customModel)
  await advanced.getByRole('button', { name: '保存服务设置', exact: true }).click()
  await toast('个人 API Key 已保存到本机').waitFor()
  await button('配置聊天 API').click()
  await page.getByRole('radio', { name: '使用邀请码' }).click()
  await page.getByLabel('免费服务邀请码', {exact:true}).fill('SYNTHETIC-INVITE')
  await button('兑换并使用免费服务').click()
  await toast('免费 API 已开通').waitFor()
  await page.getByRole('radio', {name:'深色'}).click()
  await page.getByText('数据管理', {exact:true}).click()
  await toggle.click()
  await button('开启同步').click()
  await toast('云端同步完成').waitFor()
  await toast('云端同步完成').waitFor({state:'hidden'})
  delay = 1600
  await button('立即同步').click()
  await toast('正在同步云端数据…').waitFor()
  await toast('云端同步完成').waitFor()
  delay = 0
  assert.equal(documents.get('/deepseek-api/chat/api/conversation-sync/preferences').value.themePreference, 'dark')
  await button('个人 API Key 备份').click()
  await button('备份本机 Key').click()
  await page.getByLabel('独立恢复口令', {exact:true}).fill(phrase)
  await page.getByLabel('再次输入恢复口令', {exact:true}).fill(phrase)
  await button('备份本机 Key').click()
  await page.getByText('已保存加密备份。').waitFor()
  const envelope = documents.get('/deepseek-api/chat/api/conversation-sync/key-envelope').value
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext','iv','salt','version'])
  assert.notEqual(Buffer.from(envelope.ciphertext, 'base64').toString(), apiKey)
  const other = await newDevice()
  other.setDefaultTimeout(8000)
  await other.goto(origin + '/deepseek/')
  await other.getByRole('button', {name:'设置', exact:true}).click()
  await other.locator('[role=radio][aria-checked=true]').filter({hasText:'深色'}).waitFor()
  await other.getByText('数据管理', {exact:true}).click()
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
  await toggle.click()
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
  await page.getByText('云同步仅向受邀账号开放，可在聊天 API 设置中兑换邀请码。', {exact:true}).waitFor()
  assert.equal(await toggle.isDisabled(), true)
  await button('清除云端数据').click()
  await button('关闭并清除').click()
  await toast('云端数据已清除，同步已关闭。').waitFor()
  assert.equal(documents.size, 0)
  assert.deepEqual(forbiddenSync, [])
  assert.deepEqual(blocked, [])
  console.log('PASS: personal key, invitation-gated sync, revocation and privacy purge, fast and slow sync, import count, automatic dismissal, cross-device theme and encrypted key recovery including wrong phrase, custom root/subpath model selection and streamed replies, destination-bound credentials and explicit official defaults')
} finally {
  await browser.close()
}
