import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = mkdtempSync(join(root, '.conversation-shares-check-'))
try {
  // This checks runtime boundaries. The project's separate `pnpm type` owns type validation.
  const compiled = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--project', join(root, 'tsconfig.json'), '--noEmit', 'false', '--noCheck', '--outDir', output],
  { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  writeFileSync(join(output, 'src/services/chat/db.js'), `
    globalThis.__shareDbLoaded=true;
    import {toSessionSummary} from './types.js';
    export const rows=new Map(), files=new Map(), summaries=new Map();
    let fileGate, appendGate;
    export const setFileGate=x=>{fileGate=x}; export const setAppendGate=x=>{appendGate=x};
    export const loadFile=async id=>{if(fileGate)await fileGate(id);return files.get(id)};
    export const loadSession=async id=>structuredClone(rows.get(id));
    export const loadSessionSummaries=async()=>[...summaries.values()];
    export const saveSession=async(s,fs=[])=>{rows.set(s.id,structuredClone(s));summaries.set(s.id,toSessionSummary(s));for(const f of fs)files.set(f.id,f.blob)};
    export const appendSession=async(s,guard,fs=[])=>{
      if(appendGate)await appendGate();if(!guard())throw Error('账户或本地资料已变化');
      if(rows.has(s.id))return structuredClone(rows.get(s.id));
      const next=structuredClone(s);if(!guard())throw Error('账户或本地资料已变化');
      for(const f of fs)files.set(f.id,f.blob);rows.set(s.id,next);summaries.set(s.id,toSessionSummary(next));return next;
    };
    export const deleteSession=async id=>{rows.delete(id);summaries.delete(id)};
    export const clearStaging=async()=>{};
    export const commitStaging=async()=>{rows.clear();files.clear();summaries.clear();return []};
    export const reportStorageError=()=>()=>{};
  `)
  globalThis.__API_ORIGIN__ = '/deepseek-api/chat'
  globalThis.window = new EventTarget()
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 1)
  globalThis.cancelAnimationFrame = clearTimeout
  const load = path => import(pathToFileURL(join(output, 'src', path)))
  const runtime = await load('services/runtime.js')
  const core = await load('services/conversationShares.js')
  const unified = await load('services/sharedConversation.js')
  const shareId = 's'.repeat(32)
  const url = `https://digimonlegend.com/deepseek/share/${shareId}`
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=', 'base64')
  const mime = 'image/png'
  const publicImage = { id: 'image-transfer', name: '合成.png', mime_type: mime, size: image.length,
    url: `/deepseek-api/chat/api/conversation-shares/${shareId}/images/image-transfer` }
  let snapshot = { schema_version: 1, id: shareId, title: '合成会话', created_at: 1794931200000,
    messages: [
      { id: 'original-user', role: 'user', content: '  原话\n第二行。  ', created_at: 1794931200000,
        image_ids: ['image-transfer'], files: [{ name: '附件.txt', size: 123, mime_type: 'text/plain' }] },
      { id: 'original-assistant', role: 'assistant', content: '原回答', created_at: 1794931200001,
        image_ids: ['image-transfer'], files: [] },
    ], images: [publicImage] }
  let revoked = false
  let mode = 'normal'
  let releaseImage
  let imageStarted
  const calls = []
  const creations = []
  const metadata = { id: shareId, url, title: snapshot.title, conversation_id: 'source-session',
    message_count: 2, image_count: 1, created_at: snapshot.created_at, revoked: false }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  globalThis.fetch = async (input, init) => {
    const path = new URL(input, 'https://digimonlegend.com').pathname
    calls.push({ path, method: init.method, credentials: init.credentials })
    assert.ok(!path.includes('/messages') && !path.includes('image-jobs'), 'Sharing must never call a model')
    if (path.endsWith('/conversation-shares') && init.method === 'POST') {
      const body = JSON.parse(init.body)
      creations.push(body)
      assert.equal(new Headers(init.headers).get('X-Chat-User-Id'), 'synthetic-owner')
      return json({ ...metadata, revoked }, creations.length === 1 ? 201 : 200)
    }
    if (path.endsWith('/conversation-shares') && init.method === 'GET') {return json({ shares: revoked ? [] : [metadata] })}
    if (path === `/deepseek-api/chat/api/conversation-shares/${shareId}` && init.method === 'DELETE') {
      revoked = true; return json({ revoked: true })
    }
    if (path === `/deepseek-api/chat/api/conversation-shares/${shareId}`) {
      assert.equal(init.credentials, 'omit')
      return revoked ? json({}, 404) : json(snapshot)
    }
    assert.equal(path, publicImage.url)
    assert.equal(init.credentials, 'omit')
    if (mode === 'hold-image') {
      imageStarted?.()
      await new Promise(resolve => {releaseImage = resolve})
    }
    if (revoked) {return json({}, 404)}
    return new Response(mode === 'bad-image' ? 'not an image' : image, { headers: { 'Content-Type': mime } })
  }
  assert.deepEqual(core.parseAppConversationShareLink(`分享链接 ${url}。`), { shareId, url })
  assert.equal(core.parseAppConversationShareLink('https://chat.deepseek.com/share/abc123'), undefined)
  for (const bad of [url + '?x=1', url + '#fragment', url.replace('https:', 'http:'), url.replace('digimonlegend.com', 'digimonlegend.com.evil.test'),
    url.replace('/deepseek/share/', '/deepseek/../deepseek/share/'), url + ' ' + url, url + '/']) {
    assert.throws(() => core.parseAppConversationShareLink(bad))
  }
  const guest = await unified.readSharedConversation(url)
  assert.equal(guest.sourceKind, 'app-share')
  assert.equal(guest.messages[0].content, snapshot.messages[0].content)
  assert.equal(guest.messages[0].images[0].url, publicImage.url)
  assert.equal(globalThis.__shareDbLoaded, undefined, 'Public preview must not import account storage')
  assert.equal(calls.length, 1, 'Preview must not download image originals')
  await assert.rejects(unified.continueSharedConversation(guest), /登录/)

  runtime.initializeRuntime({ provider: 'synthetic', model: 'synthetic', features: { search: true, files: true, speech: false },
    user: { id: 'synthetic-owner', username: 'synthetic', role: 'user' } })
  const store = await load('services/chat/store.js')
  const db = await load('services/chat/db.js')
  const imageBlob = new Blob([image], { type: mime })
  const source = { id: 'source-session', title: snapshot.title, createdAt: snapshot.created_at, updatedAt: snapshot.created_at + 1,
    rootMessageId: 'local-user', longMemory: { secret: 'never-share-memory' }, continuity: { secret: 'never-share-background' },
    messages: [
      { id: 'local-user', role: 'user', content: snapshot.messages[0].content, createdAt: snapshot.created_at,
        parentId: null, selectedChildId: 'local-assistant', files: [
          { id: 'private-local-image', name: '合成.png', size: image.length, mimeType: mime, isImage: true, serverId: 'secret-file-server-id' },
          { id: 'private-doc-id', name: '附件.txt', size: 123, mimeType: 'text/plain', isImage: false, serverId: 'secret-document-server-id' },
        ] },
      { id: 'local-assistant', role: 'assistant', createdAt: snapshot.created_at + 1, parentId: 'local-user',
        model: null, prefix: false, status: 'done', latestReminder: 'never-share-reminder', imageAction: { raw: 'never-share-action' },
        blocks: [{ type: 'thinking', thinking: 'never-share-thinking' }, { type: 'text', text: '原回答' },
          { type: 'image', id: 'private-local-image', name: '合成.png', mimeType: mime, prompt: 'never-share-image-prompt' }] },
      { id: 'unselected-assistant', role: 'assistant', createdAt: snapshot.created_at + 2, parentId: 'local-user', model: null,
        prefix: false, status: 'done', blocks: [{ type: 'text', text: 'never-share-other-branch' }] },
    ] }
  const fresh = () => {
    const value = structuredClone(source)
    db.rows.set(value.id, structuredClone(value)); db.files.set('private-local-image', imageBlob)
    store.useChatStore.setState({ ready: true, importingHistory: false, sessions: [value], sessionCache: { [value.id]: value },
      activeId: value.id, streaming: {}, memoryActivity: {} })
    return value
  }
  fresh()
  const summary = core.summarizeConversationShare(source, ['local-assistant', 'local-user'])
  assert.deepEqual(summary, { messageCount: 2, imageCount: 1, fileCount: 2 })
  assert.throws(() => core.summarizeConversationShare(source, ['unselected-assistant']))
  const pending = core.createConversationShare(source.id, ['local-assistant', 'local-user'])
  assert.equal(core.createConversationShare(source.id, ['local-user', 'local-assistant']), pending)
  const created = await pending
  assert.equal(created.url, url)
  const body = creations.at(-1)
  assert.deepEqual(body.messages.map(message => message.id), ['local-user', 'local-assistant'])
  assert.equal(body.messages[0].content, snapshot.messages[0].content)
  assert.equal(body.images.length, 1)
  assert.deepEqual(body.messages[0].image_ids, body.messages[1].image_ids)
  assert.notEqual(body.images[0].id, 'private-local-image')
  assert.equal(body.images[0].b64_json, image.toString('base64'))
  assert.ok(!JSON.stringify(body).includes('never-share'))
  assert.ok(!JSON.stringify(body).includes('server-id'))
  assert.ok(!JSON.stringify(body).includes('private-local-image'))
  await core.createConversationShare(source.id, ['local-user', 'local-assistant'])
  assert.deepEqual(creations.at(-1), body, 'An explicit retry reuses the exact idempotent body')
  assert.equal((await core.listConversationShares())[0].id, shareId)
  assert.equal((await core.listConversationShares(source.id))[0].id, shareId)

  const beforeImport = calls.length
  const preview = await unified.readSharedConversation(url)
  assert.equal(calls.length, beforeImport + 1)
  const originalCount = db.rows.size
  const [id, sameId] = await Promise.all([unified.continueSharedConversation(preview), unified.continueSharedConversation(preview)])
  assert.equal(id, sameId)
  assert.equal(db.rows.size, originalCount + 1)
  assert.ok(db.rows.has(source.id))
  assert.equal(calls.slice(beforeImport).filter(call => call.path === publicImage.url).length, 1)
  const imported = db.rows.get(id)
  assert.deepEqual(imported.messages.map(message => message.id), ['original-user', 'original-assistant'])
  assert.deepEqual(imported.messages.map(message => message.role), ['user', 'assistant'])
  assert.equal(imported.messages[0].content, snapshot.messages[0].content)
  assert.equal(imported.sharedSource.kind, 'app-share')
  assert.equal(imported.sharedSource.rawSnapshot, JSON.stringify(snapshot))
  const localFile = imported.messages[0].files.find(file => file.isImage)
  assert.notEqual(localFile.id, publicImage.id)
  assert.equal(localFile.serverId, null)
  assert.equal(imported.messages[1].blocks.find(block => block.type === 'image').id, localFile.id)
  assert.deepEqual(Buffer.from(await db.files.get(localFile.id).arrayBuffer()), image)
  const { toSessionFile } = await load('services/chat/history/toArchive.js')
  const { toLocalSession } = await load('services/chat/history/toLocal.js')
  const { readSessionFile } = await load('services/chat/history/schema.js')
  const backup = readSessionFile(toSessionFile(imported, () => null))
  const restored = toLocalSession(backup).session
  assert.equal(restored.sharedSource.rawSnapshot, JSON.stringify(snapshot))
  assert.equal(restored.sharedSource.url, url)
  assert.equal(restored.sharedSource.kind, 'app-share')
  assert.equal(restored.sharedSource.messageIds.length, 2)
  assert.ok(!restored.messages.some(message => message.imageJob))

  for (const change of [value => {value.images[0].url = 'https://evil.test/image'}, value => {value.images[0].b64_json = 'secret'},
    value => {value.owner_id = 'private'}, value => {value.messages[0].role = 'system'}, value => {value.messages[0].image_ids = ['missing']},
    value => {value.images.push(structuredClone(value.images[0]))}, value => {value.messages.push(structuredClone(value.messages[0]))}]) {
    const invalid = structuredClone(snapshot); change(invalid)
    assert.throws(() => core.parsePublicConversationShare(JSON.stringify(invalid), shareId))
  }
  assert.throws(() => core.parsePublicConversationShare(JSON.stringify(snapshot).replace('"schema_version":1', '"schema_version":0,"schema_version":1'), shareId))
  const noWritesBefore = db.rows.size
  mode = 'bad-image'
  await assert.rejects(core.importAppConversationShare(await core.readAppConversationShare(url), 'synthetic-owner'))
  assert.equal(db.rows.size, noWritesBefore)
  mode = 'normal'
  await assert.rejects(core.importAppConversationShare(await core.readAppConversationShare(url), 'different-owner'), /账号/)
  await assert.rejects(core.validateConversationShareImage(new Blob([new Uint8Array(12 * 1024 * 1024 + 1)]), mime), /12 MiB/)
  await assert.rejects(core.validateConversationShareImage(new Blob(['text']), mime), /类型/)
  const huge = fresh(); huge.messages[0].content = 'x'.repeat(8 * 1024 * 1024 + 1)
  store.useChatStore.setState({ sessionCache: { [huge.id]: huge } })
  const beforeLimit = creations.length
  await assert.rejects(core.createConversationShare(huge.id, ['local-user']), /上限/)
  assert.equal(creations.length, beforeLimit)

  // A source deleted while image originals are loading cannot be uploaded afterwards.
  fresh()
  let releaseFile
  let fileStarted
  const fileRead = new Promise(resolve => {fileStarted = resolve})
  db.setFileGate(async () => {fileStarted(); await new Promise(resolve => {releaseFile = resolve})})
  const deletingCreate = core.createConversationShare(source.id, ['local-user'])
  await fileRead
  assert.equal(await store.removeSession(source.id), true)
  releaseFile()
  await assert.rejects(deletingCreate, /会话|变化/)
  db.setFileGate(undefined)
  assert.equal(creations.length, beforeLimit)

  // An import started before a history replacement may not restore old records or orphan files.
  fresh()
  mode = 'hold-image'
  const imageRead = new Promise(resolve => {imageStarted = resolve})
  const stalePreview = await core.readAppConversationShare(url)
  const staleImport = core.importAppConversationShare(stalePreview, 'synthetic-owner')
  await imageRead
  await store.replaceHistory(async () => {})
  releaseImage()
  await assert.rejects(staleImport, /资料已变化/)
  assert.equal(db.rows.size, 0)
  assert.equal(db.files.size, 0)
  mode = 'normal'

  await core.revokeConversationShare(shareId)
  await core.revokeConversationShare(shareId)
  assert.deepEqual(await core.listConversationShares(), [])
  await assert.rejects(core.readAppConversationShare(url), /撤销/)
  fresh()
  const revokedCreation = await core.createConversationShare(source.id, ['local-user', 'local-assistant'])
  assert.equal(revokedCreation.revoked, true)
  const callsBeforeEnd = calls.length
  runtime.invalidateSession('login', false)
  await assert.rejects(core.listConversationShares(), /账号/)
  await assert.rejects(unified.continueSharedConversation(preview), /登录|账号/)
  assert.equal(calls.length, callsBeforeEnd)
  console.log('Conversation share checks passed: anonymous metadata-only preview, strict canonical links/DTO/duplicate keys, selected visible originals and deduplicated bytes only, no private context or API file IDs, idempotent concurrent creation/retry, owner lists/revocation, original roles/IDs/text, random local image IDs and atomic append boundary, inert source backup, image/size validation, delete and history-replace races, account end. Zero model calls; synthetic HTTP/storage only.')
} finally {
  if (!output.startsWith(root + sep)) throw Error('Unexpected test output directory')
  rmSync(output, { recursive: true, force: true })
}
