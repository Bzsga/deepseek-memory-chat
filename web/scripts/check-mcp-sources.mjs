import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = mkdtempSync(join(root, '.mcp-sources-check-'))
try {
  const compiled = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--project', join(root, 'tsconfig.json'), '--noEmit', 'false', '--noCheck', '--outDir', output],
  { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  globalThis.__API_ORIGIN__ = '/deepseek-api/chat'
  globalThis.window = new EventTarget()
  globalThis.localStorage = { getItem: () => null }
  const load = (name) => import(pathToFileURL(join(output, 'src/services', name)))
  const { initializeRuntime } = await load('runtime.js')
  initializeRuntime({ provider: 'DeepSeek', model: 'synthetic', features: {},
    user: { id: 'mcp-test-owner', username: 'synthetic', role: 'user', managed_eligible: true } })
  const { normalizeMcpSources } = await load('chat/mcpSources.js')
  const { toRequestMessages } = await load('chat/reply.js')
  const { planContext, sourceSignature } = await load('chat/contextMemory.js')
  const { toSessionFile } = await load('chat/history/toArchive.js')
  const { readSessionFile } = await load('chat/history/schema.js')
  const { toLocalSession } = await load('chat/history/toLocal.js')
  const { encodeSyncSnapshot, decodeSyncSnapshot } = await load('chat/syncCodec.js')
  const { compatibleChatRequest } = await load('api/compatibleChat.js')

  const source = { title: '操作手册 😀', url: 'https://example.test/docs#query', text: '  合成资料原文\n第二行。  ' }
  const invalid = [
    { ...source, url: 'javascript:alert(1)' },
    { ...source, url: 'https://user:pass@example.test' },
    { ...source, url: 'https://@example.test' },
    { ...source, url: 'https:///example.test' },
    { ...source, url: 'https://example.test/\nignored' },
    { ...source, title: ' ' },
    { ...source, text: '字'.repeat(1601) },
    null,
  ]
  assert.deepEqual(normalizeMcpSources(invalid), [])
  const valid = Array.from({ length: 6 }, (_, index) => ({ ...source, title: `资料 ${index + 1}` }))
  assert.deepEqual(normalizeMcpSources([...invalid, ...valid]), valid.slice(0, 5))

  const question = { id: 'question', role: 'user', content: '  原始问题\n第二行。  ', createdAt: 1, files: [],
    parentId: null, selectedChildId: 'answer', mcpSources: [source] }
  const reply = { id: 'answer', role: 'assistant', status: 'done', prefix: false, model: 'deepseek-flash',
    parentId: 'question', createdAt: 2, blocks: [{ type: 'text', text: '合成答复。' }] }
  const session = { id: 'session', title: '合成会话', rootMessageId: 'question',
    createdAt: 1, updatedAt: 2, messages: [question, reply] }
  const followUp = { id: 'follow-up', role: 'user', content: '继续。', createdAt: 3, files: [] }
  const original = structuredClone(session)
  assert.deepEqual(toRequestMessages([], question), [{ role: 'user', content: question.content }])
  assert.equal(sourceSignature([question]), sourceSignature([{ ...question, mcpSources: undefined }]))
  const request = toRequestMessages(session.messages, followUp, undefined, false, undefined, undefined, true)
  assert.equal(request[0].content.split('\n\n')[0], question.content)
  const references = request[0].content.split('\n').find((line) => line.startsWith('[{'))
  assert.deepEqual(JSON.parse(references), [source])
  assert.equal(request.at(-1).content, followUp.content)
  const compatible = JSON.parse(compatibleChatRequest('synthetic', { messages: request }))
  assert.equal(compatible.messages[0].content, request[0].content)
  const ordinaryPlan = planContext(session, session.messages, followUp, 'BASE')
  const referencePlan = planContext(session, session.messages, followUp, 'BASE', undefined, undefined, true)
  assert.ok(referencePlan.estimatedTokens > ordinaryPlan.estimatedTokens)
  assert.equal(ordinaryPlan.system, referencePlan.system)
  assert.deepEqual(session, original)

  const archive = toSessionFile(session, () => null)
  archive.messages[0].mcp_sources.unshift(...invalid)
  archive.messages[1].mcp_sources = [source]
  const restored = toLocalSession(readSessionFile(JSON.parse(JSON.stringify(archive)))).session
  assert.equal(restored.messages[0].content, question.content)
  assert.deepEqual(restored.messages[0].mcpSources, [source])
  assert.equal(restored.messages[1].mcpSources, undefined)
  const synced = encodeSyncSnapshot(session)
  synced.session.messages[0].mcpSources.unshift(...invalid)
  assert.deepEqual(decodeSyncSnapshot(synced, session.id), original)
  assert.deepEqual(session, original)
  console.log('MCP sources retain original questions, URLs and excerpts across requests, backups and sync.')
} finally {
  rmSync(output, { recursive: true, force: true })
}
