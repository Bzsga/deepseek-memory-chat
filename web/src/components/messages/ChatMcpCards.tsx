import { Fragment, useRef } from 'react'
import { respondChatMcpCall, useChatMcpActivity } from '../../services/chat/chatMcp.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import styles from './ChatMcpCards.module.css'

type Activity = ReturnType<typeof useChatMcpActivity>[number]

const states: Record<Activity['status'], readonly [string, string]> = {
  waiting: ['等待确认', 'Waiting for approval'],
  running: ['正在运行', 'Running'],
  success: ['运行完成', 'Completed'],
  tool_error: ['工具返回错误', 'Tool returned an error'],
  uncertain: ['结果未确认', 'Outcome unconfirmed'],
  rejected: ['已跳过', 'Skipped'],
}

export function ChatMcpCards({ sessionId, messageId }: { sessionId: string; messageId: string }) {
  const activity = useChatMcpActivity(sessionId, messageId)
  const chinese = useSettings((state) => state.locale === 'zh-CN')
  if (activity.length === 0) {return null}
  const active = activity.some((call) => call.status === 'waiting' || call.status === 'running')
  return (
    <section className={styles.cards} aria-label={chinese ? 'MCP 工具活动' : 'MCP tool activity'}
      data-chat-mcp-active={active ? '' : undefined}>
      {activity.map((call) => (
        <McpActivityCard key={call.id} call={call} chinese={chinese}
          respond={(approve) => respondChatMcpCall(sessionId, messageId, call.id, approve)} />
      ))}
    </section>
  )
}

function McpActivityCard({ call, chinese, respond }: {
  call: Activity
  chinese: boolean
  respond: (approve: boolean) => void
}) {
  const waiting = call.status === 'waiting'
  const uncertain = call.status === 'uncertain'
  const preview = call.status === 'rejected' ? undefined : call.text?.trim().slice(0, 180)
  const statusText = useRef<HTMLSpanElement>(null)
  function decide(approve: boolean) {
    respond(approve)
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) {statusText.current?.focus({ preventScroll: true })}
    })
  }
  return (
    <article className={styles.card} aria-label={call.title} data-chat-mcp-status={call.status}>
      <div className={styles.heading}>
        <strong>{call.title}</strong>
        <span className={styles.status} role="status" ref={statusText} tabIndex={-1}>
          {states[call.status][chinese ? 0 : 1]}
        </span>
      </div>
      {waiting || uncertain ? (
        <dl className={styles.parameters}>
          <dt>{chinese ? '目标服务' : 'Destination'}</dt>
          <dd><code>{call.endpoint}</code></dd>
          {waiting && call.toolName && call.toolName !== call.title ? <>
            <dt>{chinese ? '工具名称' : 'Tool name'}</dt>
            <dd><code>{call.toolName}</code></dd>
          </> : null}
        </dl>
      ) : null}
      {waiting ? <>
        <CallArguments args={call.args} chinese={chinese} />
        <div className={styles.actions}>
          <Button size="m" onClick={() => decide(true)}>{chinese ? '允许' : 'Allow'}</Button>
          <Button size="m" variant="outlined" onClick={() => decide(false)}>{chinese ? '跳过' : 'Skip'}</Button>
        </div>
      </> : null}
      {uncertain ? (
        <p className={styles.note}>{chinese ? '请先到目标服务核对实际状态。' : 'Check the destination to see what happened.'}</p>
      ) : null}
      {preview ? (
        <details className={styles.details}>
          <summary>
            <span>{chinese ? '查看结果' : 'View result'}</span>
            <span className={styles.preview} aria-hidden="true">{preview}</span>
          </summary>
          <pre className={styles.text}>{call.text}</pre>
        </details>
      ) : null}
    </article>
  )
}

function CallArguments({ args, chinese }: { args: Record<string, unknown>; chinese: boolean }) {
  const entries = Object.entries(args)
  const scalar = entries.filter(([, value]) => value === null || typeof value !== 'object')
  const complex = entries.filter(([, value]) => value !== null && typeof value === 'object')
  if (entries.length === 0) {
    return <p className={styles.note}>{chinese ? '无参数' : 'No arguments'}</p>
  }
  return <>
    {scalar.length > 0 ? (
      <dl className={styles.parameters} aria-label={chinese ? '参数' : 'Arguments'}>
        {scalar.map(([name, value]) => (
          <Fragment key={name}>
            <dt>{name}</dt>
            <dd><code>{JSON.stringify(value)}</code></dd>
          </Fragment>
        ))}
      </dl>
    ) : null}
    {complex.length > 0 ? (
      <details className={styles.details}>
        <summary>{chinese ? '复杂参数' : 'Structured arguments'}</summary>
        <pre className={styles.text}>{JSON.stringify(Object.fromEntries(complex), null, 2)}</pre>
      </details>
    ) : null}
  </>
}
