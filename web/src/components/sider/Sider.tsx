import { useWeeklyQuota } from '../../services/weeklyQuota.js'
import { useChatProvider } from '../../services/chatProvider.js'
import { useConversationSync } from '../../services/conversationSync.js'
import clsx from 'clsx'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconDataOutline16,
  IconPanelLeftOutline16,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import {
  isNativeConnected,
  sendNative,
  subscribeNativeBridge,
} from '../../services/nativeBridge.js'
import { getRuntime, subscribeRuntimeUser } from '../../services/runtime.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const quota = useWeeklyQuota((state) => state.quota)
  const personalProvider = useChatProvider((state) => state.mode === 'personal')
  const hasManagedQuota = useSyncExternalStore(subscribeRuntimeUser, () => {
    const { chat_api, image_api } = getRuntime().user.permissions
    return chat_api || image_api
  })
  const syncEnabled = useConversationSync((state) => state.enabled && state.scopes.conversations)
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const [query, setQuery] = useState('')
  const filteredSessions = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return search
      ? sessions.filter((session) =>
          (session.title || t('untitledChat')).toLocaleLowerCase().includes(search)
        )
      : sessions
  }, [sessions, query, t])
  const groups = useMemo(() => groupSessions(filteredSessions, now, t), [filteredSessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const connected = useSyncExternalStore(subscribeNativeBridge, isNativeConnected)
  const [navigationPending, setNavigationPending] = useState(false)
  const openNativePage = async () => {
    if (navigationPending) {
      return
    }
    setNavigationPending(true)
    try {
      await sendNative('memory.open')
      closeMobileSider()
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('memoryHandoffFailed'))
    } finally {
      setNavigationPending(false)
    }
  }

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName} title={t('appName')}>{t('appName')}</div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <div className={styles.historyTools}>
        <h2>{t('historyTitle')}</h2>
        <input
          type="search"
          value={query}
          placeholder={t('historySearch')}
          aria-label={t('historySearch')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {groups.length === 0 ? (
            <p className={styles.empty}>{t(query.trim() ? 'historyNoResults' : 'historyEmpty')}</p>
          ) : null}
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  onDelete={() => setDeleting(session)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.bottom}>
        {quota && hasManagedQuota ? (
          <div
            className={styles.weeklyQuota}
            title={t(personalProvider ? 'managedWeeklyResetDescription' : 'weeklyResetDescription')}
          >
            {t(personalProvider ? 'managedWeeklyRemaining' : 'weeklyRemaining', {
              count: quota.user_weekly_remaining,
            })}
          </div>
        ) : null}
        {connected ? (
          <button
            type="button"
            className={styles.settings}
            disabled={navigationPending}
            onClick={() => void openNativePage()}
          >
            <span className={styles.settingsIcon}>
              <IconDataOutline16 />
            </span>
            <span className={styles.settingsLabel}>{t('memoryLibrary')}</span>
          </button>
        ) : null}
        <button
          type="button"
          className={styles.settings}
          onClick={() => {
            closeMobileSider()
            openSettings('general')
          }}
        >
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
          {syncEnabled ? <p>{t('conversationSyncDeleteWarning')}</p> : null}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const t = useTranslate()
  const open = useMobileSider((state) => state.open)
  useEffect(() => {
    if (!open) {
      return
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMobileSider()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [open])
  if (!open) {
    return null
  }
  return (
    <>
      <button
        type="button"
        className={styles.drawerMask}
        aria-label={t('collapseSiderbarButton')}
        onClick={closeMobileSider}
      />
      <div className={styles.drawer} role="dialog" aria-modal="true" aria-label={t('historyTitle')}>
        <Sider mobile />
      </div>
    </>
  )
}
