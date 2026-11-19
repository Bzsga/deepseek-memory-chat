import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  createConversationShare,
  listConversationShares,
  revokeConversationShare,
  summarizeConversationShare,
  type ConversationShareMetadata,
} from '../../services/conversationShares.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { getReplyText } from '../../services/chat/reply.js'
import { loadFile } from '../../services/chat/db.js'
import { getCachedGeneratedImage } from '../../services/chat/imageGeneration.js'
import { useChatStore } from '../../services/chat/store.js'
import type { Message, Session } from '../../services/chat/types.js'
import { getRuntime, isSessionActive, isGuestWorkspace, openAccountLogin } from '../../services/runtime.js'
import { isNativeConnected, sendNative } from '../../services/nativeBridge.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { IconLinkOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import styles from './ConversationShareDialog.module.css'

const contentOf = (message: Message): string =>
  message.role === 'user' ? message.content : getReplyText(message)
const imagesOf = (message: Message): { id: string; name: string }[] =>
  message.role === 'user'
    ? message.files.filter((file) => file.isImage).map((file) => ({ id: file.id, name: file.name }))
    : message.blocks.flatMap((block) =>
        block.type === 'image' ? [{ id: block.id, name: block.name }] : []
      )

/** Only this account's selected visible branch is offered to the public-share API. */
type ShareDialogProps = { session?: Session; replyId?: string; onClose: () => void }
export const ConversationShareDialog = (props: ShareDialogProps) =>
  isGuestWorkspace() ? <ShareLoginDialog onClose={props.onClose} /> : <ShareDialog {...props} />

const ShareLoginDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const [error, setError] = useState('')
  return (
    <Modal title={t('conversationShareTitle')} closable onClose={onClose} footer={<>
      <Button variant="outlined" onClick={onClose}>{t('cancel')}</Button>
      <Button onClick={() => void openAccountLogin().catch(cause => setError(String(cause)))}>
        {t('shareSignIn')}
      </Button>
    </>}>
      <p>{t('shareGuestLoginHint')}</p>
      {error ? <p role="alert">{error}</p> : null}
    </Modal>
  )
}

const ShareDialog = ({
  session,
  replyId,
  onClose,
}: ShareDialogProps) => {
  const t = useTranslate()
  const [owner] = useState(() => getRuntime().user.id)
  const messages = useMemo(() => (session ? getVisibleMessages(session) : []), [session])
  const initialPath = useRef(messages.map((message) => message.id).join('\0'))
  const [selected, setSelected] = useState(() => {
    if (replyId === undefined) {return messages.map(message => message.id)}
    const index = messages.findIndex(message => message.id === replyId && message.role === 'assistant')
    if (index < 0) {return []}
    for (let prior = index - 1; prior >= 0; prior--) {
      if (messages[prior].role === 'user') {return [messages[prior].id, replyId]}
    }
    return [replyId]
  })
  const [shares, setShares] = useState<ConversationShareMetadata[]>([])
  const [created, setCreated] = useState<ConversationShareMetadata | null>(null)
  const [loading, setLoading] = useState(true)
  const [listFailed, setListFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState<'create' | 'revoke' | 'share' | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const operation = useRef(false)
  const requests = useRef(new Set<AbortController>())
  const listSequence = useRef(0)
  const sessionId = session?.id
  const activeId = useChatStore((state) => state.activeId)
  const importing = useChatStore((state) => state.importingHistory)
  const streaming = useChatStore((state) =>
    session ? Boolean(state.streaming[session.id]) : false
  )
  const changed = Boolean(
    session &&
    (activeId !== session.id ||
      initialPath.current !== messages.map((message) => message.id).join('\0'))
  )
  const locked = importing || streaming || changed
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const summary = useMemo(() => {
    if (!session || selected.length === 0) {
      return { messageCount: 0, imageCount: 0, fileCount: 0 }
    }
    try {
      return summarizeConversationShare(session, selected)
    } catch {
      return null
    }
  }, [session, selected])
  const live = useCallback(
    () =>
      mounted.current &&
      isSessionActive() &&
      getRuntime().user.id === owner &&
      (!sessionId || useChatStore.getState().activeId === sessionId),
    [owner, sessionId]
  )

  useEffect(() => {
    mounted.current = true
    const activeRequests = requests.current
    return () => {
      mounted.current = false
      for (const controller of activeRequests) {
        controller.abort()
      }
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    requests.current.add(controller)
    const sequence = ++listSequence.current
    setLoading(true)
    setListFailed(false)
    void listConversationShares(sessionId, controller.signal)
      .then((value) => {
        if (live() && sequence === listSequence.current) {
          setShares(value.filter((share) => !share.revoked))
        }
      })
      .catch((cause) => {
        if (live() && sequence === listSequence.current && !controller.signal.aborted) {
          setListFailed(true)
          setError(cause instanceof Error ? cause.message : t('conversationShareListFailed'))
        }
      })
      .finally(() => {
        requests.current.delete(controller)
        if (live()) {
          setLoading(false)
        }
      })
    return () => controller.abort()
  }, [sessionId, live, t, refresh])

  useEffect(() => {
    if (changed) {
      for (const controller of requests.current) {
        controller.abort()
      }
      onClose()
    }
  }, [changed, onClose])

  const create = async () => {
    if (!session || !summary?.messageCount || locked || operation.current || !live()) {
      return
    }
    operation.current = true
    const controller = new AbortController()
    requests.current.add(controller)
    ++listSequence.current
    setBusy('create')
    setError('')
    setNotice('')
    try {
      const value = await createConversationShare(session.id, [...selected], controller.signal)
      if (live()) {
        setCreated(value)
        setShares((current) => [value, ...current.filter((share) => share.id !== value.id)])
      }
    } catch (cause) {
      if (live() && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : t('conversationShareCreateFailed'))
      }
    } finally {
      requests.current.delete(controller)
      operation.current = false
      if (live()) {
        setBusy(null)
        setLoading(false)
      }
    }
  }

  const revoke = async (share: ConversationShareMetadata) => {
    if (operation.current || !live()) {
      return
    }
    operation.current = true
    const controller = new AbortController()
    requests.current.add(controller)
    ++listSequence.current
    setBusy('revoke')
    setError('')
    setNotice('')
    try {
      await revokeConversationShare(share.id, controller.signal)
      if (live()) {
        setShares((current) => current.filter((item) => item.id !== share.id))
        setCreated((current) => (current?.id === share.id ? null : current))
        setNotice(
          t('conversationShareRevoked', {
            title: share.title || t('untitledChat'),
            id: share.id.slice(-6),
          })
        )
      }
    } catch (cause) {
      if (live() && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : t('conversationShareRevokeFailed'))
      }
    } finally {
      requests.current.delete(controller)
      operation.current = false
      if (live()) {
        setBusy(null)
        setLoading(false)
      }
    }
  }

  const copy = async (share: ConversationShareMetadata) => {
    if (!live() || operation.current) {
      return
    }
    if (await copyText(share.url)) {
      if (live()) {
        setNotice(t('conversationShareCopied'))
      }
    } else if (live()) {
      setError(t('conversationShareCopyFailed'))
    }
  }
  const shareLink = async (share: ConversationShareMetadata) => {
    if (!live() || operation.current) {
      return
    }
    operation.current = true
    setBusy('share')
    setError('')
    try {
      if (isNativeConnected()) {
        await sendNative('share.link', { url: share.url, title: share.title })
      } else if (typeof navigator.share === 'function') {
        await navigator.share({ url: share.url, title: share.title })
      } else {
        if (!(await copyText(share.url))) {
          throw new Error(t('conversationShareCopyFailed'))
        }
        if (live()) {
          setNotice(t('conversationShareCopied'))
        }
      }
    } catch (cause) {
      if (live() && !(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause.message : t('conversationShareSystemFailed'))
      }
    } finally {
      operation.current = false
      if (live()) {
        setBusy(null)
      }
    }
  }
  const linkCard = (share: ConversationShareMetadata, fresh = false) => (
    <article key={share.id} className={styles.linkCard} data-share-card={share.id}>
      <strong>{fresh ? t('conversationShareCreated') : share.title || t('untitledChat')}</strong>
      <p className={styles.meta}>
        {t('conversationShareCounts', { count: share.message_count, images: share.image_count })}
        {' · '}
        {new Date(share.created_at).toLocaleDateString()}
      </p>
      <input
        data-share-link
        readOnly
        value={share.url}
        aria-label={t('conversationShareLink')}
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className={styles.linkActions}>
        <Button
          variant="outlined"
          size="s"
          disabled={busy !== null}
          onClick={() => void copy(share)}
        >
          {t('conversationShareCopyLink')}
        </Button>
        <Button
          variant="outlined"
          size="s"
          disabled={busy !== null}
          onClick={() => void shareLink(share)}
        >
          {t('conversationShareSystemShare')}
        </Button>
        <button
          className={styles.revoke}
          type="button"
          disabled={busy !== null}
          onClick={() => void revoke(share)}
        >
          {t('conversationShareRevoke')}
        </button>
      </div>
    </article>
  )

  return (
    <Modal
      title={t(session ? 'conversationShareTitle' : 'conversationShareManage')}
      closable
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={() => {
        if (!operation.current) {
          onClose()
        }
      }}
      footer={
        <div className={styles.footer}>
          {session ? (
            <span className={styles.selectedCount} role="status">
              {t('conversationShareSelected', {
                count: summary?.messageCount ?? 0,
                images: summary?.imageCount ?? 0,
              })}
            </span>
          ) : null}
          <div className={styles.footerActions}>
            <Button variant="outlined" disabled={busy !== null} onClick={onClose}>
              {t('close')}
            </Button>
            {session ? (
              <Button
                data-share-create
                disabled={busy !== null || locked || !summary?.messageCount}
                onClick={() => void create()}
              >
                {t(busy === 'create' ? 'conversationShareCreating' : 'conversationShareCreate')}
              </Button>
            ) : null}
          </div>
        </div>
      }
    >
      <div data-conversation-share-dialog>
        <p className={styles.privacy}>
          <IconLinkOutline16 />
          <span>{t('conversationShareVisibility')}</span>
        </p>
        <p className={styles.description}>{t('conversationShareSnapshot')}</p>
        {locked ? (
          <p className={styles.error} role="status">
            {t('conversationShareUnavailable')}
          </p>
        ) : null}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        ) : null}
        {created ? linkCard(created, true) : null}
        {session ? (
          <section aria-label={t('conversationShareChoose')}>
            <div className={styles.toolbar}>
              <h3>{t('conversationShareChoose')}</h3>
              <button
                type="button"
                disabled={busy !== null || locked}
                onClick={() =>
                  setSelected(
                    selected.length === messages.length ? [] : messages.map((message) => message.id)
                  )
                }
              >
                {t(
                  selected.length === messages.length
                    ? 'conversationShareSelectNone'
                    : 'conversationShareSelectAll'
                )}
              </button>
            </div>
            <div className={styles.messages}>
              {messages.map((message) => {
                const content = contentOf(message)
                const images = imagesOf(message)
                const checked = selectedSet.has(message.id)
                return (
                  <label key={message.id} className={styles.message} data-share-selected={checked}>
                    <input
                      type="checkbox"
                      data-share-message-id={message.id}
                      checked={checked}
                      disabled={busy !== null || locked}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, message.id]
                            : current.filter((id) => id !== message.id)
                        )
                      }
                    />
                    <span className={styles.messageBody}>
                      <span className={styles.role}>
                        {t(
                          message.role === 'user'
                            ? 'shareContinuationUser'
                            : 'shareContinuationAssistant'
                        )}
                      </span>
                      <span className={styles.text}>
                        {content
                          ? content.length > 600
                            ? content.slice(0, 600) + '…'
                            : content
                          : t('conversationShareNoText')}
                      </span>
                      {images.length ? (
                        <span className={styles.images}>
                          {images.map((image) =>
                            checked ? (
                              <LocalShareImage key={image.id} image={image} />
                            ) : (
                              <span key={image.id} className={styles.file}>
                                {t('conversationShareImage')} · {image.name}
                              </span>
                            )
                          )}
                        </span>
                      ) : null}
                      {message.role === 'user'
                        ? message.files
                            .filter((file) => !file.isImage)
                            .map((file) => (
                              <span key={file.id} className={styles.file}>
                                {file.name}
                              </span>
                            ))
                        : null}
                    </span>
                  </label>
                )
              })}
            </div>
          </section>
        ) : null}
        <section
          className={styles.existing}
          aria-label={t(session ? 'conversationShareExisting' : 'conversationShareManage')}
        >
          <div className={styles.toolbar}>
            <h3>{t(session ? 'conversationShareExisting' : 'conversationShareManage')}</h3>
            <button
              type="button"
              disabled={busy !== null || loading}
              onClick={() => {
                setError('')
                setRefresh((value) => value + 1)
              }}
            >
              {t('conversationShareRefresh')}
            </button>
          </div>
          {loading ? (
            <p className={styles.meta} role="status">
              {t('conversationShareLoading')}
            </p>
          ) : !listFailed && shares.length === 0 ? (
            <p className={styles.meta}>{t('conversationShareEmpty')}</p>
          ) : null}
          {shares.filter((share) => share.id !== created?.id).map((share) => linkCard(share))}
        </section>
      </div>
    </Modal>
  )
}

const LocalShareImage = ({ image }: { image: { id: string; name: string } }) => {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    let objectUrl: string | undefined
    void (async () => {
      try {
        const blob = getCachedGeneratedImage(image.id) ?? (await loadFile(image.id))
        if (!cancelled && blob) {
          objectUrl = URL.createObjectURL(blob)
          setUrl(objectUrl)
        }
      } catch {
        /* Missing originals are identified by the share creator before upload. */
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [image.id])
  return (
    <span className={styles.image}>
      {url ? <img src={url} alt={image.name} /> : null}
      <span>{image.name}</span>
    </span>
  )
}
