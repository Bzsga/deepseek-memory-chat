import {
  defaultReplyTuning, isEffort, isReplyApproach, isReplyDetail, isReplyTone, isReplyTuning, isTemperature, legacyReplyTone, MAX_PERSONA_LENGTH,
  replyTuningNames, type ReplyPreferences,
} from './replyPreferences.js'
import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'
import { accountStorageKey } from './runtime.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 普通偏好在本机保存，可按白名单同步。apiKey 只供运行时使用。 */
type Settings = ReplyPreferences & {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  autoReadAloud: boolean
  showReplyUsage: boolean
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  replyTone: accountStorageKey('reply-tone'),
  replyDetail: accountStorageKey('reply-detail'),
  replyApproach: accountStorageKey('reply-approach'),
  replyWarmth: accountStorageKey('reply-warmth'),
  replyEnthusiasm: accountStorageKey('reply-enthusiasm'),
  replyEmojis: accountStorageKey('reply-emojis'),
  replyVisuals: accountStorageKey('reply-visuals'),
  replyStructure: accountStorageKey('reply-structure'),
  persona: accountStorageKey('persona'),
  reasoningEffort: accountStorageKey('reasoning-effort'),
  temperature: accountStorageKey('temperature'),
  locale: accountStorageKey('locale'),
  location: accountStorageKey('location'),
  themePreference: accountStorageKey('theme-preference'),
  ttsVoice: accountStorageKey('tts-voice'),
  autoReadAloud: accountStorageKey('auto-read-aloud'),
  showReplyUsage: accountStorageKey('show-reply-usage'),
  thinking: accountStorageKey('thinking'),
  search: accountStorageKey('search'),
  siderCollapsed: accountStorageKey('sider-collapsed'),
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

// 兼容上游内部调用签名；此值不是凭据，也不会发送到 API。
const storedEffort = read(KEYS.reasoningEffort)
const storedTemperature = read(KEYS.temperature)
const storedTone = read(KEYS.replyTone)
const storedDetail = read(KEYS.replyDetail)
const storedApproach = read(KEYS.replyApproach)
const storedPersona = (read(KEYS.persona) ?? '').slice(0, MAX_PERSONA_LENGTH)
const storedReplyTuning = { ...defaultReplyTuning }
for (const name of replyTuningNames) {
  const value = read(KEYS[name])
  if (isReplyTuning(value)) {
    storedReplyTuning[name] = value
  }
}
export const useSettings = create<Settings>(() => ({
  apiKey: null,
  ...storedReplyTuning,
  replyTone: isReplyTone(storedTone) ? storedTone : legacyReplyTone(storedPersona),
  replyDetail: isReplyDetail(storedDetail) ? storedDetail : 'default',
  replyApproach: isReplyApproach(storedApproach) ? storedApproach : 'default',
  persona: storedPersona,
  reasoningEffort: isEffort(storedEffort) ? storedEffort : '',
  temperature: isTemperature(storedTemperature) ? storedTemperature : '',
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  autoReadAloud: read(KEYS.autoReadAloud) === 'true',
  showReplyUsage: read(KEYS.showReplyUsage) === 'true',
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

/** Runtime only. This value is never written to localStorage or chat archives. */
export const setChatProviderApiKey = (apiKey: string | null) => {
  useSettings.setState({ apiKey })
}

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setAutoReadAloud = (autoReadAloud: boolean) => {
  write(KEYS.autoReadAloud, autoReadAloud ? 'true' : null)
  useSettings.setState({ autoReadAloud })
}

export const setShowReplyUsage = (showReplyUsage: boolean) => {
  write(KEYS.showReplyUsage, showReplyUsage ? 'true' : null)
  useSettings.setState({ showReplyUsage })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export function setReplyPreferences(values: ReplyPreferences) {
  write(KEYS.replyTone, values.replyTone)
  write(KEYS.replyDetail, values.replyDetail === 'default' ? null : values.replyDetail)
  write(KEYS.replyApproach, values.replyApproach === 'default' ? null : values.replyApproach)
  for (const name of replyTuningNames) {
    write(KEYS[name], values[name] === 'default' ? null : values[name])
  }
  write(KEYS.persona, values.persona || null)
  write(KEYS.reasoningEffort, values.reasoningEffort || null)
  write(KEYS.temperature, values.temperature || null)
  useSettings.setState(values)
}

export const preferenceNames = [
  'replyTone',
  'replyDetail',
  'replyApproach',
  ...replyTuningNames,
  'persona',
  'reasoningEffort',
  'temperature',
  'locale',
  'themePreference',
  'ttsVoice',
  'thinking',
  'search',
  'siderCollapsed',
] as const
export type PreferenceName = (typeof preferenceNames)[number]
export type CloudPreferences = Pick<Settings, PreferenceName>

export const readCloudPreferences = (): Partial<CloudPreferences> => {
  const state = useSettings.getState()
  const { locale, themePreference, ttsVoice, thinking, search, siderCollapsed, replyTone, replyDetail, replyApproach,
    persona, reasoningEffort, temperature } =
    state
  const preferences: Partial<CloudPreferences> = {
    locale, themePreference, ttsVoice, thinking, search, siderCollapsed, persona, reasoningEffort, temperature,
    ...(replyTone !== legacyReplyTone(persona) ? { replyTone } : {}),
    ...(replyDetail !== 'default' ? { replyDetail } : {}),
    ...(replyApproach !== 'default' ? { replyApproach } : {}),
  }
  for (const name of replyTuningNames) {
    if (state[name] !== 'default') {
      preferences[name] = state[name]
    }
  }
  return preferences
}

export const validPreference = (name: PreferenceName, value: unknown): boolean => {
  switch (name) {
    case 'replyTone':
      return isReplyTone(value)
    case 'replyDetail':
      return isReplyDetail(value)
    case 'replyApproach':
      return isReplyApproach(value)
    case 'replyWarmth':
    case 'replyEnthusiasm':
    case 'replyEmojis':
    case 'replyVisuals':
    case 'replyStructure':
      return isReplyTuning(value)
    case 'persona':
      return typeof value === 'string' && value.length <= MAX_PERSONA_LENGTH
    case 'reasoningEffort':
      return isEffort(value)
    case 'temperature':
      return isTemperature(value)
    case 'locale':
      return value === 'zh-CN' || value === 'en-US'
    case 'themePreference':
      return value === 'system' || value === 'light' || value === 'dark'
    case 'ttsVoice':
      return value === 'tide' || value === 'stella'
    default:
      return typeof value === 'boolean'
  }
}

export const applyCloudPreferences = (changes: Partial<CloudPreferences>) => {
  for (const name of preferenceNames) {
    if (changes[name] !== undefined) {
      write(KEYS[name], String(changes[name]))
    }
  }
  useSettings.setState(changes)
}
