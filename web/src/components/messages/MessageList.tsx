import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { branchToNewChat, selectMessageVersion } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { ConversationShareDialog } from '../session/ConversationShareDialog.js'
import { showConversationShareControls } from '../session/conversationShareVisibility.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { UserMessage } from './UserMessage.js'
import type { Message } from '../../services/chat/types.js'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import { registerScrollCapture } from '../../services/scrollCapture.js'
import { readReadingPosition, readingPositionRevision, saveReadingPosition, type ReadingPosition } from '../../services/chat/readingPosition.js'
import { useSettings } from '../../services/settings.js'
import { consumeChatLocation, revealMessageBranch, useChatLocation } from '../../services/chat/chatLocation.js'
import { showToast } from '../base/toastState.js'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
import styles from './MessageList.module.css'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }
const MESSAGE_PAGE_SIZE = 80

type MessageLocation = { messageId: string; offset?: number; save?: boolean; highlight?: boolean }

const firstReadableMessage = (nodes: NodeListOf<HTMLElement>, top: number): HTMLElement | undefined => {
  let start = 0
  let end = nodes.length
  while (start < end) {
    const middle = Math.floor((start + end) / 2)
    if (nodes[middle].getBoundingClientRect().bottom <= top) {
      start = middle + 1
    } else {
      end = middle
    }
  }
  return nodes[start]
}

export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const t = useTranslate()
  const chinese = useSettings((state) => state.locale === 'zh-CN')
  const isMobile = useIsMobile()
  const mobileRef = useRef(isMobile)
  mobileRef.current = isMobile
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const captureActiveRef = useRef(false)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const prependAnchorRef = useRef<{ messageId: string; top: number } | null>(null)
  const locateRef = useRef<MessageLocation | null>(null)
  const highlightRef = useRef<{ node: HTMLElement; timer: ReturnType<typeof setTimeout> }>()
  const readingNodesRef = useRef<NodeListOf<HTMLElement>>()
  const displayedBranchRef = useRef<string>()
  const pendingReadingRef = useRef<{ branch: string; position: ReadingPosition | null; revision: number } | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const [showLatest, setShowLatest] = useState(false)
  const [shareReplyId, setShareReplyId] = useState<string | null>(null)
  const onBranch = useCallback((replyId: string) => branchToNewChat(
    session.id, replyId, t('branchChatTitle', { title: session.title || t('untitledChat') })
  ), [session.id, session.title, t])
  const importing = useChatStore(state => state.importingHistory)
  const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE)
  const messages = useMemo(() => getVisibleMessages(session), [session])
  const requestedLocation = useChatLocation((state) => state.target?.sessionId === session.id ? state.target : null)
  const startIndex = Math.max(0, messages.length - visibleCount)
  const visibleMessages = messages.slice(startIndex)
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const branchKey = useMemo(() => {
    // The first version keeps its key when a sibling is added or the conversation grows.
    let branch = messages[0]?.id
    for (const message of messages) {
      if ((versions.get(message.id)?.index ?? 0) > 0) {branch = message.id}
    }
    return JSON.stringify([session.id, branch])
  }, [messages, session.id, versions])
  const lastMessageId = messages.at(-1)?.id
  const getScroller = useCallback(
    () =>
      mobileRef.current ? (document.scrollingElement as HTMLElement | null) : scrollRef.current,
    []
  )
  const scrollToBottom = useCallback(() => {
    const el = getScroller()
    if (el && stickyRef.current && !captureActiveRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
    }
  }, [getScroller])
  const getReadingTop = useCallback(() => mobileRef.current
    ? contentRef.current?.parentElement?.parentElement?.parentElement?.querySelector('header')?.getBoundingClientRect().bottom ?? 0
    : getScroller()?.getBoundingClientRect().top ?? 0, [getScroller])

  const flushReadingPosition = useCallback(() => {
    clearTimeout(saveTimerRef.current)
    const pending = pendingReadingRef.current
    pendingReadingRef.current = null
    if (pending?.revision === readingPositionRevision()) {saveReadingPosition(pending.branch, pending.position)}
  }, [])

  const queueReadingPosition = useCallback((position: ReadingPosition | null) => {
    if (pendingReadingRef.current && pendingReadingRef.current.branch !== branchKey) {
      flushReadingPosition()
    }
    pendingReadingRef.current = { branch: branchKey, position, revision: readingPositionRevision() }
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(flushReadingPosition, 180)
  }, [branchKey, flushReadingPosition])

  useLayoutEffect(() => {
    window.addEventListener('pagehide', flushReadingPosition)
    return () => {
      window.removeEventListener('pagehide', flushReadingPosition)
      flushReadingPosition()
    }
  }, [flushReadingPosition])

  const clearHighlight = useCallback(() => {
    const highlight = highlightRef.current
    if (!highlight) {return}
    clearTimeout(highlight.timer)
    highlight.node.removeAttribute('data-chat-located')
    highlightRef.current = undefined
  }, [])
  useEffect(() => clearHighlight, [clearHighlight])

  const applyLocation = useCallback((location: MessageLocation) => {
    const scroll = getScroller()
    const element = contentRef.current?.querySelector<HTMLElement>(`[data-chat-message="${CSS.escape(location.messageId)}"]`)
    if (!scroll || !element || captureActiveRef.current) {return false}
    stickyRef.current = false
    if (location.offset === undefined) {
      element.scrollIntoView({ block: 'center' })
    } else {
      scroll.scrollTop += element.getBoundingClientRect().top - (getReadingTop() + location.offset)
    }
    scrollTopRef.current = scroll.scrollTop
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < STICKY_THRESHOLD
    stickyRef.current = nearBottom
    setShowLatest(!nearBottom)
    if (location.highlight) {
      clearHighlight()
      element.setAttribute('data-chat-located', '')
      highlightRef.current = { node: element, timer: setTimeout(clearHighlight, 2600) }
    }
    if (location.save) {
      queueReadingPosition(nearBottom ? null : {
        messageId: location.messageId,
        offset: element.getBoundingClientRect().top - getReadingTop(),
      })
    }
    return true
  }, [clearHighlight, getReadingTop, getScroller, queueReadingPosition])

  const findLocation = useCallback((location: MessageLocation) => {
    const index = messages.findIndex((message) => message.id === location.messageId)
    if (index < 0) {return false}
    locateRef.current = null
    if (!applyLocation(location)) {
      stickyRef.current = false
      locateRef.current = location
      setVisibleCount((count) => Math.max(count, messages.length - index))
    }
    return true
  }, [applyLocation, messages])

  const goToLatest = () => {
    locateRef.current = null
    stickyRef.current = true
    setShowLatest(false)
    queueReadingPosition(null)
    scrollToBottom()
  }

  useLayoutEffect(() => {
    if (!isMobile) {
      return
    }
    document.documentElement.setAttribute('data-chat-document-scroll', '')
    return () => {
      window.__deepseekScrollCapture?.end(0)
      document.documentElement.removeAttribute('data-chat-document-scroll')
      window.scrollTo(0, 0)
    }
  }, [isMobile, session.id])

  useLayoutEffect(() => {
    const view = contentRef.current?.parentElement?.parentElement?.parentElement
    const header = view?.querySelector('header')
    const input = contentRef.current?.parentElement?.nextElementSibling
    if (!view || !input) {
      return
    }
    const measure = () => {
      const headerHeight = header?.getBoundingClientRect().height ?? 0
      const inputHeight = input.getBoundingClientRect().height
      if (headerHeight > 0 && Number.isFinite(headerHeight)) {
        view.style.setProperty('--chat-header-height', `${headerHeight}px`)
      }
      if (inputHeight > 0 && Number.isFinite(inputHeight)) {
        view.style.setProperty('--chat-composer-height', `${inputHeight}px`)
      }
    }
    const observer = new ResizeObserver(measure)
    // The reserved height includes padding, including changes to the mobile safe area.
    if (header) {observer.observe(header, { box: 'border-box' })}
    observer.observe(input, { box: 'border-box' })
    measure()
    return () => observer.disconnect()
  }, [isMobile, session.id])

  useLayoutEffect(() => {
    const element = getScroller()
    if (!element) {
      return
    }
    return registerScrollCapture(element, {
      available: () => !streaming,
      content: () => scrollRef.current,
      header: () =>
        contentRef.current?.parentElement?.parentElement?.parentElement?.querySelector('header'),
      footer: () => contentRef.current?.parentElement?.nextElementSibling,
      start: () => {
        const sticky = stickyRef.current
        captureActiveRef.current = true
        return () => {
          scrollTopRef.current = element.scrollTop
          stickyRef.current = sticky
          captureActiveRef.current = false
        }
      },
    })
  }, [getScroller, isMobile, session.id, streaming])

  // 加载旧消息后保留第一条原有消息的位置；显式定位可以扩大窗口。
  useLayoutEffect(() => {
    readingNodesRef.current = contentRef.current?.querySelectorAll<HTMLElement>('[data-chat-message]')
    const scroll = getScroller()
    const anchor = prependAnchorRef.current
    if (scroll && anchor) {
      const message = scroll.querySelector<HTMLElement>(
        `[data-chat-message="${CSS.escape(anchor.messageId)}"]`
      )
      if (message) {
        scroll.scrollTop += message.getBoundingClientRect().top - anchor.top
      }
      scrollTopRef.current = scroll.scrollTop
      prependAnchorRef.current = null
    }
    if (locateRef.current && applyLocation(locateRef.current)) {
      locateRef.current = null
    }
  }, [applyLocation, getScroller, startIndex, visibleCount, lastMessageId])

  useEffect(() => {
    const locate = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; messageId: string }>).detail
      if (!detail || detail.sessionId !== session.id) {
        return
      }
      findLocation({ messageId: detail.messageId, save: true })
    }
    document.addEventListener('deepseek:locate-message', locate)
    return () => document.removeEventListener('deepseek:locate-message', locate)
  }, [session.id, findLocation])

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = getScroller()
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    const viewport = window.visualViewport
    let frame = 0
    const resize = () => {
      cancelAnimationFrame(frame)
      if (!viewport || viewport.scale === 1) {
        frame = requestAnimationFrame(scrollToBottom)
      }
    }
    window.addEventListener('resize', resize)
    viewport?.addEventListener('resize', resize)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      viewport?.removeEventListener('resize', resize)
    }
  }, [getScroller, isMobile, scrollToBottom])

  // Restore the selected branch's saved message, or preserve the version control's location.
  useLayoutEffect(() => {
    if (displayedBranchRef.current !== branchKey) {
      displayedBranchRef.current = branchKey
      if (requestedLocation?.live()) {
        restoreScrollRef.current = null
        return
      }
      const position = readReadingPosition(branchKey)
      if (position && findLocation(position)) {
        restoreScrollRef.current = null
        return
      }
    }
    const anchor = restoreScrollRef.current
    const scroll = getScroller()
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
        scrollTopRef.current = scroll.scrollTop
        setShowLatest(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >= STICKY_THRESHOLD)
      }
      restoreScrollRef.current = null
      return
    }
    scrollToBottom()
  }, [branchKey, findLocation, getScroller, lastMessageId, requestedLocation, scrollToBottom])

  useEffect(() => {
    if (!requestedLocation) {return}
    if (!requestedLocation.live()) {
      consumeChatLocation(requestedLocation)
      return
    }
    if (findLocation({ messageId: requestedLocation.messageId, save: true, highlight: true })) {
      consumeChatLocation(requestedLocation)
      return
    }
    if (revealMessageBranch(session, requestedLocation.messageId)) {return}
    consumeChatLocation(requestedLocation)
    showToast(chinese ? '暂时无法定位这条消息。' : 'This message could not be opened.')
  }, [chinese, findLocation, requestedLocation, session])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      const before = useChatStore.getState().sessionCache[session.id]
      selectMessageVersion(session.id, messageId)
      const nextSession = useChatStore.getState().sessionCache[session.id]
      if (!nextSession || nextSession === before) {return}
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      const next = getVisibleMessages(nextSession)
      const index = next.findIndex((message) => message.id === messageId)
      if (index >= 0) {
        setVisibleCount((count) => Math.max(count, next.length - index))
      }
    },
    [session.id, streaming]
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = getScroller()
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    const onScroll = () => {
      if (captureActiveRef.current || el.scrollTop === scrollTopRef.current) {
        return
      }
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
      setShowLatest(!nearBottom)
      const readingTop = getReadingTop()
      const nodes = readingNodesRef.current
      const first = !nearBottom && nodes ? firstReadableMessage(nodes, readingTop) : undefined
      const messageId = first?.dataset.chatMessage
      queueReadingPosition(first && messageId ? { messageId, offset: first.getBoundingClientRect().top - readingTop } : null)
    }
    const target = isMobile ? window : el
    target.addEventListener('scroll', onScroll, { passive: true })
    return () => target.removeEventListener('scroll', onScroll)
  }, [getReadingTop, getScroller, isMobile, queueReadingPosition, scrollToBottom])

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
        <div
          ref={isMobile ? scrollRef : undefined}
          className={styles.scroll}
          data-chat-message-scroll
        >
          <div ref={contentRef} className={styles.column}>
            {startIndex > 0 ? (
              <button
                type="button"
                className={styles.loadEarlier}
                onClick={() => {
                  const first = visibleMessages[0]
                  const element =
                    first &&
                    scrollRef.current?.querySelector<HTMLElement>(
                      `[data-chat-message="${CSS.escape(first.id)}"]`
                    )
                  if (first && element) {
                    prependAnchorRef.current = {
                      messageId: first.id,
                      top: element.getBoundingClientRect().top,
                    }
                  }
                  stickyRef.current = false
                  setVisibleCount((count) => count + MESSAGE_PAGE_SIZE)
                }}
              >
                {t('loadEarlierMessages', { count: startIndex })}
              </button>
            ) : null}
            {visibleMessages.map((message, index) =>
              message.role === 'user' ? (
                <UserMessage
                  key={message.id}
                  sessionId={session.id}
                  message={message}
                  retryUploadId={uploadRetryId}
                  isFirst={startIndex + index === 0}
                  isLast={startIndex + index === lastIndex || startIndex + index === lastIndex - 1}
                  busy={streaming}
                  versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                  onSelectVersion={selectVersion}
                />
              ) : (
                <AssistantMessage
                  key={message.id}
                  sessionId={session.id}
                  message={message}
                  isLast={startIndex + index === lastIndex}
                  onBranch={onBranch}
                  onShare={setShareReplyId}
                  actionsDisabled={importing}
                  streaming={streaming && startIndex + index === lastIndex}
                  busy={streaming}
                  versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                  onSelectVersion={selectVersion}
                />
              )
            )}
          </div>
        </div>
        {footer}
        {showLatest ? (
          <button className={styles.returnLatest} type="button" onClick={goToLatest}>
            {chinese ? '回到最新' : 'Back to latest'}
          </button>
        ) : null}
      </div>
      {showConversationShareControls && shareReplyId !== null ? (
        <ConversationShareDialog
          session={session}
          replyId={shareReplyId}
          onClose={() => setShareReplyId(null)}
        />
      ) : null}
    </ScrollToBottomContext.Provider>
  )
}
