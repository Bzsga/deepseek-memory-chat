import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { nativeDiagnosticsAvailable, sendNative, subscribeNativeBridge } from '../../services/nativeBridge.js'
import {
  diagnosticPreference, diagnosticVersion, diagnosticWasSent, latestDiagnostic,
  nativeOwnsDiagnostics, sendOneDiagnostic, setDiagnosticPreference, subscribeDiagnostics,
} from '../../services/technicalDiagnostics.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { SettingsEditRow } from './SettingsEditRow.js'
import styles from './TechnicalDiagnostics.module.css'

const OPEN_EVENT = 'deepseek:open-technical-diagnostics'

export const openTechnicalDiagnostics = () => {
  if (nativeOwnsDiagnostics()) {
    void sendNative('diagnostics.open').catch(() => showToast({ key: 'diagnosticsOpenFailed', type: 'error' }))
  } else {
    window.dispatchEvent(new Event(OPEN_EVENT))
  }
}

const useDiagnosticPreference = () => {
  useSyncExternalStore(subscribeDiagnostics, diagnosticVersion)
  return diagnosticPreference()
}

export const DiagnosticConsentNotice = () => {
  const t = useTranslate()
  const preference = useDiagnosticPreference()
  if (nativeOwnsDiagnostics() || preference !== 'unanswered') { return null }
  return (
    <aside className={styles.notice} aria-label={t('diagnosticsTitle')}>
      <div>
        <strong>{t('diagnosticsConsentTitle')}</strong>
        <p>{t('diagnosticsDescription')}</p>
      </div>
      <div className={styles.actions}>
        <Button variant="outlined" size="m" onClick={() => setDiagnosticPreference('disabled')}>
          {t('diagnosticsSkip')}
        </Button>
        <Button size="m" onClick={() => setDiagnosticPreference('enabled')}>
          {t('diagnosticsOptIn')}
        </Button>
      </div>
    </aside>
  )
}

export const TechnicalDiagnosticsSetting = () => {
  const t = useTranslate()
  const preference = useDiagnosticPreference()
  const bridgeReady = useSyncExternalStore(subscribeNativeBridge, nativeDiagnosticsAvailable)
  const native = nativeOwnsDiagnostics()
  return (
    <SettingsEditRow
      label={t('diagnosticsTitle')}
      summary={t(native ? 'diagnosticsNative' : preference === 'enabled' ? 'diagnosticsAutoOn' : 'diagnosticsAutoOff')}
      disabled={native && !bridgeReady}
      onOpen={openTechnicalDiagnostics}
    />
  )
}

export const TechnicalDiagnosticsDialogHost = () => {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(OPEN_EVENT, show)
    return () => window.removeEventListener(OPEN_EVENT, show)
  }, [])
  return open ? <TechnicalDiagnosticsDialog onClose={() => setOpen(false)} /> : null
}

const TechnicalDiagnosticsDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const preference = useDiagnosticPreference()
  const [event] = useState(latestDiagnostic)
  const [sending, setSending] = useState(false)
  const sent = !!event && diagnosticWasSent(event.event_id)
  const send = async () => {
    if (!event || sending || sent) { return }
    setSending(true)
    const ok = await sendOneDiagnostic(event.event_id)
    setSending(false)
    showToast({ key: ok ? 'diagnosticsSent' : 'diagnosticsSendFailed', type: ok ? undefined : 'error' })
  }
  const copy = async () => {
    if (!event) { return }
    const ok = await copyText(event.event_id)
    showToast({ key: ok ? 'copied' : 'copyFailed', type: ok ? undefined : 'error' })
  }

  return (
    <Modal title={t('diagnosticsTitle')} closable onClose={onClose} className={styles.dialog}>
      <p className={styles.description}>{t('diagnosticsDescription')} {t('diagnosticsRetention')}</p>
      <label className={styles.option}>
        <input
          type="checkbox" role="switch" checked={preference === 'enabled'}
          onChange={event => setDiagnosticPreference(event.target.checked ? 'enabled' : 'disabled')}
        />
        {t('diagnosticsConsentTitle')}
      </label>
      {event ? (
        <section aria-label={t('diagnosticsRecent')} className={styles.details}>
          <h3>{t('diagnosticsRecent')}</h3>
          <p>{new Date(event.occurred_at * 1000).toLocaleString()}</p>
          <p><code>{event.release} · {event.area} · {event.code}{event.stage ? ` · ${event.stage}` : ''}</code></p>
          {event.http_status !== undefined ? <p>HTTP {event.http_status}</p> : null}
          {event.elapsed_ms !== undefined ? <p>{event.elapsed_ms} ms</p> : null}
          {event.request_id ? <p>{t('diagnosticsRequestNumber')} <code>{event.request_id}</code></p> : null}
          <p>{t('diagnosticsNumber')} <code>{event.event_id}</code></p>
          <div className={styles.actions}>
            <Button variant="outlined" size="m" onClick={() => void copy()}>{t('diagnosticsCopy')}</Button>
            <Button size="m" disabled={sending || sent} onClick={() => void send()}>
              {t(sent ? 'diagnosticsSent' : sending ? 'diagnosticsSending' : 'diagnosticsSendOnce')}
            </Button>
          </div>
        </section>
      ) : <p className={styles.description}>{t('diagnosticsEmpty')}</p>}
    </Modal>
  )
}
