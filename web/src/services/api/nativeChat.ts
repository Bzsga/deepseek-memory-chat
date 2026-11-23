import { NativeChatBridgeError, requestNativeBackgroundChat } from '../nativeBridge.js'
import { ApiError } from './ApiError.js'
import { MAX_ERROR_BODY_BYTES, apiErrorField, chatInputLimitError } from './errors.js'

const watcherInterrupted = () => new ApiError('interrupted',
  '正在重新连接 App 中的生成任务。', undefined, 'chat_job_watch_interrupted')

type NativeChatState = 'running' | 'done' | 'failed' | 'cancelled'
type NativeChatFrame = {
  state: NativeChatState
  status?: number
  contentType?: string
  chunk?: Uint8Array<ArrayBuffer>
  nextOffset: number
  code?: string
  message?: string
}

const delay = async (ms: number, signal?: AbortSignal) => {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(done, ms)
    const abort = () => { clearTimeout(timer); reject(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

const failure = (code: string, message?: string) =>
  new ApiError('stream', message || '个人聊天生成已中断，请手动重试。', undefined, code)

export const startNativeChat = async (payload: {
  jobId: string; url: string; key: string; body: string; filesBeta: boolean
}, signal: AbortSignal): Promise<void> => {
  try {
    const result = await requestNativeBackgroundChat('start', payload, signal)
    if (result.state === 'failed' || result.state === 'cancelled') {
      throw failure(typeof result.code === 'string' ? result.code : 'personal_chat_failed',
        typeof result.message === 'string' ? result.message : undefined)
    }
  } catch (error) {
    if (signal.aborted || !(error instanceof NativeChatBridgeError)) {throw error}
    if (error.code !== 'personal_chat_bridge') {throw failure(error.code, error.message)}
    // Acceptance is uncertain when the port changes. Only look up the original task.
  }
}

const read = async (id: string, offset: number, signal: AbortSignal): Promise<NativeChatFrame> => {
  let value: Record<string, unknown> | undefined
  for (const pause of [0, 250, 700, 1600, 3200]) {
    if (pause) {await delay(pause, signal)}
    try {
      value = await requestNativeBackgroundChat('read', { jobId: id, offset }, signal)
      break
    } catch (error) {
      if (!(error instanceof NativeChatBridgeError) || signal.aborted) {throw error}
      if (error.code !== 'personal_chat_bridge') {throw failure(error.code, error.message)}
    }
  }
  if (!value) {throw watcherInterrupted()}
  const { state, status, contentType, chunk, nextOffset, code, message } = value
  if ((state !== 'running' && state !== 'done' && state !== 'failed' && state !== 'cancelled') ||
      typeof nextOffset !== 'number' || !Number.isSafeInteger(nextOffset) || nextOffset < offset ||
      (chunk !== undefined && (typeof chunk !== 'string' || chunk.length > 88_000))) {
    throw new ApiError('protocol', 'App 返回的聊天进度无效。', undefined, 'personal_chat_protocol')
  }
  let bytes: Uint8Array<ArrayBuffer> | undefined
  if (typeof chunk === 'string' && chunk.length) {
    try {bytes = Uint8Array.from(atob(chunk), char => char.charCodeAt(0))}
    catch {throw new ApiError('protocol', 'App 返回的聊天数据无效。', undefined, 'personal_chat_protocol')}
  }
  if (nextOffset !== offset + (bytes?.byteLength ?? 0)) {
    throw new ApiError('protocol', 'App 返回的聊天进度不连续。', undefined, 'personal_chat_protocol')
  }
  return {
    state, nextOffset, chunk: bytes,
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 200 && status <= 599 ? { status } : {}),
    ...(typeof contentType === 'string' && !/[\r\n]/.test(contentType) ? { contentType } : {}),
    ...(typeof code === 'string' && /^personal_chat_[a-z_]{1,40}$/.test(code) ? { code } : {}),
    ...(typeof message === 'string' ? { message: message.slice(0, 200) } : {}),
  }
}

const terminalFailure = (frame: NativeChatFrame) => failure(
  frame.code ?? (frame.state === 'cancelled' ? 'personal_chat_cancelled' : 'personal_chat_failed'), frame.message)

const readInputLimit = async (id: string, first: NativeChatFrame, signal: AbortSignal) => {
  let frame = first
  for (const pause of [0, 120, 260, 500]) {
    if (pause) {
      await delay(pause, signal)
      try {
        frame = await read(id, 0, signal)
      } catch (error) {
        if (signal.aborted) {throw error}
        return undefined
      }
    }
    if (frame.chunk && frame.chunk.byteLength > MAX_ERROR_BODY_BYTES) {return undefined}
    if (frame.state === 'done' && frame.chunk) {
      try {
        const value: unknown = JSON.parse(new TextDecoder().decode(frame.chunk))
        return chatInputLimitError('http', apiErrorField(value))
      } catch {
        return undefined
      }
    }
    if (frame.state !== 'running') {return undefined}
  }
  return undefined
}

/** The port reads app-local buffered bytes; dropping a watcher does not stop the Android job. */
export const watchNativeChat = async (id: string, signal: AbortSignal): Promise<Response> => {
  let first = await read(id, 0, signal)
  while (first.status === undefined && first.state === 'running') {
    await delay(220, signal)
    first = await read(id, 0, signal)
  }
  if (first.status === undefined) {throw terminalFailure(first)}
  if (first.status < 200 || first.status >= 300) {
    if (first.status === 400) {
      const inputLimit = await readInputLimit(id, first, signal)
      if (inputLimit) {throw inputLimit}
    }
    const authError = first.status === 401 || first.status === 403
    throw new ApiError('http', authError ? '个人 API Key 或模型权限不可用。' : `个人聊天服务返回 HTTP ${first.status}。`,
      first.status, authError ? 'personal_auth' : 'personal_request')
  }
  const status = first.status
  const contentType = first.contentType
  if (status === 204 || status === 205 || !contentType?.toLowerCase().includes('text/event-stream')) {
    throw new ApiError('protocol', '个人聊天服务没有返回流式回复。', status, 'personal_protocol')
  }
  let offset = 0
  let initial: NativeChatFrame | undefined = first
  let detached = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!detached) {
          signal.throwIfAborted()
          const frame = initial ?? await read(id, offset, signal)
          initial = undefined
          if (detached) {return}
          offset = frame.nextOffset
          if (frame.chunk?.byteLength) {
            controller.enqueue(frame.chunk)
            return
          }
          if (frame.state === 'done') {controller.close(); return}
          if (frame.state !== 'running') {throw terminalFailure(frame)}
          await delay(220, signal)
        }
      } catch (error) {
        if (!detached) {controller.error(error)}
      }
    },
    cancel() {detached = true},
  })
  return new Response(stream, { status, headers: { 'Content-Type': contentType } })
}

export const cancelNativeChat = async (id: string): Promise<void> => {
  const result = await requestNativeBackgroundChat('cancel', { jobId: id })
  if (result.state === 'failed' && result.code !== 'personal_chat_not_found') {
    throw failure(typeof result.code === 'string' ? result.code : 'personal_chat_failed')
  }
}
