import { useState, useSyncExternalStore } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { memoryForExport, memorySummary } from '../../services/chat/contextMemory.js'
import { createSessionExport, saveSessionExport } from '../../services/chat/sessionExport.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { buildOrganizePayload } from '../../services/chat/organize.js'
import {
  isNativeConnected,
  sendNative,
  subscribeNativeBridge,
} from '../../services/nativeBridge.js'
import {
  addPinnedMemory,
  removeMemoryEntry,
  retryMemoryPreparation,
  setMemoryEnabled,
  updateMemoryEntry,
  useChatStore,
} from '../../services/chat/store.js'
import type { Message, Session } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import {
  IconDataOutline16,
  IconDownloadOutline16,
  IconEllipsisOutline16,
  IconLinkOutline16,
} from '../base/icons.js'
import { Menu } from '../base/Menu.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './MemoryActions.module.css'
import { ConversationShareDialog } from './ConversationShareDialog.js'
import { showConversationShareControls } from './conversationShareVisibility.js'

type ExportFormat = 'markdown' | 'text' | 'json' | 'zip'

/** 常用聊天操作只占一个按钮，记忆管理和导出按需展开。 */
export const MemoryActions = ({ session, disabled }: { session: Session; disabled: boolean }) => {
  const t = useTranslate()
  const messages = getVisibleMessages(session)
  const showShare = showConversationShareControls && messages.length > 0 &&
    !messages.some(message => message.role === 'assistant' && message.status === 'done')
  const [panel, setPanel] = useState<'memory' | 'export' | 'share' | null>(null)
  const importing = useChatStore((state) => state.importingHistory)
  return (
    <>
      <Menu
        align="end"
        options={[
          ...(showShare ? [{
            key: 'share',
            label: t('conversationShareTitle'),
            icon: <IconLinkOutline16 />,
            disabled: disabled || importing,
            onSelect: () => setPanel('share'),
          }] : []),
          {
            key: 'export',
            label: t('exportSession'),
            icon: <IconDownloadOutline16 />,
            onSelect: () => setPanel('export'),
          },
          {
            key: 'memory',
            label: t('conversationMemory'),
            icon: <IconDataOutline16 />,
            onSelect: () => setPanel('memory'),
          },
        ]}
      >
        {({ open, toggle }) => (
          <IconButton
            size="xl"
            tone="primary"
            icon={<IconEllipsisOutline16 />}
            aria-label={t('sessionActions')}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
          />
        )}
      </Menu>
      {showConversationShareControls && panel === 'share' ? (
        <ConversationShareDialog
          key={session.id}
          session={session}
          onClose={() => setPanel(null)}
        />
      ) : null}
      {panel === 'export' ? (
        <ExportPanel session={session} disabled={disabled} onClose={() => setPanel(null)} />
      ) : null}
      {panel === 'memory' ? (
        <MemoryPanel session={session} disabled={disabled} onClose={() => setPanel(null)} />
      ) : null}
    </>
  )
}

const ExportPanel = ({
  session,
  disabled,
  onClose,
}: {
  session: Session
  disabled: boolean
  onClose: () => void
}) => {
  const t = useTranslate()
  const connected = useSyncExternalStore(subscribeNativeBridge, isNativeConnected)
  const importing = useChatStore((state) => state.importingHistory)
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState(false)
  const [appHelp, setAppHelp] = useState(false)
  const choices = [
    { value: 'markdown', title: t('exportMarkdown'), hint: t('exportMarkdownHint') },
    { value: 'text', title: t('exportText'), hint: t('exportTextHint') },
    { value: 'zip', title: t('exportZip'), hint: t('exportZipHint') },
    { value: 'json', title: t('exportJson'), hint: t('exportJsonHint') },
  ] as const
  const run = async () => {
    setBusy(true)
    try {
      saveSessionExport(await createSessionExport(session, format))
      showToast(t('exportStarted'))
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('exportFailed'))
    } finally {
      setBusy(false)
    }
  }
  const organize = async () => {
    if (!connected) {
      setAppHelp(true)
      return
    }
    const payload = buildOrganizePayload(session)
    if (payload.messages.length === 0) {
      showToast(t('memoryNothingToOrganize'))
      return
    }
    setOpening(true)
    try {
      await sendNative('organize', payload)
      onClose()
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('memoryHandoffFailed'))
    } finally {
      setOpening(false)
    }
  }
  return (
    <Modal
      title={t('exportSession')}
      closable
      onClose={onClose}
      footer={
        <Button disabled={busy || opening} onClick={() => void run()}>
          {t(busy ? 'exportPreparing' : 'exportOriginal')}
        </Button>
      }
    >
      <h3 className={styles.exportHeading}>{t('exportOriginal')}</h3>
      <p className={styles.explanation}>{t('exportSessionDescription')}</p>
      <div className={styles.exportChoices}>
        {choices.map((choice) => (
          <label key={choice.value} className={styles.exportChoice}>
            <input
              type="radio"
              name="session-export-format"
              value={choice.value}
              checked={format === choice.value}
              disabled={busy || opening}
              onChange={() => setFormat(choice.value)}
            />
            <span>
              <strong>{choice.title}</strong>
              <small>{choice.hint}</small>
            </span>
          </label>
        ))}
      </div>
      <div className={styles.organizeSection}>
        <button
          type="button"
          className={styles.organizeButton}
          aria-label={t('exportOrganizeFirst')}
          disabled={busy || opening || disabled || importing}
          onClick={() => void organize()}
        >
          <IconDataOutline16 />
          <span>
            <strong>{t(opening ? 'memoryOpening' : 'exportOrganizeFirst')}</strong>
            <small>{t('exportOrganizeFirstHint')}</small>
          </span>
        </button>
        {appHelp ? (
          <p className={styles.appHelp} role="status">
            {t('exportOrganizeAppOnly')} <a href="/deepseek/download">{t('downloadApp')}</a>
          </p>
        ) : null}
      </div>
    </Modal>
  )
}

const originalText = (message: Message) =>
  message.role === 'user'
    ? [message.content, ...message.files.map((file) => `[${file.name}]`)].filter(Boolean).join('\n')
    : message.blocks
        .flatMap((block) =>
          block.type === 'text' ? [block.text] : block.type === 'image' ? [`[${block.name}]`] : []
        )
        .join('\n')

const MemoryPanel = ({
  session,
  disabled,
  onClose,
}: {
  session: Session
  disabled: boolean
  onClose: () => void
}) => {
  const t = useTranslate()
  const activity = useChatStore((state) => state.memoryActivity[session.id])
  const memory = session.longMemory
  const entries = memoryForExport(session)
  const capacityReached = memorySummary(session).capacityReached
  const importing = useChatStore((state) => state.importingHistory)
  const [adding, setAdding] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [sources, setSources] = useState<string | null>(null)
  const readonly = disabled || importing || activity?.status === 'compressing'
  const addMemory = () => {
    if (!addPinnedMemory(session.id, adding.trim())) {
      showToast(t('memoryChangeFailed'))
      return
    }
    setAdding('')
  }
  return (
    <Modal
      title={t('conversationMemory')}
      closable
      onClose={onClose}
      className={styles.memoryModal}
      mainClassName={styles.memoryMain}
    >
      <label className={styles.memorySwitch}>
        <span>
          <strong>{t('automaticMemory')}</strong>
          <small>{t('automaticMemoryDescription')}</small>
        </span>
        <input
          type="checkbox"
          checked={memory?.enabled !== false}
          disabled={readonly}
          onChange={(event) => setMemoryEnabled(session.id, event.target.checked)}
        />
      </label>
      {memory?.enabled === false ? (
        <p className={styles.explanation}>{t('memoryDisabledHint')}</p>
      ) : null}
      {activity?.status === 'compressing' ? (
        <p className={styles.status} role="status">
          {t('memoryCompressing')}
        </p>
      ) : null}
      {activity?.extraCalls ? (
        <p className={styles.meta}>{t('memoryExtraCall', { count: activity.extraCalls })}</p>
      ) : null}
      {capacityReached ? (
        <p className={styles.status} role="status">
          {t('memoryCapacityReached')}
        </p>
      ) : null}
      {activity?.status === 'limited' || activity?.status === 'error' ? (
        <div className={styles.memoryProblem} role="status">
          <p>
            {activity.message ||
              t(activity.status === 'error' ? 'memoryPreparationFailed' : 'memoryLimited')}
          </p>
          <button
            type="button"
            className={styles.textAction}
            disabled={readonly}
            onClick={() => {
              showToast(
                t(retryMemoryPreparation(session.id) ? 'memoryRetryQueued' : 'memoryChangeFailed')
              )
            }}
          >
            {t('memoryRetryNext')}
          </button>
        </div>
      ) : null}
      <div className={styles.memoryEntries}>
        {entries.length === 0 ? <p className={styles.empty}>{t('memoryEntriesEmpty')}</p> : null}
        {entries.map((entry) => (
          <article key={entry.id} className={styles.memoryEntry}>
            <div className={styles.entryMeta}>
              <span>
                {t(
                  entry.pinned ? 'memoryPinned' : entry.edited ? 'memoryEdited' : 'memoryAutomatic'
                )}
              </span>
              <time dateTime={new Date(entry.createdAt).toISOString()}>
                {new Date(entry.createdAt).toLocaleDateString()}
              </time>
            </div>
            {editing === entry.id ? (
              <>
                <textarea
                  className={styles.editor}
                  value={text}
                  maxLength={4000}
                  aria-label={t('memoryEdit')}
                  onChange={(event) => setText(event.target.value)}
                />
                <div className={styles.entryActions}>
                  <button
                    type="button"
                    className={styles.textAction}
                    onClick={() => setEditing(null)}
                  >
                    {t('cancel')}
                  </button>
                  <button
                    type="button"
                    className={styles.textAction}
                    disabled={readonly || !text.trim()}
                    onClick={() => {
                      if (updateMemoryEntry(session.id, entry.id, { text: text.trim() })) {
                        setEditing(null)
                      } else {
                        showToast(t('memoryChangeFailed'))
                      }
                    }}
                  >
                    {t('memorySave')}
                  </button>
                </div>
              </>
            ) : (
              <p className={styles.entryText}>{entry.text}</p>
            )}
            <div className={styles.entryActions}>
              <button
                type="button"
                className={styles.textAction}
                disabled={readonly}
                onClick={() => {
                  setEditing(entry.id)
                  setText(entry.text)
                }}
              >
                {t('memoryEdit')}
              </button>
              <button
                type="button"
                className={styles.textAction}
                disabled={readonly}
                onClick={() => {
                  if (!updateMemoryEntry(session.id, entry.id, { pinned: !entry.pinned })) {
                    showToast(t('memoryChangeFailed'))
                  }
                }}
              >
                {t(entry.pinned ? 'memoryUnpin' : 'memoryPin')}
              </button>
              <button
                type="button"
                className={styles.textAction}
                disabled={readonly}
                onClick={() => {
                  showToast(
                    t(
                      removeMemoryEntry(session.id, entry.id)
                        ? 'memoryDeleted'
                        : 'memoryChangeFailed'
                    )
                  )
                }}
              >
                {t('memoryDelete')}
              </button>
            </div>
            {entry.sourceIds.length > 0 ? (
              <>
                <button
                  type="button"
                  className={styles.sourceToggle}
                  aria-expanded={sources === entry.id}
                  onClick={() => setSources(sources === entry.id ? null : entry.id)}
                >
                  {t('memorySources', { count: entry.sourceIds.length })}
                </button>
                {sources === entry.id ? (
                  <div className={styles.sources}>
                    {entry.sourceIds.map((id) => {
                      const original = session.messages.find((message) => message.id === id)
                      return (
                        <blockquote key={id}>
                          {original ? (
                            <>
                              <strong>
                                {t(
                                  original.role === 'user'
                                    ? 'memoryOriginalRoleUser'
                                    : 'memoryOriginalRoleAssistant'
                                )}
                              </strong>
                              <p>{originalText(original)}</p>
                            </>
                          ) : (
                            t('memorySourceMissing')
                          )}
                        </blockquote>
                      )
                    })}
                  </div>
                ) : null}
              </>
            ) : (
              <p className={styles.meta}>{t('memoryManualSource')}</p>
            )}
          </article>
        ))}
      </div>
      <form
        className={styles.addMemory}
        onSubmit={(event) => {
          event.preventDefault()
          if (adding.trim() && !readonly) {
            addMemory()
          }
        }}
      >
        <label htmlFor="pin-chat-memory">{t('memoryAdd')}</label>
        <textarea
          id="pin-chat-memory"
          className={styles.editor}
          placeholder={t('memoryAddPlaceholder')}
          value={adding}
          maxLength={4000}
          disabled={readonly}
          onChange={(event) => setAdding(event.target.value)}
        />
        <Button
          size="s"
          disabled={readonly || !adding.trim()}
          onClick={() => {
            addMemory()
          }}
        >
          {t('memoryPin')}
        </Button>
      </form>
      {session.continuity ? (
        <details className={styles.background}>
          <summary>
            {t('memoryOriginalBackground')} · {session.continuity.title}
          </summary>
          <p className={styles.explanation}>{t('memoryBackgroundExplanation')}</p>
          <pre className={styles.original}>{session.continuity.text}</pre>
        </details>
      ) : null}
    </Modal>
  )
}

/** 仅在自动维护或需要用户留意时占用一行；普通聊天保持安静。 */
export const ContinuityNotice = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const activity = useChatStore((state) => state.memoryActivity[session.id])
  if (!activity || !['compressing', 'limited', 'error'].includes(activity.status)) {
    return null
  }
  return (
    <div className={styles.notice} role="status">
      {t(
        activity.status === 'compressing'
          ? 'memoryCompressing'
          : activity.status === 'error'
            ? 'memoryPreparationFailed'
            : 'memoryLimited'
      )}
    </div>
  )
}
