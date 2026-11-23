/** A single bounded channel established by the Android host for this exact main page. */
const TRUSTED_ORIGIN = 'https://digimonlegend.com'
const MAX_BYTES = 2 * 1024 * 1024
const listeners = new Set<() => void>()
const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout>; mcpInvocation: boolean }
>()
let port: MessagePort | undefined
let supportsSettingsSections = false
let organizationUsesChatProvider = false
let supportsImageOverlayHistory = false
let privateCapabilities = { provider: false, theme: false, memoryRefresh: false }
let supportsPersonalImage = false
let supportsPersonalMcp = false
let supportsPersonalMcpActions = false
let supportsPersonalBackgroundChat = false
let supportsTechnicalDiagnostics = false
const imageFrameListeners = new Set<(frame: Record<string, unknown>) => void>()
export const nativePreferenceChannel = (kind: 'provider' | 'theme') =>
  privateCapabilities[kind] ? port : undefined
export const nativePersonalImageChannel = () => supportsPersonalImage ? port : undefined
export const subscribeNativeImageFrames = (listener: (frame: Record<string, unknown>) => void) => {
  imageFrameListeners.add(listener)
  return () => {imageFrameListeners.delete(listener)}
}
let bound = false
let receiveContinuation: ((payload: unknown, id: string) => Promise<void>) | undefined
let sequence = 0

type ChatBridgeAction = 'start' | 'read' | 'cancel'
const chatRequests = new Map<string, {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
}>()
export class NativeChatBridgeError extends Error {
  constructor(message: string, readonly code: string) { super(message) }
}
export class NativeMcpInvocationInterrupted extends Error {}
export const nativeBackgroundChatAvailable = () => supportsPersonalBackgroundChat && !!port

export const isNativeConnected = () => port !== undefined
export const nativeDiagnosticsAvailable = () => supportsTechnicalDiagnostics && !!port
export const nativePersonalMcpChannel = () => supportsPersonalMcp ? port : undefined
export const nativePersonalMcpAvailable = () => Boolean(nativePersonalMcpChannel())
export const nativePersonalMcpActionsAvailable = () => supportsPersonalMcpActions && nativePersonalMcpAvailable()
export const nativeSettingsAccess = () =>
  !port ? 'web' : supportsSettingsSections ? 'sections' : 'legacy'
export const hasSeparateOrganizationSettings = () =>
  !!port && supportsSettingsSections && !organizationUsesChatProvider
export const canUseImageOverlayHistory = () =>
  port ? supportsImageOverlayHistory : !/\bAndroid\b[^)]*;\s*wv\)/.test(navigator.userAgent)
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
  supportsImageOverlayHistory = false
  supportsPersonalImage = false
  supportsPersonalMcp = false
  supportsPersonalMcpActions = false
  supportsPersonalBackgroundChat = false
  supportsTechnicalDiagnostics = false
  privateCapabilities = { provider: false, theme: false, memoryRefresh: false }
  for (const item of pending.values()) {
    clearTimeout(item.timer)
    item.reject(item.mcpInvocation ? new NativeMcpInvocationInterrupted() : new Error('连接已刷新，请重试。'))
  }
  pending.clear()
  for (const task of chatRequests.values()) {
    task.reject(new NativeChatBridgeError('App 聊天连接已刷新。', 'personal_chat_bridge'))
  }
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
      memoryRefresh?: unknown
      imageOverlayHistory?: unknown
      personalImage?: unknown
      diagnostics?: unknown
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
      memoryRefresh: host && hello.memoryRefresh === true,
    }
    supportsSettingsSections = hello.settingsSections === true
    organizationUsesChatProvider = host && hello.organizationUsesChatProvider === true
    supportsImageOverlayHistory = host && hello.imageOverlayHistory === true
    supportsPersonalImage = host && hello.personalImage === true
    supportsTechnicalDiagnostics = host && hello.diagnostics === true
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
      if (host && value.type === 'personal.chat.capability' && value.personalBackgroundChat === true) {
        supportsPersonalBackgroundChat = true
        notify()
        return
      }
      if (host && value.type === 'personal.mcp.capability' && value.personalMcp === true) {
        supportsPersonalMcp = true
        supportsPersonalMcpActions = value.personalMcpActions === true
        notify()
        return
      }
      if (supportsPersonalImage && typeof value.type === 'string' && value.type.startsWith('image.')) {
        imageFrameListeners.forEach((listener) => listener(value))
        return
      }
      if (supportsPersonalBackgroundChat && value.type === 'personal.chat.response') {
        const task = chatRequests.get(id)
        if (!task) {return}
        if (value.ok === true && value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)) {
          task.resolve(value.payload as Record<string, unknown>)
        } else {
          const code = typeof value.code === 'string' && /^personal_chat_[a-z_]{1,40}$/.test(value.code)
            ? value.code : 'personal_chat_bridge'
          task.reject(new NativeChatBridgeError(
            typeof value.error === 'string' ? value.error.slice(0, 200) : 'App 后台聊天暂时不可用。', code))
        }
        return
      }
      if (value.type === 'ack') {
        const task = pending.get(id)
        if (task) {
          clearTimeout(task.timer)
          pending.delete(id)
          if (value.ok === true) {
            task.resolve(value.payload)
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

export const requestNativeBackgroundChat = (
  action: ChatBridgeAction, payload: object, signal?: AbortSignal
): Promise<Record<string, unknown>> => {
  const channel = port
  if (!channel || !supportsPersonalBackgroundChat || chatRequests.size >= 4) {
    return Promise.reject(new NativeChatBridgeError('App 后台聊天尚未连接。', 'personal_chat_bridge'))
  }
  signal?.throwIfAborted()
  const id = `web-chat-${Date.now()}-${++sequence}`
  let message: string
  try {
    message = encode({ version: 1, id, type: `personal.chat.${action}`, payload })
  } catch {
    return Promise.reject(new NativeChatBridgeError('本次对话内容过长，请缩短后重试。', 'personal_chat_payload'))
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      chatRequests.delete(id)
      signal?.removeEventListener('abort', abort)
    }
    const fail = (error: Error) => { cleanup(); reject(error) }
    const abort = () => fail(signal?.reason)
    const timer = setTimeout(() => fail(new NativeChatBridgeError('App 后台聊天暂未响应。', 'personal_chat_bridge')), 8000)
    chatRequests.set(id, { resolve: (value) => { cleanup(); resolve(value) }, reject: fail })
    signal?.addEventListener('abort', abort, { once: true })
    try { channel.postMessage(message) }
    catch { fail(new NativeChatBridgeError('App 后台聊天连接已关闭。', 'personal_chat_bridge')) }
  })
}

type NativeCommand =
    | 'archive.ready'
    | 'organize'
    | 'memory.open'
    | 'account.open'
    | 'settings.open'
    | 'share.link'
    | 'chat.provider'
    | 'chat.theme'
    | 'diagnostics.record'
    | 'diagnostics.ready'
    | 'diagnostics.open'

export const nativeArchiveRefreshAvailable = (): boolean =>
  Boolean(port && privateCapabilities.memoryRefresh)

const requestNativeArchive = (type: 'memory.open' | 'memory.refresh', archiveId: string): Promise<unknown> => {
  if (!nativeArchiveRefreshAvailable()) {
    return Promise.reject(new Error('此版本暂不支持打开来源档案或更新背景。'))
  }
  if (!archiveId.trim() || archiveId.length > 200) {
    return Promise.reject(new Error('来源记忆标识无效。'))
  }
  return requestNative(type, { archiveId })
}

export const openNativeSourceArchive = async (archiveId: string): Promise<void> => {
  await requestNativeArchive('memory.open', archiveId)
}

export const readNativeArchiveBackground = (archiveId: string): Promise<unknown> =>
  requestNativeArchive('memory.refresh', archiveId)

export const sendNative = async (type: NativeCommand, payload?: unknown): Promise<void> => {
  await requestNative(type, payload)
}

type NativeMcpAction = 'settings' | 'discover' | 'save' | 'clear' | 'lookup' | 'tools' | 'invoke'
type NativeMcpCommand = `mcp.${NativeMcpAction}`

export const requestNativeMcp = (action: NativeMcpAction, payload: object): Promise<unknown> => {
  if (!nativePersonalMcpAvailable()) {
    return Promise.reject(new Error('App 的资料库连接暂时不可用。'))
  }
  if ((action === 'tools' || action === 'invoke') && !nativePersonalMcpActionsAvailable()) {
    return Promise.reject(new Error('当前 App 版本暂不支持直接运行 MCP 工具。'))
  }
  return requestNative(`mcp.${action}`, payload)
}

const requestNative = (type: NativeCommand | NativeMcpCommand | 'memory.refresh', payload?: unknown): Promise<unknown> => {
  const channel = port
  if (
    !channel ||
    (type.startsWith('diagnostics.') && !supportsTechnicalDiagnostics) ||
    (type === 'chat.provider' && !privateCapabilities.provider) ||
    (type === 'chat.theme' && !privateCapabilities.theme) ||
    (type === 'memory.refresh' && !privateCapabilities.memoryRefresh)
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
  const mcpInvocation = type === 'mcp.invoke'
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(mcpInvocation ? new NativeMcpInvocationInterrupted() : new Error('暂时未收到回应，请重试。'))
    }, 30000)
    pending.set(id, { resolve, reject, timer, mcpInvocation })
    try {
      channel.postMessage(body)
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      reject(error instanceof Error ? error : new Error('连接已中断。'))
    }
  })
}
