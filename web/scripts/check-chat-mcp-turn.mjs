import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(web, '.chat-mcp-turn-'))
const service = (name) => join(out, 'src/services', `${name}.js`)
const load = (name) => import(pathToFileURL(service(name)))

try {
  execFileSync(process.execPath, [join(web, 'node_modules/typescript/bin/tsc'), '--project', join(web, 'tsconfig.json'),
    '--noEmit', 'false', '--outDir', out], { cwd: web })
  writeFileSync(service('chat/db'), `
    export const rows = new Map();
    export const saveSession = async (session) => {rows.set(session.id, structuredClone(session)); return 1};
    export const loadSession = async (id) => structuredClone(rows.get(id));
    export const reportStorageError = () => (error) => {throw error};
  `)
  writeFileSync(service('personalKeyVault'), `
    export const storePersonalApiKey = async (apiKey, endpoint) => ({...endpoint, apiKey, scope: 'test-key-scope'});
    export const readPersonalApiKey = async () => null;
    export const removePersonalApiKey = async () => {};
  `)

  globalThis.__API_ORIGIN__ = '/deepseek-api/chat'
  globalThis.location = new URL('https://digimonlegend.com/deepseek/')
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  }
  let connect
  globalThis.window = new class extends EventTarget {
    addEventListener(type, listener, options) {
      if (type === 'message') {connect = listener}
      super.addEventListener(type, listener, options)
    }
  }()
  window.top = window
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
  globalThis.cancelAnimationFrame = () => {}
  const runtime = await load('runtime')
  runtime.initializeRuntime(runtime.localGuestRuntime())
  const { bindNativeBridge } = await load('nativeBridge')
  const { configureChatProvider } = await load('chatProvider')
  const { captureBackgroundChatTransport } = await load('api/client')
  const { refreshPersonalMcpSettings } = await load('personalMcp')
  const { captureChatMcpSettings, setChatMcpEnabled } = await load('chat/chatMcp')
  const { getVisibleMessages } = await load('chat/branches')
  const { setDraftText } = await load('chat/drafts')
  const store = await load('chat/store')
  const { rows } = await load('chat/db')
  await configureChatProvider({ mode: 'personal', apiKey: 'synthetic-test-key' })
  bindNativeBridge(async () => {})
  store.useChatStore.setState({ ready: true })

  const settings = { endpoint: 'https://mcp.example.test', toolName: 'get_fixture', toolTitle: '读取资料', hasToken: false }
  const tool = { name: 'get_fixture', title: '读取资料', description: '读取合成值', readOnly: true,
    revision: 'a'.repeat(64), inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }
  const native = []
  let holdCatalog = false
  let completeCatalog
  let completeInvocation
  const attachNative = async (background) => {
    const deliver = (frame) => port.onmessage({ data: JSON.stringify({ version: 1, ...frame }) })
    const ack = (id, payload) => deliver({ type: 'ack', id, ok: true, payload })
    const port = { start() {}, close() {}, postMessage(raw) {
      const { id, type, payload } = JSON.parse(raw)
      native.push({ type, payload })
      if (type === 'mcp.settings') {void ack(id, settings)}
      else if (type === 'mcp.tools') {
        if (holdCatalog) {completeCatalog = () => ack(id, { tools: [tool] })}
        else {void ack(id, { tools: [tool] })}
      } else if (type === 'mcp.invoke') {
        completeInvocation = () => ack(id, { status: 'success', text: 'RAW_MCP_RESULT', truncated: false })
        if (payload.arguments.query === 'first') {void completeInvocation()}
      } else if (type.startsWith('personal.chat.')) {
        assert.fail(`Unexpected background transport: ${type}`)
      }
    } }
    connect({ isTrusted: true, source: null, origin: '', ports: [port],
      data: JSON.stringify({ version: 1, type: 'deepseek.connect' }) })
    await deliver({ type: 'personal.mcp.capability', id: 'fixture-mcp', personalMcp: true, personalMcpActions: true })
    if (background) {await deliver({ type: 'personal.chat.capability', id: 'fixture-chat', personalBackgroundChat: true })}
    await refreshPersonalMcpSettings()
  }

  const requests = []
  const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  let query = 'first'
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.deepseek.com/anthropic/v1/messages')
    const request = JSON.parse(init.body)
    requests.push(request)
    const toolName = request.tools.find(({ type }) => type === undefined)?.name
    const toolRound = toolName && request.tool_choice.type === 'auto'
    const block = toolRound ? { type: 'tool_use', id: 'fixture-call', name: toolName, input: { query } }
      : { type: 'text', text: '合成最终回复' }
    return new Response([
      { type: 'message_start', message: { id: 'fixture-response', model: 'deepseek-flash' } },
      { type: 'content_block_start', index: 0, content_block: block },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: toolRound ? 'tool_use' : 'end_turn' } },
      { type: 'message_stop' },
    ].map(frame).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const until = async (condition) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (condition()) {return}
      await new Promise((done) => setTimeout(done, 5))
    }
    assert.fail('Timed out waiting for MCP chat store')
  }
  const send = (sessionId, text, sources) => {
    setDraftText(sessionId, text)
    assert.equal(store.sendMessage(sessionId, sources), true)
  }
  const calls = (type) => native.filter((frame) => frame.type === type)

  await attachNative(true)
  assert.equal(captureBackgroundChatTransport('synthetic-test-key'), 'personal-messages')
  setChatMcpEnabled(null, true)
  send(null, '新会话中的合成问题')
  const sessionId = store.useChatStore.getState().activeId
  assert.ok(sessionId)
  assert.equal(captureChatMcpSettings(null), null)
  assert.ok(captureChatMcpSettings(sessionId))
  const idle = () => until(() => !store.useChatStore.getState().streaming[sessionId])
  const reply = () => getVisibleMessages(store.useChatStore.getState().sessionCache[sessionId]).at(-1)
  await idle()
  assert.equal(requests.length, 2)
  assert.equal(calls('mcp.invoke').length, 1)
  assert.equal(requests[1].messages.at(-1).content[0].type, 'tool_result')
  assert.match(requests[1].messages.at(-1).content[0].content, /RAW_MCP_RESULT/)
  assert.equal(reply().status, 'done')
  assert.equal(reply().prefix, false)
  assert.deepEqual(reply().blocks.map(({ text }) => text), ['合成最终回复'])
  const stored = JSON.stringify(rows.get(sessionId))
  assert.doesNotMatch(stored, /RAW_MCP_RESULT|fixture-call|"query"|chatJob/)

  query = 'pending'
  send(sessionId, '调用时离开会话')
  await until(() => calls('mcp.invoke').length === 2)
  store.newChat()
  store.selectSession(sessionId)
  await idle()
  await completeInvocation()
  assert.equal(reply().status, 'stopped')
  assert.equal(requests.length, 3, 'A late result must not restart the previous turn')

  holdCatalog = true
  send(sessionId, '读取列表时停止')
  await until(() => Boolean(completeCatalog))
  store.stopReply(sessionId)
  await idle()
  await completeCatalog()
  assert.equal(reply().status, 'stopped')
  assert.equal(requests.length, 3)

  await attachNative(false)
  setChatMcpEnabled(sessionId, true)
  const catalogCount = calls('mcp.tools').length
  store.regenerateReply(sessionId)
  await idle()
  assert.equal(reply().status, 'done')
  assert.equal(requests[3].tool_choice, undefined)
  send(sessionId, '用以前的资料来源', [{ title: '原有来源', url: 'https://source.example.test', text: '旧版检索摘录' }])
  await idle()
  assert.equal(requests.length, 5)
  assert.match(JSON.stringify(requests[4].messages), /旧版检索摘录/)
  assert.equal(requests[4].tool_choice, undefined)
  assert.equal(calls('mcp.tools').length, catalogCount)
  assert.equal(calls('mcp.invoke').length, 2)
  console.log('MCP chat store passed direct routing, late-result cancellation, stop, retry and legacy source checks.')
} finally {
  const target = realpathSync(out)
  assert.equal(dirname(target), realpathSync(web))
  assert.ok(basename(target).startsWith('.chat-mcp-turn-'))
  rmSync(target, { recursive: true, force: true })
}
