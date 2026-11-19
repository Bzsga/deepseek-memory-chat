/** Guest-safe handoff: only an opaque public ID, never account stores or chat data. */
const KEY = 'deepseek-pending-conversation-share'
const valid = (value: string | null | undefined): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value)
let pending: string | undefined

export const rememberConversationShareQuery = () => {
  const url = new URL(location.href)
  const values = url.searchParams.getAll('share')
  if (values.length !== 1 || !valid(values[0])) {
    return
  }
  pending = values[0]
  try {
    sessionStorage.setItem(KEY, pending)
    url.searchParams.delete('share')
    history.replaceState(history.state, '', url)
  } catch {
    // Keep the query as a fallback when session storage is unavailable.
  }
}

export const getPendingConversationShare = (): string | undefined => {
  if (pending) {
    return pending
  }
  try {
    const value = sessionStorage.getItem(KEY)
    if (valid(value)) {
      return value
    }
  } catch {
    /* The in-memory/query fallback still works on this page. */
  }
  const values = new URL(location.href).searchParams.getAll('share')
  return values.length === 1 && valid(values[0]) ? values[0] : undefined
}

export const pendingConversationShareUrl = (id: string): string => {
  if (!valid(id)) {
    throw new Error('Invalid share identifier')
  }
  return `https://digimonlegend.com/deepseek/share/${id}`
}

export const clearPendingConversationShare = (id?: string) => {
  if (id && getPendingConversationShare() !== id) {
    return
  }
  pending = undefined
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* Best effort in restricted browsers. */
  }
  const url = new URL(location.href)
  if (!id || url.searchParams.get('share') === id) {
    url.searchParams.delete('share')
    history.replaceState(history.state, '', url)
  }
}
