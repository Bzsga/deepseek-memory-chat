import { create } from 'zustand'
import { ApiError, request } from './api/client.js'
import { API_ORIGIN, accountStorageKey, getRuntime, isSessionActive, isGuestWorkspace, subscribeRuntimeUser } from './runtime.js'
import * as db from './chat/db.js'
import {
  captureConversationSyncGuard,
  displaySyncedSession,
  refreshConversationSyncCache,
  useChatStore,
} from './chat/store.js'
import {
  decodeSyncSnapshot,
  encodeSyncSnapshot,
  referencedSyncFiles,
  type SyncSnapshot,
} from './chat/syncCodec.js'
import type { Session } from './chat/types.js'

import { advancePendingPreferences, syncPreferences, watchPreferenceChanges } from './cloudPreferences.js'

const BASE = `${API_ORIGIN}/api/conversation-sync`
const MAX_JSON = 34 * 1024 * 1024
const MAX_FILE = 64 * 1024 * 1024
const POLL_MS = 15000
const SHA256 = /^[a-f0-9]{64}$/

export type SyncScopes = Readonly<{ conversations: boolean; preferences: boolean; attachments: boolean }>
const DEFAULT_SCOPES: SyncScopes = { conversations: true, preferences: true, attachments: true }
const sameScopes = (left: SyncScopes, right: SyncScopes) =>
  left.conversations === right.conversations && left.preferences === right.preferences &&
  left.attachments === right.attachments

type SyncStatus = {
  eligible: boolean
  enabled: boolean
  generation: number
  sequence: number
  scopes: SyncScopes
  supportsScopes: boolean
  supportsAttachments: boolean
}
type CloudFile = { id: string; sha256: string; size: number; mime_type: string }
type CloudEntry = { id: string; revision: number; deleted: boolean; content_hash: string | null }
type CloudSession = CloudEntry & { generation: number; snapshot: unknown; files: CloudFile[] }
type CloudIndex = { generation: number; entries: CloudEntry[]; cursor: number; has_more: boolean }
type PreparedSession = { snapshot: SyncSnapshot; files: CloudFile[]; blobs: Map<string, Blob> }

export const useConversationSync = create<{
  eligible: boolean
  enabled: boolean
  loading: boolean
  syncing: boolean
  error: string | null
  lastSyncedAt: number | null
  generation: number
  scopes: SyncScopes
  supportsAttachments: boolean
}>(() => ({
  eligible: getRuntime().user.permissions.cloud_sync,
  enabled: false,
  loading: true,
  syncing: false,
  error: null,
  lastSyncedAt: null,
  generation: 0,
  scopes: DEFAULT_SCOPES,
  supportsAttachments: false,
}))

let cycle: { generation: number; task: Promise<void> } | undefined
let controller: AbortController | undefined
let schedule: ((delay?: number) => void) | undefined
let broadcast: ((type: 'conversations' | 'settings') => void) | undefined
let lifetime = 0
const knownCloudBlobs = new Set<string>()

const invalid = (): never => {
  throw new Error('同步服务返回的数据格式无效，请稍后重试。')
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid()
const integer = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : invalid()
const identifier = (value: unknown): string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[/\\\p{Cc}]/u.test(value)
    ? value
    : invalid()
const boolean = (value: unknown): boolean => (typeof value === 'boolean' ? value : invalid())

const readStatus = (value: unknown): SyncStatus => {
  const item = record(value)
  const enabled = boolean(item.enabled)
  const supportsScopes = item.scopes !== undefined
  const selection = supportsScopes ? record(item.scopes) : DEFAULT_SCOPES
  const supportsAttachments = supportsScopes && selection.attachments !== undefined
  const scopes = {
    conversations: boolean(selection.conversations),
    preferences: boolean(selection.preferences),
    attachments: supportsAttachments ? boolean(selection.attachments) : true,
  }
  if (enabled && !scopes.conversations && !scopes.preferences) {
    return invalid()
  }
  return {
    eligible: item.eligible === undefined
      ? getRuntime().user.permissions.cloud_sync
      : boolean(item.eligible),
    enabled,
    generation: integer(item.generation),
    sequence: integer(item.sequence),
    scopes,
    supportsScopes,
    supportsAttachments,
  }
}
const readEntry = (value: unknown): CloudEntry => {
  const item = record(value)
  const deleted = boolean(item.deleted)
  const hash = item.content_hash
  if (hash !== null && (typeof hash !== 'string' || !SHA256.test(hash))) {
    return invalid()
  }
  return { id: identifier(item.id), revision: integer(item.revision), deleted, content_hash: hash }
}
const readCloudSession = (value: unknown, id: string, generation: number): CloudSession => {
  const item = record(value)
  const entry = readEntry(item)
  if (entry.id !== id || item.generation !== generation || !Array.isArray(item.files)) {
    return invalid()
  }
  const seen = new Set<string>()
  const files = item.files.map((value): CloudFile => {
    const file = record(value)
    const fileId = identifier(file.id)
    if (
      seen.has(fileId) ||
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256) ||
      typeof file.mime_type !== 'string' ||
      file.mime_type.length > 256
    ) {
      return invalid()
    }
    seen.add(fileId)
    const size = integer(file.size)
    if (size > MAX_FILE) {
      return invalid()
    }
    return { id: fileId, sha256: file.sha256, size, mime_type: file.mime_type }
  })
  if (entry.deleted && (item.snapshot !== null || files.length)) {
    return invalid()
  }
  return { ...entry, generation, snapshot: item.snapshot, files }
}

const readBytes = async (
  response: Response,
  maximum: number,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> => {
  if (Number(response.headers.get('Content-Length')) > maximum || !response.body) {
    return invalid()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const next = await reader.read()
      if (next.done) {
        break
      }
      length += next.value.byteLength
      if (length > maximum) {
        throw new Error('同步内容超过单次上限，请缩小会话或附件后重试。')
      }
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}
const jsonRequest = async (path: string, init: RequestInit = {}): Promise<unknown> => {
  const timeoutController = new AbortController()
  const abort = () => timeoutController.abort()
  let timedOut = false
  const timer = setTimeout(
    () => {
      timedOut = true
      abort()
    },
    path === '' ? 20000 : 180000
  )
  init.signal?.addEventListener('abort', abort, { once: true })
  if (init.signal?.aborted) {
    abort()
  }
  try {
    const response = await request(`${BASE}${path}`, {
      ...init,
      signal: timeoutController.signal,
      cache: 'no-store',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
    const bytes = await readBytes(response, MAX_JSON, timeoutController.signal)
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch (error) {
    if (timedOut && !init.signal?.aborted) {
      throw new Error('同步请求超时，已保留本机资料，请稍后重试。')
    }
    throw error
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', abort)
  }
}
const statusRequest = async (signal?: AbortSignal) =>
  readStatus(await jsonRequest('', { method: 'GET', signal }))
const message = (error: unknown): string =>
  error instanceof Error ? error.message : '同步暂时失败，请稍后重试。'
const changedConsent = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409 &&
  (error.code === 'sync_generation_changed' || error.code === 'sync_disabled' ||
    error.code === 'sync_scope_disabled')

const publishStatus = (status: SyncStatus) => {
  const current = useConversationSync.getState()
  if (status.generation < current.generation) {
    return
  }
  const enabled = status.eligible && status.enabled
  const nextGeneration = status.generation !== current.generation
  const scopesChanged = !sameScopes(current.scopes, status.scopes)
  if (!enabled || nextGeneration || scopesChanged) {
    controller?.abort()
    knownCloudBlobs.clear()
  }
  if (
    current.enabled && enabled && current.scopes.preferences && status.scopes.preferences &&
    status.generation === current.generation + 1
  ) {
    advancePendingPreferences(current.generation, status.generation)
  }
  useConversationSync.setState({
    eligible: status.eligible,
    enabled,
    generation: status.generation,
    scopes: scopesChanged ? status.scopes : current.scopes,
    supportsAttachments: status.supportsAttachments,
    loading: false,
    ...(!enabled || nextGeneration ? { lastSyncedAt: null } : {}),
  })
}

export const refreshConversationSync = async (): Promise<void> => {
  const owner = getRuntime().user.id
  const current = lifetime
  try {
    const status = await statusRequest()
    if (current !== lifetime || !isSessionActive() || getRuntime().user.id !== owner) {
      return
    }
    publishStatus(status)
    useConversationSync.setState({ error: null })
    if (status.eligible && status.enabled) {
      schedule?.()
    }
  } catch (error) {
    if (current === lifetime && isSessionActive()) {
      useConversationSync.setState({ loading: false, error: message(error) })
    }
    throw error
  }
}

export const setConversationSyncEnabled = async (
  enabled: boolean,
  scopes?: SyncScopes,
  expectedGeneration?: number
): Promise<void> => {
  if (enabled && scopes && !scopes.conversations && !scopes.preferences) {
    throw new Error('请至少选择一项同步内容。')
  }
  controller?.abort()
  const current = lifetime
  const owner = getRuntime().user.id
  const matchesChoice = (status: SyncStatus) =>
    status.enabled === enabled && (!scopes || sameScopes(status.scopes, scopes))
  let sent = false
  try {
    const before = await statusRequest()
    if (current !== lifetime || !isSessionActive() || getRuntime().user.id !== owner) {
      return
    }
    if (enabled && !before.eligible) {
      throw new ApiError('http', '此账号未开通云同步。', 403, 'sync_invitation_required')
    }
    if (expectedGeneration !== undefined && before.generation !== expectedGeneration) {
      throw new ApiError('http', '同步设置已在其他设备上更改，请重新选择。', 409, 'sync_generation_changed')
    }
    if (scopes && !before.supportsScopes && !sameScopes(scopes, DEFAULT_SCOPES)) {
      throw new Error('当前服务暂不支持选择同步内容，请稍后重试。')
    }
    if (scopes && !before.supportsAttachments && !scopes.attachments) {
      throw new Error('当前服务暂不支持单独关闭图片与附件同步，请稍后重试。')
    }
    sent = true
    const status = readStatus(
      await jsonRequest('', {
        method: 'PATCH',
        body: JSON.stringify({
          enabled,
          expected_generation: before.generation,
          ...(scopes && before.supportsScopes ? {
            scopes: before.supportsAttachments ? scopes : {
              conversations: scopes.conversations, preferences: scopes.preferences,
            },
          } : {}),
        }),
      })
    )
    if (current !== lifetime || !isSessionActive() || getRuntime().user.id !== owner) {
      return
    }
    if (!matchesChoice(status)) {
      throw new Error('服务器未保存本次同步设置，请重试。')
    }
    publishStatus(status)
    useConversationSync.setState({ error: null })
    broadcast?.('settings')
    if (enabled) {
      schedule?.(0)
    }
  } catch (error) {
    // A lost response never changes the user's choice a second time.
    const status = await statusRequest().catch(() => undefined)
    if (current !== lifetime || !isSessionActive() || getRuntime().user.id !== owner) {
      throw error
    }
    if (status) {
      publishStatus(status)
    }
    if (sent && status && matchesChoice(status) && !changedConsent(error)) {
      broadcast?.('settings')
      if (enabled) {
        schedule?.(0)
      }
      return
    }
    useConversationSync.setState({ error: message(error) })
    throw error
  }
}

export const clearCloudConversations = async (): Promise<void> => {
  controller?.abort()
  const current = lifetime
  const owner = getRuntime().user.id
  try {
    const before = await statusRequest()
    const status = readStatus(
      await jsonRequest('', {
        method: 'DELETE',
        body: JSON.stringify({ expected_generation: before.generation }),
      })
    )
    if (current !== lifetime || !isSessionActive() || getRuntime().user.id !== owner) {
      return
    }
    publishStatus(status)
    useConversationSync.setState({ error: null })
    broadcast?.('settings')
  } catch (error) {
    if (current === lifetime && isSessionActive()) {
      await refreshConversationSync().catch(() => {})
      useConversationSync.setState({ error: message(error) })
    }
    throw error
  }
}

const hash = async (value: ArrayBuffer): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)])
        )
      : value
const sameContent = (local: PreparedSession, remote: CloudSession) =>
  JSON.stringify(canonical({ snapshot: local.snapshot, files: local.files })) ===
  JSON.stringify(canonical({ snapshot: remote.snapshot, files: remote.files }))

const prepareSession = async (session: Session, attachments: boolean, guard: () => boolean): Promise<PreparedSession> => {
  const snapshot = encodeSyncSnapshot(session)
  const files: CloudFile[] = []
  const blobs = new Map<string, Blob>()
  if (!attachments) {
    return { snapshot, files, blobs }
  }
  for (const file of referencedSyncFiles(snapshot.session)) {
    const blob = await db.loadFile(file.id)
    if (!guard()) {
      throw new DOMException('Synchronization interrupted', 'AbortError')
    }
    if (!blob) {
      continue
    }
    if (blob.size > MAX_FILE) {
      throw new Error(`附件超过 64 MiB，请先导出或移除后同步。`)
    }
    const sha256 = await hash(await blob.arrayBuffer())
    files.push({
      id: file.id,
      sha256,
      size: blob.size,
      mime_type: file.mimeType || blob.type || 'application/octet-stream',
    })
    blobs.set(sha256, blob)
  }
  files.sort((a, b) => a.id.localeCompare(b.id))
  return { snapshot, files, blobs }
}

const sessionBusy = (session: Session | undefined) =>
  session?.messages.some(
    (item) =>
      item.role === 'assistant' &&
      (item.status === 'pending' ||
        item.status === 'streaming' ||
        (item.imageJob &&
          !['completed', 'failed', 'cancelled', 'unknown', 'expired'].includes(
            item.imageJob.state
          )))
  ) ?? false

const loadRemote = async (
  id: string,
  generation: number,
  signal: AbortSignal
): Promise<CloudSession> =>
  readCloudSession(
    await jsonRequest(`/sessions/${encodeURIComponent(id)}?generation=${generation}`, {
      method: 'GET',
      signal,
    }),
    id,
    generation
  )

const receiveSession = async (
  remote: CloudSession,
  generation: number,
  attachments: boolean,
  signal: AbortSignal,
  live: () => boolean,
  refreshOriginals = false,
): Promise<boolean> => {
  const storeGuard = captureConversationSyncGuard(remote.id)
  const guard = () => live() && storeGuard()
  if (!guard()) {
    return false
  }
  const state = await db.loadSyncState(remote.id)
  const acknowledged = state?.revision === remote.revision
  if (acknowledged) {
    if (!refreshOriginals || remote.deleted) {return true}
    // Let the ordinary upload queue flush this device's edits first.
    if (state.dirty) {return false}
  }
  const local = await db.loadSession(remote.id)
  if (!guard() || sessionBusy(local)) {
    return false
  }
  let conflictCopy: Session | undefined
  if (state?.dirty && local) {
    const prepared = await prepareSession(local, attachments, guard)
    if (!remote.deleted && sameContent(prepared, remote)) {
      for (const file of remote.files) {
        knownCloudBlobs.add(file.sha256)
      }
      return db.acknowledgeSync(remote.id, state, remote.revision, generation, guard)
    }
    conflictCopy = db.createSyncConflictCopy(local)
  }
  const session = remote.deleted ? null : acknowledged && local ? local : decodeSyncSnapshot(remote.snapshot, remote.id)
  const references = session
    ? new Map(referencedSyncFiles(session).map((file) => [file.id, file]))
    : new Map()
  const files: db.StoredFile[] = []
  for (const file of attachments ? remote.files : []) {
    if (!references.has(file.id)) {
      return invalid()
    }
    const existing = await db.loadFile(file.id)
    if (!guard()) {
      return false
    }
    if (existing && (await hash(await existing.arrayBuffer())) === file.sha256) {
      continue
    }
    // File IDs are stable across devices; an unrelated existing original is preserved.
    if (existing) {
      throw new Error('附件编号与本机原件冲突，请先备份后重试。')
    }
    const response = await request(`${BASE}/blobs/${file.sha256}?generation=${generation}`, {
      method: 'GET',
      cache: 'no-store',
      signal,
    })
    const bytes = await readBytes(response, MAX_FILE, signal)
    if (bytes.byteLength !== file.size || (await hash(bytes.buffer)) !== file.sha256) {
      return invalid()
    }
    files.push({ id: file.id, blob: new Blob([bytes], { type: file.mime_type }) })
  }
  if (!guard()) {
    return false
  }
  if (acknowledged && files.length === 0) {
    return true
  }
  const saved = await db.applySyncedSession({
    id: remote.id,
    session,
    files,
    revision: remote.revision,
    generation,
    expectedVersion: state?.version ?? 0,
    expectedRevision: state?.revision ?? 0,
    guard,
    conflictCopy,
  })
  if (saved && guard()) {
    if (remote.deleted) {
      knownCloudBlobs.clear()
    }
    for (const file of attachments ? remote.files : []) {
      knownCloudBlobs.add(file.sha256)
    }
    displaySyncedSession(remote.id, session, conflictCopy, (state?.version ?? 0) + 1)
    broadcast?.('conversations')
  }
  return saved
}

const sendSession = async (
  state: db.SyncSessionState,
  generation: number,
  attachments: boolean,
  signal: AbortSignal,
  live: () => boolean
): Promise<boolean> => {
  const storeGuard = captureConversationSyncGuard(state.id)
  const guard = () => live() && storeGuard()
  if (!guard()) {
    return false
  }
  const local = await db.loadSession(state.id)
  if (sessionBusy(local) || !guard()) {
    return false
  }
  if (state.deleted && state.revision === 0) {
    return db.acknowledgeSync(state.id, state, 0, generation, guard)
  }
  if (!state.deleted && !local) {
    throw new Error('本机会话暂时无法读取，已保留待同步记录。')
  }
  const prepared = local ? await prepareSession(local, attachments, guard) : undefined
  const uploadOriginals = async (force = false) => {
    for (const [sha256, blob] of prepared?.blobs ?? []) {
      if (!guard()) {
        return
      }
      if (!force && knownCloudBlobs.has(sha256)) {
        continue
      }
      await request(`${BASE}/blobs/${sha256}?generation=${generation}`, {
        method: 'PUT',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
        signal,
      })
      if (guard()) {
        knownCloudBlobs.add(sha256)
      }
    }
  }
  await uploadOriginals()
  const current = await db.loadSyncState(state.id)
  if (!guard() || current?.version !== state.version || current.revision !== state.revision) {
    return false
  }
  try {
    const body = {
      generation,
      expected_revision: state.revision,
      mutation_id: state.mutationId,
      ...(prepared ? { snapshot: prepared.snapshot, files: prepared.files } : {}),
    }
    const send = () =>
      jsonRequest(`/sessions/${encodeURIComponent(state.id)}`, {
        method: state.deleted ? 'DELETE' : 'PUT',
        body: JSON.stringify(body),
        signal,
      })
    let result: unknown
    try {
      result = await send()
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.status !== 409 ||
        !('code' in error) ||
        error.code !== 'sync_blob_missing' ||
        !prepared?.blobs.size ||
        !guard()
      ) {
        throw error
      }
      // Another device may have deleted the last reference to an unchanged original.
      knownCloudBlobs.clear()
      await uploadOriginals(true)
      if (!guard()) {
        return false
      }
      result = await send()
    }
    const remote = readCloudSession(result, state.id, generation)
    if (!guard()) {
      return false
    }
    const saved = await db.acknowledgeSync(state.id, state, remote.revision, generation, live)
    if (remote.deleted) {
      knownCloudBlobs.clear()
    }
    for (const file of remote.files) {
      knownCloudBlobs.add(file.sha256)
    }
    return saved
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409 || !live()) {
      throw error
    }
    const status = await statusRequest(signal)
    if (status.generation !== generation || !status.eligible || !status.enabled || !status.scopes.conversations) {
      publishStatus(status)
      return false
    }
    const remote = await loadRemote(state.id, generation, signal)
    await receiveSession(remote, generation, attachments, signal, live)
    return false
  }
}

const backfillOriginals = async (
  remote: CloudSession,
  generation: number,
  signal: AbortSignal,
  live: () => boolean,
): Promise<boolean> => {
  const state = await db.loadSyncState(remote.id)
  if (!live() || !state || state.revision !== remote.revision || state.dirty) {
    return false
  }
  const local = await db.loadSession(remote.id)
  if (!local || !live()) {
    return false
  }
  const cloudIds = new Set(remote.files.map((file) => file.id))
  for (const file of referencedSyncFiles(local)) {
    if (!cloudIds.has(file.id) && await db.loadFile(file.id)) {
      return sendSession({ ...state, mutationId: `${state.mutationId}-originals` }, generation, true, signal, live)
    }
  }
  return live()
}

const synchronizeConversationScope = async (
  status: SyncStatus,
  signal: AbortSignal,
  live: () => boolean
): Promise<void> => {
  let firstError: unknown
  await db.prepareSyncRecords()
  await refreshConversationSyncCache()
  let control = await db.loadSyncControl()
  const attachments = status.scopes.attachments
  const refreshOriginals = status.supportsAttachments && attachments &&
    control?.attachmentGeneration !== status.generation
  const fullScan = refreshOriginals || control?.generation !== status.generation || control.cursor === 0
  if (control?.generation !== status.generation) {
    control = { id: 'control', generation: status.generation, cursor: 0 }
    if (!(await db.saveSyncControl(control, live))) {
      return
    }
  }
  let after = refreshOriginals ? 0 : control?.cursor ?? 0
  let safeCursor = after
  let blocked = false
  const remoteIds = new Set<string>()
  while (live()) {
    const item = record(
      await jsonRequest(`/index?generation=${status.generation}&after=${after}`, {
        method: 'GET',
        signal,
      })
    )
    if (item.generation !== status.generation || !Array.isArray(item.entries)) {
      return invalid()
    }
    const index: CloudIndex = {
      generation: status.generation,
      entries: item.entries.map(readEntry),
      cursor: integer(item.cursor),
      has_more: boolean(item.has_more),
    }
    if (index.cursor < after || (index.has_more && index.cursor <= after)) {
      return invalid()
    }
    for (const entry of index.entries) {
      remoteIds.add(entry.id)
      try {
        const state = await db.loadSyncState(entry.id)
        if (state?.revision !== entry.revision || refreshOriginals && !entry.deleted) {
          const remote = await loadRemote(entry.id, status.generation, signal)
          const handled = await receiveSession(remote, status.generation, attachments, signal, live, refreshOriginals)
          blocked ||= !handled
          if (handled && refreshOriginals && !remote.deleted) {
            const restored = await backfillOriginals(remote, status.generation, signal, live)
            blocked ||= !restored
          }
        }
      } catch (error) {
        if (signal.aborted || !live()) {
          return
        }
        if (changedConsent(error)) {
          throw error
        }
        firstError ??= error
        blocked = true
      }
      if (!blocked) {
        safeCursor = entry.revision
      }
    }
    if (!blocked) {
      safeCursor = index.cursor
    }
    await db.saveSyncControl(
      { id: 'control', generation: status.generation, cursor: safeCursor },
      live
    )
    after = index.cursor
    if (!index.has_more) {
      break
    }
  }
  if (!live()) {
    return
  }
  if (fullScan) {
    await db.rebaseMissingSyncRecords(remoteIds, status.sequence, status.generation, live)
  }
  for (const state of await db.loadSyncStates()) {
    if (!live()) {
      return
    }
    if (!state.dirty) {
      continue
    }
    try {
      await sendSession(state, status.generation, attachments, signal, live)
    } catch (error) {
      if (signal.aborted || !live()) {
        return
      }
      if (changedConsent(error)) {
        throw error
      }
      firstError ??= error
    }
  }
  if (!live()) {
    return
  }
  if (refreshOriginals && !blocked && !firstError) {
    await db.saveSyncControl({
      id: 'control', generation: status.generation, cursor: safeCursor, attachmentGeneration: status.generation,
    }, live)
  }
  await refreshConversationSyncCache()
  if (firstError) {
    throw firstError
  }
}

const synchronize = async (): Promise<void> => {
  const currentLifetime = lifetime
  const owner = getRuntime().user.id
  const stillAccount = () =>
    currentLifetime === lifetime && isSessionActive() && getRuntime().user.id === owner
  const status = await statusRequest()
  if (!stillAccount()) {
    return
  }
  publishStatus(status)
  if (!status.eligible || !status.enabled) {
    return
  }
  controller = new AbortController()
  const signal = controller.signal
  const live = () => {
    const current = useConversationSync.getState()
    return !signal.aborted && stillAccount() && current.enabled &&
      current.generation === status.generation && sameScopes(current.scopes, status.scopes)
  }
  const conversationGuard = status.scopes.conversations ? captureConversationSyncGuard() : undefined
  const conversationsLive = () => live() && conversationGuard?.() === true
  if (!live() || (!status.scopes.preferences && !conversationsLive())) {
    return
  }
  useConversationSync.setState({ syncing: true, error: null })
  let firstError: unknown
  try {
    if (status.scopes.preferences) {
      try {
        await syncPreferences(status.generation, live, signal)
      } catch (error) {
        if (!live()) {return}
        if (changedConsent(error)) {throw error}
        firstError = error
      }
    }
    if (conversationsLive()) {
      try {
        await synchronizeConversationScope(status, signal, conversationsLive)
      } catch (error) {
        if (!live()) {return}
        if (changedConsent(error)) {throw error}
        firstError ??= error
      }
    }
    if (!live()) {
      return
    }
    if (firstError) {
      throw firstError
    }
    useConversationSync.setState({ lastSyncedAt: Date.now(), error: null })
  } catch (error) {
    if (changedConsent(error) && stillAccount()) {
      const latest = await statusRequest()
      if (stillAccount()) {
        publishStatus(latest)
      }
      return
    }
    throw error
  } finally {
    if (currentLifetime === lifetime) {
      useConversationSync.setState({ syncing: false })
    }
  }
}

export const syncConversationsNow = (): Promise<void> => {
  const generation = useConversationSync.getState().generation
  if (cycle) {
    if (cycle.generation === generation) {
      return cycle.task
    }
    return cycle.task.catch(() => {}).then(syncConversationsNow)
  }
  const current = lifetime
  const task = synchronize()
    .catch((error: unknown) => {
      if (
        current === lifetime &&
        isSessionActive() &&
        !(error instanceof DOMException && error.name === 'AbortError')
      ) {
        useConversationSync.setState({ loading: false, error: message(error) })
        throw error
      }
    })
    .finally(() => {
      if (cycle?.task === task) {
        cycle = undefined
      }
    })
  cycle = { generation, task }
  return task
}

export const bindConversationSync = (): (() => void) => {
  if (isGuestWorkspace()) {
    useConversationSync.setState({ loading: false })
    return () => {}
  }
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let channel: BroadcastChannel | undefined
  const current = ++lifetime
  const queue = (delay = 600) => {
    clearTimeout(timer)
    if (disposed || !isSessionActive() || !useConversationSync.getState().eligible) {
      return
    }
    timer = setTimeout(() => {
      if (!disposed && document.visibilityState !== 'hidden') {
        void syncConversationsNow().catch(() => {})
      }
    }, delay)
  }
  schedule = queue
  try {
    channel = new BroadcastChannel(accountStorageKey('conversation-sync'))
    channel.onmessage = ({ data }: MessageEvent) => {
      if (data?.type !== 'settings') {
        void refreshConversationSyncCache().catch(() => {})
      }
      const state = useConversationSync.getState()
      if (data?.type !== 'conversations' || (state.enabled && state.scopes.conversations)) {
        queue(0)
      }
    }
    broadcast = (type) => channel?.postMessage({ type })
  } catch {
    broadcast = undefined
  }
  const localConversationChange = () => {
    broadcast?.('conversations')
    const state = useConversationSync.getState()
    if (state.enabled && state.scopes.conversations) {
      queue()
    }
  }
  const foreground = () => {
    if (document.visibilityState !== 'hidden') {
      queue(0)
    }
  }
  const end = () => cleanup()
  const unsubscribe = useChatStore.subscribe((state, previous) => {
    const sync = useConversationSync.getState()
    if (!sync.enabled || !sync.scopes.conversations) {
      return
    }
    if (state.importingHistory && !previous.importingHistory) {
      controller?.abort()
    }
    if (
      (state.ready && !previous.ready) ||
      (!state.importingHistory && previous.importingHistory)
    ) {
      queue(0)
    }
  })
  const unwatchPreferences = watchPreferenceChanges(() => {
    const state = useConversationSync.getState()
    return state.enabled && state.scopes.preferences ? state.generation : undefined
  }, () => {
    broadcast?.('settings')
    queue()
  })
  const unwatchEligibility = subscribeRuntimeUser((user, previous) => {
    if (user.permissions.cloud_sync === previous.permissions.cloud_sync) {
      return
    }
    if (!user.permissions.cloud_sync) {
      controller?.abort()
      knownCloudBlobs.clear()
      useConversationSync.setState({ eligible: false, enabled: false, lastSyncedAt: null })
    }
    void refreshConversationSync().catch(() => {})
  })
  const interval = setInterval(() => queue(0), POLL_MS)
  window.addEventListener('online', foreground)
  window.addEventListener('pageshow', foreground)
  document.addEventListener('visibilitychange', foreground)
  window.addEventListener('deepseek-conversations-changed', localConversationChange)
  window.addEventListener('deepseek-session-ending', end)
  void refreshConversationSync().catch(() => {})
  const cleanup = () => {
    if (disposed) {
      return
    }
    disposed = true
    if (current === lifetime) {
      lifetime++
      schedule = undefined
      broadcast = undefined
    }
    controller?.abort()
    useConversationSync.setState({ syncing: false })
    clearTimeout(timer)
    clearInterval(interval)
    unsubscribe()
    unwatchPreferences()
    unwatchEligibility()
    channel?.close()
    window.removeEventListener('online', foreground)
    window.removeEventListener('pageshow', foreground)
    document.removeEventListener('visibilitychange', foreground)
    window.removeEventListener('deepseek-conversations-changed', localConversationChange)
    window.removeEventListener('deepseek-session-ending', end)
  }
  return cleanup
}
