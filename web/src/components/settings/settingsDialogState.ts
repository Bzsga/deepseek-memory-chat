import { useSettings } from '../../services/settings.js'
import { isNativeConnected } from '../../services/nativeBridge.js'
import { isGuestWorkspace } from '../../services/runtime.js'
import { createId } from '../../utils/id.js'
import { create } from 'zustand'

import {
  clearSettingsLink,
  setSettingsLink,
  type SettingsSection,
} from '../../services/settingsNavigation.js'
export type { SettingsSection } from '../../services/settingsNavigation.js'

export type ChatProviderIssue = 'chatProviderPersonalAuth' | 'chatProviderManagedSetupFailed'

/** 设置弹窗；section 为打开时选中的分组。 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
  chatProviderOpen: false,
  chatProviderIssue: null as ChatProviderIssue | null,
}))

export const openSettings = (section: SettingsSection) => {
  setSettingsLink(section)
  useSettingsDialog.setState({ open: true, section })
}

export const closeSettings = () => {
  clearSettingsLink()
  useSettingsDialog.setState({ open: false })
}

let chatProviderEntry: string | undefined
let returningFromChatProvider = false

const showChatProvider = (issue: ChatProviderIssue | null) => {
  if (useSettingsDialog.getState().chatProviderOpen) {
    return
  }
  try {
    const token = createId()
    // A same-document entry lets Android Back close the dialog before leaving chat.
    history.pushState({ ...history.state, chatProviderEntry: token }, '')
    chatProviderEntry = token
  } catch {
    chatProviderEntry = undefined
  }
  useSettingsDialog.setState({ chatProviderOpen: true, chatProviderIssue: issue })
}

export const openChatProvider = () => showChatProvider(null)
export const openChatProviderForIssue = (issue: ChatProviderIssue) => showChatProvider(issue)

const hideChatProvider = () => {
  chatProviderEntry = undefined
  returningFromChatProvider = false
  useSettingsDialog.setState({ chatProviderOpen: false, chatProviderIssue: null })
}

export const closeChatProvider = () => {
  if (chatProviderEntry && history.state?.chatProviderEntry === chatProviderEntry) {
    if (!returningFromChatProvider) {
      returningFromChatProvider = true
      history.back()
    }
    return
  }
  hideChatProvider()
}

export const watchChatProviderHistory = () => {
  const onBack = () => {
    if (chatProviderEntry && history.state?.chatProviderEntry !== chatProviderEntry) {
      hideChatProvider()
    }
  }
  window.addEventListener('popstate', onBack)
  return () => window.removeEventListener('popstate', onBack)
}

export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {return true}
  openChatProvider()
  return false
}

const SYNC_SIGN_IN_INTENT = 'deepseek-chat:sync-after-sign-in'
const SYNC_SIGN_IN_TTL_MS = 10 * 60 * 1000

export const rememberSyncSignIn = (requested: boolean) => {
  if (isNativeConnected()) {
    return
  }
  try {
    if (requested) {
      sessionStorage.setItem(SYNC_SIGN_IN_INTENT, String(Date.now() + SYNC_SIGN_IN_TTL_MS))
    } else {
      sessionStorage.removeItem(SYNC_SIGN_IN_INTENT)
    }
  } catch {
    // Sign-in remains available if the browser declines storage.
  }
}

export const resumeSyncSettingsAfterSignIn = () => {
  if (isGuestWorkspace()) {
    return
  }
  try {
    const expiresAt = Number(sessionStorage.getItem(SYNC_SIGN_IN_INTENT))
    sessionStorage.removeItem(SYNC_SIGN_IN_INTENT)
    const now = Date.now()
    if (expiresAt > now && expiresAt <= now + SYNC_SIGN_IN_TTL_MS) {
      openSettings('data')
    }
  } catch {
    // Users can still open sync settings from the data page.
  }
}
