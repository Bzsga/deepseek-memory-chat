import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { ApiError } from '../api/client.js'
import { classifyApiError } from '../api/errors.js'
import { synthesize, TTS_SAMPLE_RATE } from '../api/speech.js'
import { captureChatProvider } from '../chatProvider.js'
import { OFFICIAL_BASE } from '../providerEndpoint.js'
import { getRuntime, isSessionActive } from '../runtime.js'
import { useSettings } from '../settings.js'

/**
 * 朗读：同一时间只读一条回复。
 * 请求 TTS 的裸 PCM 流，边收边用 AudioContext 按顺序排程播放，首帧到达即出声。
 * 状态：loading（已请求、未出声）→ playing → 结束回到 idle。
 */
export type ReadAloudStatus = 'idle' | 'loading' | 'playing'

type ReadAloudState = {
  /** 正在朗读的回复 id */
  messageId: string | null
  status: ReadAloudStatus
}

export const useReadAloud = create<ReadAloudState>(() => ({ messageId: null, status: 'idle' }))

/** 首帧前多缓冲一点，减少网络抖动造成的断续 */
const START_DELAY = 0.1
const AUTO_RESUME_TIMEOUT_MS = 500

type Playback = {
  controller: AbortController
  context: AudioContext
  cleanup?: () => void
}

let current: Playback | null = null

const finish = (playback: Playback) => {
  if (current !== playback) {
    return
  }
  current = null
  playback.cleanup?.()
  void playback.context.close().catch(() => {})
  useReadAloud.setState({ messageId: null, status: 'idle' })
}

/** 停止当前朗读（发送、停止生成、切换会话等场景调用） */
export const stopReadAloud = () => {
  const playback = current
  if (playback) {
    playback.controller.abort()
    finish(playback)
  }
}

/** 16-bit 小端 PCM 转成 Float32；奇数字节留到下一段 */
const toFloat32 = (bytes: Uint8Array) => {
  const samples = new Float32Array(bytes.length >> 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000
  }
  return samples
}

export const describeReadAloudError = (error: unknown): TranslationMessage | string => {
  if (error instanceof ApiError && error.kind === 'protocol') {
    return error.message
  }
  // 400 表示这段正文服务端无法合成，与其余失败区分开
  if (error instanceof ApiError && error.status === 400) {
    return { key: 'ttsUnavailable' }
  }
  switch (classifyApiError(error)) {
    case 'unauthorized':
      return { key: 'apiKeyInvalidRetry' }
    case 'insufficientBalance':
      return { key: 'insufficientBalance' }
    case 'rateLimited':
      return { key: 'rateLimited' }
    default:
      return { key: 'ttsFailed' }
  }
}

const playReply = async (
  playback: Playback,
  messageId: string,
  text: string,
  onError?: (error: unknown) => void
) => {
  const { controller, context } = playback
  const { signal } = controller
  useReadAloud.setState({ messageId, status: 'loading' })
  // 音色在开始朗读时读取，设置中切换后下一次朗读生效
  const { apiKey, ttsVoice } = useSettings.getState()

  let nextTime = 0
  let lastSource: AudioBufferSourceNode | null = null
  let lastSourceEnded = false
  let receivedAll = false
  let rest = new Uint8Array(0)
  try {
    const stream = await synthesize(apiKey ?? '', text, ttsVoice, signal)
    const reader = stream.getReader()
    const cancel = () => void reader.cancel().catch(() => {})
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) {
      cancel()
    }
    try {
      for (;;) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done) {
          receivedAll = true
          break
        }
        const bytes = new Uint8Array(rest.length + value.length)
        bytes.set(rest)
        bytes.set(value, rest.length)
        const samples = toFloat32(bytes)
        rest = bytes.slice(samples.length * 2)
        if (samples.length === 0) {
          continue
        }
        const buffer = context.createBuffer(1, samples.length, TTS_SAMPLE_RATE)
        buffer.copyToChannel(samples, 0)
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        // 网络慢于播放时从当前时间续上，不补播过去的时间
        nextTime = Math.max(nextTime, context.currentTime + (lastSource ? 0 : START_DELAY))
        lastSource = source
        lastSourceEnded = false
        source.onended = () => {
          if (source === lastSource) {
            lastSourceEnded = true
            if (receivedAll) {
              finish(playback)
            }
          }
        }
        source.start(nextTime)
        nextTime += buffer.duration
        if (useReadAloud.getState().status === 'loading') {
          useReadAloud.setState({ status: 'playing' })
        }
      }
    } finally {
      signal.removeEventListener('abort', cancel)
      if (!receivedAll && !signal.aborted) {
        cancel()
      }
      reader.releaseLock()
    }
    if (!lastSource || lastSourceEnded) {
      finish(playback)
    }
  } catch (error) {
    if (!signal.aborted) {
      finish(playback)
      onError?.(error)
    }
  }
}

/** Manual playback starts synchronously in the click gesture. Clicking again stops it. */
export const toggleReadAloud = (
  messageId: string,
  text: string,
  onError: (error: unknown) => void
) => {
  const reading = useReadAloud.getState().messageId
  stopReadAloud()
  if (reading === messageId) {
    return
  }
  try {
    const playback = { controller: new AbortController(), context: new AudioContext({ sampleRate: TTS_SAMPLE_RATE }) }
    current = playback
    void playReply(playback, messageId, text, onError)
  } catch (error) {
    onError(error)
  }
}

const resumeForAutoPlay = async (context: AudioContext) => {
  if (context.state === 'running') {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      context.resume(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, AUTO_RESUME_TIMEOUT_MS) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Automatic playback shares the manual controls but never interrupts a current reading. */
export const autoReadAloudReply = (messageId: string, text: string, stillCurrent: () => boolean) => {
  const canRead = () =>
    document.visibilityState === 'visible' && useSettings.getState().autoReadAloud &&
    isSessionActive() && getRuntime().features.speech && stillCurrent()
  if (current || !text.trim() || typeof AudioContext !== 'function' || typeof document === 'undefined' || !canRead()) {
    return
  }
  let playback: Playback
  try {
    const provider = captureChatProvider()
    if (provider.mode === 'personal' && provider.baseUrl !== OFFICIAL_BASE) {
      return
    }
    playback = { controller: new AbortController(), context: new AudioContext({ sampleRate: TTS_SAMPLE_RATE }) }
  } catch {
    return
  }
  current = playback
  const stopAutomatic = () => {
    if (current === playback) {
      stopReadAloud()
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') {
      stopAutomatic()
    }
  }
  const unsubscribe = useSettings.subscribe((state, previous) => {
    if (!state.autoReadAloud || state.apiKey !== previous.apiKey) {
      stopAutomatic()
    }
  })
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', stopAutomatic)
  playback.cleanup = () => {
    unsubscribe()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', stopAutomatic)
  }
  void resumeForAutoPlay(playback.context).then(() => {
    // A suspended context cannot play, so do not send the text to TTS.
    if (current === playback && playback.context.state === 'running' && canRead()) {
      void playReply(playback, messageId, text)
    } else {
      stopAutomatic()
    }
  }).catch(stopAutomatic)
}
