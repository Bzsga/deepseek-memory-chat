import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = mkdtempSync(join(web, '.chat-usage-check-'))
assert.equal(dirname(output), web)
try {
  const compiled = spawnSync(process.execPath, [join(web, 'node_modules/typescript/bin/tsc'), '--project',
    join(web, 'tsconfig.json'), '--noEmit', 'false', '--noCheck', '--outDir', output], { cwd: web, encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  globalThis.__API_ORIGIN__ = '/deepseek-api/chat'
  globalThis.location = new URL('https://app.invalid/deepseek/')
  globalThis.localStorage = { getItem: () => null }
  globalThis.window = new EventTarget()
  const load = name => import(pathToFileURL(join(output, 'src/services', name + '.js')))
  const runtime = await load('runtime')
  runtime.initializeRuntime(runtime.localGuestRuntime())
  const { compatibleChatRequest, readCompatibleChatResponse } = await load('api/compatibleChat')
  const { readMessageEvent } = await load('api/parseEvent')
  const { decodeSyncSnapshot, encodeSyncSnapshot } = await load('chat/syncCodec')
  const plain = { model: 'fixture', system: '', messages: [{ role: 'user', content: 'synthetic' }],
    thinking: { type: 'disabled' }, tools: [], safety_check: { level: 'high' } }
  const enabled = { ...plain, thinking: { type: 'enabled' }, output_config: { effort: 'low' } }
  const off = JSON.parse(compatibleChatRequest('fixture', plain, 'https://api.deepseek.com/beta/'))
  assert.deepEqual(off.thinking, { type: 'disabled' })
  const on = JSON.parse(compatibleChatRequest('fixture', enabled, 'https://api.deepseek.com/v1'))
  assert.deepEqual(on.thinking, { type: 'enabled' })
  assert.equal(on.reasoning_effort, 'low')
  assert.equal('stream_options' in on, false)
  for (const base of [undefined, 'https://api.deepseek.com.example/beta', 'https://api.deepseek.com:8443/beta',
    'https://api.deepseek.com/unrecognized', 'https://provider.invalid/v1']) {
    const custom = JSON.parse(compatibleChatRequest('fixture', enabled, base))
    assert.equal('thinking' in custom, false)
    assert.equal(custom.reasoning_effort, 'low')
  }

  const sse = value => `data: ${JSON.stringify(value)}\n\n`
  const compatibleUsage = async (usage, earlierUsage) => {
    const chunk = { id: 'synthetic', choices: [{ index: 0, delta: { content: 'mock reply' } }] }
    const content = sse({ ...chunk, usage: earlierUsage }) +
      sse({ id: chunk.id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }) + 'data: [DONE]\n\n'
    const response = new Response(content, { headers: { 'Content-Type': 'text/event-stream' } })
    const events = []
    for await (const event of readCompatibleChatResponse(response, 'fixture', new AbortController().signal)) {
      events.push(event)
    }
    assert.equal(events.at(-1).type, 'message_stop')
    return events.at(-2).usage
  }
  const counts = { prompt_tokens: 100, completion_tokens: 30 }
  const cache = { input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0, output_tokens: 30 }
  const details = { output_tokens_details: { thinking_tokens: 16, safety_tokens: 0 } }
  assert.deepEqual(await compatibleUsage({ ...counts, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20,
    completion_tokens_details: { reasoning_tokens: 16, safety_tokens: 0, private: 'not a token count' } }), { ...cache, ...details })
  assert.deepEqual(await compatibleUsage({ ...counts, prompt_tokens_details: { cached_tokens: 80 } }), cache)
  assert.deepEqual(await compatibleUsage({ ...counts, prompt_cache_miss_tokens: 20 }), cache)
  const unknown = { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    cache_usage_reported: false, output_tokens: 30 }
  assert.deepEqual(await compatibleUsage(counts), unknown)
  assert.deepEqual(await compatibleUsage({ ...counts, prompt_cache_hit_tokens: 1000 }), unknown)
  assert.deepEqual(await compatibleUsage({ ...counts, prompt_cache_miss_tokens: 20, prompt_cache_hit_tokens: 81 }), unknown)
  assert.equal(await compatibleUsage({ prompt_tokens: 100 }), undefined)
  assert.deepEqual(await compatibleUsage({ completion_tokens: 'bad' }, { ...counts, prompt_cache_hit_tokens: 80 }), cache)
  assert.deepEqual(await compatibleUsage({ ...counts, prompt_cache_hit_tokens: 0 }), { ...cache, input_tokens: 100, cache_read_input_tokens: 0 })

  const startingUsage = readMessageEvent({ type: 'message_start', message: { id: 'synthetic', model: 'fixture',
    usage: { ...cache, output_tokens: 0 } } }).message.usage
  const result = usage => ({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage })
  assert.deepEqual(readMessageEvent(result({ output_tokens: 30 }), startingUsage).usage, cache)
  assert.deepEqual(readMessageEvent(result({ ...cache, ...details }), startingUsage).usage, { ...cache, ...details })
  assert.equal(readMessageEvent(result({ output_tokens: 30 })).usage, undefined)
  assert.deepEqual(readMessageEvent(result({ input_tokens: 100, output_tokens: 30 })).usage, unknown)
  assert.deepEqual(readMessageEvent(result({ ...cache, output_tokens_details: { thinking_tokens: 999,
    safety_tokens: 0, private: 'not a token count' } })).usage, { ...cache, output_tokens_details: { safety_tokens: 0 } })

  const session = { id: 'synthetic-usage', title: 'Synthetic', createdAt: 1, updatedAt: 2, rootMessageId: 'question', messages: [
    { role: 'user', id: 'question', parentId: null, selectedChildId: 'reply', createdAt: 1, content: 'Question', files: [] },
    { role: 'assistant', id: 'reply', parentId: 'question', createdAt: 2, status: 'done', prefix: false,
      model: 'deepseek-flash', blocks: [{ type: 'text', text: 'Answer' }], usage: { ...unknown,
        output_tokens_details: { ...details.output_tokens_details, unrelated: 'private detail' } },
      compactionUsage: { ...cache, private: 'local-only usage' } },
  ] }
  const restored = decodeSyncSnapshot(encodeSyncSnapshot(session), session.id).messages[1]
  assert.deepEqual(restored.usage, { ...unknown, ...details })
  assert.equal('compactionUsage' in restored, false)
  assert.equal(JSON.stringify(restored).includes('private detail'), false)
  console.log('Chat usage checks passed: official thinking, custom compatibility, cumulative usage, cache aliases and unknown, output details, sync allowlist.')
} finally {
  rmSync(output, { recursive: true, force: true })
}
