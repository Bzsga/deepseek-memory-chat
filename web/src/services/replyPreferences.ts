export const MAX_PERSONA_LENGTH = 2000
export const effortOptions = ['', 'low', 'medium', 'high', 'max'] as const
export type ReasoningEffort = (typeof effortOptions)[number]
export type ReplyPreferences = {
  persona: string
  reasoningEffort: ReasoningEffort
  temperature: string
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
