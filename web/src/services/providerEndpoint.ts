export const OFFICIAL_BASE = 'https://api.deepseek.com'
export const DEFAULT_CHAT_MODEL = 'deepseek-flash'
export type PersonalEndpoint = { baseUrl: string; model: string }
export function normalizeProviderBase(input: string): string {
  const text = input.trim() || OFFICIAL_BASE
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('请填写有效的 HTTPS Base URL。')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    text.length > 2048
  ) {
    throw new Error('Base URL 须为 HTTPS 地址，且不能含凭据、查询参数或片段。')
  }
  const base = url.href.replace(/\/+$/, '')
  return base === OFFICIAL_BASE + '/v1' ? OFFICIAL_BASE : base
}
export function providerApiUrl(base: string, path: string): string {
  const address = normalizeProviderBase(base)
  return address + (new URL(address).pathname === '/' ? '/v1/' : '/') + path
}
export function personalEndpoint(baseUrl = '', model = ''): PersonalEndpoint {
  const id = model.trim() || DEFAULT_CHAT_MODEL
  if (id.length > 256 || /[\p{Cc}]/u.test(id)) {
    throw new Error('模型名称无效。')
  }
  return { baseUrl: normalizeProviderBase(baseUrl), model: id }
}
export async function fetchProviderModels(
  base: string,
  key: string,
  signal?: AbortSignal
): Promise<string[]> {
  if (!key.trim()) {
    throw new Error('请先填写 API Key。')
  }
  const response = await fetch(providerApiUrl(base, 'models'), {
    method: 'GET',
    headers: { Authorization: `Bearer ${key.trim()}` },
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal,
  })
  if (!response.ok) {
    throw new Error(`获取模型列表失败（HTTP ${response.status}）。`)
  }
  return readProviderModels(await response.json())
}

export function readProviderModels(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) {
    throw new Error('服务未返回兼容的模型列表。')
  }
  const ids = new Set<string>()
  for (const entry of payload.data) {
    if (
      typeof entry?.id === 'string' &&
      entry.id.trim() &&
      entry.id.length <= 256 &&
      !/[\p{Cc}]/u.test(entry.id)
    ) {
      ids.add(entry.id)
    }
  }
  return [...ids].sort()
}
