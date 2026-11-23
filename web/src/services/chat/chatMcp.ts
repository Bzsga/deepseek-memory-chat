import { create } from 'zustand'
import { captureChatProvider, useChatProvider } from '../chatProvider.js'
import {
  getPersonalMcpSettings,
  invokePersonalMcpTool,
  listPersonalMcpTools,
  subscribePersonalMcpSettings,
  usePersonalMcpActionsSupported,
  usePersonalMcpSettings,
  type McpSettings,
} from '../personalMcp.js'
import { nativePersonalMcpActionsAvailable, subscribeNativeBridge } from '../nativeBridge.js'
import { OFFICIAL_BASE } from '../providerEndpoint.js'
import type { McpChatInvocation, McpChatOutcome } from './mcpChatStream.js'

export type ChatMcpActivity = {
  id: string
  title: string
  toolName?: string
  endpoint: string
  args: Record<string, unknown>
  status: 'waiting' | 'running' | McpChatOutcome['status']
  text?: string
}

const noActivity: readonly ChatMcpActivity[] = []
const turnKey = (sessionId: string, messageId: string) => `${sessionId}\0${messageId}`
const state = create<{
  selected: Map<string | null, McpSettings>
  activity: Map<string, readonly ChatMcpActivity[]>
}>(() => ({ selected: new Map(), activity: new Map() }))

export function useChatMcpAvailability(sessionId: string | null) {
  const settings = usePersonalMcpSettings()
  const supported = usePersonalMcpActionsSupported()
  const official = useChatProvider((provider) => provider.mode === 'personal' && provider.keyConfigured &&
    !provider.loading && !provider.error && provider.endpoint.baseUrl === OFFICIAL_BASE)
  const selected = state((store) => store.selected.get(sessionId))
  const available = supported && official && Boolean(settings?.endpoint)
  return { available, enabled: available && selected === settings }
}

const currentSettings = () => {
  if (!nativePersonalMcpActionsAvailable()) {return null}
  const settings = getPersonalMcpSettings()
  if (!settings?.endpoint) {return null}
  try {
    const provider = captureChatProvider()
    return provider.mode === 'personal' && provider.baseUrl === OFFICIAL_BASE ? settings : null
  } catch {
    return null
  }
}

export function captureChatMcpSettings(sessionId: string | null): McpSettings | null {
  const settings = currentSettings()
  return settings && state.getState().selected.get(sessionId) === settings ? settings : null
}

export function subscribeChatMcpSettings(notify: () => void) {
  const subscriptions = [
    state.subscribe((next, previous) => {if (next.selected !== previous.selected) {notify()}}),
    subscribePersonalMcpSettings(notify),
    subscribeNativeBridge(notify),
    useChatProvider.subscribe(notify),
  ]
  return () => subscriptions.forEach((unsubscribe) => unsubscribe())
}

export function setChatMcpEnabled(sessionId: string | null, enabled: boolean) {
  const settings = enabled ? currentSettings() : null
  state.setState(({ selected }) => {
    const next = new Map(selected)
    if (settings) {next.set(sessionId, settings)}
    else {next.delete(sessionId)}
    return { selected: next }
  })
}

export function moveChatMcpSelection(sessionId: string) {
  const settings = state.getState().selected.get(null)
  if (settings) {
    state.setState(({ selected }) => {
      const next = new Map(selected)
      next.delete(null)
      next.set(sessionId, settings)
      return { selected: next }
    })
  }
}

export function useChatMcpActivity(sessionId: string, messageId: string): readonly ChatMcpActivity[] {
  return state((store) => store.activity.get(turnKey(sessionId, messageId)) ?? noActivity)
}

export function initializeChatMcpTurn(sessionId: string, messageId: string) {
  state.setState(({ activity }) => {
    const next = new Map(activity)
    next.set(turnKey(sessionId, messageId), noActivity)
    for (const [key, calls] of next) {
      if (next.size <= 24) {break}
      if (calls.every(({ status }) => status !== 'waiting' && status !== 'running')) {next.delete(key)}
    }
    return { activity: next }
  })
}

function updateActivity(key: string, entry: ChatMcpActivity) {
  state.setState(({ activity }) => {
    const calls = activity.get(key)
    if (!calls) {return { activity }}
    const next = new Map(activity)
    next.set(key, calls.some(({ id }) => id === entry.id)
      ? calls.map((call) => call.id === entry.id ? entry : call)
      : [...calls, entry])
    return { activity: next }
  })
}

export function loadChatMcpTools(settings: McpSettings, signal: AbortSignal) {
  signal.throwIfAborted()
  if (currentSettings() !== settings) {throw new Error('MCP 服务或聊天 API 已变化，请重新开启。')}
  return new Promise<Awaited<ReturnType<typeof listPersonalMcpTools>>>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    void listPersonalMcpTools().then((tools) => {
      if (currentSettings() !== settings) {throw new Error('MCP 服务或聊天 API 已变化，请重新开启。')}
      if (!tools.length) {throw new Error('MCP 服务没有提供可用工具。')}
      resolve(tools)
    }).catch(reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

type InvocationContext = {
  sessionId: string
  messageId: string
  settings: McpSettings
  call: McpChatInvocation
  signal: AbortSignal
  live: () => boolean
  subscribeInvalidation: (notify: () => void) => () => void
}

const decisions = new Map<string, (approve: boolean) => void>()
const decisionKey = (key: string, id: string) => `${key}\0${id}`
const skipped = (): McpChatOutcome => ({ status: 'rejected', text: '用户没有运行此工具。', truncated: false })
const unknown = (): McpChatOutcome => ({ status: 'uncertain', text: '工具已提交，暂未确认执行结果。', truncated: false })

export function respondChatMcpCall(sessionId: string, messageId: string, callId: string, approve: boolean) {
  decisions.get(decisionKey(turnKey(sessionId, messageId), callId))?.(approve)
}

/** Watch navigation and bridge changes even when a tool is paused awaiting a tap. */
function watchScope(ctx: InvocationContext, onLost: () => void) {
  const changed = () => {if (!ctx.live()) {onLost()}}
  const unsubscribeStore = ctx.subscribeInvalidation(changed)
  const unsubscribeSettings = subscribeChatMcpSettings(changed)
  ctx.signal.addEventListener('abort', onLost, { once: true })
  return () => {
    unsubscribeStore()
    unsubscribeSettings()
    ctx.signal.removeEventListener('abort', onLost)
  }
}

function confirm(ctx: InvocationContext, key: string, entry: ChatMcpActivity) {
  return new Promise<boolean>((resolve) => {
    const id = decisionKey(key, entry.id)
    const complete = (approve: boolean) => {
      if (!decisions.delete(id)) {return}
      unsubscribe()
      const permitted = approve && ctx.live() && !ctx.signal.aborted
      updateActivity(key, { ...entry, args: {}, status: permitted ? 'running' : 'rejected' })
      resolve(permitted)
    }
    const unsubscribe = watchScope(ctx, () => complete(false))
    decisions.set(id, complete)
    updateActivity(key, entry)
    if (!ctx.live() || ctx.signal.aborted) {complete(false)}
  })
}

export async function runChatMcpInvocation(context: InvocationContext): Promise<McpChatOutcome> {
  const { sessionId, messageId, settings, call, signal } = context
  const ctx = { ...context, live: () => context.live() && currentSettings() === settings }
  if (!ctx.live() || signal.aborted) {return skipped()}
  const key = turnKey(sessionId, messageId)
  const entry: ChatMcpActivity = {
    id: call.id, title: call.tool.title || call.tool.name, toolName: call.tool.name,
    endpoint: settings.endpoint, args: call.args, status: 'waiting',
  }
  const allowedLookup = call.tool.readOnly && call.tool.name === settings.toolName
  if (!allowedLookup && !await confirm(ctx, key, entry)) {return skipped()}
  if (!ctx.live() || signal.aborted) {
    updateActivity(key, { ...entry, args: {}, status: 'rejected' })
    return skipped()
  }
  updateActivity(key, { ...entry, args: {}, status: 'running' })
  const request = invokePersonalMcpTool(settings.endpoint, call.tool, call.args).catch((error: unknown): McpChatOutcome => ({
    status: 'tool_error', truncated: false,
    text: error instanceof Error ? error.message : 'MCP 工具未执行。',
  }))
  return new Promise((resolve) => {
    let finished = false
    const interrupt = () => {
      if (finished) {return}
      finished = true
      unsubscribe()
      const outcome = unknown()
      updateActivity(key, { ...entry, args: {}, status: outcome.status, text: outcome.text })
      resolve(outcome)
    }
    const unsubscribe = watchScope(ctx, interrupt)
    if (!ctx.live() || signal.aborted) {interrupt()}
    void request.then((outcome) => {
      updateActivity(key, { ...entry, args: {}, status: outcome.status, text: outcome.text })
      if (!finished) {
        finished = true
        unsubscribe()
        resolve(outcome)
      }
    })
  })
}
