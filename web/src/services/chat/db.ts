import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'
import { accountStorageKey } from '../runtime.js'
import { recordDiagnostic } from '../technicalDiagnostics.js'
import { createId } from '../../utils/id.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 12
// Fixed for this page lifetime so late writes cannot follow a different account.
const DB_NAME = accountStorageKey('chats')

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

export type SyncSessionState = {
  id: string
  revision: number
  version: number
  dirty: boolean
  deleted: boolean
  mutationId: string
  writerId?: string
}

export type SyncControl = { id: 'control'; generation: number; cursor: number; attachmentGeneration?: number }

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
  syncState: { key: string; value: SyncSessionState }
  syncControl: { key: string; value: SyncControl }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null
const localWriterId = createId()
let openingError: Error | undefined
const loadedVersions = new WeakMap<Session, number>()

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user'
          ? message.files.map((file) => file.id)
          : message.blocks.flatMap((block) => (block.type === 'image' ? [block.id] : []))
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const openDatabase = () =>
  (dbPromise ??= openDB<ChatDB>(DB_NAME, DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of [
        'sessions',
        'files',
        'sessionsStaging',
        'filesStaging',
        'syncState',
        'syncControl',
      ] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
    },
    blocked() {
      openingError = new Error('请关闭其他旧版聊天页面后重试，完成本机会话存储升级。')
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('deepseek-storage-upgrade-blocked'))
      }
    },
    blocking() {
      void dbPromise?.then((db) => db.close())
      dbPromise = null
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

const getDB = async (): Promise<IDBPDatabase<ChatDB>> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      openDatabase(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(openingError ?? new Error('本机存储打开超时，请重试。')),
          8000
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

const changedSyncState = (
  id: string,
  previous?: SyncSessionState,
  deleted = false
): SyncSessionState => ({
  id,
  revision: previous?.revision ?? 0,
  version: (previous?.version ?? 0) + 1,
  dirty: true,
  deleted,
  mutationId: createId(),
  writerId: localWriterId,
})

const notifyLocalChange = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('deepseek-conversations-changed'))
  }
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)

export const loadSession = async (id: string): Promise<Session | undefined> => {
  const tx = (await getDB()).transaction(['sessions', 'syncState'])
  const session = await tx.objectStore('sessions').get(id)
  const state = await tx.objectStore('syncState').get(id)
  await tx.done
  if (session) {
    loadedVersions.set(session, state?.version ?? 0)
  }
  return session
}

export const storedSessionVersion = (session: Session): number => loadedVersions.get(session) ?? 0

export const saveSession = async (
  session: Session,
  files: StoredFile[] = [],
  expectedVersion?: number,
  expectedChat?: { replyId: string; jobId: string; cancelling?: boolean; requestCancel?: boolean;
    eventsSeen?: number; canWrite?: () => boolean }
): Promise<number> => {
  const summary = storedSummary(session)
  let writtenVersion = 0
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'syncState'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        const sync = tx.objectStore('syncState')
        const previous = await sync.get(session.id)
        const sessions = tx.objectStore('sessions')
        if (expectedChat) {
          const current = await sessions.get(session.id)
          const reply = current?.messages.find((message) => message.id === expectedChat.replyId)
          if (reply?.role !== 'assistant' || reply.chatJob?.id !== expectedChat.jobId ||
              (!expectedChat.requestCancel && Boolean(reply.chatJob.cancelRequested) !== Boolean(expectedChat.cancelling)) ||
              (expectedChat.eventsSeen !== undefined && (reply.chatJob.eventsSeen ?? 0) > expectedChat.eventsSeen) ||
              (expectedChat.canWrite && !expectedChat.canWrite())) {return}
        } else if (
          expectedVersion !== undefined &&
          previous &&
          previous.version !== expectedVersion &&
          previous.writerId !== localWriterId
        ) {
          const current = await sessions.get(session.id)
          if (current) {
            const copy = createSyncConflictCopy(current)
            await tx.objectStore('sessions').add(copy)
            await tx.objectStore('sessionSummaries').add(storedSummary(copy))
            await sync.add(changedSyncState(copy.id))
          }
        }
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await sessions.put(session)
        await tx.objectStore('sessionSummaries').put(summary)
        const changed = changedSyncState(session.id, previous)
        writtenVersion = changed.version
        await sync.put(changed)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  if (writtenVersion) {notifyLocalChange()}
  return writtenVersion
}

export const createSyncConflictCopy = (session: Session): Session => ({
  ...session,
  id: createId(),
  title: `${session.title}（冲突副本）`,
  updatedAt: Date.now(),
  nativeHandoffId: undefined,
  messages: session.messages.map((message) =>
    message.role === 'user'
      ? message
      : {
          ...message,
          chatJob: undefined,
          imageJob: undefined,
          prefix: false,
          status:
            message.status === 'pending' || message.status === 'streaming'
              ? 'stopped'
              : message.status,
        }
  ),
})

/** Shared imports append atomically. Concurrent imports of one ID keep the existing session. */
export const appendSession = async (
  session: Session,
  canWrite: () => boolean,
  files: StoredFile[] = []
): Promise<Session> => {
  if (!canWrite()) {
    throw new Error('账户或本地资料状态已变化，请重新打开分享预览。')
  }
  const connection = await getDB()
  if (!canWrite()) {
    throw new Error('账户或本地资料状态已变化，请重新打开分享预览。')
  }
  const tx = connection.transaction(
    ['sessions', 'sessionSummaries', 'files', 'syncState'],
    'readwrite'
  )
  try {
    const previous = await tx.objectStore('sessions').get(session.id)
    if (!canWrite()) {
      throw new Error('账户或本地资料状态已变化，请重新打开分享预览。')
    }
    if (!previous) {
      for (const file of files) {
        if (!canWrite()) {
          throw new Error('账户或本地资料状态已变化，请重新打开分享预览。')
        }
        await tx.objectStore('files').add(file)
      }
      if (!canWrite()) {
        throw new Error('账户或本地资料状态已变化，请重新打开分享预览。')
      }
      await tx.objectStore('sessions').add(session)
      await tx.objectStore('sessionSummaries').add(storedSummary(session))
      const sync = tx.objectStore('syncState')
      await sync.put(changedSyncState(session.id, await sync.get(session.id)))
    }
    if (!canWrite()) {
      throw new Error('账户或本地资料状态已变化，请重新打开分享预览。')
    }
    await tx.done
    if (!previous) {
      notifyLocalChange()
    }
    return previous ?? session
  } catch (error) {
    abortTransaction(tx)
    await tx.done.catch(() => {})
    throw error
  }
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'syncState'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
          const sync = tx.objectStore('syncState')
          await sync.put(changedSyncState(id, await sync.get(id)))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  notifyLocalChange()
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string, expectedVersion?: number): Promise<void> => {
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'syncState'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        const sync = tx.objectStore('syncState')
        const previous = await sync.get(sessionId)
        if (
          expectedVersion !== undefined &&
          previous &&
          previous.version !== expectedVersion &&
          previous.writerId !== localWriterId
        ) {
          const current = await tx.objectStore('sessions').get(sessionId)
          if (current) {
            const copy = createSyncConflictCopy(current)
            await tx.objectStore('sessions').add(copy)
            await summaries.add(storedSummary(copy))
            await sync.add(changedSyncState(copy.id))
          }
        }
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        await sync.put(changedSyncState(sessionId, previous, true))
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  notifyLocalChange()
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

export type AppendedHistory = { summaries: SessionSummary[]; skipped: number }

const checkAppendState = (canWrite: () => boolean) => {
  if (!canWrite()) {
    throw new DOMException('The local workspace changed during history import.', 'AbortError')
  }
}

/** Insert all selected conversations in the current schema after their archive is fully validated. */
export const appendHistory = async (
  sessions: readonly Session[], files: readonly StoredFile[],
  canWrite: () => boolean, skipSession: (id: string) => boolean
): Promise<AppendedHistory> => {
  checkAppendState(canWrite)
  const connection = await getDB()
  checkAppendState(canWrite)
  const tx = connection.transaction(['sessions', 'sessionSummaries', 'files', 'syncState'], 'readwrite')
  const live = tx.objectStore('sessions')
  const summaryStore = tx.objectStore('sessionSummaries')
  const fileStore = tx.objectStore('files')
  const sync = tx.objectStore('syncState')
  const stagedFiles = new Map(files.map((file) => [file.id, file]))
  const fileIds = new Map<string, { id: string; type: string }>()
  const summaries: SessionSummary[] = []
  let skipped = 0
  try {
    for (const session of sessions) {
      checkAppendState(canWrite)
      if (skipSession(session.id) || (await live.getKey(session.id)) !== undefined) {
        skipped++
        continue
      }
      for (const message of session.messages) {
        const references = message.role === 'user'
          ? message.files
          : message.blocks.filter((block) => block.type === 'image')
        for (const file of references) {
          let local = fileIds.get(file.id)
          if (!local) {
            const staged = stagedFiles.get(file.id)
            local = { id: createId(), type: staged?.blob.type ?? '' }
            if (staged) {await fileStore.add({ id: local.id, blob: staged.blob })}
            fileIds.set(file.id, local)
          }
          file.id = local.id
          if (message.role === 'user') {
            file.mimeType = local.type
          }
        }
      }
      checkAppendState(canWrite)
      if (skipSession(session.id)) {
        // An in-memory session appeared while staging this row. Revalidate the selection
        // rather than leave unreferenced files or touch the newly created session.
        throw new DOMException('An existing session changed during history import.', 'AbortError')
      }
      const summary = storedSummary(session)
      await live.add(session)
      await summaryStore.add(summary)
      await sync.put(changedSyncState(session.id, await sync.get(session.id)))
      summaries.push(toSessionSummary(summary))
    }
    checkAppendState(canWrite)
    await tx.done
  } catch (error) {
    abortTransaction(tx)
    await tx.done.catch(() => {})
    throw error
  }
  if (summaries.length) {notifyLocalChange()}
  return { summaries, skipped }
}

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging', 'syncState'],
    'readwrite'
  )
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      const previousIds = to === 'sessions' ? await tx.objectStore('sessions').getAllKeys() : []
      await target.clear()
      if (to === 'sessions') {
        const sync = tx.objectStore('syncState')
        for (const id of previousIds) {
          await sync.put(changedSyncState(id, await sync.get(id), true))
        }
        await tx.objectStore('sessionSummaries').clear()
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const summary = storedSummary(cursor.value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
          const sync = tx.objectStore('syncState')
          await sync.put(changedSyncState(summary.id, await sync.get(summary.id)))
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
  notifyLocalChange()
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

/** Also discovers conversations written by earlier application versions. */
export const prepareSyncRecords = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionSummaries', 'syncState'], 'readwrite')
  for (const id of await tx.objectStore('sessionSummaries').getAllKeys()) {
    if (!(await tx.objectStore('syncState').get(id))) {
      await tx.objectStore('syncState').put(changedSyncState(id))
    }
  }
  await tx.done
}

export const loadSyncStates = async (): Promise<SyncSessionState[]> =>
  (await getDB()).getAll('syncState')

export const loadSyncState = async (id: string): Promise<SyncSessionState | undefined> =>
  (await getDB()).get('syncState', id)

export const loadSyncControl = async (): Promise<SyncControl | undefined> =>
  (await getDB()).get('syncControl', 'control')

export const saveSyncControl = async (
  value: SyncControl,
  guard: () => boolean
): Promise<boolean> => {
  const tx = (await getDB()).transaction('syncControl', 'readwrite')
  const previous = await tx.store.get('control')
  if (!guard() || (previous && previous.generation > value.generation)) {
    await tx.done
    return false
  }
  await tx.store.put({
    ...(previous?.generation === value.generation ? previous : {}),
    ...value,
    cursor:
      previous?.generation === value.generation
        ? Math.max(previous.cursor, value.cursor)
        : value.cursor,
  })
  await tx.done
  return true
}

/** Missing server records after a cloud clear are new local uploads in this generation. */
export const rebaseMissingSyncRecords = async (
  remoteIds: ReadonlySet<string>,
  sequence: number,
  generation: number,
  guard: () => boolean
): Promise<void> => {
  const tx = (await getDB()).transaction(['syncState', 'syncControl'], 'readwrite')
  if (!guard() || (await tx.objectStore('syncControl').get('control'))?.generation !== generation) {
    await tx.done
    return
  }
  for (const state of await tx.objectStore('syncState').getAll()) {
    if (state.revision > 0 && state.revision <= sequence && !remoteIds.has(state.id)) {
      await tx
        .objectStore('syncState')
        .put({ ...state, revision: 0, dirty: !state.deleted, mutationId: createId() })
    }
  }
  if (!guard()) {
    abortTransaction(tx)
  }
  await tx.done
}

export const acknowledgeSync = async (
  id: string,
  uploaded: SyncSessionState,
  revision: number,
  generation: number,
  guard: () => boolean
): Promise<boolean> => {
  const tx = (await getDB()).transaction(['syncState', 'syncControl'], 'readwrite')
  const state = await tx.objectStore('syncState').get(id)
  if (
    !guard() ||
    !state ||
    state.revision !== uploaded.revision ||
    (await tx.objectStore('syncControl').get('control'))?.generation !== generation
  ) {
    await tx.done
    return false
  }
  await tx
    .objectStore('syncState')
    .put({ ...state, revision, dirty: state.version !== uploaded.version })
  if (!guard()) {
    abortTransaction(tx)
  }
  await tx.done
  return true
}

/** Remote state, files and its acknowledged revision become visible together. */
export const applySyncedSession = async (options: {
  id: string
  session: Session | null
  files: StoredFile[]
  revision: number
  generation: number
  expectedVersion: number
  expectedRevision: number
  guard: () => boolean
  conflictCopy?: Session
}): Promise<boolean> => {
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'syncState', 'syncControl'],
    'readwrite'
  )
  try {
    const states = tx.objectStore('syncState')
    const previous = await states.get(options.id)
    if (
      !options.guard() ||
      (previous?.version ?? 0) !== options.expectedVersion ||
      (previous?.revision ?? 0) !== options.expectedRevision ||
      (await tx.objectStore('syncControl').get('control'))?.generation !== options.generation
    ) {
      await tx.done
      return false
    }
    const summaries = tx.objectStore('sessionSummaries')
    const oldSummary = await summaries.get(options.id)
    const copy = options.conflictCopy
    if (copy) {
      await tx.objectStore('sessions').add(copy)
      await summaries.add(storedSummary(copy))
      await states.add(changedSyncState(copy.id))
    }
    for (const file of options.files) {
      await tx.objectStore('files').put(file)
    }
    if (options.session) {
      await tx.objectStore('sessions').put(options.session)
      await summaries.put(storedSummary(options.session))
    } else {
      await tx.objectStore('sessions').delete(options.id)
      await summaries.delete(options.id)
    }
    await states.put({
      id: options.id,
      version: (previous?.version ?? 0) + 1,
      revision: options.revision,
      dirty: false,
      deleted: options.session === null,
      mutationId: createId(),
      writerId: 'remote',
    })
    for (const id of oldSummary?.fileIds ?? []) {
      if ((await summaries.index('fileIds').count(id)) === 0) {
        await tx.objectStore('files').delete(id)
      }
    }
    if (!options.guard()) {
      throw new Error('本机会话已变化，稍后重新同步。')
    }
    await tx.done
    return true
  } catch (error) {
    abortTransaction(tx)
    await tx.done.catch(() => {})
    throw error
  }
}

/** 本地存储失败不打断对话。诊断只保留操作阶段。 */
export const reportStorageError = (action: string, stage: 'read' | 'save') => (error: unknown) => {
  if (!(error instanceof DOMException && error.name === 'AbortError')) {
    recordDiagnostic('chat', 'storage_error', { stage })
  }
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
