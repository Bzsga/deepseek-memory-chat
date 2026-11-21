import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  continueSharedConversation,
  readSharedConversation,
  type SharedConversationPreview,
} from '../../services/sharedConversation.js'
import { ApiError } from '../../services/api/client.js'
import { openAccountLogin } from '../../services/runtime.js'
import { Button } from '../base/Button.js'
import { IconChevronRightOutline14, IconLinkOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showConversationShareControls } from './conversationShareVisibility.js'
import styles from './ShareContinuation.module.css'
import {
  clearPendingConversationShare,
  getPendingConversationShare,
  pendingConversationShareUrl,
} from '../../services/pendingConversationShare.js'

const shareStepOne = new URL('../../assets/deepseek-share-step-1.jpg', import.meta.url).href
const shareStepTwo = new URL('../../assets/deepseek-share-step-2.jpg', import.meta.url).href

/** A share is read first, then appended locally only after explicit confirmation. */
export const ShareContinuation = () => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className={styles.entry} onClick={() => setOpen(true)}>
        <IconLinkOutline16 />
        {t('shareContinuationEntry')}
        <IconChevronRightOutline14 />
      </button>
      {open ? <ShareContinuationDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}

export const PendingShareContinuation = () => {
  const [pending, setPending] = useState(getPendingConversationShare)
  return pending ? (
    <ShareContinuationDialog
      key={pending}
      initialInput={pendingConversationShareUrl(pending)}
      autoRead
      onClose={() => {
        clearPendingConversationShare(pending)
        setPending(undefined)
      }}
    />
  ) : null
}

export const ShareContinuationDialog = ({
  onClose,
  initialInput = '',
  autoRead = false,
}: {
  onClose: () => void
  initialInput?: string
  autoRead?: boolean
}) => {
  const t = useTranslate()
  const [input, setInput] = useState(initialInput)
  const [preview, setPreview] = useState<SharedConversationPreview | null>(null)
  const [busy, setBusy] = useState<'read' | 'import' | null>(null)
  const [error, setError] = useState('')
  const [needsLogin, setNeedsLogin] = useState(false)
  const reading = useRef<AbortController | null>(null)
  const importing = useRef(false)
  const mounted = useRef(true)
  const autoStarted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      reading.current?.abort()
    }
  }, [])

  const read = useCallback(async () => {
    if (!input.trim() || reading.current || importing.current) {
      return
    }
    const controller = new AbortController()
    reading.current = controller
    setBusy('read')
    setPreview(null)
    setNeedsLogin(false)
    setError('')
    try {
      const value = await readSharedConversation(input, controller.signal)
      if (mounted.current && !controller.signal.aborted) {
        setPreview(value)
      }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        setNeedsLogin(cause instanceof ApiError && cause.code === 'login_required')
        setError(cause instanceof Error ? cause.message : t('shareContinuationReadFailed'))
      }
    } finally {
      if (reading.current === controller) {
        reading.current = null
      }
      if (mounted.current) {
        setBusy(null)
      }
    }
  }, [input, t])

  const confirm = async () => {
    if (!preview || reading.current || importing.current) {
      return
    }
    importing.current = true
    setBusy('import')
    setError('')
    try {
      await continueSharedConversation(preview)
      if (mounted.current) {
        onClose()
      }
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : t('shareContinuationImportFailed'))
      }
    } finally {
      importing.current = false
      if (mounted.current) {
        setBusy(null)
      }
    }
  }

  useEffect(() => {
    if (autoRead && initialInput && !autoStarted.current) {
      autoStarted.current = true
      void read()
    }
  }, [autoRead, initialInput, read])

  return (
    <Modal
      title={t('shareContinuationTitle')}
      closable
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={() => {
        if (!importing.current) {
          onClose()
        }
      }}
      footer={
        <div className={styles.actions}>
          <Button variant="outlined" disabled={busy === 'import'} onClick={onClose}>
            {t('cancel')}
          </Button>
          {needsLogin ? (
            <Button onClick={() => void openAccountLogin().catch(cause => setError(String(cause)))}>
              {t('shareSignIn')}
            </Button>
          ) : preview ? (
            <Button disabled={busy !== null} onClick={() => void confirm()}>
              {t(busy === 'import' ? 'shareContinuationImporting' : 'shareContinuationConfirm')}
            </Button>
          ) : (
            <Button disabled={!input.trim() || busy !== null} onClick={() => void read()}>
              {t(busy === 'read' ? 'shareContinuationReading' : 'shareContinuationRead')}
            </Button>
          )}
        </div>
      }
    >
      <p className={styles.description}>{t('shareContinuationDescription')}</p>
      <label className={styles.inputLabel} htmlFor="deepseek-share-link">
        {t('shareContinuationLinkLabel')}
      </label>
      <textarea
        id="deepseek-share-link"
        className={styles.input}
        rows={3}
        maxLength={8192}
        value={input}
        disabled={busy !== null}
        placeholder={t('shareContinuationPlaceholder')}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => {
          setInput(event.target.value)
          setNeedsLogin(false)
          setPreview(null)
          setError('')
        }}
      />
      {busy === 'read' ? (
        <p role="status" className={styles.hint}>
          {t('shareContinuationReading')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {preview ? (
        <section className={styles.preview} aria-label={t('shareContinuationPreview')}>
          <h3 className={styles.previewTitle}>{preview.title}</h3>
          <p className={styles.metadata}>
            {t('shareContinuationMessageCount', { count: preview.messageCount })}
          </p>
          <p className={styles.scope}>{preview.rangeWarning}</p>
          {preview.warnings.length ? (
            <ul className={styles.warnings}>
              {preview.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <details className={styles.excerpts}>
            <summary>{t('shareContinuationPreviewMessages')}</summary>
            {preview.messages.slice(-2).map((message) => (
              <div className={styles.message} key={message.id}>
                <span className={styles.role}>
                  {t(
                    message.role === 'user' ? 'shareContinuationUser' : 'shareContinuationAssistant'
                  )}
                </span>
                <p>
                  {message.content.length > 700
                    ? `${message.content.slice(0, 700)}…`
                    : message.content}
                </p>
                {message.images?.length ? (
                  <p className={styles.imageMetadata}>
                    {t('shareContinuationImageCount', { count: message.images.length })}
                    <br />
                    {message.images.map((image) => image.name).join('、')}
                  </p>
                ) : null}
              </div>
            ))}
          </details>
          <a
            className={styles.sourceLink}
            href={preview.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('shareContinuationViewSource')}
          </a>
        </section>
      ) : null}
      {showConversationShareControls ? (
        <p className={styles.hint}>{t('shareContinuationAppTutorial')}</p>
      ) : null}
      <details className={styles.tutorial}>
        <summary>{t('shareContinuationTutorial')}</summary>
        <ol>
          <li>
            <p>{t('shareContinuationStepOne')}</p>
            <img
              src={shareStepOne}
              width={1074}
              height={900}
              loading="lazy"
              alt={t('shareContinuationStepOneAlt')}
            />
          </li>
          <li>
            <p>{t('shareContinuationStepTwo')}</p>
            <img
              src={shareStepTwo}
              width={1079}
              height={2098}
              loading="lazy"
              alt={t('shareContinuationStepTwoAlt')}
            />
          </li>
        </ol>
      </details>
    </Modal>
  )
}
