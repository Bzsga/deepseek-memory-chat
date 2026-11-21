import { providerApiUrl } from '../providerEndpoint.js'
import { ApiError } from './ApiError.js'
import { readServerSentEvents } from './sse.js'
import type { CreateMessageRequest, MessageStreamEvent, MessageUsage, StopReason } from './types.js'

function compatibleMessages(body: CreateMessageRequest) {
  if (body.tools?.some((tool) => tool.type === 'deepseek_web_search')) {
    throw new ApiError(
      'protocol',
      '自定义聊天服务不支持 DeepSeek 联网搜索，请关闭搜索后重试。',
      undefined,
      'personal_feature'
    )
  }
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = []
  if (body.system) {
    messages.push({ role: 'system', content: body.system })
  }
  let reminder = ''
  for (const message of body.messages) {
    if (message.role === 'latest_reminder') {
      reminder = message.content
      continue
    }
    if (
      message.content instanceof Array &&
      message.content.some((part) => part.type === 'image' || part.type === 'document')
    ) {
      throw new ApiError(
        'protocol',
        '自定义聊天服务不支持 DeepSeek 文件引用，请使用纯文字消息。',
        undefined,
        'personal_feature'
      )
    }
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
    if (message.role === 'user') {
      messages.push({ role: 'user', content: reminder ? `${reminder}\n\n${text}` : text })
      reminder = ''
    } else if (text) {
      messages.push({ role: 'assistant', content: text })
    }
  }
  if (messages.at(-1)?.role === 'assistant') {
    messages.push({
      role: 'user',
      content: 'Continue the preceding assistant response from where it stopped.',
    })
  }
  return messages
}
const invalidStream = () =>
  new ApiError('protocol', '兼容聊天服务返回了无法读取的流式数据。', undefined, 'personal_protocol')
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const tokenCount = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0

export async function* streamCompatibleChat(
  baseUrl: string,
  model: string,
  key: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const url = providerApiUrl(baseUrl, 'chat/completions')
  const messages = compatibleMessages(body)
  signal.throwIfAborted()
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(body.output_config ? { reasoning_effort: body.output_config.effort } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      }),
    })
  } catch {
    signal.throwIfAborted()
    throw new ApiError(
      'network',
      '无法连接兼容聊天服务，请检查 Base URL 和该服务的跨域设置。',
      undefined,
      'personal_network'
    )
  }
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')
  ) {
    await response.body?.cancel().catch(() => {})
    throw new ApiError(
      response.ok ? 'protocol' : 'http',
      response.ok
        ? '兼容服务未返回 SSE 数据流。'
        : `兼容聊天服务请求失败（HTTP ${response.status}）。`,
      response.status,
      response.status === 401 || response.status === 403 ? 'personal_auth' : 'personal_http'
    )
  }
  let started = false,
    done = false,
    index = -1
  let active: 'thinking' | 'text' | undefined,
    stop: StopReason | undefined,
    usage: MessageUsage | undefined
  for await (const frame of readServerSentEvents(response.body, signal)) {
    signal.throwIfAborted()
    if (frame.event === 'error') {
      throw new ApiError('stream', '兼容聊天服务在生成时返回错误。', undefined, 'personal_stream')
    }
    if (frame.data.trim() === '[DONE]') {
      done = true
      break
    }
    let chunk: unknown
    try {
      chunk = JSON.parse(frame.data)
    } catch {
      throw invalidStream()
    }
    if (!record(chunk)) {
      throw invalidStream()
    }
    if (chunk.error) {
      throw new ApiError('stream', '兼容聊天服务在生成时返回错误。', undefined, 'personal_stream')
    }
    if (!Array.isArray(chunk.choices)) {
      throw invalidStream()
    }
    if (record(chunk.usage)) {
      const cached = record(chunk.usage.prompt_tokens_details)
        ? tokenCount(chunk.usage.prompt_tokens_details.cached_tokens)
        : 0
      usage = {
        input_tokens: Math.max(0, tokenCount(chunk.usage.prompt_tokens) - cached),
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
        output_tokens: tokenCount(chunk.usage.completion_tokens),
      }
    }
    if (!chunk.choices.length) {
      continue
    }
    const choice = chunk.choices.find((c) => record(c) && (c.index === undefined || c.index === 0))
    if (!record(choice) || !record(choice.delta)) {
      throw invalidStream()
    }
    if (!started) {
      started = true
      yield {
        type: 'message_start',
        message: {
          id: typeof chunk.id === 'string' ? chunk.id : crypto.randomUUID(),
          model: typeof chunk.model === 'string' ? chunk.model : model,
        },
      }
    }
    const delta = choice.delta
    if (delta.tool_calls || delta.function_call) {
      throw new ApiError(
        'protocol',
        '兼容服务返回了不受支持的工具调用。',
        undefined,
        'personal_feature'
      )
    }
    for (const [kind, text] of [
      ['thinking', delta.reasoning_content ?? delta.reasoning],
      ['text', delta.content ?? delta.refusal],
    ] as const) {
      if (text == null || text === '') {
        continue
      }
      if (typeof text !== 'string' || stop) {
        throw invalidStream()
      }
      if (kind !== active) {
        if (active) {
          yield { type: 'content_block_stop', index }
        }
        active = kind
        index++
        yield {
          type: 'content_block_start',
          index,
          content_block:
            kind === 'thinking'
              ? { type: 'thinking', thinking: '', signature: '' }
              : { type: 'text', text: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index,
        delta:
          kind === 'thinking'
            ? { type: 'thinking_delta', thinking: text }
            : { type: 'text_delta', text },
      }
    }
    if (choice.finish_reason != null) {
      switch (choice.finish_reason) {
        case 'stop':
          stop = 'end_turn'
          break
        case 'length':
          stop = 'max_tokens'
          break
        case 'content_filter':
          stop = 'refusal'
          break
        default:
          throw invalidStream()
      }
    }
  }
  signal.throwIfAborted()
  if (!started || (!done && !stop)) {
    throw new ApiError(
      'interrupted',
      '兼容聊天服务的回复流已中断。',
      undefined,
      'personal_interrupted'
    )
  }
  if (active) {
    yield { type: 'content_block_stop', index }
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: stop ?? 'end_turn', stop_sequence: null },
    ...(usage ? { usage } : {}),
  }
  yield { type: 'message_stop' }
}
