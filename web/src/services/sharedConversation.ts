import { createId } from '../utils/id.js'
import { API_ORIGIN, getRuntime, isSessionActive } from './runtime.js'
import type { FileAttachment, Message, Session } from './chat/types.js'
import type { AppConversationSharePreview } from './conversationShares.js'

const MAX_BYTES = 8 * 1024 * 1024
const INVALID = '分享内容格式暂不支持，请使用 DeepSeek 导出的 ZIP 文件。'
const RANGE_WARNING =
  '仅导入分享范围内的公开消息，可能不包含完整会话或其他分支；完整记录可用 ZIP 导入。'
const EXTRA_WARNING = '推理过程、搜索结果及系统提示不纳入续聊正文，原始分享数据会保留在本机。'
const ATTACHMENT_WARNING = '分享附件仅保留元数据，原文件未提供，续聊时需要重新上传。'
const EXTRA_FRAGMENTS = new Set([
  'THINK',
  'TEMPLATE_RESPONSE',
  'TIP',
  'CONTENT_RISK',
  'PARTIAL_FILE_READ',
  'SEARCH',
  'TOOL_SEARCH',
  'TOOL_OPEN',
  'TOOL_FIND',
  'READ_LINK',
  'TOOL_IMAGE_SEARCH',
])
const TEXT_TYPES = new Set([
  'text',
  'input_text',
  'output_text',
  'request',
  'response',
  'multimodal_text',
])
const REASONING_TYPES = new Set(['thinking', 'think', 'reasoning', 'reasoning_content', 'analysis'])
const MEDIA_TYPES = new Set(['image', 'image_url', 'input_image', 'file', 'audio', 'video'])

type JsonObject = Record<string, unknown>
type PreviewMessage = { id: string; role: 'user' | 'assistant'; content: string; images?: { url: string; name: string }[] }
export type SharedConversationPreview = {
  sourceKind?: 'deepseek-share' | 'app-share'
  title: string
  messageCount: number
  rangeWarning: string
  sourceUrl: string
  warnings: string[]
  messages: PreviewMessage[]
}
type PreparedShare = { accountId: string; session: Session } |
  { accountId?: string; app: AppConversationSharePreview; task?: Promise<string> }
const preparedShares = new WeakMap<SharedConversationPreview, PreparedShare>()

const object = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const fail = (message = INVALID): never => {
  throw new Error(message)
}

const firstValue = (value: JsonObject, keys: string[]) => {
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) {
      return value[key]
    }
  }
  return undefined
}

const identifier = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : undefined

export const parseDeepSeekShareLink = (input: string): { shareId: string; url: string } => {
  if (!input.trim() || input.length > 8192) {
    fail('请粘贴 DeepSeek 的完整分享链接，分享文案最多 8192 字。')
  }
  const candidates = input.match(/https?:\/\/[^\s<>"'`]+/gi) ?? []
  if (!candidates.length) {
    fail('未找到分享链接，请复制 DeepSeek 的完整分享文案或链接。')
  }
  const ids = new Set<string>()
  for (const candidate of candidates) {
    const trimmed = candidate.replace(
      /[\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u3001\uff09\u3011\u300b\u300d\u300f.,;:!?)\]}]+$/u,
      ''
    )
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return fail('分享链接无效，请重新复制。')
    }
    const rawPath = /^https:\/\/[^/?#]+([^?#]*)/i.exec(trimmed)?.[1]
    const match = /^\/share\/([A-Za-z0-9_-]{6,128})\/?$/.exec(rawPath ?? '')
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== 'chat.deepseek.com' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443') ||
      trimmed.includes('\\') ||
      !match
    ) {
      return fail('仅支持 https://chat.deepseek.com/share/ 开头的 DeepSeek 分享链接。')
    }
    ids.add(match[1])
  }
  if (ids.size !== 1) {
    fail('一次只能导入一个分享，请保留一个 DeepSeek 分享链接。')
  }
  const shareId = [...ids][0]
  return { shareId, url: `https://chat.deepseek.com/share/${shareId}` }
}

/** Reject duplicate object keys before JSON.parse can silently overwrite them. */
export const validateSharedJsonStructure = (text: string) => {
  const stack: { keys: Set<string> | null; expectsKey: boolean }[] = []
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '{' || char === '[') {
      stack.push({ keys: char === '{' ? new Set() : null, expectsKey: char === '{' })
      if (stack.length > 64) {
        fail()
      }
    } else if (char === '}' || char === ']') {
      stack.pop()
    } else if (char === ':') {
      const container = stack.at(-1)
      if (container) {
        container.expectsKey = false
      }
    } else if (char === ',') {
      const container = stack.at(-1)
      if (container) {
        container.expectsKey = container.keys !== null
      }
    } else if (char === '"') {
      const start = index
      index++
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') {
          index++
        }
        index++
      }
      const container = stack.at(-1)
      if (container?.keys && container.expectsKey) {
        let key: string
        try {
          key = JSON.parse(text.slice(start, index + 1)) as string
        } catch {
          return fail()
        }
        if (container.keys.has(key)) {
          fail()
        }
        container.keys.add(key)
      }
    }
  }
}

const sourceObject = (text: string): JsonObject => {
  validateSharedJsonStructure(text)
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return fail()
  }
  if (!object(root)) {
    return fail()
  }
  const data = object(root.data) ? root.data : root
  for (const [node, key] of [
    [root, 'code'],
    [data, 'biz_code'],
  ] as const) {
    if (
      node[key] !== undefined &&
      node[key] !== null &&
      (typeof node[key] !== 'number' || node[key] !== 0)
    ) {
      fail('分享不存在、已撤销或暂时无法访问，请检查链接。')
    }
  }
  const source = object(data.biz_data) ? data.biz_data : data
  if (
    ['has_more', 'hasMore', 'truncated', 'is_truncated', 'need_load_more'].some(
      (key) => source[key] === true
    )
  ) {
    fail('该分享返回了不完整的消息，请重新分享或使用 ZIP 导入。')
  }
  return source
}

const attachment = (value: unknown, id: string): FileAttachment => {
  const metadata = object(value) ? value : {}
  const name = firstValue(metadata, ['file_name', 'filename', 'name'])
  const mime = firstValue(metadata, ['mime_type', 'mimeType'])
  const type = typeof metadata.type === 'string' ? metadata.type.toLowerCase() : ''
  const size = firstValue(metadata, ['file_size', 'size'])
  return {
    id,
    serverId: null,
    name: typeof name === 'string' && name ? name.slice(0, 4096) : '分享附件',
    size: typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : 0,
    mimeType: typeof mime === 'string' ? mime.slice(0, 256) : '',
    isImage:
      metadata.is_image === true ||
      type.includes('image') ||
      (typeof mime === 'string' && mime.startsWith('image/')),
  }
}

const messageContent = (message: JsonObject, messageId: string, warnings: Set<string>) => {
  const files: FileAttachment[] = []
  const addFile = (value: unknown) => {
    files.push(attachment(value, `${messageId}-file-${files.length}`))
    warnings.add(ATTACHMENT_WARNING)
  }
  for (const values of [
    message.attachments,
    message.files,
    object(message.metadata) ? message.metadata.attachments : undefined,
  ]) {
    if (values !== undefined && values !== null) {
      if (!Array.isArray(values)) {
        return fail()
      }
      values.forEach(addFile)
    }
  }
  const readContent = (value: unknown): string => {
    if (value === null) {
      return ''
    }
    if (typeof value === 'string') {
      return value
    }
    if (Array.isArray(value)) {
      return value
        .map(readContent)
        .filter((part) => part !== '')
        .join('\n')
    }
    if (!object(value)) {
      return fail()
    }
    const rawType = value.content_type ?? value.type
    if (rawType !== undefined && typeof rawType !== 'string') {
      return fail()
    }
    const type = typeof rawType === 'string' ? rawType.toLowerCase() : undefined
    if (type && REASONING_TYPES.has(type)) {
      warnings.add(EXTRA_WARNING)
      return ''
    }
    if (type && MEDIA_TYPES.has(type)) {
      if (Array.isArray(value.files)) {
        value.files.forEach(addFile)
      } else {
        addFile(value)
      }
      return ''
    }
    if (type === undefined || TEXT_TYPES.has(type)) {
      const text = firstValue(value, ['parts', 'text', 'content'])
      if (text === undefined) {
        return fail()
      }
      return readContent(text)
    }
    return fail()
  }
  const roles = new Set<string>()
  let content: string
  if (message.fragments !== undefined && message.fragments !== null) {
    if (!Array.isArray(message.fragments)) {
      return fail()
    }
    content = message.fragments
      .map((fragment): string => {
        if (!object(fragment) || typeof fragment.type !== 'string') {
          return fail()
        }
        const type = fragment.type.toUpperCase()
        if (type === 'REQUEST' || type === 'RESPONSE') {
          if (typeof fragment.content !== 'string') {
            return fail()
          }
          roles.add(type === 'REQUEST' ? 'user' : 'assistant')
          return fragment.content
        }
        if (type === 'FILE') {
          if (!Array.isArray(fragment.files)) {
            return fail()
          }
          fragment.files.forEach(addFile)
        } else if (EXTRA_FRAGMENTS.has(type)) {
          warnings.add(EXTRA_WARNING)
        } else {
          return fail()
        }
        return ''
      })
      .filter((part) => part !== '')
      .join('\n')
  } else {
    if (!Object.hasOwn(message, 'content')) {
      return fail()
    }
    content = readContent(message.content)
  }
  if (['reasoning_content', 'reasoning', 'analysis'].some((key) => Object.hasOwn(message, key))) {
    warnings.add(EXTRA_WARNING)
  }
  const author = object(message.author) ? message.author.role : undefined
  const explicit =
    firstValue(message, ['role', 'sender']) ??
    author ??
    (typeof message.author === 'string' ? message.author : message.type)
  const declared = typeof explicit === 'string' ? explicit.toLowerCase() : undefined
  const role = declared === 'request' ? 'user' : declared === 'response' ? 'assistant' : declared
  if (roles.size > 1 || (role && [...roles].some((item) => item !== role))) {
    fail('分享中有角色标记冲突的消息，请使用 ZIP 导入并核对原文。')
  }
  const resolved = role ?? [...roles][0]
  if (!resolved || !['user', 'assistant', 'system', 'tool', 'developer'].includes(resolved)) {
    fail('分享中有无法确定说话者的消息，请使用 ZIP 导入并核对原文。')
  }
  if (resolved !== 'user' && resolved !== 'assistant') {
    warnings.add(EXTRA_WARNING)
  }
  return { content, files, role: resolved }
}

const messageTime = (message: JsonObject, fallback: number, warnings: Set<string>) => {
  const value = firstValue(message, [
    'inserted_at',
    'created_at',
    'create_time',
    'timestamp',
    'createdAt',
  ])
  const time =
    typeof value === 'number' && Number.isFinite(value)
      ? value < 1e12
        ? value * 1000
        : value
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN
  if (Number.isFinite(time) && time >= 0 && time <= 8640000000000000) {
    return time
  }
  warnings.add('部分消息缺少可识别时间，列表使用导入时间，原始时间字段保留在本机快照中。')
  return fallback
}

/** Parse originals and source relationships without fetching attachment URLs or calling a model. */
export const parseSharedConversationSnapshot = (
  rawSnapshot: string,
  link: { shareId: string; url: string },
  importedAt = Date.now()
): { session: Session; warnings: string[]; visibleMessages: PreviewMessage[] } => {
  if (!rawSnapshot || new TextEncoder().encode(rawSnapshot).length > MAX_BYTES) {
    fail('分享内容为空或超过 8 MB，请使用 ZIP 导入。')
  }
  const source = sourceObject(rawSnapshot)
  const rawMessages = source.messages
  if (!Array.isArray(rawMessages) || rawMessages.length === 0 || rawMessages.length > 100000) {
    return fail()
  }
  const sessionId = createId()
  const warnings = new Set<string>()
  const nodes = rawMessages.map((raw, index) => {
    if (!object(raw)) {
      return fail()
    }
    const sourceId = identifier(firstValue(raw, ['id', 'message_id', 'uuid'])) ?? `@source-${index}`
    const localId = `${sessionId}-message-${index}`
    const parsed = messageContent(raw, localId, warnings)
    let message: Message | undefined
    if (parsed.role === 'user') {
      message = {
        id: localId,
        role: 'user',
        content: parsed.content,
        files: parsed.files,
        createdAt: messageTime(raw, importedAt, warnings),
      }
    }
    if (parsed.role === 'assistant') {
      message = {
        id: localId,
        role: 'assistant',
        blocks: [{ type: 'text', text: parsed.content }],
        createdAt: messageTime(raw, importedAt, warnings),
        status: 'done',
        prefix: false,
        model: null,
      }
    }
    return { raw, sourceId, message, parent: undefined as string | undefined }
  })
  const byId = new Map(nodes.map((node) => [node.sourceId, node]))
  if (byId.size !== nodes.length) {
    fail('分享包含重复消息标识，请使用 ZIP 导入并核对原文。')
  }
  const hasTree = nodes.some(({ raw }) =>
    ['parent', 'parent_id', 'children'].some((key) => Object.hasOwn(raw, key))
  )
  const linkNodes = (parentId: string, childId: string) => {
    const child = byId.get(childId)
    if (!child) {
      warnings.add('分享中有未提供的分支节点，已保留现有消息与原始快照。')
      return
    }
    if (child.parent !== undefined && child.parent !== parentId) {
      fail('分享分支有多个父节点，请使用 ZIP 导入并核对原文。')
    }
    child.parent = parentId
  }
  if (hasTree) {
    for (const node of nodes) {
      const parent = firstValue(node.raw, ['parent', 'parent_id'])
      if (parent !== undefined) {
        const parentId = identifier(parent)
        if (!parentId) {
          return fail()
        }
        linkNodes(parentId, node.sourceId)
      }
      const children = node.raw.children
      if (children !== undefined && children !== null) {
        if (!Array.isArray(children)) {
          return fail()
        }
        for (const child of children) {
          const childId = identifier(child)
          if (!childId) {
            return fail()
          }
          linkNodes(node.sourceId, childId)
        }
      }
    }
  } else {
    nodes.forEach((node, index) => {
      node.parent = nodes[index - 1]?.sourceId
    })
  }
  const checked = new Set<string>()
  for (const node of nodes) {
    const path = new Set<string>()
    let current: typeof node | undefined = node
    while (current && !checked.has(current.sourceId)) {
      if (path.has(current.sourceId)) {
        fail('分享分支存在循环，请使用 ZIP 导入并核对原文。')
      }
      path.add(current.sourceId)
      current = current.parent === undefined ? undefined : byId.get(current.parent)
    }
    path.forEach((id) => checked.add(id))
  }
  const messages: Message[] = []
  const children = new Map<string | null, Message[]>()
  for (const node of nodes) {
    if (!node.message) {
      continue
    }
    let parent = node.parent === undefined ? undefined : byId.get(node.parent)
    if (node.parent !== undefined && !parent) {
      warnings.add('分享缺少部分父节点，已将可读消息保留为独立分支。')
    }
    while (parent && !parent.message) {
      parent = parent.parent === undefined ? undefined : byId.get(parent.parent)
    }
    node.message.parentId = parent?.message?.id ?? null
    const siblings = children.get(node.message.parentId) ?? []
    siblings.push(node.message)
    children.set(node.message.parentId, siblings)
    messages.push(node.message)
  }
  if (!messages.length) {
    fail('这个分享没有可续聊的用户或助手消息，请检查分享范围。')
  }
  for (const message of messages) {
    message.selectedChildId = children.get(message.id)?.at(-1)?.id
  }
  const roots = children.get(null) ?? []
  let rootMessageId: string | null = roots[0]?.id ?? null
  const selectedId = identifier(
    firstValue(source, [
      'current_message_id',
      'current_node',
      'currentNode',
      'currentMessageId',
      'leaf_id',
    ])
  )
  if (selectedId) {
    let current = byId.get(selectedId)
    if (!current) {
      warnings.add('分享指定的当前分支未提供，已展示可读取的首个分支。')
    }
    let selectedChild: Message | undefined
    while (current) {
      if (current.message) {
        if (selectedChild) {
          current.message.selectedChildId = selectedChild.id
        }
        selectedChild = current.message
        rootMessageId = current.message.id
      }
      current = current.parent === undefined ? undefined : byId.get(current.parent)
    }
  }
  if (roots.length > 1) {
    warnings.add('分享包含多个独立分支，已保留全部消息，可通过消息版本切换查看。')
  }
  const visibleMessages: PreviewMessage[] = []
  const localById = new Map(messages.map((message) => [message.id, message]))
  let visibleId: string | null = rootMessageId
  while (visibleId) {
    const message = localById.get(visibleId)
    if (!message) {
      break
    }
    visibleMessages.push({
      id: message.id,
      role: message.role,
      content:
        message.role === 'user'
          ? message.content
          : message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join(''),
    })
    visibleId = message.selectedChildId ?? null
  }
  const title =
    typeof source.title === 'string' && source.title.trim()
      ? source.title.trim().slice(0, 200)
      : (visibleMessages
          .find((message) => message.content.trim())
          ?.content.trim()
          .slice(0, 80) ?? 'DeepSeek 分享的聊天')
  const session: Session = {
    id: sessionId,
    title,
    createdAt: importedAt,
    updatedAt: importedAt,
    messages,
    rootMessageId,
    sharedSource: {
      kind: 'deepseek-share',
      shareId: link.shareId,
      url: link.url,
      scope: 'shared_snapshot',
      importedAt,
      rawSnapshot,
    },
  }
  return { session, warnings: [...warnings], visibleMessages }
}

const ensureAccount = (expectedAccountId: string) => {
  if (!isSessionActive() || getRuntime().user.id !== expectedAccountId) {
    fail('账号已切换或登录已过期，请重新读取分享。')
  }
}

export const readSharedConversation = async (
  input: string,
  signal?: AbortSignal
): Promise<SharedConversationPreview> => {
  if (/https?:\/\/[^\s<>"'`]*digimonlegend\.com/i.test(input)) {
    const accountId = isSessionActive() ? getRuntime().user.id : undefined
    const { readAppConversationShare } = await import('./conversationShares.js')
    const app = await readAppConversationShare(input, signal)
    if (accountId !== undefined) {ensureAccount(accountId)}
    const byId = new Map(app.snapshot.images.map(image => [image.id, image]))
    const preview: SharedConversationPreview = {
      sourceKind: 'app-share', title: app.snapshot.title, messageCount: app.snapshot.messages.length,
      rangeWarning: '仅导入创建者选定的公开消息，不包含其他消息或分支。', sourceUrl: app.sourceUrl,
      warnings: app.snapshot.messages.some(message => message.files.length) ? ['非图片附件仅保留元数据，使用时需要重新上传。'] : [],
      messages: app.snapshot.messages.map(message => ({ id: message.id, role: message.role, content: message.content,
        images: message.image_ids.map(id => {const image = byId.get(id) ?? fail(); return { url: image.url, name: image.name }}) })),
    }
    preparedShares.set(preview, { accountId, app })
    return preview
  }
  const accountId = getRuntime().user.id
  ensureAccount(accountId)
  const link = parseDeepSeekShareLink(input)
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) {
    abort()
  }
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error('分享读取超时，请重试。')), 35000)
  const accountWatch = setInterval(() => {
    if (!isSessionActive() || getRuntime().user.id !== accountId) {
      controller.abort(new Error('账号已切换，请重新读取分享。'))
    }
  }, 250)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const { request } = await import('./api/client.js')
    controller.signal.throwIfAborted()
    const response = await request(
      `${API_ORIGIN}/api/shared-conversation?share_id=${encodeURIComponent(link.shareId)}`,
      {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      }
    )
    if (!response.body) {
      return fail('分享内容为空，请重试。')
    }
    reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const pieces: string[] = []
    let size = 0
    while (true) {
      controller.signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.length
      if (size > MAX_BYTES) {
        return fail('该分享超过 8 MB，请使用 ZIP 导入。')
      }
      pieces.push(decoder.decode(value, { stream: true }))
    }
    pieces.push(decoder.decode())
    controller.signal.throwIfAborted()
    ensureAccount(accountId)
    const parsed = parseSharedConversationSnapshot(pieces.join(''), link)
    const preview = {
      sourceKind: 'deepseek-share' as const,
      title: parsed.session.title,
      messageCount: parsed.session.messages.length,
      rangeWarning: RANGE_WARNING,
      sourceUrl: link.url,
      warnings: parsed.warnings,
      messages: parsed.visibleMessages,
    }
    preparedShares.set(preview, { accountId, session: parsed.session })
    return preview
  } finally {
    clearTimeout(timeout)
    clearInterval(accountWatch)
    signal?.removeEventListener('abort', abort)
    await reader?.cancel().catch(() => {})
  }
}

export const continueSharedConversation = async (
  preview: SharedConversationPreview
): Promise<string> => {
  const prepared = preparedShares.get(preview)
  if (!prepared) {
    return fail('分享预览已失效，请重新读取分享。')
  }
  if ('app' in prepared) {
    if (!isSessionActive()) {return fail('请先登录，再继续这段对话。')}
    const accountId = prepared.accountId ?? getRuntime().user.id
    ensureAccount(accountId)
    const { importAppConversationShare } = await import('./conversationShares.js')
    ensureAccount(accountId)
    prepared.task ??= importAppConversationShare(prepared.app, accountId).finally(() => {
      prepared.task = undefined
    })
    return prepared.task
  }
  ensureAccount(prepared.accountId)
  const { appendImportedSession } = await import('./chat/store.js')
  ensureAccount(prepared.accountId)
  return appendImportedSession(prepared.session, prepared.accountId)
}
