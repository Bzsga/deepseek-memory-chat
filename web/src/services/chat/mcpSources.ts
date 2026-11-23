export type McpSource = { title: string; url: string; text: string }

const isSourceText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length <= maximum && !!value.trim() &&
  !/[\uD800-\uDFFF]/u.test(value)

const isSourceUrl = (value: unknown): value is string => {
  if (!isSourceText(value, 2048) || !/^https?:\/\/[^/@?#]+(?:[/?#]|$)/iu.test(value) || /[\s\\\p{Cc}]/u.test(value)) {
    return false
  }
  try {
    const url = new URL(value)
    return !url.username && !url.password
  } catch {
    return false
  }
}

export const normalizeMcpSources = (value: unknown): McpSource[] => {
  if (!Array.isArray(value)) {return []}
  const sources: McpSource[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {continue}
    const { title, url, text } = item as Record<string, unknown>
    if (!isSourceText(title, 240) || !isSourceUrl(url) || !isSourceText(text, 1600)) {continue}
    sources.push({ title, url, text })
    if (sources.length === 5) {break}
  }
  return sources
}
