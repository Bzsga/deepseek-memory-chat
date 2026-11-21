import { request, API_ORIGIN } from './client.js'

export type ImageJobState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'expired'
export type LocalImageJobState = ImageJobState | 'submitting' | 'recoverable' | 'cancelling'
export type LocalImageJob = {
  prompts?: string[]
  provider?: 'personal'
  clientRequestId: string
  ownerId: string
  state: LocalImageJobState
  createdAt: number
  cancelRequested?: boolean
  error?: { code: string; message: string }
}
export type ImageJob = {
  id: string
  client_request_id: string
  status: ImageJobState
  model: string
  created_at: string
  updated_at: string
  expires_at: string
  has_result: boolean
  error?: { code: string; message: string }
}

const states = new Set<ImageJobState>([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'unknown',
  'expired',
])
const base = `${API_ORIGIN}/api/image-jobs`

const identifier = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(value)) {
    throw new Error('图片任务标识无效。')
  }
  return encodeURIComponent(value)
}

export const readJson = async (response: Response, maximum: number): Promise<unknown> => {
  if (Number(response.headers.get('Content-Length')) > maximum || !response.body) {
    throw new Error('图片任务响应无效。')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      length += chunk.value.byteLength
      if (length > maximum) {
        throw new Error('图片任务响应过大。')
      }
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

const metadata = (value: unknown, expectedId: string): ImageJob => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('图片任务响应无效。')
  }
  const job = value as Partial<ImageJob>
  if (
    typeof job.id !== 'string' ||
    job.id.length > 128 ||
    job.client_request_id !== expectedId ||
    !states.has(job.status as ImageJobState) ||
    typeof job.model !== 'string' ||
    job.model.length > 128 ||
    typeof job.has_result !== 'boolean' ||
    ![job.created_at, job.updated_at, job.expires_at].every(
      (time) => typeof time === 'string' && Number.isFinite(Date.parse(time))
    ) ||
    (job.error !== undefined &&
      (typeof job.error !== 'object' ||
        job.error === null ||
        typeof job.error.code !== 'string' ||
        job.error.code.length > 100 ||
        typeof job.error.message !== 'string' ||
        job.error.message.length > 1000))
  ) {
    throw new Error('图片任务响应无效。')
  }
  return job as ImageJob
}

const exchange = async <T>(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
  maximum: number,
  timeout: number,
  read: (value: unknown) => T
): Promise<T> => {
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) {
    abort()
  }
  const timer = setTimeout(() => controller.abort(new Error('图片任务连接暂时超时。')), timeout)
  try {
    const response = await request(path, { ...init, signal: controller.signal })
    return read(await readJson(response, maximum))
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

export const createImageJob = (
  clientRequestId: string,
  prompt: string,
  signal: AbortSignal,
  sources?: readonly File[]
): Promise<ImageJob> => {
  identifier(clientRequestId)
  let submission: RequestInit
  if (sources) {
    if (sources.length === 0) {throw new Error('请至少选择一张参考图。')}
    const form = new FormData()
    form.set('client_request_id', clientRequestId)
    form.set('prompt', prompt)
    for (const source of sources) {form.append('image', source)}
    // Fetch keepalive rejects upload bodies above its small shared limit.
    submission = { method: 'POST', body: form }
  } else {
    submission = {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_request_id: clientRequestId, prompt }),
    }
  }
  return exchange(
    base,
    submission,
    signal,
    32768,
    sources ? 180000 : 20000,
    (value) => metadata(value, clientRequestId)
  )
}

export const getImageJob = (clientRequestId: string, signal: AbortSignal): Promise<ImageJob> =>
  exchange(
    `${base}/${identifier(clientRequestId)}`,
    { method: 'GET', cache: 'no-store' },
    signal,
    32768,
    20000,
    (value) => metadata(value, clientRequestId)
  )

export const cancelRemoteImageJob = (
  clientRequestId: string,
  signal: AbortSignal
): Promise<ImageJob> =>
  exchange(
    `${base}/${identifier(clientRequestId)}/cancel`,
    { method: 'POST', keepalive: true },
    signal,
    32768,
    20000,
    (value) => metadata(value, clientRequestId)
  )

export const getImageJobResult = (clientRequestId: string, signal: AbortSignal): Promise<unknown> =>
  exchange(
    `${base}/${identifier(clientRequestId)}/result`,
    { method: 'GET', cache: 'no-store' },
    signal,
    32 * 1024 * 1024,
    180000,
    (value) => value
  )

export const imageJobIsTerminal = (state: LocalImageJobState): boolean =>
  ['completed', 'failed', 'cancelled', 'unknown', 'expired'].includes(state)
