import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(root, '.memory-check-'))
try {
  const compile = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--project', join(root, 'tsconfig.json'), '--noEmit', 'false', '--outDir', out], { cwd: root, encoding: 'utf8' })
  assert.equal(compile.status, 0, compile.stdout + compile.stderr)
  globalThis.__API_ORIGIN__ = '/deepseek-api/chat'
  const { initializeRuntime } = await import(pathToFileURL(join(out, 'src/services/runtime.js')))
  initializeRuntime({ provider: 'DeepSeek', model: 'synthetic', features: { search: true, files: true, speech: true },
    user: { id: 'synthetic-owner', username: 'synthetic', role: 'user' } })
  const load = (path) => import(pathToFileURL(join(out, 'src/services/chat', path)))
  const { buildOrganizePayload } = await load('organize.js')
  const { toSessionFile } = await load('history/toArchive.js')
  const { toLocalSession } = await load('history/toLocal.js')
  const { readSessionFile } = await load('history/schema.js')
  const { buildContinuitySystem } = await load('continuity.js')
  const { toRequestMessages } = await load('reply.js')
  const { imagePath } = await load('history/paths.js')
  const { cacheGeneratedImage, releaseGeneratedImage } = await load('imageGeneration.js')
  const { exportArchive } = await load('history/exportArchive.js')
  const { readArchive, readEntry } = await load('history/zipReader.js')
  const memory = { title: '旧约定', text: '  我：也许下次一起看日出。\n你：我们可以慢慢安排。\n', sourceArchiveId: 'archive-synthetic' }
  const session = { id: 'continuation-native-1', nativeHandoffId: 'native-1', title: '海边',
    createdAt: 1700000000000, updatedAt: 1700000001000, continuity: memory, rootMessageId: 'u1', messages: [
      { id: 'u1', role: 'user', content: '  我后来又想了想。\n', files: [], createdAt: 1700000000000, parentId: null, selectedChildId: 'a2' },
      { id: 'a1', role: 'assistant', createdAt: 1700000000100, parentId: 'u1', status: 'done', prefix: false, model: null, blocks: [{ type: 'text', text: '未选中的版本' }] },
      { id: 'a2', role: 'assistant', createdAt: 1700000000200, parentId: 'u1', selectedChildId: 'u2', status: 'done', prefix: false, model: null, blocks: [
        { type: 'thinking', thinking: '不该进入原话' }, { type: 'text', text: '嗯，' },
        { type: 'server_tool_use', id: 'tool', kind: 'read_link', input: { action: 'read_link', url: 'https://example.invalid/' }, name: 'deepseek_read_url', caller: { type: 'direct' } },
        { type: 'text', text: '我们接着说。' }, { type: 'text', text: '服务器错误提示', isTemplate: true } ] },
      { id: 'u2', role: 'user', createdAt: 1700000001000, parentId: 'a2', files: [], content: '那就先聊聊今天？' },
    ] }
  const payload = buildOrganizePayload(session)
  assert.equal(payload.sourceArchiveId, memory.sourceArchiveId)
  assert.deepEqual(payload.messages.map(({ id, role, content }) => ({ id, role, content })), [
    { id: 'u1', role: 'user', content: '  我后来又想了想。\n' },
    { id: 'a2', role: 'assistant', content: '嗯，我们接着说。' },
    { id: 'u2', role: 'user', content: '那就先聊聊今天？' },
  ])
  const file = readSessionFile(toSessionFile(session, () => null))
  const restored = toLocalSession(file).session
  assert.deepEqual(restored.continuity, memory)
  assert.equal(restored.nativeHandoffId, 'native-1')
  assert.equal(restored.messages.length, session.messages.length)
  assert.equal(buildContinuitySystem('BASE', restored.continuity).split(JSON.stringify(memory)).length, 2)
  const empty = { ...session, messages: [], rootMessageId: null }
  assert.deepEqual(toLocalSession(readSessionFile(toSessionFile(empty, () => null))).session.continuity, memory)
  assert.throws(() => readSessionFile({ ...file, continuity: { ...memory, text: '' } }))
  const generated = { id: 'generated-image-1', type: 'image', name: 'original.png', mimeType: 'image/png', prompt: '画一幅海边日出，保留这个原始提示词。' }
  const imageSession = { ...session, messages: [...session.messages.map((message) => message.id === 'u2' ? { ...message, selectedChildId: 'a3' } : message),
    { id: 'a3', role: 'assistant', createdAt: 1700000002000, parentId: 'u2', selectedChildId: 'u3', status: 'done', prefix: false, model: null,
      imageGeneration: true, imageModel: 'synthetic-image-model', blocks: [generated] },
    { id: 'u3', role: 'user', createdAt: 1700000003000, parentId: 'a3', files: [], content: '聊点别的吧。' },
  ] }
  const generatedPath = imagePath(imageSession.id, generated.id, generated.name)
  const imageArchive = readSessionFile(toSessionFile(imageSession, ({ id }) => id === generated.id ? generatedPath : null))
  const localImage = toLocalSession(imageArchive)
  const imageReply = localImage.session.messages.find((message) => message.role === 'assistant' && message.imageGeneration)
  assert.equal(imageReply.imageModel, 'synthetic-image-model')
  assert.equal(imageReply.prefix, false)
  assert.deepEqual(imageReply.blocks, [generated])
  assert.equal(localImage.images.get(generatedPath), generated.id)
  assert.deepEqual(localImage.session.continuity, memory)
  const wrongPath = structuredClone(imageArchive)
  wrongPath.messages.find((message) => message.generated_images)?.generated_images.forEach((image) => { image.export_path = 'chat_sessions/another_files/foreign.png' })
  assert.throws(() => toLocalSession(wrongPath))
  const noOriginal = toLocalSession(readSessionFile(toSessionFile(imageSession, () => null)))
  assert.equal(noOriginal.images.size, 0)
  assert.equal(noOriginal.session.messages.find((message) => message.imageGeneration).blocks[0].id, generated.id)
  const question = imageSession.messages.at(-1)
  const context = toRequestMessages(imageSession.messages.slice(0, -1), question)
  assert.deepEqual(context.map(({ role }) => role), ['user', 'assistant', 'user', 'assistant', 'user'])
  assert.equal(context.at(-1).content, question.content)
  assert.ok(!JSON.stringify(context).includes(generated.id))
  assert.ok(JSON.stringify(context).includes(generated.prompt))
  const organizedImages = buildOrganizePayload(imageSession)
  assert.ok(!JSON.stringify(organizedImages).includes('synthetic-image-model'))
  assert.ok(!organizedImages.messages.some(({ content }) => content.includes(generated.prompt)))
  // A paid result can still be backed up before IndexedDB persistence succeeds.
  const originalBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1])
  cacheGeneratedImage(generated.id, new Blob([originalBytes], { type: generated.mimeType }))
  const zip = new File([await exportArchive([imageSession])], 'synthetic.zip')
  const archived = new Map()
  for await (const entry of readArchive(zip)) archived.set(entry.path, await readEntry(entry))
  assert.deepEqual(new Uint8Array(await archived.get(generatedPath).arrayBuffer()), originalBytes)
  const zippedSession = toLocalSession(readSessionFile(JSON.parse(await archived.get(`chat_sessions/${imageSession.id}.json`).text())))
  assert.deepEqual(zippedSession.session.continuity, memory)
  assert.equal(zippedSession.images.get(generatedPath), generated.id)
  releaseGeneratedImage(generated.id)
  console.log('Memory flow checks passed: selected branch/raw wording, excluded tools/thoughts, source target, background and generated-image ZIP roundtrip, original image paths, empty new chat, invalid backup, and no invented image context.')
} finally {
  if (!out.startsWith(root + sep)) throw new Error('Temporary output escaped project')
  rmSync(out, { recursive: true, force: true })
}
