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
  const locateRef = useRef<string | null>(null)
  const [shareReplyId, setShareReplyId] = useState<string | null>(null)
  const onBranch = useCallback((replyId: string) => branchToNewChat(
    session.id, replyId, t('branchChatTitle', { title: session.title || t('untitledChat') })
  ), [session.id, session.title, t])
  const importing = useChatStore(state => state.importingHistory)
  const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE)
  const messages = getVisibleMessages(session)
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
    if (!isMobile) {
      return
    }
    const view = contentRef.current?.parentElement?.parentElement?.parentElement
    const header = view?.querySelector('header')
    const input = contentRef.current?.parentElement?.nextElementSibling
    if (!view || !header || !input) {
      return
    }
    const measure = () => {
      const headerHeight = header.getBoundingClientRect().height
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
    observer.observe(header, { box: 'border-box' })
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
    if (locateRef.current && scroll) {
      const message = scroll.querySelector<HTMLElement>(
        `[data-chat-message="${CSS.escape(locateRef.current)}"]`
      )
      if (message) {
        message.scrollIntoView({ block: 'center' })
        scrollTopRef.current = scroll.scrollTop
        locateRef.current = null
      }
    }
  }, [getScroller, startIndex, visibleCount, lastMessageId])

  useEffect(() => {
    const locate = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; messageId: string }>).detail
      if (!detail || detail.sessionId !== session.id) {
        return
      }
      const index = messages.findIndex((message) => message.id === detail.messageId)
      if (index < 0) {
        return
      }
      stickyRef.current = false
      locateRef.current = detail.messageId
      setVisibleCount((count) => Math.max(count, messages.length - index))
      requestAnimationFrame(() => {
        const target = scrollRef.current?.querySelector<HTMLElement>(
          `[data-chat-message="${CSS.escape(detail.messageId)}"]`
        )
        if (target) {
          target.scrollIntoView({ block: 'center' })
          locateRef.current = null
        }
      })
    }
    document.addEventListener('deepseek:locate-message', locate)
    return () => document.removeEventListener('deepseek:locate-message', locate)
  }, [session.id, messages])

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

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = getScroller()
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [getScroller, session.id, lastMessageId, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
      const nextSession = useChatStore.getState().sessionCache[session.id]
      if (nextSession) {
        const next = getVisibleMessages(nextSession)
        const index = next.findIndex((message) => message.id === messageId)
        if (index >= 0) {
          setVisibleCount((count) => Math.max(count, next.length - index))
        }
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
    }
    const target = isMobile ? window : el
    target.addEventListener('scroll', onScroll, { passive: true })
    return () => target.removeEventListener('scroll', onScroll)
  }, [getScroller, isMobile, scrollToBottom])

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
