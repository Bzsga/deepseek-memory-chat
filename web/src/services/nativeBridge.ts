/** A single bounded channel established by the Android host for this exact main page. */
const TRUSTED_ORIGIN = 'https://digimonlegend.com'
const MAX_BYTES = 2 * 1024 * 1024
const listeners = new Set<() => void>()
const pending = new Map<
  string,
  { resolve: () => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }
>()
let port: MessagePort | undefined
let supportsSettingsSections = false
let organizationUsesChatProvider = false
let privateCapabilities = { provider: false, theme: false }
export const nativePreferenceChannel = (kind: 'provider' | 'theme') =>
  privateCapabilities[kind] ? port : undefined
let bound = false
let receiveContinuation: ((payload: unknown, id: string) => Promise<void>) | undefined
let sequence = 0

export const isNativeConnected = () => port !== undefined
export const nativeSettingsAccess = () =>
  !port ? 'web' : supportsSettingsSections ? 'sections' : 'legacy'
export const hasSeparateOrganizationSettings = () =>
  !!port && supportsSettingsSections && !organizationUsesChatProvider
export type NativeSettingsSection = 'service' | 'data' | 'about' | 'developer'
export const openNativeSettings = (section?: NativeSettingsSection) =>
  sendNative('settings.open', supportsSettingsSections && section ? { section } : undefined)

export const subscribeNativeBridge = (notify: () => void) => {
  listeners.add(notify)
  return () => {
    listeners.delete(notify)
  }
}
const notify = () => listeners.forEach((listener) => listener())
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
const encode = (value: unknown) => {
  const json = JSON.stringify(value)
  if (new TextEncoder().encode(json).byteLength > MAX_BYTES) {
    throw new Error('内容过长，请减少本次选择的聊天。')
  }
  return json
}
const close = () => {
  port?.close()
  port = undefined
  supportsSettingsSections = false
  organizationUsesChatProvider = false
  privateCapabilities = { provider: false, theme: false }
  for (const item of pending.values()) {
    clearTimeout(item.timer)
    item.reject(new Error('连接已刷新，请重试。'))
  }
  pending.clear()
  notify()
}

export const bindNativeBridge = (
  onContinuation: (payload: unknown, id: string) => Promise<void>,
  archive?: { identity: () => Promise<{ ownerId: string; guest: boolean }>; frame: (payload: unknown, live: () => boolean) => Promise<void> }
) => {
  receiveContinuation = onContinuation
  if (bound) {
    return
  }
  bound = true
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (
      window.top !== window ||
      location.origin !== TRUSTED_ORIGIN ||
      location.pathname !== '/deepseek/' ||
      !(
        event.origin === TRUSTED_ORIGIN ||
        (event.source === null && (event.origin === '' || event.origin === 'null'))
      ) ||
      event.ports.length !== 1 ||
      typeof event.data !== 'string' ||
      event.data.length > 256
    ) {
      return
    }
    let hello: {
      type?: unknown
      version?: unknown
      archiveImport?: unknown
      settingsSections?: unknown
      organizationUsesChatProvider?: unknown
      chatProvider?: unknown
      themePreference?: unknown
    }
    try {
      hello = JSON.parse(event.data) as typeof hello
    } catch {
      return
    }
    if (hello.type !== 'deepseek.connect' || hello.version !== 1) {
      return
    }
    close()
    const channel = event.ports[0]
    // Android WebView.postWebMessage originates in the host. Window.postMessage
    // supplies a WindowProxy source; script-created MessageEvents are untrusted.
    const host = event.isTrusted && event.source === null
    privateCapabilities = {
      provider: host && hello.chatProvider === true,
      theme: host && hello.themePreference === true,
    }
    supportsSettingsSections = hello.settingsSections === true
    organizationUsesChatProvider = host && hello.organizationUsesChatProvider === true
    port = channel
    channel.onmessage = async (message: MessageEvent<unknown>) => {
      if (
        channel !== port ||
        typeof message.data !== 'string' ||
        new TextEncoder().encode(message.data).byteLength > MAX_BYTES
      ) {
        return
      }
      let value: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(message.data)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return
        }
        value = parsed as Record<string, unknown>
      } catch {
        return
      }
      if (value.version !== 1 || !validId(value.id)) {
        return
      }
      const id = value.id
      if (value.type === 'ack') {
        const task = pending.get(id)
        if (task) {
          clearTimeout(task.timer)
          pending.delete(id)
          if (value.ok === true) {
            task.resolve()
          } else {
            task.reject(
              new Error(
                typeof value.error === 'string'
                  ? value.error.slice(0, 300)
                  : '这次没有完成，请重试。'
              )
            )
          }
        }
        return
      }
      const archiveFrame = value.type === 'archive.frame' && host && hello.archiveImport === true && archive
      if (!archiveFrame && value.type !== 'continuation.create') {
        return
      }
      try {
        if (archiveFrame) {await archiveFrame.frame(value.payload, () => port === channel)}
        else {await receiveContinuation?.(value.payload, id)}
        if (channel === port) {
          channel.postMessage(encode({ version: 1, id, type: 'ack', ok: true }))
        }
      } catch (error) {
        if (channel === port) {
          channel.postMessage(
            encode({
              version: 1,
              id,
              type: 'ack',
              ok: false,
              error:
                error instanceof Error ? error.message.slice(0, 300) : '无法保存续聊，请重试。',
            })
          )
        }
      }
    }
    channel.start()
    if (host && hello.archiveImport === true && archive) {
      void archive.identity().then(async identity => {
        if (port === channel) {await sendNative('archive.ready', identity)}
      }).catch(() => {})
    }
    notify()
  })
  window.addEventListener('pagehide', close)
}

export const sendNative = (
  type:
    | 'archive.ready'
    | 'organize'
    | 'memory.open'
    | 'account.open'
    | 'settings.open'
    | 'share.link'
    | 'chat.provider'
    | 'chat.theme',
  payload?: unknown
): Promise<void> => {
  const channel = port
  if (
    !channel ||
    (type === 'chat.provider' && !privateCapabilities.provider) ||
    (type === 'chat.theme' && !privateCapabilities.theme)
  ) {
    return Promise.reject(new Error('请在 App 中打开记忆功能。'))
  }
  if (pending.size >= 4) {
    return Promise.reject(new Error('正在处理，请稍候。'))
  }
  const id = `web-${Date.now()}-${++sequence}`
  let body: string
  try {
    body = encode({ version: 1, id, type, ...(payload === undefined ? {} : { payload }) })
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('暂时未收到回应，请重试。'))
    }, 30000)
    pending.set(id, { resolve, reject, timer })
    try {
      channel.postMessage(body)
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      reject(error instanceof Error ? error : new Error('连接已中断。'))
    }
  })
}
