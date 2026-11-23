import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const { chromium, devices } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const origin = 'https://digimonlegend.com'
const dist = fileURLToPath(new URL('../dist/', import.meta.url)).replace(/[\\/]$/, '')
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
const endpoint = 'https://library.example.test/mcp'
const source = { title: '合成资料', url: 'https://library.example.test/doc', text: '合成摘录用于检查上下文。' }
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', args: [
  '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND',
] })

try {
  const device = devices['Pixel 7']
  const context = await browser.newContext({ ...device, viewport: { width: 320, height: 720 },
    locale: 'zh-CN', userAgent: device.userAgent + ' DeepSeekNativeDiagnostics/1', serviceWorkers: 'block',
  })
  const modelRequests = []
  let registered = false
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === origin && url.pathname.startsWith('/deepseek/')) {
      const path = resolve(dist, url.pathname.slice('/deepseek/'.length) || 'index.html')
      if (path.startsWith(dist + sep) && (await stat(path).catch(() => null))?.isFile()) {
        return route.fulfill({ body: await readFile(path), contentType: mime[extname(path)] || 'application/octet-stream' })
      }
    }
    if (url.href === origin + '/deepseek-api/chat/api/runtime') {
      return registered ? route.fulfill({ json: { model: 'deepseek-flash', features: {},
        user: { id: 'synthetic-account', username: 'QA', role: 'user' } } }) : route.fulfill({ status: 401, json: {} })
    }
    if (url.href === 'https://api.deepseek.com/anthropic/v1/messages') {
      const body = route.request().postDataJSON()
      modelRequests.push(body)
      const taskTool = body.tools?.find((tool) => tool.input_schema?.properties?.title)
      const lastContent = body.messages.at(-1)?.content
      const result = Array.isArray(lastContent) && lastContent.find((block) => block.type === 'tool_result')
      const title = typeof lastContent === 'string' ? lastContent : lastContent?.find((block) => block.type === 'text')?.text
      const proposal = taskTool && !result && body.tool_choice?.type === 'auto'
      const block = proposal ? { type: 'tool_use', id: 'toolu_qa', name: taskTool.name, input: {} } :
        { type: 'text', text: result ? `模型收到工具结果：${JSON.parse(result.content).status}` : '合成模型回复。' }
      const events = [
        { type: 'message_start', message: { id: 'qa', model: 'deepseek-flash' } },
        { type: 'content_block_start', index: 0, content_block: block },
        ...(proposal ? [{ type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify({ title: title || '模型待办' }) } }] : []),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: proposal ? 'tool_use' : 'end_turn' } },
        { type: 'message_stop' },
      ]
      return route.fulfill({ contentType: 'text/event-stream', body: events.map(event =>
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') })
    }
    return route.abort()
  })

  // Substitute the native host only in this isolated page. Production code still parses every bridge frame.
  await context.addInitScript(() => {
    const addListener = window.addEventListener.bind(window)
    let receiver, port, config = { endpoint: '', toolName: '', toolTitle: '', hasToken: false }
    const calls = []
    const deferred = []
    const actions = []
    const task = { name: 'create_task', title: '创建待办', description: '在示例清单中添加一项。',
      readOnly: false, revision: 'c'.repeat(64), inputSchema: { type: 'object', required: ['title'],
        properties: { title: { type: 'string', title: '任务标题' }, notes: { type: 'string', title: '任务说明' } } } }
    const status = { name: 'read_status', title: '查看状态', description: '读取示例清单的状态。',
      readOnly: true, revision: 'd'.repeat(64), inputSchema: { type: 'object', additionalProperties: false } }
    function receive(frame) { return port.onmessage({ data: JSON.stringify({ version: 1, ...frame }) }) }
    function ack(id, payload, error) { return receive({ type: 'ack', id, ok: !error, payload, error }) }
    window.addEventListener = (type, listener, options) => {
      if (type === 'message') { receiver = listener }
      return addListener(type, listener, options)
    }
    window.mcpTest = {
      calls, deferred,
      connect(trusted, enableActions = false) {
        port = { start() {}, close() {}, postMessage(data) {
          const { type, id, payload } = JSON.parse(data)
          if (!type.startsWith('mcp.')) { return }
          calls.push({ type, payload })
          const tool = { name: 'search', title: '合成检索' }
          if (type === 'mcp.settings') { void ack(id, config) }
          if (type === 'mcp.discover') { void ack(id, { tools: [tool] }) }
          if (type === 'mcp.save') {
            config = { endpoint: payload.endpoint, toolName: payload.toolName,
              toolTitle: payload.toolName ? tool.title : '', hasToken: Boolean(payload.token) }
            void ack(id, config)
          }
          if (type === 'mcp.lookup') { deferred.push(id) }
          if (type === 'mcp.tools') { void ack(id, { tools: [task, status] }) }
          if (type === 'mcp.invoke') { actions.push(id) }
        } }
        receiver({ isTrusted: trusted, source: null, origin: '', ports: [port],
          data: JSON.stringify({ type: 'deepseek.connect', version: 1 }) })
        return receive({ type: 'personal.mcp.capability', id: 'qa-mcp', personalMcp: true, personalMcpActions: enableActions })
      },
      complete(sources, error) { return ack(deferred.shift(), { sources }, error) },
      completeAction(status, text) { return ack(actions.shift(), { status, text, truncated: false }) },
    }
  })

  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const button = (name) => page.getByRole('button', { name, exact: true })
  const draft = page.getByPlaceholder('请输入消息')
  const plus = button('添加附件或使用工具')
  const lookup = button('查资料')
  const activeLookup = button('关闭本条查资料')
  const send = button('发送')
  const begin = async (question) => {
    await draft.fill(question)
    if (!(await activeLookup.isVisible())) {
      await plus.click()
      await lookup.click()
      await activeLookup.waitFor()
    }
    await send.click()
    await page.getByText('正在查资料…', { exact: true }).waitFor()
    const calls = await page.evaluate(() => window.mcpTest.calls.filter(call => call.type === 'mcp.lookup'))
    assert.deepEqual(calls.at(-1).payload, { guest: true, ownerId: 'local', query: question })
  }
  const finish = (error) => page.evaluate(({ source, error }) => window.mcpTest.complete([source], error), { source, error })

  await page.goto(origin + '/deepseek/')
  await draft.waitFor()
  await page.evaluate(() => window.mcpTest.connect(false))
  await button('填写个人 API Key').click()
  await button('高级 API 设置').click()
  const settings = page.getByRole('dialog', { name: '高级 API 设置' })
  assert.equal(await settings.getByRole('button', { name: /^MCP 资料库/ }).count(), 0)
  await page.evaluate(() => window.mcpTest.connect(true))
  await settings.getByRole('button', { name: /^MCP 资料库/ }).click()
  await settings.getByLabel('服务地址').fill(endpoint)
  await settings.getByLabel(/访问令牌/).fill('synthetic-library-token')
  await settings.getByRole('button', { name: '查找工具', exact: true }).click()
  await settings.getByRole('button', { name: '保存资料库', exact: true }).click()
  await settings.getByText('已保存。发送前点「＋」即可开启「查资料」。').waitFor()
  await settings.getByPlaceholder(/输入个人 DeepSeek API Key/).fill('synthetic-model-key')
  await settings.getByRole('button', { name: '保存服务设置', exact: true }).click()
  await settings.waitFor({ state: 'hidden' })
  await plus.waitFor()
  assert.equal(await button('MCP 工具').count(), 0)
  assert.equal(await lookup.count(), 0)
  await plus.click()
  assert.equal(await button('文件').isVisible(), true)
  assert.equal(await lookup.getAttribute('aria-pressed'), 'false')
  await lookup.click()
  await activeLookup.click()
  await activeLookup.waitFor({ state: 'hidden' })

  await begin('资料库失败测试')
  await finish('合成资料库错误')
  await page.getByRole('alert').filter({ hasText: '合成资料库错误' }).waitFor()
  assert.equal(await draft.inputValue(), '资料库失败测试')
  assert.equal(modelRequests.length, 0)

  await begin('取消查询测试')
  await button('取消发送').click()
  await finish()
  assert.equal(await draft.inputValue(), '取消查询测试')
  assert.equal(modelRequests.length, 0)

  await begin('修改草稿测试')
  await draft.fill('修改后的草稿')
  await finish()
  assert.equal(await draft.inputValue(), '修改后的草稿')
  assert.equal(modelRequests.length, 0)

  await begin('请查找合成文档')
  await finish()
  await page.getByText('合成模型回复。', { exact: true }).waitFor()
  await page.getByText('资料来源（1）', { exact: true }).click()
  const citation = page.getByRole('link', { name: source.title, exact: true })
  assert.equal(await citation.getAttribute('href'), source.url)
  await activeLookup.waitFor({ state: 'hidden' })
  assert.equal(modelRequests.length, 1)
  assert.ok(JSON.stringify(modelRequests[0]).includes(source.text))
  assert.ok(!JSON.stringify(modelRequests[0]).includes('synthetic-library-token'))
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))

  const lookupCount = () => page.evaluate(() => window.mcpTest.calls.filter(call => call.type === 'mcp.lookup').length)
  const beforeFollowup = await lookupCount()
  await draft.fill('继续讨论这份文档')
  await send.click()
  await page.getByText('合成模型回复。', { exact: true }).nth(1).waitFor()
  assert.equal(await lookupCount(), beforeFollowup)
  assert.equal(modelRequests.length, 2)
  assert.ok(JSON.stringify(modelRequests[1]).includes(source.text))

  await begin('切换会话时取消发送')
  await button('开启新对话').click()
  await finish()
  assert.equal(await draft.inputValue(), '')
  assert.equal(modelRequests.length, 2)

  await begin('切换账号时取消发送')
  registered = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await button('填写 API Key 或使用邀请码').waitFor()
  assert.equal(modelRequests.length, 2)

  // The new host supports a tool-only connection on the fresh account, without a model key.
  await page.getByRole('dialog', { name: '复制这台设备的聊天？' }).getByRole('button', { name: '稍后' }).click()
  await page.evaluate(() => window.mcpTest.connect(true, true))
  await button('填写 API Key 或使用邀请码').click()
  await button('高级 API 设置').click()
  await settings.getByRole('button', { name: /^MCP 服务/ }).click()
  await settings.getByLabel('服务地址').fill(endpoint)
  await settings.getByRole('button', { name: '保存 MCP 服务', exact: true }).click()
  await settings.getByText(/已保存。使用官方个人 API/).waitFor()
  await settings.getByRole('button', { name: '测试工具', exact: true }).click()
  const toolsDialog = page.getByRole('dialog', { name: '测试 MCP 工具', exact: true })
  const invocations = () => page.evaluate(() => window.mcpTest.calls.filter(call => call.type === 'mcp.invoke'))
  const action = (status, text) => page.evaluate(({ status, text }) => window.mcpTest.completeAction(status, text), { status, text })
  const createTask = toolsDialog.getByRole('button', { name: '创建待办', exact: true })
  await createTask.waitFor()
  assert.equal(await toolsDialog.getByRole('searchbox').count(), 0)
  await createTask.click()
  assert.equal(await toolsDialog.getByLabel('任务说明').isVisible(), false)
  await toolsDialog.getByText('更多参数', { exact: true }).click()
  await toolsDialog.getByLabel('任务说明').waitFor()
  await toolsDialog.getByText('更多参数', { exact: true }).click()
  await toolsDialog.getByLabel('任务标题').fill('整理观星资料')
  const toolDialogId = await toolsDialog.getAttribute('aria-labelledby')
  await toolsDialog.getByRole('button', { name: '运行工具', exact: true }).click()
  const confirm = page.getByRole('button', { name: '确认运行', exact: true })
  await confirm.waitFor()
  assert.equal((await invocations()).length, 0)
  const confirmDialog = page.getByRole('dialog', { name: '确认运行工具' })
  assert.equal(await confirmDialog.getAttribute('aria-labelledby'), toolDialogId)
  await confirmDialog.getByRole('button', { name: '返回编辑', exact: true }).click()
  await confirmDialog.waitFor({ state: 'hidden' })
  assert.equal((await invocations()).length, 0)
  assert.equal(await toolsDialog.getByLabel('任务标题').inputValue(), '整理观星资料')
  await toolsDialog.getByRole('button', { name: '运行工具', exact: true }).click()
  await page.getByText(endpoint, { exact: true }).last().waitFor()
  await page.getByText(/"title": "整理观星资料"/).waitFor()
  await confirm.click()
  await page.waitForFunction(() => window.mcpTest.calls.filter(call => call.type === 'mcp.invoke').length === 1)
  assert.deepEqual((await invocations())[0].payload, { ownerId: 'synthetic-account', guest: false,
    endpoint, toolName: 'create_task', revision: 'c'.repeat(64), arguments: { title: '整理观星资料' } })
  await action('success', '示例待办已创建。')
  await toolsDialog.getByText('示例待办已创建。', { exact: true }).waitFor()
  assert.equal(modelRequests.length, 2)

  await toolsDialog.getByRole('button', { name: '返回工具列表', exact: true }).click()
  await toolsDialog.getByRole('button', { name: '查看状态', exact: true }).click()
  assert.equal(await toolsDialog.getByText('更多参数', { exact: true }).count(), 0)
  assert.equal(await toolsDialog.getByLabel('JSON 参数').count(), 0)
  await toolsDialog.getByRole('button', { name: '运行工具', exact: true }).click()
  await page.waitForFunction(() => window.mcpTest.calls.filter(call => call.type === 'mcp.invoke').length === 2)
  assert.deepEqual((await invocations())[1].payload.arguments, {})
  await action('uncertain', '')
  await toolsDialog.getByText(/运行结果未确认/).waitFor()
  assert.equal((await invocations()).length, 2)
  assert.equal(modelRequests.length, 2)

  await page.keyboard.press('Escape')
  await toolsDialog.waitFor({ state: 'hidden' })
  await settings.getByPlaceholder(/输入个人 DeepSeek API Key/).fill('synthetic-model-key')
  await settings.getByRole('button', { name: '保存服务设置', exact: true }).click()
  await settings.waitFor({ state: 'hidden' })
  await plus.click()
  await button('使用 MCP').click()
  const enabled = button('关闭本对话的 MCP')
  await enabled.waitFor()

  const runPrompt = async (prompt) => {
    await draft.fill(prompt)
    await send.click()
    const pending = page.getByRole('article', { name: '创建待办', exact: true }).filter({ hasText: '等待确认' })
    await pending.getByText(prompt, { exact: false }).waitFor()
    assert.equal(await page.getByRole('dialog').count(), 0)
    return pending
  }
  const skip = await runPrompt('跳过这条模型待办')
  assert.equal((await invocations()).length, 2)
  await skip.getByRole('button', { name: '跳过', exact: true }).click()
  await page.getByText('模型收到工具结果：rejected', { exact: true }).waitFor()
  assert.equal(modelRequests.length, 4)
  assert.equal((await invocations()).length, 2)

  const approve = await runPrompt('周五整理资料')
  await approve.getByRole('button', { name: '允许', exact: true }).evaluate((element) => {
    element.click()
    element.click()
  })
  await page.waitForFunction(() => window.mcpTest.calls.filter(call => call.type === 'mcp.invoke').length === 3)
  assert.deepEqual((await invocations())[2].payload.arguments, { title: '周五整理资料' })
  assert.equal((await invocations())[2].payload.toolName, 'create_task')
  await action('success', '从对话创建成功。')
  await page.getByText('模型收到工具结果：success', { exact: true }).waitFor()
  assert.equal(modelRequests.length, 6)
  assert.equal(modelRequests[5].tool_choice.type, 'none')
  const toolUse = modelRequests[5].messages.at(-2).content.find((block) => block.type === 'tool_use')
  const toolResult = modelRequests[5].messages.at(-1).content[0]
  assert.equal(toolUse.id, toolResult.tool_use_id)
  assert.deepEqual(JSON.parse(toolResult.content), { status: 'success', text: '从对话创建成功。', truncated: false })
  await enabled.waitFor()

  await runPrompt('换会话时停止')
  await button('开启新对话').click()
  await enabled.waitFor({ state: 'hidden' })
  assert.equal((await invocations()).length, 3)
  assert.equal(modelRequests.length, 7)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  console.log('MCP mobile UI passed: legacy lookup, settings tool test, model-chosen actions, skip, linked result, and conversation isolation.')
} finally {
  await browser.close()
}
