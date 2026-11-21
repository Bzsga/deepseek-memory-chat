import {
  nativePersonalImageChannel,
  subscribeNativeBridge,
  subscribeNativeImageFrames,
} from './nativeBridge.js'

type ImageRequest = {
  operation: 'models' | 'generate' | 'edit'
  url: string
  key: string
  model?: string
  prompt?: string
  files?: readonly File[]
}

const CHUNK_BYTES = 96 * 1024
const RESULT_CHUNK_LENGTH = 128 * 1024
const MAX_ACTIVE = 2
let active = 0
let sequence = 0
const waiting = new Set<() => void>()

function acquire(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (active < MAX_ACTIVE) {
    active++
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const ready = () => {
      waiting.delete(ready)
      signal?.removeEventListener('abort', abort)
      active++
      resolve()
    }
    const abort = () => {
      waiting.delete(ready)
      reject(signal?.reason)
    }
    waiting.add(ready)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export async function requestNativePersonalImage(
  channel: MessagePort,
  request: ImageRequest,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<unknown> {
  await acquire(signal)
  try {
    signal?.throwIfAborted()
    if (channel !== nativePersonalImageChannel() || !isCurrent()) {
      throw new Error('生图配置或连接已变化，请重新提交。')
    }
    return await exchange(channel, request, signal)
  } finally {
    active--
    waiting.values().next().value?.()
  }
}

function exchange(channel: MessagePort, { files, ...request }: ImageRequest, signal?: AbortSignal): Promise<unknown> {
  const id = `image-${Date.now()}-${++sequence}`
  const limit = (request.operation === 'models' ? 2 : 29) * 1024 * 1024
  return new Promise((resolve, reject) => {
    const chunks: string[] = []
    let length = 0
    let dispatched = false
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let ack: { resolve: () => void; reject: (reason: unknown) => void } | undefined

    const post = (type: string, payload?: object) => {
      channel.postMessage(JSON.stringify({ version: 1, id, type, ...payload }))
    }
    const cleanup = () => {
      finished = true
      clearTimeout(timer)
      detachBridge()
      detachFrames()
      signal?.removeEventListener('abort', abort)
      chunks.length = 0
    }
    const fail = (error: unknown) => {
      if (finished) {
        return
      }
      ack?.reject(error)
      ack = undefined
      cleanup()
      if (nativePersonalImageChannel() === channel) {
        try {post('image.cancel')} catch { /* The port may already be closed. */ }
      }
      reject(error)
    }
    const abort = () => fail(signal?.reason)
    const setTimeoutFor = (ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => fail(new Error('个人生图服务暂时未响应，请检查连接。')), ms)
    }
    const invalid = () => new Error('个人生图服务返回了无效的响应。')
    const detachBridge = subscribeNativeBridge(() => {
      if (nativePersonalImageChannel() !== channel) {
        fail(new Error('个人生图连接已中断。'))
      }
    })
    const detachFrames = subscribeNativeImageFrames((frame) => {
      if (frame.id !== id) {
        return
      }
      switch (frame.type) {
        case 'image.ack':
          ack?.resolve()
          ack = undefined
          break
        case 'image.result': {
          const part = frame.data
          if (!dispatched || typeof part !== 'string' || !part.length ||
              part.length > RESULT_CHUNK_LENGTH || length + part.length > limit) {
            fail(invalid())
            break
          }
          chunks.push(part)
          length += part.length
          break
        }
        case 'image.done':
          if (!dispatched) {
            fail(invalid())
            break
          }
          try {
            const result: unknown = JSON.parse(chunks.join(''))
            cleanup()
            resolve(result)
          } catch {
            fail(invalid())
          }
          break
        case 'image.error':
          fail(typeof frame.message === 'string' && frame.message.length <= 300
            ? new Error(frame.message) : invalid())
          break
      }
    })
    signal?.addEventListener('abort', abort, { once: true })
    const uploadFrame = (type: string, payload: object) => new Promise<void>((accept, decline) => {
      if (finished) {
        decline(new Error('个人生图连接已中断。'))
        return
      }
      ack = { resolve: accept, reject: decline }
      setTimeoutFor(30_000)
      try {post(type, payload)} catch (error) {fail(error)}
    })
    void (async () => {
      await uploadFrame('image.request', {
        ...request,
        files: files?.map(file => ({ name: file.name, mime: file.type, size: file.size })),
      })
      for (const [index, file] of (files ?? []).entries()) {
        for (let offset = 0; offset < file.size && !finished; offset += CHUNK_BYTES) {
          const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
          let chunk = ''
          for (let start = 0; start < bytes.length; start += 8192) {
            chunk += String.fromCharCode(...bytes.subarray(start, start + 8192))
          }
          await uploadFrame('image.chunk', { index, data: btoa(chunk) })
        }
      }
      if (!finished) {
        dispatched = true
        setTimeoutFor(request.operation === 'models' ? 35_000 : 310_000)
        post('image.run')
      }
    })().catch(fail)
  })
}
