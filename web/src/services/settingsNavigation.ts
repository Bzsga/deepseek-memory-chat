export type SettingsSection = 'general' | 'data' | 'about'

const settingsHashes = {
  general: '#settings',
  data: '#settings/data',
  about: '#settings/about',
} as const

const currentSection = () =>
  (Object.keys(settingsHashes) as SettingsSection[]).find(
    (section) => settingsHashes[section] === location.hash
  )

export const setSettingsLink = (section: SettingsSection) => {
  if (location.hash === settingsHashes[section]) {return}
  if (currentSection()) {
    history.replaceState(history.state, '', settingsHashes[section])
  } else {
    history.pushState({ ...history.state, settingsEntry: true }, '', settingsHashes[section])
  }
}

export const clearSettingsLink = () => {
  if (!currentSection()) {return}
  if (history.state?.settingsEntry) {history.back()}
  else {history.replaceState(history.state, '', location.pathname + location.search)}
}

export const watchSettingsLink = (change: (section?: SettingsSection) => void) => {
  const receive = () => change(currentSection())
  window.addEventListener('hashchange', receive)
  receive()
  return () => window.removeEventListener('hashchange', receive)
}
