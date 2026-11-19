import { useEffect, useId, useRef, useState } from 'react'
import { useSettings } from '../../services/settings.js'
import {
  configureImageProvider,
  forgetImageProvider,
  imageModels,
  managedImageAvailable,
  useActiveImageProvider,
  useImageProvider,
} from '../../services/imageProvider.js'
import { useChatProvider } from '../../services/chatProvider.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { SettingsEditRow } from './SettingsEditRow.js'
import styles from './ChatProviderSetting.module.css'

export function ImageProviderSetting() {
  const zh = useSettings((state) => state.locale === 'zh-CN')
  const ready = useImageProvider((state) => state.ready)
  const active = useActiveImageProvider()
  const [open, setOpen] = useState(false)
  const title = zh ? '生图服务' : 'Image generation'
  const summary = !ready
    ? zh ? '正在读取配置…' : 'Loading configuration…'
    : active === 'personal'
      ? zh ? '个人生图 API' : 'Personal image API'
      : active === 'managed'
        ? zh ? '配套免费生图' : 'Included image service'
        : zh ? '未启用' : 'Off'

  return (
    <>
      <SettingsEditRow label={title} summary={summary} disabled={!ready} onOpen={() => setOpen(true)} />
      {open ? <ImageProviderForm title={title} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function ImageProviderForm({ title, onClose }: { title: string; onClose: () => void }) {
  const zh = useSettings((state) => state.locale === 'zh-CN')
  useChatProvider((state) => state.managedEligible)
  const included = managedImageAvailable()
  const current = useImageProvider()
  const [mode, setMode] = useState(current.mode === 'managed' && !included ? 'off' : current.mode)
  const [base, setBase] = useState(current.base)
  const [model, setModel] = useState(current.model)
  const [key, setKey] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const pending = useRef(false)
  const list = useId()
  const formId = useId()
  useEffect(() => () => request.current?.abort(), [])

  async function run(action: 'save' | 'list' | 'forget') {
    if (pending.current || !current.ready) {
      return
    }
    pending.current = true
    setBusy(true)
    setError('')
    try {
      if (action === 'list') {
        const controller = new AbortController()
        request.current = controller
        const values = await imageModels(base, key, controller.signal)
        if (!controller.signal.aborted) {
          setModels(values)
          showToast({
            key: 'chatEndpointCount',
            params: { count: values.length },
          })
        }
      } else {
        if (action === 'forget') {
          await forgetImageProvider()
        } else {
          await configureImageProvider(mode, base, key, model)
        }
        showToast(zh ? '已保存生图服务设置' : 'Image generation settings saved')
        onClose()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : zh ? '操作失败。' : 'Request failed.')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <Modal
      title={title}
      className={styles.dialog}
      closable
      onClose={() => {
        if (!pending.current) {
          onClose()
        }
      }}
      footer={
        <div className={styles.footerActions}>
          {current.configured ? (
            <Button variant="outlined" size="m" disabled={busy} onClick={() => void run('forget')}>
              {zh ? '清除生图密钥' : 'Remove image key'}
            </Button>
          ) : null}
          <Button type="submit" size="m" form={formId} disabled={busy || !current.ready || (mode === 'managed' && !included)}>
            {zh ? '保存' : 'Save'}
          </Button>
        </div>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault()
          void run('save')
        }}
      >
        <fieldset disabled={busy || !current.ready} className={styles.fieldset}>
          <label className={styles.field}>
            {zh ? '服务' : 'Service'}
            <select
              className={styles.keyInput}
              value={mode}
              onChange={(event) => {
                setMode(event.target.value as typeof mode)
                setError('')
              }}
            >
              <option value="off">{zh ? '关闭' : 'Off'}</option>
              <option value="managed" disabled={!included}>
                {included
                  ? zh ? '配套免费生图' : 'Included image service'
                  : zh ? '配套生图不可用' : 'Included service unavailable'}
              </option>
              <option value="personal">{zh ? '个人生图 API' : 'Personal image API'}</option>
            </select>
          </label>
          {mode === 'personal' ? (
            <>
              <label className={styles.field}>
                Base URL
                <input
                  className={styles.keyInput}
                  type="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={base}
                  onChange={(event) => {
                    setBase(event.target.value)
                    setModels([])
                    setKey('')
                  }}
                  placeholder="https://…/v1"
                />
              </label>
              <label className={styles.field}>
                API Key
                <input
                  className={styles.keyInput}
                  type="password"
                  autoComplete="new-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={key}
                  onChange={(event) => {
                    setKey(event.target.value)
                    setModels([])
                  }}
                  placeholder={current.configured && base === current.base
                    ? zh ? '已保存，留空可继续使用' : 'Saved on this device'
                    : ''}
                />
              </label>
              <label className={styles.field}>
                {zh ? '生图模型' : 'Image model'}
                <input className={styles.keyInput} list={list} value={model} onChange={(event) => setModel(event.target.value)} />
              </label>
              <datalist id={list}>
                {models.map((id) => <option key={id} value={id} />)}
              </datalist>
              <div className={styles.actions}>
                <Button variant="outlined" size="m" onClick={() => void run('list')}>
                  {zh ? '获取模型列表' : 'Fetch models'}
                </Button>
              </div>
              <p className={styles.description}>
                {zh
                  ? '需使用允许浏览器跨域访问、兼容 OpenAI 生图接口的服务。密钥在本机加密保存，绘图费用由所选服务商收取。'
                  : 'Use a service that allows browser requests and supports OpenAI-compatible image generation. Your key is encrypted locally and your provider bills each generation.'}
              </p>
            </>
          ) : null}
          {error ? <p role="alert" className={styles.error}>{error}</p> : null}
        </fieldset>
      </form>
    </Modal>
  )
}
