import { captureChatProvider, useChatProvider } from './chatProvider.js'
import { nativePreferenceChannel, sendNative, subscribeNativeBridge } from './nativeBridge.js'
import { getRuntime, isGuestWorkspace, isSessionActive } from './runtime.js'
import { useSettings } from './settings.js'

type Kind = 'provider' | 'theme'
function current(kind: Kind) {
  const identity = { ownerId: getRuntime().user.id, guest: isGuestWorkspace() }
  if (kind === 'theme') {
    const preference = useSettings.getState().themePreference
    return { fingerprint: preference, payload: { ...identity, preference } }
  }
  const state = useChatProvider.getState()
  if (state.loading) {
    return
  }
  try {
    const provider = captureChatProvider()
    if (provider.mode === 'personal') {
      const { mode, apiKey, baseUrl, model, scope } = provider
      return {
        fingerprint: JSON.stringify([scope, baseUrl, model]),
        payload: { ...identity, mode, apiKey, baseUrl, model },
      }
    }
    return { fingerprint: 'managed', payload: { ...identity, mode: 'managed' } }
  } catch {
    // Missing, explicitly cleared or unusable personal credentials invalidate the native copy.
    return { fingerprint: 'empty', payload: { ...identity, mode: 'personal' } }
  }
}

export function bindNativePreferences() {
  const owner = getRuntime().user.id,
    guest = isGuestWorkspace()
  let disposed = false
  const active = () =>
    !disposed && isSessionActive() && owner === getRuntime().user.id && guest === isGuestWorkspace()
  function sender(kind: Kind) {
    let channel: MessagePort | undefined,
      last = '',
      busy = false,
      queued = false
    return async function flush() {
      if (busy) {
        queued = true
        return
      }
      busy = true
      try {
        do {
          queued = false
          const next = nativePreferenceChannel(kind)
          if (next !== channel) {
            channel = next
            last = ''
          }
          if (!next || !active()) {
            return
          }
          const state = current(kind)
          if (!state || last === state.fingerprint) {
            return
          }
          try {
            await sendNative(kind === 'provider' ? 'chat.provider' : 'chat.theme', state.payload)
            last = state.fingerprint
          } catch {
            // Native stores idempotent state. Focus, the next change or reconnect can retry it.
            last = ''
          }
        } while (queued && active())
      } finally {
        busy = false
      }
    }
  }
  const provider = sender('provider'),
    theme = sender('theme')
  const refresh = () => {
    void provider()
    void theme()
  }
  const detachBridge = subscribeNativeBridge(refresh)
  const detachProvider = useChatProvider.subscribe(() => void provider())
  const detachSettings = useSettings.subscribe((next, previous) => {
    if (next.themePreference !== previous.themePreference) {
      void theme()
    }
  })
  window.addEventListener('focus', refresh)
  refresh()
  return () => {
    disposed = true
    detachBridge()
    detachProvider()
    detachSettings()
    window.removeEventListener('focus', refresh)
  }
}
