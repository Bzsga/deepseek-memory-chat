/** Loaded before any account-scoped stores or UI modules are imported. */
export const API_ORIGIN = __API_ORIGIN__

export type RuntimeUser = {
  id: string
  username: string
  role: 'admin' | 'user' | 'guest'
  managed_eligible: boolean
}
export type WeeklyQuota = {
  user_weekly_remaining: number
  reset_at: string
  managed_eligible?: boolean
}
export type RuntimeConfig = {
  provider: string
  model: string
  features: { search: boolean; files: boolean; speech: boolean; image_generation?: boolean }
  image_model?: string | null
  user: RuntimeUser
  weekly_quota?: WeeklyQuota
}
export type SessionEndReason = 'login' | 'changed'

export class LoginRequired extends Error {}

let runtime: RuntimeConfig | null = null
let ended = false
let sessionEndHandler: ((reason: SessionEndReason) => void) | undefined
let authChannel: BroadcastChannel | undefined

export const fetchRuntime = async (): Promise<RuntimeConfig> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  let response: Response
  try {
    response = await fetch(`${API_ORIGIN}/api/runtime`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
  if (response.status === 401) {
    throw new LoginRequired()
  }
  if (!response.ok) {
    throw new Error('Unable to verify the current account')
  }
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid runtime configuration')
  }
  const data = value as Partial<RuntimeConfig>
  const user = data.user
  if (
    typeof data.model !== 'string' ||
    !data.model ||
    !user ||
    typeof user.id !== 'string' ||
    !user.id ||
    user.id.length > 256 ||
    typeof user.username !== 'string' ||
    !user.username ||
    (user.role !== 'admin' && user.role !== 'user')
  ) {
    throw new Error('Invalid account configuration')
  }
  return {
    provider: typeof data.provider === 'string' ? data.provider : 'DeepSeek',
    model: data.model,
    ...(typeof data.image_model === 'string' ? { image_model: data.image_model } : {}),
    features: {
      search: data.features?.search === true,
      files: data.features?.files === true,
      speech: data.features?.speech === true,
      image_generation: data.features?.image_generation === true,
    },
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      managed_eligible: user.managed_eligible === true,
    },
    ...(validWeeklyQuota(data.weekly_quota) ? { weekly_quota: data.weekly_quota } : {}),
  }
}

export const localGuestRuntime = (): RuntimeConfig => ({
  provider: 'DeepSeek',
  model: 'deepseek-flash',
  features: { search: true, files: true, speech: true, image_generation: false },
  user: { id: 'local', username: '', role: 'guest', managed_eligible: false },
})

export const isGuestWorkspace = (): boolean => runtime?.user.role === 'guest'

export const openAccountLogin = async (): Promise<void> => {
  const { isNativeConnected, sendNative } = await import('./nativeBridge.js')
  if (isNativeConnected()) {await sendNative('account.open')}
  else {window.location.assign(`${API_ORIGIN}/login`)}
}

export const validWeeklyQuota = (value: unknown): value is WeeklyQuota => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const q = value as Partial<WeeklyQuota>
  return (
    Number.isSafeInteger(q.user_weekly_remaining) &&
    (q.user_weekly_remaining ?? -1) >= 0 &&
    typeof q.reset_at === 'string' &&
    Number.isFinite(Date.parse(q.reset_at))
  )
}

export const initializeRuntime = (value: RuntimeConfig) => {
  if (runtime && (runtime.user.id !== value.user.id || runtime.user.role !== value.user.role)) {
    throw new Error('Changing account requires a full page reload')
  }
  runtime = Object.freeze({ ...value, user: Object.freeze({ ...value.user }) })
}

export const getRuntime = (): RuntimeConfig => {
  if (!runtime) {
    throw new Error('Account runtime has not been initialized')
  }
  return runtime
}

/** Never read or migrate the legacy anonymous chat-demo database/settings. */
export const accountStorageKey = (name: string): string =>
  isGuestWorkspace()
    ? `deepseek-chat:${encodeURIComponent(API_ORIGIN)}:local-guest:${name}`
    : `deepseek-chat:${encodeURIComponent(API_ORIGIN)}:user:${getRuntime().user.id}:${name}`

export const isSessionActive = () => runtime !== null && !ended

export const setSessionEndHandler = (handler: (reason: SessionEndReason) => void) => {
  sessionEndHandler = handler
}

export const invalidateSession = (reason: SessionEndReason, broadcast = true) => {
  if (ended) {
    return
  }
  ended = true
  if (broadcast) {
    authChannel?.postMessage({ type: reason === 'changed' ? 'check-session' : 'session-ended' })
  }
  sessionEndHandler?.(reason)
}

/** This channel only carries invalidation signals, never identities or chat content. */
export const bindAuthChannel = (revalidate: () => void): (() => void) => {
  try {
    authChannel = new BroadcastChannel(`deepseek-chat:${API_ORIGIN}:auth`)
    authChannel.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'object' || event.data === null || !('type' in event.data)) {
        return
      }
      if (event.data.type === 'session-ended' && !isGuestWorkspace()) {
        invalidateSession('login', false)
      } else if (event.data.type === 'check-session') {
        revalidate()
      }
    }
    // A newly logged-in tab prompts older tabs to check their shared cookie.
    if (!isGuestWorkspace()) {authChannel.postMessage({ type: 'check-session' })}
  } catch {
    // Visibility/pageshow checks and server-side identity checks remain active.
  }
  return () => {
    authChannel?.close()
    authChannel = undefined
  }
}
