import { activeImageProvider, useActiveImageProvider } from '../../services/imageProvider.js'
import { getRuntime, isSessionActive, subscribeRuntimeUser } from '../../services/runtime.js'
import clsx from 'clsx'
import { memo, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import {
  IconGlobeLanguageOutline14,
  IconCloseOutline16,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline14,
} from '../base/icons.js'
import { setSearch, setThinking, useSettings } from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import {
  sendMessage,
  sendImageMessage,
  stopReply,
  useChatStore,
} from '../../services/chat/store.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { IconButton } from '../base/IconButton.js'
import { Tooltip } from '../base/Tooltip.js'
import { ensureApiKey, openChatProvider } from '../settings/settingsDialogState.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import {
  ACCEPT,
  IMAGE_ACCEPT,
  normalizeUploadFiles,
  useUploads,
} from '../../services/attachments.js'
import {
  IMAGE_EDIT_ACCEPT,
  MAX_IMAGE_EDIT_COUNT,
  MAX_IMAGE_EDIT_MB,
  MAX_IMAGE_EDIT_TOTAL_MB,
  resolveImageEditSources,
} from '../../services/imageEditSource.js'
import { DraftAttachments } from './DraftAttachments.js'
import { useVoiceInput } from './useVoiceInput.js'
import { VoiceButton } from './VoiceButton.js'
import { Spectrum } from './Spectrum.js'
import { AddIcon, CameraIcon, ChatIcon, FileIcon, ImageIcon } from './ComposerIcons.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ChatInput.module.css'

type ImageReference = { file: File; url: string }

/** 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const imageProvider = useActiveImageProvider()
  const locale = useSettings(state => state.locale)
  const needsConfiguration = useSettings(state => !state.apiKey)
  const canRedeemInvite = useSyncExternalStore(subscribeRuntimeUser, () => getRuntime().user.invite_redeemable)
  const [imageCount, setImageCount] = useState(1)
  const [imageSelected, setImageMode] = useState(false)
  const [imageReferences, setImageReferences] = useState<ImageReference[]>([])
  const imageReferencesRef = useRef<ImageReference[]>([])
  const [uploadOpen, setUploadOpen] = useState(false)
  const uploadPanelId = useId()
  const imageAvailable = imageProvider !== null
  const imageMode = imageSelected
  const editMode = imageMode && imageReferences.length > 0
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useSettings((state) => state.thinking)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const search = useSettings((state) => state.search)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const updateImageReferences = useCallback((next: ImageReference[]) => {
    for (const reference of imageReferencesRef.current) {
      if (!next.includes(reference)) {
        URL.revokeObjectURL(reference.url)
      }
    }
    imageReferencesRef.current = next
    setImageReferences(next)
  }, [])

  useEffect(() => () => {
    for (const reference of imageReferencesRef.current) {
      URL.revokeObjectURL(reference.url)
    }
  }, [])

  const addImageReferences = useCallback((files: File[]) => {
    const current = imageReferencesRef.current
    const selection = resolveImageEditSources([...current.map((reference) => reference.file), ...files])
    if ('error' in selection) {
      showToast(selection.error)
      return false
    }
    const added = selection.sources
      .slice(current.length)
      .map((file) => ({ file, url: URL.createObjectURL(file) }))
    updateImageReferences([...current, ...added])
    return true
  }, [updateImageReferences])

  useEffect(() => {
    if (sessionId === null) {
      return
    }
    let focusFrame = 0
    const useImageForEdit = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail?.sessionId !== sessionId) {
        return
      }
      const state = useChatStore.getState()
      if (
        !isSessionActive() || !activeImageProvider() || state.activeId !== sessionId || state.importingHistory ||
        Object.hasOwn(state.streaming, sessionId) || !(event.detail.source instanceof File)
      ) {
        event.preventDefault()
        return
      }
      if (getDraft(sessionId).attachments.length > 0) {
        showToast({ key: 'imageTextOnly' })
        event.preventDefault()
        return
      }
      if (!addImageReferences([event.detail.source])) {
        event.preventDefault()
        return
      }
      setImageMode(true)
      setUploadOpen(false)
      cancelAnimationFrame(focusFrame)
      if (!isMobile) {
        focusFrame = requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
      }
    }
    document.addEventListener('deepseek:use-image-for-edit', useImageForEdit)
    return () => {
      cancelAnimationFrame(focusFrame)
      document.removeEventListener('deepseek:use-image-for-edit', useImageForEdit)
    }
  }, [sessionId, isMobile, addImageReferences])

  const acceptFiles = (files: File[]) => {
    if (files.length === 0 || !isSessionActive() || useChatStore.getState().importingHistory) {
      return
    }
    if (imageMode) {
      if (!streaming) {
        addImageReferences(files)
      }
      return
    }
    if (!ensureApiKey()) {
      return
    }
    const error = addDraftFiles(
      sessionId,
      normalizeUploadFiles(files),
      useSettings.getState().apiKey ?? ''
    )
    if (error) {
      showToast(error)
    }
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey()) {
        retryDraftAttachment(sessionId, id, useSettings.getState().apiKey ?? '')
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)
  const chooseFile = (kind: 'camera' | 'image' | 'file') => {
    if (!ensureApiKey() || importingHistory || imageMode) {
      return
    }
    const input =
      kind === 'camera' ? cameraInputRef : kind === 'image' ? imageInputRef : fileInputRef
    input.current?.click()
  }
  const changeMode = (next: boolean) => {
    if (next && attachments.length > 0) {
      showToast(t('imageTextOnly'))
      return
    }
    setImageMode(next)
    setUploadOpen(false)
  }

  /** 转写结果插入到光标处，并把光标移到插入内容之后 */
  const voice = useVoiceInput((transcript) => {
    const textarea = textareaRef.current
    const current = getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    setText(current.slice(0, start) + transcript + current.slice(end))
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  })

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
          updateImageReferences([])
        }
      }),
    [cancelVoice, updateImageReferences]
  )

  // 移动端录音时用频谱替代输入框内容
  const recording = voice.status === 'recording'

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  const canSend =
    !importingHistory &&
    !streaming &&
    voice.status === 'idle' &&
    (imageMode ? imageAvailable && !!text.trim() && attachments.length === 0 && text.length <= 8000 : draftReady)

  const send = () => {
    if (useChatStore.getState().importingHistory || streaming || voice.status !== 'idle') {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    const currentDraft = getDraft(sessionId)
    if (imageMode && currentDraft.attachments.length > 0) {
      showToast(t('imageTextOnly'))
      return
    }
    if (imageMode && currentDraft.text.length > 8000) {
      showToast(t('imagePromptLimit'))
      return
    }
    if (!imageMode) {
      if (!prepareDraftMessage(currentDraft, useUploads.getState().tasks)) {
        return
      }
      if (!ensureApiKey()) {
        if (isMobile) {
          textareaRef.current?.blur()
        }
        return
      }
    }
    const references = imageReferencesRef.current
    const sources = references.length > 0 ? references.map((reference) => reference.file) : undefined
    const sent = imageMode
      ? sendImageMessage(sessionId, sources ? 1 : imageCount, sources)
      : sendMessage(sessionId)
    if (!sent) {
      return
    }
    if (imageMode) {
      updateImageReferences([])
    }
    stopReadAloud()
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  const placeholder = t(editMode ? 'imageEditPromptPlaceholder' : imageMode ? 'imagePromptPlaceholder' : 'chatInputPlaceholderChat')

  return (
    <div
      className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      {needsConfiguration && !imageMode ? (
        <div className={styles.modeRow}>
          <button type="button" className={styles.modeTab} aria-haspopup="dialog" onClick={openChatProvider}>
            {t(canRedeemInvite ? 'chatProviderSetup' : 'chatProviderGuestSetup')}
          </button>
        </div>
      ) : null}
      {imageAvailable || imageMode ? (
        <div className={styles.modeRow}>
          <div className={styles.modeTabs} role="group" aria-label={t('composerMode')}>
            <button
              type="button"
              className={clsx(styles.modeTab, !imageMode && styles.modeActive)}
              aria-pressed={!imageMode}
              disabled={streaming || importingHistory}
              onClick={() => changeMode(false)}
            >
              <ChatIcon />
              {t('chatMode')}
            </button>
            <button
              type="button"
              className={clsx(styles.modeTab, imageMode && styles.modeActive)}
              aria-pressed={imageMode}
              disabled={streaming || importingHistory || !imageAvailable}
              onClick={() => changeMode(true)}
            >
              <ImageIcon />
              {t('imageMode')}
            </button>
          </div>
          {imageMode && !editMode ? (
            <select
              className={styles.imageCount}
              aria-label={locale === 'zh-CN' ? '生成张数' : 'Image count'}
              value={imageCount}
              onChange={(event) => setImageCount(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5].map((count) => (
                <option key={count} value={count}>
                  {locale === 'zh-CN' ? `${count} 张` : `${count} image${count === 1 ? '' : 's'}`}
                </option>
              ))}
            </select>
          ) : null}
          {imageMode ? (
            <span className={styles.imageHint}>
              {imageProvider === 'personal'
                ? locale === 'zh-CN' ? '使用个人生图 API，由服务商计费。' : 'Billed by your image provider.'
                : t(imageProvider === 'managed' ? 'imageManagedQuotaHint' : 'imageProviderUnavailable')}
            </span>
          ) : null}
        </div>
      ) : null}
      <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
      {editMode ? (
        <ul className={styles.imageReferences} role="list" aria-label={t('imageEditChooseSource')}>
          {imageReferences.map((reference, index) => {
            const label = t('imageEditRemoveSource', { index: index + 1, name: reference.file.name })
            return (
              <li key={reference.url} className={clsx(styles.attachment, styles.imageReference)} title={reference.file.name}>
                <img src={reference.url} alt={reference.file.name} />
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={label}
                  title={label}
                  disabled={streaming || importingHistory}
                  onClick={() => updateImageReferences(imageReferencesRef.current.filter((item) => item !== reference))}
                >
                  <IconCloseOutline16 />
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
          placeholder={placeholder}
          aria-label={placeholder}
          rows={2}
          // 移动端不自动聚焦，避免一打开就弹出键盘
          autoFocus={!isMobile}
          disabled={importingHistory}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onFocus={() => setUploadOpen(false)}
          onMouseDown={(event) => {
            // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
            if (isMobile && event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length > 0) {
              event.preventDefault()
              acceptFiles(files)
            }
          }}
        />
        {recording && isMobile ? <Spectrum getAnalyser={voice.getAnalyser} /> : null}
        <div className={styles.mirror} aria-hidden>
          {`${text}\n`}
        </div>
      </div>
      <div className={styles.functionRow}>
        {!imageMode ? (
          <IconButton
            size="m"
            tone="primary"
            className={clsx(styles.addButton, uploadOpen && styles.addActive)}
            icon={uploadOpen ? <IconCloseOutline16 /> : <AddIcon />}
            aria-label={t(uploadOpen ? 'closeUploadPanel' : 'addAttachments')}
            aria-expanded={uploadOpen}
            aria-controls={uploadPanelId}
            disabled={importingHistory}
            onClick={() => {
              textareaRef.current?.blur()
              setUploadOpen(!uploadOpen)
            }}
          />
        ) : null}
        <div className={styles.toggles}>
          {!imageMode ? (
            <>
              <Tooltip content={t('deactivatedThinkTooltip')}>
                <button
                  type="button"
                  className={clsx(styles.toggle, thinking && styles.selected)}
                  aria-label={t('thinkingSwitch')}
                  aria-pressed={thinking}
                  onClick={() => setThinking(!thinking)}
                >
                  <IconThinkOutline14 />
                  <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
                </button>
              </Tooltip>
              <Tooltip content={t('deactivatedSearchTooltip')}>
                <button
                  type="button"
                  className={clsx(styles.toggle, search && styles.selected)}
                  aria-label={t('search')}
                  aria-pressed={search}
                  onClick={() => setSearch(!search)}
                >
                  <IconGlobeLanguageOutline14 />
                  <span className={styles.toggleLabel}>{t('search')}</span>
                </button>
              </Tooltip>
            </>
          ) : (
            <button
              type="button"
              className={styles.toggle}
              title={t('imageEditSourceHint', { count: MAX_IMAGE_EDIT_COUNT, size: MAX_IMAGE_EDIT_MB, total: MAX_IMAGE_EDIT_TOTAL_MB })}
              disabled={streaming || importingHistory || imageReferences.length >= MAX_IMAGE_EDIT_COUNT}
              onClick={() => {
                textareaRef.current?.blur()
                editInputRef.current?.click()
              }}
            >
              <ImageIcon />
              <span>{t('imageEditChooseSource')}</span>
            </button>
          )}
        </div>
        <div className={styles.right}>
          <VoiceButton
            status={voice.status}
            disabled={!voice.available}
            seconds={voice.seconds}
            onClick={() => {
              if (
                voice.status !== 'idle' ||
                (!useChatStore.getState().importingHistory && ensureApiKey())
              ) {
                void voice.toggle()
              }
            }}
          />
          {streaming && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('chatInputStopButtonTooltip')}
              onClick={() => {
                stopReadAloud()
                stopReply(sessionId)
              }}
            >
              <IconStopFill16 />
            </button>
          ) : (
            <button
              type="button"
              className={clsx(styles.sendButton, !canSend && styles.disabled)}
              aria-label={t(editMode ? 'editImage' : imageMode ? 'generateImage' : 'send')}
              disabled={!canSend}
              onClick={send}
            >
              <IconSendOutline16 />
            </button>
          )}
        </div>
      </div>
      {uploadOpen && !imageMode ? (
        <div
          id={uploadPanelId}
          className={styles.uploadPanel}
          role="group"
          aria-label={t('addAttachments')}
        >
          <button type="button" onClick={() => chooseFile('camera')}>
            <CameraIcon />
            <span>{t('takePhoto')}</span>
          </button>
          <button type="button" onClick={() => chooseFile('image')}>
            <ImageIcon />
            <span>{t('choosePhotos')}</span>
          </button>
          <button type="button" onClick={() => chooseFile('file')}>
            <FileIcon />
            <span>{t('chooseFiles')}</span>
          </button>
        </div>
      ) : null}
      {imageMode ? (
        <input
          ref={editInputRef}
          type="file"
          multiple
          hidden
          accept={IMAGE_EDIT_ACCEPT}
          data-upload-kind="image-edit"
          onChange={(event) => {
            acceptFiles(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
      ) : null}
      <input
        ref={imageInputRef}
        type="file"
        multiple
        hidden
        accept={IMAGE_ACCEPT}
        data-upload-kind="image"
        onChange={(event) => {
          acceptFiles(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        hidden
        accept={IMAGE_ACCEPT}
        capture="environment"
        data-upload-kind="camera"
        onChange={(event) => {
          acceptFiles(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        accept={ACCEPT}
        data-upload-kind="file"
        onChange={(event) => {
          acceptFiles(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      {dragging ? <DragMask imageEdit={imageMode} /> : null}
    </div>
  )
}
