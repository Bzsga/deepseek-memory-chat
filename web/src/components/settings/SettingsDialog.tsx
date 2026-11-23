import { ImageProviderSetting } from './ImageProviderSetting.js'
import {
  hasSeparateOrganizationSettings,
  nativeSettingsAccess,
  openNativeSettings,
  sendNative,
  subscribeNativeBridge,
  type NativeSettingsSection,
} from '../../services/nativeBridge.js'
import clsx from 'clsx'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  HistoryInputTooLargeError,
  HistorySelectionTooLargeError,
  addHistory,
  clearHistory,
  exportHistory,
  importHistory,
  previewHistory,
  type HistoryPreview,
} from '../../services/chat/backup.js'
import { API_ORIGIN, request } from '../../services/api/client.js'
import { getRuntime, invalidateSession, isGuestWorkspace } from '../../services/runtime.js'
import { stopSessionActivity } from '../../services/sessionActivity.js'
import { captureConversationDataGuard, useChatStore } from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setAutoReadAloud,
  setLocale,
  setLocation,
  setShowReplyUsage,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { watchSettingsLink } from '../../services/settingsNavigation.js'
import {
  closeSettings,
  openSettings,
  useSettingsDialog,
  type SettingsSection,
} from './settingsDialogState.js'
import { AboutSoftware } from './AboutSoftware.js'
import { ConversationSyncSetting } from './ConversationSyncSetting.js'
import { AccountLoginButton } from './AccountLoginButton.js'
import { ChatProviderSetting } from './ChatProviderSetting.js'
import { GuestHistoryCopyEntry } from './GuestHistoryMigration.js'
import { ReplyPreferenceSetting } from './ReplyPreferenceSetting.js'
import { TechnicalDiagnosticsSetting } from './TechnicalDiagnostics.js'
import { useConversationSync } from '../../services/conversationSync.js'
import { ConversationShareDialog } from '../session/ConversationShareDialog.js'
import { showConversationShareControls } from '../session/conversationShareVisibility.js'
import historyStyles from './HistoryImport.module.css'
import styles from './Settings.module.css'

/**
 * 设置弹窗：通用设置、数据管理与关于该软件。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  useEffect(
    () =>
      watchSettingsLink((section) => {
        if (section) {useSettingsDialog.setState({ open: true, section })}
        else {useSettingsDialog.setState({ open: false })}
      }),
    []
  )
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
  {
    value: 'about',
    label: 'aboutSoftware',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 7v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="4.7" r=".85" fill="currentColor" />
      </svg>
    ),
  },
]

const SettingsContent = () => {
  const t = useTranslate()
  const section = useSettingsDialog((state) => state.section)
  const guest = isGuestWorkspace()
  const administrator = !guest && getRuntime().user.role === 'admin'
  const native = useSyncExternalStore(subscribeNativeBridge, nativeSettingsAccess)
  const separateOrganizationSettings = useSyncExternalStore(
    subscribeNativeBridge,
    hasSeparateOrganizationSettings
  )
  const [managingShares, setManagingShares] = useState(false)
  // Older Android WebViews pass only the first accept type to the system picker.
  // Leave that picker unfiltered and validate the selected archive in the importer.
  const archiveFileTypes = native === 'web'
    ? '.zip,.json,application/zip,application/x-zip-compressed,application/json'
    : undefined
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy && !historyImport.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => openSettings(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" key={section} className={styles.content}>
          {section === 'general' ? (
            <>
              <ChatProviderSetting />
              <ImageProviderSetting />
              <ReplyPreferenceSetting />
              {separateOrganizationSettings ? (
                <NativeSetting section="service" label="nativeServiceSettings" />
              ) : null}
              {native === 'legacy' && administrator ? <NativeSetting label="appSettings" /> : null}
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <AutoReadAloudSetting />
              <ReplyUsageSetting />
              <LocationSetting />
              {guest ? (
                <SettingCell label={t('accountAndSync')} status={null} action={<AccountLoginButton />} />
              ) : (
                <AccountSetting native={native !== 'web'} />
              )}
            </>
          ) : section === 'about' ? (
            <>
              {native === 'sections' ? (
                <NativeSetting section="about" label="nativeAboutSettings" />
              ) : (
                <AboutSoftware />
              )}
              <SettingCell
                label={t('aboutChangelog')}
                status={null}
                action={
                  <Button variant="outlined" size="m" onClick={() => window.location.assign('./changelog.html')}>
                    {t('aboutViewChangelog')}
                  </Button>
                }
              />
              {administrator && native === 'sections' ? (
                <NativeSetting section="developer" label="nativeDeveloperSettings" />
              ) : null}
            </>
          ) : (
            <>
              {native === 'sections' ? (
                <NativeSetting section="data" label="nativeDataSettings" />
              ) : null}
              {guest ? (
                <SettingCell
                  label={t('conversationSyncTitle')}
                  description={t('signInToSync')}
                  status={null}
                  action={<AccountLoginButton label="conversationSyncEnableConfirm" resumeSync />}
                />
              ) : (
                <>
                  <ConversationSyncSetting disabled={historyBusy} />
                  <GuestHistoryCopyEntry />
                </>
              )}
              <ImportHistory mode="append" accept={archiveFileTypes} historyImport={historyImport} disabled={historyBusy} />
              <ImportHistory mode="restore" accept={archiveFileTypes} historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <TechnicalDiagnosticsSetting />
              {showConversationShareControls ? (
                <SettingCell
                  label={t('conversationShareManage')}
                  description={guest ? undefined : t('conversationShareManageHint')}
                  status={null}
                  action={
                    guest ? (
                      <AccountLoginButton label="signInToManage" />
                    ) : (
                      <Button
                        variant="outlined"
                        size="m"
                        className={styles.cellButton}
                        disabled={historyBusy}
                        onClick={() => setManagingShares(true)}
                      >
                        {t('conversationShareManageAction')}
                      </Button>
                    )
                  }
                />
              ) : null}
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
            </>
          )}
        </div>
      </Modal>
      {historyImport.pending ? <ImportConfirm historyImport={historyImport} pending={historyImport.pending} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
      {showConversationShareControls && managingShares ? (
        <ConversationShareDialog onClose={() => setManagingShares(false)} />
      ) : null}
    </>
  )
}

const NativeSetting = ({
  section,
  label,
}: {
  section?: NativeSettingsSection
  label: TranslationKey
}) => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const open = async () => {
    setBusy(true)
    try {
      await openNativeSettings(section)
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('memoryHandoffFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingCell
      label={t(label)}
      status={null}
      action={
        <Button variant="outlined" size="m" disabled={busy} onClick={() => void open()}>
          {t('nativeOpen')}
        </Button>
      }
    />
  )
}

const AccountSetting = ({ native }: { native: boolean }) => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)

  const logout = async () => {
    if (pending.current) {
      return
    }
    pending.current = true
    setBusy(true)
    if (native) {
      try {
        await sendNative('account.open')
      } catch (error) {
        showToast(error instanceof Error ? error.message : t('logoutFailed'))
      } finally {
        pending.current = false
        setBusy(false)
      }
      return
    }
    stopSessionActivity()
    try {
      await request(`${API_ORIGIN}/logout`, { method: 'POST' })
      invalidateSession('login')
    } catch {
      showToast({ key: 'logoutFailed', type: 'error' })
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('accountAndSync')}
      description={getRuntime().user.username}
      status={null}
      action={
        <Button variant="outlined" size="m" disabled={busy} onClick={() => void logout()}>
          {t(busy ? 'loggingOut' : native ? 'manageAccount' : 'logout')}
        </Button>
      }
    />
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  const syncEnabled = useConversationSync((state) => state.enabled && state.scopes.conversations)
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
      {syncEnabled ? <p>{t('conversationSyncDeleteWarning')}</p> : null}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

const AutoReadAloudSetting = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.autoReadAloud)
  return (
    <SettingCell
      label={t('settingsAutoReadAloud')}
      description={t('settingsAutoReadAloudDescription')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsAutoReadAloud')}
          value={enabled ? 'on' : 'off'}
          options={[
            { value: 'off', label: t('settingsAutoReadAloudOff') },
            { value: 'on', label: t('settingsAutoReadAloudOn') },
          ]}
          onChange={(value) => setAutoReadAloud(value === 'on')}
        />
      }
    />
  )
}

const ReplyUsageSetting = () => {
  const t = useTranslate()
  const enabled = useSettings((state) => state.showReplyUsage)
  return (
    <SettingCell
      label={t('settingsReplyUsage')}
      description={t('settingsReplyUsageDescription')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsReplyUsage')}
          value={enabled ? 'on' : 'off'}
          options={[
            { value: 'off', label: t('settingsAutoReadAloudOff') },
            { value: 'on', label: t('settingsAutoReadAloudOn') },
          ]}
          onChange={(value) => setShowReplyUsage(value === 'on')}
        />
      }
    />
  )
}

const useHistoryCopy = () => {
  const zh = useSettings((state) => state.locale === 'zh-CN')
  return {
    read: zh ? '正在读取文件…' : 'Reading file…',
    append: zh ? '添加旧聊天' : 'Add past chats',
    appendHint: zh
      ? '从导出的聊天 JSON 或 ZIP 选择要添加的会话。'
      : 'Choose chats from an exported conversation JSON or ZIP.',
    restore: zh ? '恢复整库备份' : 'Restore chat library',
    restoreHint: zh
      ? '用备份文件替换本机聊天和附件。'
      : 'Replace local chats and attachments from a backup.',
    choose: zh ? '选择文件' : 'Choose file',
    unnamed: zh ? '未命名对话' : 'Untitled chat',
    duplicate: zh ? '已在本机' : 'Already on this device',
    selectAll: zh ? '全选可添加项' : 'Select all available',
    more: zh ? '显示更多对话' : 'Show more chats',
    previewCount: (total: number, selected: number) => zh
      ? '文件含 ' + total + ' 个聊天，已选 ' + selected + ' 个。'
      : total + ' chats in file, ' + selected + ' selected.',
    restoreCount: (total: number, local: number) => zh
      ? '将用备份中的 ' + total + ' 个聊天替换本机的 ' + local + ' 个聊天及本机聊天附件。'
      : 'The ' + total + ' chats in this backup will replace ' + local + ' local chats and their attachments.',
    restoreEmpty: zh ? '这份备份没有聊天，继续会清空本机聊天。' : 'This backup is empty. Restoring it will clear local chats.',
    appendDone: (added: number, skipped: number) => zh
      ? '已添加 ' + added + ' 个聊天' + (skipped ? '，保留 ' + skipped + ' 个已有聊天' : '。')
      : 'Added ' + added + ' chats.' + (skipped ? ' Kept ' + skipped + ' existing chats.' : ''),
    noAdd: zh ? '此文件没有可添加的聊天。' : 'There are no new chats to add from this file.',
    appendNext: zh ? '请选择本应用导出的会话 JSON 或兼容的历史 ZIP。' : 'Choose an exported conversation JSON or compatible history ZIP.',
    restoreNext: zh ? '请选择有效的备份 ZIP 或本应用导出的会话 JSON。' : 'Choose a valid backup ZIP or a conversation JSON exported by this app.',
    retry: zh ? '暂时无法导入，请确认设备存储空间后重试。' : 'Import failed. Check available device storage and try again.',
    space: zh ? '设备存储空间不足，请释放空间后重试。' : 'Free up device storage and try again.',
    size: zh ? '会话 JSON 超过 32 MB，请导出 ZIP 后再试。' : 'This conversation JSON exceeds 32 MB. Export a ZIP instead.',
    selectionSize: zh
      ? '所选聊天和附件解压后超过 64 MB，请减少勾选的会话后重试。'
      : 'Selected chats and attachments exceed 64 MB after extraction. Choose fewer chats and try again.',
    unreadable: zh ? '无法读取这份会话 JSON。' : 'This conversation JSON could not be read.',
    reopen: zh ? '当前工作区已变化，请重新选取文件。' : 'The workspace changed. Choose the file again.',
  }
}

type ImportMode = 'append' | 'restore'
type ImportSelection = {
  mode: ImportMode
  preview: HistoryPreview
  filename: string
  selected: ReadonlySet<string>
  guard: () => boolean
}

const ImportConfirm = ({
  historyImport,
  pending,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  pending: ImportSelection
}) => {
  const t = useTranslate()
  const copy = useHistoryCopy()
  const [limit, setLimit] = useState(60)
  const local = useChatStore((state) => state.sessions)
  const syncEnabled = useConversationSync((state) => state.enabled && state.scopes.conversations)
  const existing = new Set(local.map(({ id }) => id))
  const { sessions } = pending.preview
  const available = sessions.filter(({ id }) => !existing.has(id))
  const selection = new Set(available.filter(({ id }) => pending.selected.has(id)).map(({ id }) => id))
  const restore = pending.mode === 'restore'
  const title = restore ? copy.restore : copy.append
  return (
    <Modal
      title={title}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button
            variant={restore ? 'dangerOutlined' : 'primary'}
            size="m"
            disabled={historyImport.busy || (!restore && !selection.size)}
            onClick={() => void historyImport.confirm(selection)}
          >
            {title}
          </Button>
        </>
      }
    >
      <div className={historyStyles.filename}>{pending.filename}</div>
      {restore ? (
        <>
          <p className={styles.importConfirmText}>{copy.restoreCount(sessions.length, local.length)}</p>
          {!sessions.length ? <p className={styles.importConfirmText}>{copy.restoreEmpty}</p> : null}
          {syncEnabled ? <p className={styles.importConfirmText}>{t('conversationSyncReplaceWarning')}</p> : null}
        </>
      ) : (
        <>
          <p className={styles.importConfirmText}>{copy.previewCount(sessions.length, selection.size)}</p>
          {available.length ? (
            <label className={historyStyles.all}>
              <input
                type="checkbox"
                checked={selection.size === available.length}
                disabled={historyImport.busy}
                onChange={(event) => historyImport.selectIds(new Set(event.target.checked ? available.map(({ id }) => id) : []))}
              />
              {copy.selectAll}
            </label>
          ) : <p className={styles.importConfirmText}>{copy.noAdd}</p>}
          <ul className={historyStyles.list}>
            {sessions.slice(0, limit).map((item) => {
              const duplicate = existing.has(item.id)
              return (
                <li key={item.id}>
                  <label className={historyStyles.choice}>
                    <input
                      type="checkbox"
                      checked={selection.has(item.id)}
                      disabled={duplicate || historyImport.busy}
                      onChange={(event) => {
                        const next = new Set(selection)
                        if (event.target.checked) {next.add(item.id)}
                        else {next.delete(item.id)}
                        historyImport.selectIds(next)
                      }}
                    />
                    <span>{item.title?.trim() || copy.unnamed}</span>
                    {duplicate ? <small>{copy.duplicate}</small> : null}
                  </label>
                </li>
              )
            })}
          </ul>
          {sessions.length > limit ? (
            <Button size="m" variant="outlined" onClick={() => setLimit((count) => count + 60)}>
              {copy.more}
            </Button>
          ) : null}
        </>
      )}
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

const useHistoryImport = () => {
  const t = useTranslate()
  const copy = useHistoryCopy()
  const [pending, setPending] = useState<ImportSelection | null>(null)
  const [operation, setOperation] = useState<ImportMode | null>(null)
  const [failure, setFailure] = useState<{ mode: ImportMode; text: string } | null>(null)
  const busy = useRef(false)

  const describe = (error: unknown, mode: ImportMode) => {
    if (error instanceof HistoryInputTooLargeError) {return copy.size}
    if (error instanceof HistorySelectionTooLargeError) {return copy.selectionSize}
    if (error instanceof BackupError) {
      const reason = error.key === 'backupInvalidJson' ? copy.unreadable : t(error.key)
      return reason + ' ' + (mode === 'restore' ? copy.restoreNext : copy.appendNext)
    }
    if (error instanceof DOMException) {
      if (error.name === 'QuotaExceededError') {return copy.space}
      if (error.name === 'AbortError') {return copy.reopen}
    }
    return copy.retry
  }

  const select = async (file: File, mode: ImportMode) => {
    if (busy.current) {return}
    busy.current = true
    setOperation(mode)
    setFailure(null)
    const guard = captureConversationDataGuard(getRuntime().user.id)
    try {
      const preview = await previewHistory(file)
      if (!guard()) {throw new DOMException('Workspace changed', 'AbortError')}
      setPending({
        mode, preview, filename: file.name, guard,
        selected: new Set(preview.sessions.map(({ id }) => id)),
      })
    } catch (error) {
      setFailure({ mode, text: describe(error, mode) })
    } finally {
      busy.current = false
      setOperation(null)
    }
  }

  const confirm = async (selected: ReadonlySet<string>) => {
    if (!pending || busy.current) {return}
    busy.current = true
    const { mode, preview, guard } = pending
    setOperation(mode)
    setFailure(null)
    setPending(null)
    try {
      if (mode === 'append') {
        const { added, skipped } = await addHistory(preview, selected, guard)
        showToast(copy.appendDone(added, skipped))
        if (added > 0) {
          closeSettings()
          openMobileSider()
        }
      } else {
        const count = await importHistory(preview.archive, guard)
        showToast({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
      }
    } catch (error) {
      setFailure({ mode, text: describe(error, mode) })
    } finally {
      busy.current = false
      setOperation(null)
    }
  }

  return {
    pending,
    busy: operation !== null,
    operation,
    failure,
    select,
    selectIds: (selected: ReadonlySet<string>) =>
      setPending((value) => value ? { ...value, selected } : null),
    cancel: () => { if (!busy.current) {setPending(null)} },
    confirm,
  }
}

const ImportHistory = ({
  mode,
  accept,
  historyImport,
  disabled,
}: {
  mode: ImportMode
  accept: string | undefined
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const copy = useHistoryCopy()
  const inputRef = useRef<HTMLInputElement>(null)
  const restore = mode === 'restore'
  const label = restore ? copy.restore : copy.append

  return (
    <>
      <SettingCell
        label={label}
        description={historyImport.operation === mode ? copy.read : restore ? copy.restoreHint : copy.appendHint}
        status={null}
        action={
          <>
            <Button
              variant="outlined"
              size="m"
              className={clsx(styles.cellButton, styles.uploadButton)}
              disabled={disabled}
              aria-label={label}
              onClick={() => inputRef.current?.click()}
            >
              <IconUploadOutline14 />
              {copy.choose}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept={accept}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) {void historyImport.select(file, mode)}
              }}
            />
          </>
        }
      />
      {historyImport.failure?.mode === mode ? (
        <p role="alert" className={historyStyles.error}>{historyImport.failure.text}</p>
      ) : null}
    </>
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}
