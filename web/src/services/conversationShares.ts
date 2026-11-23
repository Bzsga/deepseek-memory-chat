import { createId } from '../utils/id.js'
import { cloneSnapshot } from '../utils/cloneSnapshot.js'
import { API_ORIGIN, getRuntime, isSessionActive } from './runtime.js'
import { validateSharedJsonStructure } from './sharedConversation.js'
import { getVisibleMessages } from './chat/branches.js'
import { getCachedGeneratedImage } from './chat/imageGeneration.js'
import { getReplyText } from './chat/reply.js'
import type { StoredFile } from './chat/db.js'
import type { Message, Session } from './chat/types.js'

const SITE = 'https://digimonlegend.com'
const BASE = `${API_ORIGIN}/api/conversation-shares`
const MAX_TEXT = 8 * 1024 * 1024
const MAX_BODY = 64 * 1024 * 1024
const MAX_SNAPSHOT = 16 * 1024 * 1024
const MAX_IMAGE = 12 * 1024 * 1024
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/
const IMAGE_ID = /^[A-Za-z0-9_-]{1,128}$/
const encoder = new TextEncoder()
// Keep public metadata reads independent of account-scoped settings/storage.
const request = async (url: string, init: RequestInit) =>
  (await import('./api/client.js')).request(url, init)
const FAIL = '分享内容格式无效，请重新打开分享链接。'
const LIMIT = '所选内容超过分享上限，请减少消息或图片后重试。'

export type ConversationShareFile = { name: string; size: number; mime_type: string }
export type ConversationShareMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: number
  image_ids: string[]
  files: ConversationShareFile[]
}
export type ConversationShareMetadata = {
  id: string
  url: string
  title: string
  conversation_id: string
  message_count: number
  image_count: number
  created_at: number
  revoked: boolean
}
export type PublicConversationShareImage = {
  id: string
  name: string
  mime_type: string
  size: number
  url: string
}
export type PublicConversationShare = {
  schema_version: 1
  id: string
  title: string
  created_at: number
  messages: ConversationShareMessage[]
  images: PublicConversationShareImage[]
}
export type AppConversationSharePreview = {
  snapshot: PublicConversationShare
  rawSnapshot: string
  sourceUrl: string
  sessionId: string
}

const fail = (message = FAIL): never => {
  throw new Error(message)
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length <= maximum && !/[\uD800-\uDFFF]/u.test(value)
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0
const timestamp = (value: unknown): value is number => count(value) && value <= 8640000000000000
const account = (expected: string) => {
  if (!isSessionActive() || getRuntime().user.id !== expected) {
    fail('账号已变化，请重新打开分享。')
  }
}
const publicUrl = (id: string) => `${SITE}/deepseek/share/${id}`
const imageUrl = (shareId: string, imageId: string) => `${BASE}/${shareId}/images/${imageId}`

/** Accept only the application's canonical public origin/path; never fetch arbitrary links. */
export const parseAppConversationShareLink = (
  input: string
): { shareId: string; url: string } | undefined => {
  if (input.length > 8192) {
    fail('分享文案最多 8192 字，请只保留一个链接。')
  }
  const candidates = input.match(/https?:\/\/[^\s<>"'`]+/gi) ?? []
  const own = candidates.filter((candidate) => /digimonlegend\.com/i.test(candidate))
  if (!own.length) {
    return undefined
  }
  if (candidates.length !== 1) {
    fail('一次只能读取一个分享链接。')
  }
  const candidate = own[0].replace(
    /[\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u3001\uff09\u3011\u300b\u300d\u300f.,;:!?)\]}]+$/u,
    ''
  )
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return fail()
  }
  const match = /^\/deepseek\/share\/([A-Za-z0-9_-]{32,128})$/.exec(url.pathname)
  if (
    url.origin !== SITE ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    candidate.includes('\\') ||
    !match ||
    candidate !== publicUrl(match[1])
  ) {
    return fail('请使用本应用完整的 HTTPS 会话分享链接。')
  }
  return { shareId: match[1], url: publicUrl(match[1]) }
}

const selectedMessages = (session: Session, selectedIds: readonly string[]): Message[] => {
  const selected = new Set(selectedIds)
  if (!selected.size || selected.size !== selectedIds.length) {
    fail('请选择要分享的消息，每条消息只能选择一次。')
  }
  const messages = getVisibleMessages(session).filter((message) => selected.has(message.id))
  if (messages.length !== selected.size) {
    fail('所选消息已不在当前分支，请重新选择分享范围。')
  }
  if (
    messages.some(
      (message) =>
        message.role === 'assistant' &&
        (message.status === 'pending' || message.status === 'streaming')
    )
  ) {
    fail('请先等待当前回复结束，再创建分享。')
  }
  return messages
}
const localImages = (message: Message) =>
  message.role === 'user'
    ? message.files
        .filter((file) => file.isImage)
        .map((file) => ({ id: file.id, name: file.name, mime: file.mimeType }))
    : message.blocks.flatMap((block) =>
        block.type === 'image' ? [{ id: block.id, name: block.name, mime: block.mimeType }] : []
      )

export const summarizeConversationShare = (
  session: Session,
  selectedIds: readonly string[]
): { messageCount: number; imageCount: number; fileCount: number } => {
  const messages = selectedMessages(session, selectedIds)
  return {
    messageCount: messages.length,
    imageCount: new Set(
      messages.flatMap((message) => localImages(message).map((image) => image.id))
    ).size,
    fileCount: messages.reduce(
      (total, message) => total + (message.role === 'user' ? message.files.length : 0),
      0
    ),
  }
}

const mimeFromBytes = (bytes: Uint8Array): string | undefined => {
  const at = (offset: number, values: number[]) =>
    values.every((value, index) => bytes[offset + index] === value)
  if (bytes.length >= 24 && at(0, [137, 80, 78, 71, 13, 10, 26, 10]) && at(12, [73, 72, 68, 82])) {
    return 'image/png'
  }
  if (bytes.length >= 4 && at(0, [255, 216, 255])) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 13 &&
    at(0, [71, 73, 70, 56]) &&
    [55, 57].includes(bytes[4]) &&
    bytes[5] === 97
  ) {
    return 'image/gif'
  }
  if (
    bytes.length >= 16 &&
    at(0, [82, 73, 70, 70]) &&
    at(8, [87, 69, 66, 80]) &&
    [32, 76, 88].includes(bytes[15]) &&
    at(12, [86, 80, 56])
  ) {
    return 'image/webp'
  }
  return undefined
}
export const validateConversationShareImage = async (
  blob: Blob,
  declaredMime: string
): Promise<void> => {
  if (!blob.size || blob.size > MAX_IMAGE) {
    fail('分享图片为空或超过 12 MiB，请调整图片后重试。')
  }
  if (mimeFromBytes(new Uint8Array(await blob.slice(0, 32).arrayBuffer())) !== declaredMime) {
    fail('分享图片类型与原件不符，请重新选择图片。')
  }
  if (typeof createImageBitmap === 'function') {
    try {
      ;(await createImageBitmap(blob)).close()
    } catch {
      fail('分享图片无法解码，请重新选择图片。')
    }
  }
}
const base64 = (bytes: Uint8Array) => {
  const pieces: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)))
  }
  return btoa(pieces.join(''))
}
const metadata = (value: unknown): ConversationShareMetadata => {
  if (
    !object(value) ||
    !text(value.id, 128) ||
    !TOKEN.test(value.id) ||
    value.url !== publicUrl(value.id) ||
    !text(value.title, 200) ||
    !text(value.conversation_id, 256) ||
    !count(value.message_count) ||
    !count(value.image_count) ||
    !timestamp(value.created_at) ||
    typeof value.revoked !== 'boolean'
  ) {
    return fail()
  }
  return {
    id: value.id,
    url: value.url,
    title: value.title,
    conversation_id: value.conversation_id,
    message_count: value.message_count,
    image_count: value.image_count,
    created_at: value.created_at,
    revoked: value.revoked,
  }
}
const creationIds = new Map<string, { requestId: string; imageIds: Map<string, string> }>()
const creating = new Map<string, Promise<ConversationShareMetadata>>()

/** Build only the selected visible originals. No derived context, thoughts, actions or API file IDs. */
export const createConversationShare = (
  sessionId: string,
  selectedIds: readonly string[],
  signal?: AbortSignal
): Promise<ConversationShareMetadata> => {
  const owner = getRuntime().user.id
  account(owner)
  const key = JSON.stringify([owner, sessionId, [...selectedIds].sort()])
  const previous = creating.get(key)
  if (previous) {
    return previous
  }
  const task = (async () => {
    const [store, db] = await Promise.all([import('./chat/store.js'), import('./chat/db.js')])
    const guard = store.captureConversationDataGuard(owner, sessionId)
    const state = store.useChatStore.getState()
    const original = state.sessionCache[sessionId]
    if (!original || state.streaming[sessionId] || !guard()) {
      fail('请打开会话并等待当前回复结束，再创建分享。')
    }
    const originalMessages = selectedMessages(original, selectedIds)
    const chosen = await cloneSnapshot(originalMessages)
    const current = () => {
      account(owner)
      signal?.throwIfAborted()
      const live = store.useChatStore.getState()
      if (!guard() || live.streaming[sessionId] || !live.sessionCache[sessionId]) {
        fail('会话或分享范围已变化，请重新选择。')
      }
      const selected = selectedMessages(live.sessionCache[sessionId], selectedIds)
      if (selected.some((message, index) => message !== originalMessages[index])) {
        fail('会话或分享范围已变化，请重新选择。')
      }
    }
    const imageMap = new Map<string, string>()
    const images: { id: string; name: string; mime_type: string; b64_json: string }[] = []
    const messages: ConversationShareMessage[] = []
    let imageBytes = 0
    for (const message of chosen) {
      current()
      const imageIds: string[] = []
      for (const image of localImages(message)) {
        let id = imageMap.get(image.id)
        if (!id) {
          const originalBlob = getCachedGeneratedImage(image.id) ?? (await db.loadFile(image.id))
          current()
          const blob =
            originalBlob ??
            fail(`图片“${image.name}”的原件不在本机，请重新上传或取消选择这条消息。`)
          const mime = image.mime || blob.type
          await validateConversationShareImage(blob, mime)
          imageBytes += Math.ceil(blob.size / 3) * 4
          if (imageBytes > MAX_BODY) {
            fail(LIMIT)
          }
          // Local IDs are only an internal fingerprint input. The public payload
          // receives stable random transfer IDs below, including explicit retries.
          id = image.id
          images.push({
            id,
            name: image.name,
            mime_type: mime,
            b64_json: base64(new Uint8Array(await blob.arrayBuffer())),
          })
          imageMap.set(image.id, id)
        }
        if (!imageIds.includes(id)) {
          imageIds.push(id)
        }
      }
      messages.push({
        id: message.id,
        role: message.role,
        content: message.role === 'user' ? message.content : getReplyText(message),
        created_at: message.createdAt,
        image_ids: imageIds,
        files:
          message.role === 'user'
            ? message.files
                .filter((file) => !file.isImage)
                .map((file) => ({ name: file.name, size: file.size, mime_type: file.mimeType }))
            : [],
      })
    }
    const title = original.title.slice(0, 200)
    if (encoder.encode(JSON.stringify({ title, messages })).byteLength > MAX_TEXT) {
      fail(LIMIT)
    }
    const content = JSON.stringify({ conversation_id: sessionId, title, messages, images })
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(content))),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('')
    const attempt = `${owner}:${digest}`
    const stable = creationIds.get(attempt) ?? {
      requestId: createId(),
      imageIds: new Map(images.map((image) => [image.id, createId()])),
    }
    creationIds.set(attempt, stable)
    if (creationIds.size > 32) {
      const oldest = creationIds.keys().next().value
      if (oldest !== undefined) {
        creationIds.delete(oldest)
      }
    }
    const body = JSON.stringify({
      client_request_id: stable.requestId,
      conversation_id: sessionId,
      title,
      messages: messages.map((message) => ({
        ...message,
        image_ids: message.image_ids.map((id) => stable.imageIds.get(id) ?? fail()),
      })),
      images: images.map((image) => ({ ...image, id: stable.imageIds.get(image.id) ?? fail() })),
    })
    if (encoder.encode(body).byteLength > MAX_BODY) {
      fail(LIMIT)
    }
    current()
    const response = await request(BASE, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    account(owner)
    return metadata(await response.json())
  })().finally(() => creating.delete(key))
  creating.set(key, task)
  return task
}

export const listConversationShares = async (
  conversationId?: string,
  signal?: AbortSignal
): Promise<ConversationShareMetadata[]> => {
  const owner = getRuntime().user.id
  account(owner)
  const response = await request(
    BASE +
      (conversationId === undefined
        ? ''
        : `?conversation_id=${encodeURIComponent(conversationId)}`),
    { method: 'GET', signal, cache: 'no-store' }
  )
  const body: unknown = await response.json()
  account(owner)
  if (!object(body) || !Array.isArray(body.shares)) {
    return fail()
  }
  return body.shares.map(metadata)
}
export const revokeConversationShare = async (id: string, signal?: AbortSignal): Promise<void> => {
  if (!TOKEN.test(id)) {
    fail()
  }
  const owner = getRuntime().user.id
  account(owner)
  const response = await request(`${BASE}/${id}`, { method: 'DELETE', signal })
  const body: unknown = await response.json()
  account(owner)
  if (!object(body) || body.revoked !== true) {
    fail()
  }
}

const boundedRead = async (
  response: Response,
  maximum: number,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> => {
  if (!response.ok) {
    fail(response.status === 404 ? '分享不存在或已撤销。' : '暂时无法读取分享，请稍后重试。')
  }
  if (!response.body) {
    return fail()
  }
  const reader = response.body.getReader()
  const pieces: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > maximum) {
        fail(LIMIT)
      }
      pieces.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const piece of pieces) {
    result.set(piece, offset)
    offset += piece.byteLength
  }
  return result
}
const publicFetch = (url: string, signal?: AbortSignal) =>
  fetch(url, {
    method: 'GET',
    signal,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  })

/** Strict public DTO: the retained raw snapshot cannot smuggle private/base64 fields. */
export const parsePublicConversationShare = (
  raw: string,
  shareId: string
): PublicConversationShare => {
  if (!TOKEN.test(shareId) || encoder.encode(raw).byteLength > MAX_SNAPSHOT) {
    return fail()
  }
  let value: unknown
  try {
    validateSharedJsonStructure(raw)
    value = JSON.parse(raw)
  } catch {
    return fail()
  }
  if (
    !object(value) ||
    !exact(value, ['schema_version', 'id', 'title', 'created_at', 'messages', 'images']) ||
    value.schema_version !== 1 ||
    value.id !== shareId ||
    !text(value.title, 200) ||
    !timestamp(value.created_at) ||
    !Array.isArray(value.messages) ||
    !value.messages.length ||
    value.messages.length > 50000 ||
    !Array.isArray(value.images)
  ) {
    return fail()
  }
  const imageIds = new Set<string>()
  for (const item of value.images) {
    if (
      !object(item) ||
      !exact(item, ['id', 'name', 'mime_type', 'size', 'url']) ||
      !text(item.id, 128) ||
      !IMAGE_ID.test(item.id) ||
      imageIds.has(item.id) ||
      !text(item.name, 4096) ||
      !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(item.mime_type as string) ||
      !count(item.size) ||
      !item.size ||
      item.size > MAX_IMAGE ||
      item.url !== imageUrl(shareId, item.id)
    ) {
      return fail()
    }
    imageIds.add(item.id)
  }
  const messageIds = new Set<string>()
  const referenced = new Set<string>()
  for (const item of value.messages) {
    if (
      !object(item) ||
      !exact(item, ['id', 'role', 'content', 'created_at', 'image_ids', 'files']) ||
      !text(item.id, 256) ||
      !item.id ||
      messageIds.has(item.id) ||
      !['user', 'assistant'].includes(item.role as string) ||
      !text(item.content, MAX_TEXT) ||
      !timestamp(item.created_at) ||
      !Array.isArray(item.image_ids) ||
      new Set(item.image_ids).size !== item.image_ids.length ||
      !Array.isArray(item.files)
    ) {
      return fail()
    }
    messageIds.add(item.id)
    for (const id of item.image_ids) {
      if (typeof id !== 'string' || !imageIds.has(id)) {
        return fail()
      }
      referenced.add(id)
    }
    for (const file of item.files) {
      if (
        !object(file) ||
        !exact(file, ['name', 'size', 'mime_type']) ||
        !text(file.name, 4096) ||
        !count(file.size) ||
        !text(file.mime_type, 256)
      ) {
        return fail()
      }
    }
  }
  if (
    referenced.size !== imageIds.size ||
    encoder.encode(JSON.stringify({ title: value.title, messages: value.messages })).byteLength >
      MAX_TEXT
  ) {
    return fail()
  }
  return value as unknown as PublicConversationShare
}

/** Public preview reads neither account storage nor image bodies. */
export const readAppConversationShare = async (
  input: string,
  signal?: AbortSignal
): Promise<AppConversationSharePreview> => {
  const link = parseAppConversationShareLink(input)
  if (!link) {
    return fail('未找到本应用的分享链接。')
  }
  const bytes = await boundedRead(
    await publicFetch(`${BASE}/${link.shareId}`, signal),
    MAX_SNAPSHOT,
    signal
  )
  let rawSnapshot: string
  try {
    rawSnapshot = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return fail()
  }
  return {
    snapshot: parsePublicConversationShare(rawSnapshot, link.shareId),
    rawSnapshot,
    sourceUrl: link.url,
    sessionId: createId(),
  }
}

/** Called only after explicit confirmation. Originals and files are appended in one guarded transaction. */
export const importAppConversationShare = async (
  preview: AppConversationSharePreview,
  expectedAccountId: string,
  signal?: AbortSignal
): Promise<string> => {
  account(expectedAccountId)
  const store = await import('./chat/store.js')
  const guard = store.captureConversationDataGuard(expectedAccountId)
  const current = () => {
    account(expectedAccountId)
    signal?.throwIfAborted()
    if (!guard()) {
      fail('本地资料已变化，请重新读取分享。')
    }
  }
  const snapshot = parsePublicConversationShare(preview.rawSnapshot, preview.snapshot.id)
  const files: StoredFile[] = []
  const localImages = new Map<string, { id: string; image: PublicConversationShareImage }>()
  let size = 0
  for (const image of snapshot.images) {
    current()
    const bytes = await boundedRead(await publicFetch(image.url, signal), MAX_IMAGE, signal)
    current()
    size += bytes.byteLength
    if (size > MAX_BODY || bytes.byteLength !== image.size) {
      fail('分享图片大小不符或总量超过 64 MiB，请重新读取分享。')
    }
    const blob = new Blob([bytes], { type: image.mime_type })
    await validateConversationShareImage(blob, image.mime_type)
    const id = createId()
    files.push({ id, blob })
    localImages.set(image.id, { id, image })
  }
  const importedAt = Date.now()
  const messages: Message[] = snapshot.messages.map((message, index) => {
    const base = {
      id: message.id,
      createdAt: message.created_at,
      parentId: snapshot.messages[index - 1]?.id ?? null,
      selectedChildId: snapshot.messages[index + 1]?.id,
    }
    if (message.role === 'user') {
      return {
        ...base,
        role: 'user',
        content: message.content,
        files: [
          ...message.files.map((file) => ({
            id: createId(),
            serverId: null,
            name: file.name,
            size: file.size,
            mimeType: file.mime_type,
            isImage: false,
          })),
          ...message.image_ids.map((id) => {
            const item = localImages.get(id) ?? fail()
            return {
              id: item.id,
              serverId: null,
              name: item.image.name,
              size: item.image.size,
              mimeType: item.image.mime_type,
              isImage: true,
            }
          }),
        ],
      }
    }
    return {
      ...base,
      role: 'assistant',
      model: null,
      prefix: false,
      status: 'done',
      blocks: [
        { type: 'text', text: message.content },
        ...message.image_ids.map((id) => {
          const item = localImages.get(id) ?? fail()
          return {
            type: 'image' as const,
            id: item.id,
            name: item.image.name,
            mimeType: item.image.mime_type,
            prompt: '',
          }
        }),
      ],
    }
  })
  const session: Session = {
    id: preview.sessionId,
    title: snapshot.title,
    createdAt: importedAt,
    updatedAt: importedAt,
    messages,
    rootMessageId: messages[0]?.id ?? null,
    sharedSource: {
      kind: 'app-share',
      shareId: snapshot.id,
      url: preview.sourceUrl,
      scope: 'shared_snapshot',
      importedAt,
      rawSnapshot: preview.rawSnapshot,
      messageIds: messages.map((message) => message.id),
    },
  }
  current()
  return store.appendImportedSession(session, expectedAccountId, files, guard)
}
