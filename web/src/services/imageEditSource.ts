import type { TranslationMessage } from '../i18n/index.js'
import { normalizeUploadFiles } from './attachments.js'

export const IMAGE_EDIT_ACCEPT = 'image/jpeg,image/png,image/webp'
export const MAX_IMAGE_EDIT_COUNT = 4
export const MAX_IMAGE_EDIT_MB = 12
export const MAX_IMAGE_EDIT_TOTAL_MB = 24
const allowedTypes = new Set(IMAGE_EDIT_ACCEPT.split(','))
const bytesPerMiB = 1024 * 1024

export const resolveImageEditSources = (
  files: readonly File[]
): { sources: File[] } | { error: TranslationMessage } => {
  if (files.length === 0 || files.length > MAX_IMAGE_EDIT_COUNT) {
    return { error: { key: 'imageEditReferenceCount', params: { count: MAX_IMAGE_EDIT_COUNT } } }
  }
  const sources = normalizeUploadFiles([...files])
  if (sources.some((source) => source.size === 0 || !allowedTypes.has(source.type))) {
    return { error: { key: 'imageEditSourceInvalid' } }
  }
  if (sources.some((source) => source.size > MAX_IMAGE_EDIT_MB * bytesPerMiB)) {
    return { error: { key: 'uploadMaxMBSize', params: { size: MAX_IMAGE_EDIT_MB } } }
  }
  if (sources.reduce((total, source) => total + source.size, 0) > MAX_IMAGE_EDIT_TOTAL_MB * bytesPerMiB) {
    return { error: { key: 'imageEditReferenceTotalSize', params: { size: MAX_IMAGE_EDIT_TOTAL_MB } } }
  }
  return { sources }
}

export const resolveImageEditSource = (
  files: readonly File[]
): { source: File } | { error: TranslationMessage } => {
  if (files.length !== 1) {
    return { error: { key: 'imageEditSourceCount' } }
  }
  const selection = resolveImageEditSources(files)
  return 'error' in selection ? selection : { source: selection.sources[0] }
}
