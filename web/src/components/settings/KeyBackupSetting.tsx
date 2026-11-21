import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useChatProvider } from '../../services/chatProvider.js'
import { keyBackupSession, type KeyEnvelope } from '../../services/keyBackup.js'
import type { SyncDocument } from '../../services/cloudPreferences.js'
import { Button } from '../base/Button.js'
import fields from './ChatProviderSetting.module.css'
import styles from './ConversationSyncSetting.module.css'

type Action = 'save' | 'restore' | 'remove'
export function KeyBackupControls({ generation }: { generation: number }) {
  const t = useTranslate()
  const configured = useChatProvider((s) => s.keyConfigured)
  const [doc, setDoc] = useState<SyncDocument<KeyEnvelope> | null>(null)
  const [action, setAction] = useState<Action | null>(null)
  const [phrase, setPhrase] = useState(''),
    [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0)
  const [notice, setNotice] = useState<
    | 'keyBackupError'
    | 'keyBackupRestoreError'
    | 'keyBackupSaved'
    | 'keyBackupRestored'
    | 'keyBackupRemoved'
    | null
  >(null)
  useEffect(() => {
    let active = true
    void keyBackupSession(generation)
      .load()
      .then((result) => {
        if (active) {
          setDoc(result)
        }
      })
      .catch(() => {
        if (active) {
          setNotice('keyBackupError')
        }
      })
    return () => {
      active = false
    }
  }, [generation, refresh])
  function select(next: Action | null) {
    setAction(next)
    setPhrase('')
    setRepeat('')
    setNotice(null)
  }
  async function confirm() {
    if (busy || !doc || !action) {
      return
    }
    setBusy(true)
    const session = keyBackupSession(generation)
    try {
      if (action === 'save') {
        setDoc(await session.save(doc.revision, phrase))
      }
      if (action === 'restore') {
        await session.restore(doc, phrase)
      }
      if (action === 'remove') {
        setDoc(await session.remove(doc.revision))
      }
      select(null)
      setNotice(
        action === 'save'
          ? 'keyBackupSaved'
          : action === 'restore'
            ? 'keyBackupRestored'
            : 'keyBackupRemoved'
      )
    } catch {
      select(null)
      setNotice(action === 'restore' ? 'keyBackupRestoreError' : 'keyBackupError')
      setDoc(null)
      setRefresh((n) => n + 1)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={styles.section}>
      <p className={styles.description}>{t('keyBackupHelp')}</p>
      {doc && (
        <p className={styles.status}>{t(doc.value ? 'keyBackupPresent' : 'keyBackupAbsent')}</p>
      )}
      {action ? (
        <>
          <p>
            {t(
              action === 'save'
                ? 'keyBackupSaveHelp'
                : action === 'restore'
                  ? 'keyBackupRestoreHelp'
                  : 'keyBackupRemoveHelp'
            )}
          </p>
          {action !== 'remove' && (
            <input
              className={fields.keyInput}
              type="password"
              aria-label={t('keyBackupPhrase')}
              placeholder={t('keyBackupPhrase')}
              autoComplete="off"
              maxLength={512}
              value={phrase}
              disabled={busy}
              onChange={(e) => setPhrase(e.target.value)}
            />
          )}
          {action === 'save' && (
            <input
              className={fields.keyInput}
              type="password"
              aria-label={t('keyBackupRepeat')}
              placeholder={t('keyBackupRepeat')}
              autoComplete="new-password"
              maxLength={512}
              value={repeat}
              disabled={busy}
              onChange={(e) => setRepeat(e.target.value)}
            />
          )}
          <div className={styles.actions}>
            <Button size="s" variant="outlined" disabled={busy} onClick={() => select(null)}>
              {t('cancel')}
            </Button>
            <Button
              size="s"
              disabled={
                busy ||
                (action === 'restore' && !phrase) ||
                (action === 'save' && (phrase.trim().length < 12 || phrase !== repeat))
              }
              onClick={() => void confirm()}
            >
              {t(
                action === 'save'
                  ? 'keyBackupSave'
                  : action === 'restore'
                    ? 'keyBackupRestore'
                    : 'keyBackupRemove'
              )}
            </Button>
          </div>
        </>
      ) : (
        <div className={styles.actions}>
          {configured && doc && (
            <Button variant="outlined" size="s" onClick={() => select('save')}>
              {t('keyBackupSave')}
            </Button>
          )}
          {doc?.value && (
            <>
              <Button variant="outlined" size="s" onClick={() => select('restore')}>
                {t('keyBackupRestore')}
              </Button>
              <Button variant="dangerOutlined" size="s" onClick={() => select('remove')}>
                {t('keyBackupRemove')}
              </Button>
            </>
          )}
          {!doc && notice && (
            <Button variant="outlined" size="s" onClick={() => setRefresh((n) => n + 1)}>
              {t('keyBackupRetry')}
            </Button>
          )}
          {!configured && doc && <p className={styles.description}>{t('keyBackupNoLocal')}</p>}
        </div>
      )}
      {notice && (
        <p role="status" className={styles.status}>
          {t(notice)}
        </p>
      )}
    </div>
  )
}
