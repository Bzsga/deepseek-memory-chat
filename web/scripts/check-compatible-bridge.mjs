import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(web, '.provider-bridge-'))
try {
  execFileSync(
    process.execPath,
    [
      join(web, 'node_modules/typescript/bin/tsc'),
      '--project',
      join(web, 'tsconfig.json'),
      '--noEmit',
      'false',
      '--noCheck',
      '--outDir',
      out,
    ],
    { cwd: web }
  )
  const file = (name) => join(out, 'src/services', name + '.js')
  const load = (name) => import(pathToFileURL(file(name)))
  // Isolate the transport and bridge; actual provider mutations still run through their public entry points.
  writeFileSync(
    file('personalKeyVault'),
    `let saved;export const readPersonalApiKey=async()=>saved;export const hasPersonalApiKey=async()=>!!saved;export const storePersonalApiKey=async(apiKey,target)=>saved={scope:crypto.randomUUID(),apiKey,...target};export const removePersonalApiKey=async()=>{saved=undefined}`
  )
  writeFileSync(
    file('chat/store'),
    `export const useChatStore={getState:()=>({activeId:null,streaming:{}})};export const suspendReply=()=>{};export const saved=new Map();export const appendNativeArchiveChat=async(s,live)=>{if(!live())throw Error();if(!saved.has(s.id))saved.set(s.id,s)}`
  )
  writeFileSync(file('speech/readAloud'), `export const stopReadAloud=()=>{}`)
  globalThis.__API_ORIGIN__ = '/deepseek-api/chat'
  class TestWindow extends EventTarget {
    addEventListener(name, fn, opts) {
      if (name === 'message') this.connect = fn
      super.addEventListener(name, fn, opts)
    }
  }
  globalThis.window = new TestWindow()
  window.top = window
  globalThis.location = new URL('https://digimonlegend.com/deepseek/')
  const storage = new Map()
  globalThis.localStorage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
  }
  const runtime = await load('runtime')
  runtime.initializeRuntime({
    user: { id: 'local', role: 'user', managed_eligible: true },
    model: 'test',
    features: {},
  })
  const provider = await load('chatProvider'),
    bridge = await load('nativeBridge'),
    pref = await load('nativePreferences'),
    settings = await load('settings')
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0)),
    sent = []
  const establish = (trusted, source, flags) => {
    const channel = {
      start() {},
      close() {},
      postMessage(text) {
        const msg = JSON.parse(text)
        sent.push(msg)
        queueMicrotask(() =>
          channel.onmessage({
            data: JSON.stringify({ version: 1, type: 'ack', id: msg.id, ok: true }),
          })
        )
      },
    }
    window.connect({
      isTrusted: trusted,
      source,
      origin: source === null ? '' : location.origin,
      ports: [channel],
      data: JSON.stringify({ type: 'deepseek.connect', version: 1, ...flags }),
    })
  }
  bridge.bindNativeBridge(async () => {})
  assert.equal(bridge.hasSeparateOrganizationSettings(), false)
  await provider.initializeChatProvider()
  const detach = pref.bindNativePreferences()
  const flags = { chatProvider: true, themePreference: true, settingsSections: true }
  establish(true, window, { ...flags, organizationUsesChatProvider: true })
  assert.equal(bridge.hasSeparateOrganizationSettings(), true)
  await pause()
  establish(false, null, flags)
  await pause()
  establish(true, null, {})
  await pause()
  assert.equal(sent.length, 0)
  establish(true, null, flags)
  await pause()
  assert.equal(bridge.hasSeparateOrganizationSettings(), true)
  assert.deepEqual(
    sent.map((x) => x.type),
    ['chat.provider', 'chat.theme']
  )
  assert.equal(sent[0].payload.guest, false)
  assert.equal(sent[0].payload.ownerId, 'local')
  establish(true, null, { ...flags, organizationUsesChatProvider: true })
  await pause()
  assert.equal(bridge.nativeSettingsAccess(), 'sections')
  assert.equal(bridge.hasSeparateOrganizationSettings(), false)
  const key = 'SYNTHETIC_COMPATIBLE_KEY',
    endpoint = { baseUrl: 'https://qa.invalid/custom/v1', model: 'test-reasoner' }
  await provider.configureChatProvider({ mode: 'personal', apiKey: key, endpoint })
  await pause()
  assert.deepEqual(sent.at(-1).payload, {
    mode: 'personal',
    ownerId: 'local',
    guest: false,
    apiKey: key,
    ...endpoint,
  })
  settings.applyCloudPreferences({ themePreference: 'dark' })
  await pause()
  assert.equal(sent.at(-1).payload.preference, 'dark')
  settings.setThemePreference('light')
  await pause()
  assert.equal(sent.at(-1).payload.preference, 'light')
  const api = await load('api/client')
  const expectedInput = {
    model: 'deepseek-flash',
    system: 'background',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    thinking: { type: 'enabled' },
  }
  const requests = []
  let frames
  const emit = (values) =>
    values.map((v) => 'data: ' + (typeof v === 'string' ? v : JSON.stringify(v)) + '\n\n').join('')
  const choice = (delta, finish_reason = null) => ({
    choices: [{ delta, finish_reason, index: 0 }],
  })
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    return new Response(frames, { headers: { 'content-type': 'text/event-stream' } })
  }
  const run = async (body = expectedInput, signal = new AbortController().signal) => {
    const events = []
    for await (const event of api.streamMessage(key, body, signal)) events.push(event)
    return events
  }
  frames = emit([
    choice({ reasoning_content: 'reason' }),
    choice({ content: 'answer' }),
    choice({}, 'stop'),
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    '[DONE]',
  ])
  const reply = await run()
  assert.deepEqual(
    reply.filter((e) => e.type === 'content_block_delta').map((e) => e.delta),
    [
      { type: 'thinking_delta', thinking: 'reason' },
      { type: 'text_delta', text: 'answer' },
    ]
  )
  assert.equal(reply.at(-1).type, 'message_stop')
  assert.equal(reply.at(-2).usage.output_tokens, 2)
  assert.equal(requests.length, 1)
  const req = requests[0]
  assert.equal(req.url, endpoint.baseUrl + '/chat/completions')
  assert.equal(req.init.credentials, 'omit')
  assert.equal(req.init.redirect, 'error')
  assert.equal(new Headers(req.init.headers).get('authorization'), 'Bearer ' + key)
  assert.equal(JSON.parse(req.init.body).model, endpoint.model)
  const { modelParameters } = await load('replyPreferences')
  const defaults = { reasoningEffort: '', temperature: '' }
  assert.deepEqual(modelParameters(defaults, true), {})
  assert.deepEqual(modelParameters(defaults, false), {})
  const prefs = { reasoningEffort: 'high', temperature: '0' }
  assert.deepEqual(modelParameters(prefs, true), { output_config: { effort: 'high' } })
  assert.deepEqual(modelParameters(prefs, false), { temperature: 0 })
  await run({ ...expectedInput, ...modelParameters(prefs, true) })
  const reasoningBody = JSON.parse(requests.at(-1).init.body)
  assert.equal(reasoningBody.reasoning_effort, 'high')
  assert.equal(reasoningBody.temperature, undefined)
  await run({ ...expectedInput, thinking: { type: 'disabled' }, ...modelParameters(prefs, false) })
  const samplingBody = JSON.parse(requests.at(-1).init.body)
  assert.equal(samplingBody.temperature, 0)
  assert.equal(samplingBody.reasoning_effort, undefined)

  frames = emit([choice({ content: 'partial' })])
  await assert.rejects(run(), (e) => e.code === 'personal_interrupted')
  frames = emit([{ error: { message: 'untrusted ' + key } }])
  await assert.rejects(run(), (e) => e.code === 'personal_stream' && !e.message.includes(key))
  const count = requests.length
  await assert.rejects(run({ ...expectedInput, tools: [{ type: 'deepseek_web_search' }] }))
  await assert.rejects(run(expectedInput, AbortSignal.abort()))
  assert.equal(requests.length, count)
  const interrupted = new AbortController()
  let streamCancelled = false
  frames = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(emit([choice({ content: 'first' })])))
    },
    cancel() {
      streamCancelled = true
    },
  })
  const current = api.streamMessage(key, expectedInput, interrupted.signal)
  assert.equal((await current.next()).value.type, 'message_start')
  interrupted.abort()
  await assert.rejects(
    async () => {
      for await (const item of current) {
        void item
      }
    },
    (e) => e.name === 'AbortError'
  )
  assert.equal(streamCancelled, true)
  await provider.configureChatProvider({
    mode: 'personal',
    apiKey: key,
    endpoint: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' },
  })
  frames = emit([{ type: 'message_stop' }])
  await run({ ...expectedInput, ...modelParameters({ ...prefs, reasoningEffort: 'medium' }, true) })
  const official = requests.at(-1)
  assert.equal(official.url, 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal(official.init.credentials, 'omit')
  assert.equal(new Headers(official.init.headers).get('authorization'), 'Bearer ' + key)
  const officialReasoning = JSON.parse(official.init.body)
  assert.equal(officialReasoning.model, 'deepseek-v4-pro')
  assert.deepEqual(officialReasoning.output_config, { effort: 'high' })
  assert.equal(officialReasoning.temperature, undefined)
  await run({ ...expectedInput, thinking: { type: 'disabled' }, ...modelParameters(prefs, false) })
  const officialSampling = JSON.parse(requests.at(-1).init.body)
  assert.equal(officialSampling.temperature, 0)
  assert.equal(officialSampling.output_config, undefined)
  await provider.clearPersonalApiKey()
  await pause()
  assert.deepEqual(sent.at(-1).payload, { mode: 'personal', ownerId: 'local', guest: false })
  writeFileSync(file('conversationSync'), "import { create } from 'zustand'; export const useConversationSync=create(()=>({enabled:false,generation:0}));")
  const backup = await load('keyBackup'),
    sync = await load('conversationSync')
  sync.useConversationSync.setState({ enabled: true, eligible: true, generation: 2 })
  const restored = { ...endpoint, model: 'restored-model' },
    phrase = 'test recovery phrase'
  const doc = { generation: 2, revision: 1, value: await backup.encryptKey(key, phrase, restored) }
  globalThis.fetch = async () => Response.json(doc)
  await backup.keyBackupSession(2).restore(doc, phrase)
  await pause()
  assert.deepEqual(sent.at(-1).payload, {
    ownerId: 'local',
    guest: false,
    mode: 'personal',
    apiKey: key,
    ...restored,
  })
  await provider.configureChatProvider({ mode: 'managed' })
  await pause()
  assert.equal(sent.at(-1).payload.mode, 'managed')
  assert.equal(sent.at(-1).payload.apiKey, undefined)
  const {importArchiveFrame} = await load('chat/nativeArchive')
  const {saved} = await load('chat/store')
  const deliver = async (source, title) => {
    const text = JSON.stringify({id: source, title, created: '1700000000', updated: '1700000001', root: 'u', messages: [
      {id: 'u', role: 'user', text: '你好🌱', time: '', attachments: [], next: 'a'},
      {id: 'a', role: 'assistant', parent: 'u', text: '第一条回答', time: '', attachments: []},
    ]})
    await importArchiveFrame({source, offset: 0, text: text.slice(0, 40), last: false}, () => true)
    await importArchiveFrame({source, offset: 40, text: text.slice(40), last: true}, () => true)
  }
  await deliver('conversation-' + 'a'.repeat(64), '甲')
  await deliver('conversation-' + 'b'.repeat(64) + ':version:' + 'c'.repeat(16), '乙')
  const chat = [...saved.values()][0]
  assert.equal(chat.messages[0].selectedChildId, 'a')
  assert.equal(chat.messages[0].content, '你好🌱')
  chat.messages.push({id: 'follow-up'})
  await deliver('conversation-' + 'a'.repeat(64), '甲')
  assert.deepEqual([...saved.values()].map(s => s.title), ['甲', '乙'])
  assert.equal([...saved.values()][0].messages.at(-1).id, 'follow-up')
  await assert.rejects(importArchiveFrame({source: 'conversation-' + 'b'.repeat(64) + ':version:' + 'c'.repeat(16), offset: 1, text: 'x'}, () => true))
  await assert.rejects(importArchiveFrame({finished: true}, () => false))
  await importArchiveFrame({finished: true}, () => true)
  const {useMobileSider} = await import(pathToFileURL(join(out, 'src/components/sider/mobileSiderState.js')))
  assert.equal(useMobileSider.getState().open, true)
  runtime.invalidateSession('login', false)
  const before = sent.length
  settings.setThemePreference('dark')
  await pause()
  assert.equal(sent.length, before)
  detach()
  console.log(
    'Verified Android provider/theme bridge, account binding, endpoint/key mutation/clear, cloud and local theme, direct and compatible reply parameters, SSE failures, abort and single-dispatch transport. Zero real model calls.'
  )
} finally {
  rmSync(out, { recursive: true, force: true })
}
