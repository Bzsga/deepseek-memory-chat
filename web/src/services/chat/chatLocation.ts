import { create } from 'zustand'
import { getRuntime } from '../runtime.js'
import { getVisibleMessages } from './branches.js'
import { captureConversationDataGuard, selectMessageVersion, selectSession, useChatStore } from './store.js'
import type { Session } from './types.js'

type MessageDestination = { sessionId: string; messageId: string }
type ChatLocation = MessageDestination & { live: () => boolean }

export const useChatLocation = create<{ target: ChatLocation | null }>(() => ({ target: null }))
let unsubscribe: (() => void) | undefined

export function consumeChatLocation(target: ChatLocation) {
  if (useChatLocation.getState().target === target) {
    unsubscribe?.()
    unsubscribe = undefined
    useChatLocation.setState({ target: null })
  }
}

export function openChatLocation(destination: MessageDestination): boolean {
  const live = captureConversationDataGuard(getRuntime().user.id)
  const { activeId, sessions } = useChatStore.getState()
  if (!live() || !sessions.some((session) => session.id === destination.sessionId)) {
    return false
  }
  const previous = useChatLocation.getState().target
  if (previous) {consumeChatLocation(previous)}
  if (activeId !== destination.sessionId) {selectSession(destination.sessionId)}
  if (!live() || useChatStore.getState().activeId !== destination.sessionId) {return false}

  const target = { ...destination, live }
  unsubscribe = useChatStore.subscribe((state) => {
    if (!target.live() || state.activeId !== target.sessionId ||
        !state.sessions.some((session) => session.id === target.sessionId)) {
      consumeChatLocation(target)
    }
  })
  useChatLocation.setState({ target })
  return true
}

/** Select each required version from the root down without changing original messages. */
export function revealMessageBranch(session: Session, messageId: string): boolean {
  const live = captureConversationDataGuard(getRuntime().user.id, session.id)
  if (session.rootMessageId === undefined || !live() || useChatStore.getState().activeId !== session.id) {
    return false
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const path: string[] = []
  let node = byId.get(messageId)
  while (node && path.length < session.messages.length) {
    path.push(node.id)
    if (node.parentId === null) {break}
    node = node.parentId ? byId.get(node.parentId) : undefined
  }
  if (node?.parentId !== null) {return false}

  let visible = getVisibleMessages(session)
  for (const [index, id] of path.reverse().entries()) {
    if (visible[index]?.id === id) {continue}
    selectMessageVersion(session.id, id)
    const selected = useChatStore.getState().sessionCache[session.id]
    if (!selected) {return false}
    visible = getVisibleMessages(selected)
    if (visible[index]?.id !== id) {return false}
  }
  return visible.some((message) => message.id === messageId)
}
