/** Loaded before any account-scoped stores or UI modules are imported. */
export const API_ORIGIN = __API_ORIGIN__

export type AccountPermissions = {
  chat_api: boolean
  image_api: boolean
  cloud_sync: boolean
}
export type RuntimeUser = {
  id: string
  username: string
  role: 'admin' | 'user' | 'guest'
  managed_eligible: boolean
  permissions: AccountPermissions
  invite_redeemable: boolean
}
export type WeeklyQuota = {
  user_weekly_remaining: number
  reset_at: string
  managed_eligible?: boolean
  permissions?: AccountPermissions
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
let runtimeRevision = 0
let runtimeRefresh: { revision: number; promise: Promise<void> } | undefined
const userListeners = new Set<(current: RuntimeUser, previous: RuntimeUser) => void>()

export const subscribeRuntimeUser = (listener: (current: RuntimeUser, previous: RuntimeUser) => void) => {
  userListeners.add(listener)
  return () => { userListeners.delete(listener) }
}

export const parseRuntimeUser = (value: unknown): RuntimeUser | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const user = value as Partial<RuntimeUser>
  if (
    typeof user.id !== 'string' || !user.id || user.id.length > 256 ||
    typeof user.username !== 'string' || (!user.username && user.role !== 'guest') ||
    (user.role !== 'admin' && user.role !== 'user' && user.role !== 'guest')
  ) {
    return undefined
  }
  const legacy = user.role !== 'guest' && user.managed_eligible === true
  const supplied = user.permissions
  const permissions = user.role === 'guest' || supplied === undefined
    ? { chat_api: legacy, image_api: legacy, cloud_sync: legacy }
    : {
        chat_api: supplied?.chat_api === true,
        image_api: supplied?.image_api === true,
        cloud_sync: supplied?.cloud_sync === true,
      }
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    managed_eligible: permissions.chat_api,
    permissions: Object.freeze(permissions),
    invite_redeemable: user.role !== 'guest' && (
      user.invite_redeemable === true ||
      (user.invite_redeemable === undefined && supplied === undefined && !legacy)
    ),
  }
}

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
  const user = parseRuntimeUser(data.user)
  if (
    typeof data.model !== 'string' ||
    !data.model ||
    !user || user.role === 'guest'
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
    user,
    ...(validWeeklyQuota(data.weekly_quota) ? { weekly_quota: data.weekly_quota } : {}),
  }
}

export const localGuestRuntime = (): RuntimeConfig => ({
  provider: 'DeepSeek',
  model: 'deepseek-flash',
  features: { search: true, files: true, speech: true, image_generation: false },
  user: {
    id: 'local', username: '', role: 'guest', managed_eligible: false, invite_redeemable: false,
    permissions: { chat_api: false, image_api: false, cloud_sync: false },
  },
})

export const isGuestWorkspace = (): boolean => runtime?.user.role === 'guest'

export const openAccountLogin = async (section?: 'data'): Promise<void> => {
  const { isNativeConnected, sendNative } = await import('./nativeBridge.js')
  if (isNativeConnected()) {await sendNative('account.open', section ? { section } : undefined)}
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
  const user = parseRuntimeUser(value.user)
  if (!user) {
    throw new Error('Invalid account configuration')
  }
  const previous = runtime?.user
  if (previous && (previous.id !== user.id || previous.role !== user.role)) {
    throw new Error('Changing account requires a full page reload')
  }
  runtime = Object.freeze({ ...value, user: Object.freeze(user) })
  runtimeRevision++
  if (previous) {
    userListeners.forEach((listener) => listener(user, previous))
  }
}

export const getRuntime = (): RuntimeConfig => {
  if (!runtime) {
    throw new Error('Account runtime has not been initialized')
  }
  return runtime
}

/** Never read or migrate the legacy anonymous chat-demo database/settings. */
export const guestStorageKey = (name: string): string =>
  `deepseek-chat:${encodeURIComponent(API_ORIGIN)}:local-guest:${name}`

export const accountStorageKey = (name: string): string =>
  isGuestWorkspace()
    ? guestStorageKey(name)
    : `deepseek-chat:${encodeURIComponent(API_ORIGIN)}:user:${getRuntime().user.id}:${name}`

export const isSessionActive = () => runtime !== null && !ended

/** Share focus and quota refreshes; pre-redemption responses cannot overwrite new permissions. */
export const refreshRuntime = (): Promise<void> => {
  if (!isSessionActive()) {
    return Promise.resolve()
  }
  if (runtimeRefresh?.revision === runtimeRevision) {
    return runtimeRefresh.promise
  }
  const started = runtimeRevision
  const promise: Promise<void> = fetchRuntime()
    .then((fresh) => {
      if (!isSessionActive() || started !== runtimeRevision) {
        return
      }
      const current = getRuntime().user
      if (fresh.user.id !== current.id || fresh.user.role !== current.role) {
        invalidateSession('changed')
      } else {
        initializeRuntime(fresh)
      }
    })
    .catch((error: unknown) => {
      if (started === runtimeRevision && error instanceof LoginRequired && !isGuestWorkspace()) {
        invalidateSession('login')
      }
    })
    .finally(() => {
      if (runtimeRefresh?.promise === promise) {
        runtimeRefresh = undefined
      }
    })
  runtimeRefresh = { revision: started, promise }
  return promise
}

export const denyRuntimePermission = (name: keyof AccountPermissions) => {
  if (!isSessionActive()) {
    return
  }
  const current = getRuntime()
  if (current.user.permissions[name]) {
    initializeRuntime({ ...current, user: {
      ...current.user, permissions: { ...current.user.permissions, [name]: false },
    } })
  }
}

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
