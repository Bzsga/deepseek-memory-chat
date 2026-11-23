import { create } from 'zustand'
import { useSyncExternalStore } from 'react'
import { normalizeMcpSources, type McpSource } from './chat/mcpSources.js'
import {
  NativeMcpInvocationInterrupted,
  nativePersonalMcpActionsAvailable,
  nativePersonalMcpChannel,
  requestNativeMcp,
  subscribeNativeBridge,
} from './nativeBridge.js'
import { getRuntime, isGuestWorkspace, isSessionActive } from './runtime.js'

export const MAX_MCP_QUESTION_LENGTH = 2000
export const MAX_MCP_ARGUMENT_BYTES = 24 * 1024

export type McpSettings = {
  endpoint: string
  toolName: string
  toolTitle: string
  hasToken: boolean
}
export type McpTool = { name: string; title: string }
export type McpActionTool = McpTool & {
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
  revision: string
}
export type McpActionResult = { status: 'success' | 'tool_error' | 'uncertain'; text: string; truncated: boolean }
type McpConnection = { endpoint: string; token?: string }

const useMcpStore = create<{ settings: McpSettings | null; channel?: MessagePort }>(() => ({ settings: null }))
export const usePersonalMcpChannel = () =>
  useSyncExternalStore(subscribeNativeBridge, nativePersonalMcpChannel)
export const usePersonalMcpSupported = () => Boolean(usePersonalMcpChannel())
export const subscribePersonalMcpSettings = (notify: () => void) => useMcpStore.subscribe(notify)
export const usePersonalMcpActionsSupported = () =>
  useSyncExternalStore(subscribeNativeBridge, nativePersonalMcpActionsAvailable)
export const usePersonalMcpSettings = () => {
  const channel = usePersonalMcpChannel()
  return useMcpStore((state) => state.channel === channel ? state.settings : null)
}
export const getPersonalMcpSettings = () => {
  const state = useMcpStore.getState()
  return state.channel === nativePersonalMcpChannel() ? state.settings : null
}

const object = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('App 返回的资料库信息无效。')
  }
  return value as Record<string, unknown>
}

const toolNamePattern = /^[A-Za-z0-9_.-]{1,128}$/
const readSettings = (value: unknown): McpSettings => {
  const data = object(value)
  const { endpoint, toolName, toolTitle, hasToken } = data
  if (typeof endpoint !== 'string' || endpoint.length > 2048 ||
      typeof toolName !== 'string' || (toolName !== '' && !toolNamePattern.test(toolName)) ||
      typeof toolTitle !== 'string' || toolTitle.length > 240 || typeof hasToken !== 'boolean') {
    throw new Error('App 返回的资料库配置无效。')
  }
  return { endpoint, toolName, toolTitle, hasToken }
}

function bridge(action: Parameters<typeof requestNativeMcp>[0], payload: object = {}) {
  if (!isSessionActive()) {
    throw new Error('当前聊天工作区已切换。')
  }
  const user = getRuntime().user
  return requestNativeMcp(action, { ...payload, ownerId: user.id, guest: isGuestWorkspace() })
}

let settingsRevision = 0
let settingsRead: { channel: MessagePort; request: Promise<McpSettings> } | undefined

function stillCurrent(channel: MessagePort | undefined, revision: number) {
  return channel === nativePersonalMcpChannel() && revision === settingsRevision && isSessionActive()
}

export async function refreshPersonalMcpSettings(): Promise<McpSettings | null> {
  const channel = nativePersonalMcpChannel()
  if (!channel || !isSessionActive()) {
    settingsRevision++
    useMcpStore.setState({ settings: null })
    return null
  }
  if (settingsRead?.channel === channel) {return settingsRead.request}
  const revision = settingsRevision
  const request = bridge('settings').then((value) => {
    const settings = readSettings(value)
    if (stillCurrent(channel, revision)) {
      const current = getPersonalMcpSettings()
      if (!current || current.endpoint !== settings.endpoint || current.toolName !== settings.toolName ||
          current.toolTitle !== settings.toolTitle || current.hasToken !== settings.hasToken) {
        useMcpStore.setState({ settings, channel })
      }
    }
    return settings
  })
  settingsRead = { channel, request }
  try {
    return await request
  } finally {
    if (settingsRead?.request === request) {settingsRead = undefined}
  }
}

export async function discoverPersonalMcp(input: McpConnection): Promise<McpTool[]> {
  const { tools } = object(await bridge('discover', input))
  if (!Array.isArray(tools) || tools.length > 50) {
    throw new Error('App 返回的资料库工具列表无效。')
  }
  return tools.map((item: unknown) => {
    const { name, title } = object(item)
    if (typeof name !== 'string' || !toolNamePattern.test(name) ||
        typeof title !== 'string' || title.length > 240) {
      throw new Error('App 返回的资料库工具无效。')
    }
    return { name, title: title || name }
  })
}

export async function savePersonalMcp(input: McpConnection & { toolName: string }): Promise<McpSettings> {
  const channel = nativePersonalMcpChannel()
  const settings = readSettings(await bridge('save', input))
  if (channel === nativePersonalMcpChannel() && isSessionActive()) {
    settingsRevision++
    useMcpStore.setState({ settings, channel })
  }
  return settings
}

export async function clearPersonalMcp(): Promise<void> {
  const channel = nativePersonalMcpChannel()
  await bridge('clear')
  if (channel === nativePersonalMcpChannel() && isSessionActive()) {
    settingsRevision++
    useMcpStore.setState({ settings: null, channel })
  }
}

export async function lookupPersonalMcp(query: string): Promise<McpSource[]> {
  const { sources } = object(await bridge('lookup', { query }))
  const result = normalizeMcpSources(sources)
  if (!result.length) {
    throw new Error('资料库没有返回可以引用的结果。')
  }
  return result
}

export async function listPersonalMcpTools(): Promise<McpActionTool[]> {
  const settings = getPersonalMcpSettings()
  if (!settings?.endpoint) {throw new Error('请先保存 MCP 服务。')}
  const { tools } = object(await bridge('tools'))
  if (settings !== getPersonalMcpSettings() || !isSessionActive()) {
    throw new Error('MCP 服务已变化，请重新打开工具列表。')
  }
  if (!Array.isArray(tools) || tools.length > 50) {
    throw new Error('App 返回的 MCP 工具列表无效。')
  }
  return tools.map((item: unknown) => {
    const { name, title, description, inputSchema, readOnly, revision } = object(item)
    const schema = object(inputSchema)
    if (typeof name !== 'string' || !toolNamePattern.test(name) ||
        typeof title !== 'string' || typeof description !== 'string' || typeof readOnly !== 'boolean' ||
        typeof revision !== 'string' || !/^[a-f0-9]{64}$/i.test(revision) || schema.type !== 'object') {
      throw new Error('App 返回的 MCP 工具定义无效。')
    }
    return { name, title: title || name, description, inputSchema: schema, readOnly, revision }
  })
}

export async function invokePersonalMcpTool(
  endpoint: string,
  tool: McpActionTool,
  args: Record<string, unknown>,
): Promise<McpActionResult> {
  if (!endpoint || getPersonalMcpSettings()?.endpoint !== endpoint) {
    throw new Error('MCP 服务已变化，请重新选择工具。')
  }
  if (new TextEncoder().encode(JSON.stringify(args)).byteLength > MAX_MCP_ARGUMENT_BYTES) {
    throw new Error('MCP 参数过长，请缩短后再运行。')
  }
  const uncertain: McpActionResult = { status: 'uncertain', text: '', truncated: false }
  let value: unknown
  try {
    value = await bridge('invoke', { endpoint, toolName: tool.name, revision: tool.revision, arguments: args })
  } catch (error) {
    if (error instanceof NativeMcpInvocationInterrupted) {return uncertain}
    throw error
  }
  try {
    const { status, text, truncated } = object(value)
    if ((status === 'success' || status === 'tool_error' || status === 'uncertain') &&
        typeof text === 'string' && typeof truncated === 'boolean') {
      return { status, text, truncated }
    }
  } catch {
    // The tool may have run even when its receipt cannot be read.
  }
  return uncertain
}
