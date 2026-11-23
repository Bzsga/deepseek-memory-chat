import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = mkdtempSync(join(root, '.mcp-chat-stream-check-'))
try {
  const compiled = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--project', join(root, 'tsconfig.json'), '--noEmit', 'false', '--noCheck', '--outDir', output],
  { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  globalThis.__API_ORIGIN__ = '/deepseek-api/chat'
  globalThis.window = new EventTarget()
  globalThis.localStorage = { getItem: () => null }
  const load = (path) => import(pathToFileURL(join(output, 'src/services', path)))
  const { initializeRuntime } = await load('runtime.js')
  initializeRuntime({ provider: 'DeepSeek', model: 'synthetic', features: {},
    user: { id: 'mcp-stream-fixture', username: 'synthetic', role: 'user', managed_eligible: true } })
  const { streamMcpChat } = await load('chat/mcpChatStream.js')
  const { readMessageEvent } = await load('api/parseEvent.js')
  const { streamMessage } = await load('api/client.js')

  const callId = 'toolu_fixture'
  const tool = {
    name: 'records.update', title: 'Update record', description: 'Update a synthetic record',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
    readOnly: false, revision: 'a'.repeat(64),
  }
  const body = {
    model: 'deepseek-flash', system: 'Test', messages: [{ role: 'user', content: 'Update a record' }],
    thinking: { type: 'enabled' }, tools: [], safety_check: { level: 'high' },
  }
  const usage = (output, input = 4) => ({
    input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 1, output_tokens: output,
  })
  const start = { type: 'message_start', message: { id: 'fixture', model: body.model, usage: usage(0) } }
  const stop = { type: 'message_stop' }
  const final = (stop_reason, output = 5) => ({
    type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: usage(output),
  })
  const begin = (index, content_block) => ({ type: 'content_block_start', index, content_block })
  const end = (index) => ({ type: 'content_block_stop', index })
  const delta = (index, data) => ({ type: 'content_block_delta', index, delta: data })
  const use = (index, name, id, input = {}) => begin(index, { type: 'tool_use', id, name, input })
  const wire = async function* (events) {
    for (const event of events) {
      const parsed = readMessageEvent(JSON.parse(JSON.stringify(event)))
      assert(parsed, 'Expected a valid Messages event')
      yield parsed
    }
  }
  const collect = async (stream) => {
    const events = []
    for await (const event of stream) {events.push(event)}
    return events
  }
  const outcome = (status = 'success') => ({ status, text: 'mock tool result', truncated: false })
  const requests = []
  const calls = []
  let stopped = false
  const events = await collect(streamMcpChat({
    body, tools: [tool], signal: new AbortController().signal, live: () => true,
    async *open(request) {
      requests.push(request)
      const name = request.tools[0].name
      if (requests.length === 1) {
        assert.deepEqual(request.tools, [{ name, description: tool.description, input_schema: tool.inputSchema }])
        assert.deepEqual(request.tool_choice, { type: 'auto' })
        try {
          yield* wire([
            start, begin(0, { type: 'thinking', thinking: '', signature: '' }),
            delta(0, { type: 'thinking_delta', thinking: 'Need to update.' }),
            delta(0, { type: 'signature_delta', signature: 'fixture-signature' }), end(0),
            begin(1, { type: 'text', text: 'Checking.' }), end(1),
            use(2, name, callId), delta(2, { type: 'input_json_delta', partial_json: '{"label":' }),
            delta(2, { type: 'input_json_delta', partial_json: '"合成记录"}' }), end(2),
            use(3, name, 'toolu_second', { label: 'skip' }), end(3), final('tool_use'), stop,
          ])
        } finally {stopped = true}
      } else {
        assert.deepEqual(request.tool_choice, { type: 'none' })
        assert.deepEqual(request.tools, requests[0].tools)
        assert.deepEqual(request.messages[1], { role: 'assistant', content: [
          { type: 'thinking', thinking: 'Need to update.', signature: 'fixture-signature' },
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', name, id: callId, input: { label: '合成记录' } },
          { type: 'tool_use', name, id: 'toolu_second', input: { label: 'skip' } },
        ] })
        const results = request.messages[2].content
        assert.deepEqual(results.map(({ tool_use_id }) => tool_use_id), [callId, 'toolu_second'])
        assert.deepEqual(results.map(({ content }) => JSON.parse(content).status), ['success', 'rejected'])
        yield* wire([start, begin(0, { type: 'text', text: 'Done.' }), end(0), final('end_turn', 9), stop])
      }
    },
    async run(call) {
      assert(stopped)
      calls.push(call)
      return outcome(calls.length === 1 ? 'success' : 'rejected')
    },
  }))
  assert.deepEqual(calls, [
    { id: callId, tool, args: { label: '合成记录' } },
    { id: 'toolu_second', tool, args: { label: 'skip' } },
  ])
  assert.deepEqual(events.filter(({ type }) => type === 'content_block_start').map(({ index }) => index), [0, 1, 2])
  assert.equal(events.filter(({ type }) => type === 'message_start').length, 1)
  assert.equal(events.filter(({ type }) => type === 'message_stop').length, 1)
  assert.deepEqual(events.filter(({ type }) => type === 'message_delta'), [{
    ...final('end_turn'),
    delta: { ...final('end_turn').delta, title: undefined },
    usage: { ...usage(14, 8), cache_read_input_tokens: 2 },
  }])

  const blocked = [
    (name) => [use(0, name, callId), end(0), final('tool_use')], // Missing message_stop.
    (name) => [use(0, name, callId), final('tool_use'), stop], // Missing block stop.
    () => [use(0, 'unknown', callId), end(0), final('tool_use'), stop],
    (name) => [use(0, name, callId), end(0), use(1, name, callId), end(1), final('tool_use'), stop],
    (name) => [use(0, name, callId), delta(0, { type: 'input_json_delta', partial_json: '{"x":' }),
      end(0), final('tool_use'), stop],
    (name) => [use(0, name, callId, { label: 'x'.repeat(24 * 1024) }), end(0), final('tool_use'), stop],
    (name) => [...Array.from({ length: 4 }, (_, n) => [use(n, name, `call-${n}`), end(n)]).flat(),
      final('tool_use'), stop],
  ]
  for (const fixture of blocked) {
    await assert.rejects(collect(streamMcpChat({
      body, tools: [tool], signal: new AbortController().signal, live: () => true,
      open(request) {return wire([start, ...fixture(request.tools[0].name)])},
      async run() {assert.fail('Incomplete or invalid call must never execute')},
    })), { name: 'ApiError' })
  }

  const stopper = new AbortController()
  let executed = 0
  await assert.rejects(collect(streamMcpChat({
    body, tools: [tool], signal: stopper.signal, live: () => true,
    open(request) {
      assert.equal(request.tool_choice.type, 'auto')
      const name = request.tools[0].name
      return wire([start, use(0, name, callId), end(0), use(1, name, 'second'), end(1), final('tool_use'), stop])
    },
    async run() {
      executed++
      stopper.abort()
      return outcome()
    },
  })), { name: 'AbortError' })
  assert.equal(executed, 1)

  let requestCount = 0
  let runCount = 0
  await assert.rejects(collect(streamMcpChat({
    body, tools: [tool], signal: new AbortController().signal, live: () => true,
    open(request) {
      requestCount++
      return wire([start, use(0, request.tools[0].name, callId), end(0), final('tool_use'), stop])
    },
    async run() {runCount++; return outcome('uncertain')},
  })), { name: 'ApiError' })
  assert.equal(requestCount, 2)
  assert.equal(runCount, 1)

  // Run the original transport against synthetic frames to verify that only
  // client-tool requests refuse a malformed event instead of skipping it.
  const frames = [
    start, begin(0, { type: 'text', text: 'Hello.' }),
    delta(0, { type: 'input_json_delta', partial_json: null }),
    end(0), final('end_turn'), stop,
  ]
  globalThis.fetch = async () => new Response(
    frames.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
  const signal = new AbortController().signal
  await assert.rejects(collect(streamMessage('server-managed', {
    ...body, tools: [{ name: 'mock_tool', input_schema: tool.inputSchema }],
  }, signal)), { code: 'personal_mcp_protocol' })
  assert.equal((await collect(streamMessage('server-managed', body, signal))).at(-1).type, 'message_stop')
  console.log('MCP Messages stream checks passed.')
} finally {
  rmSync(output, { recursive: true, force: true })
}
