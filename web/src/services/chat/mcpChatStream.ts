import { ApiError } from '../api/ApiError.js'
import type {
  AssistantBlockParam, ClientMessageTool, CreateMessageRequest, MessageStreamEvent, MessageUsage,
  OutputBlockStart, ToolResultBlockParam, ToolUseBlockParam,
} from '../api/types.js'
import { MAX_MCP_ARGUMENT_BYTES, type McpActionTool } from '../personalMcp.js'

export type McpChatInvocation = { id: string; tool: McpActionTool; args: Record<string, unknown> }
export type McpChatOutcome = {
  status: 'success' | 'tool_error' | 'uncertain' | 'rejected'
  text: string
  truncated: boolean
}

type McpChatOptions = {
  body: CreateMessageRequest
  tools: McpActionTool[]
  signal: AbortSignal
  live: () => boolean
  open: (body: CreateMessageRequest) => AsyncIterable<MessageStreamEvent>
  run: (call: McpChatInvocation) => Promise<McpChatOutcome>
}

type FinalEvent = Extract<MessageStreamEvent, { type: 'message_delta' }>
type OpenBlock = { value: OutputBlockStart; visibleIndex?: number; inputJson: string; ended: boolean }
type Round = { final: FinalEvent; content: AssistantBlockParam[]; calls: McpChatInvocation[] }

const MAX_CALLS = 3
const MAX_BLOCKS = 2048
const MAX_REPLAY_CHARS = 2 * 1024 * 1024
const MAX_RESULT_CHARS = 12_000
const TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,128}$/
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function protocolError(detail = 'MCP 工具调用未完整返回。'): never {
  throw new ApiError('protocol', detail, undefined, 'personal_mcp_protocol')
}

const jsonValueIsBounded = (value: unknown, depth: number): boolean => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))
  }
  if (Array.isArray(value)) {
    return depth > 0 && value.every((item: unknown) => jsonValueIsBounded(item, depth - 1))
  }
  if (isObject(value)) {
    return depth > 0 && Object.values(value).every((item) => jsonValueIsBounded(item, depth - 1))
  }
  return value === null || typeof value === 'string' || typeof value === 'boolean'
}

function readArguments(input: unknown, inputJson: string): Record<string, unknown> {
  if (!isObject(input)) {return protocolError('MCP 工具参数必须是 JSON 对象。')}
  if (inputJson) {
    if (Object.keys(input).length || new TextEncoder().encode(inputJson).byteLength > MAX_MCP_ARGUMENT_BYTES) {
      return protocolError('MCP 工具参数无效或过长。')
    }
    try {
      input = JSON.parse(inputJson) as unknown
    } catch {
      return protocolError('MCP 工具参数不是完整的 JSON。')
    }
  }
  if (!isObject(input) || !jsonValueIsBounded(input, 32) ||
      new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_MCP_ARGUMENT_BYTES) {
    return protocolError('MCP 工具参数无效或过长。')
  }
  return input
}

function modelTools(tools: McpActionTool[]) {
  const catalog = new Map<string, McpActionTool>()
  const definitions: ClientMessageTool[] = tools.map((tool, index) => {
    // MCP accepts dots and longer names. A per-request prefix also prevents collisions.
    const name = `mcp_${index + 1}_${tool.name.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64)
    catalog.set(name, tool)
    return { name, description: tool.description, input_schema: tool.inputSchema }
  })
  return { definitions, catalog }
}

function sumUsage(left?: MessageUsage, right?: MessageUsage): MessageUsage | undefined {
  if (!left || !right) {return left ?? right}
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    cache_creation_input_tokens: left.cache_creation_input_tokens + right.cache_creation_input_tokens,
    cache_read_input_tokens: left.cache_read_input_tokens + right.cache_read_input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    ...(left.server_tool_use || right.server_tool_use ? {
      server_tool_use: {
        web_search_requests: (left.server_tool_use?.web_search_requests ?? 0) +
          (right.server_tool_use?.web_search_requests ?? 0),
        tool_search: (left.server_tool_use?.tool_search ?? 0) + (right.server_tool_use?.tool_search ?? 0),
      },
    } : {}),
  }
}

function applyDelta(block: OpenBlock, delta: Extract<MessageStreamEvent, { type: 'content_block_delta' }>['delta']) {
  const { value } = block
  switch (delta.type) {
    case 'input_json_delta':
      if (value.type !== 'tool_use') {return protocolError()}
      if (block.inputJson.length + delta.partial_json.length > MAX_MCP_ARGUMENT_BYTES) {
        return protocolError('MCP 工具参数过长。')
      }
      block.inputJson += delta.partial_json
      return delta.partial_json.length
    case 'text_delta':
      if (value.type !== 'text') {return protocolError()}
      block.value = { ...value, text: value.text + delta.text }
      return delta.text.length
    case 'thinking_delta':
      if (value.type !== 'thinking') {return protocolError()}
      block.value = { ...value, thinking: value.thinking + delta.thinking }
      return delta.thinking.length
    case 'signature_delta':
      if (value.type !== 'thinking') {return protocolError()}
      block.value = { ...value, signature: (value.signature ?? '') + delta.signature }
      return delta.signature.length
    case 'citations_delta':
      if (value.type !== 'text') {return protocolError()}
      block.value = { ...value, citations: [...(value.citations ?? []), delta.citation] }
      return JSON.stringify(delta.citation).length
  }
}

async function* readRound(
  events: AsyncIterable<MessageStreamEvent>,
  requireLive: () => void,
  allocateIndex: () => number,
  catalog?: Map<string, McpActionTool>,
): AsyncGenerator<MessageStreamEvent, Round> {
  const blocks = new Map<number, OpenBlock>()
  const calls = new Map<string, McpChatInvocation>()
  let startUsage: MessageUsage | undefined
  let final: FinalEvent | undefined
  let started = false
  let toolCount = 0
  let lastIndex = -1
  let replayChars = 0
  for await (const event of events) {
    requireLive()
    if (event.type === 'ping') {continue}
    if (event.type === 'message_start') {
      if (started) {return protocolError()}
      started = true
      startUsage = event.message.usage
      if (catalog) {yield event}
      continue
    }
    if (!started || (final && event.type !== 'message_stop')) {return protocolError()}
    switch (event.type) {
      case 'content_block_start': {
        if (!Number.isSafeInteger(event.index) || event.index <= lastIndex || blocks.size >= MAX_BLOCKS) {
          return protocolError()
        }
        lastIndex = event.index
        const value = event.content_block
        const clientTool = value.type === 'tool_use'
        if (clientTool && (!catalog || ++toolCount > MAX_CALLS)) {
          return protocolError('本轮回复的 MCP 工具调用超过上限。')
        }
        const visibleIndex = clientTool ? undefined : allocateIndex()
        blocks.set(event.index, { value, visibleIndex, inputJson: '', ended: false })
        if (catalog) {replayChars += JSON.stringify(value).length}
        if (visibleIndex !== undefined) {yield { ...event, index: visibleIndex }}
        break
      }
      case 'content_block_delta':
      case 'content_block_stop': {
        const block = blocks.get(event.index)
        if (!block || block.ended) {return protocolError()}
        if (event.type === 'content_block_delta') {
          if (catalog) {replayChars += applyDelta(block, event.delta)}
        } else {
          block.ended = true
          const value = block.value
          if (value.type === 'tool_use') {
            const tool = catalog?.get(value.name)
            if (!tool || typeof value.id !== 'string' || !TOOL_CALL_ID.test(value.id) || calls.has(value.id)) {
              return protocolError('MCP 工具名称或调用标识无效。')
            }
            const args = readArguments(value.input, block.inputJson)
            calls.set(value.id, { id: value.id, tool, args })
            block.value = { ...value, input: args }
          }
        }
        if (block.visibleIndex !== undefined) {yield { ...event, index: block.visibleIndex }}
        break
      }
      case 'message_delta':
        final = { ...event, usage: event.usage ?? startUsage }
        break
      case 'message_stop': {
        if (!final || [...blocks.values()].some((block) => !block.ended)) {return protocolError()}
        if (final.delta.stop_reason !== 'tool_use') {
          return { final, content: [], calls: [] }
        }
        if (!catalog || calls.size === 0 || calls.size !== toolCount) {return protocolError()}
        const content: AssistantBlockParam[] = []
        const orderedCalls: McpChatInvocation[] = []
        for (const { value } of blocks.values()) {
          if (value.type === 'tool_use') {
            const call = calls.get(value.id)
            if (!call) {return protocolError()}
            const replay: ToolUseBlockParam = { ...value, input: call.args }
            content.push(replay)
            orderedCalls.push(call)
          } else {
            content.push(value)
          }
        }
        return { final, content, calls: orderedCalls }
      }
    }
    if (replayChars > MAX_REPLAY_CHARS) {return protocolError('MCP 工具调用上下文过长。')}
  }
  throw new ApiError('interrupted', 'MCP 聊天响应未完整返回。', undefined, 'personal_mcp_interrupted')
}

function toolResult(id: string, outcome: McpChatOutcome): ToolResultBlockParam {
  const text = outcome.text.slice(0, MAX_RESULT_CHARS).replace(/[\uD800-\uDBFF]$/u, '')
  return {
    type: 'tool_result',
    tool_use_id: id,
    is_error: outcome.status !== 'success',
    // DeepSeek may ignore is_error. Preserve the outcome in the tool result itself.
    content: JSON.stringify({ status: outcome.status, text, truncated: outcome.truncated || text !== outcome.text }),
  }
}

export async function* streamMcpChat(options: McpChatOptions): AsyncGenerator<MessageStreamEvent> {
  const { body, tools, signal, live, open, run } = options
  function requireLive() {
    signal.throwIfAborted()
    if (!live()) {
      throw new ApiError('interrupted', '聊天状态已变化，MCP 工具调用已停止。', undefined, 'personal_mcp_context_changed')
    }
  }
  requireLive()
  if (!tools.length) {
    yield* open(body)
    return
  }

  const { definitions, catalog } = modelTools(tools)
  const firstRequest: CreateMessageRequest = {
    ...body,
    tools: [...body.tools, ...definitions],
    tool_choice: { type: 'auto' },
  }
  let nextIndex = 0
  const allocateIndex = () => nextIndex++
  const first = yield* readRound(open(firstRequest), requireLive, allocateIndex, catalog)
  requireLive()
  if (first.final.delta.stop_reason !== 'tool_use') {
    yield first.final
    yield { type: 'message_stop' }
    return
  }

  const results: ToolResultBlockParam[] = []
  for (const call of first.calls) {
    requireLive()
    const outcome = await run(call)
    requireLive()
    results.push(toolResult(call.id, outcome))
  }
  const followUp: CreateMessageRequest = {
    ...firstRequest,
    tool_choice: { type: 'none' },
    messages: [
      ...body.messages,
      { role: 'assistant', content: first.content },
      { role: 'user', content: results },
    ],
  }
  const answer = yield* readRound(open(followUp), requireLive, allocateIndex)
  requireLive()
  yield {
    ...answer.final,
    delta: { ...answer.final.delta, title: answer.final.delta.title || first.final.delta.title },
    usage: sumUsage(first.final.usage, answer.final.usage),
  }
  yield { type: 'message_stop' }
}
