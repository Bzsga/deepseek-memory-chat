import { useMemo, useState } from 'react'
import { useSettings } from '../../services/settings.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { openChatLocation } from '../../services/chat/chatLocation.js'
import { findMessageHits, MAX_MESSAGE_SEARCH_RESULTS, normalizeSearchQuery, type TextHit } from '../../services/chat/historySearch.js'
import type { Session } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { IconSearchOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import styles from './ChatFind.module.css'

export function MatchExcerpt({ hit }: { hit: TextHit }) {
  return <>{hit.before}<mark>{hit.match}</mark>{hit.after}</>
}

export function ChatFind({ session }: { session: Session }) {
  const chinese = useSettings((state) => state.locale === 'zh-CN')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const hits = useMemo(() => open ? findMessageHits(session.messages, query) : [], [session.messages, query, open])
  const visibleIds = useMemo(() => open
    ? new Set(getVisibleMessages(session).map((message) => message.id))
    : new Set<string>(), [session, open])
  const label = chinese ? '查找本对话消息' : 'Find in conversation'
  const jump = (messageId: string) => {
    if (openChatLocation({ sessionId: session.id, messageId })) {setOpen(false)}
  }
  return (
    <>
      <IconButton size="xl" tone="primary" icon={<IconSearchOutline16 />} aria-label={label}
        aria-haspopup="dialog" onClick={() => setOpen(true)} />
      {open ? <Modal title={label} className={styles.dialog} onClose={() => setOpen(false)}>
        <div className={styles.searchRow}>
          <input type="search" aria-label={label} spellCheck={false} maxLength={160}
            placeholder={chinese ? '输入消息关键词' : 'Search messages'}
            value={query} onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && hits[0]) {
                jump(hits[0].messageId)
              }
            }} />
          <button className={styles.close} type="button" onClick={() => setOpen(false)}>{chinese ? '关闭' : 'Close'}</button>
        </div>
        {normalizeSearchQuery(query) && hits.length === 0 ? (
          <p role="status" className={styles.empty}>{chinese ? '没有匹配的消息' : 'No matching messages'}</p>
        ) : null}
        {hits.length > 0 ? <ul className={styles.results}>
          {hits.map((hit) => <li key={hit.messageId}>
            <button type="button" onClick={() => jump(hit.messageId)}>
              <span className={styles.meta}>
                {hit.role === 'user' ? (chinese ? '你' : 'You') : (chinese ? '助手' : 'Assistant')}
                {' · '}{new Date(hit.createdAt).toLocaleString(chinese ? 'zh-CN' : 'en')}
                {!visibleIds.has(hit.messageId) ? (chinese ? ' · 其他分支' : ' · Another branch') : null}
              </span>
              <span className={styles.body}><MatchExcerpt hit={hit} /></span>
            </button>
          </li>)}
        </ul> : null}
        {hits.length === MAX_MESSAGE_SEARCH_RESULTS ? <p className={styles.empty}>
          {chinese ? '可输入更具体的关键词以缩小范围' : 'Try a more specific search to narrow the results.'}
        </p> : null}
      </Modal> : null}
    </>
  )
}
