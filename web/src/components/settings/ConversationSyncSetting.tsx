import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { KeyBackupSetting } from './KeyBackupSetting.js'
import { useTranslate } from '../../i18n/index.js'
import {
  clearCloudConversations,
  refreshConversationSync,
  setConversationSyncEnabled,
  syncConversationsNow,
  useConversationSync,
} from '../../services/conversationSync.js'
import { getRuntime, isSessionActive } from '../../services/runtime.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import settingStyles from './Settings.module.css'
import styles from './ConversationSyncSetting.module.css'

type Action = 'enable' | 'disable' | 'clear' | 'sync' | 'refresh'

export const ConversationSyncSetting = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const { eligible, enabled, loading, syncing, error, lastSyncedAt, generation } =
    useConversationSync()
  const [confirmation, setConfirmation] = useState<'enable' | 'clear' | null>(null)
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

  const confirm = async () => {
    if (confirmation === 'enable') {
      if (await perform('enable', () => setConversationSyncEnabled(true))) {
        setConfirmation(null)
        if (useConversationSync.getState().enabled && isSessionActive()) {
          await perform('sync', syncWithFeedback)
        }
      }
    } else if (confirmation === 'clear') {
      if (await perform('clear', clearCloudConversations)) {
        setConfirmation(null)
        showToast({ key: 'conversationSyncCleared' })
      }
    }
  }

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
                setConfirmation('enable')
              }
            }}
          />
        </div>
        <p id={descriptionId} className={styles.description}>
          {t(eligible ? 'conversationSyncDescription' : 'conversationSyncInviteOnly')}
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
          {eligible || generation > 0 ? (
            <Button
              variant="dangerOutlined"
              size="s"
              disabled={unavailable}
              onClick={() => {
                setConfirmation('clear')
              }}
            >
              {t('conversationSyncClear')}
            </Button>
          ) : null}
          {enabled && !disabled ? <KeyBackupSetting generation={generation} /> : null}
        </div>
      </div>
      {confirmation && (confirmation !== 'enable' || eligible) ? (
        <Modal
          title={t(
            confirmation === 'enable' ? 'conversationSyncEnableTitle' : 'conversationSyncClearTitle'
          )}
          className={styles.confirmation}
          onClose={() => {
            if (!busy) {
              setConfirmation(null)
            }
          }}
          footer={
            <div className={styles.confirmActions}>
              <Button
                variant="outlined"
                autoFocus
                disabled={busy}
                onClick={() => setConfirmation(null)}
              >
                {t('cancel')}
              </Button>
              <Button
                variant={confirmation === 'clear' ? 'danger' : 'primary'}
                disabled={busy || disabled}
                onClick={() => void confirm()}
              >
                {t(
                  busy
                    ? 'conversationSyncUpdating'
                    : confirmation === 'enable'
                      ? 'conversationSyncEnableConfirm'
                      : 'conversationSyncClearConfirm'
                )}
              </Button>
            </div>
          }
        >
          <p className={styles.confirmText}>
            {t(
              confirmation === 'enable'
                ? 'conversationSyncEnableDescription'
                : 'conversationSyncClearDescription'
            )}
          </p>
          {confirmation === 'enable' ? (
            <p className={styles.confirmText}>{t('conversationSyncEnablePrivacy')}</p>
          ) : (
            <p className={styles.confirmText}>{t('conversationSyncClearShares')}</p>
          )}
          {problem ? (
            <p className={styles.error} role="alert">
              {problem}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </>
  )
}
