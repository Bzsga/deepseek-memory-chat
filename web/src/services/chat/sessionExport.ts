import { formatDate } from '../../utils/format.js'
import { cloneSnapshot } from '../../utils/cloneSnapshot.js'
import { getRuntime, isSessionActive } from '../runtime.js'
import { getVisibleMessages } from './branches.js'
import { memoryForExport } from './contextMemory.js'
import type { Message, Session } from './types.js'
import { exportArchive, prepareSessionArchive } from './history/exportArchive.js'
import { EXPORT_FORMAT_VERSION } from './history/format.js'
import { BackupError } from './history/errors.js'
import { INDEX_PATH, MANIFEST_PATH, sessionPath } from './history/paths.js'
import { checkManifest, readSessionFile } from './history/schema.js'
import { toIndexEntry } from './history/toArchive.js'
import { isZipFile } from './history/zipReader.js'
import { writeArchive } from './history/zipWriter.js'

export type SessionExportFormat = 'markdown' | 'text' | 'json' | 'zip'
export type SessionExportFile = { name: string; blob: Blob; accountId?: string }
export const MAX_SESSION_JSON_BYTES = 32 * 1024 * 1024

const checkJsonSize = (size: number) => {
  if (size > MAX_SESSION_JSON_BYTES) {
    throw new Error('单会话 JSON 超过 32 MB，请使用 ZIP 完整备份。')
  }
}

const assertExportAccount = (accountId: string) => {
  if (!isSessionActive() || getRuntime().user.id !== accountId) {
    throw new Error('登录状态已变化，请重新打开当前会话后导出。')
  }
}

const fileName = (session: Session, extension: string) => {
  const title = Array.from(session.title.trim() || 'DeepSeek会话')
    .slice(0, 90)
    .map((character) =>
      character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character
    )
    .join('')
    .replace(/[. ]+$/g, '')
  return `${title || 'DeepSeek会话'}-${formatDate(session.updatedAt) ?? 'export'}.${extension}`
}

const messageText = (message: Message) => {
  if (message.role === 'user') {
    return [
      message.content,
      ...message.files.map((file) => `[${file.isImage ? '图片附件' : '文件附件'}] ${file.name}`),
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  const paragraphs = message.blocks.flatMap((block) => {
    if (block.type === 'text') {
      return [block.text]
    }
    if (block.type === 'image') {
      return [`[生成图片] ${block.name}\n${block.prompt}`]
    }
    return []
  })
  if (message.status === 'error' && message.error?.message) {
    paragraphs.push(`[请求失败] ${message.error.message}`)
  }
  return paragraphs.join('\n\n')
}

const readableSession = (session: Session, markdown: boolean) => {
  const title = session.title || 'DeepSeek会话'
  const parts = [markdown ? `# ${title}` : title]
  if (session.continuity?.text) {
    parts.push(`${markdown ? '## ' : ''}带入的历史背景\n\n${session.continuity.text}`)
  }
  const memories = memoryForExport(session)
  if (memories.length > 0) {
    parts.push(
      `${markdown ? '## ' : ''}会话记忆\n\n${memories
        .map((entry) => `- ${entry.text}${entry.pinned ? ' [已固定]' : ''}`)
        .join('\n')}`
    )
  }
  for (const message of getVisibleMessages(session)) {
    const role = message.role === 'user' ? '用户' : 'DeepSeek'
    const time = new Date(message.createdAt).toISOString()
    parts.push(`${markdown ? '## ' : ''}${role} · ${time}\n\n${messageText(message)}`)
  }
  return parts.join('\n\n') + '\n'
}

const base64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)))
  }
  return btoa(chunks.join(''))
}

/** Export current visible text, or a complete single-session archive with all branches. */
export const createSessionExport = async (
  session: Session,
  format: SessionExportFormat
): Promise<SessionExportFile> => {
  const accountId = getRuntime().user.id
  assertExportAccount(accountId)
  const finish = (file: SessionExportFile): SessionExportFile => {
    assertExportAccount(accountId)
    return { ...file, accountId }
  }
  const snapshot = await cloneSnapshot(session)
  if (format === 'markdown' || format === 'text') {
    return finish({
      name: fileName(snapshot, format === 'markdown' ? 'md' : 'txt'),
      blob: new Blob([readableSession(snapshot, format === 'markdown')], {
        type: format === 'markdown' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8',
      }),
    })
  }
  if (format === 'zip') {
    return finish({ name: fileName(snapshot, 'zip'), blob: await exportArchive([snapshot]) })
  }
  const prepared = await prepareSessionArchive(snapshot)
  // Refuse oversized image envelopes before allocating their base64 strings.
  const metadataBytes = new TextEncoder().encode(JSON.stringify(prepared.session)).byteLength
  checkJsonSize(
    metadataBytes +
      prepared.files.reduce((size, file) => size + Math.ceil(file.blob.size / 3) * 4, 0)
  )
  const files = []
  for (const file of prepared.files) {
    files.push({ path: file.name, mime_type: file.blob.type, data_base64: await base64(file.blob) })
  }
  const document = {
    format: 'deepseek-session',
    version: 1,
    manifest: { export_format_version: EXPORT_FORMAT_VERSION },
    session: prepared.session,
    files,
  }
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
  checkJsonSize(blob.size)
  return finish({
    name: fileName(snapshot, 'json'),
    blob,
  })
}

/** Native chat-export-bridge intercepts this same blob download on the trusted page. */
export const saveSessionExport = ({ name, blob, accountId }: SessionExportFile): void => {
  if (accountId) {
    assertExportAccount(accountId)
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const invalidJson = (): never => {
  throw new BackupError('backupInvalidJson')
}

/** Convert the readable single-session JSON envelope to the existing validated ZIP path. */
export const sessionExportToArchive = async (file: File): Promise<File> => {
  if (await isZipFile(file)) {
    return file
  }
  checkJsonSize(file.size)
  let value: unknown
  try {
    value = JSON.parse(await file.text())
  } catch {
    return invalidJson()
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidJson()
  }
  const envelope = value as Record<string, unknown>
  if (
    envelope.format !== 'deepseek-session' ||
    envelope.version !== 1 ||
    !Array.isArray(envelope.files)
  ) {
    return invalidJson()
  }
  checkManifest(envelope.manifest)
  const session = readSessionFile(envelope.session)
  const json = (data: unknown) => new Blob([JSON.stringify(data)], { type: 'application/json' })
  const entries = [
    { name: MANIFEST_PATH, blob: json({ export_format_version: EXPORT_FORMAT_VERSION }) },
    { name: sessionPath(session.id), blob: json(session) },
    { name: INDEX_PATH, blob: json([toIndexEntry(session)]) },
  ]
  for (const item of envelope.files) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return invalidJson()
    }
    const asset = item as Record<string, unknown>
    if (
      typeof asset.path !== 'string' ||
      typeof asset.mime_type !== 'string' ||
      typeof asset.data_base64 !== 'string' ||
      asset.data_base64.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data_base64)
    ) {
      return invalidJson()
    }
    const binary = atob(asset.data_base64)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    entries.push({ name: asset.path, blob: new Blob([bytes], { type: asset.mime_type }) })
  }
  const archive = await writeArchive(entries)
  return new File([archive], file.name.replace(/\.json$/i, '') + '.zip', {
    type: 'application/zip',
  })
}
