import { ApiError, request } from './api/client.js'
import { legacyReplyTone } from './replyPreferences.js'
import { API_ORIGIN, accountStorageKey } from './runtime.js'
import {
  applyCloudPreferences,
  preferenceNames,
  readCloudPreferences,
  useSettings,
  validPreference,
  type CloudPreferences,
} from './settings.js'

export type SyncDocument<T> = { generation: number; revision: number; value: T | null }
type Kind = 'preferences' | 'key-envelope'
export async function syncDocument<T>(
  kind: Kind,
  generation: number,
  change?: { revision: number; value: T | null },
  signal?: AbortSignal
): Promise<SyncDocument<T>> {
  const base = `${API_ORIGIN}/api/conversation-sync/${kind}`
  const response = change
    ? await request(base, {
        method: change.value === null ? 'DELETE' : 'PUT',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          generation,
          expected_revision: change.revision,
          ...(change.value === null ? {} : { value: change.value }),
        }),
      })
    : await request(`${base}?generation=${generation}`, { method: 'GET', signal })
  const doc = await response.json()
  if (
    doc?.generation !== generation ||
    !Number.isSafeInteger(doc.revision) ||
    doc.revision < 0 ||
    !Object.hasOwn(doc, 'value')
  ) {
    throw new Error('Invalid sync response')
  }
  return doc
}

let applying = false
const pendingKey = (name: string) => accountStorageKey(`sync-pref-${name}`)
const volatilePending = new Map<string, string | null>()
const getPending = (key: string) => {
  if (volatilePending.has(key)) {
    return volatilePending.get(key) ?? null
  }
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const setPending = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
    volatilePending.delete(key)
  } catch {
    volatilePending.set(key, value)
  }
}

/** The account changed scope without interrupting preference consent. */
export function advancePendingPreferences(previous: number, generation: number) {
  for (const name of preferenceNames) {
    const key = pendingKey(name)
    const text = getPending(key)
    if (!text) {
      continue
    }
    try {
      const pending = JSON.parse(text)
      if (pending?.generation === previous && validPreference(name, pending.value)) {
        setPending(key, JSON.stringify({ generation, value: pending.value }))
      }
    } catch {
      // The sync cycle will discard damaged pending entries.
    }
  }
}
export function watchPreferenceChanges(generation: () => number | undefined, schedule: () => void) {
  return useSettings.subscribe((next, previous) => {
    if (applying) {
      return
    }
    const epoch = generation()
    if (epoch === undefined) {
      return
    }
    for (const name of preferenceNames) {
      if (next[name] !== previous[name]) {
        setPending(pendingKey(name), JSON.stringify({ generation: epoch, value: next[name] }))
        schedule()
      }
    }
  })
}

export async function syncPreferences(
  generation: number,
  live: () => boolean,
  signal: AbortSignal
) {
  for (let attempt = 0; attempt < 3 && live(); attempt++) {
    const cloud = await syncDocument<Partial<CloudPreferences>>(
      'preferences',
      generation,
      undefined,
      signal
    )
    if (!live()) {
      return
    }
    const remote = cloud.value
    if (
      remote !== null &&
      (typeof remote !== 'object' ||
        Array.isArray(remote) ||
        Object.keys(remote).some(
          (name) =>
            !preferenceNames.some((key) => key === name && validPreference(key, remote[key]))
        ))
    ) {
      throw new Error('Invalid cloud preferences')
    }
    const desired = { ...(remote ?? readCloudPreferences()) }
    const sent = new Map<string, string | null>()
    for (const name of preferenceNames) {
      const text = getPending(pendingKey(name))
      sent.set(name, text)
      if (!text) {
        continue
      }
      let pending
      try {
        pending = JSON.parse(text)
      } catch {
        // A damaged local pending record must not block other settings or chat synchronization.
        continue
      }
      if (pending?.generation === generation && validPreference(name, pending.value)) {
        Object.assign(desired, { [name]: pending.value })
      }
    }
    if (remote === null || preferenceNames.some((name) => desired[name] !== remote[name])) {
      try {
        await syncDocument(
          'preferences',
          generation,
          { revision: cloud.revision, value: desired },
          signal
        )
      } catch (error) {
        if (
          attempt < 2 && error instanceof ApiError && error.status === 409 && live() &&
          error.code !== 'sync_generation_changed' && error.code !== 'sync_disabled' &&
          error.code !== 'sync_scope_disabled'
        ) {
          continue
        }
        throw error
      }
    }
    if (!live()) {
      return
    }
    const updates: Partial<CloudPreferences> = {}
    for (const name of preferenceNames) {
      const key = pendingKey(name)
      if (getPending(key) !== sent.get(name)) {
        continue
      }
      if (sent.get(name)) {
        setPending(key, null)
      }
      if (desired[name] !== undefined && useSettings.getState()[name] !== desired[name]) {
        Object.assign(updates, { [name]: desired[name] })
      }
    }
    applying = true
    try {
      // Older preference documents express the chosen style solely through their custom text.
      const toneKey = pendingKey('replyTone')
      if (desired.replyTone === undefined && updates.persona !== undefined &&
          getPending(toneKey) === sent.get('replyTone')) {
        updates.replyTone = legacyReplyTone(updates.persona)
      }
      if (Object.keys(updates).length > 0) {
        applyCloudPreferences(updates)
      }
    } finally {
      applying = false
    }
    return
  }
}
