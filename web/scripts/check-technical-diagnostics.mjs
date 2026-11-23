import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const dist = resolve(process.argv[2] || fileURLToPath(new URL('../dist', import.meta.url)))
const origin = 'https://diagnostics.example.test'
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png',
}
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', args: [
  '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND',
] })

async function scenario({ firstEntryFails = false, native = false } = {}) {
  const device = devices['Pixel 7']
  const context = await browser.newContext({ ...device, locale: 'zh-CN', serviceWorkers: 'block',
    ...(native ? { userAgent: device.userAgent + ' DeepSeekNativeDiagnostics/1' } : {}),
  })
  await context.addCookies([{ name: 'qa_session', value: 'never-transmit', domain: 'diagnostics.example.test', path: '/' }])
  const sent = []
  let failUpload = false
  let blockEntry = firstEntryFails
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) { return route.abort() }
    if (url.pathname.startsWith('/deepseek/')) {
      if (blockEntry && /\/main\.[a-f0-9]+\.js$/.test(url.pathname)) {
        blockEntry = false
        return route.fulfill({ status: 404 })
      }
      const path = resolve(dist, url.pathname.slice('/deepseek/'.length) || 'index.html')
      if (!path.startsWith(dist + sep) || !(await stat(path).catch(() => undefined))?.isFile()) {
        return route.fulfill({ status: 404 })
      }
      return route.fulfill({ body: await readFile(path), contentType: mime[extname(path)] || 'application/octet-stream' })
    }
    if (url.pathname === '/deepseek-api/chat/api/runtime') {
      return route.fulfill({ status: 401, json: {} })
    }
    if (url.pathname === '/deepseek-api/v1/technical-diagnostics/events') {
      const headers = await route.request().allHeaders()
      assert.ok(!headers.cookie && !headers.authorization && !headers.referer)
      const body = route.request().postDataJSON()
      const visible = ['source', 'occurred_at', 'event_id', 'release', 'area', 'code', 'stage', 'http_status', 'elapsed_ms', 'request_id']
      for (const report of body.events) {
        assert.ok(Object.keys(report).every(key => visible.includes(key)))
        assert.ok(/^[0-9a-f-]{36}$/.test(report.event_id))
        assert.ok(/^2\.6\.0\+[a-f0-9]+$/.test(report.release))
      }
      assert.ok(!route.request().postData().includes('never-transmit'))
      sent.push(body.events)
      return failUpload
        ? route.fulfill({ status: 503, json: {} })
        : route.fulfill({ json: { accepted_event_ids: body.events.map(event => event.event_id) } })
    }
    return route.fulfill({ status: 404 })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  return { context, page, sent, blockUpload: value => { failUpload = value } }
}

const openSettings = async (page) => {
  await page.getByRole('button', { name: '打开边栏', exact: true }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '数据管理', exact: true }).click()
  return page.getByRole('button', { name: '配置技术诊断', exact: true })
}

const recordError = async (page) => {
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { error: new Error('never-transmit') })))
}

try {
  const manual = await scenario({ firstEntryFails: true })
  await manual.page.goto(origin + '/deepseek/')
  await manual.page.getByRole('button', { name: '重新加载', exact: true }).click()
  await manual.page.getByRole('button', { name: '暂不开启', exact: true }).click()
  const open = await openSettings(manual.page)
  await open.click()
  const details = manual.page.getByRole('dialog', { name: '技术诊断', exact: true })
  await details.getByText(/startup · load_failed · download/).waitFor()
  assert.equal(manual.sent.length, 0)
  const send = details.getByRole('button', { name: '发送本次诊断', exact: true })
  manual.blockUpload(true)
  await send.click()
  await manual.page.getByText('诊断发送失败，记录仍保存在本机。', { exact: true }).waitFor()
  manual.blockUpload(false)
  await send.click()
  await details.getByRole('button', { name: '已发送诊断', exact: true }).waitFor()
  assert.equal(manual.sent.length, 2)
  assert.deepEqual(manual.sent[0], manual.sent[1])
  assert.equal(manual.sent[1][0].area, 'startup')
  await manual.context.close()

  const automatic = await scenario()
  await automatic.page.goto(origin + '/deepseek/')
  const optIn = automatic.page.getByRole('button', { name: '开启自动发送', exact: true })
  await optIn.waitFor()
  await recordError(automatic.page)
  assert.equal(automatic.sent.length, 0)
  await optIn.click()
  await automatic.page.waitForResponse(response => response.url().endsWith('/technical-diagnostics/events'))
  assert.equal(automatic.sent.length, 1)
  assert.equal(automatic.sent[0][0].code, 'unexpected_error')
  await (await openSettings(automatic.page)).click()
  await automatic.page.getByRole('switch', { name: '自动发送技术诊断', exact: true }).uncheck()
  await automatic.page.reload()
  await automatic.page.getByRole('button', { name: '打开边栏', exact: true }).waitFor()
  await recordError(automatic.page)
  await automatic.page.waitForTimeout(1250)
  assert.equal(automatic.sent.length, 1)
  assert.equal(await optIn.count(), 0)
  await automatic.context.close()

  const recovery = await scenario()
  await recovery.page.setViewportSize({ width: 800, height: 900 })
  await recovery.page.goto(origin + '/deepseek/')
  const composer = recovery.page.getByRole('textbox', { name: '请输入消息', exact: true })
  await composer.waitFor()
  await recovery.page.evaluate(() => Object.defineProperty(window.visualViewport, 'height', {
    configurable: true,
    get() { throw new Error('never-transmit-render') },
  }))
  await recovery.page.setViewportSize({ width: 760, height: 900 })
  const fallback = recovery.page.locator('#session-bootstrap')
  await fallback.getByText('聊天界面加载失败，请重新加载。', { exact: true }).waitFor()
  await fallback.locator('summary').click()
  const raw = await fallback.locator('pre').textContent()
  const { area, code, stage } = JSON.parse(raw)
  assert.deepEqual({ area, code, stage }, { area: 'runtime', code: 'unexpected_error', stage: 'render' })
  assert.ok(!raw.includes('never-transmit-render'))
  assert.equal(recovery.sent.length, 0)
  await fallback.getByRole('button', { name: '重试', exact: true }).click()
  await composer.waitFor()
  await recovery.context.close()

  const embedded = await scenario({ native: true })
  await embedded.page.goto(origin + '/deepseek/')
  const nativeAction = await openSettings(embedded.page)
  assert.equal(await nativeAction.isDisabled(), true)
  assert.equal(await embedded.page.getByRole('button', { name: '开启自动发送', exact: true }).count(), 0)
  assert.equal(embedded.sent.length, 0)
  await embedded.context.close()
  console.log('Technical diagnostics passed: consent, manual acknowledgement and retry, revocation, static startup failure, render recovery, native fail-closed.')
} finally {
  await browser.close()
}
