import { personalEndpoint, type PersonalEndpoint } from './providerEndpoint.js'
import { create } from 'zustand'
import { accountStorageKey, getRuntime, isSessionActive, isGuestWorkspace, subscribeRuntimeUser } from './runtime.js'
import { setChatProviderApiKey, useSettings } from './settings.js'
import {
  readPersonalApiKey,
  removePersonalApiKey,
  storePersonalApiKey,
} from './personalKeyVault.js'

export type ChatProviderMode = 'managed' | 'personal'
type ChatProviderState = {
  mode: ChatProviderMode
  managedEligible: boolean
  loading: boolean
  keyConfigured: boolean
  endpoint: PersonalEndpoint
  error: string
}
export type ChatProviderSnapshot =
  | { mode: 'managed'; scope: string; apiKey: null }
  | ({ mode: 'personal'; scope: string; apiKey: string } & PersonalEndpoint)
export class ChatProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatProviderError'
  }
}
export const CHAT_PROVIDER_CHANGED = 'deepseek-chat-provider-changed'
const MODE_KEY = accountStorageKey('chat-provider-mode')
const OWNER = getRuntime().user.id
const MANAGED_SCOPE = accountStorageKey('managed-provider')
const missingKey = () => getRuntime().user.invite_redeemable
  ? '请填写个人 API Key，或使用邀请码。'
  : '请填写个人聊天 API Key。'
const unavailableChat = () => getRuntime().user.invite_redeemable
  ? '当前账号未开通配套聊天 API，可填写个人 API Key 或使用邀请码。'
  : '当前账号未开通配套聊天 API，可填写个人 API Key。'
const initialEligibility = getRuntime().user.permissions.chat_api
const unreadable = '无法读取本机服务设置，请重新保存服务选择。'
let initialMode: ChatProviderMode = initialEligibility ? 'managed' : 'personal',
  preferredMode: string | null = null,
  initialError = ''
try {
  const value = localStorage.getItem(MODE_KEY)
  preferredMode = value
  if (value === 'personal') {
    initialMode = 'personal'
  } else if (value !== null && value !== 'managed') {
    throw new Error()
  }
} catch {
  initialMode = 'personal'
  initialError = unreadable
}
export const useChatProvider = create<ChatProviderState>(() => ({
  mode: initialMode,
  managedEligible: initialEligibility,
  loading: initialMode === 'personal',
  keyConfigured: false,
  endpoint: personalEndpoint(),
  error: initialError,
}))
let personalKey = '',
  personalScope = '',
  disposed = false
let initialized: Promise<void> | undefined
let configuring = false
setChatProviderApiKey(initialMode === 'managed' ? 'server-managed' : null)

const ownerActive = () => !disposed && isSessionActive() && getRuntime().user.id === OWNER
const assertOwner = () => {
  if (!ownerActive()) {
    throw new ChatProviderError('应用账号已变化，请重新登录后配置。')
  }
}
const keyValue = (value: string): string => {
  const key = value.trim()
  if (!key || key === 'server-managed' || key.length > 8192 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new ChatProviderError('请填写有效的个人 DeepSeek API Key。')
  }
  return key
}
const changed = () => window.dispatchEvent(new Event(CHAT_PROVIDER_CHANGED))
const stopPreviousActivity = async () => {
  const [{ suspendChatReply, useChatStore }, { stopReadAloud }] = await Promise.all([
    import('./chat/store.js'),
    import('./speech/readAloud.js'),
  ])
  assertOwner()
  for (const id of Object.keys(useChatStore.getState().streaming)) {
    suspendChatReply(id)
  }
  stopReadAloud()
  changed()
}
const publish = (mode: ChatProviderMode, keyConfigured: boolean, error = '') => {
  if (mode === 'managed' && !useChatProvider.getState().managedEligible) {
    mode = 'personal'
    error = unavailableChat()
  }
  setChatProviderApiKey(error ? null : mode === 'personal' ? personalKey || null : 'server-managed')
  useChatProvider.setState({ mode, loading: false, keyConfigured, error })
}

export const initializeChatProvider = (): Promise<void> =>
  (initialized ??= (async () => {
    if (!ownerActive()) {
      return
    }
    if (initialError) {
      publish('personal', false, initialError)
      return
    }
    useChatProvider.setState({ loading: true })
    if (initialMode === 'managed' || preferredMode === 'managed') {
      let configured = false
      try {
        const saved = await readPersonalApiKey()
        configured = !!saved
        if (saved && ownerActive()) {
          useChatProvider.setState({ endpoint: personalEndpoint(saved.baseUrl, saved.model) })
        }
      } catch {
        /* Explicit managed mode does not depend on the key vault. */
      }
      if (ownerActive()) {
        publish('managed', configured)
      }
      return
    }
    try {
      const credential = await readPersonalApiKey()
      assertOwner()
      if (!credential) {
        publish('personal', false)
        return
      }
      personalKey = keyValue(credential.apiKey)
      useChatProvider.setState({ endpoint: personalEndpoint(credential.baseUrl, credential.model) })
      personalScope = credential.scope
      publish('personal', true)
    } catch {
      personalKey = ''
      personalScope = ''
      if (ownerActive()) {
        publish('personal', false, '本机个人 API Key 无法读取，请重新填写。')
      }
    }
  })())

export const configureChatProvider = async ({
  mode,
  apiKey,
  endpoint,
}: {
  mode: ChatProviderMode
  apiKey?: string
  endpoint?: PersonalEndpoint
}): Promise<void> => {
  assertOwner()
  if (configuring) {
    throw new ChatProviderError('正在保存服务设置，请稍候。')
  }
  if (mode !== 'managed' && mode !== 'personal') {
    throw new ChatProviderError('服务选择无效。')
  }
  const previous = useChatProvider.getState()
  if (mode === 'managed' && !previous.managedEligible) {
    throw new ChatProviderError(unavailableChat())
  }
  const target = endpoint ? personalEndpoint(endpoint.baseUrl, endpoint.model) : previous.endpoint
  const destinationChanged = target.baseUrl !== previous.endpoint.baseUrl
  if (mode === 'personal' && destinationChanged && !apiKey) {
    throw new ChatProviderError('更改 Base URL 后请重新填写该服务的 API Key。')
  }
  if (
    !destinationChanged &&
    target.model === previous.endpoint.model &&
    !previous.loading &&
    !previous.error &&
    previous.mode === mode &&
    (mode === 'managed' || (personalKey && (apiKey === undefined || apiKey.trim() === personalKey)))
  ) {
    return
  }
  configuring = true
  useChatProvider.setState({ loading: true, error: '' })
  try {
    if (mode === 'personal') {
      // A durable non-secret intent prevents a storage failure/reload from silently using managed quota.
      localStorage.setItem(MODE_KEY, 'personal')
      preferredMode = 'personal'
      const saved = apiKey === undefined ? await readPersonalApiKey() : null
      if (saved && saved.baseUrl !== target.baseUrl) {
        throw new ChatProviderError('服务地址已变化，请重新填写 API Key。')
      }
      const secret = apiKey ?? saved?.apiKey
      const credential =
        secret && (!saved || saved.model !== target.model)
          ? await storePersonalApiKey(keyValue(secret), target)
          : saved
      assertOwner()
      if (!credential) {
        throw new ChatProviderError(missingKey())
      }
      const key = keyValue(credential.apiKey)
      await stopPreviousActivity()
      assertOwner()
      personalKey = key
      useChatProvider.setState({ endpoint: personalEndpoint(credential.baseUrl, credential.model) })
      personalScope = credential.scope
      publish('personal', true)
    } else {
      localStorage.setItem(MODE_KEY, 'managed')
      preferredMode = 'managed'
      await stopPreviousActivity()
      personalKey = ''
      personalScope = ''
      publish('managed', previous.keyConfigured)
    }
  } catch (error) {
    personalKey = ''
    personalScope = ''
    const message =
      error instanceof ChatProviderError
        ? error.message
        : '服务设置未能保存，请检查本机存储后重试。'
    if (ownerActive()) {
      changed()
      publish(mode === 'personal' ? 'personal' : previous.mode, previous.keyConfigured, message)
    }
    throw new ChatProviderError(message)
  } finally {
    configuring = false
  }
}

export const updateManagedEligibility = (eligible: boolean) => {
  if (!ownerActive() || isGuestWorkspace()) {
    return
  }
  const current = useChatProvider.getState()
  if (eligible === current.managedEligible) {
    return
  }
  useChatProvider.setState({ managedEligible: eligible })
  if (!eligible && current.mode === 'managed') {
    personalKey = ''
    personalScope = ''
    publish('personal', current.keyConfigured, unavailableChat())
    void stopPreviousActivity().catch(() => {})
  } else if (eligible && preferredMode !== 'personal' && !initialError && !configuring) {
    publish('managed', current.keyConfigured)
    changed()
  }
}

subscribeRuntimeUser((user) => updateManagedEligibility(user.permissions.chat_api))

export const clearPersonalApiKey = async (): Promise<void> => {
  assertOwner()
  if (configuring) {
    throw new ChatProviderError('正在保存服务设置，请稍候。')
  }
  configuring = true
  const previous = useChatProvider.getState()
  useChatProvider.setState({ loading: true, error: '' })
  try {
    await removePersonalApiKey()
    assertOwner()
    if (previous.mode === 'personal') {
      await stopPreviousActivity()
    }
    personalKey = ''
    personalScope = ''
    publish(previous.mode, false)
  } catch {
    personalKey = ''
    personalScope = ''
    if (ownerActive()) {
      publish(
        previous.mode,
        previous.keyConfigured,
        '个人 API Key 未能清除，请检查本机存储后重试。'
      )
    }
    throw new ChatProviderError('个人 API Key 未能清除，请检查本机存储后重试。')
  } finally {
    configuring = false
  }
}

export const captureChatProvider = (
  apiKey = useSettings.getState().apiKey ?? ''
): ChatProviderSnapshot => {
  assertOwner()
  const current = useChatProvider.getState()
  if (current.loading || current.error) {
    throw new ChatProviderError(current.error || '服务配置尚未就绪，请稍候。')
  }
  if (current.mode === 'managed' && apiKey === 'server-managed') {
    return { mode: 'managed', scope: MANAGED_SCOPE, apiKey: null }
  }
  if (current.mode === 'personal' && personalKey && apiKey === personalKey && personalScope) {
    return {
      mode: 'personal',
      scope: accountStorageKey('personal-provider') + ':' + personalScope,
      apiKey: personalKey,
      ...current.endpoint,
    }
  }
  throw new ChatProviderError('聊天服务已变化，请重新发送。')
}
export const getChatProviderScope = (apiKey?: string): string => captureChatProvider(apiKey).scope
export const isFileProviderScope = (scope: string | undefined, expected: string): boolean =>
  scope === expected || (scope === undefined && expected === MANAGED_SCOPE)
export const disposeChatProvider = () => {
  disposed = true
  personalKey = ''
  personalScope = ''
  setChatProviderApiKey(null)
  useChatProvider.setState({ loading: false, keyConfigured: false, error: '应用账号已退出。' })
  changed()
}
