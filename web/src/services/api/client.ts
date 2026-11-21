import { ApiError } from './ApiError.js'
export { ApiError, type ApiErrorKind } from './ApiError.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import {
  API_ORIGIN,
  denyRuntimePermission,
  getRuntime,
  invalidateSession,
  isSessionActive,
  isGuestWorkspace,
} from '../runtime.js'
import {
  captureChatProvider,
  type ChatProviderSnapshot,
} from '../chatProvider.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/** 同源聊天服务前缀，服务器负责上游 API 凭据。 */
export { API_ORIGIN }
import { OFFICIAL_BASE } from '../providerEndpoint.js'
import { streamCompatibleChat } from './compatibleChat.js'
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  let code: string | undefined
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
      const value = (body.error as { code?: unknown }).code
      if (typeof value === 'string' && value.length <= 128) {
        code = value
      }
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status, code)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  if (isGuestWorkspace()) {
    throw new ApiError('http', '请先登录，再使用这项服务器功能。', 401, 'login_required')
  }
  if (!isSessionActive()) {
    throw new ApiError('http', 'Your login session has ended', 401)
  }
  let response: Response
  try {
    const headers = new Headers(init.headers)
    headers.delete('Authorization')
    headers.delete('x-api-key')
    headers.set('X-Chat-User-Id', String(getRuntime().user.id))
    response = await fetch(url, { ...init, headers, credentials: 'same-origin' })
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (init.method?.toUpperCase() === 'POST' && !url.endsWith('/logout')) {
    window.dispatchEvent(new Event('deepseek:usage'))
  }
  if (response.status === 401 && response.headers.get('X-Session-Expired') === '1') {
    invalidateSession('login')
  } else if (response.status === 409 && response.headers.get('X-Session-Changed') === '1') {
    invalidateSession('changed')
  }
  if (!response.ok) {
    const error = await readErrorResponse(response)
    if (response.status === 403) {
      if (error.code === 'managed_ineligible') {
        denyRuntimePermission('chat_api')
      } else if (error.code === 'image_ineligible') {
        denyRuntimePermission('image_api')
      } else if (error.code === 'sync_invitation_required') {
        denyRuntimePermission('cloud_sync')
      }
    }
    throw error
  }
  return response
}

const privateErrorMessage = (message: string, apiKey: string): string =>
  message
    .split(apiKey)
    .join('[hidden]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [hidden]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[hidden]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[service]')
    .replace(/[<>\p{Cc}]/gu, ' ')
    .slice(0, 500)

const personalError = async (
  response: Response,
  apiKey: string,
  kind: 'http' | 'protocol' = 'http'
): Promise<ApiError> => {
  const status = response.status
  if (status === 401 || status === 403) {
    await response.body?.cancel().catch(() => {})
    return new ApiError(
      kind,
      '个人 DeepSeek API Key 无效或无权使用，请检查聊天设置。',
      status,
      'personal_auth'
    )
  }
  if (status === 402) {
    await response.body?.cancel().catch(() => {})
    return new ApiError(
      kind,
      '个人 DeepSeek 账户余额不足，请检查个人账户。',
      status,
      'personal_balance'
    )
  }
  let message =
    kind === 'protocol'
      ? '个人 DeepSeek 服务响应格式不完整，请稍后手动重试。'
      : status === 429
        ? '个人 DeepSeek 请求过于频繁，请稍后手动重试。'
        : status >= 500
          ? '个人 DeepSeek 服务暂不可用，请稍后手动重试。'
          : '个人 DeepSeek 请求未被接受，请检查模型和附件后手动重试。'
  if (status === 400 && response.body) {
    const reader = response.body.getReader()
    const pieces: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) {
          break
        }
        size += part.value.byteLength
        if (size > 8192) {
          break
        }
        pieces.push(part.value)
      }
      if (size <= 8192) {
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const piece of pieces) {
          bytes.set(piece, offset)
          offset += piece.byteLength
        }
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
        if (isErrorBody(value)) {
          message = privateErrorMessage(value.error.message, apiKey)
        }
      }
    } catch {
      /* A malformed upstream error never exposes raw HTML or credentials. */
    } finally {
      await reader.cancel().catch(() => {})
    }
  } else {
    await response.body?.cancel().catch(() => {})
  }
  return new ApiError(
    kind,
    message,
    status,
    kind === 'protocol' ? 'personal_protocol' : 'personal_request'
  )
}

const paidPath = (path: string, method: string): boolean =>
  (method === 'POST' &&
    ['/anthropic/v1/messages', '/anthropic/v1/files', '/v1/tools/asr', '/v1/tools/tts'].includes(
      path
    )) ||
  (method === 'DELETE' && /^\/anthropic\/v1\/files\/[A-Za-z0-9_-]{1,512}$/.test(path))

const requestWithProvider = async (
  provider: ChatProviderSnapshot,
  path: string,
  init: RequestInit
): Promise<Response> => {
  const method = (init.method ?? 'GET').toUpperCase()
  if (!paidPath(path, method)) {
    throw new ApiError('protocol', '聊天接口地址无效。')
  }
  if (provider.mode === 'managed') {
    return request(`${API_ORIGIN}${path}`, init)
  }
  if (provider.baseUrl !== OFFICIAL_BASE) {
    throw new ApiError('protocol', '自定义聊天服务当前仅支持文本对话。')
  }
  const headers = new Headers()
  const supplied = new Headers(init.headers)
  for (const name of ['Content-Type', 'Accept', 'anthropic-beta']) {
    const value = supplied.get(name)
    if (value !== null) {
      headers.set(name, value)
    }
  }
  headers.set('Authorization', `Bearer ${provider.apiKey}`)
  let response: Response
  try {
    response = await fetch(`${OFFICIAL_BASE}${path}`, {
      method,
      headers,
      body: init.body,
      signal: init.signal,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    })
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError(
      'network',
      '无法连接个人 DeepSeek 服务，请检查网络后手动重试。',
      undefined,
      'personal_network'
    )
  }
  if (!response.ok) {
    throw await personalError(response, provider.apiKey)
  }
  return response
}

/** Model/files/speech only. Account, sharing and sync must keep using request(). */
export const requestChatApi = (
  apiKey: string,
  path: string,
  init: RequestInit
): Promise<Response> => requestWithProvider(captureChatProvider(apiKey), path, init)

/** Keep waiting through image-generation heartbeats without replaying the POST. */
export const readImageGenerationResponse = async (
  response: Response,
  signal: AbortSignal
): Promise<unknown> => {
  try {
    if (!(response.headers.get('Content-Type') ?? '').includes('text/event-stream')) {
      return await response.json()
    }
    if (!response.body) {
      throw new ApiError('protocol', '生图服务返回了空响应，请稍后手动重试。')
    }
    for await (const event of readServerSentEvents(response.body, signal)) {
      signal.throwIfAborted()
      if (event.data.length > 32 * 1024 * 1024) {
        throw new ApiError('protocol', '生成图片超过保存上限，请联系管理员调整输出尺寸。')
      }
      let value: unknown
      try {
        value = JSON.parse(event.data)
      } catch {
        throw new ApiError('protocol', '生图响应不完整，未收到可保存的图片。')
      }
      if (event.event === 'error' && isErrorBody(value)) {
        const status = (value.error as { status?: unknown }).status
        const validStatus =
          typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
            ? status
            : 502
        if (validStatus === 401) {
          invalidateSession('login')
        }
        throw new ApiError('http', value.error.message, validStatus)
      }
      if (event.event === 'result') {
        return value
      }
    }
    throw new ApiError('interrupted', '生图连接已结束，尚未收到确定结果。请稍后手动重试。')
  } catch (error) {
    if (signal.aborted || error instanceof ApiError) {
      throw error
    }
    throw new ApiError('network', '生图连接已中断，尚未收到确定结果。请稍后手动重试。')
  }
}

const anthropicHeaders = (_apiKey: string, beta: boolean): Record<string, string> => ({
  // 配套/个人鉴权统一由对应transport处理，此处只声明接口能力。
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await requestChatApi(apiKey, '/anthropic/v1/files', {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await requestChatApi(apiKey, `/anthropic/v1/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const provider = captureChatProvider(apiKey)
  if (provider.mode === 'personal' && provider.baseUrl !== OFFICIAL_BASE) {
    yield* streamCompatibleChat(provider.baseUrl, provider.model, provider.apiKey, body, signal)
    return
  }
  // DeepSeek treats the compatible "medium" effort as "high".
  const outputConfig = body.output_config?.effort === 'medium' ? { effort: 'high' } : body.output_config
  const response = await requestWithProvider(provider, '/anthropic/v1/messages', {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      ...body,
      output_config: outputConfig,
      ...(provider.mode === 'personal' ? { model: provider.model } : {}),
      stream: true,
    }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw provider.mode === 'personal'
      ? await personalError(response, provider.apiKey, 'protocol')
      : await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError(
        'stream',
        provider.mode === 'personal'
          ? privateErrorMessage(payload.error.message, provider.apiKey)
          : payload.error.message,
        undefined,
        provider.mode === 'personal' ? 'personal_stream' : undefined
      )
    }
    if (eventName === 'error') {
      throw new ApiError(
        'stream',
        provider.mode === 'personal' ? '个人 DeepSeek 服务未完整返回回复，请稍后手动重试。' : data,
        undefined,
        provider.mode === 'personal' ? 'personal_stream' : undefined
      )
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
