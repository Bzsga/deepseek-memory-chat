// WebView 83 provides the underlying platform APIs, but lacks these later methods.
const defineMethod = (target: object, name: PropertyKey, value: unknown) =>
  Object.defineProperty(target, name, { configurable: true, writable: true, value })

if (typeof Object.hasOwn !== 'function') {
  defineMethod(Object, 'hasOwn', (object: object, key: PropertyKey) =>
    Object.prototype.hasOwnProperty.call(object, key))
}

function at<T>(this: ArrayLike<T>, index: number): T | undefined {
  const length = Math.min(Math.max(Math.trunc(this.length) || 0, 0), Number.MAX_SAFE_INTEGER)
  const offset = Math.trunc(index) || 0
  const position = offset < 0 ? length + offset : offset
  return position >= 0 && position < length ? this[position] : undefined
}

for (const prototype of [Array.prototype, String.prototype]) {
  if (typeof prototype.at !== 'function') defineMethod(prototype, 'at', at)
}

if (typeof String.prototype.replaceAll !== 'function') {
  defineMethod(String.prototype, 'replaceAll', function (this: string, search: string | RegExp, replacement: string) {
    if (search instanceof RegExp) {
      if (!search.global) throw new TypeError('replaceAll requires a global regular expression')
      return String(this).replace(search, replacement)
    }
    const literal = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return String(this).replace(new RegExp(literal, 'g'), replacement)
  })
}

// Keep provider scopes and diagnostic IDs cryptographically random on older WebView.
if (globalThis.isSecureContext && typeof globalThis.crypto?.randomUUID !== 'function' &&
    typeof globalThis.crypto?.getRandomValues === 'function') {
  defineMethod(Crypto.prototype, 'randomUUID', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  })
}

const abortError = () => new DOMException('The operation was aborted.', 'AbortError')

if (typeof AbortSignal !== 'undefined') {
  if (!Object.prototype.hasOwnProperty.call(AbortSignal.prototype, 'reason')) {
    const reasons = new WeakMap<AbortSignal, unknown>()
    const abort = AbortController.prototype.abort
    Object.defineProperty(AbortSignal.prototype, 'reason', {
      configurable: true,
      get(this: AbortSignal) {
        if (!this.aborted) return undefined
        if (!reasons.has(this)) reasons.set(this, abortError())
        return reasons.get(this)
      },
    })
    defineMethod(AbortController.prototype, 'abort', function (this: AbortController, reason?: unknown) {
      if (!this.signal.aborted) reasons.set(this.signal, reason === undefined ? abortError() : reason)
      return abort.call(this)
    })
  }

  if (typeof AbortSignal.prototype.throwIfAborted !== 'function') {
    defineMethod(AbortSignal.prototype, 'throwIfAborted', function (this: AbortSignal) {
      if (this.aborted) throw this.reason === undefined ? abortError() : this.reason
    })
  }
}
