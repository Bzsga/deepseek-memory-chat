import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = mkdtempSync(join(root, '.session-export-check-'))

try {
  const compile = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--project',
      join(root, 'tsconfig.json'),
      '--noEmit',
      'false',
      '--outDir',
      output,
    ],
    { cwd: root, encoding: 'utf8' }
  )
  assert.equal(compile.status, 0, compile.stdout + compile.stderr)
  globalThis.__API_ORIGIN__ = '/deepseek-api/chat'
  globalThis.window = { dispatchEvent() {} }
  const load = (name) => import(pathToFileURL(join(output, 'src', name)))
  const runtime = await load('services/runtime.js')
  runtime.initializeRuntime({
    provider: 'DeepSeek',
    model: 'synthetic',
    features: {},
    user: { id: 'synthetic-export-owner', username: 'synthetic', role: 'user' },
  })
  const { createSessionExport, sessionExportToArchive, saveSessionExport, MAX_SESSION_JSON_BYTES } =
    await load('services/chat/sessionExport.js')
  const { readArchive, readEntry } = await load('services/chat/history/zipReader.js')
  const { readSessionFile } = await load('services/chat/history/schema.js')
  const { toLocalSession } = await load('services/chat/history/toLocal.js')
  const { getVisibleMessages } = await load('services/chat/branches.js')
  const { sourceSignature, memoryForExport, newConversationMemory } = await load(
    'services/chat/contextMemory.js'
  )
  const { cacheGeneratedImage, releaseGeneratedImage } = await load(
    'services/chat/imageGeneration.js'
  )
  const { normalizeUploadFiles, validateFiles, isImage, uploadAttachment } =
    await load('services/attachments.js')
  const { describeReply } = await load('services/chat/describe.js')
  const { readImageGenerationResponse, ApiError } = await load('services/api/client.js')
  const eventResponse = (parts) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
          controller.close()
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  const imageResult = { model: 'synthetic', images: [] }
  assert.deepEqual(
    await readImageGenerationResponse(
      eventResponse([
        ': generating\n\n',
        ': keep-alive\n\n',
        'event: result\ndata: ' + JSON.stringify(imageResult) + '\n\n',
      ]),
      new AbortController().signal
    ),
    imageResult
  )
  assert.deepEqual(
    await readImageGenerationResponse(
      new Response(JSON.stringify(imageResult), {
        headers: { 'Content-Type': 'application/json' },
      }),
      new AbortController().signal
    ),
    imageResult
  )
  await assert.rejects(
    () =>
      readImageGenerationResponse(
        eventResponse([
          ': generating\n\n',
          'event: error\ndata: {"error":{"message":"生图服务额度不足","code":"image_provider_quota","status":503}}\n\n',
        ]),
        new AbortController().signal
      ),
    (error) =>
      error instanceof ApiError &&
      error.kind === 'http' &&
      error.status === 503 &&
      error.message === '生图服务额度不足'
  )
  await assert.rejects(
    () =>
      readImageGenerationResponse(
        eventResponse([': keep-alive\n\n']),
        new AbortController().signal
      ),
    (error) => error instanceof ApiError && error.kind === 'interrupted'
  )
  await assert.rejects(
    () =>
      readImageGenerationResponse(
        eventResponse(['event: result\ndata: {\n\n']),
        new AbortController().signal
      ),
    (error) => error instanceof ApiError && error.kind === 'protocol'
  )
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
    'base64'
  )
  const camera = new File([png], 'capture', { type: 'image/png', lastModified: 123 })
  const normalized = normalizeUploadFiles([camera])[0]
  assert.equal(normalized.name, 'capture.png')
  assert.equal(normalized.lastModified, 123)
  assert.deepEqual(Buffer.from(await normalized.arrayBuffer()), png)
  assert.equal(validateFiles([normalized], 0), null)
  assert.equal(isImage('image/svg+xml'), false)
  assert.deepEqual(
    validateFiles([new File(['<svg/>'], 'unsafe.svg', { type: 'image/svg+xml' })], 0),
    { key: 'uploadUnsupportedFormat' }
  )
  const jpeg = normalizeUploadFiles([new File([png], '', { type: 'image/jpg' })])[0]
  assert.equal(jpeg.name, 'image.jpg')
  assert.equal(jpeg.type, 'image/jpeg')

  const now = 1700000000000
  const uploaded = {
    id: 'photo-1',
    serverId: 'file-api-synthetic',
    name: '照片.png',
    size: png.length,
    isImage: true,
    mimeType: 'image/png',
  }
  const generated = {
    type: 'image',
    id: 'generated-1',
    name: '海边.png',
    mimeType: 'image/png',
    prompt: '海边日出',
  }
  const reply = (id, text, parentId) => ({
    id,
    role: 'assistant',
    createdAt: now + 1,
    parentId,
    status: 'done',
    prefix: false,
    model: null,
    blocks: [{ type: 'text', text }],
  })
  const session = {
    id: 'export-synthetic',
    title: '../测试:会话?',
    createdAt: now,
    updatedAt: now + 4,
    rootMessageId: 'u1',
    continuity: { title: '背景', text: '保留这段原话。', sourceArchiveId: 'local-source' },
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: '  原话与换行\n',
        files: [uploaded],
        createdAt: now,
        parentId: null,
        selectedChildId: 'a2',
      },
      reply('a1', '未选中版本', 'u1'),
      { ...reply('a2', '当前版本', 'u1'), selectedChildId: 'u2' },
      {
        id: 'u2',
        role: 'user',
        content: '再画一张',
        files: [],
        createdAt: now + 2,
        parentId: 'a2',
        selectedChildId: 'a3',
      },
      {
        ...reply('a3', '', 'u2'),
        imageGeneration: true,
        imageModel: 'synthetic-image',
        blocks: [generated],
      },
    ],
  }
  session.longMemory = {
    ...newConversationMemory(),
    entries: [
      {
        id: 'manual',
        kind: 'preference',
        text: '用户手动固定的偏好。',
        sourceIds: [],
        sourceSignature: '',
        pinned: true,
        edited: true,
        createdAt: now,
      },
      {
        id: 'source',
        kind: 'fact',
        text: '当前分支的记忆。',
        sourceIds: ['u1', 'a2'],
        sourceSignature: sourceSignature([session.messages[0], session.messages[2]]),
        pinned: false,
        edited: false,
        createdAt: now,
      },
    ],
  }
  for (const id of [uploaded.id, generated.id]) {
    cacheGeneratedImage(id, new Blob([png], { type: 'image/png' }))
  }
  for (const format of ['markdown', 'text']) {
    const artifact = await createSessionExport(session, format)
    const text = await artifact.blob.text()
    assert.ok(text.includes('  原话与换行\n'))
    assert.ok(text.includes('当前版本'))
    assert.ok(!text.includes('未选中版本'))
    assert.ok(text.includes('用户手动固定的偏好。'))
    assert.ok(text.includes('当前分支的记忆。'))
    assert.ok(text.includes('照片.png') && text.includes('海边.png'))
    assert.ok(!/[<>:"/\\|?*]/.test(artifact.name))
  }
  for (const format of ['json', 'zip']) {
    const artifact = await createSessionExport(session, format)
    const file = new File([artifact.blob], artifact.name, { type: artifact.blob.type })
    const archive = await sessionExportToArchive(file)
    const entries = new Map()
    for await (const entry of readArchive(archive)) {
      entries.set(entry.path, await readEntry(entry))
    }
    const data = readSessionFile(
      JSON.parse(await entries.get('chat_sessions/export-synthetic.json').text())
    )
    const restored = toLocalSession(data)
    assert.equal(restored.session.messages.length, 5)
    assert.deepEqual(restored.session.continuity, session.continuity)
    assert.equal(restored.images.size, 2)
    for (const path of restored.images.keys()) {
      assert.deepEqual(Buffer.from(await entries.get(path).arrayBuffer()), png)
    }
    assert.deepEqual(
      memoryForExport(restored.session).map(({ text }) => text),
      ['用户手动固定的偏好。', '当前分支的记忆。']
    )
    assert.equal(getVisibleMessages(restored.session).length, 4)
    assert.ok(
      restored.session.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.blocks.some((block) => block.type === 'text' && block.text === '未选中版本')
      )
    )
  }
  const json = await createSessionExport(session, 'json')
  const invalid = JSON.parse(await json.blob.text())
  invalid.files[0].path = '../escape.png'
  await assert.rejects(() =>
    sessionExportToArchive(new File([JSON.stringify(invalid)], 'invalid.json'))
  )
  invalid.files[0].path = 'chat_sessions/export-synthetic_files/photo.png'
  invalid.files[0].data_base64 = 'not a base64 payload'
  await assert.rejects(() =>
    sessionExportToArchive(new File([JSON.stringify(invalid)], 'invalid.json'))
  )
  await assert.rejects(() =>
    sessionExportToArchive(new File(['{"format":"other"}'], 'unrelated.json'))
  )
  const oversizedJson = new File([new Uint8Array(MAX_SESSION_JSON_BYTES + 1)], 'oversized.json')
  Object.defineProperty(oversizedJson, 'text', {
    value: () => {
      throw new Error('Oversized JSON must be rejected before text allocation')
    },
  })
  await assert.rejects(() => sessionExportToArchive(oversizedJson), /超过 32 MB/)

  let requests = 0
  globalThis.fetch = async (_url, init) => {
    requests += 1
    assert.equal(init.credentials, 'same-origin')
    return new Response(JSON.stringify({ error: { message: 'synthetic upload busy' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const first = uploadAttachment('', 'synthetic-upload', normalized, normalized.name, true)
  assert.equal(uploadAttachment('', 'synthetic-upload', normalized, normalized.name, true), first)
  await assert.rejects(first)
  assert.equal(requests, 1)
  assert.deepEqual(
    describeReply({
      ...reply('failure', '', 'u1'),
      imageGeneration: true,
      status: 'error',
      error: { kind: 'http', status: 503, message: '生图服务余额不足，请联系管理员。' },
    }),
    { text: '生图服务余额不足，请联系管理员。' }
  )
  runtime.invalidateSession('login', false)
  assert.throws(() => saveSessionExport(json))
  await assert.rejects(() => createSessionExport(session, 'zip'))
  for (const id of [uploaded.id, generated.id]) releaseGeneratedImage(id)
  console.log(
    'Session export and upload checks passed: branch/memory/image roundtrip, safe JSON import, camera naming, single dispatch, image error and account invalidation.'
  )
} finally {
  if (!output.startsWith(root + sep)) throw new Error('Temporary output escaped project')
  rmSync(output, { recursive: true, force: true })
}
