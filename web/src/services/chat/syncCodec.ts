import type { TranslationMessage } from '../../i18n/index.js'
import type { ChatModel, ServerToolBlock, ServerToolInput, TextCitation } from '../api/types.js'
import { validateSharedJsonStructure } from '../sharedConversation.js'
import { normalizeSession } from './branches.js'
import { validateConversationMemory } from './contextMemory.js'
import { validateContinuationPayload } from './continuity.js'
import { validateImageActionTrace } from './imageAction.js'
import { validateSharedSource } from './sharedSource.js'
import type { AssistantMessage, FileAttachment, Message, ReplyBlock, Session } from './types.js'

export const MAX_SYNC_SNAPSHOT_BYTES = 32 * 1024 * 1024
export type SyncSnapshot = { version: 1; session: Session }

type JsonObject = Record<string, unknown>
const encoder = new TextEncoder()
const invalid = (): never => {
  throw new Error('云端会话资料格式无效，请保留本机资料后重试。')
}
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : invalid()
const text = (value: unknown, maximum = MAX_SYNC_SNAPSHOT_BYTES): string =>
  typeof value === 'string' && value.length <= maximum && !/[\uD800-\uDFFF]/u.test(value)
    ? value
    : invalid()
const id = (value: unknown): string => {
  const result = text(value, 256)
  return result && !/[/\\\p{Cc}]/u.test(result) ? result : invalid()
}
const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid()
const count = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : invalid()
const boolean = (value: unknown): boolean => (typeof value === 'boolean' ? value : invalid())
const list = <T>(value: unknown, read: (item: unknown) => T): T[] =>
  Array.isArray(value) && value.length <= 250000 ? value.map(read) : invalid()
const nullableText = (value: unknown): string | null => (value === null ? null : text(value))
const oneOf = <const T extends string>(value: unknown, allowed: readonly T[]): T =>
  typeof value === 'string' && allowed.includes(value as T) ? (value as T) : invalid()
const webUrl = (value: unknown, empty = false): string => {
  const result = text(value)
  if (empty && result === '') {
    return result
  }
  try {
    const url = new URL(result)
    return ['http:', 'https:'].includes(url.protocol) ? result : invalid()
  } catch {
    return invalid()
  }
}
const nullableUrl = (value: unknown): string | null => (value === null ? null : webUrl(value, true))

const citation = (value: unknown): TextCitation => {
  const item = object(value)
  if (item.type !== 'web_search_result_location') {
    return invalid()
  }
  return {
    type: item.type,
    url: webUrl(item.url),
    title: nullableText(item.title),
    cited_text: text(item.cited_text),
    encrypted_index: text(item.encrypted_index),
  }
}

const toolInput = (value: unknown): ServerToolInput => {
  const input = object(value)
  switch (input.action) {
    case 'search':
      return {
        action: input.action,
        queries: list(input.queries, (query) => text(query)),
        ...(input.query !== undefined ? { query: text(input.query) } : {}),
      }
    case 'open_page':
    case 'read_link':
      return { action: input.action, url: webUrl(input.url) }
    case 'find_in_page':
      return { action: input.action, url: webUrl(input.url, true), pattern: text(input.pattern) }
    default:
      return invalid()
  }
}

const toolBlock = (item: JsonObject): ServerToolBlock => {
  switch (item.type) {
    case 'server_tool_use': {
      if (object(item.caller).type !== 'direct') {
        return invalid()
      }
      return {
        type: item.type,
        id: id(item.id),
        name: oneOf(item.name, ['deepseek_web_search', 'deepseek_read_url']),
        kind: oneOf(item.kind, [
          'search',
          'deep_search',
          'read_link',
          'image_search',
          'deep_image_search',
        ]),
        caller: { type: 'direct' },
        input: toolInput(item.input),
      }
    }
    case 'web_search_tool_result':
      return {
        type: item.type,
        tool_use_id: id(item.tool_use_id),
        kind: oneOf(item.kind, ['search', 'deep_search', 'image_search', 'deep_image_search']),
        content: list(item.content, (value) => {
          const result = object(value)
          if (result.type === 'web_search_tool_result_error') {
            return { type: result.type, error_code: oneOf(result.error_code, ['unavailable']) }
          }
          if (result.type !== 'web_search_result') {
            return invalid()
          }
          return {
            type: result.type,
            title: text(result.title),
            url: webUrl(result.url),
            ...(result.image_url !== undefined ? { image_url: webUrl(result.image_url) } : {}),
            snippet: text(result.snippet),
            site_icon: nullableUrl(result.site_icon),
            site_name: nullableText(result.site_name),
            encrypted_content: text(result.encrypted_content),
            page_age: nullableText(result.page_age),
          }
        }),
      }
    case 'web_fetch_tool_result': {
      const content = object(item.content)
      const base = {
        type: item.type,
        tool_use_id: id(item.tool_use_id),
        kind: oneOf(item.kind, ['read_link', 'deep_search']),
        ...(item.signature !== undefined ? { signature: text(item.signature) } : {}),
      }
      if (content.type === 'web_fetch_tool_result_error') {
        return {
          ...base,
          content: {
            type: content.type,
            error_code: oneOf(content.error_code, [
              'url_not_accessible',
              'url_not_allowed',
              'unavailable',
            ]),
          },
        }
      }
      const document = object(content.content)
      const source = object(document.source)
      if (
        content.type !== 'web_fetch_result' ||
        document.type !== 'document' ||
        source.type !== 'text' ||
        source.media_type !== 'text/plain'
      ) {
        return invalid()
      }
      return {
        ...base,
        content: {
          type: content.type,
          url: webUrl(content.url, true),
          content: {
            type: document.type,
            title: nullableText(document.title),
            source: { type: source.type, media_type: source.media_type, data: text(source.data) },
          },
          published_at: nullableText(content.published_at),
        },
      }
    }
    default:
      return invalid()
  }
}

const block = (value: unknown): ReplyBlock => {
  const item = object(value)
  switch (item.type) {
    case 'text':
      return {
        type: item.type,
        text: text(item.text),
        ...(item.citations !== undefined ? { citations: list(item.citations, citation) } : {}),
        ...(item.isTemplate !== undefined ? { isTemplate: boolean(item.isTemplate) } : {}),
      }
    case 'thinking':
      return {
        type: item.type,
        thinking: text(item.thinking),
        ...(item.signature !== undefined ? { signature: text(item.signature) } : {}),
        ...(item.startedAt !== undefined ? { startedAt: number(item.startedAt) } : {}),
        ...(item.endedAt !== undefined ? { endedAt: number(item.endedAt) } : {}),
        ...(item.elapsedSeconds !== undefined
          ? { elapsedSeconds: number(item.elapsedSeconds) }
          : {}),
      }
    case 'image':
      return {
        type: item.type,
        id: id(item.id),
        name: text(item.name, 4096),
        mimeType: text(item.mimeType, 256),
        prompt: text(item.prompt),
      }
    default:
      return toolBlock(item)
  }
}

const attachment = (value: unknown): FileAttachment => {
  const item = object(value)
  return {
    id: id(item.id),
    serverId: null,
    name: text(item.name, 4096),
    size: count(item.size),
    isImage: boolean(item.isImage),
    mimeType: text(item.mimeType, 256),
  }
}

const localMessage = (value: unknown): TranslationMessage => {
  const item = object(value)
  const key = text(item.key, 256) as TranslationMessage['key']
  if (item.params === undefined) {
    return { key }
  }
  const params = Object.fromEntries(
    Object.entries(object(item.params)).map(([name, value]) => [
      text(name, 256),
      typeof value === 'number' ? number(value) : text(value),
    ])
  )
  return { key, params }
}

const reply = (
  item: JsonObject
): Omit<AssistantMessage, 'id' | 'createdAt' | 'parentId' | 'selectedChildId'> => {
  const status = oneOf(item.status, ['done', 'stopped', 'error'])
  const result: Omit<AssistantMessage, 'id' | 'createdAt' | 'parentId' | 'selectedChildId'> = {
    role: 'assistant',
    model: item.model === null ? null : (text(item.model, 128) as ChatModel),
    prefix: boolean(item.prefix),
    status,
    blocks: list(item.blocks, block),
    ...(item.thinking !== undefined ? { thinking: boolean(item.thinking) } : {}),
    ...(item.search !== undefined ? { search: boolean(item.search) } : {}),
    ...(item.latestReminder !== undefined ? { latestReminder: text(item.latestReminder) } : {}),
    ...(item.imagePrompt !== undefined ? { imagePrompt: text(item.imagePrompt) } : {}),
    ...(item.imageGeneration !== undefined
      ? { imageGeneration: boolean(item.imageGeneration) }
      : {}),
    ...(item.imageOrigin !== undefined ? { imageOrigin: oneOf(item.imageOrigin, ['chat']) } : {}),
    ...(item.imageModel !== undefined ? { imageModel: text(item.imageModel, 256) } : {}),
    ...(item.imageAction !== undefined
      ? { imageAction: validateImageActionTrace(item.imageAction) }
      : {}),
    ...(item.stopReason !== undefined
      ? { stopReason: oneOf(item.stopReason, ['end_turn', 'max_tokens', 'tool_use', 'refusal']) }
      : {}),
  }
  if (item.stopDetails !== undefined) {
    const details = object(item.stopDetails)
    if (details.type !== 'refusal' || details.category !== null || details.explanation !== null) {
      return invalid()
    }
    result.stopDetails = { type: details.type, category: null, explanation: null }
  }
  if (item.usage !== undefined) {
    const usage = object(item.usage)
    result.usage = {
      input_tokens: count(usage.input_tokens),
      cache_creation_input_tokens: count(usage.cache_creation_input_tokens),
      cache_read_input_tokens: count(usage.cache_read_input_tokens),
      output_tokens: count(usage.output_tokens),
      ...(usage.server_tool_use !== undefined
        ? {
            server_tool_use: {
              web_search_requests: count(object(usage.server_tool_use).web_search_requests),
              tool_search: count(object(usage.server_tool_use).tool_search),
            },
          }
        : {}),
    }
  }
  if (item.error !== undefined) {
    const error = object(item.error)
    result.error = {
      kind: oneOf(error.kind, ['http', 'stream', 'network', 'interrupted', 'protocol', 'upload']),
      message: text(error.message),
      ...(error.status !== undefined ? { status: count(error.status) } : {}),
      ...(error.retryable !== undefined ? { retryable: boolean(error.retryable) } : {}),
      ...(error.localMessage !== undefined
        ? { localMessage: localMessage(error.localMessage) }
        : {}),
    }
  }
  return result
}

const message = (value: unknown): Message => {
  const item = object(value)
  const base = {
    id: id(item.id),
    createdAt: number(item.createdAt),
    ...(item.parentId !== undefined
      ? { parentId: item.parentId === null ? null : id(item.parentId) }
      : {}),
    ...(item.selectedChildId !== undefined ? { selectedChildId: id(item.selectedChildId) } : {}),
  }
  if (item.role === 'user') {
    return {
      ...base,
      role: item.role,
      content: text(item.content),
      files: list(item.files, attachment),
    }
  }
  if (item.role !== 'assistant') {
    return invalid()
  }
  return { ...base, ...reply(item) }
}

const readSession = (value: unknown, expectedId: string): Session => {
  const item = object(value)
  if (id(item.id) !== expectedId) {
    return invalid()
  }
  const session = normalizeSession({
    id: expectedId,
    title: text(item.title, 4096),
    createdAt: number(item.createdAt),
    updatedAt: number(item.updatedAt),
    messages: list(item.messages, message),
    ...(item.rootMessageId !== undefined
      ? { rootMessageId: item.rootMessageId === null ? null : id(item.rootMessageId) }
      : {}),
    ...(item.continuity !== undefined
      ? { continuity: validateContinuationPayload(item.continuity) }
      : {}),
    ...(item.sharedSource !== undefined
      ? { sharedSource: validateSharedSource(item.sharedSource) }
      : {}),
    ...(item.longMemory !== undefined
      ? { longMemory: validateConversationMemory(item.longMemory) }
      : {}),
    ...(item.nativeHandoffId !== undefined ? { nativeHandoffId: id(item.nativeHandoffId) } : {}),
  })
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  if (
    byId.size !== session.messages.length ||
    (session.rootMessageId !== null && !byId.has(session.rootMessageId ?? ''))
  ) {
    return invalid()
  }
  // Local branch operations append children after their parents. Validate every branch,
  // including hidden branches, so stale pointers and cycles cannot reach the chat store.
  const preceding = new Set<string>()
  for (const message of session.messages) {
    if (message.parentId !== null && !preceding.has(message.parentId ?? '')) {
      return invalid()
    }
    if (
      message.selectedChildId !== undefined &&
      byId.get(message.selectedChildId)?.parentId !== message.id
    ) {
      return invalid()
    }
    preceding.add(message.id)
  }
  if (session.rootMessageId && byId.get(session.rootMessageId)?.parentId !== null) {
    return invalid()
  }
  return session
}

/** Synchronization keeps stable IDs and raw text; model dispatch state stays on its originating device. */
export const encodeSyncSnapshot = (session: Session): SyncSnapshot => {
  for (const message of session.messages) {
    if (
      message.role === 'assistant' &&
      (message.status === 'pending' ||
        message.status === 'streaming' ||
        (message.imageJob &&
          !['completed', 'failed', 'cancelled', 'unknown', 'expired'].includes(
            message.imageJob.state
          )) ||
        (message.imageJob?.state === 'completed' &&
          !message.blocks.some((block) => block.type === 'image')))
    ) {
      throw new Error('当前会话仍在生成，完成后会自动同步。')
    }
  }
  return decodeAndWrap({ version: 1, session }, session.id)
}

const decodeAndWrap = (value: unknown, expectedId: string): SyncSnapshot => {
  const raw = JSON.stringify(value)
  if (encoder.encode(raw).byteLength > MAX_SYNC_SNAPSHOT_BYTES) {
    throw new Error('会话超过 32 MiB 同步上限，请先导出备份。')
  }
  validateSharedJsonStructure(raw)
  const snapshot = object(JSON.parse(raw))
  if (snapshot.version !== 1) {
    return invalid()
  }
  return { version: 1, session: readSession(snapshot.session, expectedId) }
}

export const decodeSyncSnapshot = (value: unknown, expectedId: string): Session =>
  decodeAndWrap(value, expectedId).session

/** Every original referenced by any branch is eligible for private attachment synchronization. */
export const referencedSyncFiles = (session: Session): { id: string; mimeType: string }[] => {
  const files = new Map<string, { id: string; mimeType: string }>()
  for (const message of session.messages) {
    const entries =
      message.role === 'user'
        ? message.files
        : message.blocks.flatMap((block) => (block.type === 'image' ? [block] : []))
    for (const file of entries) {
      const previous = files.get(file.id)
      if (previous && previous.mimeType && file.mimeType && previous.mimeType !== file.mimeType) {
        return invalid()
      }
      files.set(file.id, { id: file.id, mimeType: file.mimeType || previous?.mimeType || '' })
    }
  }
  return [...files.values()]
}
