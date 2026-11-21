import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = mkdtempSync(join(root, '.conversation-sync-check-'))
try {
  const compiled = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '--project', join(root, 'tsconfig.json'), '--noEmit', 'false', '--noCheck', '--outDir', output],
  { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  writeFileSync(join(output, 'src/services/chat/db.js'), `
    export const rows=new Map(), states=new Map(), files=new Map();
    let control, copies=0;
    export const reset=()=>{rows.clear();states.clear();files.clear();control=undefined};
    export const dirty=s=>{rows.set(s.id,structuredClone(s)); const p=states.get(s.id);states.set(s.id,{id:s.id,revision:p?.revision??0,version:(p?.version??0)+1,dirty:true,deleted:false,mutationId:'mutation-'+s.id+'-'+((p?.version??0)+1)})};
    export const remove=id=>{const p=states.get(id);rows.delete(id);states.set(id,{id,revision:p?.revision??0,version:(p?.version??0)+1,dirty:true,deleted:true,mutationId:'delete-'+id})};
    export const loadSession=async id=>structuredClone(rows.get(id));
    export const loadFile=async id=>files.get(id);
    export const loadSyncState=async id=>structuredClone(states.get(id));
    export const loadSyncStates=async()=>structuredClone([...states.values()]);
    export const loadSyncControl=async()=>structuredClone(control);
    export const prepareSyncRecords=async()=>{for(const s of rows.values())if(!states.has(s.id))dirty(s)};
    export const saveSyncControl=async(v,g)=>{if(!g()||control?.generation>v.generation)return false;const previous=control?.generation===v.generation?control:undefined;control={...previous,...v,cursor:Math.max(previous?.cursor??0,v.cursor)};return true};
    export const rebaseMissingSyncRecords=async(ids,sequence,generation,guard)=>{if(!guard())return;for(const s of states.values())if(s.revision>0&&s.revision<=sequence&&!ids.has(s.id)){s.revision=0;s.dirty=!s.deleted}};
    export const acknowledgeSync=async(id,uploaded,revision,generation,guard)=>{const s=states.get(id);if(!guard()||!s||s.revision!==uploaded.revision||control.generation!==generation)return false;s.revision=revision;s.dirty=s.version!==uploaded.version;return true};
    export const createSyncConflictCopy=s=>({...structuredClone(s),id:'conflict-'+(++copies),title:s.title+'（冲突副本）'});
    export const applySyncedSession=async(o)=>{const p=states.get(o.id);if(!o.guard()||(p?.version??0)!==o.expectedVersion||(p?.revision??0)!==o.expectedRevision||control.generation!==o.generation)return false;if(o.conflictCopy)dirty(o.conflictCopy);for(const f of o.files)files.set(f.id,f.blob);if(o.session)rows.set(o.id,structuredClone(o.session));else rows.delete(o.id);states.set(o.id,{id:o.id,version:(p?.version??0)+1,revision:o.revision,dirty:false,deleted:!o.session,mutationId:'remote-'+o.id+'-'+o.revision});return true};
  `)
  writeFileSync(join(output, 'src/services/chat/store.js'), `
    import {create} from 'zustand';
    export const useChatStore=create(()=>({ready:true,importingHistory:false,sessions:[],sessionCache:{},streaming:{}}));
    export const captureConversationSyncGuard=()=>{const epoch=useChatStore.getState().epoch;return()=>useChatStore.getState().ready&&!useChatStore.getState().importingHistory&&useChatStore.getState().epoch===epoch};
    export const displaySyncedSession=()=>{};
    export const refreshConversationSyncCache=async()=>{};
  `)
  globalThis.__API_ORIGIN__ = '/deepseek-api/chat'
  globalThis.window = new EventTarget()
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const load = path => import(pathToFileURL(join(output, 'src', path)))
  const runtime = await load('services/runtime.js')
  runtime.initializeRuntime({ provider: 'synthetic', model: 'deepseek-flash', features: {},
    user: { id: 'synthetic-owner', username: 'synthetic', role: 'user', managed_eligible: false,
      permissions: { chat_api: false, image_api: false, cloud_sync: true } } })
  const sync = await load('services/conversationSync.js')
  const db = await load('services/chat/db.js')
  const codec = await load('services/chat/syncCodec.js')
  const storage = new Map()
  globalThis.localStorage = { getItem:k=>storage.get(k) ?? null, setItem:(k,v)=>storage.set(k,v), removeItem:k=>storage.delete(k) }
  let preferences = null, preferenceRevision = 0, changePreferenceDuringWrite = false
  const calls = []
  const remote = new Map()
  const blobs = new Map()
  const mutations = new Map()
  let eligible = false, enabled = false, generation = 0, sequence = 0
  const both = { conversations: true, preferences: true, attachments: true }
  let scopes = { ...both }
  let reportsScopes = false, reportsAttachments = false
  let loseNextSettingsPatch = false, changeScopeDuringPrefs = false
  let loseNextPut = false
  let conflictNextPut = false
  let missingBlobNextPut = false
  let gateGet
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const status = () => ({ eligible, enabled, generation, sequence, ...(reportsScopes ? {
    scopes: reportsAttachments ? scopes : { conversations: scopes.conversations, preferences: scopes.preferences },
  } : {}) })
  const visibleSession = row => ({ ...row, generation, files: scopes.attachments ? row.files : [] })
  const checksum = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const publish = (snapshot, files = [], deleted = false) => {
    const row = { generation, id: snapshot.session.id, revision: ++sequence, deleted,
      content_hash: checksum({ snapshot, files, deleted }), snapshot: deleted ? null : structuredClone(snapshot), files: deleted ? [] : structuredClone(files) }
    remote.set(row.id, row)
    return row
  }
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url, 'https://digimonlegend.com')
    const path = parsed.pathname.replace('/deepseek-api/chat/api/conversation-sync', '')
    assert.ok(parsed.pathname.startsWith('/deepseek-api/chat/api/conversation-sync'), 'Sync must only use its private zero-model API')
    const headers = new Headers(init.headers)
    assert.equal(headers.get('X-Chat-User-Id'), 'synthetic-owner')
    assert.equal(headers.has('Authorization'), false)
    calls.push({ path, method: init.method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    if (!path && init.method === 'GET') {return json(status())}
    if (!path && init.method === 'PATCH') {
      const body = JSON.parse(init.body)
      if (body.enabled) {assert.equal(eligible, true)}
      if (body.expected_generation !== generation) {return json({ error: { message: 'generation changed' } }, 409)}
      if (body.scopes) {
        assert.equal(reportsScopes, true)
        assert.equal('attachments' in body.scopes, reportsAttachments)
      }
      const nextScopes = { ...scopes, ...body.scopes }
      if (enabled !== body.enabled || JSON.stringify(nextScopes) !== JSON.stringify(scopes)) {
        enabled = body.enabled
        scopes = nextScopes
        generation++
      }
      if (loseNextSettingsPatch) {loseNextSettingsPatch = false; throw new TypeError('synthetic settings response lost')}
      return json(status())
    }
    if (!path && init.method === 'DELETE') {
      enabled = false; generation++; remote.clear(); blobs.clear(); mutations.clear()
      preferences = null; preferenceRevision = 0
      return json(status())
    }
    assert.equal(eligible, true, 'Ineligible users must not send sync data requests')
    if (!enabled) {return json({ error: { message: 'disabled' } }, 409)}
    if (path === '/preferences') {
      assert.equal(scopes.preferences, true)
      if (changeScopeDuringPrefs) {
        changeScopeDuringPrefs = false
        scopes = { ...scopes, conversations: true, preferences: false }
        generation++
        return json({error:{message:'Preference scope turned off',code:'sync_scope_disabled'}}, 409)
      }
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body)
        if (changePreferenceDuringWrite) {
          changePreferenceDuringWrite = false; preferences.ttsVoice = 'tide'; preferenceRevision++
          return json({error:{message:'Revision changed'}}, 409)
        }
        assert.equal(body.expected_revision, preferenceRevision)
        const allowed = ['locale', 'themePreference', 'ttsVoice', 'thinking', 'search', 'siderCollapsed',
          'replyTone', 'replyDetail', 'replyApproach', 'replyWarmth', 'replyEnthusiasm', 'replyEmojis', 'replyVisuals', 'replyStructure',
          'persona', 'reasoningEffort', 'temperature']
        assert.ok(Object.keys(body.value).every(key => allowed.includes(key)))
        preferences = body.value; preferenceRevision++
      }
      return json({generation,revision:preferenceRevision,value:preferences})
    }
    assert.equal(scopes.conversations, true)
    if (path === '/index') {
      const after = Number(parsed.searchParams.get('after'))
      const rows = [...remote.values()].filter(row => row.revision > after).sort((a, b) => a.revision - b.revision)
      return json({ generation, entries: rows.map(({ id, revision, deleted, content_hash }) => ({ id, revision, deleted, content_hash })), cursor: rows.at(-1)?.revision ?? after, has_more: false })
    }
    if (path.startsWith('/blobs/')) {
      assert.equal(scopes.attachments, true)
      const key = path.split('/').at(-1)
      if (init.method === 'PUT') {
        const bytes = Buffer.from(await init.body.arrayBuffer())
        assert.equal(createHash('sha256').update(bytes).digest('hex'), key)
        blobs.set(key, bytes)
        return json({ sha256: key, size: bytes.length })
      }
      assert.ok(blobs.has(key))
      return new Response(blobs.get(key), { headers: { 'Content-Type': 'application/octet-stream' } })
    }
    const id = decodeURIComponent(path.split('/').at(-1))
    if (init.method === 'GET') {
      if (gateGet) {await gateGet()}
      return remote.has(id) ? json(visibleSession(remote.get(id))) : json({ error: { message: 'missing' } }, 404)
    }
    const body = JSON.parse(init.body)
    assert.equal(body.generation, generation)
    if (conflictNextPut) {
      conflictNextPut = false
      const snapshot = structuredClone(remote.get(id).snapshot)
      snapshot.session.title = '上传期间另一端修改'
      publish(snapshot, remote.get(id).files)
    }
    const previous = remote.get(id)
    if ((previous?.revision ?? 0) !== body.expected_revision) {return json({ error: { message: 'conflict' } }, 409)}
    if (missingBlobNextPut && body.files?.length) {
      missingBlobNextPut = false
      blobs.delete(body.files[0].sha256)
    }
    if (body.files?.some(file => !blobs.has(file.sha256))) {
      return json({ error: { message: 'original missing', code: 'sync_blob_missing' } }, 409)
    }
    const mutation = `${generation}:${body.mutation_id}`
    assert.ok(!mutations.has(mutation), 'Unknown results must be reconciled before any changed replay')
    const snapshot = init.method === 'DELETE' ? { version: 1, session: { id } } : body.snapshot
    let files = body.files ?? []
    if (!scopes.attachments && init.method !== 'DELETE') {
      assert.deepEqual(files, [], 'Paused attachments must not send a blob manifest')
      const referenced = new Set(codec.referencedSyncFiles(snapshot.session).map(file => file.id))
      files = (previous?.files ?? []).filter(file => referenced.has(file.id))
    }
    const row = publish(snapshot, files, init.method === 'DELETE')
    mutations.set(mutation, row.revision)
    if (loseNextPut) {loseNextPut = false; throw new TypeError('synthetic response lost')}
    return json(visibleSession(row))
  }
  const session = (id, title) => ({ id, title, createdAt: 1794931200000, updatedAt: 1794931200001,
    rootMessageId: `user-${id}`, messages: [
      { id: `user-${id}`, parentId: null, selectedChildId: `assistant-${id}`, role: 'user', content: ' 原话\n保持空白 ', createdAt: 1794931200000, files: [] },
      { id: `assistant-${id}`, parentId: `user-${id}`, role: 'assistant', createdAt: 1794931200001, model: null, status: 'done', prefix: false, blocks: [{ type: 'text', text: '回答' }] },
    ] })
  db.rows.set('local-first', session('local-first', '本机已有会话'))
  await sync.syncConversationsNow()
  assert.equal(remote.size, 0)
  assert.deepEqual(calls.map(call => [call.method, call.path]), [['GET', '']])
  assert.equal(sync.useConversationSync.getState().eligible, false)
  await assert.rejects(sync.setConversationSyncEnabled(true), /未开通云同步/)
  assert.ok(calls.every(call => call.method === 'GET' && !call.path))
  eligible = true
  await assert.rejects(sync.setConversationSyncEnabled(true, { ...both, conversations: false }), /暂不支持/)
  assert.ok(calls.every(call => call.method === 'GET' && !call.path), 'Old services are not allowed to enable an unsupported selection')
  await sync.setConversationSyncEnabled(true)
  assert.deepEqual(sync.useConversationSync.getState().scopes, both)
  await sync.syncConversationsNow()
  const prefs = await load('services/settings.js')
  const syncPrefs = await load('services/cloudPreferences.js')
  const { defaultReplyTuning } = await load('services/replyPreferences.js')
  const detach = syncPrefs.watchPreferenceChanges(() => generation, () => {})
  prefs.setChatProviderApiKey('SYNTHETIC_NEVER_SYNC_THIS')
  // Existing cloud documents predate reply preferences.
  for (const name of ['replyTone', 'persona', 'reasoningEffort', 'temperature']) {delete preferences[name]}
  prefs.setSearch(true); changePreferenceDuringWrite = true
  await sync.syncConversationsNow()
  assert.equal(preferences.search, true); assert.equal(preferences.ttsVoice, 'tide')
  assert.equal(prefs.useSettings.getState().ttsVoice, 'tide')
  assert.equal(prefs.useSettings.getState().apiKey, 'SYNTHETIC_NEVER_SYNC_THIS')
  assert.ok(!JSON.stringify(calls).includes('SYNTHETIC_NEVER_SYNC_THIS'))
  preferences.persona = '旧版自定义语气'
  preferenceRevision++
  await sync.syncConversationsNow()
  assert.equal(prefs.useSettings.getState().replyTone, 'custom')
  assert.equal(prefs.useSettings.getState().replyWarmth, 'default')
  assert.equal(prefs.useSettings.getState().replyDetail, 'default')
  assert.equal(prefs.useSettings.getState().replyApproach, 'default')
  const replies = { ...defaultReplyTuning, replyTone: 'warm', replyWarmth: 'more', replyVisuals: 'less',
    replyDetail: 'deep', replyApproach: 'compare', persona: '先给结论。', reasoningEffort: 'high', temperature: '0.6' }
  prefs.setReplyPreferences(replies)
  await sync.syncConversationsNow()
  for (const [name, value] of Object.entries(replies)) {
    if (value !== 'default') {assert.equal(preferences[name], value)}
  }
  preferences.persona = '另一设备修改的自定义语气'
  preferences.replyVisuals = 'default'
  preferences.replyApproach = 'default'
  preferenceRevision++
  await sync.syncConversationsNow()
  assert.equal(prefs.useSettings.getState().persona, preferences.persona)
  assert.equal(prefs.useSettings.getState().replyTone, 'warm')
  assert.equal(prefs.useSettings.getState().replyWarmth, 'more')
  assert.equal(prefs.useSettings.getState().replyVisuals, 'default')
  assert.equal(prefs.useSettings.getState().replyDetail, 'deep')
  assert.equal(prefs.useSettings.getState().replyApproach, 'default')
  const expectedPrefs = {...preferences}
  const pendingName = runtime.accountStorageKey('sync-pref-search')
  storage.set(pendingName, '{damaged')
  await sync.syncConversationsNow()
  assert.equal(storage.has(pendingName), false)
  storage.set(pendingName, JSON.stringify({generation:generation-1,value:false}))
  await sync.syncConversationsNow()
  assert.deepEqual(preferences, expectedPrefs)
  const workingStorage = globalThis.localStorage
  globalThis.localStorage = {getItem(){throw Error('unavailable')},setItem(){throw Error('unavailable')},removeItem(){throw Error('unavailable')}}
  prefs.setThinking(true)
  await sync.syncConversationsNow()
  assert.equal(preferences.thinking,true)
  globalThis.localStorage = workingStorage
  detach()
  const crypt = await load('services/keyBackup.js')
  const phrase = 'synthetic recovery words', key = 'SYNTHETIC_PRETEND_KEY'
  const envelope = await crypt.encryptKey(key, phrase)
  assert.equal(await crypt.decryptKey(envelope, phrase), key)
  assert.deepEqual(Object.keys(envelope).sort(), ['version','iv','salt','ciphertext'].sort())
  assert.ok(!JSON.stringify(envelope).includes(phrase) && !JSON.stringify(envelope).includes(key))
  const another = await crypt.encryptKey(key, phrase)
  assert.notEqual(envelope.salt, another.salt); assert.notEqual(envelope.iv, another.iv)
  await assert.rejects(crypt.decryptKey(envelope, 'wrong recovery phrase'))
  await assert.rejects(crypt.decryptKey({...envelope, iv:another.iv}, phrase))
  await assert.rejects(crypt.encryptKey('server-managed', phrase))
  assert.equal(remote.size, 1)
  assert.equal(remote.get('local-first').snapshot.session.messages[0].content, ' 原话\n保持空白 ')
  assert.equal(db.states.get('local-first').dirty, false)

  // A new device merges cloud data with its own existing history and attachment original.
  db.reset()
  const second = session('second-local', '另一端已有会话')
  const attachment = new Blob(['synthetic text original'], { type: 'text/plain' })
  second.messages[0].files.push({ id: 'txt-original', name: '合成.txt', size: attachment.size, isImage: false, mimeType: 'text/plain', serverId: 'private-upstream-file-id' })
  db.files.set('txt-original', attachment)
  db.rows.set(second.id, second)
  await sync.syncConversationsNow()
  assert.deepEqual([...db.rows.keys()].sort(), ['local-first', 'second-local'])
  assert.equal(remote.size, 2)
  assert.equal(remote.get('second-local').snapshot.session.messages[0].files[0].serverId, null)
  assert.equal(remote.get('second-local').files.length, 1)
  assert.equal(blobs.size, 1)

  const originalUploads = calls.filter(call => call.method === 'PUT' && call.path.startsWith('/blobs/')).length
  const attachmentUpdate = structuredClone(db.rows.get('second-local'))
  attachmentUpdate.title = '仅修改标题复用原件'
  db.dirty(attachmentUpdate)
  await sync.syncConversationsNow()
  assert.equal(calls.filter(call => call.method === 'PUT' && call.path.startsWith('/blobs/')).length, originalUploads)
  attachmentUpdate.title = '云端原件失效后补传'
  db.dirty(attachmentUpdate)
  missingBlobNextPut = true
  const copiesBeforeMissing = [...db.rows.keys()].filter(id => id.startsWith('conflict-')).length
  await sync.syncConversationsNow()
  assert.equal(calls.filter(call => call.method === 'PUT' && call.path.startsWith('/blobs/')).length, originalUploads + 1)
  assert.equal([...db.rows.keys()].filter(id => id.startsWith('conflict-')).length, copiesBeforeMissing)
  assert.equal(remote.get('second-local').snapshot.session.title, attachmentUpdate.title)

  // Concurrent same-session changes preserve a complete local copy.
  const local = structuredClone(db.rows.get('local-first'))
  local.title = '离线本机修改'
  db.dirty(local)
  const updated = structuredClone(remote.get(local.id).snapshot)
  updated.session.title = '另一设备修改'
  publish(updated)
  await sync.syncConversationsNow()
  assert.equal(db.rows.get(local.id).title, '另一设备修改')
  assert.ok([...db.rows.values()].some(row => row.title === '离线本机修改（冲突副本）'))
  assert.ok([...remote.values()].some(row => row.snapshot?.session.title === '离线本机修改（冲突副本）'))

  // A deletion propagates, while an offline edit concurrent with a deletion is retained.
  db.remove('second-local')
  await sync.syncConversationsNow()
  assert.equal(remote.get('second-local').deleted, true)
  const dirty = structuredClone(db.rows.get('local-first'))
  dirty.title = '删除前的离线修改'
  db.dirty(dirty)
  publish({ version: 1, session: { id: dirty.id } }, [], true)
  await sync.syncConversationsNow()
  assert.equal(db.rows.has(dirty.id), false)
  assert.ok([...db.rows.values()].some(row => row.title === '删除前的离线修改（冲突副本）'))

  // A lost response is reconciled with GET, without a second mutation.
  const uncertain = session('uncertain', '未知结果')
  db.dirty(uncertain)
  loseNextPut = true
  await assert.rejects(sync.syncConversationsNow(), /synthetic response lost/)
  assert.equal(db.states.get(uncertain.id).dirty, true)
  const putCount = calls.filter(call => call.method === 'PUT' && call.path === '/sessions/uncertain').length
  await sync.syncConversationsNow()
  assert.equal(db.states.get(uncertain.id).dirty, false)
  assert.equal(calls.filter(call => call.method === 'PUT' && call.path === '/sessions/uncertain').length, putCount)

  // A change between index and upload exercises the actual 409 path.
  const race = structuredClone(db.rows.get('uncertain'))
  race.title = '上传竞态本机修改'
  db.dirty(race)
  conflictNextPut = true
  await sync.syncConversationsNow()
  assert.equal(db.rows.get('uncertain').title, '上传期间另一端修改')
  assert.ok([...db.rows.values()].some(row => row.title === '上传竞态本机修改（冲突副本）'))

  const beforePause = calls.length
  await sync.setConversationSyncEnabled(false)
  const paused = session('paused', '关闭后本机新增')
  db.dirty(paused)
  await sync.syncConversationsNow()
  assert.equal(remote.has('paused'), false)
  assert.ok(calls.slice(beforePause).every(call => !call.path))
  const localCount = db.rows.size
  await sync.clearCloudConversations()
  assert.equal(remote.size, 0)
  assert.equal(db.rows.size, localCount)
  assert.equal(sync.useConversationSync.getState().enabled, false)
  await sync.setConversationSyncEnabled(true)
  await sync.syncConversationsNow()
  assert.ok(remote.has('paused'), 'Re-enabling repopulates the cloud from retained local originals')

  // A switch made while a read is in flight invalidates the old generation.
  const later = session('delayed', '切换期间的云端会话')
  publish(codec.encodeSyncSnapshot(later))
  let release, reached
  const waiting = new Promise(resolve => {reached = resolve})
  gateGet = async () => {reached(); await new Promise(resolve => {release = resolve})}
  const pending = sync.syncConversationsNow()
  await waiting
  await sync.setConversationSyncEnabled(false)
  gateGet = undefined
  release()
  await pending
  assert.equal(db.rows.has('delayed'), false)
  assert.equal(sync.useConversationSync.getState().enabled, false)

  reportsScopes = true
  const preferencesOnly = { ...both, conversations: false }
  const conversationsOnly = { ...both, preferences: false }
  const startScopes = calls.length
  await assert.rejects(sync.setConversationSyncEnabled(true, { ...both, conversations: false, preferences: false }), /至少/)
  assert.equal(calls.length, startScopes)
  await assert.rejects(sync.setConversationSyncEnabled(true, { ...both, attachments: false }, generation), /不支持单独关闭/)
  await assert.rejects(sync.setConversationSyncEnabled(true, preferencesOnly, generation - 1), /重新选择/)
  assert.ok(calls.slice(startScopes).every(call => call.method === 'GET' && !call.path), 'Stale drafts cannot overwrite account choices')
  loseNextSettingsPatch = true
  await sync.setConversationSyncEnabled(true, preferencesOnly, generation)
  assert.deepEqual(sync.useConversationSync.getState().scopes, preferencesOnly)
  const retained = session('opted-out', '仅保存在本机的会话')
  db.dirty(retained)
  const store = await load('services/chat/store.js')
  store.useChatStore.setState({ ready: false })
  const prefsStart = calls.length
  await sync.syncConversationsNow()
  assert.ok(calls.slice(prefsStart).some(call => call.path === '/preferences'))
  assert.ok(calls.slice(prefsStart).every(call => !call.path || call.path === '/preferences'))
  assert.equal(db.states.get(retained.id).dirty, true)
  assert.equal(remote.has(retained.id), false)
  store.useChatStore.setState({ ready: true })
  const keepPreference = syncPrefs.watchPreferenceChanges(() => generation, () => {})
  const newTheme = prefs.useSettings.getState().themePreference === 'dark' ? 'light' : 'dark'
  prefs.setThemePreference(newTheme)
  await sync.setConversationSyncEnabled(true, both, generation)
  await sync.syncConversationsNow()
  keepPreference()
  assert.equal(preferences.themePreference, newTheme, 'A pending preference survives a generation change when its consent is continuous')
  assert.equal(remote.get(retained.id).snapshot.session.title, retained.title)
  const raceScopeStart = calls.length
  changeScopeDuringPrefs = true
  await sync.syncConversationsNow()
  assert.deepEqual(sync.useConversationSync.getState().scopes, conversationsOnly)
  assert.equal(calls.slice(raceScopeStart).filter(call => call.path === '/preferences').length, 1)
  assert.ok(!calls.slice(raceScopeStart).some(call => call.path.startsWith('/index')))
  const syncConversationsStart = calls.length
  await sync.syncConversationsNow()
  assert.ok(calls.slice(syncConversationsStart).some(call => call.path.startsWith('/index')))
  assert.ok(calls.slice(syncConversationsStart).every(call => call.path !== '/preferences'))
  assert.ok(calls.every(call => call.path !== '/key-envelope'), 'The encrypted Key backup remains an explicit action')

  // Attachments paused on a newer account leave local originals and sync metadata intact.
  reportsAttachments = true
  const textOnly = { ...conversationsOnly, attachments: false }
  await sync.setConversationSyncEnabled(true, textOnly, generation)
  const offlineOriginal = session('offline-original', '只同步聊天正文的会话')
  offlineOriginal.messages[0].files.push({
    id: 'original-paused', name: '合成.txt', size: attachment.size, isImage: false, mimeType: 'text/plain',
  })
  db.files.set('original-paused', attachment)
  db.dirty(offlineOriginal)
  const whilePaused = calls.length
  await sync.syncConversationsNow()
  assert.deepEqual(remote.get(offlineOriginal.id).files, [])
  assert.equal(remote.get(offlineOriginal.id).snapshot.session.messages[0].files[0].id, 'original-paused')
  assert.equal(db.states.get(offlineOriginal.id).dirty, false)
  assert.equal(await db.files.get('original-paused').text(), await attachment.text())
  assert.ok(calls.slice(whilePaused).every(call => !call.path.startsWith('/blobs/')))

  // Enabling originals uploads the files of unchanged conversations once.
  await sync.setConversationSyncEnabled(true, conversationsOnly, generation)
  await sync.syncConversationsNow()
  assert.equal(remote.get(offlineOriginal.id).files[0].id, 'original-paused')
  const attachmentSynced = calls.length
  await sync.syncConversationsNow()
  assert.ok(calls.slice(attachmentSynced).every(call => call.method !== 'PUT'))

  // A new device can sync the same cloud revision without originals, then fill them after opting in.
  await sync.setConversationSyncEnabled(true, textOnly, generation)
  db.reset()
  await sync.syncConversationsNow()
  const textRevision = db.states.get(offlineOriginal.id).revision
  assert.equal(db.files.has('original-paused'), false)
  assert.equal(db.rows.get(offlineOriginal.id).title, offlineOriginal.title)
  await sync.setConversationSyncEnabled(true, conversationsOnly, generation)
  await sync.syncConversationsNow()
  assert.equal(await db.files.get('original-paused').text(), await attachment.text())
  assert.equal(db.states.get(offlineOriginal.id).revision, textRevision)

  await sync.setConversationSyncEnabled(true)
  const beforeRevocation = calls.length
  eligible = false
  enabled = false
  generation++
  await sync.syncConversationsNow()
  assert.equal(sync.useConversationSync.getState().eligible, false)
  assert.equal(sync.useConversationSync.getState().enabled, false)
  await assert.rejects(crypt.keyBackupSession(generation).load(), /Session changed/)
  assert.ok(calls.slice(beforeRevocation).every(call => call.method === 'GET' && !call.path))
  await sync.clearCloudConversations()
  assert.equal(remote.size, 0)
  assert.ok(db.rows.has(retained.id))
  assert.ok(calls.every(call => call.method !== 'POST'))
  console.log('Conversation synchronization checks passed: invitation gate, selectable scopes, attachment pause and restore, stale choices, legacy compatibility, revocation and privacy purge, merge, originals, conflicts, deletions, unknown results, CAS race, pause and clear; zero model calls.')
} finally {
  rmSync(output, { recursive: true, force: true })
}
