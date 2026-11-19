import { getVisibleMessages } from './branches.js'
import type { Session } from './types.js'

/** Take only the selected branch, retaining original wording and stable message ids. */
export const buildOrganizePayload = (session: Session) => ({
  conversationId: session.id,
  title: session.title || '未命名聊天',
  ...(session.continuity ? { sourceArchiveId: session.continuity.sourceArchiveId } : {}),
  messages: getVisibleMessages(session).flatMap((message) => {
    const content = message.role === 'user' ? message.content : message.blocks
      .map((block) => block.type === 'text' && !block.isTemplate ? block.text : '').join('')
    return content.trim() ? [{ id: message.id, role: message.role, content,
      ...(Number.isFinite(message.createdAt) ? { createdAt: new Date(message.createdAt).toISOString() } : {}) }] : []
  }),
})
