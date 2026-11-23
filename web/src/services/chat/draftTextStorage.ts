import { accountStorageKey, isSessionActive } from '../runtime.js'

const draftPrefix = 'draft-text-v1:'
const slot = (sessionId: string | null) => sessionId === null ? 'new' : `session:${encodeURIComponent(sessionId)}`

function storedKeys(prefix: string): string[] {
  const keys: string[] = []
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (key?.startsWith(prefix)) {
      keys.push(key)
    }
  }
  return keys
}

export function loadDraftText(): Map<string | null, string> {
  const result = new Map<string | null, string>()
  if (!isSessionActive()) {
    return result
  }
  try {
    const prefix = accountStorageKey(draftPrefix)
    for (const key of storedKeys(prefix)) {
      const name = key.slice(prefix.length)
      if (name !== 'new' && !name.startsWith('session:')) {
        continue
      }
      const text = localStorage.getItem(key)
      if (text) {
        result.set(name === 'new' ? null : decodeURIComponent(name.slice('session:'.length)), text)
      }
    }
  } catch {
    // The composer is still available when device storage is blocked.
  }
  return result
}

export function saveDraftText(sessionId: string | null, text: string): void {
  if (!isSessionActive()) {
    return
  }
  try {
    const key = accountStorageKey(draftPrefix + slot(sessionId))
    if (text) {
      localStorage.setItem(key, text)
    } else {
      localStorage.removeItem(key)
    }
  } catch {
    // Keep the draft in memory if the device cannot save it.
  }
}

export function clearSavedDraftText(): void {
  if (!isSessionActive()) {
    return
  }
  try {
    for (const key of storedKeys(accountStorageKey(draftPrefix))) {
      localStorage.removeItem(key)
    }
  } catch {
    // In-memory drafts are still discarded by the caller.
  }
}
