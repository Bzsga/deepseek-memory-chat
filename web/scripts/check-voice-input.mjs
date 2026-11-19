import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

// Exercise the actual recorder with synthetic device nodes. The offline stub checks
// rate, length and source-buffer wiring; browser resampling quality is not mocked proof.
const source = readFileSync(new URL('../src/services/speech/recorder.ts', import.meta.url), 'utf8')
const { startRecording } = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`
)
globalThis.fetch = () => {
  throw Error('Voice recorder checks must never make network requests')
}

const fixture = ({
  sampleRate = 48000,
  initialState = 'running',
  resumedState = 'running',
  resume,
  permissionError,
  offlineAvailable = true,
  renderError,
  disconnectError = false,
} = {}) => {
  const calls = {
    permission: 0,
    constraints: [],
    options: [],
    resume: 0,
    close: 0,
    stop: 0,
    disconnect: 0,
    offline: [],
  }
  let processor
  const node = () => ({
    connect() {},
    disconnect() {
      calls.disconnect++
      if (disconnectError) throw Error('Synthetic disconnect failure')
    },
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        async getUserMedia(constraints) {
          calls.permission++
          calls.constraints.push(constraints)
          if (permissionError) throw permissionError
          return { getTracks: () => [{ stop: () => calls.stop++ }] }
        },
      },
    },
  })
  globalThis.AudioContext = class {
    sampleRate = sampleRate
    state = initialState
    destination = node()
    constructor(options) {
      calls.options.push(options)
    }
    createMediaStreamSource() {
      return node()
    }
    createScriptProcessor() {
      processor = { ...node(), onaudioprocess: null }
      return processor
    }
    createAnalyser() {
      return node()
    }
    async resume() {
      calls.resume++
      await resume?.()
      this.state = resumedState
    }
    async close() {
      calls.close++
      this.state = 'closed'
    }
  }
  globalThis.OfflineAudioContext = offlineAvailable
    ? class {
        destination = node()
        constructor(channels, length, rate) {
          assert.equal(channels, 1)
          this.length = length
          this.sampleRate = rate
          calls.offline.push({ channels, length, sampleRate: rate })
        }
        createBuffer(channels, length, rate) {
          assert.equal(channels, 1)
          const channel = new Float32Array(length)
          return { length, sampleRate: rate, getChannelData: () => channel }
        }
        createBufferSource() {
          const source = { ...node(), buffer: null, start() {} }
          this.source = source
          return source
        }
        async startRendering() {
          if (renderError) throw renderError
          const input = this.source.buffer
          assert.equal(input.sampleRate, sampleRate)
          const samples = input.getChannelData(0)
          const output = this.createBuffer(1, this.length, this.sampleRate)
          const channel = output.getChannelData(0)
          // Constant and impulse inputs below only need deterministic sample selection.
          for (let index = 0; index < channel.length; index++) {
            channel[index] =
              samples[
                Math.min(samples.length - 1, Math.floor((index * sampleRate) / this.sampleRate))
              ]
          }
          return output
        }
      }
    : undefined
  return {
    calls,
    feed(samples) {
      processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } })
    },
    assertReleased() {
      assert.equal(calls.stop, 1, 'Microphone tracks must be stopped exactly once')
      assert.equal(calls.close, 1, 'The hardware audio context must be closed exactly once')
      assert.equal(processor?.onaudioprocess ?? null, null)
    },
  }
}

const cases = []
const check = async (name, run) => {
  await run()
  cases.push(name)
}
const wav = async (blob) => {
  assert.equal(blob?.type, 'audio/wav')
  const bytes = await blob.arrayBuffer()
  const view = new DataView(bytes)
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF')
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), 'WAVE')
  assert.equal(view.getUint16(20, true), 1)
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint32(28, true), 32000)
  assert.equal(view.getUint16(32, true), 2)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(view.getUint32(40, true), bytes.byteLength - 44)
  return view
}

await check('48 kHz capture uses default hardware context and emits 16 kHz WAV', async () => {
  const device = fixture()
  const recording = await startRecording(() => assert.fail('Unexpected limit'))
  assert.deepEqual(device.calls.constraints, [{ audio: true }], 'Use device capture defaults')
  assert.deepEqual(device.calls.options, [undefined], 'Do not force a hardware sample rate')
  device.feed(new Float32Array(48000).fill(0.5))
  assert.equal(recording.durationSeconds(), 1)
  const view = await wav(await recording.stop())
  assert.equal(view.byteLength, 32044)
  assert.equal(view.getInt16(44, true), 16383)
  assert.deepEqual(device.calls.offline, [{ channels: 1, length: 16000, sampleRate: 16000 }])
  recording.cancel()
  device.assertReleased()
})

await check('16 kHz capture does not require an offline context', async () => {
  const device = fixture({ sampleRate: 16000, offlineAvailable: false })
  const recording = await startRecording(() => {})
  device.feed(new Float32Array([-1, 0, 1]))
  const view = await wav(await recording.stop())
  assert.equal(view.getInt16(44, true), -32768)
  assert.equal(view.getInt16(48, true), 32767)
  assert.equal(device.calls.offline.length, 0)
  device.assertReleased()
})

await check('no frames and quantized all-zero frames return null', async () => {
  for (const samples of [null, new Float32Array(4096), new Float32Array(4096).fill(1e-9)]) {
    const device = fixture()
    const recording = await startRecording(() => {})
    if (samples) device.feed(samples)
    assert.equal(await recording.stop(), null)
    recording.cancel()
    device.assertReleased()
  }
  const device = fixture()
  const recording = await startRecording(() => {})
  device.feed(new Float32Array(4096).fill(0.0001))
  assert.ok(await recording.stop(), 'Quiet nonzero PCM must not be rejected by a VAD threshold')
  device.assertReleased()
})

await check('permission denial creates no audio context', async () => {
  const device = fixture({
    permissionError: new DOMException('Synthetic denial', 'NotAllowedError'),
  })
  await assert.rejects(
    startRecording(() => {}),
    { name: 'NotAllowedError' }
  )
  assert.equal(device.calls.permission, 1)
  assert.equal(device.calls.options.length, 0)
})

await check('resume is awaited before recording is returned', async () => {
  let resolveResume
  const device = fixture({
    initialState: 'suspended',
    resume: () =>
      new Promise((resolve) => {
        resolveResume = resolve
      }),
  })
  let returned = false
  const pending = startRecording(() => {}).then((value) => {
    returned = true
    return value
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(returned, false)
  resolveResume()
  const recording = await pending
  assert.equal(device.calls.resume, 1)
  recording.cancel()
  device.assertReleased()
})

await check('failed resume and non-running state release all resources', async () => {
  for (const options of [
    {
      resume: () =>
        Promise.reject(new DOMException('Synthetic resume failure', 'NotReadableError')),
      name: 'NotReadableError',
    },
    { resumedState: 'suspended', name: 'AbortError' },
  ]) {
    const device = fixture({ initialState: 'suspended', disconnectError: true, ...options })
    await assert.rejects(
      startRecording(() => {}),
      { name: options.name }
    )
    assert.equal(device.calls.disconnect, 3)
    device.assertReleased()
  }
})

await check('cancelling while resume is pending releases the microphone immediately', async () => {
  let resolveResume
  const device = fixture({
    initialState: 'suspended',
    resume: () =>
      new Promise((resolve) => {
        resolveResume = resolve
      }),
  })
  const controller = new AbortController()
  const pending = startRecording(() => {}, controller.signal)
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  device.assertReleased()
  resolveResume()
  await assert.rejects(pending, { name: 'AbortError' })
  device.assertReleased()
})

await check('missing resampling support fails explicitly and releases the microphone', async () => {
  const device = fixture({ offlineAvailable: false })
  await assert.rejects(
    startRecording(() => {}),
    { name: 'NotSupportedError' }
  )
  device.assertReleased()
})

await check('cancel releases once and prevents further capture', async () => {
  const device = fixture()
  const recording = await startRecording(() => assert.fail('Unexpected limit'))
  device.feed(new Float32Array(4096).fill(0.5))
  const duration = recording.durationSeconds()
  recording.cancel()
  recording.cancel()
  device.feed(new Float32Array(4096).fill(0.5))
  assert.equal(recording.durationSeconds(), duration)
  device.assertReleased()
})

await check('resampling failure occurs after hardware release', async () => {
  const device = fixture({
    renderError: new DOMException('Synthetic render failure', 'NotSupportedError'),
  })
  const recording = await startRecording(() => {})
  device.feed(new Float32Array(4096).fill(0.5))
  await assert.rejects(recording.stop(), { name: 'NotSupportedError' })
  recording.cancel()
  device.assertReleased()
})

await check('120-second input cap is exact and produces less than 8 MiB', async () => {
  const device = fixture()
  let limits = 0
  const recording = await startRecording(() => limits++)
  const second = new Float32Array(48000).fill(0.5)
  for (let index = 0; index < 122; index++) device.feed(second)
  assert.equal(recording.durationSeconds(), 120)
  assert.equal(limits, 1)
  const audio = await recording.stop()
  await wav(audio)
  assert.equal(audio.size, 3840044)
  assert.ok(audio.size < 8 * 1024 * 1024)
  device.assertReleased()
})

console.log(
  JSON.stringify(
    {
      evidence: 'Synthetic recorder unit checks; no microphone, browser playback or ASR requests',
      cases,
      passed: cases.length,
    },
    null,
    2
  )
)
