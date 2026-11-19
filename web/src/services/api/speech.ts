import { ApiError, requestChatApi } from './client.js'
import type { TranslationMessage } from '../../i18n/index.js'

/**
 * 语音接口：
 * - ASR：POST /v1/tools/asr，multipart 上传 WAV / Ogg Opus，一次返回全文
 * - TTS：POST /v1/tools/tts，返回音频字节流（产出首帧后即返回 200）
 * 根据当前冻结的聊天服务选择同源配套或官方个人接口。
 */
export type TtsVoice = 'stella' | 'tide'

/** TTS 输出的裸 PCM 参数：24kHz、单声道、16-bit 小端 */
export const TTS_SAMPLE_RATE = 24000

/** 语音识别：audio 为 WAV（单声道 16-bit PCM）或 Ogg Opus，时长不超过 120 秒、大小不超过 8 MiB */
export const transcribe = async (
  apiKey: string,
  audio: Blob,
  signal?: AbortSignal
): Promise<string> => {
  if (audio.size === 0) {
    throw new ApiError('protocol', { key: 'voiceInputEmpty' })
  }
  if (audio.size > 8 * 1024 * 1024) {
    throw new ApiError('protocol', { key: 'voiceInputTooLarge' })
  }
  const header = new Uint8Array(await audio.slice(0, 12).arrayBuffer())
  const magic = String.fromCharCode(...header)
  const extension =
    magic.startsWith('RIFF') && magic.slice(8) === 'WAVE'
      ? 'wav'
      : magic.startsWith('OggS')
        ? 'ogg'
        : null
  if (!extension) {
    throw new ApiError('protocol', { key: 'voiceInputFormatError' })
  }
  const form = new FormData()
  form.append('file', audio, `recording.${extension}`)
  const response = await requestChatApi(apiKey, '/v1/tools/asr', {
    method: 'POST',
    body: form,
    signal,
  })
  let raw: string
  try {
    raw = await response.text()
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    throw new ApiError('network', { key: 'voiceInputNetworkError' })
  }
  if (raw.length > 256 * 1024) {
    throw new ApiError('protocol', { key: 'voiceInputInvalidResponse' })
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new ApiError('protocol', { key: 'voiceInputInvalidResponse' })
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    !('text' in body) ||
    typeof body.text !== 'string'
  ) {
    throw new ApiError('protocol', { key: 'voiceInputInvalidResponse' })
  }
  return body.text
}

/** Preserve bounded gateway explanations without exposing raw proxy pages. */
export const describeTranscriptionError = (error: unknown): TranslationMessage | string => {
  if (!(error instanceof ApiError)) {
    return { key: 'voiceInputFailed' }
  }
  if (error.localMessage) {
    return error.localMessage
  }
  if (error.code?.startsWith('personal_')) {
    return error.message
  }
  if (error.kind === 'network') {
    return { key: 'voiceInputNetworkError' }
  }
  if (error.kind === 'protocol') {
    return { key: 'voiceInputInvalidResponse' }
  }
  const message = error.message.trim()
  if (
    message.length <= 300 &&
    /[\u3400-\u9fff]/.test(message) &&
    !/[<>\r\n]/.test(message) &&
    !/(?:bearer|api.?key|sk-[a-z0-9]|https?:\/\/|traceback)/i.test(message)
  ) {
    return message
  }
  switch (error.status) {
    case 400:
    case 415:
    case 422:
      return { key: 'voiceInputFormatError' }
    case 413:
      return { key: 'voiceInputTooLarge' }
    case 401:
      return { key: 'voiceInputSignIn' }
    case 408:
    case 504:
      return { key: 'voiceInputTimeout' }
    case 429:
    case 503:
      return { key: 'voiceInputServiceBusy' }
    default:
      return { key: 'voiceInputServiceUnavailable' }
  }
}

/** 语音合成：返回裸 PCM 字节流；服务端默认过滤代码块、表格、引用标记与长公式 */
export const synthesize = async (
  apiKey: string,
  text: string,
  voice: TtsVoice,
  signal: AbortSignal
): Promise<ReadableStream<Uint8Array>> => {
  const response = await requestChatApi(apiKey, '/v1/tools/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, format: 'pcm', filter_markdown: true }),
    signal,
  })
  if (!response.body) {
    throw new ApiError('protocol', '语音服务未返回音频，请稍后手动重试。')
  }
  return response.body
}
