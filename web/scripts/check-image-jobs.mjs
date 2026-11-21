import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = mkdtempSync(join(root, '.image-jobs-check-'))
const realTimeout = globalThis.setTimeout
globalThis.setTimeout = (callback, delay, ...args) => realTimeout(callback, [1500, 2000].includes(delay) ? 5 : delay, ...args)
try {
  const compiled = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--project', join(root, 'tsconfig.json'), '--noEmit', 'false', '--outDir', output],
  { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  writeFileSync(join(output, 'src/services/chat/db.js'), `
    import {toSessionSummary} from './types.js';
    export const rows = new Map(); export const files = new Map(); export const summaries = new Map();
    export const saveSession = async (value, originals=[]) => {
      rows.set(value.id,structuredClone(value)); summaries.set(value.id,toSessionSummary(value));
      for(const file of originals)files.set(file.id,file.blob);
    };
    export const loadSession = async id => structuredClone(rows.get(id));
    export const loadSessionSummaries = async () => [...summaries.values()];
    export const loadFile = async id => files.get(id);
    export const deleteSession = async id => {rows.delete(id);summaries.delete(id)};
    export const clearStaging = async () => {};
    export const commitStaging = async () => {rows.clear();summaries.clear();return []};
    export const reportStorageError = () => () => {};
  `)
  globalThis.__API_ORIGIN__ = '/deepseek-api/chat'
  globalThis.window = new EventTarget()
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  globalThis.cancelAnimationFrame = () => {}
  globalThis.requestAnimationFrame = callback => realTimeout(callback, 0)
  const load = path => import(pathToFileURL(join(output, 'src', path)))
  const runtime = await load('services/runtime.js')
  runtime.initializeRuntime({ provider: 'DeepSeek', model: 'synthetic', features: {image_generation:true},
    user: { id: 'synthetic-job-owner', username: 'synthetic', role: 'user', managed_eligible: true } })
  writeFileSync(join(output, 'src/services/personalKeyVault.js'), `
    const rows = new Map();
    export const readPersonalApiKey = async purpose => rows.get(purpose) ?? null;
    export const hasPersonalApiKey = async purpose => rows.has(purpose);
    export const removePersonalApiKey = async purpose => rows.delete(purpose);
    export const storePersonalApiKey = async (apiKey, endpoint, purpose) => { rows.set(purpose, {apiKey}); return {apiKey} };
  `)
  const imageProvider = await load('services/imageProvider.js')
  await imageProvider.initializeImageProvider()
  const db = await load('services/chat/db.js')
  const store = await load('services/chat/store.js')
  const drafts = await load('services/chat/drafts.js')
  const { toSessionFile } = await load('services/chat/history/toArchive.js')
  const { toLocalSession } = await load('services/chat/history/toLocal.js')
  const { readSessionFile } = await load('services/chat/history/schema.js')
  const jobs = new Map()
  const calls = []
  let dispatches = 0
  let state = 'completed'
  let disconnectCreation = false
  let offline = false
  let holdGet
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII='
  const originalBytes = Buffer.from(image, 'base64')
  const { createImageJob } = await load('services/api/imageJobs.js')
  const { MAX_IMAGE_EDIT_COUNT, MAX_IMAGE_EDIT_MB, MAX_IMAGE_EDIT_TOTAL_MB,
    resolveImageEditSource, resolveImageEditSources } = await load('services/imageEditSource.js')
  const original = resolveImageEditSource([
    new File([originalBytes], 'original.PNG', { type: 'application/octet-stream' }),
  ]).source
  assert.ok(original)
  assert.equal(original.type, 'image/png')
  assert.equal(original.name, 'original.PNG')
  assert.equal(resolveImageEditSource([original, original]).error.key, 'imageEditSourceCount')
  assert.equal(resolveImageEditSource([new File(['gif'], 'original.gif')]).error.key, 'imageEditSourceInvalid')
  assert.equal(resolveImageEditSource([
    new File([new Uint8Array(MAX_IMAGE_EDIT_MB * 1024 * 1024 + 1)], 'large.png'),
  ]).error.key, 'uploadMaxMBSize')
  const secondOriginal = new File([originalBytes, Uint8Array.of(1, 2, 3)], 'reference.png', { type: 'image/png' })
  const references = [original, secondOriginal]
  assert.deepEqual(resolveImageEditSources(references).sources, references)
  assert.deepEqual(resolveImageEditSources(Array(MAX_IMAGE_EDIT_COUNT + 1).fill(original)).error,
    { key: 'imageEditReferenceCount', params: { count: MAX_IMAGE_EDIT_COUNT } })
  const maxFile = new File([new ArrayBuffer(MAX_IMAGE_EDIT_MB * 1024 * 1024)], 'full.png', { type: 'image/png' })
  assert.deepEqual(resolveImageEditSources([maxFile, maxFile]).sources, [maxFile, maxFile])
  assert.deepEqual(resolveImageEditSources([maxFile, maxFile, original]).error,
    { key: 'imageEditReferenceTotalSize', params: { size: MAX_IMAGE_EDIT_TOTAL_MB } })
  assert.throws(() => createImageJob('empty-input-check', '无参考图', new AbortController().signal, []), /参考图/)
  const editSubmissions = []
  const assertEditUpload = async (init, expectedSources, field = 'image') => {
    assert.ok(init.body instanceof FormData)
    assert.equal(new Headers(init.headers).has('Content-Type'), false, 'Fetch sets the multipart boundary')
    assert.ok(!init.keepalive, 'Image upload must not use the smaller keepalive body limit')
    const actual = init.body.getAll(field)
    assert.equal(init.body.has(field === 'image' ? 'image[]' : 'image'), false)
    assert.equal(actual.length, expectedSources.length)
    for (const [index, source] of actual.entries()) {
      const expected = expectedSources[index]
      assert.ok(source instanceof File)
      assert.equal(source.type, expected.type)
      assert.equal(source.name, expected.name)
      assert.deepEqual(Buffer.from(await source.arrayBuffer()), Buffer.from(await expected.arrayBuffer()))
    }
  }
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  const metadata = job => ({ id: job.id, client_request_id: job.id, status: job.status, model: 'synthetic-image',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), has_result: job.status === 'completed',
    ...(job.status === 'unknown' ? { error: { code: 'image_job_interrupted', message: '合成重启未知结果' } } : {}) })
  globalThis.fetch = async (url, init) => {
    const path = new URL(url, 'http://synthetic.invalid').pathname
    calls.push({ path, method: init.method })
    assert.equal(init.headers.get('X-Chat-User-Id'), 'synthetic-job-owner')
    if (offline) throw new TypeError('synthetic network disconnected')
    const match = /^\/deepseek-api\/chat\/api\/image-jobs(?:\/([^/]+)(?:\/(result|cancel))?)?$/.exec(path)
    assert.ok(match, `Unexpected external request ${path}`)
    let id = match[1]
    if (init.method === 'POST' && !id) {
      if (init.body instanceof FormData) {
        await assertEditUpload(init, references)
        id = init.body.get('client_request_id')
        editSubmissions.push({ id, prompt: init.body.get('prompt') })
      } else {
        assert.equal(init.keepalive, true)
        assert.equal(init.headers.get('Content-Type'), 'application/json')
        id = JSON.parse(init.body).client_request_id
      }
      const local = [...db.rows.values()].find(session => session.messages.some(message => message.imageJob?.clientRequestId === id))
      assert.ok(local, 'Stable request ID must be durable before create POST')
      assert.equal(db.summaries.get(local.id).pendingImageJob, true)
      if (!jobs.has(id)) { jobs.set(id, { id, status: state }); dispatches += 1 }
      if (disconnectCreation) { disconnectCreation = false; throw new TypeError('synthetic response lost after create') }
      return response(metadata(jobs.get(id)), 202)
    }
    if (match[2] === 'cancel') {
      const job = jobs.get(id) ?? { id, status: 'cancelled' }
      if (job.status !== 'completed') job.status = 'cancelled'
      jobs.set(id, job)
      return response(metadata(job))
    }
    if (holdGet && !match[2]) await new Promise((resolveGet, reject) => {
      holdGet.resolve = resolveGet
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    const job = jobs.get(id)
    if (!job) return response({ error: { message: 'not found' } }, 404)
    if (match[2] === 'result') {
      assert.equal(job.status, 'completed')
      return response({ model: 'synthetic-image', images: [{ b64_json: image, mime_type: 'image/png' }] })
    }
    return response(metadata(job))
  }
  const until = async condition => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (condition()) return
      await new Promise(done => realTimeout(done, 5))
    }
    throw Error('Image job operation timed out')
  }
  const idle = id => until(() => !store.useChatStore.getState().streaming[id])
  const fresh = id => {
    const session = { id, title: '合成生图', createdAt: 1, updatedAt: 2, messages: [], rootMessageId: null }
    store.useChatStore.setState({ ready: true, importingHistory: false, sessions: [session], sessionCache: { [id]: session }, activeId: id, streaming: {} })
    return session
  }
  const send = id => { drafts.setDraftText(id, '一张合成海边日出图'); assert.equal(store.sendImageMessage(id), true) }
  const reply = id => store.useChatStore.getState().sessionCache[id]?.messages.find(message => message.role === 'assistant')
  fresh('success')
  disconnectCreation = true
  send('success')
  await idle('success')
  assert.equal(dispatches, 1)
  assert.equal(reply('success').status, 'done')
  assert.equal(reply('success').imageJob, undefined)
  assert.equal(db.summaries.get('success').pendingImageJob, undefined)
  const firstImageId = reply('success').blocks[0].id
  assert.ok(db.files.has(firstImageId))
  assert.equal(calls.filter(call => call.method === 'POST' && call.path.endsWith('/image-jobs')).length, 1)

  state = 'running'
  fresh('background')
  document.visibilityState = 'hidden'
  send('background')
  await until(() => [...jobs.values()].some(job => job.status === 'running'))
  const pending = structuredClone(reply('background'))
  const requestId = pending.imageJob.clientRequestId
  const countBeforeResume = dispatches
  assert.equal(db.summaries.get('background').pendingImageJob, true)
  const portable = toSessionFile(db.rows.get('background'), () => null)
  assert.ok(!JSON.stringify(portable).includes(requestId))
  assert.equal(toLocalSession(readSessionFile(portable)).session.messages.find(message => message.role === 'assistant').imageJob, undefined)
  store.suspendReply('background')
  await idle('background')
  assert.equal(jobs.get(requestId).status, 'running')
  assert.equal(calls.some(call => call.path.endsWith(`/${requestId}/cancel`)), false)
  jobs.get(requestId).status = 'completed'
  store.useChatStore.setState({ ready: false, sessions: [], sessionCache: {}, activeId: null, streaming: {} })
  document.visibilityState = 'visible'
  await store.initChat()
  await until(() => reply('background')?.status === 'done')
  await idle('background')
  assert.equal(store.useChatStore.getState().activeId, 'background')
  assert.equal(dispatches, countBeforeResume)
  assert.equal(reply('background').blocks[0].id, `generated-${requestId}-0`)
  assert.equal(db.files.size, 2)

  fresh('missing')
  const missingId = 'missing-request-id'
  const q = { id: 'missing-user', role: 'user', content: '未确认提交', files: [], createdAt: 1, parentId: null, selectedChildId: 'missing-reply' }
  const placeholder = { id: 'missing-reply', parentId: q.id, role: 'assistant', imageGeneration: true, model: null, prefix: false, blocks: [], status: 'pending', createdAt: 2,
    imageJob: { clientRequestId: missingId, ownerId: 'synthetic-job-owner', state: 'recoverable', createdAt: Date.now() - 60000 } }
  const missingSession = { ...store.useChatStore.getState().sessionCache.missing, rootMessageId: q.id, messages: [q, placeholder] }
  store.useChatStore.setState({ sessionCache: { missing: missingSession } })
  assert.equal(store.resumeImageJob('missing', placeholder.id), true)
  await idle('missing')
  assert.equal(reply('missing').imageJob.error.code, 'image_job_not_found')
  const beforeExplicit = dispatches
  store.regenerateReply('missing')
  assert.equal(dispatches, beforeExplicit)
  assert.equal(store.useChatStore.getState().sessionCache.missing.messages.length, 2)
  state = 'completed'
  assert.equal(store.retryImageJobSubmission('missing', placeholder.id), true)
  await idle('missing')
  assert.equal(dispatches, beforeExplicit + 1)
  assert.ok(jobs.has(missingId))

  fresh('stop-restored')
  const stopped = { ...missingSession, id: 'stop-restored', messages: [q, { ...placeholder, imageJob: { ...placeholder.imageJob, clientRequestId: 'cancel-before-create', cancelRequested: true, state: 'recoverable' } }] }
  store.useChatStore.setState({ sessionCache: { 'stop-restored': stopped } })
  const beforeCancel = dispatches
  assert.equal(store.resumeImageJob(stopped.id, placeholder.id), true)
  await idle(stopped.id)
  assert.equal(reply(stopped.id).imageJob.state, 'cancelled')
  assert.equal(reply(stopped.id).status, 'stopped')
  assert.equal(jobs.get('cancel-before-create').status, 'cancelled')
  assert.equal(dispatches, beforeCancel)
  assert.equal(store.retryImageJobSubmission(stopped.id, placeholder.id), false)

  state = 'running'
  fresh('cancel')
  send('cancel')
  await until(() => reply('cancel')?.imageJob?.state === 'running')
  store.stopReply('cancel')
  await until(() => reply('cancel')?.imageJob?.state === 'cancelled')
  await idle('cancel')
  assert.ok(calls.some(call => call.path.endsWith(`/${reply('cancel').imageJob.clientRequestId}/cancel`)))

  offline = true
  fresh('offline')
  send('offline')
  await idle('offline')
  assert.equal(reply('offline').imageJob.state, 'recoverable')
  assert.equal(reply('offline').status, 'pending')
  const offlineId = reply('offline').imageJob.clientRequestId
  const offlineAttempts = calls.filter(call => call.method === 'POST' && call.path.endsWith('/image-jobs')).length
  offline = false
  assert.equal(store.resumeImageJob('offline', reply('offline').id), true)
  await idle('offline')
  assert.equal(calls.filter(call => call.method === 'POST' && call.path.endsWith('/image-jobs')).length, offlineAttempts)
  assert.equal(jobs.has(offlineId), false)

  fresh('managed-edit')
  offline = true
  drafts.setDraftText('managed-edit', '把原图的天空改成橙色')
  assert.equal(store.sendImageMessage('managed-edit', 1, references), true)
  await idle('managed-edit')
  const editReply = reply('managed-edit')
  const editId = editReply.imageJob.clientRequestId
  const editQuestion = db.rows.get('managed-edit').messages.find(message => message.role === 'user')
  assert.deepEqual(editQuestion.files.map(file => file.name), references.map(file => file.name))
  for (const [index, file] of editQuestion.files.entries()) {
    assert.deepEqual(Buffer.from(await db.files.get(file.id).arrayBuffer()),
      Buffer.from(await references[index].arrayBuffer()))
  }
  assert.equal(editReply.imageOrigin, 'edit')
  offline = false
  assert.equal(store.resumeImageJob('managed-edit', editReply.id), true)
  await idle('managed-edit')
  assert.equal(reply('managed-edit').imageJob.error.code, 'image_job_not_found')
  assert.equal(editSubmissions.length, 0)
  state = 'completed'
  assert.equal(store.retryImageJobSubmission('managed-edit', editReply.id), true)
  await idle('managed-edit')
  assert.deepEqual(editSubmissions, [{ id: editId, prompt: '把原图的天空改成橙色' }])
  assert.equal(reply('managed-edit').status, 'done')
  assert.equal(reply('managed-edit').imageOrigin, 'edit')
  assert.ok(db.files.has(reply('managed-edit').blocks[0].id))
  const { getVisibleMessages } = await load('services/chat/branches.js')
  const editPath = () => getVisibleMessages(store.useChatStore.getState().sessionCache['managed-edit'])
  store.regenerateReply('managed-edit', reply('managed-edit').id)
  await idle('managed-edit')
  assert.equal(editPath().at(-1).status, 'done')
  assert.equal(editSubmissions.length, 2)
  assert.notEqual(editSubmissions[1].id, editId)
  assert.equal(editSubmissions[1].prompt, editSubmissions[0].prompt)
  assert.equal(store.editMessage('managed-edit', editQuestion.id, '把同一张图的天空改成蓝色'), true)
  await idle('managed-edit')
  assert.equal(editPath().at(-1).status, 'done')
  assert.deepEqual(editPath().at(-2).files.map(file => file.id), editQuestion.files.map(file => file.id))
  assert.equal(editSubmissions.length, 3)
  assert.equal(editSubmissions[2].prompt, '把同一张图的天空改成蓝色')
  const managedRequestsBeforeMissingReference = calls.length
  assert.equal(db.files.delete(editQuestion.files[1].id), true)
  store.regenerateReply('managed-edit', editPath().at(-1).id)
  await idle('managed-edit')
  assert.equal(editPath().at(-1).imageJob.error.code, 'image_edit_original_missing')
  assert.equal(calls.length, managedRequestsBeforeMissingReference)

  const originalFetch = globalThis.fetch
  const personalCalls = []
  let personalError = false
  let failOnce = false
  let personalEditUnavailable = false
  let personalSources = [original]
  globalThis.fetch = async (url, init) => {
    personalCalls.push(String(url))
    assert.equal(init.credentials, 'omit')
    if (String(url) === 'https://image-cdn.invalid/result') {
      assert.equal(new Headers(init.headers).has('Authorization'), false)
      return new Response(Buffer.from(image, 'base64'))
    }
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer synthetic-image-key')
    if (String(url).endsWith('/models')) return response({data:[{id:'draw-test'}]})
    if (String(url) === 'https://images.invalid/v1/images/edits') {
      await assertEditUpload(init, personalSources, personalSources.length === 1 ? 'image' : 'image[]')
      assert.equal(init.body.get('model'), 'draw-test')
      assert.equal(init.body.get('prompt'), '删除右边的云')
      assert.equal(init.body.get('n'), '1')
      return personalEditUnavailable
        ? response({error:{message:'Synthetic unsupported route'}}, 405)
        : response({data:[{b64_json: image}]})
    }
    assert.equal(String(url), 'https://images.invalid/v1/images/generations')
    assert.equal(JSON.parse(init.body).model, 'draw-test')
    if (failOnce) {failOnce = false; throw new TypeError('one lost response')}
    if (personalError) throw new TypeError('lost POST response')
    return response({data:[{url:'https://image-cdn.invalid/result'}]})
  }
  await imageProvider.configureImageProvider('personal', 'https://images.invalid', 'synthetic-image-key', 'draw-test')
  assert.deepEqual(await imageProvider.imageModels('https://images.invalid', ''), ['draw-test'])
  assert.throws(() => imageProvider.imageModels('https://another.invalid', ''))
  fresh('personal'); send('personal'); await idle('personal')
  assert.equal(reply('personal').imageModel, 'draw-test')
  assert.equal(reply('personal').blocks[0].mimeType, 'image/png')
  personalError = true
  fresh('personal-failed'); send('personal-failed'); await idle('personal-failed')
  assert.equal(reply('personal-failed').imageJob.state, 'failed')
  assert.equal(personalCalls.filter(url => url.endsWith('/generations')).length, 2)
  personalError = false
  fresh('four'); drafts.setDraftText('four', '四种海岸风格'); assert.equal(store.sendImageMessage('four', 4), true)
  await idle('four')
  assert.equal(reply('four').status, 'done')
  assert.equal(reply('four').blocks.filter(block => block.type === 'image' && db.files.has(block.id)).length, 4)
  failOnce = true
  fresh('partial'); drafts.setDraftText('partial', '海边'); assert.equal(store.sendImageMessage('partial', 5), true)
  const attempts = personalCalls.filter(url => url.endsWith('/generations')).length
  await idle('partial')
  assert.equal(personalCalls.filter(url => url.endsWith('/generations')).length - attempts, 5)
  assert.equal(reply('partial').blocks.filter(block => block.type === 'image' && db.files.has(block.id)).length, 4)
  assert.match(reply('partial').imageJob.error.message, /4\/5/)
  const sendPersonalEdit = async (id, sources) => {
    fresh(id)
    drafts.setDraftText(id, '删除右边的云')
    personalSources = sources
    assert.equal(store.sendImageMessage(id, 1, sources), true)
    await idle(id)
  }
  const generationCalls = personalCalls.filter(url => url.endsWith('/generations')).length
  await assert.rejects(imageProvider.requestPersonalImage('无参考图', new AbortController().signal, []), /参考图/)
  await sendPersonalEdit('personal-edit', [original])
  assert.equal(reply('personal-edit').status, 'done')
  await sendPersonalEdit('personal-edit-multiple', references)
  assert.equal(reply('personal-edit-multiple').status, 'done')
  personalEditUnavailable = true
  await sendPersonalEdit('personal-edit-unavailable', references)
  assert.match(reply('personal-edit-unavailable').imageJob.error.message, /图片编辑接口不可用/)
  assert.equal(personalCalls.filter(url => url.endsWith('/generations')).length, generationCalls)
  assert.equal(personalCalls.filter(url => url.endsWith('/edits')).length, 3)
  await imageProvider.forgetImageProvider()
  assert.equal(store.sendImageMessage('personal-failed'), false)
  assert.equal(imageProvider.activeImageProvider(), null)
  await imageProvider.configureImageProvider('managed', '', '', '')
  globalThis.fetch = originalFetch

  // A pending GET from a replaced/deleted account view cannot recreate its row.
  holdGet = {}
  fresh('deleted')
  const deleting = { ...missingSession, id: 'deleted', messages: [q, { ...placeholder, imageJob: { ...placeholder.imageJob, clientRequestId: 'delete-pending-id' } }] }
  jobs.set('delete-pending-id', { id: 'delete-pending-id', status: 'running' })
  store.useChatStore.setState({ sessionCache: { deleted: deleting } })
  assert.equal(store.resumeImageJob('deleted', placeholder.id), true)
  await until(() => holdGet.resolve !== undefined)
  assert.equal(await store.removeSession('deleted'), true)
  assert.equal(db.rows.has('deleted'), false)
  assert.equal(store.useChatStore.getState().sessionCache.deleted, undefined)
  holdGet = {}
  fresh('replaced')
  store.useChatStore.setState({ sessionCache: { replaced: { ...deleting, id: 'replaced' } } })
  store.resumeImageJob('replaced', placeholder.id)
  await until(() => holdGet.resolve !== undefined)
  await store.replaceHistory(async () => {})
  assert.equal(db.rows.size, 0)
  holdGet = {}
  fresh('account-ended')
  store.useChatStore.setState({ sessionCache: { 'account-ended': { ...deleting, id: 'account-ended' } } })
  store.resumeImageJob('account-ended', placeholder.id)
  await until(() => holdGet.resolve !== undefined)
  const cancelCalls = calls.filter(call => call.path.endsWith('/cancel')).length
  runtime.setSessionEndHandler(() => store.suspendReply('account-ended'))
  runtime.invalidateSession('login', false)
  await idle('account-ended')
  assert.equal(calls.filter(call => call.path.endsWith('/cancel')).length, cancelCalls)
  assert.equal(reply('account-ended').blocks.length, 0)
  console.log('Image job checks passed: durable IDs before dispatch, lost create response and one generation, hidden/destroyed view recovery, pending-summary startup restore, deterministic files, portable backup isolation, explicit same-ID submission, ordered reference validation and persistence, managed edit recovery and branching, missing reference blocks all dispatch, personal single/multiple edit upload and no text-generation fallback, persisted cancellation/tombstone, network pause without new job, deletion/import/account isolation. Synthetic HTTP and storage boundaries only.')
} finally {
  globalThis.setTimeout = realTimeout
  if (!output.startsWith(root + sep)) throw Error('Unexpected temporary output')
  rmSync(output, { recursive: true, force: true })
}
