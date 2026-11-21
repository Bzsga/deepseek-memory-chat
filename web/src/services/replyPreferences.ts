export const MAX_PERSONA_LENGTH = 2000
export const replyToneOptions = ['default', 'direct', 'warm', 'structured', 'casual', 'custom'] as const
export type ReplyTone = (typeof replyToneOptions)[number]
export const replyDetailOptions = ['default', 'brief', 'balanced', 'deep'] as const
export type ReplyDetail = (typeof replyDetailOptions)[number]
export const replyApproachOptions = ['default', 'direct', 'compare', 'explore'] as const
export type ReplyApproach = (typeof replyApproachOptions)[number]
export const replyTuningNames = ['replyWarmth', 'replyEnthusiasm', 'replyEmojis', 'replyVisuals', 'replyStructure'] as const
export type ReplyTuningName = (typeof replyTuningNames)[number]
export const replyTuningOptions = ['default', 'less', 'more'] as const
export type ReplyTuning = (typeof replyTuningOptions)[number]
export const defaultReplyTuning: Record<ReplyTuningName, ReplyTuning> = {
  replyWarmth: 'default',
  replyEnthusiasm: 'default',
  replyEmojis: 'default',
  replyVisuals: 'default',
  replyStructure: 'default',
}
export const effortOptions = ['', 'low', 'medium', 'high', 'max'] as const
export type ReasoningEffort = (typeof effortOptions)[number]
export type ReplyPreferences = {
  replyTone: ReplyTone
  replyDetail: ReplyDetail
  replyApproach: ReplyApproach
  persona: string
  reasoningEffort: ReasoningEffort
  temperature: string
} & Record<ReplyTuningName, ReplyTuning>

const tonePrompts: Record<Exclude<ReplyTone, 'custom'>, string> = {
  default: '',
  direct: '先给结论或直接回答问题。用简明的句子，只展开理解结论所需的理由、步骤和例外。',
  warm: '用温和、自然的语气回应。在用户表达感受时先回应具体处境，再给建议。普通问题保持自然，避免套话和过度安慰。',
  structured: '把判断依据和要点组织清楚。复杂问题按需要分段、列步骤或比较取舍，简单问题直接回答。',
  casual: '用轻松、随和的口语表达，像日常聊天一样自然。可以用简短的比喻或例子，语气随话题的严肃程度调整。',
}

const detailPrompts: Record<ReplyDetail, string> = {
  default: '',
  brief: '简短作答，保留关键结论和必要条件。',
  balanced: '给出结论和主要依据，按问题复杂度调整篇幅，必要时补充可执行的步骤。',
  deep: '展开关键依据、前提、取舍和例外。优先解释会改变判断的细节，必要时举例。',
}

const approachPrompts: Record<ReplyApproach, string> = {
  default: '',
  direct: '当用户寻求建议时，先给出明确建议，再说明关键理由和适用条件。',
  compare: '当问题涉及选择时，比较可行选项与主要取舍，说明什么条件会改变判断。有足够依据时给出倾向。',
  explore: '在开放性问题中，先梳理用户的目标、约束和可选方向。只有缺少会改变结论的信息时才提出简短问题。',
}

const tuningPrompts: Record<ReplyTuningName, Record<Exclude<ReplyTuning, 'default'>, string>> = {
  replyWarmth: {
    less: '保持礼貌和分寸，减少寒暄和亲昵表达。',
    more: '语气亲切体贴，自然地回应用户的具体处境或感受。',
  },
  replyEnthusiasm: {
    less: '语气平静克制，少用感叹和夸张的肯定。',
    more: '在合适的场合更有热情和活力，对用户的尝试给出具体回应。',
  },
  replyEmojis: {
    less: '尽量少用表情符号。',
    more: '在轻松话题中适度使用表情符号。',
  },
  replyVisuals: {
    less: '优先用文字解释，减少额外的表格和图示。',
    more: '在有助于理解关系、流程或比较时，主动使用 Markdown 表格或 Mermaid 图示。',
  },
  replyStructure: {
    less: '优先用自然段，减少不必要的标题和列表。',
    more: '在较长或复杂的回答中用短标题和列表组织要点。',
  },
}

export const isReplyTone = (value: unknown): value is ReplyTone =>
  replyToneOptions.some((tone) => tone === value)
export const isReplyDetail = (value: unknown): value is ReplyDetail =>
  replyDetailOptions.some((detail) => detail === value)
export const isReplyApproach = (value: unknown): value is ReplyApproach =>
  replyApproachOptions.some((approach) => approach === value)
export const isReplyTuning = (value: unknown): value is ReplyTuning =>
  replyTuningOptions.some((tuning) => tuning === value)
export const legacyReplyTone = (persona: string): ReplyTone => persona.trim() ? 'custom' : 'default'
export const replyStylePrompt = (preferences: Pick<ReplyPreferences,
  'replyTone' | 'replyDetail' | 'replyApproach' | 'persona' | ReplyTuningName>) => {
  const { replyTone, replyDetail, replyApproach, persona } = preferences
  const base = replyTone === 'custom' ? persona.trim() : tonePrompts[replyTone]
  const tuning = replyTuningNames.flatMap((name) => {
    const value = preferences[name]
    return value === 'default' ? [] : [tuningPrompts[name][value]]
  })
  const selected = [detailPrompts[replyDetail], approachPrompts[replyApproach], ...tuning].filter(Boolean)
  if (selected.length === 0) {
    return base
  }
  const rules = ['按话题和用户本轮要求应用以下偏好。同一方面优先采用这些明确设置。', ...selected]
  return base ? `${base}\n\n${rules.join('\n')}` : rules.join('\n')
}

export const isEffort = (value: unknown): value is ReasoningEffort =>
  effortOptions.some((e) => e === value)
export const isTemperature = (value: unknown): value is string =>
  typeof value === 'string' &&
  (value === '' || (/^\d(?:\.\d{1,2})?$/u.test(value) && Number(value) <= 2))

export const modelParameters = (
  preferences: Pick<ReplyPreferences, 'reasoningEffort' | 'temperature'>,
  thinking: boolean
) => ({
  ...(thinking && preferences.reasoningEffort
    ? { output_config: { effort: preferences.reasoningEffort } }
    : {}),
  ...(!thinking && preferences.temperature !== ''
    ? { temperature: Number(preferences.temperature) }
    : {}),
})
