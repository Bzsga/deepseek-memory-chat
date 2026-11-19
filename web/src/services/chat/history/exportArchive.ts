import * as db from '../db.js'
import { getCachedGeneratedImage } from '../imageGeneration.js'
import type { Session } from '../types.js'
import {
  EXPORT_FORMAT_VERSION,
  type Manifest,
  type SessionFile,
  type SessionIndexEntry,
} from './format.js'
import { INDEX_PATH, MANIFEST_PATH, imagePath, sessionPath } from './paths.js'
import { toIndexEntry, toSessionFile } from './toArchive.js'
import { writeArchive } from './zipWriter.js'

const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' })

export type SessionArchiveData = {
  session: SessionFile
  files: { name: string; blob: Blob }[]
}

/** Read one session's original images, including paid images awaiting persistence. */
export const prepareSessionArchive = async (
  session: Session,
  originals = new Map<string, Blob | undefined>()
): Promise<SessionArchiveData> => {
  for (const message of session.messages) {
    const images =
      message.role === 'user'
        ? message.files.filter((file) => file.isImage)
        : message.blocks.filter((block) => block.type === 'image')
    for (const image of images) {
      if (!originals.has(image.id)) {
        originals.set(image.id, getCachedGeneratedImage(image.id) ?? (await db.loadFile(image.id)))
      }
    }
  }
  const images = new Map<string, Blob>()
  const data = toSessionFile(session, ({ id, name, isImage }) => {
    const blob = originals.get(id)
    if (!blob || !isImage) {
      return null
    }
    const path = imagePath(session.id, id, name)
    images.set(path, blob)
    return path
  })
  return { session: data, files: [...images].map(([name, blob]) => ({ name, blob })) }
}

/**
 * 按导出格式生成 ZIP：manifest → 全部会话 JSON → index → 全部图片。没有账号信息，不写 user.json。
 * 只写出本地有原件的图片，每个会话目录各写一份；其他附件只有元数据。
 */
export const exportArchive = async (
  sessions: Iterable<Session> | AsyncIterable<Session>
): Promise<Blob> => {
  const manifest: Manifest = { export_format_version: EXPORT_FORMAT_VERSION }
  const entries = [{ name: MANIFEST_PATH, blob: json(manifest) }]
  const imageEntries: { name: string; blob: Blob }[] = []
  const index: SessionIndexEntry[] = []
  const originals = new Map<string, Blob | undefined>()
  for await (const session of sessions) {
    const prepared = await prepareSessionArchive(session, originals)
    entries.push({ name: sessionPath(session.id), blob: json(prepared.session) })
    imageEntries.push(...prepared.files)
    index.push(toIndexEntry(prepared.session))
  }
  entries.push({ name: INDEX_PATH, blob: json(index) })
  return writeArchive(entries.concat(imageEntries))
}
