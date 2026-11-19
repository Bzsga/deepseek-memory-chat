import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import layout from './Settings.module.css'
import styles from './ChatProviderSetting.module.css'

export function SettingsEditRow({
  label,
  summary,
  disabled,
  onOpen,
}: {
  label: string
  summary: string
  disabled?: boolean
  onOpen: () => void
}) {
  const t = useTranslate()

  return (
    <div className={clsx(layout.cell, layout.row)}>
      <div className={styles.rowText}>
        <div className={layout.label}>{label}</div>
        <div className={styles.rowSummary} title={summary}>{summary}</div>
      </div>
      <Button
        variant="outlined"
        size="m"
        className={layout.cellButton}
        aria-label={t('settingsConfigureLabel', { label })}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={onOpen}
      >
        {t('settingsConfigure')}
      </Button>
    </div>
  )
}
