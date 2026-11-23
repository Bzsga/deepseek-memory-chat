import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  getPersonalMcpSettings,
  invokePersonalMcpTool,
  listPersonalMcpTools,
  usePersonalMcpActionsSupported,
  usePersonalMcpSettings,
  type McpActionResult,
  type McpActionTool,
  type McpSettings,
} from '../../services/personalMcp.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import {
  checkMcpArguments,
  formMcpArguments,
  inputMcpArguments,
  mcpArgumentFields,
  parseMcpArguments,
  type McpArgumentField,
  type McpArgumentInputs,
} from './mcpToolArguments.js'
import styles from './PersonalMcpTools.module.css'

type PanelProps = {
  open: boolean
  onClose: () => void
}
type DialogProps = Omit<PanelProps, 'open'> & { settings: McpSettings; chinese: boolean }
type ToolList = { settings: McpSettings } &
  ({ loading: true } | { loading: false; tools: McpActionTool[] } | { loading: false; error: string })
type Invocation = { settings: McpSettings; tool: McpActionTool; args: Record<string, unknown> }

const errorText = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback

export function PersonalMcpTools({ open, onClose }: PanelProps) {
  const chinese = useSettings((state) => state.locale === 'zh-CN')
  const settings = usePersonalMcpSettings()
  const supported = usePersonalMcpActionsSupported()
  if (!open) {return null}
  const title = chinese ? '测试 MCP 工具' : 'Test MCP tools'
  if (!supported || !settings?.endpoint) {
    return <Modal title={title} closable onClose={onClose}>
      <p className={styles.status}>{chinese ? '请先在设置中配置 MCP 服务。' : 'Configure an MCP server in Settings.'}</p>
    </Modal>
  }
  return <ToolDialog key={settings.endpoint} settings={settings} chinese={chinese}
    onClose={onClose} />
}

function ToolDialog({ settings, chinese, onClose }: DialogProps) {
  const [list, setList] = useState<ToolList>({ settings, loading: true })
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [toolName, setToolName] = useState('')
  const [values, setValues] = useState<McpArgumentInputs>({})
  const [json, setJson] = useState<string | null>(null)
  const [inputError, setInputError] = useState('')
  const [confirmation, setConfirmation] = useState<Invocation | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<McpActionResult | null>(null)
  const [runError, setRunError] = useState('')
  const [showMore, setShowMore] = useState(false)
  const inFlight = useRef(false)
  const active = useRef(false)
  const firstToolButton = useRef<HTMLButtonElement>(null)
  const toolHeading = useRef<HTMLHeadingElement>(null)
  const confirmIntro = useRef<HTMLParagraphElement>(null)
  const currentList = list.settings === settings ? list : undefined
  const pendingConfirmation = confirmation?.settings === settings ? confirmation : null
  const tools = currentList && 'tools' in currentList ? currentList.tools : []
  const tool = tools.find((entry) => entry.name === toolName)
  const fields = useMemo(() => tool && mcpArgumentFields(tool.inputSchema), [tool])
  const requiredFields = fields?.filter((field) => field.required) ?? []
  const optionalFields = fields?.filter((field) => !field.required) ?? []
  const canEditJson = fields && (fields.length > 0 || tool?.inputSchema.additionalProperties !== false)
  const search = tools.length >= 8 ? query.trim().toLocaleLowerCase() : ''
  const shown = tools.filter(({ name, title, description }) =>
    !search || [name, title, description].some((value) => value.toLocaleLowerCase().includes(search)))
  const close = () => {
    if (inFlight.current) {return}
    if (pendingConfirmation) {setConfirmation(null)}
    else {onClose()}
  }

  useLayoutEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  useLayoutEffect(() => {
    const target = pendingConfirmation ? confirmIntro.current : tool ? toolHeading.current : firstToolButton.current
    target?.focus({ preventScroll: true })
  }, [pendingConfirmation, tool])

  useEffect(() => {
    let current = true
    setQuery('')
    setToolName('')
    setValues({})
    setJson(null)
    setInputError('')
    setConfirmation(null)
    setShowMore(false)
    void listPersonalMcpTools().then((available) => {
      if (current) {setList({ settings, loading: false, tools: available })}
    }).catch((cause: unknown) => {
      if (current) {
        setList({ settings, loading: false, error: errorText(cause, '') })
      }
    })
    return () => { current = false }
  }, [loadAttempt, settings])

  function selectTool(name: string) {
    setToolName(name)
    setValues({})
    setJson(null)
    setInputError('')
    setResult(null)
    setRunError('')
    setShowMore(false)
  }

  function changeInput(name: string, value: string) {
    setValues((previous) => ({ ...previous, [name]: value === '' ? undefined : value }))
    setInputError('')
  }

  function toggleEditor() {
    if (!fields) {return}
    if (json === null) {
      setJson(JSON.stringify(formMcpArguments(fields, values), null, 2))
    } else {
      const parsed = parseMcpArguments(json)
      const inputs = parsed.args && inputMcpArguments(fields, parsed.args)
      if (!inputs) {
        setInputError(chinese ? '当前 JSON 无法转换为表单，请继续编辑 JSON。' : 'These JSON arguments cannot be shown in the form.')
        return
      }
      setValues(inputs)
      setJson(null)
    }
    setInputError('')
  }

  async function invoke(execution: Invocation) {
    if (inFlight.current || !active.current) {return}
    if (execution.settings !== getPersonalMcpSettings()) {
      setConfirmation(null)
      setRunError(chinese ? 'MCP 服务配置已变化，请重新选择工具。' : 'MCP settings have changed. Choose the tool again.')
      return
    }
    inFlight.current = true
    setConfirmation(null)
    setResult(null)
    setRunError('')
    setRunning(true)
    try {
      const reply = await invokePersonalMcpTool(execution.settings.endpoint, execution.tool, execution.args)
      if (active.current) {setResult(reply)}
    } catch (cause) {
      if (active.current) {setRunError(errorText(cause, chinese ? '无法运行工具。' : 'The tool could not run.'))}
    } finally {
      inFlight.current = false
      if (active.current) {setRunning(false)}
    }
  }

  function prepareRun() {
    if (!tool || inFlight.current || pendingConfirmation) {return}
    const parsed = json === null && fields ? { args: formMcpArguments(fields, values) } : parseMcpArguments(json ?? '{}')
    const checked = parsed.args ? checkMcpArguments(tool.inputSchema, parsed.args) : parsed
    if (!checked.args) {
      const problem = checked.issue
      if (problem.kind === 'json') {
        setInputError(chinese ? '请输入有效的 JSON。' : 'Enter valid JSON.')
      } else if (problem.kind === 'object') {
        setInputError(chinese ? '参数必须是 JSON 对象。' : 'Arguments must be a JSON object.')
      } else if (problem.kind === 'number') {
        setInputError(chinese ? '数字超出可精确输入的范围。工具若支持，可改用字符串。' :
          'A number is outside the supported precision. Use a string if the tool allows it.')
      } else if ('field' in problem) {
        const field = fields?.find((entry) => entry.name === problem.field)?.title ?? problem.field
        setInputError(problem.kind === 'required'
          ? chinese ? `请填写「${field}」。` : `Enter ${field}.`
          : problem.kind === 'extra'
            ? chinese ? `工具未声明参数「${field}」。` : `${field} is not an accepted argument.`
            : chinese ? `请检查「${field}」的类型或选项。` : `Check the type or value of ${field}.`)
      }
      return
    }
    setInputError('')
    const execution = { settings, tool, args: checked.args }
    if (tool.readOnly) {void invoke(execution)}
    else {setConfirmation(execution)}
  }

  const renderField = (field: McpArgumentField) => (
    <ArgumentField key={field.name} field={field} chinese={chinese}
      value={Object.hasOwn(values, field.name) ? values[field.name] ?? '' : ''}
      onChange={(value) => changeInput(field.name, value)} />
  )

  const title = pendingConfirmation
    ? chinese ? '确认运行工具' : 'Confirm tool run'
    : chinese ? '测试 MCP 工具' : 'Test MCP tools'
  return (
    <Modal title={title} closable={!running} onClose={close} className={styles.dialog}
      footer={pendingConfirmation ? <div className={styles.actions}>
        <Button size="m" variant="outlined" onClick={() => setConfirmation(null)}>{chinese ? '返回编辑' : 'Back to edit'}</Button>
        <Button size="m" onClick={() => void invoke(pendingConfirmation)}>{chinese ? '确认运行' : 'Confirm run'}</Button>
      </div> : undefined}>
      {pendingConfirmation ? <div className={styles.body}>
        <p ref={confirmIntro} tabIndex={-1} className={styles.status}>
          {chinese ? '此操作可能修改外部数据。' : 'This operation may change external data.'}
        </p>
        <dl className={styles.details}>
          <dt>{chinese ? '目的地址' : 'Destination'}</dt>
          <dd><code>{pendingConfirmation.settings.endpoint}</code></dd>
          <dt>{chinese ? '工具' : 'Tool'}</dt>
          <dd><code>{pendingConfirmation.tool.name}</code></dd>
          <dt>{chinese ? '发送的参数' : 'Arguments to send'}</dt>
          <dd><pre className={styles.preview}>{JSON.stringify(pendingConfirmation.args, null, 2)}</pre></dd>
        </dl>
      </div> : !tool ? <div className={styles.body}>
        {!currentList || currentList.loading ? <p role="status" className={styles.status}>{chinese ? '正在读取工具…' : 'Loading tools…'}</p> : null}
        {currentList && 'error' in currentList ? <div className={styles.body}>
          <p className={styles.error} role="alert">{currentList.error || (chinese ? '无法读取工具列表。' : 'Could not load tools.')}</p>
          <div className={styles.actions}>
            <Button size="m" variant="outlined" onClick={() => {
              setList({ settings, loading: true })
              setLoadAttempt((attempt) => attempt + 1)
            }}>{chinese ? '重试读取工具' : 'Reload tools'}</Button>
          </div>
        </div> : null}
        {currentList && 'tools' in currentList && tools.length === 0
          ? <p className={styles.status}>{chinese ? '服务未提供可运行的工具。' : 'The server has no available tools.'}</p> : null}
        {tools.length >= 8 ? <input className={styles.input} type="search" value={query}
          aria-label={chinese ? '搜索工具' : 'Search tools'} placeholder={chinese ? '搜索工具' : 'Search tools'}
          onChange={(event) => setQuery(event.target.value)} /> : null}
        {shown.length > 0 ? <ul className={styles.toolList}>
          {shown.map((entry, index) => (
            <li key={entry.name}>
              <button ref={index === 0 ? firstToolButton : undefined} type="button" className={styles.toolRow}
                aria-label={entry.title || entry.name} disabled={running} onClick={() => selectTool(entry.name)}>
                <span className={styles.toolTitle}>{entry.title || entry.name}</span>
                {entry.description ? <span className={styles.toolDescription}>{entry.description}</span> : null}
              </button>
            </li>
          ))}
        </ul> : null}
        {tools.length > 0 && shown.length === 0
          ? <p role="status" className={styles.status}>{chinese ? '没有匹配的工具。' : 'No matching tools.'}</p> : null}
      </div> : <div className={styles.body}>
          <section className={styles.tool} aria-label={tool.title || tool.name}>
            <div className={styles.toolHeading}>
              <h2 ref={toolHeading} tabIndex={-1} className={styles.toolTitle}>{tool.title || tool.name}</h2>
              <span>{tool.readOnly ? chinese ? '只读' : 'Read-only' : chinese ? '可能修改外部数据' : 'May change external data'}</span>
            </div>
            {tool.description ? <p className={styles.status}>{tool.description}</p> : null}
          </section>
          <fieldset className={styles.arguments} aria-label={chinese ? '输入参数' : 'Arguments'} disabled={running}>
            {fields && json === null ? <>
                {requiredFields.map(renderField)}
                {optionalFields.length > 0 || canEditJson ? <details className={styles.more}
                  open={showMore} onToggle={(event) => setShowMore(event.currentTarget.open)}>
                  <summary>{chinese ? '更多参数' : 'More arguments'}</summary>
                  <div className={styles.optionalFields}>
                    {optionalFields.map(renderField)}
                    {canEditJson ? <div className={styles.actions}>
                      <Button size="m" variant="outlined" onClick={toggleEditor}>{chinese ? '编辑 JSON' : 'Edit JSON'}</Button>
                    </div> : null}
                  </div>
                </details> : null}
              </>
              : <>
                <label className={styles.field}>
                  <span>{chinese ? 'JSON 参数' : 'JSON arguments'}</span>
                  <textarea className={styles.input} value={json ?? '{}'} rows={5} autoCapitalize="none" spellCheck={false}
                    onChange={(event) => { setJson(event.target.value); setInputError('') }} />
                </label>
                <details className={styles.schema}>
                  <summary>{chinese ? '参数结构' : 'Parameter schema'}</summary>
                  <pre className={styles.preview}>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                </details>
                {fields ? <div className={styles.actions}>
                  <Button size="m" variant="outlined" onClick={toggleEditor}>{chinese ? '使用表单' : 'Use form'}</Button>
                </div> : null}
              </>}
            {inputError ? <p className={styles.error} role="alert">{inputError}</p> : null}
            <div className={styles.actions}>
              <Button size="m" onClick={prepareRun}>{chinese ? '运行工具' : 'Run tool'}</Button>
              <Button size="m" variant="outlined" onClick={() => selectTool('')}>{chinese ? '返回工具列表' : 'Back to tools'}</Button>
            </div>
          </fieldset>
        {running ? <p role="status" className={styles.status}>{chinese ? '工具正在运行…' : 'Running tool…'}</p> : null}
        {runError ? <p role="alert" className={styles.error}>{runError}</p> : null}
        {result ? <section className={styles.result} aria-label={chinese ? '工具结果' : 'Tool result'}>
          {result.status === 'success'
            ? <p role="status" className={styles.status}>{chinese ? '运行完成' : 'Completed'}</p>
            : <p role="alert" className={styles.error}>{result.status === 'tool_error'
              ? chinese ? '工具返回错误。' : 'The tool returned an error.'
              : chinese ? '运行结果未确认。请先到外部服务核对实际状态，再决定是否重试。' : 'The outcome is unknown. Check the external service before deciding whether to run it again.'}</p>}
          {result.truncated ? <p className={styles.status}>{chinese ? '结果过长，此处显示部分内容。' : 'Showing part of a long result.'}</p> : null}
          {result.text ? <pre className={styles.preview}>{result.text}</pre> : null}
        </section> : null}
      </div>}
    </Modal>
  )
}

function ArgumentField({ field, value, onChange, chinese }: {
  field: McpArgumentField
  value: string
  onChange: (value: string) => void
  chinese: boolean
}) {
  return <label className={styles.field}>
    <span>{field.title}{field.required ? <span aria-hidden="true"> *</span> : null}</span>
    {field.type === 'enum' || field.type === 'boolean' ? (
      <select className={styles.input} value={value} aria-required={field.required}
        onChange={(event) => onChange(event.target.value)}>
        <option value="">{chinese ? '请选择' : 'Select'}</option>
        {field.type === 'enum' ? field.options.map((option, index) => <option key={index} value={index}>
          {JSON.stringify(option)}
        </option>) : <>
          <option value="true">{chinese ? '是' : 'Yes'}</option>
          <option value="false">{chinese ? '否' : 'No'}</option>
        </>}
      </select>
    ) : (
      <input className={styles.input} value={value} aria-required={field.required}
        type={field.type === 'string' ? field.sensitive ? 'password' : 'text' : 'number'}
        step={field.type === 'integer' ? 1 : field.type === 'number' ? 'any' : undefined}
        autoComplete={field.sensitive ? 'new-password' : 'off'}
        onChange={(event) => onChange(event.target.value)} />
    )}
    {field.description ? <small>{field.description}</small> : null}
  </label>
}
