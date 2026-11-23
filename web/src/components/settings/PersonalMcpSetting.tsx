import { useEffect, useId, useRef, useState } from 'react'
import { useSettings } from '../../services/settings.js'
import {
  clearPersonalMcp,
  discoverPersonalMcp,
  refreshPersonalMcpSettings,
  savePersonalMcp,
  usePersonalMcpActionsSupported,
  usePersonalMcpSettings,
  usePersonalMcpSupported,
  type McpSettings,
  type McpTool,
} from '../../services/personalMcp.js'
import { Button } from '../base/Button.js'
import { PersonalMcpTools } from '../chatInput/PersonalMcpTools.js'
import form from './ChatProviderSetting.module.css'
import styles from './PersonalMcpSetting.module.css'

export function PersonalMcpSetting({ disabled }: { disabled: boolean }) {
  const supported = usePersonalMcpSupported()
  return supported ? <McpForm disabled={disabled} /> : null
}

function McpForm({ disabled }: { disabled: boolean }) {
  const chinese = useSettings((state) => state.locale === 'zh-CN')
  const actionsSupported = usePersonalMcpActionsSupported()
  const saved = usePersonalMcpSettings()
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')
  const [removeToken, setRemoveToken] = useState(false)
  const [tools, setTools] = useState<McpTool[]>([])
  const [toolName, setToolName] = useState('')
  const [discovered, setDiscovered] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const pending = useRef(false)
  const active = useRef(false)

  function reset(settings?: McpSettings | null) {
    setEndpoint(settings?.endpoint ?? '')
    setToken('')
    setRemoveToken(false)
    setToolName(settings?.toolName ?? '')
    setTools(settings?.toolName ? [{ name: settings.toolName, title: settings.toolTitle || settings.toolName }] : [])
    setDiscovered(false)
    setConfirmClear(false)
  }

  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  const errorText = (cause: unknown) =>
    cause instanceof Error ? cause.message : chinese ? '资料库请求未完成。' : 'The library request could not be completed.'

  async function perform(action: () => Promise<void>) {
    if (pending.current) {return}
    pending.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (cause) {
      if (active.current) {setError(errorText(cause))}
    } finally {
      pending.current = false
      if (active.current) {setBusy(false)}
    }
  }

  const load = () => perform(async () => {
    const settings = await refreshPersonalMcpSettings()
    if (active.current) {
      reset(settings)
      setLoaded(true)
    }
  })

  function changeConnection() {
    setTools([])
    setToolName('')
    setDiscovered(false)
    setError('')
    setNotice('')
    setConfirmClear(false)
  }

  const connection = () => ({
    endpoint: endpoint.trim(),
    ...(removeToken ? { token: '' } : token.trim() ? { token: token.trim() } : {}),
  })
  const loadTools = () => perform(async () => {
    const available = await discoverPersonalMcp(connection())
    if (!active.current) {return}
    setTools(available)
    setDiscovered(true)
    setToolName((previous) => available.some((tool) => tool.name === previous) ? previous :
      available.length === 1 ? available[0].name : '')
  })
  const save = () => perform(async () => {
    const settings = await savePersonalMcp({ ...connection(), toolName })
    if (!active.current) {return}
    reset(settings)
    setNotice(actionsSupported
      ? chinese ? '已保存。使用官方个人 API 时，可在聊天的「＋」菜单启用 MCP。' :
        'Saved. With your personal DeepSeek API, enable MCP from the + menu in chat.'
      : chinese ? '已保存。发送前点「＋」即可开启「查资料」。' : 'Saved. Use the + menu to enable Search library before sending.')
  })
  const forget = () => perform(async () => {
    await clearPersonalMcp()
    if (!active.current) {return}
    reset()
    setNotice(actionsSupported ? chinese ? '已移除 MCP 服务。' : 'MCP server removed.' :
      chinese ? '已移除资料库。' : 'Library removed.')
  })

  const readOnly = disabled || busy || !loaded
  const sameEndpoint = saved?.endpoint === endpoint.trim()
  const hasSavedToken = sameEndpoint && saved.hasToken
  const title = actionsSupported ? chinese ? 'MCP 服务' : 'MCP server' : chinese ? 'MCP 资料库' : 'MCP library'
  return (
    <section className={styles.setting} onKeyDown={(event) => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {event.preventDefault()}
    }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        className={styles.trigger}
        disabled={disabled || busy}
        onClick={() => {
          setOpen(!open)
          if (!open && !loaded) {void load()}
        }}
      >
        <strong>{title}</strong>
        <span className={styles.rowSummary}>
          {saved?.toolName ? saved.toolTitle || saved.toolName : saved?.endpoint
            ? chinese ? '已配置' : 'Configured'
            : chinese ? '未配置' : 'Unconfigured'}
        </span>
      </button>
      {open ? (
        <div id={panelId} className={form.section} aria-busy={busy}>
          <p className={form.description}>
            {actionsSupported ? chinese
              ? '使用官方个人 API 时，可在聊天中启用此服务。也可以在这里测试工具。'
              : 'Enable this service in chat when using your official DeepSeek API, or test its tools here.'
              : chinese
              ? '配置一个远程只读查询工具。启用后，本条问题会发给资料库，聊天中会保留资料出处。'
              : 'Connect one remote read-only search tool. When enabled, the library receives this message and the chat keeps its sources.'}
          </p>
          {!loaded && !busy ? (
            <div className={form.actions}>
              <Button size="m" variant="outlined" onClick={() => void load()}>
                {chinese ? '重试读取配置' : 'Retry loading settings'}
              </Button>
            </div>
          ) : null}
          <label className={styles.field}>
            {chinese ? '服务地址' : 'Server URL'}
            <input
              className={form.keyInput}
              value={endpoint}
              type="url"
              placeholder="https://example.com/mcp"
              disabled={readOnly}
              maxLength={2048}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => {
                setEndpoint(event.target.value)
                setToken('')
                setRemoveToken(false)
                changeConnection()
              }}
            />
          </label>
          <label className={styles.field}>
            {chinese ? '访问令牌（可选）' : 'Access token (optional)'}
            <input
              className={form.keyInput}
              value={token}
              type="password"
              placeholder={hasSavedToken && !removeToken
                ? chinese ? '已保存，留空保留' : 'Stored. Leave blank to keep.'
                : undefined}
              disabled={readOnly}
              maxLength={4096}
              autoComplete="new-password"
              onChange={(event) => {
                setToken(event.target.value)
                setRemoveToken(false)
                changeConnection()
              }}
            />
          </label>
          {hasSavedToken ? (
            <label className={styles.check}>
              <input type="checkbox" checked={removeToken} disabled={readOnly}
                onChange={(event) => {
                  setRemoveToken(event.target.checked)
                  setToken('')
                  changeConnection()
                }} />
              {chinese ? '移除已保存的令牌' : 'Remove the saved token'}
            </label>
          ) : null}
          <div className={form.actions}>
            <Button variant="outlined" size="m" disabled={readOnly || !endpoint.trim()}
              onClick={() => void loadTools()}>
              {actionsSupported ? chinese ? '查找查询工具' : 'Find lookup tools' : chinese ? '查找工具' : 'Find tools'}
            </Button>
            {tools.length ? (
              <select
                className={form.keyInput}
                aria-label={chinese ? '查询工具' : 'Lookup tool'}
                value={toolName}
                disabled={readOnly}
                onChange={(event) => setToolName(event.target.value)}
              >
                <option value="">{actionsSupported ? chinese ? '不设置默认查询' : 'No default lookup' :
                  chinese ? '选择查询工具' : 'Choose a lookup tool'}</option>
                {tools.map((tool) => <option key={tool.name} value={tool.name}>{tool.title}</option>)}
              </select>
            ) : null}
          </div>
          {discovered && !tools.length ? (
            <p className={form.description}>{chinese ? '没有找到兼容的只读查询工具。' : 'No compatible read-only lookup tool was found.'}</p>
          ) : null}
          <div className={form.actions}>
            <Button size="m" disabled={readOnly || !endpoint.trim() || (!actionsSupported && !toolName)}
              onClick={() => void save()}>
              {actionsSupported ? chinese ? '保存 MCP 服务' : 'Save MCP server' : chinese ? '保存资料库' : 'Save library'}
            </Button>
            {actionsSupported && saved?.endpoint ? (
              <Button variant="outlined" size="m" disabled={readOnly} onClick={() => setTestOpen(true)}>
                {chinese ? '测试工具' : 'Test tools'}
              </Button>
            ) : null}
            {saved?.endpoint ? (
              <Button variant="outlined" size="m" disabled={readOnly}
                onClick={() => {
                  if (confirmClear) {void forget()}
                  else {setConfirmClear(true)}
                }}>
                {actionsSupported ? confirmClear
                  ? chinese ? '确认移除服务' : 'Confirm removal'
                  : chinese ? '移除 MCP 服务' : 'Remove MCP server'
                  : confirmClear
                  ? chinese ? '确认移除资料库' : 'Confirm removal'
                  : chinese ? '移除资料库' : 'Remove library'}
              </Button>
            ) : null}
          </div>
          {busy ? <p role="status" className={form.description}>{chinese ? '正在连接…' : 'Connecting…'}</p> : null}
          {notice ? <p role="status" className={form.description}>{notice}</p> : null}
          {error ? <p role="alert" className={form.error}>{error}</p> : null}
        </div>
      ) : null}
      <PersonalMcpTools open={testOpen} onClose={() => setTestOpen(false)} />
    </section>
  )
}
