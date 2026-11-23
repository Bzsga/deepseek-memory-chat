import { accountStorageKey, isSessionActive } from '../runtime.js'

export type ReadingPosition = { messageId: string; offset: number }

const MAX_POSITIONS = 150
const positions = new Map<string, Map<string, ReadingPosition>>()
let revision = 0

function workspacePositions() {
  const storageKey = accountStorageKey('chat-reading-positions')
  let saved = positions.get(storageKey)
  if (!saved) {
    saved = new Map()
    try {
      const rows: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
      if (Array.isArray(rows)) {
        for (const row of rows.slice(-MAX_POSITIONS)) {
          if (!Array.isArray(row) || typeof row[0] !== 'string') {
            continue
          }
          const position = row[1] as Partial<ReadingPosition> | null
          if (typeof position?.messageId === 'string' &&
            typeof position.offset === 'number' && Number.isFinite(position.offset)) {
            saved.set(row[0], { messageId: position.messageId, offset: position.offset })
          }
        }
      }
    } catch {
      // Reading can continue in this page when persistent storage is unavailable.
    }
    positions.set(storageKey, saved)
  }
  return { storageKey, saved }
}

export const readReadingPosition = (branchKey: string): ReadingPosition | undefined =>
  isSessionActive() ? workspacePositions().saved.get(branchKey) : undefined

export const readingPositionRevision = () => revision

export function clearSavedReadingPositions(): void {
  if (!isSessionActive()) {return}
  const storageKey = accountStorageKey('chat-reading-positions')
  revision++
  positions.delete(storageKey)
  try {
    localStorage.removeItem(storageKey)
  } catch {
    // The current page still discards its saved anchors.
  }
}

export function saveReadingPosition(branchKey: string, position: ReadingPosition | null) {
  if (!isSessionActive()) {return}
  const { storageKey, saved } = workspacePositions()
  if (!saved.delete(branchKey) && !position) {
    return
  }
  if (position) {
    saved.set(branchKey, position)
    const oldest = saved.keys().next().value
    if (saved.size > MAX_POSITIONS && oldest !== undefined) {
      saved.delete(oldest)
    }
  }
  try {
    localStorage.setItem(storageKey, JSON.stringify([...saved]))
  } catch {
    // The current page can still restore the position from memory.
  }
}
