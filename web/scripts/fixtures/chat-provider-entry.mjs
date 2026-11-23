import {
  initializeRuntime,
  accountStorageKey,
  isSessionActive,
  localGuestRuntime,
  isGuestWorkspace,
} from '../../src/services/runtime.ts'

const scenario = new URLSearchParams(location.search).get('case') ?? 'main'
const KEY_A = 'SYNTHETIC_PERSONAL_KEY_A_0123456789'
const KEY_B = 'SYNTHETIC_PERSONAL_KEY_B_0123456789'
const owner = scenario === 'guest-copy' ? 'qa-guest-copy' : scenario === 'other' ? 'qa-provider-other' : 'qa-provider-main'
initializeRuntime(scenario === 'guest' ? localGuestRuntime() : {
  provider: 'DeepSeek',
  model: 'deepseek-flash',
  features: { search: true, files: true, speech: true, image_generation: false },
  user: { id: owner, username: '纯合成凭据回归', role: 'user', managed_eligible: scenario !== 'other' },
})
const results = { scenario, cases: [], networkCalls: 0, passed: false }
const check = (condition, code) => {
  if (!condition) throw Error(code)
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
let responseMode = 'ok',
  usage = 0,
  sessionEnding = 0,
  waitingUpload
const calls = []
window.addEventListener('deepseek:usage', () => usage++)
window.addEventListener('deepseek-session-ending', () => sessionEnding++)
const sse = (error) => {
  const events = error
    ? [
        {
          type: 'error',
          error: { message: 'Synthetic Bearer ' + KEY_B + ' https://example.com/?token=' + KEY_B },
        },
      ]
    : [
        {
          type: 'message_start',
          message: {
            id: 'synthetic-message',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '合成回答。' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: 'message_stop' },
      ]
  return new Response(
    events
      .map((event) => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}
// Every model/API fetch is a local deterministic function, never a network request.
window.fetch = async (url, init = {}) => {
  const path = new URL(url, location.href).pathname
  const record = {
    url: String(url),
    path,
    method: init.method ?? 'GET',
    init,
    headers: new Headers(init.headers),
  }
  calls.push(record)
  if (responseMode === 'auth' && path.endsWith('/messages'))
    return new Response(JSON.stringify({ error: { message: KEY_B } }), {
      status: 401,
      headers: { 'X-Session-Expired': '1' },
    })
  if (path.endsWith('/messages') && responseMode === 'input-limit-http')
    return new Response(JSON.stringify({ error: syntheticInputLimit }), { status: 400 })
  if (path.endsWith('/messages') && responseMode === 'input-limit-managed')
    return new Response(JSON.stringify({ error: { message: 'synthetic-private-rejection', code: 'chat_input_too_long' } }),
      { status: 400 })
  if (path.endsWith('/messages') && responseMode === 'input-limit-sse')
    return inputLimitSse()
  if (responseMode === 'file400' && path.endsWith('/messages'))
    return new Response(
      JSON.stringify({
        error: {
          message: 'file_ids do not exist or are not created under your account: file-api-expired',
        },
      }),
      { status: 400 }
    )
  if (path.endsWith('/messages')) return sse(responseMode === 'stream-error')
  if (path.endsWith('/files') && init.method === 'POST') {
    if (responseMode === 'late-upload')
      return new Promise((resolve, reject) => {
        waitingUpload = { resolve, reject }
        init.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true }
        )
      })
    return new Response(
      JSON.stringify({
        id: 'file-api-synthetic-' + calls.length,
        type: 'file',
        size_bytes: 4,
        created_at: '2026-11-18T00:00:00Z',
        filename: '合成.png',
        mime_type: 'image/png',
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  }
  if (path.endsWith('/asr')) return new Response(JSON.stringify({ text: '合成语音文字。' }))
  if (path.endsWith('/tts'))
    return new Response(new Uint8Array([0, 0, 1, 0]), {
      headers: { 'Content-Type': 'application/octet-stream' },
    })
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
const syntheticInputLimit = {
  message: 'user input too long, 643317 tokens exceeds max 32768 tokens (synthetic-private-rejection)',
}
const inputLimitSse = () => new Response(
  'event: error\ndata: ' + JSON.stringify({ error: syntheticInputLimit }) + '\n\n',
  { headers: { 'Content-Type': 'text/event-stream' } }
)
const expectInputLimit = async (events, label) => {
  try {
    for await (const _event of events) {}
  } catch (error) {
    check(error?.code === 'chat_input_too_long' && error.status === 400 &&
      error.localMessage?.key === 'replyContextInputTooLong' && !error.message.includes('643317') &&
      !error.message.includes('synthetic-private-rejection'), label)
    return
  }
  throw Error(label)
}
const waitUntil = async (predicate, code) => {
  for (let index = 0; index < 100; index++) {
    if (await predicate()) return
    await delay(20)
  }
  throw Error(code)
}
const credentialRows = async (purpose = 'chat') => {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open(accountStorageKey(`${purpose}-provider-vault`))
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  const rows = await new Promise((resolve, reject) => {
    const r = db.transaction('entries').objectStore('entries').getAll()
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  db.close()
  return rows
}
try {
  const provider = await import('../../src/services/chatProvider.ts')
  const settings = await import('../../src/services/settings.ts')
  const api = await import('../../src/services/api/client.ts')
  const speech = await import('../../src/services/api/speech.ts')
  await provider.initializeChatProvider()
  if (scenario === 'main') {
    check(
      provider.useChatProvider.getState().mode === 'managed' &&
        settings.useSettings.getState().apiKey === 'server-managed' &&
        calls.length === 0,
      'managed_default_failed'
    )
    for await (const _event of api.streamMessage(
      'server-managed',
      { model: 'deepseek-flash', messages: [{ role: 'user', content: '合成文字。' }] },
      new AbortController().signal
    )) {
    }
    check(
      calls[0].url === '/deepseek-api/chat/anthropic/v1/messages' &&
        !calls[0].headers.has('Authorization') &&
        calls[0].headers.get('X-Chat-User-Id') === owner,
      'managed_transport_failed'
    )
    results.cases.push('managed default and same-origin transport')
    responseMode = 'input-limit-managed'
    await expectInputLimit(api.streamMessage('server-managed', { model: 'deepseek-flash', messages: [] },
      new AbortController().signal), 'managed_context_limit_not_normalized')
    responseMode = 'ok'
    await provider.configureChatProvider({ mode: 'personal', apiKey: KEY_A })
    const scopeA = provider.getChatProviderScope(KEY_A)
    const rows = await credentialRows()
    const key = rows.find((row) => row.id === 'key')?.key,
      sealed = rows.find((row) => row.id === 'credential')
    check(
      key?.extractable === false &&
        key.algorithm.name === 'AES-GCM' &&
        sealed?.ciphertext instanceof ArrayBuffer,
      'vault_format_failed'
    )
    let exported = false
    try {
      await crypto.subtle.exportKey('raw', key)
      exported = true
    } catch {}
    check(!exported && !JSON.stringify(rows).includes(KEY_A), 'vault_key_extractable')
    check(
      [...Array(localStorage.length)].every(
        (_, index) => !localStorage.getItem(localStorage.key(index)).includes(KEY_A)
      ),
      'plaintext_local_storage'
    )
    results.cases.push('real IndexedDB nonextractable AES-GCM key and ciphertext')
    const images = await import('../../src/services/imageProvider.ts')
    await images.initializeImageProvider()
    check(images.activeImageProvider() === null, 'missing_image_service_enabled')
    await images.configureImageProvider('personal', 'https://images.invalid/v1', 'synthetic-private-image-key', 'draw-test')
    const imageRows = await credentialRows('image')
    check(imageRows.find(row => row.id === 'key')?.key.extractable === false && imageRows.find(row => row.id === 'credential')?.ciphertext instanceof ArrayBuffer, 'image_vault_unsealed')
    check(images.activeImageProvider() === 'personal' && provider.getChatProviderScope(KEY_A) === scopeA, 'image_overwrote_chat_key')
    await images.forgetImageProvider()
    check(images.activeImageProvider() === null && provider.getChatProviderScope(KEY_A) === scopeA, 'image_clear_affected_chat_key')
    results.cases.push('separate device-protected image API credential and local removal')
    const beforeUsage = usage
    for await (const _event of api.streamMessage(
      KEY_A,
      { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: '合成文字。' }] },
      new AbortController().signal
    )) {
    }
    const personal = calls.at(-1)
    check(
      personal.url === 'https://api.deepseek.com/anthropic/v1/messages' &&
        personal.headers.get('Authorization') === 'Bearer ' + KEY_A &&
        !personal.headers.has('X-Chat-User-Id') &&
        personal.init.credentials === 'omit' &&
        personal.init.redirect === 'error' &&
        JSON.parse(personal.init.body).model === 'deepseek-flash' &&
        usage === beforeUsage,
      'personal_transport_failed'
    )
    for (const path of ['/api/runtime', '/api/conversation-shares', '/api/conversation-sync']) {
      await api.request('/deepseek-api/chat' + path, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + KEY_A, 'x-api-key': KEY_A },
      })
      const request = calls.at(-1)
      check(
        !request.headers.has('Authorization') &&
          !request.headers.has('x-api-key') &&
          request.headers.get('X-Chat-User-Id') === owner,
        'account_secret_leak'
      )
    }
    results.cases.push('official host, frozen secret, private account/share/sync isolation')
    const file = await api.uploadFile(
      KEY_A,
      new File(['synthetic'], '合成.txt', { type: 'text/plain' }),
      'user_data'
    )
    check(
      calls.at(-1).url === 'https://api.deepseek.com/anthropic/v1/files' &&
        calls.at(-1).headers.get('anthropic-beta') === 'files-api-2025-04-14',
      'files_route_failed'
    )
    await api.deleteFile(KEY_A, file.id)
    const audio = new Uint8Array(16)
    audio.set(new TextEncoder().encode('RIFF'))
    audio.set(new TextEncoder().encode('WAVE'), 8)
    check(
      (await speech.transcribe(KEY_A, new Blob([audio], { type: 'audio/wav' }))) ===
        '合成语音文字。',
      'asr_failed'
    )
    const sound = await speech.synthesize(
      KEY_A,
      '合成朗读。',
      'stella',
      new AbortController().signal
    )
    check(
      (await sound.getReader().read()).value.byteLength === 4 &&
        calls.at(-1).url === 'https://api.deepseek.com/v1/tools/tts' &&
        usage === beforeUsage,
      'tts_failed'
    )
    const beforeInvalid = calls.length
    await api.requestChatApi(KEY_A, 'https://example.com/messages', { method: 'POST' }).then(
      () => {
        throw Error('bad_path_accepted')
      },
      () => {}
    )
    check(calls.length === beforeInvalid, 'bad_path_dispatched')
    results.cases.push('Files, ASR, TTS direct routes without managed usage')
    const attachments = await import('../../src/services/attachments.ts')
    const upload = attachments.uploadAttachment(
      KEY_A,
      'qa-upload',
      new Blob(['synthetic'], { type: 'image/png' }),
      '合成.png',
      true
    )
    await upload
    check(
      attachments.useUploads.getState().tasks['qa-upload'].providerScope === scopeA &&
        !provider.isFileProviderScope(undefined, scopeA),
      'personal_scope_missing'
    )
    responseMode = 'late-upload'
    const pendingUpload = attachments
      .uploadAttachment(
        KEY_A,
        'qa-late',
        new Blob(['synthetic'], { type: 'image/png' }),
        '合成.png',
        true
      )
      .then(
        () => false,
        () => true
      )
    await waitUntil(() => waitingUpload, 'late_upload_missing')
    await provider.configureChatProvider({ mode: 'personal', apiKey: KEY_B })
    check(await pendingUpload, 'late_upload_not_aborted')
    check(
      Object.values(attachments.useUploads.getState().tasks).every(
        (task) => task.status === 'error' && task.retryable && !('serverId' in task)
      ) &&
        provider.getChatProviderScope(KEY_B) !== scopeA &&
        sessionEnding === 0,
      'provider_switch_boundary_failed'
    )
    results.cases.push(
      'provider scope isolates cached IDs and aborts late upload without ending account sync'
    )
    responseMode = 'auth'
    let error
    try {
      for await (const _event of api.streamMessage(
        KEY_B,
        { model: 'deepseek-flash', messages: [] },
        new AbortController().signal
      )) {
      }
    } catch (caught) {
      error = caught
    }
    check(
      error?.code === 'personal_auth' &&
        !error.message.includes(KEY_B) &&
        isSessionActive() &&
        settings.useSettings.getState().apiKey === KEY_B,
      'personal_401_account_logout'
    )
    responseMode = 'stream-error'
    try {
      for await (const _event of api.streamMessage(
        KEY_B,
        { model: 'deepseek-flash', messages: [] },
        new AbortController().signal
      )) {
      }
    } catch (caught) {
      error = caught
    }
    check(error?.code === 'personal_stream' && !error.message.includes(KEY_B), 'stream_secret_echo')
    results.cases.push(
      'personal authentication and streaming errors redact key and preserve app login'
    )
    for (const mode of ['input-limit-http', 'input-limit-sse']) {
      responseMode = mode
      await expectInputLimit(api.streamMessage(KEY_B, { model: 'deepseek-flash', messages: [] },
        new AbortController().signal), mode)
    }
    const { readCompatibleChatResponse } = await import('../../src/services/api/compatibleChat.ts')
    for (const response of [new Response(JSON.stringify({ error: syntheticInputLimit }), { status: 400 }), inputLimitSse()]) {
      await expectInputLimit(readCompatibleChatResponse(response, 'synthetic-model', new AbortController().signal),
        'compatible_context_limit_not_normalized')
    }
    results.cases.push('managed and personal input-limit errors show fixed capacity guidance without exposing provider text')
    responseMode = 'ok'
    const store = await import('../../src/services/chat/store.ts')
    const db = await import('../../src/services/chat/db.ts')
    const drafts = await import('../../src/services/chat/drafts.ts')
    await store.initChat()
    const makeSession = (id, serverId, serverScope) => ({
      id,
      title: '合成文件作用域回归',
      createdAt: 1,
      updatedAt: 2,
      rootMessageId: id + '-u',
      messages: [
        {
          id: id + '-u',
          role: 'user',
          content: '合成旧图片。',
          files: [
            {
              id: id + '-image',
              serverId,
              serverScope,
              name: '合成旧图.png',
              size: 4,
              isImage: true,
              mimeType: 'image/png',
            },
          ],
          createdAt: 1,
          parentId: null,
          selectedChildId: id + '-a',
        },
        {
          id: id + '-a',
          role: 'assistant',
          model: null,
          prefix: false,
          status: 'done',
          blocks: [{ type: 'text', text: '合成旧回答。' }],
          createdAt: 2,
          parentId: id + '-u',
        },
      ],
    })
    const runStore = async (session, mode) => {
      await db.saveSession(session)
      store.useChatStore.setState({
        ready: true,
        sessionCache: { [session.id]: session },
        sessions: [{ id: session.id, title: session.title, createdAt: 1, updatedAt: 2 }],
        activeId: session.id,
      })
      drafts.setDraftText(session.id, '合成新问题。')
      responseMode = mode
      const from = calls.length
      check(store.sendMessage(session.id), 'store_send_failed')
      await waitUntil(() => {
        const state = store.useChatStore.getState(),
          current = state.sessionCache[session.id]
        return current.messages.length === 4 && !state.streaming[session.id]
      }, 'store_request_not_finished')
      return calls.slice(from)
    }
    const missing = await runStore(
      makeSession(
        'qa-scope-missing',
        'file-api-managed-private',
        accountStorageKey('managed-provider')
      ),
      'ok'
    )
    check(
      missing.filter((call) => call.path.endsWith('/messages')).length === 1 &&
        !JSON.stringify(
          JSON.parse(missing.find((call) => call.path.endsWith('/messages')).init.body)
        ).includes('file-api-managed-private'),
      'old_scope_sent_to_personal'
    )
    const expired = await runStore(
      makeSession('qa-scope-expired', 'file-api-expired', provider.getChatProviderScope(KEY_B)),
      'file400'
    )
    await delay(1200)
    check(
      expired.filter((call) => call.path.endsWith('/messages')).length === 1 &&
        !expired.some((call) => call.path.endsWith('/files')),
      'personal_file_error_auto_replayed'
    )
    check(
      store.useChatStore.getState().sessionCache['qa-scope-expired'].messages[0].files[0]
        .serverId === null,
      'personal_stale_id_not_cleared'
    )
    const limited = await runStore(
      makeSession('qa-context-limited', 'file-api-context-original', provider.getChatProviderScope(KEY_B)),
      'input-limit-http'
    )
    const preserved = store.useChatStore.getState().sessionCache['qa-context-limited'].messages
    check(limited.filter((call) => call.path.endsWith('/messages')).length === 1 &&
      preserved[0].files[0].serverId === 'file-api-context-original' && preserved[2].content === '合成新问题。' &&
      preserved[3].status === 'error' && preserved[3].error.localMessage?.key === 'replyContextInputTooLong',
      'context_limit_replayed_or_lost_originals')
    check(sessionEnding === 0, 'provider_change_ended_sync')
    results.cases.push(
      'actual store filters old fileScope and never auto-replays personal file errors'
    )
    results.scope = provider.getChatProviderScope(KEY_B)
    results.passed = true
  } else if (scenario === 'reload') {
    check(
      provider.useChatProvider.getState().mode === 'personal' &&
        settings.useSettings.getState().apiKey === KEY_B &&
        calls.length === 0,
      'encrypted_reload_failed'
    )
    results.scope = provider.getChatProviderScope(KEY_B)
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(accountStorageKey('chat-provider-vault'))
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    const rows = await credentialRows(),
      record = rows.find((row) => row.id === 'credential')
    const bytes = new Uint8Array(record.ciphertext)
    bytes[0] ^= 1
    record.ciphertext = bytes.buffer
    await new Promise((resolve, reject) => {
      const tx = db.transaction('entries', 'readwrite')
      tx.objectStore('entries').put(record)
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    results.cases.push('actual persisted CryptoKey decrypts after page reload')
    results.passed = true
  } else if (scenario === 'corrupt') {
    check(
      provider.useChatProvider.getState().mode === 'personal' &&
        !provider.useChatProvider.getState().loading &&
        provider.useChatProvider.getState().error &&
        settings.useSettings.getState().apiKey === null &&
        calls.length === 0,
      'corrupt_vault_fell_back'
    )
    let blocked = false
    try {
      await api.requestChatApi('', '/anthropic/v1/messages', { method: 'POST' })
    } catch {
      blocked = true
    }
    check(blocked && calls.length === 0, 'corrupt_vault_dispatched')
    await provider.configureChatProvider({ mode: 'personal', apiKey: KEY_A })
    await provider.clearPersonalApiKey()
    check(
      provider.useChatProvider.getState().mode === 'personal' &&
        settings.useSettings.getState().apiKey === null &&
        (await credentialRows()).length === 0,
      'clear_key_not_closed'
    )
    await provider.configureChatProvider({ mode: 'personal', apiKey: KEY_A })
    await provider.configureChatProvider({ mode: 'managed' })
    check(
      settings.useSettings.getState().apiKey === 'server-managed' &&
        provider.isFileProviderScope(undefined, provider.getChatProviderScope()),
      'managed_legacy_scope_failed'
    )
    check(calls.length === 0 && sessionEnding === 0, 'configuration_made_paid_call_or_ended_sync')
    results.cases.push(
      'corrupt vault fails closed, explicit repair/clear/managed selection stay local'
    )
    results.passed = true
  } else if (scenario === 'guest') {
    check(isGuestWorkspace() && accountStorageKey('chats').includes(':local-guest:'), 'guest_namespace')
    await provider.configureChatProvider({mode:'personal', apiKey:KEY_A})
    await api.uploadFile(KEY_A,new File(['guest'], 'guest.txt', {type:'text/plain'}),'user_data')
    const audio = new Uint8Array(16)
    audio.set(new TextEncoder().encode('RIFF'))
    audio.set(new TextEncoder().encode('WAVE'), 8)
    await speech.transcribe(KEY_A, new Blob([audio], {type:'audio/wav'}))
    const spoken = await speech.synthesize(KEY_A, '本机访客。', 'stella', new AbortController().signal)
    await spoken.getReader().read()
    for await (const event of api.streamMessage(KEY_A,{model:'deepseek-flash',messages:[]},new AbortController().signal)) {}
    check(calls.length === 4 && calls.every(call=>new URL(call.url).origin === 'https://api.deepseek.com' &&
      call.headers.get('Authorization') === 'Bearer '+KEY_A && !call.headers.has('X-Chat-User-Id') &&
      call.init.credentials === 'omit'), 'guest_official_routes')
    for (const path of ['/api/conversation-sync','/api/conversation-shares','/api/image-jobs','/api/redeem-invite']) {
      let denied = false
      try { await api.request('/deepseek-api/chat'+path,{method:'POST'}) } catch(error) { denied = error.code === 'login_required' }
      check(denied, 'guest_allowed_account_request')
    }
    provider.updateManagedEligibility(true)
    check(!provider.useChatProvider.getState().managedEligible && calls.length === 4,'guest_allowed_managed')
    const db = await import('../../src/services/chat/db.ts')
    await db.appendSession({
      id: 'guest-original', title: 'Synthetic guest history', createdAt: 1, updatedAt: 2,
      rootMessageId: 'g-question', messages: [
        { id: 'g-question', role: 'user', parentId: null, selectedChildId: 'g-active', content: 'Example', createdAt: 1,
          files: [{ id: 'fixture-file', name: 'note.txt', size: 4, mimeType: 'text/plain', isImage: false,
            serverId: 'guest-provider-handle', serverScope: 'guest-api' }] },
        { id: 'g-active', role: 'assistant', parentId: 'g-question', createdAt: 2, status: 'done', prefix: false,
          model: null, blocks: [{ type: 'text', text: 'Current branch' }] },
        { id: 'g-alt', role: 'assistant', parentId: 'g-question', createdAt: 2, status: 'streaming', prefix: true,
          model: null, blocks: [{ type: 'text', text: 'Other branch' }] },
      ],
    }, () => true, [{ id: 'fixture-file', blob: new Blob(['test'], {type:'text/plain'}) }])
    results.cases.push('local guest key direct chat/file/ASR/TTS, no application-account headers, no managed operations')
    results.passed = true
  } else if (scenario === 'guest-copy') {
    const history = await import('../../src/services/chat/guestHistory.ts')
    const db = await import('../../src/services/chat/db.ts')
    check(await history.countGuestChats() === 1 && (await db.loadSessionSummaries()).length === 0, 'guest_data_visible_without_copy')
    await history.copyGuestChats(() => false).then(
      () => { throw Error('unconfirmed_copy_writes') }, () => {}
    )
    check(await history.copyGuestChats(() => true) === 1, 'guest_copy_failed')
    const [summary] = await db.loadSessionSummaries()
    const copy = await db.loadSession(summary.id)
    const file = copy.messages[0].files[0]
    check(copy.id !== 'guest-original' && copy.rootMessageId === 'g-question' && copy.messages.length === 3 &&
      copy.messages[0].selectedChildId === 'g-active' && copy.messages[2].status === 'stopped', 'guest_copy_lost_branches')
    check(file.id !== 'fixture-file' && !file.serverId && !file.serverScope &&
      await (await db.loadFile(file.id)).text() === 'test', 'guest_copy_reused_provider_file_or_lost_original')
    await db.saveSession({...copy, title: 'Keep account edit'})
    check(await history.copyGuestChats(() => true) === 0 &&
      (await db.loadSession(copy.id)).title === 'Keep account edit' &&
      await history.countGuestChats() === 1 && calls.length === 0, 'guest_copy_retry_not_safe')
    results.cases.push('confirmed cross-workspace copy preserves branches and local files, without API calls or duplicate overwrites')
    results.passed = true
  } else {
    check(
      provider.useChatProvider.getState().mode === 'personal' &&
        !provider.useChatProvider.getState().keyConfigured &&
        settings.useSettings.getState().apiKey === null &&
        (await credentialRows()).length === 0 &&
        calls.length === 0,
      'account_key_isolation_failed'
    )
    await provider.configureChatProvider({mode: 'managed'}).then(
      () => {throw Error('managed_without_invite')}, () => {})
    provider.updateManagedEligibility(true)
    check(settings.useSettings.getState().apiKey === 'server-managed', 'invite_default_missing')
    provider.updateManagedEligibility(false)
    check(settings.useSettings.getState().apiKey === null, 'revocation_did_not_block_managed')
    await provider.configureChatProvider({mode: 'personal', apiKey: KEY_A})
    provider.updateManagedEligibility(true)
    check(settings.useSettings.getState().apiKey === KEY_A, 'explicit_personal_choice_lost')
    check(calls.length === 0, 'eligibility_triggered_external_call')
    results.cases.push('public account requires own key, invite enables free service, revocation blocks immediately and explicit personal choice persists')
    results.passed = true
  }
} catch (error) {
  results.error = /^[a-z_]+$/.test(error.message) ? error.message : error.constructor.name
}
window.__chatProviderCheck = results
