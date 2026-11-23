import { formatDate } from '../../utils/format.js'
import { recordDiagnostic } from '../technicalDiagnostics.js'
import * as db from './db.js'
import { BackupError, HistorySelectionTooLargeError } from './history/errors.js'
import type { SessionIndexEntry } from './history/format.js'
import { commitHistoryAppend, replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError, HistorySelectionTooLargeError } from './history/errors.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })

export class HistoryInputTooLargeError extends Error {}

export type HistoryPreview = { archive: File; sessions: SessionIndexEntry[] }

const requireWorkspace = (guard: () => boolean) => {
  if (!guard()) {
    throw new DOMException('The local workspace changed during history import.', 'AbortError')
  }
}

const reportImportError = (error: unknown, stage: 'parse' | 'apply') => {
  if (error instanceof HistoryInputTooLargeError || error instanceof HistorySelectionTooLargeError) {return}
  if (error instanceof BackupError) {
    if (error.key === 'backupInvalidJson' || error.key === 'backupIncomplete') {
      recordDiagnostic('import', 'integrity_error', { stage: 'parse' })
    }
  } else if (!(error instanceof DOMException && error.name === 'AbortError')) {
    recordDiagnostic('import', 'operation_failed', { stage })
  }
}

/** Inspect the archive without changing the current workspace. */
export const previewHistory = async (file: File): Promise<HistoryPreview> => {
  try {
    const { readArchiveIndex } = await import('./history/importArchive.js')
    const { MAX_SESSION_JSON_BYTES, sessionExportToArchive } = await import('./sessionExport.js')
    const { isZipFile } = await import('./history/zipReader.js')
    if (!(await isZipFile(file)) && file.size > MAX_SESSION_JSON_BYTES) {
      throw new HistoryInputTooLargeError()
    }
    const archive = await sessionExportToArchive(file)
    return { archive, sessions: await readArchiveIndex(archive) }
  } catch (error) {
    reportImportError(error, 'parse')
    throw error
  }
}

export const addHistory = (
  preview: HistoryPreview,
  selected: ReadonlySet<string>,
  guard: () => boolean
): Promise<{ added: number; skipped: number }> =>
  enqueueBackup(async () => {
    requireWorkspace(guard)
    if (!selected.size) {return { added: 0, skipped: 0 }}
    const sessions: Session[] = []
    const files: db.StoredFile[] = []
    let stage: 'parse' | 'apply' = 'parse'
    try {
      const { importArchive } = await import('./history/importArchive.js')
      await importArchive(preview.archive, {
        addSession: (session) => { sessions.push(session) },
        saveFiles: (originals) => { files.push(...originals) },
      }, selected)
      stage = 'apply'
      return await commitHistoryAppend(sessions, files, guard)
    } catch (error) {
      reportImportError(error, stage)
      throw error
    }
  })

/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 */
export const importHistory = (file: File, guard: () => boolean = () => true): Promise<number> =>
  enqueueBackup(async () => {
    let stage: 'parse' | 'apply' = 'parse'
    try {
      const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
      const { sessionExportToArchive } = await import('./sessionExport.js')
      const archive = await sessionExportToArchive(file)
      await checkArchiveFormat(archive)
      requireWorkspace(guard)
      stage = 'apply'
      return await replaceHistory(() => importArchive(archive))
    } catch (error) {
      reportImportError(error, stage)
      throw error
    }
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
