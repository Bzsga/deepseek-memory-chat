import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { guestStorageKey, isGuestWorkspace } from '../runtime.js'
import { normalizeSession } from './branches.js'
import { appendSession, type StoredFile } from './db.js'
import { captureConversationSyncGuard, initChat, refreshConversationSyncCache } from './store.js'
import type { Message, Session } from './types.js'

interface GuestChatDB extends DBSchema {
  sessions: { key: string; value: Session }
  files: { key: string; value: StoredFile }
}

const openGuestHistory = async (): Promise<IDBPDatabase<GuestChatDB> | undefined> => {
  let absent = false
  try {
    return await openDB<GuestChatDB>(guestStorageKey('chats'), undefined, {
      upgrade(_db, oldVersion, _newVersion, transaction) {
        if (oldVersion === 0) {
          absent = true
          transaction.abort()
        }
      },
    })
  } catch (error) {
    if (!absent) {throw error}
    return undefined
  }
}

export async function countGuestChats(): Promise<number> {
  const source = await openGuestHistory()
  try {
    return source?.objectStoreNames.contains('sessions') ? await source.count('sessions') : 0
  } finally {
    source?.close()
  }
}

const copySession = async (original: Session) => {
  // API file handles and unfinished requests belong to the guest workspace.
  const messages = original.messages.map((message): Message => {
    if (message.role === 'user') {
      return { ...message, files: message.files.map(file => ({ ...file, serverId: null, serverScope: undefined })) }
    }
    const interrupted = message.status === 'pending' || message.status === 'streaming'
    return {
      ...message,
      imageJob: undefined,
      prefix: false,
      status: interrupted ? 'stopped' : message.status,
    }
  })
  const longMemory = original.longMemory
  const portable = {
    ...original,
    nativeHandoffId: undefined,
    messages,
    ...(longMemory ? { longMemory: {
      ...longMemory,
      segments: longMemory.segments.map(segment => segment.status === 'started'
        ? { ...segment, status: 'interrupted' as const }
        : segment),
    } } : {}),
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(portable)))
  const id = 'guest-copy-' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  const fileIds = new Map<string, string>()
  const copyFileId = (sourceId: string) => {
    const mapped = fileIds.get(sourceId) ?? `${id}-file-${fileIds.size}`
    fileIds.set(sourceId, mapped)
    return mapped
  }
  const session = normalizeSession({
    ...portable,
    id,
    messages: messages.map(message => message.role === 'user'
      ? { ...message, files: message.files.map(file => ({ ...file, id: copyFileId(file.id) })) }
      : {
          ...message,
          blocks: message.blocks.map(block => block.type === 'image' ? { ...block, id: copyFileId(block.id) } : block),
        }),
  })
  return { session, fileIds }
}

/** Copies only after confirmation. Stable IDs make retries safe and leave existing account edits intact. */
export async function copyGuestChats(live: () => boolean): Promise<number> {
  if (isGuestWorkspace()) {throw new Error('请先登录。')}
  await initChat()
  const workspace = captureConversationSyncGuard()
  const canWrite = () => live() && workspace()
  if (!canWrite()) {throw new Error('工作区已变化，请重试。')}
  const source = await openGuestHistory()
  let copied = 0
  try {
    if (!source?.objectStoreNames.contains('sessions')) {return 0}
    for (const key of await source.getAllKeys('sessions')) {
      if (!canWrite()) {throw new Error('工作区已变化，请重试。')}
      const original = await source.get('sessions', key)
      if (!original) {continue}
      const { session, fileIds } = await copySession(original)
      const files: StoredFile[] = []
      if (fileIds.size && source.objectStoreNames.contains('files')) {
        const tx = source.transaction('files')
        const records = await Promise.all([...fileIds].map(async ([id, newId]) => ({
          record: await tx.store.get(id),
          newId,
        })))
        await tx.done
        for (const { record, newId } of records) {
          if (record) {files.push({ id: newId, blob: record.blob })}
        }
      }
      const saved = await appendSession(session, canWrite, files)
      if (saved === session) {copied++}
    }
    return copied
  } finally {
    source?.close()
    if (canWrite()) {await refreshConversationSyncCache()}
  }
}
