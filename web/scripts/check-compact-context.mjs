import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(root, '.compact-context-check-'))
try {
  const compile = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--project', join(root, 'tsconfig.json'), '--noEmit', 'false', '--rootDir', root, '--outDir', out],
  { cwd: root, encoding: 'utf8' })
  assert.equal(compile.status, 0, compile.stdout + compile.stderr)
  globalThis.__API_ORIGIN__ = '/deepseek-api/chat'
  globalThis.window = new EventTarget()
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
  globalThis.cancelAnimationFrame = () => {}
  const local = new Map()
  globalThis.localStorage = {
    getItem: key => local.get(key) ?? null,
    setItem: (key, value) => local.set(key, value),
    removeItem: key => local.delete(key),
  }
  const runtime = await import(pathToFileURL(join(out, 'src/services/runtime.js')))
  runtime.initializeRuntime({ provider: 'DeepSeek', model: 'synthetic', features: { search: false, files: false, speech: false },
    user: { id: 'context-test-owner', username: 'synthetic', role: 'user', managed_eligible: true } })
  const load = (name) => import(pathToFileURL(join(out, 'src/services/chat', name)))
  const memory = await load('contextMemory.js')
  const { toSessionFile } = await load('history/toArchive.js')
  const { toLocalSession } = await load('history/toLocal.js')
  const { readSessionFile } = await load('history/schema.js')
  const { toRequestMessages } = await load('reply.js')
  const { encodeSyncSnapshot, decodeSyncSnapshot } = await load('syncCodec.js')
  const timestamp = 1794931200000
  const question = (id, content, files = []) => ({ id, role: 'user', content, files, createdAt: timestamp })
  const answer = (id, content) => ({ id, role: 'assistant', status: 'done', model: 'deepseek-flash',
    prefix: false, createdAt: timestamp + 1, blocks: [{ type: 'text', text: content }] })
  const createSession = (messages, longMemory) => ({ id: 'compact-fixture', title: '合成测试', createdAt: timestamp,
    updatedAt: timestamp + 1, messages, ...(longMemory ? { longMemory } : {}) })
  const complete = memory.newConversationMemory()
  const compact = { ...complete, contextMode: 'compact' }
  const next = question('next', '继续讨论海边行程')
  const plan = (session, current = next) => memory.planContext(session, session.messages, current, 'SYSTEM')
  const references = (value) => JSON.parse(value.system.split('\n').at(-1))
  const small = createSession([question('first', '合成问题'), answer('initial-answer', '合成回答')], compact)
  assert.equal(plan(small).limited, false)
  assert.equal(plan(small).limitedByCompact, undefined)
  assert.equal(plan(small).history.length, 2)
  assert.equal(memory.memorySummary(small).budget, 128000)
  assert.deepEqual(memory.validateConversationMemory({ ...complete, contextBudgetTokens: 32000 }), complete)
  assert.deepEqual(memory.validateConversationMemory({ ...compact, contextBudgetTokens: 128000 }), compact)
  for (const unsupported of ['complete', 'unexpected', null, 0]) {
    assert.throws(() => memory.validateConversationMemory({ ...complete, contextMode: unsupported }))
  }
  const snapshot = encodeSyncSnapshot(small)
  assert.equal(decodeSyncSnapshot(snapshot, small.id).longMemory.contextMode, 'compact')
  const archive = readSessionFile(toSessionFile(small, () => null))
  assert.equal(toLocalSession(archive).session.longMemory.contextMode, 'compact')

  const history = Array.from({ length: 90 }, (_, index) => [
    question('u-' + index, (index === 0 ? '海边行程和防晒问题。' : '记录其他主题与细节。').repeat(260)),
    answer('a-' + index, '合成回答'),
  ]).flat()
  const pinned = { id: 'pinned', kind: 'fact', text: '仍要保留手动记忆。', sourceIds: [], sourceSignature: '',
    pinned: true, edited: true, createdAt: timestamp }
  const limited = plan(createSession(history, { ...compact, entries: [pinned] }))
  const unbounded = plan(createSession(history, { ...complete, entries: [pinned] }))
  assert.ok(unbounded.history.length > limited.history.length)
  assert.ok(limited.estimatedTokens <= 128000)
  assert.ok(limited.history.some(item => item.id === 'u-89'))
  assert.ok(limited.history.some(item => item.id === 'u-0'))
  assert.equal(references(limited).memories[0].text, pinned.text)
  assert.equal(limited.limitedByCompact, true)
  assert.equal(limited.segment, undefined)

  const largeHistory = Array.from({ length: 230 }, (_, index) => [
    question('big-' + index, '用于测试容量的普通文字。'.repeat(440)),
    answer('reply-' + index, '合成回答'),
  ]).flat()
  const actualLimit = plan(createSession(largeHistory, compact))
  assert.ok(actualLimit.limited)
  assert.ok(actualLimit.segment)
  assert.equal(actualLimit.limitedByCompact, undefined)
  const largeQuestion = question('large-question', '本轮完整输入。'.repeat(24000))
  assert.deepEqual(plan(small, largeQuestion), plan({ ...small, longMemory: complete }, largeQuestion))
  const overCapacity = question('over-capacity', '超出模型容量。'.repeat(110000))
  assert.throws(() => plan(small, overCapacity), /拆分本条内容或减少附件/)

  const historicalFile = { id: 'large-local', serverId: 'file-api-historical', name: 'long.txt',
    mimeType: 'text/plain', size: 2_700_000, isImage: false }
  const currentFile = { ...historicalFile, id: 'current-local', serverId: 'file-api-current' }
  const smallFile = { ...historicalFile, id: 'small-local', serverId: 'file-api-small', name: 'short.txt', size: 700 }
  const historyWithFile = [question('doc-u', '请读旧资料', [historicalFile, smallFile]), answer('doc-a', '旧资料的相关答复')]
  const withFile = createSession(historyWithFile, compact)
  const fileQuestion = question('current-doc', '读取这次附件', [currentFile])
  const compactFiles = plan(withFile, fileQuestion)
  const fullFiles = plan({ ...withFile, longMemory: complete }, fileQuestion)
  assert.deepEqual(compactFiles.history.map(({ id }) => id), ['doc-u', 'doc-a'])
  assert.deepEqual(compactFiles.history[0].files, [smallFile])
  assert.deepEqual(withFile.messages[0].files, [historicalFile, smallFile])
  assert.deepEqual(fullFiles.history[0].files, [historicalFile, smallFile])
  assert.equal(compactFiles.limitedByCompact, true)
  assert.equal(compactFiles.segment, undefined)
  assert.match(references(compactFiles).historyNote, /历史大附件未带入/)
  const sent = JSON.stringify(toRequestMessages(compactFiles.history, fileQuestion))
  assert.match(sent, /file-api-current/)
  assert.match(sent, /file-api-small/)
  assert.doesNotMatch(sent, /file-api-historical/)
  const failedHistory = [...small.messages, question('failed-file', '未成功读取的旧附件', [historicalFile]),
    { ...answer('failed-reply', '上传失败'), status: 'error' }]
  const priorFailure = plan(createSession(failedHistory, compact))
  assert.equal(priorFailure.limitedByCompact, undefined)
  assert.doesNotMatch(JSON.stringify(toRequestMessages(priorFailure.history, next)), /file-api-historical/)

  const facts = ['苹果船票', '海边地点'].map((text, index) => ({
    ...pinned, id: 'fact-' + index, text, pinned: false, edited: false, createdAt: timestamp + index,
  }))
  const withFacts = { ...small, longMemory: { ...compact, entries: facts } }
  assert.equal(plan(withFacts, question('fruit', '苹果船票')).system,
    plan(withFacts, question('sea', '海边地点')).system)
  const original = '海海a😀b'.repeat(220_000)
  const excerptPlan = plan(createSession([question('source', original), answer('reply', '答复')], compact),
    question('excerpt', '海海'))
  const excerpts = references(excerptPlan).originalExcerpts
  assert.equal(excerpts.length, 1)
  assert.equal(excerpts[0].sourceId, 'source')
  assert.equal(excerpts[0].text, original.slice(excerpts[0].from, excerpts[0].from + excerpts[0].text.length))
  assert.equal(excerpts[0].text.length, 9999)
  assert.ok(!/[\uD800-\uDFFF]/u.test(excerpts[0].text))
  console.log('Compact context checks passed: default and optional codecs, soft cap/fallback, real-cap compaction, attachment/source preservation, stable memory order and Unicode excerpt union.')
} finally {
  rmSync(out, { recursive: true, force: true })
}
