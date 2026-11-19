import { useSettings } from '../../services/settings.js'
import { create } from 'zustand'

import {
  clearSettingsLink,
  setSettingsLink,
  type SettingsSection,
} from '../../services/settingsNavigation.js'
export type { SettingsSection } from '../../services/settingsNavigation.js'

/** 设置弹窗；section 为打开时选中的分组。 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) => {
  setSettingsLink(section)
  useSettingsDialog.setState({ open: true, section })
}

export const closeSettings = () => {
  clearSettingsLink()
  useSettingsDialog.setState({ open: false })
}

export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {return true}
  openSettings('general')
  return false
}
