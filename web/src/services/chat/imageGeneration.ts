export type GeneratedImageMime = 'image/png' | 'image/jpeg' | 'image/webp'

export type DecodedGeneratedImage = {
  blob: Blob
  mimeType: GeneratedImageMime
  extension: 'png' | 'jpg' | 'webp'
}

export const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_BASE64_LENGTH = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4
const generatedImageCache = new Map<string, Blob>()

/** Keep a paid result available until local persistence has completed. */
export const cacheGeneratedImage = (id: string, blob: Blob): void => {
  generatedImageCache.set(id, blob)
}

export const getCachedGeneratedImage = (id: string): Blob | undefined =>
  generatedImageCache.get(id)

export const releaseGeneratedImage = (id: string): void => {
  generatedImageCache.delete(id)
}

const fail = (): never => {
  throw new Error('生成结果不是可保存的图片，请稍后重试。')
}

const imageMime = (bytes: Uint8Array): GeneratedImageMime | undefined => {
  const at = (offset: number, values: number[]) =>
    values.every((value, index) => bytes[offset + index] === value)
  if (bytes.length >= 24 && at(0, [137, 80, 78, 71, 13, 10, 26, 10]) && at(12, [73, 72, 68, 82])) {
    return 'image/png'
  }
  if (bytes.length >= 4 && at(0, [255, 216, 255])) {
    return 'image/jpeg'
  }
  if (bytes.length >= 16 && at(0, [82, 73, 70, 70]) && at(8, [87, 69, 66, 80]) &&
    (at(12, [86, 80, 56, 32]) || at(12, [86, 80, 56, 76]) || at(12, [86, 80, 56, 88]))) {
    return 'image/webp'
  }
  return undefined
}

const decodeImage = (value: unknown, requireMime = true): DecodedGeneratedImage => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail()
  }
  const image = value as Record<string, unknown>
  // Remote URLs are deliberately not followed: the server returns the actual image bytes.
  if (typeof image.b64_json !== 'string' || image.b64_json.length > MAX_BASE64_LENGTH + 65536) {
    return fail()
  }
  const compact = image.b64_json.replace(/[\t\n\r ]/g, '')
  if (!compact || compact.length > MAX_BASE64_LENGTH || compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return fail()
  }
  const encoded = compact.padEnd(Math.ceil(compact.length / 4) * 4, '=')
  let binary: string
  try {
    binary = atob(encoded)
  } catch {
    return fail()
  }
  if (!binary.length || binary.length > MAX_GENERATED_IMAGE_BYTES) {
    return fail()
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  const mimeType = imageMime(bytes)
  if (!mimeType || ((requireMime || image.mime_type !== undefined) && image.mime_type !== mimeType)) {
    return fail()
  }
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
  return { blob: new Blob([bytes], { type: mimeType }), mimeType, extension }
}

/** Decode the bounded, single-image API response without loading external resources. */
export const decodeGeneratedImages = (value: unknown): {
  model: string
  images: DecodedGeneratedImage[]
} => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail()
  }
  const result = value as Record<string, unknown>
  if (!Array.isArray(result.images) || result.images.length !== 1 ||
    typeof result.model !== 'string' || !result.model.trim() || result.model.length > 128) {
    return fail()
  }
  return { model: result.model, images: result.images.map(image => decodeImage(image)) }
}

export const decodePersonalImage = (value: unknown) => decodeImage(value, false)

export const decodePersonalImageResponse = async (response: Response): Promise<DecodedGeneratedImage> => {
  if (!response.body || Number(response.headers.get('Content-Length')) > MAX_GENERATED_IMAGE_BYTES) {return fail()}
  const reader = response.body.getReader()
  const parts: ArrayBuffer[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {break}
      size += next.value.byteLength
      if (size > MAX_GENERATED_IMAGE_BYTES) {return fail()}
      parts.push(new Uint8Array(next.value).buffer)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const blob = new Blob(parts)
  const mimeType = imageMime(new Uint8Array(await blob.slice(0, 32).arrayBuffer()))
  if (!mimeType) {return fail()}
  return { blob: blob.slice(0, size, mimeType), mimeType, extension: mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png' }
}
