import { openMobileSider } from '../../components/sider/mobileSiderState.js'
import { isSessionActive } from '../runtime.js'
import { setSiderCollapsed } from '../settings.js'
import { appendNativeArchiveChat } from './store.js'
import type { Message, Session } from './types.js'

type Node = { id: string; role: 'user' | 'assistant'; text: string; attachments: string[]; time: string; parent?: string; next?: string }
type RecordData = { id: string; title: string; created: string; updated: string; root?: string; messages: Node[] }

const timestamp = (value: string, fallback: number) => {
  const numeric = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN
  const parsed = Number.isFinite(numeric) ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback
}

export async function convertNativeChat(text: string, source: string): Promise<Session> {
  const raw = JSON.parse(text) as RecordData
  if (raw.id !== source || !Array.isArray(raw.messages)) {throw new Error('会话内容不完整。')}
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  const id = 'zip-' + Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
  const createdAt = timestamp(raw.created, Date.now())
  const messages = raw.messages.map((node): Message => {
    const shared = { id: node.id, parentId: node.parent ?? null, selectedChildId: node.next, createdAt: timestamp(node.time, createdAt) }
    const content = [node.text, ...node.attachments.map(name => `［附件描述］${name}`)].filter(Boolean).join('\n')
    return node.role === 'user' ? {...shared, role: 'user', content, files: []} :
      {...shared, role: 'assistant', status: 'done', prefix: false, model: null, blocks: [{type: 'text', text: content}]}
  })
  return { id, title: raw.title, createdAt, updatedAt: timestamp(raw.updated, createdAt), rootMessageId: raw.root ?? null, messages }
}

let buffer: {source: string; length: number; chunks: string[]} | undefined
export async function importArchiveFrame(payload: unknown, activePort: () => boolean) {
  const live = () => activePort() && isSessionActive()
  if (!live()) {throw new Error('工作区已变化。')}
  const frame = payload as {finished?: boolean; source: string; offset: number; text: string; last: boolean}
  if (frame.finished === true) {buffer = undefined; setSiderCollapsed(false); openMobileSider(); return}
  if (!/^conversation-[a-f0-9]{64}(?::version:[a-f0-9]{16})?$/.test(frame.source) || typeof frame.text !== 'string' || frame.text.length > 64000) {throw new Error('导入数据无效。')}
  if (frame.offset === 0) {buffer = {source: frame.source, length: 0, chunks: []}}
  if (!buffer || buffer.source !== frame.source || frame.offset !== buffer.length) {throw new Error('导入中断，请重新加载。')}
  buffer.chunks.push(frame.text); buffer.length += frame.text.length
  if (frame.last) {
    const text = buffer.chunks.join(''); buffer = undefined
    await appendNativeArchiveChat(await convertNativeChat(text, frame.source), live)
  }
}
