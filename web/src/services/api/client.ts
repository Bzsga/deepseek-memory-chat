import { ApiError } from './ApiError.js'
import { CHAT_INPUT_LIMIT_CODE, apiErrorField, chatInputLimitError, readSmallErrorJson } from './errors.js'
export { ApiError, type ApiErrorKind } from './ApiError.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import { managedRequestId, reportApiFailure, type ApiTimeout } from './serviceDiagnostics.js'
import { recordDiagnostic } from '../technicalDiagnostics.js'
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
  MessageUsage,
} from './types.js'

/** 同源聊天服务前缀，服务器负责上游 API 凭据。 */
export { API_ORIGIN }
import { OFFICIAL_BASE, providerApiUrl } from '../providerEndpoint.js'
import { nativeBackgroundChatAvailable } from '../nativeBridge.js'
import { compatibleChatRequest, readCompatibleChatResponse, streamCompatibleChat } from './compatibleChat.js'
import { cancelNativeChat, startNativeChat, watchNativeChat } from './nativeChat.js'
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

const serviceArea = (path: string) => {
  const route = path.split('?')[0]
  if (route === '/anthropic/v1/messages' || /^\/api\/chat-jobs(?:\/|$)/.test(route)) {return 'chat'}
  if (/^\/anthropic\/v1\/files(?:\/|$)/.test(route)) {return 'attachment'}
  if (/^\/api\/image-jobs(?:\/|$)/.test(route)) {return 'image'}
  if (/^\/api\/conversation-sync(?:\/|$)/.test(route)) {return 'sync'}
  if (route === '/logout' || route === '/api/redeem-invite') {return 'account'}
  if (route === '/v1/tools/asr' || route === '/v1/tools/tts') {return 'chat'}
  return undefined
}

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
    const upstream = apiErrorField(body)
    if (response.status === 400 && typeof upstream === 'object' && upstream !== null &&
        'code' in upstream && upstream.code === CHAT_INPUT_LIMIT_CODE) {
      const inputLimit = chatInputLimitError(kind, upstream)
      if (inputLimit) {return inputLimit}
    }
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
  if (code === CHAT_INPUT_LIMIT_CODE) {
    return new ApiError(kind, { key: 'replyContextInputTooLong' }, response.status, code)
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
  const area = url.startsWith(`${API_ORIGIN}/`) ? serviceArea(url.slice(API_ORIGIN.length)) : undefined
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
    const failure = new ApiError('network', error instanceof Error ? error.message : String(error))
    if (area) {reportApiFailure(area, failure)}
    throw failure
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
    if (area && !init.signal?.aborted) {reportApiFailure(area, error, managedRequestId(response))}
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
  (apiKey ? message.split(apiKey).join('[hidden]') : message)
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [hidden]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[hidden]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[service]')
    .replace(/[<>\p{Cc}]/gu, ' ')
    .slice(0, 500)

const personalError = async (
  response: Response,
  apiKey: string,
  kind: 'http' | 'protocol' = 'http',
  chat = false
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
  if (status === 400) {
    const value = await readSmallErrorJson(response)
    if (chat) {
      const inputLimit = chatInputLimitError(kind, apiErrorField(value))
      if (inputLimit) {return inputLimit}
    }
    if (isErrorBody(value)) {
      message = privateErrorMessage(value.error.message, apiKey)
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
  const area = serviceArea(path)
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
    const failure = new ApiError(
      'network',
      '无法连接个人 DeepSeek 服务，请检查网络后手动重试。',
      undefined,
      'personal_network'
    )
    if (area) {reportApiFailure(area, failure)}
    throw failure
  }
  if (!response.ok) {
    const failure = await personalError(response, provider.apiKey, 'http', path === '/anthropic/v1/messages')
    if (area && !init.signal?.aborted) {reportApiFailure(area, failure)}
    throw failure
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
  try {
    return (await response.json()) as FileObject
  } catch (error) {
    if (!signal?.aborted) {
      recordDiagnostic('attachment', 'invalid_response', { stage: 'parse', request_id: managedRequestId(response) })
    }
    throw error
  }
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

const chatRequestBody = (body: CreateMessageRequest, model?: string): string => JSON.stringify({
  ...body,
  // DeepSeek treats the compatible "medium" effort as "high".
  output_config: body.output_config?.effort === 'medium' ? { effort: 'high' } : body.output_config,
  ...(model ? { model } : {}),
  stream: true,
})

const DIRECT_CHAT_IDLE_MS = 180_000
const DIRECT_CHAT_TOTAL_MS = 480_000
const MANAGED_CHAT_SUBMIT_MS = 65_000
const MANAGED_WATCH_HEADERS_MS = 20_000
const MANAGED_WATCH_IDLE_MS = 35_000
const MANAGED_CHAT_PROGRESS_MS = 210_000
const MANAGED_WATCH_TOTAL_MS = 960_000

// A transport deadline interrupts the current exchange without stopping the user-owned reply or job.
const chatDeadline = (parent: AbortSignal, wait: number, stage: ApiTimeout['stage'], total?: number) => {
  parent.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort(parent.reason)
  parent.addEventListener('abort', abort, { once: true })
  let timeout: ApiTimeout | undefined
  const expire = (elapsed: number) => {
    if (controller.signal.aborted) {return}
    timeout = { stage, elapsed_ms: elapsed }
    controller.abort()
  }
  let timer = setTimeout(() => expire(wait), wait)
  const totalTimer = total === undefined ? undefined : setTimeout(() => expire(total), total)
  return {
    signal: controller.signal,
    get timeout() {return timeout},
    reset(nextStage: ApiTimeout['stage'], nextWait: number) {
      if (controller.signal.aborted) {return}
      stage = nextStage
      clearTimeout(timer)
      timer = setTimeout(() => expire(nextWait), nextWait)
    },
    close() {
      clearTimeout(timer)
      clearTimeout(totalTimer)
      parent.removeEventListener('abort', abort)
    },
  }
}

/** Open one direct request, preserving received content even when waiting times out. */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const provider = captureChatProvider(apiKey)
  const wait = chatDeadline(signal, DIRECT_CHAT_IDLE_MS, 'request', DIRECT_CHAT_TOTAL_MS)
  const receivedResponse = () => wait.reset('response', DIRECT_CHAT_IDLE_MS)
  const compatible = provider.mode === 'personal' && provider.baseUrl !== OFFICIAL_BASE
  let requestId: string | undefined
  try {
    let events: AsyncIterable<MessageStreamEvent>
    if (compatible) {
      events = streamCompatibleChat(provider.baseUrl, provider.model, provider.apiKey, body, wait.signal, receivedResponse)
    } else {
      const response = await requestWithProvider(provider, '/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          ...anthropicHeaders(apiKey, hasFile(body)),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: chatRequestBody(body, provider.mode === 'personal' ? provider.model : undefined),
        signal: wait.signal,
      })
      if (provider.mode === 'managed') {requestId = managedRequestId(response)}
      receivedResponse()
      events = readMessageStream(response, wait.signal, provider.mode === 'personal' ? provider.apiKey : undefined,
        false, undefined, body.tools?.some((tool) => tool.type === undefined))
    }
    for await (const event of events) {
      if (event.type !== 'ping') {receivedResponse()}
      yield event
    }
    wait.signal.throwIfAborted()
  } catch (error) {
    if (!signal.aborted && wait.timeout) {
      const message = '等待回复超时。已收到的内容已保留，可手动重新生成。'
      const failure = new ApiError('interrupted', message, undefined, 'chat_timeout')
      reportApiFailure('chat', failure, requestId, wait.timeout)
      throw failure
    }
    if (compatible && !signal.aborted) {reportApiFailure('chat', error)}
    throw error
  } finally {
    wait.close()
  }
}

async function* readMessageStream(
  response: Response,
  signal: AbortSignal,
  personalKey?: string,
  background = false,
  onBytes?: () => void,
  strictToolEvents = false,
): AsyncGenerator<MessageStreamEvent> {
  const failResponse = (failure: ApiError): never => {
    if (!signal.aborted && (!background || failure.kind !== 'interrupted')) {
      reportApiFailure('chat', failure, personalKey === undefined ? managedRequestId(response) : undefined)
    }
    throw failure
  }
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    return failResponse(personalKey !== undefined
      ? await personalError(response, personalKey, 'protocol')
      : await readErrorResponse(response, 'protocol', ''))
  }
  const failRead = (error: unknown) => failResponse(error instanceof ApiError ? error : new ApiError('interrupted', ''))
  const malformed = () => failResponse(new ApiError(
    'protocol', 'MCP 工具调用未完整返回。', undefined, 'personal_mcp_protocol'
  ))
  let usage: MessageUsage | undefined
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal, failRead, onBytes)) {
    const toolEvent = strictToolEvents && (eventName === 'message' || eventName.startsWith('message_') ||
      eventName.startsWith('content_block_'))
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        if (toolEvent) {return malformed()}
        continue
      }
    }
    const inputLimit = chatInputLimitError('stream', apiErrorField(payload) ?? (eventName === 'error' ? data : undefined))
    if (inputLimit) {return failResponse(inputLimit)}
    if (isErrorBody(payload)) {
      const { code, status } = payload.error as { code?: unknown; status?: unknown }
      return failResponse(new ApiError(
        'stream',
        personalKey !== undefined
          ? privateErrorMessage(payload.error.message, personalKey)
          : payload.error.message,
        background && typeof status === 'number' && Number.isInteger(status) ? status : undefined,
        personalKey !== undefined ? 'personal_stream' :
          background && typeof code === 'string' && code.length <= 128 ? code : undefined
      ))
    }
    if (eventName === 'error') {
      return failResponse(new ApiError(
        'stream',
        personalKey !== undefined ? '个人 DeepSeek 服务未完整返回回复，请稍后手动重试。' : data,
        undefined,
        personalKey !== undefined ? 'personal_stream' : undefined
      ))
    }
    const event = readMessageEvent(payload, usage)
    if (toolEvent && (!event || (eventName !== 'message' && event.type !== eventName))) {
      return malformed()
    }
    if (!event) {
      continue
    }
    if (event.type === 'message_start') {
      usage = event.message.usage
    } else if (event.type === 'message_delta') {
      usage = event.usage ?? usage
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  return failResponse(new ApiError('interrupted', ''))
}

const backgroundChatUrl = (id: string): string => {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) {
    throw new ApiError('protocol', '后台聊天任务标识无效。')
  }
  return `${API_ORIGIN}/api/chat-jobs/${id}`
}

const waitForBackgroundChat = (delay: number, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timeout = setTimeout(finish, delay)
    const abort = () => {
      clearTimeout(timeout)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

const mayReconnectBackgroundChat = (error: unknown): error is ApiError =>
  error instanceof ApiError && (error.kind === 'network' || error.kind === 'interrupted' ||
    (error.kind === 'http' && (error.status === 408 || (error.status ?? 0) >= 500)))

export type BackgroundChatTransport = 'managed' | 'personal-messages' | 'personal-completions'

export const captureBackgroundChatTransport = (key: string): BackgroundChatTransport | undefined => {
  try {
    const provider = captureChatProvider(key)
    if (provider.mode === 'managed') {
      return getRuntime().features.background_chat ? 'managed' : undefined
    }
    if (nativeBackgroundChatAvailable()) {
      return provider.baseUrl === OFFICIAL_BASE ? 'personal-messages' : 'personal-completions'
    }
  } catch {
    // The ordinary send path reports provider configuration errors.
  }
  return undefined
}

/** Submission happens at most once. Watchers reconnect and skip already consumed SSE events. */
export async function* streamBackgroundChat(
  key: string,
  id: string,
  body: CreateMessageRequest | undefined,
  signal: AbortSignal,
  transport: BackgroundChatTransport = 'managed',
  model = ''
): AsyncGenerator<MessageStreamEvent> {
  if (transport !== 'managed') {
    if (body) {
      const provider = captureChatProvider(key)
      if (provider.mode !== 'personal' ||
          (provider.baseUrl === OFFICIAL_BASE) !== (transport === 'personal-messages')) {
        throw new ApiError('protocol', '个人聊天配置已变化，请重新发送。')
      }
      const official = transport === 'personal-messages'
      await startNativeChat({
        jobId: id, key: provider.apiKey, filesBeta: official && hasFile(body),
        url: official ? `${OFFICIAL_BASE}/anthropic/v1/messages` : providerApiUrl(provider.baseUrl, 'chat/completions'),
        body: official ? chatRequestBody(body, provider.model) : compatibleChatRequest(provider.model, body, provider.baseUrl),
      }, signal)
      model = provider.model
    }
    const response = await watchNativeChat(id, signal)
    if (transport === 'personal-messages') {
      yield* readMessageStream(response, signal, key || '', true)
    } else {
      yield* readCompatibleChatResponse(response, model, signal)
    }
    return
  }
  const url = backgroundChatUrl(id)
  const owner = getRuntime().user.id
  if (body) {
    if (captureChatProvider(key).mode !== 'managed') {
      throw new ApiError('protocol', '后台聊天仅支持配套 API。')
    }
    const submit = chatDeadline(signal, MANAGED_CHAT_SUBMIT_MS, 'request')
    try {
      const accepted = await request(url, {
        method: 'POST', signal: submit.signal,
        headers: { ...anthropicHeaders(key, hasFile(body)), 'Content-Type': 'application/json' },
        body: chatRequestBody(body),
      })
      void accepted.body?.cancel().catch(() => {})
    } catch (error) {
      if (signal.aborted) {throw error}
      if (submit.timeout) {
        const failure = new ApiError('interrupted', '等待任务确认超时。', undefined, 'chat_timeout')
        reportApiFailure('chat', failure, undefined, submit.timeout)
      } else if (!mayReconnectBackgroundChat(error)) {
        throw error
      }
      // If acceptance is unclear, look up the original ID. Never send it again.
    } finally {
      submit.close()
    }
  }

  const reconnect = () => new ApiError('interrupted', '等待后台回复超时或连接中断，可以接回原来的生成任务。',
    undefined, 'chat_job_watch_interrupted')
  const progress = chatDeadline(signal, MANAGED_CHAT_PROGRESS_MS, 'response', MANAGED_WATCH_TOTAL_MS)
  let delivered = 0
  let attempt = 0
  let requestId: string | undefined
  const delays = [300, 800, 1800, 3500, 6500]
  try {
    for (;;) {
      progress.signal.throwIfAborted()
      if (!isSessionActive() || getRuntime().user.id !== owner) {
        throw new ApiError('http', '账号已变化。', 401)
      }
      const watch = chatDeadline(progress.signal, MANAGED_WATCH_HEADERS_MS, 'request')
      const receivedBytes = () => watch.reset('response', MANAGED_WATCH_IDLE_MS)
      let delay: number
      let seen = 0
      try {
        requestId = undefined
        const response = await request(`${url}/events`, {
          headers: { Accept: 'text/event-stream' }, cache: 'no-store', signal: watch.signal,
        })
        requestId = managedRequestId(response)
        receivedBytes()
        for await (const event of readMessageStream(response, watch.signal, undefined, true, receivedBytes)) {
          seen++
          if (seen <= delivered) {continue}
          delivered++
          if (event.type !== 'ping') {
            attempt = 0
            progress.reset('response', MANAGED_CHAT_PROGRESS_MS)
          }
          yield event
        }
        watch.signal.throwIfAborted()
        window.dispatchEvent(new Event('deepseek:usage'))
        return
      } catch (error) {
        progress.signal.throwIfAborted()
        const missing = error instanceof ApiError && error.code === 'chat_job_not_found'
        if (!watch.timeout && !missing && !mayReconnectBackgroundChat(error)) {throw error}
        const backoff: number | undefined = delays[attempt++]
        if (backoff === undefined) {
          if (missing) {throw error}
          const failure = reconnect()
          if (watch.timeout) {reportApiFailure('chat', failure, requestId, watch.timeout)}
          throw failure
        }
        delay = backoff
      } finally {
        watch.close()
      }
      await waitForBackgroundChat(delay, progress.signal)
    }
  } catch (error) {
    if (!signal.aborted && progress.timeout) {
      const failure = reconnect()
      reportApiFailure('chat', failure, requestId, progress.timeout)
      throw failure
    }
    throw error
  } finally {
    progress.close()
  }
}

/** A stop can race the same task's initial acceptance. Retrying cancel never starts generation. */
export const cancelBackgroundChat = async (id: string, transport: BackgroundChatTransport = 'managed'): Promise<void> => {
  if (transport !== 'managed') {return cancelNativeChat(id)}
  const url = backgroundChatUrl(id)
  const owner = getRuntime().user.id
  for (const delay of [0, 250, 750, 1500]) {
    if (delay) {await waitForBackgroundChat(delay)}
    if (!isSessionActive() || getRuntime().user.id !== owner) {return}
    try {
      await request(`${url}/cancel`, { method: 'POST' })
      return
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'chat_job_not_found' || delay === 1500) {throw error}
    }
  }
}
