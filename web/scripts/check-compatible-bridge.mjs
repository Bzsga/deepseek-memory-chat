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
    `const saved = new Map();
    export const readPersonalApiKey = async (purpose = 'chat') => saved.get(purpose);
    export const hasPersonalApiKey = async (purpose = 'chat') => saved.has(purpose);
    export const storePersonalApiKey = async (apiKey, target, purpose = 'chat') => {
      const entry = {scope:crypto.randomUUID(), apiKey, ...target}; saved.set(purpose, entry); return entry;
    };
    export const removePersonalApiKey = async (purpose = 'chat') => { saved.delete(purpose) };`
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
    user: { id: 'local', username: 'synthetic', role: 'user', managed_eligible: true },
    model: 'test',
    features: { image_generation: true },
  })
  const provider = await load('chatProvider'),
    bridge = await load('nativeBridge'),
    pref = await load('nativePreferences'),
    settings = await load('settings')
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0)),
    sent = []
  const establish = (trusted, source, flags, receiveImage) => {
    const channel = {
      start() {},
      close() {},
      postMessage(text) {
        const msg = JSON.parse(text)
        sent.push(msg)
        if (msg.type.startsWith('image.')) {
          assert.ok(receiveImage, 'Only an authenticated image-capable port may receive image frames')
          const reply = (type, payload) => channel.onmessage({
            data: JSON.stringify({ version: 1, type, id: msg.id, ...payload }),
          })
          receiveImage(msg, reply)
          return
        }
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
  let dropStream
  const resetAfterPartialReply = (values) => new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(emit(values)))
      dropStream = () => controller.error(new TypeError('connection closed'))
    },
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
  frames = resetAfterPartialReply([choice({ content: 'first' })])
  const brokenCompatible = api.streamMessage(key, expectedInput, new AbortController().signal)
  assert.equal((await brokenCompatible.next()).value.type, 'message_start')
  assert.equal((await brokenCompatible.next()).value.type, 'content_block_start')
  assert.equal((await brokenCompatible.next()).value.delta.text, 'first')
  const callsBeforeCompatibleDrop = requests.length
  dropStream()
  await assert.rejects(brokenCompatible.next(), (e) => e.kind === 'interrupted' && e.code === 'personal_interrupted')
  assert.equal(requests.length, callsBeforeCompatibleDrop)
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
  const diagnosticRequestId = 'e13cfa4c-f3f4-42ee-affa-a97ec030ecbc'
  const currentDocument = globalThis.document
  globalThis.document = { querySelector: () => null, scripts: [] }
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init })
    const response = new Response(resetAfterPartialReply([
      { type: 'message_start', message: { id: 'synthetic', model: 'test' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'first' } },
    ]), { headers: { 'content-type': 'text/event-stream', 'X-Request-ID': diagnosticRequestId } })
    Object.defineProperty(response, 'url', { value: location.origin + url })
    return response
  }
  const brokenManaged = api.streamMessage(settings.useSettings.getState().apiKey, expectedInput, new AbortController().signal)
  assert.equal((await brokenManaged.next()).value.type, 'message_start')
  assert.equal((await brokenManaged.next()).value.content_block.text, 'first')
  const callsBeforeManagedDrop = requests.length
  dropStream()
  await assert.rejects(brokenManaged.next(), (e) => e.kind === 'interrupted')
  assert.equal(requests.length, callsBeforeManagedDrop)
  const streamDiagnostic = [...storage.entries()]
    .filter(([name]) => name.includes(':event:'))
    .map(([, value]) => JSON.parse(value))
    .find((item) => item.area === 'chat')
  assert.ok(streamDiagnostic)
  assert.equal(streamDiagnostic.area, 'chat')
  assert.equal(streamDiagnostic.code, 'network_error')
  assert.equal(streamDiagnostic.stage, 'response')
  assert.equal(streamDiagnostic.request_id, diagnosticRequestId)
  globalThis.document = currentDocument
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

  const images = await load('imageProvider')
  const imageBase = 'https://image.qa.invalid/compatible/v1'
  const imageKey = 'SYNTHETIC_PERSONAL_IMAGE_KEY'
  const imageModel = 'synthetic-image-model'
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64')
  const modelResponse = { data: [{ id: imageModel }, { id: imageModel }, { id: '' }] }
  const imageResponse = { data: [{ b64_json: png.toString('base64') }] }
  const held = new Map(), inflight = new Set(), dispatched = []
  let maxInflight = 0
  const awaitingAck = new Set()
  const finish = (reply, result) => {
    const value = JSON.stringify(result)
    reply('image.result', { data: value.slice(0, 21) })
    reply('image.result', { data: value.slice(21) })
    reply('image.done')
  }
  const imageSpecs = new Map()
  establish(true, null, { ...flags, personalImage: true }, (msg, reply) => {
    assert.equal(msg.version, 1)
    if (msg.type === 'image.request' || msg.type === 'image.chunk') {
      assert.equal(awaitingAck.has(msg.id), false, 'Each upload frame waits for its acknowledgement')
      awaitingAck.add(msg.id)
      if (msg.type === 'image.request') imageSpecs.set(msg.id, msg)
      queueMicrotask(() => {
        awaitingAck.delete(msg.id)
        reply('image.ack')
      })
    } else if (msg.type === 'image.run') {
      assert.equal(awaitingAck.has(msg.id), false)
      const { operation, prompt } = imageSpecs.get(msg.id)
      dispatched.push(prompt ?? operation)
      if (prompt?.startsWith('batch-')) {
        inflight.add(msg.id)
        maxInflight = Math.max(maxInflight, inflight.size)
        held.set(prompt, () => {
          inflight.delete(msg.id)
          finish(reply, imageResponse)
        })
      } else {
        queueMicrotask(() => {
          if (prompt === 'provider error') reply('image.error', { message: '合成服务错误（HTTP 503）。' })
          else finish(reply, operation === 'models' ? modelResponse : imageResponse)
        })
      }
    } else {
      assert.equal(msg.type, 'image.cancel')
      inflight.delete(msg.id)
    }
  })
  const browserImageRequests = []
  globalThis.fetch = async (url, init) => {
    browserImageRequests.push({ url, init })
    throw new TypeError('Simulated browser CORS rejection')
  }
  await images.initializeImageProvider()
  assert.equal(images.managedImageAvailable(), true)
  assert.deepEqual(await images.imageModels('https://image.qa.invalid/', imageKey), [imageModel])
  assert.equal([...imageSpecs.values()].at(-1).url, 'https://image.qa.invalid/v1/models')
  await images.configureImageProvider('personal', imageBase + '/', imageKey, imageModel)
  assert.equal(images.activeImageProvider(), 'personal')
  assert.deepEqual(await images.imageModels(imageBase, ''), [imageModel])
  assert.equal([...imageSpecs.values()].at(-1).key, imageKey)
  const freshSignal = () => new AbortController().signal
  const result = await images.requestPersonalImage('生成测试图', freshSignal())
  const generation = [...imageSpecs.values()].at(-1)
  assert.deepEqual([generation.operation, generation.url, generation.key, generation.model, generation.prompt],
    ['generate', imageBase + '/images/generations', imageKey, imageModel, '生成测试图'])
  assert.equal(result.model, imageModel)
  assert.deepEqual(Buffer.from(await result.images[0].blob.arrayBuffer()), png)
  const seed = Buffer.alloc(96 * 1024 + 17, 0x8a)
  png.copy(seed)
  const jpeg = Buffer.from([255, 216, 255, 217])
  const refs = [new File([seed], '参考.png', { type: 'image/png' }), new File([jpeg], 'photo.jpg', { type: 'image/jpeg' })]
  await images.requestPersonalImage('编辑两张图', freshSignal(), refs)
  const edit = [...imageSpecs.values()].at(-1)
  assert.equal(edit.operation, 'edit')
  assert.equal(edit.url, imageBase + '/images/edits')
  assert.deepEqual(edit.files, refs.map(file => ({ name: file.name, mime: file.type, size: file.size })))
  const chunks = sent.filter(frame => frame.type === 'image.chunk' && frame.id === edit.id)
  assert.deepEqual(chunks.map(chunk => chunk.index), [0, 0, 1])
  for (const [index, original] of [seed, jpeg].entries()) {
    assert.deepEqual(Buffer.concat(chunks.filter(chunk => chunk.index === index)
      .map(chunk => Buffer.from(chunk.data, 'base64'))), original)
  }
  await assert.rejects(images.requestPersonalImage('provider error', freshSignal()), /HTTP 503/)
  assert.equal(dispatched.filter(prompt => prompt === 'provider error').length, 1)

  const controls = Array.from({ length: 5 }, () => new AbortController())
  const batch = controls.map((control, index) =>
    images.requestPersonalImage(`batch-${index}`, control.signal).then(() => 'success', error => error.name))
  await pause()
  assert.deepEqual([...held.keys()], ['batch-0', 'batch-1'])
  controls[4].abort()
  controls[0].abort()
  await pause()
  assert.deepEqual([...held.keys()], ['batch-0', 'batch-1', 'batch-2'])
  const stopped = [...imageSpecs.values()].find(frame => frame.prompt === 'batch-0')
  assert.equal(sent.filter(frame => frame.type === 'image.cancel' && frame.id === stopped.id).length, 1)
  held.get('batch-1')()
  await pause()
  assert.deepEqual([...held.keys()], ['batch-0', 'batch-1', 'batch-2', 'batch-3'])
  held.get('batch-2')()
  held.get('batch-3')()
  assert.deepEqual(await Promise.all(batch), ['AbortError', 'success', 'success', 'success', 'AbortError'])
  assert.equal(maxInflight, 2)
  assert.equal(browserImageRequests.length, 0)

  establish(true, null, flags)
  await assert.rejects(images.imageModels(imageBase, ''), /跨域访问/)
  establish(false, null, { ...flags, personalImage: true })
  await assert.rejects(images.requestPersonalImage('浏览器请求', freshSignal()), /跨域访问/)
  establish(true, window, { ...flags, personalImage: true })
  await assert.rejects(images.imageModels(imageBase, ''), /跨域访问/)
  assert.deepEqual(browserImageRequests.map(({ url, init }) => [url, init.method]), [
    [imageBase + '/models', 'GET'], [imageBase + '/images/generations', 'POST'], [imageBase + '/models', 'GET'],
  ])
  for (const { init } of browserImageRequests) {
    assert.equal(init.credentials, 'omit')
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + imageKey)
  }

  establish(true, null, flags)
  await pause()
  runtime.invalidateSession('login', false)
  const before = sent.length
  settings.setThemePreference('dark')
  await pause()
  assert.equal(sent.length, before)
  detach()
  console.log(
    'Verified Android provider/theme and personal image bridges, trusted capability, multi-reference framing, abort and bounded concurrency, browser fallback, account binding, reply parameters and SSE. Zero real model calls.'
  )
} finally {
  rmSync(out, { recursive: true, force: true })
}
