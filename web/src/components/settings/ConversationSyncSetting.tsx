import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { KeyBackupControls } from './KeyBackupSetting.js'
import { useTranslate } from '../../i18n/index.js'
import {
  clearCloudConversations,
  refreshConversationSync,
  setConversationSyncEnabled,
  syncConversationsNow,
  useConversationSync,
  type SyncScopes,
} from '../../services/conversationSync.js'
import { getRuntime, isSessionActive } from '../../services/runtime.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { showConversationShareControls } from '../session/conversationShareVisibility.js'
import settingStyles from './Settings.module.css'
import styles from './ConversationSyncSetting.module.css'

type Action = 'configure' | 'disable' | 'clear' | 'sync' | 'refresh'
type Dialog = 'enable' | 'manage' | 'clear' | 'key'

export const ConversationSyncSetting = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const { eligible, enabled, loading, syncing, error, lastSyncedAt, generation, scopes, supportsAttachments } =
    useConversationSync()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [draft, setDraft] = useState<{ scopes: SyncScopes; generation: number } | null>(null)
  const [action, setAction] = useState<Action | null>(null)
  const pending = useRef(false)
  const labelId = useId()
  const descriptionId = useId()
  const busy = action !== null
  const problem = error
  const unavailable = disabled || loading || busy

  useEffect(() => {
    void refreshConversationSync().catch(() => {})
  }, [])

  const perform = async (next: Action, operation: () => Promise<void>): Promise<boolean> => {
    if (pending.current) {
      return false
    }
    pending.current = true
    setAction(next)
    try {
      await operation()
      return true
    } catch {
      return false
    } finally {
      pending.current = false
      setAction(null)
    }
  }

  const syncWithFeedback = async () => {
    const owner = getRuntime().user.id
    const active = () => isSessionActive() && getRuntime().user.id === owner
    const previous = useConversationSync.getState().lastSyncedAt
    const timer = window.setTimeout(() => {
      if (active()) {
        showToast({ key: 'conversationSyncProgress' })
      }
    }, 1000)
    try {
      await syncConversationsNow()
      const result = useConversationSync.getState()
      if (active() && result.enabled && !result.error && result.lastSyncedAt !== previous) {
        showToast({ key: 'conversationSyncComplete' })
      }
    } catch (error) {
      if (active()) {
        showToast({ key: 'conversationSyncFailedNotice', type: 'error' })
      }
      throw error
    } finally {
      window.clearTimeout(timer)
    }
  }

  function openScopes() {
    setDraft({
      scopes: supportsAttachments && generation === 0 ? { ...scopes, attachments: false } : scopes,
      generation,
    })
    setDialog(enabled ? 'manage' : 'enable')
  }

  const saveScopes = async () => {
    if (draft && await perform('configure', () => setConversationSyncEnabled(true, draft.scopes, draft.generation))) {
      setDialog(null)
      if (useConversationSync.getState().enabled && isSessionActive()) {
        await perform('sync', syncWithFeedback)
      }
    }
  }

  const clear = async () => {
    if (await perform('clear', clearCloudConversations)) {
      setDialog(null)
      showToast({ key: 'conversationSyncCleared' })
    }
  }

  const scopeOptions = [
    { id: 'conversations', label: t(supportsAttachments ? 'conversationSyncChatText' : 'conversationSyncChats'),
      description: t(supportsAttachments ? 'conversationSyncChatTextDescription' : 'conversationSyncChatsDescription') },
    { id: 'preferences', label: t('conversationSyncPreferences'), description: t('conversationSyncPreferencesDescription') },
    { id: 'attachments', label: t('conversationSyncAttachments'), description: t('conversationSyncAttachmentsDescription') },
  ] as const
  const visibleOptions = scopeOptions.filter(({ id }) => id !== 'attachments' || supportsAttachments)
  const scopeSummary = visibleOptions
    .filter(({ id }) => scopes[id] && (id !== 'attachments' || scopes.conversations))
    .map(({ label }) => label).join(' · ')
  const choosing = eligible && (dialog === 'enable' || dialog === 'manage') && draft
  const noScopesSelected = !draft?.scopes.conversations && !draft?.scopes.preferences
  const changesPending = visibleOptions.some(({ id }) => draft?.scopes[id] !== scopes[id])

  const status = loading
    ? t('conversationSyncLoading')
    : busy && action !== 'sync' && action !== 'refresh'
      ? t('conversationSyncUpdating')
      : syncing || action === 'sync'
        ? t('conversationSyncProgress')
        : enabled
          ? lastSyncedAt
            ? t('conversationSyncLastSynced', {
                time: new Date(lastSyncedAt).toLocaleString(locale, {
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              })
            : t('conversationSyncEnabled')
          : t('conversationSyncDisabled')

  return (
    <>
      <div className={clsx(settingStyles.cell, styles.section)}>
        <div className={styles.heading}>
          <div id={labelId} className={settingStyles.label}>
            {t('conversationSyncTitle')}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            className={styles.toggle}
            disabled={unavailable || !eligible}
            onClick={() => {
              if (enabled) {
                void perform('disable', () => setConversationSyncEnabled(false))
              } else {
                openScopes()
              }
            }}
          />
        </div>
        <p id={descriptionId} className={styles.description}>
          {eligible ? (enabled ? scopeSummary : t('conversationSyncDescription')) : t('conversationSyncInviteOnly')}
        </p>
        {eligible || loading || busy ? (
          <p className={styles.status} role="status" aria-live="polite">
            {status}
          </p>
        ) : null}
        {problem ? (
          <p className={styles.error} role="alert">
            {problem}
          </p>
        ) : null}
        <div className={styles.actions}>
          {enabled || problem ? (
            <Button
              variant="outlined"
              size="s"
              disabled={unavailable || syncing}
              onClick={() => {
                if (enabled) {
                  void perform('sync', syncWithFeedback)
                } else {
                  void perform('refresh', refreshConversationSync)
                }
              }}
            >
              {t(
                enabled
                  ? problem
                    ? 'conversationSyncRetry'
                    : 'conversationSyncNow'
                  : 'conversationSyncRefresh'
              )}
            </Button>
          ) : null}
          {enabled ? (
            <button type="button" className={styles.secondaryAction} disabled={unavailable} aria-haspopup="dialog" onClick={openScopes}>
              {t('conversationSyncManage')}
            </button>
          ) : generation > 0 ? (
            <Button
              variant="dangerOutlined"
              size="s"
              disabled={unavailable}
              onClick={() => setDialog('clear')}
            >
              {t('conversationSyncClear')}
            </Button>
          ) : null}
        </div>
      </div>
      {choosing || dialog === 'clear' || (dialog === 'key' && enabled) ? (
        <Modal
          title={t(
            dialog === 'key' ? 'keyBackupTitle' : dialog === 'clear' ? 'conversationSyncClearTitle' :
              dialog === 'enable' ? 'conversationSyncEnableTitle' : 'conversationSyncManage'
          )}
          className={styles.confirmation}
          closable
          onClose={() => {
            if (!busy) {
              setDialog(null)
            }
          }}
          footer={
            <div className={styles.confirmActions}>
              <Button
                variant="outlined"
                disabled={busy}
                onClick={() => setDialog(dialog === 'key' ? 'manage' : null)}
              >
                {t(dialog === 'key' ? 'conversationSyncBackToSettings' : 'cancel')}
              </Button>
              {dialog === 'clear' ? (
                <Button variant="danger" disabled={unavailable} onClick={() => void clear()}>
                  {t(busy ? 'conversationSyncUpdating' : 'conversationSyncClearConfirm')}
                </Button>
              ) : choosing ? (
                <Button disabled={unavailable || noScopesSelected || (dialog === 'manage' && !changesPending)} onClick={() => void saveScopes()}>
                  {t(busy ? 'conversationSyncUpdating' : dialog === 'enable' ? 'conversationSyncEnableConfirm' : 'conversationSyncSaveScopes')}
                </Button>
              ) : null}
            </div>
          }
        >
          {choosing ? (
            <>
              <p className={styles.confirmText}>{t(dialog === 'enable' ? 'conversationSyncEnableDescription' : 'conversationSyncPauseScope')}</p>
              <div className={styles.scopeList}>
                {visibleOptions.map(({ id, label, description }) => (
                  <label className={styles.scopeOption} key={id}>
                    <input
                      type="checkbox"
                      checked={draft.scopes[id] && (id !== 'attachments' || draft.scopes.conversations)}
                      disabled={unavailable || (id === 'attachments' && !draft.scopes.conversations)}
                      onChange={(event) => {
                        const checked = event.target.checked
                        setDraft({
                          ...draft,
                          scopes: {
                            ...draft.scopes,
                            [id]: checked,
                            ...(supportsAttachments && id === 'conversations' && !checked ? { attachments: false } : {}),
                          },
                        })
                      }}
                    />
                    <span>
                      <span className={styles.scopeLabel}>{label}</span>
                      <span className={styles.description}>{description}</span>
                    </span>
                  </label>
                ))}
              </div>
              {dialog === 'manage' ? (
                <div className={styles.scopeTools}>
                  <button type="button" className={styles.secondaryAction} disabled={unavailable || !enabled} onClick={() => setDialog('key')}>
                    {t('keyBackupTitle')}
                  </button>
                  <button type="button" className={clsx(styles.secondaryAction, styles.dangerAction)} disabled={unavailable} onClick={() => setDialog('clear')}>
                    {t('conversationSyncClear')}
                  </button>
                </div>
              ) : <p className={styles.description}>{t('conversationSyncKeyOptional')}</p>}
            </>
          ) : dialog === 'clear' ? (
            <>
              <p className={styles.confirmText}>{t('conversationSyncClearDescription')}</p>
              <p className={styles.confirmText}>
                {t(showConversationShareControls ? 'conversationSyncClearShares' : 'conversationSyncClearSharesHidden')}
              </p>
            </>
          ) : <KeyBackupControls key={generation} generation={generation} />}
          {problem && dialog !== 'key' ? (
            <p className={styles.error} role="alert">
              {problem}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </>
  )
}
