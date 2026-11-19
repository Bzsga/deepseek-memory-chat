import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { openAccountLogin } from '../../services/runtime.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'

export const AccountLoginButton = ({ label = 'signInOrRegister' }: { label?: TranslationKey }) => {
  const t = useTranslate()
  const [opening, setOpening] = useState(false)
  const open = async () => {
    setOpening(true)
    try {
      await openAccountLogin()
    } catch {
      showToast({ key: 'loginOpenFailed', type: 'error' })
    } finally {
      setOpening(false)
    }
  }
  return (
    <Button variant="outlined" size="m" disabled={opening} onClick={() => void open()}>
      {t(label)}
    </Button>
  )
}
