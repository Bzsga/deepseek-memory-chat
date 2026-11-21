import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { countGuestChats, copyGuestChats } from '../../services/chat/guestHistory.js'
import { accountStorageKey, isGuestWorkspace, isSessionActive } from '../../services/runtime.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { SettingsEditRow } from './SettingsEditRow.js'
import styles from './ChatProviderSetting.module.css'

const useGuestHistoryCopy = create(() => ({ count: 0, open: false }))

export function GuestHistoryCopyEntry() {
  const count = useGuestHistoryCopy(state => state.count)
  const zh = useSettings(state => state.locale === 'zh-CN')
  if (!count || isGuestWorkspace()) {return null}
  return <SettingsEditRow
    label={zh ? '复制本机访客聊天' : 'Copy chats from this device'}
    summary={zh ? `${count} 个会话` : `${count} conversations`}
    onOpen={() => useGuestHistoryCopy.setState({ open: true })}
  />
}

export function GuestHistoryMigration() {
  const { count, open } = useGuestHistoryCopy()
  const zh = useSettings(state => state.locale === 'zh-CN')
  const mounted = useRef(false)
  const copying = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (isGuestWorkspace()) {return}
    mounted.current = true
    const marker = accountStorageKey('guest-history-copy-v1')
    void countGuestChats().then(count => {
      if (!mounted.current || !isSessionActive()) {return}
      let seen = false
      try {seen = localStorage.getItem(marker) !== null} catch { /* Storage access can be restricted. */ }
      useGuestHistoryCopy.setState({ count, open: count > 0 && !seen })
    }).catch(() => {})
    return () => {mounted.current = false}
  }, [])

  const dismiss = () => {
    try {localStorage.setItem(accountStorageKey('guest-history-copy-v1'), 'seen')} catch { /* Optional reminder. */ }
    setError('')
    useGuestHistoryCopy.setState({ open: false })
  }
  const copy = async () => {
    if (copying.current) {return}
    copying.current = true
    setBusy(true)
    setError('')
    try {
      const added = await copyGuestChats(() => mounted.current)
      if (mounted.current && isSessionActive()) {
        dismiss()
        showToast(zh ? `已复制 ${added} 个会话` : `Copied ${added} conversations`)
      }
    } catch {
      if (mounted.current) {
        setError(zh ? '复制中断。可以重试，已复制的会话会保留。' : 'Copy interrupted. You can retry and keep the chats already copied.')
      }
    } finally {
      copying.current = false
      if (mounted.current) {setBusy(false)}
    }
  }

  if (!open || isGuestWorkspace()) {return null}
  return <Modal
    title={zh ? '复制这台设备的聊天？' : 'Copy chats from this device?'}
    className={styles.dialog}
    closable={!busy}
    onClose={() => {if (!copying.current) {dismiss()}}}
    footer={<div className={styles.footerActions}>
      <Button size="m" variant="outlined" disabled={busy} onClick={dismiss}>{zh ? '稍后' : 'Later'}</Button>
      <Button size="m" disabled={busy} onClick={() => {void copy()}}>
        {busy ? (zh ? '正在复制…' : 'Copying…') : (zh ? '复制聊天' : 'Copy chats')}
      </Button>
    </div>}
  >
    <p className={styles.description}>{zh
      ? `这台设备有 ${count} 个访客会话。复制后可在当前账号继续使用，原会话保留在访客工作区。如果当前账号已开启同步，副本会按已有的同步范围上传。`
      : `This device has ${count} guest conversations. Copies go into this account, and the originals stay in the guest workspace. If sync is already on, copies follow its current settings.`}</p>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
  </Modal>
}
