/**
 * 录音并编码为 ASR 接受的 WAV（单声道、16-bit PCM、16kHz）。
 *
 * AudioContext 使用设备默认采样率采集；停止后由 OfflineAudioContext 重采样为 16kHz。
 * 录音处理在页面内完成。
 */
export const SAMPLE_RATE = 16000
/** ASR 单次时长上限 120 秒 */
export const MAX_SECONDS = 120

const BUFFER_SIZE = 4096

export type Recording = {
  /** 停止录音并返回 WAV；没有样本或 PCM 量化后全为零时返回 null */
  stop: () => Promise<Blob | null>
  /** 放弃录音，释放麦克风 */
  cancel: () => void
  /** 频谱分析节点，只读；采样率与录音一致 */
  analyser: AnalyserNode
  /** 实际采集的时长，不包含等待麦克风授权的时间 */
  durationSeconds: () => number
}

/** 开始录音；到达时长上限时调用 onLimit，由调用方决定何时 stop */
export const startRecording = async (
  onLimit: () => void,
  signal?: AbortSignal
): Promise<Recording> => {
  // 由设备选择采集设置；单声道与 16kHz 转换在 Web Audio 中完成。
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  let context: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let processor: ScriptProcessorNode | undefined
  let analyser: AnalyserNode | undefined
  let released = false

  const release = () => {
    if (released) {
      return
    }
    released = true
    signal?.removeEventListener('abort', release)
    if (processor) {
      processor.onaudioprocess = null
    }
    // 初始化可能只完成了一部分；单个节点断开失败也不能阻止麦克风释放。
    for (const node of [processor, analyser, source]) {
      try {
        node?.disconnect()
      } catch {
        // 继续释放其余资源。
      }
    }
    for (const track of stream.getTracks()) {
      track.stop()
    }
    void context?.close().catch(() => {})
  }

  try {
    signal?.addEventListener('abort', release, { once: true })
    if (signal?.aborted) {
      release()
      signal.throwIfAborted()
    }
    // 使用设备首选采样率，避免部分设备无法连接强制 16kHz 的硬件上下文。
    context = new AudioContext()
    const sampleRate = context.sampleRate
    if (sampleRate !== SAMPLE_RATE && typeof OfflineAudioContext !== 'function') {
      throw new DOMException('This browser cannot resample microphone audio', 'NotSupportedError')
    }
    const maxSamples = MAX_SECONDS * sampleRate
    source = context.createMediaStreamSource(stream)
    processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1)
    // 频谱分析用：串在录音链路中间（原样透传），WebKit 不会处理未连到输出的分析节点
    analyser = context.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.2
    const chunks: Float32Array[] = []
    let length = 0
    let limited = false
    processor.onaudioprocess = (event) => {
      if (limited) {
        return
      }
      const input = event.inputBuffer.getChannelData(0)
      const count = Math.min(input.length, maxSamples - length)
      chunks.push(new Float32Array(input.subarray(0, count)))
      length += count
      if (length >= maxSamples) {
        limited = true
        onLimit()
      }
    }
    source.connect(analyser)
    analyser.connect(processor)
    // ScriptProcessorNode 只有连到输出才会持续回调；输出缓冲保持静音
    processor.connect(context.destination)
    // 在 await getUserMedia 之后创建，iOS 上可能处于 suspended
    if (context.state === 'suspended') {
      await context.resume()
    }
    if (signal?.aborted || context.state !== 'running') {
      throw new DOMException('Microphone audio context did not start', 'AbortError')
    }

    return {
      stop: async () => {
        release()
        if (length === 0) {
          return null
        }
        if (sampleRate === SAMPLE_RATE) {
          return encodeWav(chunks, length)
        }
        const offline = new OfflineAudioContext(
          1,
          Math.ceil((length * SAMPLE_RATE) / sampleRate),
          SAMPLE_RATE
        )
        const input = offline.createBuffer(1, length, sampleRate)
        const channel = input.getChannelData(0)
        let offset = 0
        for (const chunk of chunks) {
          channel.set(chunk, offset)
          offset += chunk.length
        }
        chunks.length = 0
        const source = offline.createBufferSource()
        source.buffer = input
        source.connect(offline.destination)
        source.start()
        const resampled = await offline.startRendering()
        return encodeWav([resampled.getChannelData(0)], resampled.length)
      },
      cancel: () => {
        release()
        chunks.length = 0
      },
      analyser,
      durationSeconds: () => length / sampleRate,
    }
  } catch (error) {
    release()
    throw error
  }
}

const encodeWav = (chunks: Float32Array[], length: number) => {
  const samples = Math.min(length, MAX_SECONDS * SAMPLE_RATE)
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, samples * 2, true)
  let offset = 44
  let written = 0
  let hasAudio = false
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length && written < samples; i++, written++) {
      const sample = Number.isFinite(chunk[i]) ? Math.max(-1, Math.min(1, chunk[i])) : 0
      const pcm = Math.trunc(sample < 0 ? sample * 0x8000 : sample * 0x7fff)
      hasAudio ||= pcm !== 0
      view.setInt16(offset, pcm, true)
      offset += 2
    }
  }
  return hasAudio ? new Blob([buffer], { type: 'audio/wav' }) : null
}
