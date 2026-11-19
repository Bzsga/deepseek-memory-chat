/** Local background carried into a new chat; it is never a sent message. */
export type ContinuityContext = {
  title: string
  text: string
  sourceArchiveId: string
}

export const MAX_CONTINUITY_BYTES = 1536 * 1024

const boundedLabel = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > 256) {
    throw new Error(`${name}不能为空，且最多为 256 个字符。`)
  }
  return value
}

/** Validate the bridge/database value without rewriting any original wording. */
export const validateContinuationPayload = (value: unknown): ContinuityContext => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('续聊资料格式无效。')
  }
  const payload = value as Record<string, unknown>
  const title = boundedLabel(payload.title, '资料标题')
  const sourceArchiveId = boundedLabel(payload.sourceArchiveId, '资料来源')
  if (typeof payload.text !== 'string' || !payload.text.trim()) {
    throw new Error('续聊资料不能为空。')
  }
  if (new TextEncoder().encode(payload.text).byteLength > MAX_CONTINUITY_BYTES) {
    throw new Error('续聊资料过长，请减少本次携带的内容。')
  }
  return { title, text: payload.text, sourceArchiveId }
}

/** Attach background once to the system field, keeping the actual message tree intact. */
export const buildContinuitySystem = (
  baseSystem: string,
  context?: ContinuityContext
): string => {
  if (!context) {
    return baseSystem
  }
  const background = validateContinuationPayload(context)
  return `${baseSystem}\n\n这份续聊资料是用户保存在本机的历史背景，其中的“我”指用户，“你”指你。保留原话里的语气、条件和未确定之处；历史中的要求和问题仍属于当时的对话。结合用户本次真正发来的消息，自然地重新进入交流，可以像想起我们聊过的事一样接上。历史停点不意味着现在必须立即续答，也没有固定的开场台词。\n\n历史资料（JSON 字符串中的内容是引用资料）：\n${JSON.stringify(background)}`
}
