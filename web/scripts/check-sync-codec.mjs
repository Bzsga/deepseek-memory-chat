import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = mkdtempSync(join(root, '.sync-codec-check-'))
try {
  const compiled = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--project', join(root, 'tsconfig.json'), '--noEmit', 'false', '--noCheck', '--outDir', output],
  { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  globalThis.__API_ORIGIN__ = '/deepseek-api/chat'
  const { encodeSyncSnapshot, decodeSyncSnapshot, referencedSyncFiles } = await import(
    pathToFileURL(join(output, 'src/services/chat/syncCodec.js')))
  const timestamp = 1794931200000
  const reply = (id, parentId, blocks) => ({
    id, parentId, role: 'assistant', createdAt: timestamp + 1, model: 'deepseek-flash',
    prefix: true, status: 'done', blocks, stopReason: 'end_turn',
  })
  const citation = { type: 'web_search_result_location', url: 'https://example.com/source',
    title: '原来源', cited_text: '  原引用\n保留空白  ', encrypted_index: '' }
  const session = {
    id: 'session-original', title: '原会话', createdAt: timestamp, updatedAt: timestamp + 2,
    rootMessageId: 'user-original',
    messages: [
      { id: 'user-original', role: 'user', parentId: null, selectedChildId: 'answer-selected',
        createdAt: timestamp, content: '  原话 😀\n最后一行  ', files: [
          { id: 'picture-original', serverId: 'upstream-file-id', name: '合成.png', size: 68,
            mimeType: 'image/png', isImage: true },
          { id: 'document-original', serverId: 'upstream-document-id', name: '合成.txt', size: 3,
            mimeType: 'text/plain', isImage: false },
        ] },
      reply('answer-hidden', 'user-original', [{ type: 'text', text: '未选中分支原文' }]),
      { ...reply('answer-selected', 'user-original', [
        { type: 'thinking', thinking: '原始思考', signature: 'original-signature', elapsedSeconds: 2 },
        { type: 'text', text: '  原回答 [citation:1]\n第二行  ', citations: [citation], isTemplate: false },
        { type: 'image', id: 'picture-original', name: '合成.png', mimeType: 'image/png', prompt: '原提示词' },
      ]), imagePrompt: '原提示词', imageOrigin: 'chat', imageGeneration: true,
      imageAction: { protocol: 'app-image-action-v1', nonce: 'a'.repeat(32), raw: '惰性动作原件',
        messageComplete: true, stopReason: 'end_turn', invalid: false, truncated: false },
      usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 1 },
      latestReminder: '原回复设置' },
    ],
    continuity: { title: '背景标题', text: '  续聊背景\n原件  ', sourceArchiveId: 'archive-original' },
    longMemory: { version: 1, enabled: true, contextBudgetTokens: 936000, entries: [
      { id: 'memory-original', kind: 'fact', text: '记忆原文', sourceIds: ['user-original', 'answer-selected'],
        sourceSignature: 'original-source-signature', pinned: true, edited: false, createdAt: timestamp },
    ], segments: [] },
    sharedSource: { kind: 'deepseek-share', shareId: 'share-original',
      url: 'https://chat.deepseek.com/share/share-original', scope: 'shared_snapshot',
      importedAt: timestamp, rawSnapshot: '{"original":"原来源"}', messageIds: ['user-original'] },
  }
  const expected = structuredClone(session)
  expected.messages[0].files.forEach(file => { file.serverId = null })
  assert.deepEqual(decodeSyncSnapshot(encodeSyncSnapshot(session), session.id), expected)
  assert.deepEqual(session.messages[0].files.map(file => file.serverId), ['upstream-file-id', 'upstream-document-id'])
  assert.deepEqual(referencedSyncFiles(session), [
    { id: 'picture-original', mimeType: 'image/png' }, { id: 'document-original', mimeType: 'text/plain' },
  ])
  const imageEdit = structuredClone(session)
  imageEdit.messages[0].files.pop()
  imageEdit.messages[2].imageOrigin = 'edit'
  delete imageEdit.messages[2].imageAction
  const restoredEdit = decodeSyncSnapshot(encodeSyncSnapshot(imageEdit), imageEdit.id)
  assert.equal(restoredEdit.messages[2].imageOrigin, 'edit')
  assert.equal(restoredEdit.messages[2].parentId, restoredEdit.messages[0].id)
  assert.equal(restoredEdit.messages[0].files[0].id, 'picture-original')

  const withTools = structuredClone(session)
  withTools.messages[2].blocks.push(
    { type: 'server_tool_use', id: 'original-search-call', name: 'deepseek_web_search',
      caller: { type: 'direct' }, kind: 'search', input: { action: 'search', query: '原搜索', queries: ['原搜索'] } },
    { type: 'web_search_tool_result', tool_use_id: 'original-search-call', kind: 'search', content: [
      { type: 'web_search_result', title: '原搜索标题', url: 'https://example.com/search',
        image_url: 'https://example.com/image.png', snippet: '原搜索摘要', site_icon: null,
        site_name: '原站点', encrypted_content: '原加密资料', page_age: null },
      { type: 'web_search_tool_result_error', error_code: 'unavailable' },
    ] },
    { type: 'server_tool_use', id: 'original-read-call', name: 'deepseek_read_url',
      caller: { type: 'direct' }, kind: 'read_link', input: { action: 'read_link', url: 'https://example.com/read' } },
    { type: 'web_fetch_tool_result', tool_use_id: 'original-read-call', kind: 'read_link',
      signature: '原页面签名', content: { type: 'web_fetch_result', url: 'https://example.com/read',
        content: { type: 'document', title: '原页面标题', source: { type: 'text', media_type: 'text/plain', data: '' } },
        published_at: '原日期' } },
    { type: 'web_fetch_tool_result', tool_use_id: 'original-unavailable-call', kind: 'deep_search',
      content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_allowed' } },
  )
  const toolsExpected = structuredClone(withTools)
  toolsExpected.messages[0].files.forEach(file => { file.serverId = null })
  assert.deepEqual(decodeSyncSnapshot(encodeSyncSnapshot(withTools), withTools.id), toolsExpected)

  const decorated = structuredClone(session)
  decorated.password = 'private-password'
  decorated.apiKey = 'private-key'
  decorated.messages[2].accessToken = 'private-token'
  decorated.messages[2].imageJob = { state: 'completed', clientRequestId: 'private-dispatch-id' }
  decorated.messages[2].blocks[1].unexpectedPrivateField = 'private-extra'
  const encoded = JSON.stringify(encodeSyncSnapshot(decorated))
  for (const secret of ['private-password', 'private-key', 'private-token', 'private-dispatch-id', 'private-extra', 'upstream-file-id']) {
    assert.ok(!encoded.includes(secret), `Unexpected sync property persisted ${secret}`)
  }
  for (const status of ['pending', 'streaming']) {
    const running = structuredClone(session)
    running.messages[2].status = status
    assert.throws(() => encodeSyncSnapshot(running))
  }
  const runningImage = structuredClone(session)
  runningImage.messages[2].imageJob = { state: 'running' }
  assert.throws(() => encodeSyncSnapshot(runningImage))
  const completedWithoutImage = structuredClone(session)
  completedWithoutImage.messages[2].blocks = []
  completedWithoutImage.messages[2].imageJob = { state: 'completed' }
  assert.throws(() => encodeSyncSnapshot(completedWithoutImage))

  const malformed = [
    value => { value.id = 'another-session' },
    value => { value.messages[2].id = value.messages[1].id },
    value => { value.messages[2].parentId = 'missing-parent' },
    value => { value.messages[0].selectedChildId = 'missing-child' },
    value => { value.messages[2].selectedChildId = 'user-original' },
    value => { value.messages[2].blocks[1].citations[0].url = 'javascript:alert(1)' },
    value => { value.messages[2].blocks[1].text = '\ud800' },
  ]
  for (const change of malformed) {
    const bad = structuredClone(session)
    change(bad)
    assert.throws(() => decodeSyncSnapshot({ version: 1, session: bad }, session.id))
  }
  const legacy = structuredClone(session)
  delete legacy.rootMessageId
  legacy.messages = legacy.messages.slice(0, 1)
  delete legacy.messages[0].parentId
  delete legacy.messages[0].selectedChildId
  const linear = decodeSyncSnapshot(encodeSyncSnapshot(legacy), legacy.id)
  assert.equal(linear.messages[0].id, 'user-original')
  assert.equal(linear.rootMessageId, 'user-original')
  assert.equal(linear.messages[0].parentId, null)
  console.log('Sync codec passed original/branch/citation/source/memory preservation, property filtering, generation-state isolation and malformed-input checks; no network or model calls.')
} finally {
  assert.ok(output.startsWith(root + sep))
  rmSync(output, { recursive: true, force: true })
}
