import clsx from 'clsx'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { API_ORIGIN, request } from '../../services/api/client.js'
import {
  clearPersonalApiKey,
  configureChatProvider,
  useChatProvider,
  type ChatProviderMode,
} from '../../services/chatProvider.js'
import { readPersonalApiKey } from '../../services/personalKeyVault.js'
import {
  DEFAULT_CHAT_MODEL,
  OFFICIAL_BASE,
  fetchProviderModels,
  normalizeProviderBase,
  personalEndpoint,
} from '../../services/providerEndpoint.js'
import {
  getRuntime, isGuestWorkspace, parseRuntimeUser, refreshRuntime, subscribeRuntimeUser, validWeeklyQuota,
} from '../../services/runtime.js'
import { applyInviteRedemption } from '../../services/weeklyQuota.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { AccountLoginButton } from './AccountLoginButton.js'
import { SettingsEditRow } from './SettingsEditRow.js'
import { closeChatProvider, openChatProvider, useSettingsDialog, watchChatProviderHistory } from './settingsDialogState.js'
import styles from './ChatProviderSetting.module.css'

type CredentialsDraft = { base: string; model: string; apiKey: string }
type ServiceChoice = ChatProviderMode | 'invite'

export function ChatProviderSetting() {
  const t = useTranslate()
  const { mode, keyConfigured, loading, error, endpoint } = useChatProvider()
  const summary = t(
    loading
      ? 'chatProviderLoading'
      : error || (mode === 'personal' && !keyConfigured)
        ? 'chatProviderNeedsConfiguration'
        : mode === 'managed'
          ? 'chatProviderManagedActive'
          : endpoint.baseUrl === OFFICIAL_BASE
            ? 'chatProviderPersonalActive'
            : 'chatProviderCustomActive'
  )

  return (
    <SettingsEditRow label={t('chatProviderTitle')} summary={summary} onOpen={openChatProvider} />
  )
}

export function ChatProviderDialog() {
  const open = useSettingsDialog((state) => state.chatProviderOpen)
  useEffect(watchChatProviderHistory, [])
  return open ? <ChatProviderForm onClose={closeChatProvider} /> : null
}

function ChatProviderForm({ onClose }: { onClose: () => void }) {
  const t = useTranslate()
  const issue = useSettingsDialog((state) => state.chatProviderIssue)
  const { mode, managedEligible, loading, keyConfigured, error, endpoint } = useChatProvider()
  const account = useSyncExternalStore(subscribeRuntimeUser, () => getRuntime().user)
  const preferredChoice = issue === 'chatProviderManagedSetupFailed' ? 'personal' : mode
  const [selected, setSelected] = useState<ServiceChoice>(preferredChoice)
  const [credentials, setCredentials] = useState<CredentialsDraft>(() => ({
    base: endpoint.baseUrl === OFFICIAL_BASE ? '' : endpoint.baseUrl,
    model: endpoint.model === DEFAULT_CHAT_MODEL ? '' : endpoint.model,
    apiKey: '',
  }))
  const [beforeAdvanced, setBeforeAdvanced] = useState<CredentialsDraft | null>(null)
  const advanced = beforeAdvanced !== null
  const { base, model, apiKey } = credentials
  const [invitationCode, setInvitationCode] = useState('')
  const [saveError, setSaveError] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [listing, setListing] = useState(false)
  const listRequest = useRef<AbortController | null>(null)
  const advancedTrigger = useRef<HTMLButtonElement | null>(null)
  const listId = useId()
  const mainFormId = useId()
  const advancedFormId = useId()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)

  useEffect(() => {
    setCredentials((previous) => ({
      ...previous,
      base: endpoint.baseUrl === OFFICIAL_BASE ? '' : endpoint.baseUrl,
      model: endpoint.model === DEFAULT_CHAT_MODEL ? '' : endpoint.model,
    }))
  }, [endpoint.baseUrl, endpoint.model])

  useEffect(() => setSelected(preferredChoice), [preferredChoice])
  useEffect(() => {
    if (!account.invite_redeemable) {
      setSelected((choice) => choice === 'invite' ? mode : choice)
    }
  }, [account.invite_redeemable, mode])

  useEffect(() => {
    setModels([])
    setListing(false)
    return () => listRequest.current?.abort()
  }, [base, apiKey, advanced])

  const needsInvite = selected === 'invite'
  const missingManaged = selected === 'managed' && !managedEligible
  const guestInvite = missingManaged && isGuestWorkspace()
  const options: ServiceChoice[] = ['personal']
  if (managedEligible || !account.invite_redeemable) {options.push('managed')}
  if (account.invite_redeemable) {options.push('invite')}
  const disabled = loading || busy
  const saveDisabled = disabled ||
    missingManaged ||
    (needsInvite && (!account.invite_redeemable || !invitationCode.trim())) ||
    (selected === 'personal' && !keyConfigured && !apiKey.trim())

  const changeCredentials = (changes: Partial<CredentialsDraft>) => {
    setCredentials((previous) => ({ ...previous, ...changes }))
    setSaveError('')
  }

  const closeAdvanced = () => {
    if (pending.current || !beforeAdvanced) {
      return
    }
    setCredentials(beforeAdvanced)
    setBeforeAdvanced(null)
    setSaveError('')
  }

  const listModels = async () => {
    listRequest.current?.abort()
    const controller = new AbortController()
    listRequest.current = controller
    setListing(true)
    setSaveError('')
    try {
      const destination = normalizeProviderBase(base)
      const saved = apiKey.trim() ? null : await readPersonalApiKey()
      const key = apiKey.trim() || (saved?.baseUrl === destination ? saved.apiKey : '')
      if (!key) {
        throw new Error(t('chatEndpointNeedsKey'))
      }
      const ids = await fetchProviderModels(destination, key, controller.signal)
      if (!controller.signal.aborted) {
        setModels(ids)
        showToast({ key: 'chatEndpointCount', params: { count: ids.length } })
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setSaveError(cause instanceof Error ? cause.message : t('chatEndpointFailed'))
      }
    } finally {
      if (!controller.signal.aborted) {
        setListing(false)
      }
    }
  }

  const save = async () => {
    if (pending.current || saveDisabled || guestInvite) {
      return
    }
    pending.current = true
    setBusy(true)
    setSaveError('')
    try {
      if (needsInvite) {
        const response = await request(`${API_ORIGIN}/api/redeem-invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invitation_code: invitationCode.trim() }),
        })
        const result = await response.json() as { user?: unknown; quota?: unknown } | null
        const redeemed = parseRuntimeUser(result?.user)
        if (!redeemed || redeemed.id !== account.id || redeemed.role !== account.role || redeemed.invite_redeemable) {
          throw new Error(t('chatProviderRedeemUnconfirmed'))
        }
        setInvitationCode('')
        applyInviteRedemption(redeemed, validWeeklyQuota(result?.quota) ? result.quota : undefined)
        void refreshRuntime()
        if (redeemed.permissions.chat_api) {
          await configureChatProvider({ mode: 'managed' })
        }
        showToast({ key: 'chatProviderRedeemed' })
        onClose()
        return
      }
      await configureChatProvider({
        mode: selected,
        ...(selected === 'personal' ? { endpoint: personalEndpoint(base, model) } : {}),
        ...(selected === 'personal' && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      showToast({
        key: selected === 'managed'
          ? 'chatProviderManagedActive'
          : apiKey.trim() ? 'chatProviderKeySaved' : 'chatProviderPersonalActive',
      })
      onClose()
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : t('chatProviderRedeemUnconfirmed'))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  const clear = async () => {
    if (pending.current || disabled) {
      return
    }
    pending.current = true
    setBusy(true)
    try {
      await clearPersonalApiKey()
      setCredentials({ base: '', model: '', apiKey: '' })
    } catch {
      // Storage failures remain visible through the provider state.
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  const keyField = (fieldDisabled: boolean) => (
    <label className={styles.field}>
      {t('chatProviderKeyLabel')}
      <input
        type="text"
        className={styles.keyInput}
        value={apiKey}
        disabled={fieldDisabled}
        placeholder={t(keyConfigured ? 'chatProviderKeepKey' : 'chatProviderEnterKey')}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => changeCredentials({ apiKey: event.target.value })}
      />
    </label>
  )

  const issueMessage = issue && (issue === 'chatProviderManagedSetupFailed' || selected === 'personal') ? t(issue) : ''
  const errorMessage = saveError || (selected === mode ? error : '') || issueMessage
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void save()
  }

  return (
    <>
      <Modal
        title={t('chatProviderTitle')}
        className={styles.dialog}
        closable
        onClose={() => {
          if (!pending.current) {
            onClose()
          }
        }}
        footer={
          <div className={styles.footerActions}>
            {selected === 'personal' && keyConfigured ? (
              <Button variant="outlined" size="m" disabled={disabled || advanced} onClick={() => void clear()}>
                {t('chatProviderClearKey')}
              </Button>
            ) : null}
            {guestInvite ? (
              <AccountLoginButton />
            ) : (
              <Button type="submit" form={mainFormId} size="m" disabled={saveDisabled || advanced}>
                {t(busy ? 'chatProviderSaving' : needsInvite ? 'chatProviderRedeem' : 'chatProviderSave')}
              </Button>
            )}
          </div>
        }
      >
        <form id={mainFormId} className={styles.section} onSubmit={submit} aria-hidden={advanced || undefined}>
          <div className={styles.options} role="radiogroup" aria-label={t('chatProviderTitle')}>
            {options.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected === value}
                className={clsx(styles.option, selected === value && styles.selected)}
                disabled={disabled || advanced}
                onClick={() => {
                  setSelected(value)
                  setSaveError('')
                }}
              >
                {t(
                  value === 'personal'
                    ? 'chatProviderPersonal'
                    : value === 'managed'
                      ? 'chatProviderManaged'
                      : 'chatProviderInviteOption'
                )}
              </button>
            ))}
          </div>
          <p className={styles.description}>
            {t(selected === 'personal'
              ? 'chatProviderPersonalBilling'
              : needsInvite
                ? 'chatProviderInviteHelp'
                : missingManaged
                  ? guestInvite ? 'chatProviderManagedGuest' : 'chatProviderManagedUnavailable'
                  : 'chatProviderManagedBilling')}
          </p>
          {selected === 'personal' ? (
            <>
              {keyField(disabled || advanced)}
              <p className={styles.description}>
                {t(account.permissions.cloud_sync ? 'chatProviderSyncKey' : 'chatProviderLocalKey')}
              </p>
              <div className={styles.actions}>
                <a className={styles.guide} href="/deepseek-api/api-key-guide" target="_blank" rel="noopener noreferrer">
                  {t('chatProviderGuide')}
                </a>
                <Button
                  variant="outlined"
                  size="m"
                  disabled={disabled || advanced}
                  aria-haspopup="dialog"
                  onClick={(event) => {
                    advancedTrigger.current = event.currentTarget
                    setBeforeAdvanced(credentials)
                    setSaveError('')
                  }}
                >
                  {t('chatEndpointAdvanced')}
                </Button>
              </div>
            </>
          ) : needsInvite ? (
            <label className={styles.field}>
              {t('chatProviderInviteLabel')}
              <input
                className={styles.keyInput}
                value={invitationCode}
                disabled={disabled}
                maxLength={128}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => setInvitationCode(event.target.value)}
              />
            </label>
          ) : null}
          {!advanced && errorMessage ? <p className={styles.error} role="alert">{errorMessage}</p> : null}
        </form>
      </Modal>
      {advanced ? (
        <Modal
          title={t('chatEndpointAdvanced')}
          className={styles.dialog}
          closable
          returnFocusTo={advancedTrigger}
          onClose={closeAdvanced}
          footer={
            <div className={styles.footerActions}>
              <Button variant="outlined" size="m" disabled={busy} onClick={closeAdvanced}>{t('cancel')}</Button>
              <Button type="submit" form={advancedFormId} size="m" disabled={saveDisabled}>
                {t(busy ? 'chatProviderSaving' : 'chatProviderSave')}
              </Button>
            </div>
          }
        >
          <form id={advancedFormId} className={styles.section} onSubmit={submit}>
            <label className={styles.field}>
              Base URL
              <input
                className={styles.keyInput}
                type="url"
                value={base}
                placeholder={OFFICIAL_BASE}
                disabled={disabled}
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => changeCredentials({ base: event.target.value })}
              />
            </label>
            {keyField(disabled)}
            <label className={styles.field}>
              {t('chatEndpointModel')}
              <input
                className={styles.keyInput}
                value={model}
                list={listId}
                placeholder={DEFAULT_CHAT_MODEL}
                disabled={disabled}
                onChange={(event) => changeCredentials({ model: event.target.value })}
              />
            </label>
            <datalist id={listId}>
              {models.map((id) => <option key={id} value={id} />)}
            </datalist>
            <div className={styles.actions}>
              <Button variant="outlined" size="m" disabled={disabled || listing} onClick={() => void listModels()}>
                {t(listing ? 'chatEndpointLoading' : 'chatEndpointList')}
              </Button>
              {models.length > 0 ? (
                <select
                  className={styles.modelSelect}
                  aria-label={t('chatEndpointPick')}
                  disabled={disabled}
                  value={models.includes(model) ? model : ''}
                  onChange={(event) => changeCredentials({ model: event.target.value })}
                >
                  <option value="">{t('chatEndpointPick')}</option>
                  {models.map((id) => <option key={id}>{id}</option>)}
                </select>
              ) : null}
            </div>
            <p className={styles.description}>{t('chatEndpointHelp')}</p>
            {errorMessage ? <p className={styles.error} role="alert">{errorMessage}</p> : null}
          </form>
        </Modal>
      ) : null}
    </>
  )
}
