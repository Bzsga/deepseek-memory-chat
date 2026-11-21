import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(root, '.context-check-'))
try {
  const compile = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--project', join(root, 'tsconfig.json'), '--noEmit', 'false', '--outDir', out],
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
  const question = (id, content = '我们之前的海边约定是什么？') => ({ id, role: 'user', content, files: [], createdAt: 1 })
  const fixture = (id, count = 200, length = 360) => {
    const messages = []
    for (let index = 0; index < count; index += 1) {
      messages.push(question(`u-${index}`, `第${index}轮海边约定，先保留原话。${'讨论条件和未决定事项。'.repeat(length)}`),
        { id: `a-${index}`, role: 'assistant', model: null, prefix: false, status: 'done', createdAt: 2,
          blocks: [{ type: 'text', text: `第${index}轮答复。我们以后再慢慢决定。` }] })
    }
    return { id, title: 'synthetic', createdAt: 1, updatedAt: 2, messages }
  }
  const small = fixture('small', 4, 1)
  const automaticBudget = memory.MODEL_CONTEXT_WINDOW - memory.RESPONSE_TOKEN_RESERVE
  assert.equal(automaticBudget, 936000)
  assert.equal(memory.newConversationMemory().contextBudgetTokens, automaticBudget)
  for (const legacy of [32000, 64000, 128000]) {
    const migrated = memory.validateConversationMemory({ ...memory.newConversationMemory(), contextBudgetTokens: legacy })
    assert.equal(migrated.contextBudgetTokens, automaticBudget)
    assert.equal(memory.withAutomaticContextBudget(migrated), migrated)
  }
  assert.throws(() => memory.validateConversationMemory({ ...memory.newConversationMemory(), contextBudgetTokens: 1000000 }))
  assert.throws(() => memory.planContext(small, [], question('oversize', '超'.repeat(automaticBudget)), 'BASE'), /拆分本条内容或减少附件/)
  const originalSmall = JSON.stringify(small)
  const shortPlan = memory.planContext(small, small.messages, question('next'), 'BASE')
  assert.equal(shortPlan.history.length, small.messages.length)
  assert.equal(shortPlan.limited, false)
  small.longMemory = { ...memory.newConversationMemory(), entries: [{ id: 'manual', kind: 'fact', text: '以后讨论海边旅行时保留弹性。', sourceIds: [], sourceSignature: '', pinned: true, edited: true, createdAt: 3 }] }
  assert.equal(memory.planContext(small, small.messages, question('next'), 'BASE').history.length, small.messages.length)
  assert.ok(memory.planContext(small, small.messages, question('next'), 'BASE').system.includes('保留弹性'))
  assert.equal(JSON.stringify({ ...small, longMemory: undefined }), originalSmall)

  const large = fixture('large')
  const original = JSON.stringify(large)
  const plan = memory.planContext(large, large.messages, question('next'), 'BASE')
  assert.ok(plan.estimatedTokens <= automaticBudget)
  assert.ok(plan.history.length < large.messages.length)
  assert.ok(plan.segment)
  assert.ok(plan.segment.source.length <= 128)
  assert.ok(plan.segment.source.every((message) => large.messages.includes(message)))
  assert.ok(plan.history.some((message) => message.id === 'u-199'))
  const entry = memory.parseMemoryCompression(JSON.stringify({ entries: [{ kind: 'decision', text: '旅行时间尚未确定。', sourceIds: [plan.segment.source[0].id] }] }), plan.segment)[0]
  assert.ok(memory.sourcesMatch(entry, large.messages))
  assert.throws(() => memory.parseMemoryCompression(JSON.stringify({ entries: [{ kind: 'fact', text: '伪造', sourceIds: ['foreign'] }] }), plan.segment))
  assert.throws(() => memory.parseMemoryCompression('not JSON', plan.segment))
  for (const status of ['started', 'failed', 'interrupted']) {
    const checkpoint = { ...plan.segment.checkpoint, status }
    const blocked = { ...large, longMemory: { ...memory.newConversationMemory(), segments: [checkpoint] } }
    assert.equal(memory.planContext(blocked, large.messages, question('next'), 'BASE').segment, undefined)
  }
  const storedMemory = { ...memory.newConversationMemory(), entries: [entry], segments: [{ ...plan.segment.checkpoint, status: 'complete' }] }
  const remembered = { ...large, longMemory: storedMemory }
  const following = memory.planContext(remembered, large.messages, question('next'), 'BASE')
  assert.ok(following.segment?.source.every((message) => !plan.segment.checkpoint.sourceIds.includes(message.id)))
  assert.ok(!memory.memoryCompressionPrompt(following.segment.source).includes(entry.text))
  assert.equal(JSON.stringify(large), original)

  const branch = { ...small, rootMessageId: 'u-0', messages: [
    { ...small.messages[0], parentId: null, selectedChildId: 'alternate' },
    { ...small.messages[1], parentId: 'u-0' },
    { ...small.messages[1], id: 'alternate', parentId: 'u-0', blocks: [{ type: 'text', text: '另一条分支' }] },
  ], longMemory: { ...memory.newConversationMemory(), entries: [
    { ...entry, id: 'shared', sourceIds: ['u-0'], sourceSignature: memory.sourceSignature([small.messages[0]]) },
    { ...entry, id: 'other', sourceIds: ['a-0'], sourceSignature: memory.sourceSignature([small.messages[1]]) },
  ] } }
  assert.deepEqual(memory.memoryForExport(branch).map((item) => item.id), ['shared'])
  assert.equal(memory.sourcesMatch(branch.longMemory.entries[0], [{ ...small.messages[0], content: '改过的正文' }]), false)
  const archived = readSessionFile(toSessionFile(branch, () => null))
  const restored = toLocalSession(archived).session
  assert.deepEqual(memory.memoryForExport(restored).map((item) => item.id), ['shared'])
  assert.equal(restored.longMemory.entries.length, 2)
  const oldBudgetArchive = structuredClone(archived)
  oldBudgetArchive.long_term_memory.contextBudgetTokens = 32000
  assert.equal(toLocalSession(readSessionFile(oldBudgetArchive)).session.longMemory.contextBudgetTokens, automaticBudget)
  const stale = { ...branch, longMemory: { ...branch.longMemory, entries: [{ ...branch.longMemory.entries[0], sourceSignature: 'stale' }] } }
  assert.equal(memory.memoryForExport(toLocalSession(readSessionFile(toSessionFile(stale, () => null))).session).length, 0)
  const missing = structuredClone(archived)
  missing.long_term_memory.entries[0].sourceIds = ['missing-message']
  assert.throws(() => toLocalSession(readSessionFile(missing)))
  const background = '一段无关旧事。'.repeat(20000) + '重要海边约定：先不订日期。' + '继续保留其他历史。'.repeat(20000)
  const imported = { ...large, continuity: { title: '海边', sourceArchiveId: 'original', text: background } }
  const importedPlan = memory.planContext(imported, imported.messages, question('next'), 'BASE')
  assert.ok(importedPlan.estimatedTokens <= automaticBudget)
  assert.ok(importedPlan.system.includes('先不订日期'))
  assert.equal(imported.continuity.text, background)
  assert.equal(toLocalSession(readSessionFile(toSessionFile(imported, () => null))).session.continuity.text, background)
  const pictures = fixture('pictures', 14, 1)
  pictures.messages.filter((message) => message.role === 'user').forEach((message) => {
    message.files = [{ id: message.id + '-file', serverId: 'file-synthetic', name: 'test.png', size: 1, isImage: true, mimeType: 'image/png' }]
  })
  const picturePlan = memory.planContext(pictures, pictures.messages, question('next'), 'BASE')
  assert.ok(picturePlan.estimatedTokens <= automaticBudget)
  assert.ok(picturePlan.estimatedTokens >= picturePlan.history.filter((item) => item.role === 'user').length * 4096)
  const fullMemory = { ...memory.newConversationMemory(), entries: Array.from({ length: 4090 }, (_, index) => ({ ...small.longMemory.entries[0], id: `item-${index}` })) }
  const capacityPlan = memory.planContext({ ...large, longMemory: fullMemory }, large.messages, question('next'), 'BASE')
  assert.equal(capacityPlan.capacityReached, true)
  assert.equal(capacityPlan.segment, undefined)
  assert.throws(() => memory.validateConversationMemory({ ...fullMemory, entries: [...fullMemory.entries, ...fullMemory.entries.slice(0, 7)] }))

  const sharedSource = { kind: 'deepseek-share', shareId: 'synthetic-share', url: 'https://chat.deepseek.com/share/synthetic-share',
    scope: 'shared_snapshot', importedAt: 3, rawSnapshot: 'RAW_SNAPSHOT_NEVER_SEND_TO_MODEL' }
  const partial = { ...fixture('partial', 1, 1), rootMessageId: 'shared-assistant', messages: [
    { ...small.messages[1], id: 'shared-assistant', parentId: null, selectedChildId: 'shared-user-a', blocks: [{ type: 'text', text: '最早分享助手原话😀' }] },
    { ...question('shared-user-a', '分享用户第一段'), parentId: 'shared-assistant', selectedChildId: 'shared-user-b' },
    { ...question('shared-user-b', '分享用户第二段'), parentId: 'shared-user-a' },
    { ...small.messages[1], id: 'shared-later', parentId: 'shared-user-b', blocks: [{ type: 'text', text: '之后的分享答复' }] },
  ], sharedSource: { ...sharedSource, messageIds: ['shared-assistant', 'shared-user-a', 'shared-user-b', 'shared-later'] } }
  const partialPlan = memory.planContext(partial, partial.messages.slice(0, 3), question('partial-next'), 'BASE')
  assert.ok(partialPlan.system.includes('最早分享助手原话😀'))
  assert.ok(partialPlan.system.includes('分享用户第一段'))
  assert.ok(partialPlan.system.includes('分享用户第二段'))
  assert.ok(partialPlan.system.includes('"role":"assistant"'))
  assert.ok(partialPlan.system.includes('"role":"user"'))
  assert.ok(!partialPlan.system.includes('之后的分享答复'))
  assert.ok(!partialPlan.system.includes(sharedSource.rawSnapshot))
  assert.ok(!memory.memoryCompressionPrompt(partial.messages).includes(sharedSource.rawSnapshot))
  const alternative = { ...partial, messages: [
    { ...question('branch-user', '分支问题'), parentId: null, selectedChildId: 'branch-selected' },
    { ...small.messages[1], id: 'branch-old', parentId: 'branch-user', blocks: [{ type: 'text', text: '未选分支原话不能进入当前上下文' }] },
    { ...small.messages[1], id: 'branch-selected', parentId: 'branch-user', blocks: [{ type: 'text', text: '当前选定答复' }] },
    { ...small.messages[1], id: 'detached-root', parentId: null, blocks: [{ type: 'text', text: '独立根原话不能进入当前上下文' }] },
  ], rootMessageId: 'branch-user', sharedSource: { ...sharedSource, messageIds: ['branch-user', 'branch-old', 'branch-selected', 'detached-root'] } }
  const alternativePlan = memory.planContext(alternative, [alternative.messages[0], alternative.messages[2]], question('branch-next'), 'BASE')
  assert.ok(!alternativePlan.system.includes('未选分支原话'))
  assert.ok(!alternativePlan.system.includes('独立根原话'))
  const detachedPlan = memory.planContext(alternative, [alternative.messages[3]], question('detached-next'), 'BASE')
  assert.ok(detachedPlan.system.includes('独立根原话'))
  assert.ok(!detachedPlan.system.includes('未选分支原话'))
  const partialArchive = readSessionFile(toSessionFile(partial, () => null))
  const partialRestored = toLocalSession(partialArchive).session
  assert.deepEqual(partialRestored.messages.map(message => message.role), partial.messages.map(message => message.role))
  assert.equal(partialRestored.sharedSource.rawSnapshot, sharedSource.rawSnapshot)
  assert.deepEqual(partialRestored.sharedSource.messageIds, partialRestored.messages.map(message => message.id))
  const hugePartial = { ...partial, messages: partial.messages.map((message, index) => index === 0
    ? { ...message, blocks: [{ type: 'text', text: ('海边原话😀'.repeat(150000)) }] } : message) }
  const boundedPartialPlan = memory.planContext(hugePartial, hugePartial.messages.slice(0, 3), question('partial-next'), 'BASE')
  assert.ok(boundedPartialPlan.estimatedTokens <= automaticBudget)
  assert.equal(boundedPartialPlan.limited, true)
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(boundedPartialPlan.system))
  assert.ok(!boundedPartialPlan.system.includes(sharedSource.rawSnapshot))

  // Keep the actual store and SSE client. Replace only IndexedDB with a durable
  // in-memory boundary so cancellation and dispatch ordering run under Node.
  writeFileSync(join(out, 'src/services/chat/db.js'), `
    export const rows = new Map(); export const writes = []; export const deleted = [];
    export let appendCalls = 0; let appendGate;
    export const setAppendGate = value => {appendGate = value};
    export const saveSession = async value => { writes.push(structuredClone(value)); rows.set(value.id,structuredClone(value)); };
    export const appendSession = async (value, canWrite) => {
      appendCalls += 1;
      if (appendGate) await appendGate(value);
      if (!canWrite()) throw Error('stale import');
      const existing = rows.get(value.id);
      if (existing) return existing;
      rows.set(value.id, structuredClone(value)); return value;
    };
    export const loadSession = async id => rows.get(id);
    export const loadSessionSummaries = async () => [];
    export const loadFile = async () => undefined;
    export const deleteSession = async id => {deleted.push(id); rows.delete(id)};
    export const clearStaging = async () => {};
    export const commitStaging = async () => {rows.clear();return []};
    export const reportStorageError = () => () => {};
  `)
  const db = await load('db.js')
  const store = await load('store.js')
  const drafts = await load('drafts.js')
  const { setReplyPreferences, useSettings } = await import(pathToFileURL(join(out, 'src/services/settings.js')))
  const { defaultReplyTuning } = await import(pathToFileURL(join(out, 'src/services/replyPreferences.js')))
  const persona = '请先总结，再举一个简短例子。'
  const warmth = '语气亲切体贴'
  const detail = '展开关键依据、前提、取舍和例外'
  const approach = '比较可行选项与主要取舍'
  setReplyPreferences({ ...defaultReplyTuning, replyTone: 'custom', replyWarmth: 'more',
    replyDetail: 'deep', replyApproach: 'compare', persona,
    temperature: '0.2', reasoningEffort: 'max' })
  useSettings.setState({ thinking: false })
  let mode = 'success'
  let releaseSummary
  let summaryCalls = 0
  let chatCalls = 0
  const eventResponse = (text) => new Response([
    { type: 'message_start', message: { id: 'synthetic-response', model: 'synthetic' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
    { type: 'message_stop' },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.system.startsWith('你负责从指定聊天原文')) {
      summaryCalls += 1
      assert.equal(body.system.includes(persona), false)
      assert.equal(body.system.includes(warmth), false)
      assert.equal(body.system.includes(detail), false)
      assert.equal(body.system.includes(approach), false)
      assert.equal(body.temperature, undefined)
      assert.equal(body.output_config, undefined)
      const persisted = db.rows.get(store.useChatStore.getState().activeId)
      assert.equal(persisted.longMemory.segments.at(-1).status, 'started')
      if (mode === 'fail') throw new TypeError('synthetic uncertain connection')
      if (mode === 'delay') await new Promise((resolveWait, reject) => {
        releaseSummary = resolveWait
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
      const content = body.messages[0].content
      const source = JSON.parse(content.slice(content.lastIndexOf('\n\n') + 2))
      return eventResponse(JSON.stringify({ entries: [{ kind: 'decision', text: '记得保留旅行时间的弹性。', sourceIds: [source[0].id] }] }))
    }
    chatCalls += 1
    assert.ok(body.system.includes(persona))
    assert.ok(body.system.includes(warmth))
    assert.ok(body.system.includes(detail))
    assert.ok(body.system.includes(approach))
    assert.equal(body.temperature, 0.2)
    assert.equal(body.output_config, undefined)
    assert.ok(memory.estimateTokens(body) < automaticBudget + 4000)
    return eventResponse('合成回复，继续在原会话交流。')
  }
  const until = async predicate => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (predicate()) return
      await new Promise(resolveWait => setTimeout(resolveWait, 5))
    }
    throw Error('Store operation timed out')
  }
  const seed = id => {
    const session = fixture(id)
    store.useChatStore.setState({ ready: true, importingHistory: false,
      activeId: id, sessions: [session], sessionCache: { [id]: session }, streaming: {}, memoryActivity: {} })
    return session
  }
  const send = id => { drafts.setDraftText(id, '继续聊海边计划'); assert.equal(store.sendMessage(id), true) }
  const idle = id => until(() => !store.useChatStore.getState().streaming[id])
  seed('existing-local')
  const sharedImport = { ...partial, id: 'shared-import' }
  const importTask = store.appendImportedSession(sharedImport, 'context-test-owner')
  assert.equal(store.appendImportedSession(sharedImport, 'context-test-owner'), importTask)
  assert.equal(await importTask, sharedImport.id)
  assert.equal(db.appendCalls, 1)
  assert.equal(store.useChatStore.getState().activeId, sharedImport.id)
  assert.ok(store.useChatStore.getState().sessions.some(session => session.id === 'existing-local'))
  assert.deepEqual(db.rows.get(sharedImport.id).sharedSource.messageIds, sharedImport.messages.map(message => message.id))
  await store.appendImportedSession({ ...sharedImport, title: 'must not overwrite' }, 'context-test-owner')
  assert.equal(db.rows.get(sharedImport.id).title, sharedImport.title)
  assert.equal(db.appendCalls, 1)
  await assert.rejects(store.appendImportedSession({ ...sharedImport, id: 'wrong-owner' }, 'foreign-owner'))
  assert.equal(db.rows.has('wrong-owner'), false)
  const oldLocal = { ...fixture('old-local', 1, 1), longMemory: { ...memory.newConversationMemory(), contextBudgetTokens: 64000 } }
  db.rows.set(oldLocal.id, structuredClone(oldLocal))
  store.useChatStore.setState({ ready: true, sessions: [oldLocal], sessionCache: {}, activeId: null })
  store.selectSession(oldLocal.id)
  await until(() => db.rows.get(oldLocal.id).longMemory.contextBudgetTokens === automaticBudget)
  assert.deepEqual(db.rows.get(oldLocal.id).messages.map(message => message.id), oldLocal.messages.map(message => message.id))
  let releaseImport
  db.setAppendGate(() => new Promise(resolveWait => {releaseImport = resolveWait}))
  const deletingImport = store.appendImportedSession({ ...sharedImport, id: 'deleting-import' }, 'context-test-owner')
  const deletionRejected = assert.rejects(deletingImport)
  await until(() => releaseImport !== undefined)
  const deleting = store.removeSession('deleting-import')
  assert.ok(!db.deleted.includes('deleting-import'))
  releaseImport()
  assert.equal(await deleting, true)
  await deletionRejected
  assert.equal(db.rows.has('deleting-import'), false)
  assert.notEqual(store.useChatStore.getState().activeId, 'deleting-import')
  releaseImport = undefined
  const replacingImport = store.appendImportedSession({ ...sharedImport, id: 'replacing-import' }, 'context-test-owner')
  const replacementRejected = assert.rejects(replacingImport)
  await until(() => releaseImport !== undefined)
  const replacing = store.replaceHistory(async () => {})
  releaseImport()
  await replacing
  await replacementRejected
  assert.equal(db.rows.has('replacing-import'), false)
  assert.equal(store.useChatStore.getState().sessions.length, 0)
  db.setAppendGate(undefined)
  seed('successful')
  send('successful')
  await idle('successful')
  assert.equal(summaryCalls, 1)
  assert.equal(chatCalls, 1)
  assert.equal(store.useChatStore.getState().sessionCache.successful.longMemory.segments[0].status, 'complete')
  assert.equal(store.useChatStore.getState().sessionCache.successful.longMemory.entries.length, 1)
  mode = 'fail'
  seed('failed')
  send('failed')
  await idle('failed')
  const failedCount = summaryCalls
  send('failed')
  await idle('failed')
  assert.equal(summaryCalls, failedCount)
  mode = 'success'
  assert.equal(store.retryMemoryPreparation('failed'), true)
  send('failed')
  await idle('failed')
  assert.equal(summaryCalls, failedCount + 1)
  memory.validateConversationMemory(store.useChatStore.getState().sessionCache.failed.longMemory)
  mode = 'delay'
  seed('cancelled')
  send('cancelled')
  await until(() => releaseSummary !== undefined)
  store.stopReply('cancelled')
  await idle('cancelled')
  assert.equal(store.useChatStore.getState().sessionCache.cancelled.longMemory.entries.length, 0)
  assert.equal(store.useChatStore.getState().sessionCache.cancelled.longMemory.segments[0].status, 'interrupted')
  releaseSummary = undefined
  seed('deleted')
  send('deleted')
  await until(() => releaseSummary !== undefined)
  assert.equal(await store.removeSession('deleted'), true)
  assert.equal(db.rows.has('deleted'), false)
  assert.equal(store.useChatStore.getState().sessionCache.deleted, undefined)
  releaseSummary = undefined
  seed('replaced')
  send('replaced')
  await until(() => releaseSummary !== undefined)
  await store.replaceHistory(async () => {})
  assert.equal(store.useChatStore.getState().sessions.length, 0)
  releaseSummary = undefined
  seed('other-branch')
  send('other-branch')
  await until(() => releaseSummary !== undefined)
  const current = store.useChatStore.getState().sessionCache['other-branch']
  store.useChatStore.setState({ sessionCache: { 'other-branch': { ...current, rootMessageId: null } } })
  releaseSummary()
  await idle('other-branch')
  assert.equal(store.useChatStore.getState().sessionCache['other-branch'].longMemory.entries.length, 0)
  releaseSummary = undefined
  seed('account-ended')
  send('account-ended')
  await until(() => releaseSummary !== undefined)
  releaseImport = undefined
  db.setAppendGate(() => new Promise(resolveWait => {releaseImport = resolveWait}))
  const accountImport = store.appendImportedSession({ ...sharedImport, id: 'account-import' }, 'context-test-owner')
  const accountImportRejected = assert.rejects(accountImport)
  await until(() => releaseImport !== undefined)
  runtime.setSessionEndHandler(() => store.stopReply('account-ended'))
  runtime.invalidateSession('login', false)
  releaseImport()
  await accountImportRejected
  assert.equal(db.rows.has('account-import'), false)
  await idle('account-ended')
  assert.equal(store.useChatStore.getState().sessionCache['account-ended'].longMemory.entries.length, 0)
  assert.throws(() => runtime.initializeRuntime({ provider: 'other', model: 'synthetic', features: {}, user: { id: 'different-owner', username: 'other', role: 'user' } }))
  console.log('Context memory checks passed: automatic 936K and legacy migration, bounded text/files/continuity, partial-share original roles and Unicode excerpts, snapshot isolation and portable sources, idempotent imports and delete/replace/account races, recent originals, memory source/branch validation, backup remapping, capacity, chat-only reply preferences, store/SSE dispatch ordering, success, uncertain-result pause and explicit retry, cancellation, deletion, history replacement, branch change, and account end. No model or external network calls.')
} finally {
  if (!out.startsWith(root + sep)) throw Error('Unexpected temporary output')
  rmSync(out, { recursive: true, force: true })
}
