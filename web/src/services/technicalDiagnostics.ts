import { nativeDiagnosticsAvailable, sendNative, subscribeNativeBridge } from './nativeBridge.js'

const AREAS = ['startup', 'webview', 'runtime', 'chat', 'image', 'import', 'attachment', 'account', 'sync', 'update', 'organization'] as const
const CODES = ['timeout', 'load_failed', 'http_error', 'network_error', 'crash', 'render_gone', 'invalid_response', 'operation_failed', 'storage_error', 'integrity_error', 'unexpected_error'] as const
const STAGES = ['initialize', 'navigate', 'document', 'render', 'request', 'response', 'download', 'verify', 'save', 'read', 'parse', 'upload', 'apply', 'install'] as const
export type DiagnosticArea = typeof AREAS[number]
export type DiagnosticCode = typeof CODES[number]
export type DiagnosticStage = typeof STAGES[number]
type DiagnosticPreference = 'unanswered' | 'enabled' | 'disabled'
type Facts = { stage?: DiagnosticStage; http_status?: number; elapsed_ms?: number; request_id?: string }
export type DiagnosticEvent = Facts & {
  event_id: string
  occurred_at: number
  source: 'web'
  release: string
  area: DiagnosticArea
  code: DiagnosticCode
}

const PREFIX = `deepseek-diagnostics:${encodeURIComponent(__API_ORIGIN__)}:`
const PREFERENCE_KEY = `${PREFIX}preference`
const EVENT_PREFIX = `${PREFIX}event:`
const LAST_SENT_KEY = `${PREFIX}last-sent`
const ENTRY_FAILURE_KEY = 'deepseek-startup-entry-failure'
const MAX_EVENTS = 32
const MAX_BATCH = 20
const RETENTION_SECONDS = 30 * 24 * 60 * 60
const POST_INTERVAL = 30_000
const RELEASE_PATTERN = /^[A-Za-z0-9._+-]{1,80}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const nowSeconds = () => Math.floor(Date.now() / 1000)

const subscribers = new Set<() => void>()
const memory = new Map<string, DiagnosticEvent>()
const recent = new Map<string, number>()
const bridgeEvents: DiagnosticEvent[] = []
let version = 0
let decision: DiagnosticPreference | undefined
let lastSent: DiagnosticEvent | undefined
let autoTimer: ReturnType<typeof setTimeout> | undefined
let autoRequest: AbortController | undefined
let lastAttempt = 0
let observersInstalled = false
let bridgeRunning = false
let firstRender = false
let readySent = false

export const nativeOwnsDiagnostics = () => /\bDeepSeekNativeDiagnostics\/1\b/.test(navigator.userAgent ?? '')
const emit = () => { version++; subscribers.forEach((listener) => listener()) }
export const diagnosticVersion = () => version
export const subscribeDiagnostics = (listener: () => void) => {
  subscribers.add(listener)
  return () => { subscribers.delete(listener) }
}

const stored = (key: string): string | null => {
  try { return localStorage.getItem(key) }
  catch { return null }
}

const store = (key: string, value: string) => {
  try { localStorage.setItem(key, value) }
  catch { /* This browser can still hold diagnostics until the page closes. */ }
}

const erase = (key: string) => {
  try { localStorage.removeItem(key) }
  catch { /* A storage error should not mask the original operation. */ }
}

export const diagnosticPreference = (): DiagnosticPreference => {
  if (nativeOwnsDiagnostics()) { return 'disabled' }
  const value = decision ?? stored(PREFERENCE_KEY)
  return value === 'enabled' || value === 'disabled' ? value : 'unanswered'
}

const stopAutoUpload = () => {
  clearTimeout(autoTimer)
  autoTimer = undefined
  autoRequest?.abort()
}

export const setDiagnosticPreference = (value: 'enabled' | 'disabled') => {
  if (nativeOwnsDiagnostics()) { return }
  decision = value
  store(PREFERENCE_KEY, value)
  if (value === 'disabled') { stopAutoUpload() }
  else { scheduleUpload() }
  emit()
}

export const safeRequestId = (response: Pick<Response, 'headers'>): string | undefined => {
  const value = response.headers.get('X-Request-ID')
  return value && UUID_PATTERN.test(value) ? value : undefined
}

const contains = <T extends string>(choices: readonly T[], input: unknown): input is T =>
  typeof input === 'string' && choices.includes(input as T)

const safeFacts = (value: Facts): Facts => {
  const { stage, http_status, elapsed_ms, request_id } = value
  return {
    ...(contains(STAGES, stage) ? { stage } : {}),
    ...(typeof http_status === 'number' && Number.isInteger(http_status) && http_status >= 100 && http_status <= 599 ? { http_status } : {}),
    ...(typeof elapsed_ms === 'number' && Number.isInteger(elapsed_ms) && elapsed_ms >= 0 && elapsed_ms <= 86_400_000 ? { elapsed_ms } : {}),
    ...(typeof request_id === 'string' && UUID_PATTERN.test(request_id) ? { request_id } : {}),
  }
}

const decodedEvent = (raw: string | null): DiagnosticEvent | undefined => {
  if (!raw || raw.length > 2048) { return }
  try {
    const item = JSON.parse(raw) as DiagnosticEvent | null
    if (!item || item.source !== 'web' || typeof item.event_id !== 'string' || !UUID_PATTERN.test(item.event_id) ||
        typeof item.release !== 'string' || !RELEASE_PATTERN.test(item.release) || !contains(AREAS, item.area) ||
        !contains(CODES, item.code) || !Number.isInteger(item.occurred_at) ||
        item.occurred_at < nowSeconds() - RETENTION_SECONDS || item.occurred_at > nowSeconds() + 300) { return }
    const { event_id, occurred_at, source, release, area, code } = item
    return { event_id, occurred_at, source, release, area, code, ...safeFacts(item) }
  } catch { return undefined }
}

const pendingEvents = () => {
  const items = new Map(memory)
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(EVENT_PREFIX)) { continue }
      const event = decodedEvent(stored(key))
      if (event && key === EVENT_PREFIX + event.event_id) { items.set(event.event_id, event) }
      else { erase(key) }
    }
  } catch { /* Memory-only storage remains usable. */ }
  const sorted = [...items.values()].filter(event => event.occurred_at >= nowSeconds() - RETENTION_SECONDS)
    .sort((a, b) => a.occurred_at - b.occurred_at)
  sorted.slice(0, Math.max(0, sorted.length - MAX_EVENTS)).forEach(event => {
    erase(EVENT_PREFIX + event.event_id)
    memory.delete(event.event_id)
  })
  return sorted.slice(-MAX_EVENTS)
}

export const latestDiagnostic = (): DiagnosticEvent | undefined => {
  if (nativeOwnsDiagnostics()) { return }
  const latest = pendingEvents().at(-1)
  const accepted = decodedEvent(stored(LAST_SENT_KEY)) ??
    (lastSent && lastSent.occurred_at >= nowSeconds() - RETENTION_SECONDS ? lastSent : undefined)
  return latest && (!accepted || latest.occurred_at >= accepted.occurred_at) ? latest : accepted
}

export const diagnosticWasSent = (id: string): boolean =>
  lastSent?.event_id === id || decodedEvent(stored(LAST_SENT_KEY))?.event_id === id

const buildRelease = () => {
  const declared = document.querySelector<HTMLMetaElement>('meta[name="application-version"]')?.content
  const hash = Array.from(document.scripts).map(script => /(?:^|\/)main\.([a-f0-9]{8,32})\.js$/.exec(script.src)?.[1]).find(Boolean)
  const base = declared && RELEASE_PATTERN.test(declared) ? declared.slice(0, 46) : 'web'
  return hash ? `${base}+${hash}` : base
}

export const recordDiagnostic = (area: DiagnosticArea, code: DiagnosticCode, facts: Facts = {}): DiagnosticEvent | undefined => {
  try {
    if (!contains(AREAS, area) || !contains(CODES, code)) { return }
    const safe = safeFacts(facts)
    const signature = [area, code, safe.stage, safe.http_status].join('/')
    const occurred_at = nowSeconds()
    const prior = recent.get(signature)
    if (prior !== undefined && occurred_at - prior < 60) { return }
    if (recent.size >= 128) { recent.delete(recent.keys().next().value ?? '') }
    const event_id = crypto.randomUUID()
    const event: DiagnosticEvent = { event_id, occurred_at, source: 'web', release: buildRelease(), area, code, ...safe }
    recent.set(signature, occurred_at)
    if (nativeOwnsDiagnostics()) {
      bridgeEvents.push(event)
      if (bridgeEvents.length > MAX_EVENTS) { bridgeEvents.shift() }
      void flushBridge()
    } else {
      store(EVENT_PREFIX + event_id, JSON.stringify(event))
      if (!stored(EVENT_PREFIX + event_id)) {
        memory.set(event_id, event)
        if (memory.size > MAX_EVENTS) { memory.delete(memory.keys().next().value ?? '') }
      }
      pendingEvents()
      emit()
      scheduleUpload()
    }
    return event
  } catch { return undefined }
}

const acknowledge = (events: DiagnosticEvent[], accepted: Set<unknown>) => {
  for (const event of events) {
    if (!accepted.has(event.event_id)) { continue }
    erase(EVENT_PREFIX + event.event_id)
    memory.delete(event.event_id)
    if (!lastSent || lastSent.occurred_at <= event.occurred_at) { lastSent = event }
  }
  if (lastSent) { store(LAST_SENT_KEY, JSON.stringify(lastSent)) }
  emit()
}

const submit = async (events: DiagnosticEvent[], controller: AbortController): Promise<Set<unknown>> => {
  const timeout = setTimeout(() => controller.abort(), 12_000)
  try {
    const url = `${__API_ORIGIN__.replace(/\/chat\/?$/, '')}/v1/technical-diagnostics/events`
    const response = await fetch(url, {
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events }), signal: controller.signal,
    })
    if (!response.ok) { return new Set() }
    const value = await response.json() as { accepted_event_ids?: unknown } | null
    const ids = value?.accepted_event_ids
    return new Set(Array.isArray(ids) && ids.length <= MAX_BATCH ? ids : [])
  } catch { return new Set() }
  finally { clearTimeout(timeout) }
}

const autoUpload = async () => {
  autoTimer = undefined
  if (autoRequest || diagnosticPreference() !== 'enabled') { return }
  const events = pendingEvents().slice(0, MAX_BATCH)
  if (!events.length) { return }
  const controller = new AbortController()
  autoRequest = controller
  lastAttempt = Date.now()
  let progress = false
  try {
    const accepted = await submit(events, controller)
    if (events.some(({ event_id }) => accepted.has(event_id))) {
      acknowledge(events, accepted)
      progress = true
    }
  } finally { autoRequest = undefined }
  if (progress && pendingEvents().length) { scheduleUpload() }
}

function scheduleUpload() {
  if (autoTimer !== undefined || autoRequest || diagnosticPreference() !== 'enabled' || navigator.onLine === false) { return }
  autoTimer = setTimeout(() => void autoUpload(), Math.max(1000, lastAttempt + POST_INTERVAL - Date.now()))
}

export const sendOneDiagnostic = async (id: string): Promise<boolean> => {
  if (nativeOwnsDiagnostics()) { return false }
  if (diagnosticWasSent(id)) { return true }
  const event = pendingEvents().find(item => item.event_id === id)
  if (!event) { return false }
  const accepted = await submit([event], new AbortController())
  if (!accepted.has(id)) { return false }
  acknowledge([event], accepted)
  return true
}

async function flushBridge() {
  if (!nativeDiagnosticsAvailable() || bridgeRunning) { return }
  bridgeRunning = true
  try {
    while (nativeDiagnosticsAvailable() && bridgeEvents.length) {
      const event = bridgeEvents.shift()
      if (!event) { break }
      const { area, code, release, stage, http_status, request_id } = event
      await sendNative('diagnostics.record', { area, code, release, stage, http_status, request_id })
    }
  } catch { /* A lost acknowledgement may follow a successful record. */ }
  finally { bridgeRunning = false }
}

const announceNativeReady = () => {
  if (!nativeDiagnosticsAvailable()) { readySent = false; return }
  if (!firstRender || readySent) { return }
  readySent = true
  void sendNative('diagnostics.ready').catch(() => {})
}

export const diagnosticsFirstRender = () => {
  firstRender = true
  announceNativeReady()
}

export const bindTechnicalDiagnostics = () => {
  if (observersInstalled) { return }
  observersInstalled = true
  window.addEventListener('error', (event: Event) => {
    if (event instanceof ErrorEvent) {
      if (event.error) { recordDiagnostic(firstRender ? 'runtime' : 'startup', 'unexpected_error', { stage: 'render' }) }
      return
    }
    const target = event.target
    if (!(target instanceof HTMLScriptElement) && !(target instanceof HTMLLinkElement)) { return }
    try {
      const url = new URL(target instanceof HTMLScriptElement ? target.src : target.href, window.location.href)
      const appDirectory = new URL('.', window.location.href).pathname
      if (url.origin === window.location.origin && url.pathname.startsWith(`${appDirectory}static/`)) {
        recordDiagnostic(firstRender ? 'runtime' : 'startup', 'load_failed', { stage: 'download' })
      }
    } catch { /* A malformed URL can still trigger the page's normal error handling. */ }
  }, true)
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason instanceof Error && event.reason.name === 'AbortError') { return }
    recordDiagnostic(firstRender ? 'runtime' : 'startup', 'unexpected_error', { stage: 'response' })
  })
  if (nativeOwnsDiagnostics()) {
    subscribeNativeBridge(() => { announceNativeReady(); void flushBridge(); emit() })
    void flushBridge()
    return
  }
  try {
    const failed = Number(sessionStorage.getItem(ENTRY_FAILURE_KEY))
    sessionStorage.removeItem(ENTRY_FAILURE_KEY)
    if (failed > 0 && nowSeconds() - failed < RETENTION_SECONDS) {
      recordDiagnostic('startup', 'load_failed', { stage: 'download' })
    }
  } catch { /* A local storage restriction leaves the app usable. */ }
  window.addEventListener('online', scheduleUpload)
  window.addEventListener('pageshow', scheduleUpload)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { scheduleUpload() } })
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === PREFERENCE_KEY) {
      decision = undefined
      if (diagnosticPreference() === 'enabled') { scheduleUpload() }
      else { stopAutoUpload() }
    }
    if (event.key === null || event.key.startsWith(PREFIX)) { emit() }
  })
  scheduleUpload()
}
