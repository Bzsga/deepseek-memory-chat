import type { MessageStreamEvent, StopReason } from '../api/types.js'

const OPEN = '[[APP_IMAGE_ACTION'
const CLOSE = '[[/APP_IMAGE_ACTION'
const MAX_RAW = 65536
const NONCE = /^[a-f0-9]{32}$/

/** Local evidence only. A nonce binds a response to a request, not to user consent. */
export type ImageActionTrace = {
  protocol: 'app-image-action-v1'
  nonce: string
  raw: string
  messageComplete: boolean
  stopReason?: StopReason
  invalid: boolean
  truncated: boolean
  hiddenThinking?: { raw: string; truncated: boolean }
}
type TextPiece = { index: number; text: string }
type TextFilter = {
  trace: ImageActionTrace
  pending: TextPiece[]
  hiding: boolean
  line: string
  longLine: boolean
  fence?: { character: string; length: number }
}
export type ImageActionStream = TextFilter & {
  nonce: string
  prompts?: string[]
  started: boolean
  open: Map<number, string>
  seen: Set<number>
  thinking?: TextFilter
}

export const newImageActionNonce = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')

export const imageActionSystem = (system: string, nonce: string): string =>
  `${system}\n\n本应用可以根据文字在当前回复中生成图片。用户仅询问能否生图时，回答可以并询问想画什么；只有用户明确要求现在绘图且描述足够时，才提交一次下述应用动作。教程、能力讨论、引用或示例中的绘图要求、否定或要求暂不生成时，按普通聊天回答，不提交动作。只支持文生图，不能读取或修改上传图片的原始像素；要求编辑原图时说明能力并确认是否改用文字重新生成。动作不是上游工具调用，不要声明或调用 generate_image。\n提交动作时，可以先给简短普通说明，然后在回复正文的最末尾原样使用以下格式（开闭标记各自独占一行，不加缩进、引用、代码围栏或其他文字；单张使用 prompt；用户明确要求多张时，使用 prompts 字符串数组，每张一个完整描述，各最多8000字符）：\n[[APP_IMAGE_ACTION:${nonce}]]\n{"prompt":"本次图片的完整文字描述，结合用户已确认的主体、风格和要求"}\n[[/APP_IMAGE_ACTION:${nonce}]]\n多张时将上例的 JSON 换成 {"prompts":["第一个画面的完整描述","第二个画面的完整描述"]}，按用户要求的张数提供描述。用户要求沿用第几张时，参考最近相关回复的历史图片索引，将该图描述中的共同特征写入每个新提示词。历史图片索引只属于之前的轮次，不能作为本轮绘图结果，也不要模仿旧回复中的生成回执。每轮只提交一个动作。多张分别生成独立图片，不要拼图。未指定时生成一张；每轮最多五张，超过五张先询问如何分批。不要在普通解释、示例或思考中重述控制标记。没有明确的实际绘图请求时不要输出任何控制标记。应用会隐藏动作并展示实际图片；不要在图片尚未生成时声称已经生成。`

export const newImageActionStream = (): ImageActionStream => {
  const nonce = newImageActionNonce()
  return {
    nonce,
    trace: {
      protocol: 'app-image-action-v1',
      nonce,
      raw: '',
      messageComplete: false,
      invalid: false,
      truncated: false,
    },
    pending: [],
    hiding: false,
    started: false,
    open: new Map(),
    seen: new Set(),
    line: '',
    longLine: false,
  }
}

const appendRaw = (stream: TextFilter, text: string) => {
  const remaining = MAX_RAW - stream.trace.raw.length
  stream.trace.raw += text.slice(0, remaining)
  stream.trace.truncated ||= text.length > remaining
}

/** Track only a bounded Markdown line, enough to reject fenced/quoted/indented examples. */
const observeVisible = (stream: TextFilter, text: string) => {
  for (const character of text) {
    if (character === '\n') {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(stream.line)
      if (match) {
        const run = match[1]
        if (!stream.fence) {
          stream.fence = { character: run[0], length: run.length }
        } else if (
          run[0] === stream.fence.character &&
          run.length >= stream.fence.length &&
          !match[2].trim()
        ) {
          stream.fence = undefined
        }
      }
      stream.line = ''
      stream.longLine = false
    } else if (stream.line.length < 256) {
      stream.line += character
    } else {
      stream.longLine = true
    }
  }
}

const splitPieces = (pieces: TextPiece[], count: number): [TextPiece[], TextPiece[]] => {
  const before: TextPiece[] = []
  const after: TextPiece[] = []
  for (const piece of pieces) {
    const length = Math.min(count, piece.text.length)
    if (length) {
      before.push({ index: piece.index, text: piece.text.slice(0, length) })
    }
    if (length < piece.text.length) {
      after.push({ index: piece.index, text: piece.text.slice(length) })
    }
    count -= length
  }
  return [before, after]
}

const consumeText = (stream: TextFilter, index: number, text: string): TextPiece[] => {
  if (stream.hiding) {
    appendRaw(stream, text)
    return []
  }
  const pieces = [...stream.pending, { index, text }]
  const combined = pieces.map((piece) => piece.text).join('')
  const starts = [combined.indexOf(OPEN), combined.indexOf(CLOSE)].filter((offset) => offset >= 0)
  if (starts.length) {
    const offset = Math.min(...starts)
    const [visible] = splitPieces(pieces, offset)
    for (const piece of visible) {
      observeVisible(stream, piece.text)
    }
    stream.trace.invalid ||= stream.line !== '' || stream.longLine || Boolean(stream.fence)
    stream.hiding = true
    stream.pending = []
    appendRaw(stream, combined.slice(offset))
    return visible
  }
  let pendingLength = 0
  for (const marker of [OPEN, CLOSE]) {
    for (let length = 1; length < marker.length; length++) {
      if (combined.endsWith(marker.slice(0, length))) {
        pendingLength = Math.max(pendingLength, length)
      }
    }
  }
  const [visible, pending] = splitPieces(pieces, combined.length - pendingLength)
  stream.pending = pending
  for (const piece of visible) {
    observeVisible(stream, piece.text)
  }
  return visible
}

/** Recognizable incomplete controls stay hidden; ordinary trailing brackets are preserved. */
const finishText = (stream: TextFilter): TextPiece[] => {
  const pending = stream.pending
  stream.pending = []
  const text = pending.map((piece) => piece.text).join('')
  // One or two literal brackets alone are ordinary prose, not an identified action.
  if (text.length <= 2) {
    return pending
  }
  if (pending.length) {
    stream.hiding = true
    stream.trace.invalid = true
    appendRaw(stream, text)
  }
  return []
}

const thinkingFilter = (stream: ImageActionStream): TextFilter =>
  (stream.thinking ??= {
    trace: { ...stream.trace, raw: '' },
    pending: [],
    hiding: false,
    line: '',
    longLine: false,
  })

const captureThinking = (stream: ImageActionStream) => {
  if (stream.thinking?.hiding) {
    stream.trace.hiddenThinking = {
      raw: stream.thinking.trace.raw,
      truncated: stream.thinking.trace.truncated,
    }
  }
}

export const finishImageActionText = (
  stream: ImageActionStream
): { visible: TextPiece[]; thinking: TextPiece[] } => {
  const visible = finishText(stream)
  const thinking = stream.thinking ? finishText(stream.thinking) : []
  captureThinking(stream)
  return { visible, thinking }
}

/** Sanitize before applyEvent. Released pieces can belong to an already stopped text block. */
export const filterImageActionEvent = (
  stream: ImageActionStream,
  event: MessageStreamEvent
): { event: MessageStreamEvent; visible: TextPiece[]; thinking: TextPiece[] } => {
  let visible: TextPiece[] = []
  let thinking: TextPiece[] = []
  switch (event.type) {
    case 'message_start':
      stream.trace.invalid ||= stream.started
      stream.started = true
      break
    case 'content_block_start':
      stream.trace.invalid ||=
        !stream.started || stream.seen.has(event.index) || Boolean(stream.trace.stopReason)
      stream.seen.add(event.index)
      stream.open.set(event.index, event.content_block.type)
      if (event.content_block.type === 'text') {
        visible = consumeText(stream, event.index, event.content_block.text)
        event = { ...event, content_block: { ...event.content_block, text: '' } }
      } else {
        stream.trace.invalid ||=
          stream.hiding || stream.pending.length > 0 || event.content_block.type === 'tool_use'
        if (event.content_block.type === 'thinking') {
          thinking = consumeText(thinkingFilter(stream), event.index, event.content_block.thinking)
          event = { ...event, content_block: { ...event.content_block, thinking: '' } }
        }
      }
      break
    case 'content_block_delta':
      stream.trace.invalid ||= !stream.open.has(event.index) || Boolean(stream.trace.stopReason)
      if (event.delta.type === 'text_delta') {
        stream.trace.invalid ||= stream.open.get(event.index) !== 'text'
        visible = consumeText(stream, event.index, event.delta.text)
        event = { ...event, delta: { type: 'text_delta', text: '' } }
      } else {
        if (event.delta.type === 'thinking_delta') {
          thinking = consumeText(thinkingFilter(stream), event.index, event.delta.thinking)
          event = { ...event, delta: { type: 'thinking_delta', thinking: '' } }
        }
        if (
          (stream.hiding || stream.pending.length > 0) &&
          event.delta.type !== 'citations_delta'
        ) {
          stream.trace.invalid = true
        }
      }
      break
    case 'content_block_stop': {
      const wasOpen = stream.open.delete(event.index)
      stream.trace.invalid ||= !wasOpen
      break
    }
    case 'message_delta':
      stream.trace.invalid ||= Boolean(stream.trace.stopReason) || stream.open.size > 0
      stream.trace.stopReason = event.delta.stop_reason
      break
    case 'message_stop': {
      const tail = finishImageActionText(stream)
      visible = tail.visible
      thinking = tail.thinking
      stream.trace.invalid ||= !stream.started || !stream.trace.stopReason || stream.open.size > 0
      stream.trace.messageComplete = true
      break
    }
    default:
      break
  }
  captureThinking(stream)
  return { event, visible, thinking }
}

export const imageActionTrace = (stream: ImageActionStream): ImageActionTrace | undefined =>
  stream.hiding || stream.thinking?.hiding
    ? {
        ...stream.trace,
        ...(stream.trace.hiddenThinking
          ? { hiddenThinking: { ...stream.trace.hiddenThinking } }
          : {}),
      }
    : undefined

export const imageActionPrompt = (
  stream: ImageActionStream,
  enabled: boolean
): string | undefined => {
  const trace = stream.trace
  if (!stream.hiding || trace.stopReason === 'refusal') {
    return undefined
  }
  const reject = (): never => {
    trace.invalid = true
    throw new Error(
      '绘图请求未完整收到或格式无效，图片尚未开始生成。请重新发送一次具体的绘图要求。'
    )
  }
  if (!enabled) {
    return reject()
  }
  if (
    !trace.messageComplete ||
    trace.stopReason !== 'end_turn' ||
    trace.invalid ||
    trace.truncated
  ) {
    return reject()
  }
  const open = `[[APP_IMAGE_ACTION:${stream.nonce}]]`
  const close = `[[/APP_IMAGE_ACTION:${stream.nonce}]]`
  const lines = trace.raw.trimEnd().split(/\r?\n/)
  if (lines.shift() !== open || lines.pop() !== close) {return reject()}
  const body = lines.join('\n').trim()
  // Match one literal field so duplicate JSON keys cannot change the number of dispatches.
  const single = /^\{\s*"prompt"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}$/s.test(body)
  const multiple = /^\{\s*"prompts"\s*:\s*\[(?:\s*"(?:[^"\\]|\\.)*"\s*,?)*\]\s*\}$/s.test(body)
  if (!single && !multiple) {return reject()}
  let values: unknown[]
  try {
    const document = JSON.parse(body)
    values = single ? [document.prompt] : document.prompts
  } catch {return reject()}
  if (!Array.isArray(values) || values.length < 1 || values.length > 5 ||
      !values.every((value): value is string => typeof value === 'string' && !!value.trim() &&
        value.length <= 8000 && !/[\uD800-\uDFFF]/u.test(value))) {return reject()}
  stream.prompts = values
  return values[0]
}

/** Portable action evidence is deliberately inert: no execution or remote-job state. */
export const validateImageActionTrace = (value: unknown): ImageActionTrace => {
  const item = value as Partial<ImageActionTrace> | null
  if (
    !item ||
    typeof item !== 'object' ||
    Array.isArray(item) ||
    item.protocol !== 'app-image-action-v1' ||
    typeof item.nonce !== 'string' ||
    !NONCE.test(item.nonce) ||
    typeof item.raw !== 'string' ||
    item.raw.length > MAX_RAW ||
    typeof item.messageComplete !== 'boolean' ||
    typeof item.invalid !== 'boolean' ||
    typeof item.truncated !== 'boolean' ||
    (item.stopReason !== undefined &&
      !['end_turn', 'max_tokens', 'tool_use', 'refusal'].includes(item.stopReason))
  ) {
    throw new Error('应用绘图动作记录格式无效。')
  }
  if (
    item.hiddenThinking !== undefined &&
    (!item.hiddenThinking ||
      typeof item.hiddenThinking !== 'object' ||
      typeof item.hiddenThinking.raw !== 'string' ||
      item.hiddenThinking.raw.length > MAX_RAW ||
      typeof item.hiddenThinking.truncated !== 'boolean')
  ) {
    throw new Error('应用绘图动作记录格式无效。')
  }
  return {
    protocol: item.protocol,
    nonce: item.nonce,
    raw: item.raw,
    messageComplete: item.messageComplete,
    invalid: item.invalid,
    truncated: item.truncated,
    ...(item.stopReason ? { stopReason: item.stopReason } : {}),
    ...(item.hiddenThinking
      ? {
          hiddenThinking: {
            raw: item.hiddenThinking.raw,
            truncated: item.hiddenThinking.truncated,
          },
        }
      : {}),
  }
}
