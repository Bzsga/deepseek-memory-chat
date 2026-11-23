import { loadSession } from './db.js'
import { captureConversationDataGuard, useChatStore } from './store.js'
import type { Message, SessionSummary } from './types.js'
import { getRuntime } from '../runtime.js'

export type TextHit = { before: string; match: string; after: string }
export type MessageHit = TextHit & { messageId: string; createdAt: number; role: Message['role'] }
export type HistoryHit = { session: SessionSummary; title?: TextHit; message?: MessageHit }
export const MAX_MESSAGE_SEARCH_RESULTS = 60

export const normalizeSearchQuery = (input: string): string => input.replace(/\s+/g, ' ').trim()

const searchPattern = (input: string): RegExp | undefined => {
  const query = normalizeSearchQuery(input)
  return query ? new RegExp(query.replace(/[.*+?^{}()|[\]\\$]/g, '\\$&'), 'iu') : undefined
}

const splitsSurrogate = (text: string, index: number) =>
  text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff &&
  text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff

function textHit(text: string, query: RegExp): TextHit | undefined {
  const plain = normalizeSearchQuery(text)
  const result = query.exec(plain)
  if (!result) {return undefined}
  const index = result.index
  const end = index + result[0].length
  let left = Math.max(0, index - 24)
  let right = Math.min(plain.length, Math.max(index + 105, end + 24))
  if (splitsSurrogate(plain, left)) {left--}
  if (splitsSurrogate(plain, right)) {right++}
  return {
    before: (left > 0 ? '…' : '') + plain.slice(left, index),
    match: result[0],
    after: plain.slice(end, right) + (right < plain.length ? '…' : ''),
  }
}

const searchMessages = (messages: readonly Message[], query: RegExp, limit: number): MessageHit[] => {
  const hits: MessageHit[] = []
  for (let index = messages.length - 1; index >= 0 && hits.length < limit; index--) {
    const message = messages[index]
    const text = message.role === 'user' ? message.content
      : message.stopReason === 'refusal' ? '' : message.blocks
        .flatMap((block) => block.type === 'text' && !block.isTemplate ? [block.text] : [])
        .join(' ')
    const hit = textHit(text, query)
    if (hit) {
      hits.push({ ...hit, messageId: message.id, createdAt: message.createdAt, role: message.role })
    }
  }
  return hits
}

export function findMessageHits(messages: readonly Message[], input: string, limit = MAX_MESSAGE_SEARCH_RESULTS): MessageHit[] {
  const query = searchPattern(input)
  return query ? searchMessages(messages, query, limit) : []
}

export function findTitleHits(summaries: readonly SessionSummary[], input: string, untitled: string) {
  const query = searchPattern(input)
  return query ? summaries.flatMap((session): HistoryHit[] => {
    const title = textHit(session.title || untitled, query)
    return title ? [{ session, title }] : []
  }) : []
}

export async function searchHistoryBody(
  summaries: readonly SessionSummary[],
  input: string,
  signal: AbortSignal
): Promise<HistoryHit[]> {
  const query = searchPattern(input)
  if (!query || signal.aborted) {return []}
  const live = captureConversationDataGuard(getRuntime().user.id)
  const hits: HistoryHit[] = []
  for (const summary of summaries) {
    if (signal.aborted || !live()) {return []}
    const session = useChatStore.getState().sessionCache[summary.id] ?? await loadSession(summary.id)
    if (signal.aborted || !live()) {return []}
    if (session) {
      for (const message of searchMessages(session.messages, query, MAX_MESSAGE_SEARCH_RESULTS - hits.length)) {
        hits.push({ session: summary, message })
      }
    }
    if (hits.length >= MAX_MESSAGE_SEARCH_RESULTS) {break}
  }
  return hits
}
