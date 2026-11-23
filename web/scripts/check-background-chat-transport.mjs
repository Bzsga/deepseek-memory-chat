import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(web, '.background-chat-'))
try {
  execFileSync(process.execPath, [join(web, 'node_modules/typescript/bin/tsc'), '--project', join(web, 'tsconfig.json'),
    '--noEmit', 'false', '--outDir', out], { cwd: web })
  const service = name => join(out, 'src/services', name + '.js')
  writeFileSync(service('chatProvider'), `
    export const captureChatProvider = key => key === 'managed-test' ? { mode: 'managed' } : {
      mode: 'personal', model: 'fixture', apiKey: key, baseUrl: key === 'official-test'
        ? 'https://api.deepseek.com' : 'https://provider.invalid/v1',
    };
  `)
  const load = name => import(pathToFileURL(service(name)))
  globalThis.__API_ORIGIN__ = '/deepseek-api/chat'
  globalThis.location = new URL('https://digimonlegend.com/deepseek/')
  globalThis.localStorage = { getItem: () => null }
  globalThis.window = new class extends EventTarget {
    addEventListener(name, callback, options) {
      if (name === 'message') this.receive = callback
      super.addEventListener(name, callback, options)
    }
  }()
  window.top = window
  const runtime = await load('runtime')
  runtime.initializeRuntime({ model: 'deepseek-flash', features: { background_chat: true },
    user: { id: 'synthetic-user', username: 'synthetic', role: 'user', managed_eligible: true } })
  const api = await load('api/client')
  const bridge = await load('nativeBridge')
  bridge.bindNativeBridge(async () => {})
  const body = { model: 'deepseek-flash', messages: [{ role: 'user', content: '合成问题' }] }
  const signal = new AbortController().signal
  const sse = event => `data: ${JSON.stringify(event)}\n\n`
  const start = sse({ type: 'message_start', message: { id: 'synthetic', model: 'fixture' } })
  const first = sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  const delta = sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '原请求完成' } })
  const finish = sse({ type: 'message_stop' })
  const read = async (...args) => {
    const events = []
    for await (const event of api.streamBackgroundChat(...args)) events.push(event)
    return events
  }
  assert.equal(api.captureBackgroundChatTransport('managed-test'), 'managed')
  let submissions = 0, watches = 0
  globalThis.fetch = async (url, init) => {
    assert.equal(new Headers(init.headers).has('authorization'), false)
    if (init.method === 'POST') {
      assert.match(url, /\/chat-jobs\/qa-managed$/)
      submissions++
      assert.equal(JSON.parse(init.body).stream, true)
      throw new Error('acknowledgement was lost after acceptance')
    }
    assert.match(url, /\/qa-managed\/events$/)
    watches++
    return new Response(start + first + (watches === 1 ? '' : delta + finish),
      { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const managed = await read('managed-test', 'qa-managed', body, signal)
  assert.deepEqual(managed.map(event => event.type), ['message_start', 'content_block_start', 'content_block_delta', 'message_stop'])
  assert.equal(submissions, 1)
  assert.equal(watches, 2)

  // Advance only chat watchdogs and shorten transport backoff; no test calls an external service.
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const timers = new Map()
  const chatWatchdogs = new Set([180_000, 480_000, 65_000, 20_000, 35_000, 210_000, 960_000])
  const chatReconnectBackoffs = new Set([300, 800, 1800, 3500, 6500])
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (!chatWatchdogs.has(delay)) {
      return realSetTimeout(callback, chatReconnectBackoffs.has(delay) ? 0 : delay, ...args)
    }
    const handle = Symbol()
    timers.set(handle, { delay, expire: () => callback(...args) })
    return handle
  }
  globalThis.clearTimeout = handle => {
    if (!timers.delete(handle)) {realClearTimeout(handle)}
  }
  const active = delay => [...timers].filter(([, timer]) => timer.delay === delay)
  const expire = delay => {
    const matching = active(delay)
    assert.equal(matching.length, 1, `exactly one timer must be active for ${delay}ms`)
    const [handle, timer] = matching[0]
    timers.delete(handle)
    timer.expire()
  }
  const deferred = () => {
    let resolveValue
    const promise = new Promise(resolve => {resolveValue = resolve})
    return { promise, resolve: resolveValue }
  }
  const waitForAbort = signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const replyStream = (initial = '') => {
    let streamController
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        streamController = controller
        if (initial) {controller.enqueue(encoder.encode(initial))}
      },
    })
    return {
      response: new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
      push: text => streamController.enqueue(encoder.encode(text)),
      close: () => streamController.close(),
    }
  }
  const isDirectTimeout = error => error instanceof api.ApiError && error.code === 'chat_timeout'
  const nextTurn = () => new Promise(resolve => realSetTimeout(resolve, 0))
  try {
    const headerReached = deferred()
    let directPosts = 0
    globalThis.fetch = async (_url, { signal }) => {
      directPosts++
      headerReached.resolve()
      return waitForAbort(signal)
    }
    const hidden = api.streamMessage('official-test', body, signal).next()
    const headerTimeout = assert.rejects(hidden, isDirectTimeout)
    await headerReached.promise
    expire(180_000)
    await headerTimeout
    assert.equal(directPosts, 1)
    assert.equal(signal.aborted, false)
    assert.equal(timers.size, 0)

    const compatibleFrame = sse({ id: 'direct', choices: [{ index: 0, delta: { content: '保留片段' } }] })
    const compatible = replyStream(compatibleFrame)
    globalThis.fetch = async (url, init) => {
      assert.match(url, /\/chat\/completions$/)
      assert.equal(init.method, 'POST')
      return compatible.response
    }
    const direct = api.streamMessage('compatible-test', body, signal)
    let piece
    do {piece = await direct.next()} while (piece.value?.delta?.text !== '保留片段' && !piece.done)
    assert.equal(piece.value?.delta?.text, '保留片段')
    const held = direct.next()
    const directTimeout = assert.rejects(held, isDirectTimeout)
    const directIdle = active(180_000)[0][0]
    compatible.push(': keep-alive\n\n')
    await nextTurn()
    assert.equal(active(180_000)[0][0], directIdle)
    expire(180_000)
    await directTimeout
    assert.equal(timers.size, 0)

    const submitted = deferred(), firstChunk = deferred(), secondWatch = deferred()
    let timeoutPosts = 0, timeoutWatches = 0
    const blocked = replyStream(start + first + delta)
    const resumed = replyStream(start + first + delta)
    globalThis.fetch = async (url, init) => {
      if (init.method === 'POST') {
        assert.match(url, /\/chat-jobs\/qa-timeout$/)
        timeoutPosts++
        submitted.resolve()
        return waitForAbort(init.signal)
      }
      assert.match(url, /\/chat-jobs\/qa-timeout\/events$/)
      timeoutWatches++
      if (timeoutWatches === 1) {return blocked.response}
      secondWatch.resolve()
      return resumed.response
    }
    const timeoutEvents = []
    const running = (async () => {
      for await (const event of api.streamBackgroundChat('managed-test', 'qa-timeout', body, signal)) {
        timeoutEvents.push(event.type)
        if (event.type === 'content_block_delta') {firstChunk.resolve()}
      }
    })()
    await submitted.promise
    expire(65_000)
    await firstChunk.promise
    const progressTimer = active(210_000)[0][0]
    expire(35_000)
    await secondWatch.promise
    await nextTurn()
    assert.equal(active(210_000)[0][0], progressTimer)
    resumed.push(finish)
    resumed.close()
    await running
    assert.deepEqual(timeoutEvents, ['message_start', 'content_block_start', 'content_block_delta', 'message_stop'])
    assert.equal(timeoutPosts, 1)
    assert.equal(timeoutWatches, 2)
    assert.equal(timers.size, 0)

    const alive = replyStream(': keep-alive\n\n')
    const watching = deferred()
    globalThis.fetch = async (url, init) => {
      assert.match(url, /\/chat-jobs\/qa-keepalive\/events$/)
      assert.notEqual(init.method, 'POST')
      watching.resolve()
      return alive.response
    }
    const silent = api.streamBackgroundChat('managed-test', 'qa-keepalive', undefined, signal).next()
    const silentTimeout = assert.rejects(silent, error => error instanceof api.ApiError && error.code === 'chat_job_watch_interrupted')
    await watching.promise
    await nextTurn()
    const silentProgress = active(210_000)[0][0]
    const silentTransport = active(35_000)[0][0]
    alive.push(': keep-alive\n\n')
    await nextTurn()
    assert.equal(active(210_000)[0][0], silentProgress)
    assert.notEqual(active(35_000)[0][0], silentTransport)
    expire(210_000)
    await silentTimeout
    assert.equal(signal.aborted, false)
    assert.equal(timers.size, 0)
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }

  const nativeJobs = new Map()
  const nativeCalls = []
  const connect = trusted => {
    const port = {
      start() {}, close() {}, postMessage(message) {
        const frame = JSON.parse(message)
        if (!frame.type.startsWith('personal.chat.')) {return}
        const { jobId, offset } = frame.payload
        nativeCalls.push(frame.type)
        if (frame.type.endsWith('.start')) {
          assert.equal(nativeJobs.has(jobId), false)
          assert.equal(JSON.parse(frame.payload.body).stream, true)
          const compatible = frame.payload.key === 'compatible-test'
          assert.equal(frame.payload.url, compatible ? 'https://provider.invalid/v1/chat/completions' : 'https://api.deepseek.com/anthropic/v1/messages')
          const bytes = compatible ? sse({ id: 'native', choices: [{ index: 0, delta: { content: '兼容回复' }, finish_reason: 'stop' }] }) +
            'data: [DONE]\n\n' : start + first + delta + finish
          nativeJobs.set(jobId, Buffer.from(bytes))
        }
        let payload = { state: 'running' }
        if (frame.type.endsWith('.read')) {
          const chunk = nativeJobs.get(jobId).subarray(offset, offset + 19)
          payload = { state: 'done', status: 200, contentType: 'text/event-stream', chunk: chunk.toString('base64'),
            nextOffset: offset + chunk.length }
        }
        if (frame.type.endsWith('.cancel')) {payload = { state: 'cancelled' }}
        queueMicrotask(() => port.onmessage({ data: JSON.stringify({ version: 1, id: frame.id, type: 'personal.chat.response', ok: true, payload }) }))
      },
    }
    window.receive({ isTrusted: trusted, source: null, origin: location.origin, ports: [port],
      data: JSON.stringify({ type: 'deepseek.connect', version: 1 }) })
    port.onmessage({ data: JSON.stringify({ version: 1, id: 'personal-chat-capability', type: 'personal.chat.capability', personalBackgroundChat: true }) })
  }
  connect(false)
  assert.equal(api.captureBackgroundChatTransport('official-test'), undefined)
  connect(true)
  globalThis.fetch = () => { throw Error('Personal Android jobs must not use the application server') }
  const transport = api.captureBackgroundChatTransport('official-test')
  assert.equal(transport, 'personal-messages')
  await read('official-test', 'qa-personal', body, signal, transport)
  connect(true)
  const restored = await read('', 'qa-personal', undefined, signal, transport)
  assert.ok(restored.some(event => event.delta?.text === '原请求完成'))
  assert.equal(nativeCalls.filter(action => action.endsWith('.start')).length, 1)
  await api.cancelBackgroundChat('qa-personal', transport)
  assert.equal(nativeCalls.at(-1), 'personal.chat.cancel')
  const compatible = await read('compatible-test', 'qa-compatible', body, signal, 'personal-completions')
  assert.ok(compatible.some(event => event.delta?.text === '兼容回复'))
  assert.equal(compatible.at(-1).type, 'message_stop')
  console.log('Background chat transport checks passed: direct and managed deadlines, partial replies, lost submit ACK, same-ID SSE replay, trusted native negotiation, binary chunks, direct personal Messages and Chat Completions, reload and cancel. No external calls.')
} finally {
  rmSync(out, { recursive: true, force: true })
}
