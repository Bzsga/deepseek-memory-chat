import { activeImageProvider, imageConfigurationIdentity, requestPersonalImage } from '../imageProvider.js'
import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { openChatProviderForIssue, type ChatProviderIssue } from '../../components/settings/settingsDialogState.js'
import { ApiError, streamMessage } from '../api/client.js'
import {
  cancelRemoteImageJob, createImageJob, getImageJob, getImageJobResult,
  imageJobIsTerminal, type ImageJob, type LocalImageJob,
} from '../api/imageJobs.js'
import type { ChatModel, CreateMessageRequest } from '../api/types.js'
import { extractFileIds, getFileErrorCode, isRetryableApiError } from '../api/errors.js'
import { cancelUpload, describeUploadError, uploadAttachment, useUploads } from '../attachments.js'
import { getChatProviderScope, isFileProviderScope } from '../chatProvider.js'
import { IMAGE_EDIT_ACCEPT, MAX_IMAGE_EDIT_MB, resolveImageEditSources } from '../imageEditSource.js'
import { modelParameters, replyStylePrompt } from '../replyPreferences.js'
import { useSettings } from '../settings.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import * as db from './db.js'
import { validateSharedSource } from './sharedSource.js'
import { filterImageActionEvent, finishImageActionText, imageActionPrompt, imageActionSystem, isDirectImageEditRequest,
  imageActionTrace, newImageActionNonce, newImageActionStream } from './imageAction.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import {
  validateContinuationPayload,
  type ContinuityContext,
} from './continuity.js'
import { getRuntime, isGuestWorkspace, isSessionActive } from '../runtime.js'
import {
  memoryCompressionPrompt,
  newConversationMemory,
  parseMemoryCompression,
  planContext,
  sourcesMatch,
  sourceSignature,
  validateConversationMemory,
  withAutomaticContextBudget,
  type MemoryActivity,
} from './contextMemory.js'
import {
  cacheGeneratedImage,
  decodeGeneratedImages,
  releaseGeneratedImage,
} from './imageGeneration.js'
import { createLatestReminder } from './latestReminder.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  getReplyText,
  recoverableImagePrompts,
  settleReply,
  toRequestMessages,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'
import { buildReplyView } from './view.js'

/** deepseek-flash 同时支持深度思考与图片输入 */
const MODEL: ChatModel = 'deepseek-flash'
/** 所有生成请求统一携带的助手身份说明 */
const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 安全审核固定开启，所有请求都走扩展模式 */
const SAFETY_CHECK = { level: 'high' } as const
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
  memoryActivity: Record<string, MemoryActivity>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
  memoryActivity: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt &&
  toSessionSummary(a).pendingImageJob === toSessionSummary(b).pendingImageJob

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
const sessionVersions = new Map<string, number>()
const saveLocalSession = async (session: Session, files: db.StoredFile[] = []): Promise<void> => {
  const version = await db.saveSession(session, files, sessionVersions.get(session.id) ?? 0)
  sessionVersions.set(session.id, version)
}
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
export const loadMessageFile = async (sessionId: string, fileId: string) =>
  pendingFiles.get(sessionId)?.find((file) => file.id === fileId)?.blob ?? db.loadFile(fileId)
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const continuationTasks = new Map<string, Promise<void>>()
const importedSessionTasks = new Map<string, Promise<string>>()
const streamFlushes = new Map<string, () => void>()
const imageWatches = new Map<string, { messageId: string; controller: AbortController; mode: 'create' | 'resume' | 'cancel' }>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void saveLocalSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
          for (const file of files ?? []) {
            releaseGeneratedImage(file.id)
          }
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const resumeImages = () => {
    if (document.visibilityState !== 'hidden' && isSessionActive()) {
      for (const id of Object.keys(get().sessionCache)) {resumeSessionImageJobs(id)}
    }
  }
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    } else {
      resumeImages()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  window.addEventListener('focus', resumeImages)
  window.addEventListener('online', resumeImages)
  window.addEventListener('pageshow', resumeImages)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
    window.removeEventListener('focus', resumeImages)
    window.removeEventListener('online', resumeImages)
    window.removeEventListener('pageshow', resumeImages)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (): AssistantMessage => {
  const { thinking, search } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: MODEL,
    thinking,
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && !m.imageJob && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && !m.imageJob && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        const sorted = sortSessions(summaries)
        const pending = sorted.filter((summary) => summary.pendingImageJob)
        set({ ready: true, sessions: sorted, ...(pending[0] ? { activeId: pending[0].id } : {}) })
        for (const summary of pending) {
          void ensureSessionLoaded(summary.id)
        }
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    resumeSessionImageJobs(id)
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      sessionVersions.set(id, db.storedSessionVersion?.(stored) ?? 0)
      const normalized = normalizeSession(stored)
      const migrated = normalized.longMemory ? withAutomaticContextBudget(normalized.longMemory) : undefined
      const settled = settleInterrupted(migrated && migrated !== normalized.longMemory
        ? { ...normalized, longMemory: migrated } : normalized)
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      if (session !== stored) {
        persist(id)
      }
      resumeSessionImageJobs(id)
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (write: () => Promise<void>): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    await Promise.allSettled(continuationTasks.values())
    await Promise.allSettled(importedSessionTasks.values())
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await db.commitStaging()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    sessionVersions.clear()
    unsavedSessions.clear()
    for (const files of pendingFiles.values()) {
      for (const file of files) {releaseGeneratedImage(file.id)}
    }
    pendingFiles.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      memoryActivity: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    set({ activeId: null })
    trimSessionCache()
  }
}

/** Durable, idempotent local handoff. It never calls a model or replaces existing history. */
export const createContinuationChat = (
  payload: ContinuityContext,
  handoffId: string
): Promise<void> => {
  const active = continuationTasks.get(handoffId)
  if (active) {
    return active
  }
  const task = (async () => {
    const context = validateContinuationPayload(payload)
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(handoffId)) {
      throw new Error('续聊请求标识无效。')
    }
    await initChat()
    if (!get().ready || get().importingHistory) {
      throw new Error('本地资料正在处理，请稍后重试。')
    }
    const id = `continuation-${handoffId}`
    const previous = getSession(id) ?? (await db.loadSession(id))
    const now = Date.now()
    const session: Session = previous ?? {
      id,
      title: context.title,
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
      continuity: context,
      nativeHandoffId: handoffId,
    }
    if (previous && previous.nativeHandoffId !== handoffId) {
      throw new Error('续聊会话标识冲突。')
    }
    if (!previous) {
      await saveLocalSession(session)
    }
    touchSession(id)
    set((state) => ({
      sessions: sortSessions([
        toSessionSummary(session),
        ...state.sessions.filter((item) => item.id !== id),
      ]),
      sessionCache: { ...state.sessionCache, [id]: session },
      activeId: id,
    }))
    trimSessionCache()
  })().finally(() => continuationTasks.delete(handoffId))
  continuationTasks.set(handoffId, task)
  return task
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

/** Append a previewed shared snapshot to this account without replacing its conversations. */
export const captureConversationDataGuard = (expectedAccountId: string, sessionId?: string): (() => boolean) => {
  const epoch = historyEpoch
  return () => isSessionActive() && getRuntime().user.id === expectedAccountId && epoch === historyEpoch && !get().importingHistory &&
    (sessionId === undefined || (!deletingSessions.has(sessionId) && Boolean(getSession(sessionId))))
}

/** A sync read may span network waits; in-memory edits must invalidate it too. */
export const captureConversationSyncGuard = (sessionId?: string): (() => boolean) => {
  const epoch = historyEpoch
  const owner = getRuntime().user.id
  const cached = sessionId === undefined ? undefined : getSession(sessionId)
  return () => isSessionActive() && getRuntime().user.id === owner && epoch === historyEpoch &&
    get().ready && !get().importingHistory && (sessionId === undefined || (
      !deletingSessions.has(sessionId) && !unsavedSessions.has(sessionId) &&
      !sessionLoads.has(sessionId) && !Object.hasOwn(get().streaming, sessionId) &&
      !get().sessions.find((summary) => summary.id === sessionId)?.pendingImageJob &&
      getSession(sessionId) === cached
    ))
}

/** Called after the remote snapshot and revision were committed atomically. */
export const displaySyncedSession = (id: string, session: Session | null, conflictCopy?: Session, version?: number) => {
  if (version !== undefined) {sessionVersions.set(id, version)}
  const cached = getSession(id)
  set((state) => {
    const cache = Object.fromEntries(Object.entries(state.sessionCache).filter(([key]) => key !== id))
    if (session && cached) {cache[id] = session}
    const summaries = state.sessions.filter((summary) => summary.id !== id)
    if (session) {summaries.push(toSessionSummary(session))}
    if (conflictCopy) {summaries.push(toSessionSummary(conflictCopy))}
    return { sessions: sortSessions(summaries), sessionCache: cache,
      activeId: session === null && state.activeId === id ? null : state.activeId }
  })
  if (!session) {sessionAccess.delete(id)}
}

/** Other tabs can advance IndexedDB while this page keeps a read-only cache. */
export const refreshConversationSyncCache = async (): Promise<void> => {
  const guard = captureConversationSyncGuard()
  if (!guard()) {return}
  for (const id of Object.keys(get().sessionCache)) {
    const current = captureConversationSyncGuard(id)
    if (!current()) {continue}
    const stored = await db.loadSession(id)
    if (!current()) {continue}
    if (stored && db.storedSessionVersion(stored) === sessionVersions.get(id)) {continue}
    displaySyncedSession(id, stored ?? null, undefined, stored ? db.storedSessionVersion(stored) : 0)
  }
  if (!guard()) {return}
  const previousList = get().sessions
  const summaries = await db.loadSessionSummaries()
  if (!guard() || get().sessions !== previousList) {return}
  set((state) => {
    const merged = new Map(summaries.map((summary) => [summary.id, summary]))
    for (const summary of state.sessions) {
      if (unsavedSessions.has(summary.id) || Object.hasOwn(state.streaming, summary.id)) {
        merged.set(summary.id, summary)
      }
    }
    return { sessions: sortSessions([...merged.values()]) }
  })
}

export const appendNativeArchiveChat = async (session: Session, live: () => boolean) => {
  await initChat()
  const guard = captureConversationSyncGuard()
  const canWrite = () => live() && guard() && !deletingSessions.has(session.id)
  const saved = await db.appendSession(session, canWrite)
  if (!canWrite()) {throw new Error('工作区已变化，请重新分享文件。')}
  set(state => ({sessions: sortSessions([...state.sessions.filter(item => item.id !== saved.id), toSessionSummary(saved)])}))
}

export const branchToNewChat = async (sessionId: string, replyId: string, title: string) => {
  const source = getSession(sessionId)
  if (!source || !get().ready || get().activeId !== sessionId) {throw new Error('Conversation unavailable')}
  const inWorkspace = captureConversationDataGuard(getRuntime().user.id, sessionId)
  const canWrite = () => inWorkspace() && get().activeId === sessionId &&
    getSession(sessionId) === source && !getStreamController(sessionId)
  const path = getVisibleMessages(source)
  const end = path.findIndex((message) => message.id === replyId && message.role === 'assistant' && message.status === 'done')
  if (end === -1 || !canWrite()) {throw new Error('Reply unavailable')}

  const messages = path.slice(0, end + 1).map((message): Message =>
    message.role === 'assistant' && (message.imageJob || message.status === 'pending' || message.status === 'streaming')
      ? { ...message, imageJob: undefined, prefix: false,
          status: message.status === 'done' ? 'done' : 'stopped' }
      : message
  )
  const messageIds = new Set(messages.map((message) => message.id))
  const comesFromPrefix = ({ sourceIds }: { sourceIds: string[] }) => sourceIds.every((id) => messageIds.has(id))
  const memory = source.longMemory
  const shared = source.sharedSource
  const now = Date.now()
  const branch = normalizeSession({
    id: createId(), title, createdAt: now, updatedAt: now, messages,
    ...(source.continuity ? { continuity: source.continuity } : {}),
    ...(shared?.messageIds?.length && shared.messageIds.every((id) => messageIds.has(id))
      ? { sharedSource: shared } : {}),
    ...(memory ? { longMemory: { ...memory, entries: memory.entries.filter(comesFromPrefix),
      segments: memory.segments.filter(comesFromPrefix).map((segment) =>
        segment.status === 'started' ? { ...segment, status: 'interrupted' as const } : segment
      ) } } : {}),
  })
  const pending = pendingFiles.get(sessionId)
  if (pending?.length) {await saveLocalSession(source, pending)}
  const saved = await db.appendSession(branch, canWrite)
  if (!canWrite()) {return}
  touchSession(saved.id)
  set((state) => ({
    sessions: sortSessions([toSessionSummary(saved), ...state.sessions]),
    sessionCache: { ...state.sessionCache, [saved.id]: saved },
    activeId: saved.id,
  }))
  trimSessionCache()
}

export const appendImportedSession = (incoming: Session, expectedAccountId: string,
  files: db.StoredFile[] = [], externalGuard: () => boolean = () => true): Promise<string> => {
  if (!isSessionActive() || getRuntime().user.id !== expectedAccountId) {
    return Promise.reject(new Error('账户已变化，请在当前账户重新导入。'))
  }
  const pending = importedSessionTasks.get(incoming.id)
  if (pending) {return pending}
  const epoch = historyEpoch
  const canWrite = () => isSessionActive() && getRuntime().user.id === expectedAccountId &&
    epoch === historyEpoch && !get().importingHistory && !deletingSessions.has(incoming.id) && externalGuard()
  const task = (async () => {
    if (!canWrite()) {throw new Error('账户或本地资料状态已变化，请重新打开分享预览。')}
    if (!incoming.id || incoming.id.length > 256 || /[/\\]/.test(incoming.id) || !incoming.sharedSource) {
      throw new Error('分享会话资料无效。')
    }
    await initChat()
    if (!get().ready || !canWrite()) {throw new Error('本地会话暂时不可用，请重试。')}
    const sharedSource = validateSharedSource({ ...incoming.sharedSource,
      messageIds: incoming.messages.map((message) => message.id) })
    const session = normalizeSession({ ...incoming, sharedSource })
    const existing = getSession(session.id)
    const saved = existing ?? await db.appendSession(session, canWrite, files)
    if (!canWrite()) {throw new Error('账户已变化，请在当前账户重新导入。')}
    touchSession(saved.id)
    set((state) => ({
      sessions: sortSessions([toSessionSummary(saved), ...state.sessions.filter((item) => item.id !== saved.id)]),
      sessionCache: { ...state.sessionCache, [saved.id]: saved }, activeId: saved.id,
    }))
    trimSessionCache()
    return saved.id
  })().finally(() => importedSessionTasks.delete(incoming.id))
  importedSessionTasks.set(incoming.id, task)
  return task
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
  }
}

const changeMemory = (id: string, change: (memory: NonNullable<Session['longMemory']>) => NonNullable<Session['longMemory']>): boolean => {
  if (get().importingHistory || deletingSessions.has(id) || getStreamController(id) || !getSession(id)) {
    return false
  }
  const session = getSession(id)
  if (!session) {return false}
  let memory
  try {
    memory = validateConversationMemory(change(session.longMemory ?? newConversationMemory()))
  } catch {
    set((state) => ({ memoryActivity: { ...state.memoryActivity,
      [id]: { status: 'error', message: '记忆容量已达到上限，请精简记忆后再试。', extraCalls: 0 } } }))
    return false
  }
  updateSession(id, (current) => ({ ...current, longMemory: memory }))
  persist(id)
  set((state) => ({ memoryActivity: { ...state.memoryActivity, [id]: { status: 'idle', extraCalls: 0 } } }))
  return true
}

export const setMemoryEnabled = (id: string, enabled: boolean): boolean =>
  changeMemory(id, (memory) => ({ ...memory, enabled }))

export const updateMemoryEntry = (
  id: string,
  entryId: string,
  change: { text?: string; pinned?: boolean },
): boolean => {
  const text = change.text?.trim()
  if (text !== undefined && (!text || text.length > 4000)) {return false}
  return changeMemory(id, (memory) => ({ ...memory,
    entries: memory.entries.map((entry) => entry.id === entryId
      ? { ...entry, ...(text === undefined ? {} : { text, edited: true }),
          ...(change.pinned === undefined ? {} : { pinned: change.pinned }) }
      : entry) }))
}

export const removeMemoryEntry = (id: string, entryId: string): boolean =>
  changeMemory(id, (memory) => ({ ...memory, entries: memory.entries.filter((entry) => entry.id !== entryId) }))

export const addPinnedMemory = (id: string, value: string): boolean => {
  const text = value.trim()
  if (!text || text.length > 4000) {return false}
  return changeMemory(id, (memory) => ({ ...memory,
    entries: [...memory.entries, { id: createId(), kind: 'fact', text,
      sourceIds: [], sourceSignature: '', pinned: true, edited: true, createdAt: Date.now() }] }))
}

/** Explicitly permits a new attempt on the next send after an uncertain/failed call. */
export const retryMemoryPreparation = (id: string): boolean => {
  const session = getSession(id)
  if (!session) {return false}
  const path = getVisibleMessages(session)
  const changed = changeMemory(id, (memory) => ({ ...memory,
    segments: memory.segments.filter((segment) => segment.status === 'complete' || !sourcesMatch(segment, path)) }))
  if (changed) {
    set((state) => ({ memoryActivity: { ...state.memoryActivity, [id]: { status: 'idle', extraCalls: 0 } } }))
  }
  return changed
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    const importing = importedSessionTasks.get(id)
    if (importing) {await Promise.allSettled([importing])}
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id, getSession(id) ? sessionVersions.get(id) ?? 0 : undefined)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    for (const file of pendingFiles.get(id) ?? []) {
      releaseGeneratedImage(file.id)
    }
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      memoryActivity: Object.fromEntries(
        Object.entries(state.memoryActivity).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

/** Account or host teardown stops local waiting while durable jobs remain recoverable. */
export const suspendReply = (sessionId: string) => getStreamController(sessionId)?.abort()

export const suspendChatReply = (sessionId: string) => {
  if (!imageWatches.has(sessionId)) {
    suspendReply(sessionId)
  }
}

export const stopReply = (sessionId: string) => {
  const watch = imageWatches.get(sessionId)
  if (watch) {
    cancelImageJob(sessionId, watch.messageId)
  } else {
    getStreamController(sessionId)?.abort()
  }
}

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  const reply = createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, { history, question })
  return true
}

/** An explicit image generation or original-image edit. */
export const sendImageMessage = (targetSessionId: string | null, count = 1, sources?: readonly File[]): boolean => {
  if (!activeImageProvider() || !Number.isInteger(count) || count < 1 || count > 5) {return false}
  const selection = sources ? resolveImageEditSources(sources) : null
  if (selection && (!('sources' in selection) || count !== 1)) {return false}
  const originals = selection?.sources ?? []
  const draft = getDraft(targetSessionId)
  if (
    !get().ready ||
    get().importingHistory ||
    !draft.text.trim() ||
    draft.text.length > 8000 ||
    draft.attachments.length > 0
  ) {
    return false
  }
  if (
    targetSessionId !== null &&
    (deletingSessions.has(targetSessionId) ||
      getStreamController(targetSessionId) ||
      !getSession(targetSessionId))
  ) {
    return false
  }
  const now = Date.now()
  let sessionId = targetSessionId
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: draft.text.trim().slice(0, 32),
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const session = getSession(sessionId)
  if (!session) {
    return false
  }
  const attachments: FileAttachment[] = originals.map((original) => ({
    id: createId(), serverId: null, name: original.name, size: original.size,
    isImage: true, mimeType: original.type,
  }))
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: draft.text,
    files: attachments,
    createdAt: now,
  }
  const reply: AssistantMessage = {
    ...createReply(),
    imageGeneration: true,
    imageJob: newLocalImageJob(Array(count).fill(question.content)),
    imagePrompt: question.content,
    ...(attachments.length ? { imageOrigin: 'edit' as const } : {}),
    thinking: false,
    search: false,
    prefix: false,
  }
  if (attachments.length) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...attachments.map(({ id }, index) => ({ id, blob: originals[index] })),
    ])
  }
  updateSession(sessionId, (current) => ({
    ...appendBranch(current, getVisibleMessages(current).at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void generateImageReply(sessionId, reply.id, 'create', question.content)
  return true
}

const newLocalImageJob = (prompts?: string[]): LocalImageJob => ({
  ...(prompts && prompts.length > 1 ? { prompts } : {}),
  ...(activeImageProvider() === 'personal' ? { provider: 'personal' as const } : {}),
  clientRequestId: createId(), ownerId: getRuntime().user.id,
  state: 'submitting', createdAt: Date.now(),
})

const imageReply = (sessionId: string, messageId: string): AssistantMessage | undefined => {
  const message = getSession(sessionId)?.messages.find((item) => item.id === messageId)
  return message?.role === 'assistant' ? message : undefined
}

const recoverableImage = (message: Message): message is AssistantMessage & { imageJob: LocalImageJob } =>
  message.role === 'assistant' && (!isGuestWorkspace() || message.imageJob?.provider === 'personal') && message.imageGeneration === true && message.imageJob !== undefined &&
  message.imageJob.ownerId === getRuntime().user.id &&
  (!imageJobIsTerminal(message.imageJob.state) ||
    (message.imageJob.state === 'completed' && !message.blocks.some((block) => block.type === 'image')))

const updateImageJob = (sessionId: string, messageId: string, patch: Partial<LocalImageJob>, status: AssistantMessage['status'] = 'pending') => {
  const current = imageReply(sessionId, messageId)
  if (!current?.imageJob) {return}
  const imageJob = { ...current.imageJob, ...patch }
  if (JSON.stringify(imageJob) === JSON.stringify(current.imageJob) && current.status === status && !current.error) {return}
  updateReply(sessionId, { ...current, imageJob, status, error: undefined })
  persist(sessionId)
}

const pauseImagePoll = (signal: AbortSignal, milliseconds: number): Promise<void> =>
  new Promise((resolvePause, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); resolvePause() }
    const aborted = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) {aborted()}
  })

const waitForImageVisibility = (signal: AbortSignal): Promise<void> => {
  if (document.visibilityState !== 'hidden') {return Promise.resolve()}
  return new Promise((resolveVisible, reject) => {
    const cleanup = () => {
      document.removeEventListener('visibilitychange', changed)
      signal.removeEventListener('abort', aborted)
    }
    const changed = () => {
      if (document.visibilityState !== 'hidden') { cleanup(); resolveVisible() }
    }
    const aborted = () => { cleanup(); reject(signal.reason) }
    document.addEventListener('visibilitychange', changed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) {aborted()}
  })
}

/** Each image keeps its own paid request identity across connection loss and page reloads. */
async function readBatchImage(id: string, prompt: string, mode: 'create' | 'resume' | 'cancel', signal: AbortSignal) {
  let remote: ImageJob | undefined
  if (mode === 'create') {
    try { remote = await createImageJob(id, prompt, signal) }
    catch (error) {
      signal.throwIfAborted()
      if (error instanceof ApiError && error.status && error.status < 500 && error.status !== 408) {throw error}
      // A missing acknowledgement may follow a successful submission. Only poll this ID.
    }
  } else if (mode === 'cancel') {remote = await cancelRemoteImageJob(id, signal)}
  for (;;) {
    signal.throwIfAborted()
    await waitForImageVisibility(signal)
    remote ??= await getImageJob(id, signal)
    if (remote.status === 'completed') {return decodeGeneratedImages(await getImageJobResult(id, signal))}
    if (imageJobIsTerminal(remote.status)) {throw new Error(remote.error?.message ?? `图片任务状态：${remote.status}`)}
    await pauseImagePoll(signal, 2000)
    remote = undefined
  }
}

/** A user submission or completed custom-tool request creates once. Recovery uses GET. */
const loadImageEditSources = async (session: Session, reply: AssistantMessage) => {
  const parent = session.messages.find((message) => message.id === reply.parentId)
  if (parent?.role !== 'user' || parent.files.some((file) => !file.isImage)) {return undefined}
  const files = await Promise.all(parent.files.map(async (original) => {
    const blob = await loadMessageFile(session.id, original.id)
    if (!blob) {throw new Error('Reference image unavailable')}
    return new File([blob], original.name, { type: original.mimeType || blob.type })
  }))
  const selection = resolveImageEditSources(files)
  return 'sources' in selection ? selection.sources : undefined
}

const generateImageReply = async (
  sessionId: string,
  messageId: string,
  mode: 'create' | 'resume' | 'cancel',
  prompt?: string,
) => {
  const initial = imageReply(sessionId, messageId)
  if (!initial?.imageJob || getStreamController(sessionId) || !isSessionActive()) {return}
  const job = initial.imageJob
  const imageConfig = imageConfigurationIdentity()
  const creationPrompt = initial.imagePrompt ?? prompt
  if (job.ownerId !== getRuntime().user.id) {return}
  const epoch = historyEpoch
  const controller = new AbortController()
  const watch = { messageId, controller, mode }
  imageWatches.set(sessionId, watch)
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  const live = () => epoch === historyEpoch && isSessionActive() && getRuntime().user.id === job.ownerId &&
    !get().importingHistory && !deletingSessions.has(sessionId) &&
    imageReply(sessionId, messageId)?.imageJob?.clientRequestId === job.clientRequestId
  const sessionLive = () => epoch === historyEpoch && isSessionActive() && getRuntime().user.id === job.ownerId &&
    !get().importingHistory && !deletingSessions.has(sessionId) && Boolean(getSession(sessionId))
  let terminal = false
  try {
    // Save the stable ID, placeholder and summary index before any paid dispatch.
    const snapshot = getSession(sessionId)
    if (!snapshot) {return}
    await saveLocalSession(snapshot, pendingFiles.get(sessionId))
    controller.signal.throwIfAborted()
    if (!live()) {return}
    let sources: File[] | undefined
    if (mode === 'create' && initial.imageOrigin === 'edit') {
      sources = await loadImageEditSources(snapshot, initial).catch(() => undefined)
      controller.signal.throwIfAborted()
      if (!live()) {return}
      if (!sources) {
        updateImageJob(sessionId, messageId, { state: 'failed', error: {
          code: 'image_edit_original_missing', message: '无法读取用于编辑的参考图，请重新选择图片后发送。',
        } }, 'error')
        terminal = true
        return
      }
    }
    const saveResult = async (result: ReturnType<typeof decodeGeneratedImages>) => {
      const current = imageReply(sessionId, messageId)
      const session = getSession(sessionId)
      if (!current || !session) {return}
      const question = session.messages.find((message) => message.id === current.parentId)
      const description = current.imagePrompt ?? (question?.role === 'user' ? question.content : prompt ?? '')
      const files: db.StoredFile[] = []
      const blocks = result.images.map(({ blob, mimeType, extension }, index) => {
        const id = `generated-${job.clientRequestId}-${index}`
        cacheGeneratedImage(id, blob)
        files.push({ id, blob })
        return { type: 'image' as const, id,
          name: `deepseek-image-${job.createdAt}-${index + 1}.${extension}`, mimeType, prompt: description }
      })
      const completed = { ...current }
      delete completed.imageJob
      pendingFiles.set(sessionId, [...(pendingFiles.get(sessionId) ?? []), ...files])
      updateReply(sessionId, { ...completed, status: 'done', blocks: [...current.blocks, ...blocks], imageModel: result.model, error: undefined })
      // Images, message and removal of the pending-summary flag share one DB transaction.
      const saved = getSession(sessionId)
      if (!saved) {return}
      const savedFiles = pendingFiles.get(sessionId)
      try {
        await saveLocalSession(saved, savedFiles)
      } catch (error) {
        persist(sessionId)
        throw error
      }
      if (pendingFiles.get(sessionId) === savedFiles) {
        for (const file of savedFiles ?? []) {releaseGeneratedImage(file.id)}
        pendingFiles.delete(sessionId)
      }
    }
    if (initial.imageOrigin !== 'edit' && job.prompts?.length) {
      const prompts = job.prompts
      if (prompts.length > 5) {throw new Error('每轮最多可生成五张图片。')}
      const personal = job.provider === 'personal'
      const operation = job.cancelRequested ? 'cancel' : mode
      if (operation === 'create' && (imageConfig !== imageConfigurationIdentity() || activeImageProvider() !== (personal ? 'personal' : 'managed'))) {
        throw new Error('生图配置已变化，请重新提交。')
      }
      updateImageJob(sessionId, messageId, { state: operation === 'cancel' ? 'cancelling' : 'running' })
      const outcomes = await Promise.allSettled(prompts.map(async (description, index) => {
        const id = `${job.clientRequestId}-${index}`
        const fileId = `generated-${id}`
        if (initial.blocks.some(block => block.type === 'image' && block.id === fileId)) {return}
        if (personal && operation !== 'create') {throw new Error('个人生图已中断，请查看服务商记录。')}
        const result = personal ? await requestPersonalImage(description, controller.signal) :
          await readBatchImage(id, description, operation, controller.signal)
        controller.signal.throwIfAborted()
        const current = imageReply(sessionId, messageId)
        if (!live() || !current) {return}
        const {blob, extension, mimeType} = result.images[0]
        cacheGeneratedImage(fileId, blob)
        pendingFiles.set(sessionId, [...(pendingFiles.get(sessionId) ?? []), {id: fileId, blob}])
        const block = {type: 'image' as const, id: fileId, name: `deepseek-image-${job.createdAt}-${index + 1}.${extension}`, mimeType, prompt: description}
        const blocks = [...current.blocks, block]
        const position = (item: typeof blocks[number]) => item.type === 'image' ? Number(item.id.split('-').at(-1)) : -1
        blocks.sort((left, right) => position(left) - position(right))
        updateReply(sessionId, {...current, imageModel: result.model, blocks})
        persist(sessionId)
      }))
      if (!live()) {return}
      if (!personal) {controller.signal.throwIfAborted()}
      const current = imageReply(sessionId, messageId)
      if (!current) {return}
      const failures = outcomes.filter(outcome => outcome.status === 'rejected')
      if (failures.length) {
        const retryRead = !personal && failures.some(({reason}) => reason instanceof TypeError || reason instanceof ApiError && (!reason.status || reason.status >= 500 || reason.status === 408))
        const reason = failures[0].reason
        updateImageJob(sessionId, messageId, { state: retryRead ? 'recoverable' : 'failed', error: {
          code: 'image_batch_incomplete', message: `已生成 ${prompts.length - failures.length}/${prompts.length} 张。${reason instanceof Error ? reason.message : '部分图片未完成。'}`,
        } }, retryRead ? 'pending' : 'error')
        terminal = !retryRead
      } else {
        const completed = {...current, status: 'done' as const}
        delete completed.imageJob
        updateReply(sessionId, completed)
        terminal = true
      }
      persist(sessionId)
      return
    }
    if (job.provider === 'personal') {
      if (mode !== 'create' || !creationPrompt) {throw new Error('个人生图请求已中断，请在服务商后台查看此次生成记录。')}
      if (imageConfig !== imageConfigurationIdentity()) {throw new Error('个人生图配置已变化，请重新提交。')}
      const result = await requestPersonalImage(creationPrompt, controller.signal, sources)
      controller.signal.throwIfAborted()
      if (live()) {await saveResult(result)}
      terminal = true
      return
    }
    let remote: ImageJob | undefined
    let cancellationSent = false
    if (mode === 'create') {
      if (activeImageProvider() !== 'managed') {
        updateImageJob(sessionId, messageId, { state: 'failed', error: {code: 'image_unavailable', message: '配套生图当前不可用。'} }, 'error')
        terminal = true
        return
      }
      if (!creationPrompt || job.cancelRequested) {throw new Error('图片任务提交状态无效。')}
      try {
        remote = await createImageJob(job.clientRequestId, creationPrompt, controller.signal, sources)
      } catch (error) {
        controller.signal.throwIfAborted()
        if (!live()) {return}
        // The POST may have succeeded. Only query that same ID after losing its response.
        if (error instanceof ApiError && error.status && error.status !== 408 && error.status !== 429 && error.status < 500) {
          if (initial.imageOrigin !== 'edit') {throw error}
          updateImageJob(sessionId, messageId, { state: 'failed', error: {
            code: error.code ?? 'image_edit_submit_failed', message: error.message,
          } }, 'error')
          terminal = true
          return
        }
      }
    }
    if (mode === 'cancel') {
      remote = await cancelRemoteImageJob(job.clientRequestId, controller.signal)
      cancellationSent = true
    }
    let absentChecks = 0
    for (;;) {
      controller.signal.throwIfAborted()
      if (!live()) {return}
      await waitForImageVisibility(controller.signal)
      if (!remote) {
        try {
          remote = await getImageJob(job.clientRequestId, controller.signal)
        } catch (error) {
          if (error instanceof ApiError && error.status === 404 && imageReply(sessionId, messageId)?.imageJob?.cancelRequested) {
            remote = await cancelRemoteImageJob(job.clientRequestId, controller.signal)
            cancellationSent = true
          } else if (error instanceof ApiError && error.status === 404 && Date.now() - job.createdAt < 30000 && absentChecks < 3) {
            absentChecks += 1
            await pauseImagePoll(controller.signal, 1500)
            continue
          } else {
            throw error
          }
        }
      }
      controller.signal.throwIfAborted()
      if (!live()) {return}
      if (remote.status === 'completed') {
        updateImageJob(sessionId, messageId, { state: 'completed', error: undefined })
        const result = decodeGeneratedImages(await getImageJobResult(job.clientRequestId, controller.signal))
        controller.signal.throwIfAborted()
        if (!live()) {return}
        await saveResult(result)
        terminal = true
        return
      }
      if (imageJobIsTerminal(remote.status)) {
        updateImageJob(sessionId, messageId, { state: remote.status, cancelRequested: undefined,
          error: remote.error }, remote.status === 'cancelled' ? 'stopped' : 'error')
        terminal = true
        return
      }
      const cancelling = imageReply(sessionId, messageId)?.imageJob?.cancelRequested
      if (cancelling && !cancellationSent) {
        // A persisted Stop intent can outlive its HTTP connection. Deliver the
        // same idempotent cancellation after confirming the job still runs.
        remote = await cancelRemoteImageJob(job.clientRequestId, controller.signal)
        cancellationSent = true
        if (!imageJobIsTerminal(remote.status)) {await pauseImagePoll(controller.signal, 2000)}
        continue
      }
      updateImageJob(sessionId, messageId, { state: cancelling ? 'cancelling' : remote.status, error: undefined })
      remote = undefined
      await pauseImagePoll(controller.signal, 2000)
    }
  } catch (error) {
    if (live()) {
      const current = imageReply(sessionId, messageId)
      if (job.provider === 'personal') {
        const message = error instanceof TypeError || controller.signal.aborted ? '个人生图连接已中断，服务商可能已受理。请查看生成记录。' : error instanceof Error ? error.message : '个人生图失败，请检查服务配置。'
        updateImageJob(sessionId, messageId, {state: 'failed', cancelRequested: undefined, error: {code: 'personal_image_failed', message}}, 'error')
        terminal = true
      } else if (error instanceof ApiError && error.code === 'image_ineligible') {
        updateImageJob(sessionId, messageId, {
          state: 'failed', cancelRequested: undefined, error: { code: error.code, message: error.message },
        }, 'error')
        terminal = true
      } else if (current?.imageJob && !(controller.signal.aborted && current.imageJob.cancelRequested)) {
        const expired = error instanceof ApiError && error.status === 410
        const absent = error instanceof ApiError && error.status === 404
        const cancellation = current.imageJob.cancelRequested
        updateImageJob(sessionId, messageId, {
          state: expired ? 'expired' : 'recoverable',
          error: { code: expired ? 'image_job_expired' : absent ? 'image_job_not_found' : 'image_job_reconnect',
            message: expired ? '这次生成结果的暂存已到期。' : absent ? '暂未找到这次生成任务，可以继续提交。' : cancellation ? '停止请求尚未确认，可以继续查看任务状态。' : '这次图片结果尚未读取完成，可以继续查看。' },
        }, expired ? 'error' : 'pending')
        terminal = expired
      }
    }
  } finally {
    if (imageWatches.get(sessionId) === watch) {imageWatches.delete(sessionId)}
    set((state) => ({ streaming: Object.fromEntries(
      Object.entries(state.streaming).filter(([id, active]) => id !== sessionId || active !== controller)
    ) }))
    if (live()) {
      persist(sessionId)
      const current = imageReply(sessionId, messageId)?.imageJob
      if (current?.cancelRequested && mode !== 'cancel' && controller.signal.aborted) {
        void generateImageReply(sessionId, messageId, 'cancel')
      }
    }
    if (terminal && sessionLive()) {resumeSessionImageJobs(sessionId)}
    if (job.provider !== 'personal') {window.dispatchEvent(new Event('deepseek:usage'))}
  }
}

function resumeSessionImageJobs(sessionId: string): void {
  if (!isSessionActive() || get().importingHistory || deletingSessions.has(sessionId) || getStreamController(sessionId)) {return}
  const pending = getSession(sessionId)?.messages.find(recoverableImage)
  if (pending) {void generateImageReply(sessionId, pending.id, 'resume')}
}

export const drawFromReplyDescriptions = (sessionId: string, messageId: string): boolean => {
  const session = getSession(sessionId)
  if (!session || !isSessionActive() || !activeImageProvider() || getStreamController(sessionId) ||
      deletingSessions.has(sessionId) || get().importingHistory) {return false}
  const reply = getVisibleMessages(session).find(message => message.id === messageId)
  if (reply?.role !== 'assistant') {return false}
  const prompts = recoverableImagePrompts(reply)
  if (!prompts.length) {return false}
  updateReply(sessionId, { ...reply, status: 'pending', error: undefined, imageGeneration: true, imageOrigin: 'chat',
    imagePrompt: prompts[0], imageJob: newLocalImageJob(prompts) })
  void generateImageReply(sessionId, messageId, 'create', prompts[0])
  return true
}

export const resumeImageJob = (sessionId: string, messageId: string): boolean => {
  const current = imageReply(sessionId, messageId)
  if (!isSessionActive() || get().importingHistory || deletingSessions.has(sessionId) || getStreamController(sessionId) || !current || !recoverableImage(current)) {return false}
  void generateImageReply(sessionId, messageId, 'resume')
  return true
}

export const retryImageJobSubmission = (sessionId: string, messageId: string): boolean => {
  const current = imageReply(sessionId, messageId)
  if (activeImageProvider() !== 'managed' || !current?.imageJob || current.imageJob.provider === 'personal' || current.imageJob.cancelRequested || current.imageJob.error?.code !== 'image_job_not_found' ||
      current.imageJob.ownerId !== getRuntime().user.id || getStreamController(sessionId) || get().importingHistory || deletingSessions.has(sessionId)) {return false}
  const question = getSession(sessionId)?.messages.find((message) => message.id === current.parentId)
  if (question?.role !== 'user') {return false}
  updateImageJob(sessionId, messageId, { state: 'submitting', error: undefined })
  void generateImageReply(sessionId, messageId, 'create', current.imagePrompt ?? question.content)
  return true
}

export const cancelImageJob = (sessionId: string, messageId: string): boolean => {
  const current = imageReply(sessionId, messageId)
  if (!isSessionActive() || get().importingHistory || deletingSessions.has(sessionId) || !current || !recoverableImage(current)) {return false}
  const watch = imageWatches.get(sessionId)
  if (watch?.messageId === messageId && watch.mode === 'cancel') {return true}
  updateImageJob(sessionId, messageId, { state: 'cancelling', cancelRequested: true, error: undefined })
  if (watch?.messageId === messageId) {watch.controller.abort()}
  else if (!getStreamController(sessionId)) {void generateImageReply(sessionId, messageId, 'cancel')}
  return true
}

const priorImagePrompts = (reply: AssistantMessage) => reply.imageJob?.prompts ??
  reply.blocks.flatMap(block => block.type === 'image' ? [block.prompt] : [])

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const imageGeneration =
    path[index]?.role === 'assistant' && (path[index] as AssistantMessage).imageGeneration === true
  if (imageGeneration && !activeImageProvider()) {return}
  const originalReply = path[index]
  if (originalReply?.role === 'assistant' && originalReply.imageJob && recoverableImage(originalReply)) {return}
  const reply: AssistantMessage = imageGeneration
    ? { ...createReply(), imageGeneration: true, imageJob: newLocalImageJob(originalReply.role === 'assistant' ? priorImagePrompts(originalReply) : undefined),
        imagePrompt: originalReply.role === 'assistant' ? originalReply.imagePrompt ?? question.content : question.content,
        ...(originalReply.role === 'assistant' && originalReply.imageOrigin ? { imageOrigin: originalReply.imageOrigin } : {}),
        thinking: false, search: false, prefix: false }
    : createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  if (imageGeneration) {
    void generateImageReply(sessionId, reply.id, 'create', question.content)
  } else {
    void streamReply(sessionId, reply, { history, question })
  }
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const imageGeneration =
    path[index + 1]?.role === 'assistant' &&
    (path[index + 1] as AssistantMessage).imageGeneration === true &&
    (path[index + 1] as AssistantMessage).imageOrigin !== 'chat' &&
    !(path[index + 1] as AssistantMessage).imageAction
  if (imageGeneration && (!activeImageProvider() || !text || text.length > 8000)) {return false}
  const originalReply = path[index + 1]
  if (originalReply?.role === 'assistant' && originalReply.imageJob && recoverableImage(originalReply)) {return false}
  const reply: AssistantMessage = imageGeneration
    ? { ...createReply(), imageGeneration: true, imageJob: newLocalImageJob(originalReply?.role === 'assistant' ? priorImagePrompts(originalReply).map(() => question.content) : undefined), imagePrompt: question.content,
        ...(originalReply?.role === 'assistant' && originalReply.imageOrigin === 'edit' ? { imageOrigin: 'edit' as const } : {}),
        thinking: false, search: false, prefix: false }
    : createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  if (imageGeneration) {
    void generateImageReply(sessionId, reply.id, 'create', question.content)
  } else {
    void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  }
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { thinking, search } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? MODEL,
    thinking: previous.thinking ?? thinking,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, serverIds: Map<string, string>, providerScope: string) => {
  if (serverIds.size === 0) {
    return
  }
  try {
    if (getChatProviderScope() !== providerScope) {
      return
    }
  } catch {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) =>
              serverIds.has(file.id)
                ? { ...file, serverId: serverIds.get(file.id) ?? null, serverScope: providerScope }
                : file
            ),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment): Promise<string | null> => {
  const providerScope = getChatProviderScope(apiKey)
  if (file.serverId && isFileProviderScope(file.serverScope, providerScope)) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done' && task.providerScope === providerScope) {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  if (getChatProviderScope(apiKey) !== providerScope) {
    throw new Error('聊天服务已变化，请重新发送。')
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (sessionId: string, request: Request, signal: AbortSignal) => {
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const apiKey = useSettings.getState().apiKey ?? ''
  const providerScope = getChatProviderScope(apiKey)
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId(apiKey, file)
      if (serverId) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveServerIds(sessionId, serverIds, providerScope)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  for (const [user] of getContextRounds(request.history).toReversed()) {
    for (const file of user.files) {
      if (
        (!file.serverId || !isFileProviderScope(file.serverScope, providerScope)) &&
        !serverIds.has(file.id) &&
        !pending.has(file.id)
      ) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    signal.throwIfAborted()
    try {
      const serverId = await Promise.race([ensureServerId(apiKey, file), aborted])
      if (serverId) {
        serverIds.set(file.id, serverId)
        saveServerIds(sessionId, new Map([[file.id, serverId]]), providerScope)
      }
    } catch {
      signal.throwIfAborted()
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T => {
    const current = (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
    return current.role === 'user'
      ? {
          ...current,
          files: current.files.map((file) =>
            isFileProviderScope(file.serverScope, providerScope)
              ? file
              : { ...file, serverId: null, serverScope: undefined }
          ),
        } as T
      : current
  }
  return {
    history: request.history.map(resolve),
    question: resolve(request.question),
    prefix: request.prefix,
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

const prepareMemoryContext = async (
  sessionId: string,
  request: Request,
  controller: AbortController,
  system: string,
) => {
  const epoch = historyEpoch
  const owner = getRuntime().user.id
  const live = () => epoch === historyEpoch && isSessionActive() && getRuntime().user.id === owner &&
    !get().importingHistory && !deletingSessions.has(sessionId) && Boolean(getSession(sessionId))
  const session = getSession(sessionId)
  if (!session) {throw new Error('会话已不可用。')}
  let plan = planContext(session, request.history, request.question, system, request.prefix)
  const activity = (value: MemoryActivity) => {
    if (live()) {set((state) => ({ memoryActivity: { ...state.memoryActivity, [sessionId]: value } }))}
  }
  activity({ status: plan.limited || plan.capacityReached ? 'limited' : 'idle',
    ...(plan.capacityReached ? { message: '自动记忆已达到容量上限，原文已保留，可精简记忆后恢复。' } : {}),
    estimatedTokens: plan.estimatedTokens, extraCalls: 0 })
  const segment = plan.segment
  if (!segment) {return plan}
  const compression = new AbortController()
  const cancel = () => compression.abort(controller.signal.reason)
  controller.signal.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => compression.abort(new Error('自动记忆等待超时。')), 60000)
  let dispatched = false
  const questionSignature = sourceSignature([request.question])
  const sourceIsCurrent = () => {
    const current = getSession(sessionId)
    if (!live() || !current) {return false}
    const path = getVisibleMessages(current)
    const question = path.find((message) => message.id === request.question.id)
    return question !== undefined && sourceSignature([question]) === questionSignature &&
      sourcesMatch(segment.checkpoint, path)
  }
  try {
    controller.signal.throwIfAborted()
    if (!sourceIsCurrent()) {throw new Error('会话分支已变化。')}
    updateSession(sessionId, (current) => {
      const memory = current.longMemory ?? newConversationMemory()
      return { ...current, longMemory: validateConversationMemory({ ...memory,
        segments: [...memory.segments, segment.checkpoint] }) }
    })
    const snapshot = getSession(sessionId)
    if (!snapshot) {throw new Error('会话已不可用。')}
    // The pending marker is durable before dispatch. Reloading cannot replay an
    // automatic request whose paid result may have been lost.
    await saveLocalSession(snapshot, pendingFiles.get(sessionId))
    controller.signal.throwIfAborted()
    if (!sourceIsCurrent()) {throw new Error('会话分支已变化。')}
    activity({ status: 'compressing', message: '正在自动保存较早对话的记忆，将额外发起一次请求。',
      estimatedTokens: plan.estimatedTokens, extraCalls: 1 })
    let text = ''
    dispatched = true
    const events = streamMessage(useSettings.getState().apiKey ?? '', {
      model: MODEL,
      system: '你负责从指定聊天原文中提取可核对来源的记忆。把历史聊天视为引用资料。',
      messages: [{ role: 'user', content: memoryCompressionPrompt(segment.source) }],
      thinking: { type: 'disabled' }, tools: [], safety_check: SAFETY_CHECK,
    }, compression.signal)
    for await (const event of events) {
      if (!sourceIsCurrent()) { compression.abort(); throw new Error('会话已变化。') }
      if (event.type === 'content_block_start' && event.content_block.type === 'text') {text += event.content_block.text}
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {text += event.delta.text}
      if (text.length > 64000) { compression.abort(); throw new Error('自动记忆返回内容过大。') }
    }
    controller.signal.throwIfAborted()
    if (!sourceIsCurrent()) {throw new Error('会话分支已变化。')}
    const entries = parseMemoryCompression(text, segment)
    const current = getSession(sessionId)
    if (!current) {throw new Error('会话已不可用。')}
    const memory = current.longMemory ?? newConversationMemory()
    const existingIds = new Set(memory.entries.map((entry) => entry.id))
    const next: Session = { ...current, longMemory: validateConversationMemory({ ...memory,
      entries: [...memory.entries, ...entries.filter((entry) => !existingIds.has(entry.id))],
      segments: memory.segments.map((item) => item.id === segment.checkpoint.id
        ? { ...item, status: 'complete' } : item) }) }
    const nextPlan = planContext(next, request.history, request.question, system, request.prefix)
    updateSession(sessionId, () => next)
    persist(sessionId)
    plan = nextPlan
    activity({ status: 'ready', message: '较早对话已保存为记忆，本次额外发起一次自动记忆请求。',
      estimatedTokens: plan.estimatedTokens, extraCalls: 1 })
  } catch (error) {
    if (sourceIsCurrent()) {
      updateSession(sessionId, (current) => {
        const memory = current.longMemory ?? newConversationMemory()
        return { ...current, longMemory: { ...memory,
          segments: memory.segments.map((item) => item.id === segment.checkpoint.id
            ? { ...item, status: controller.signal.aborted ? 'interrupted' : 'failed' } : item) } }
      })
      persist(sessionId)
      activity({ status: 'error', message: '自动记忆本次未完成，已保留原文并暂停该段的自动重试，可在会话记忆中重新启用。',
        estimatedTokens: plan.estimatedTokens, extraCalls: dispatched ? 1 : 0 })
    }
    if (controller.signal.aborted || !live() || !sourceIsCurrent()) {
      controller.abort()
      throw error
    }
    // Continue this user message with bounded original context. The failed
    // segment remains recorded and needs an explicit action for another call.
  } finally {
    clearTimeout(timeout)
    controller.signal.removeEventListener('abort', cancel)
  }
  return plan
}

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  const owner = getRuntime().user.id
  const epoch = historyEpoch
  const preferences = useSettings.getState()
  const replyStyle = replyStylePrompt(preferences)
  const baseSystem = replyStyle
    ? `${SYSTEM_PROMPT}\n\n用户指定的回复风格与角色偏好：\n${replyStyle}`
    : SYSTEM_PROMPT
  const parameters = modelParameters(preferences, initial.thinking === true)
  const plannedImageProvider = imageConfigurationIdentity()
  const allowImageAction = !!plannedImageProvider && !request.prefix
  const original = request.question.files.length === 1 ? request.question.files[0] : undefined
  const canEditSource = allowImageAction && !!original?.isImage && original.size > 0 &&
    original.size <= MAX_IMAGE_EDIT_MB * 1024 * 1024 && IMAGE_EDIT_ACCEPT.split(',').includes(original.mimeType) &&
    isDirectImageEditRequest(request.question.content)
  const planningNonce = newImageActionNonce()
  const questionSignature = sourceSignature([request.question])
  let imageHandoff: string | undefined
  let providerIssue: ChatProviderIssue | undefined
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  try {
    let context
    try {
      context = await prepareMemoryContext(sessionId, request, controller,
        allowImageAction ? imageActionSystem(baseSystem, planningNonce, canEditSource) : baseSystem)
      controller.signal.throwIfAborted()
      request = { ...request, history: context.history }
    } catch (error) {
      reply = controller.signal.aborted
        ? settleReply(reply, 'stopped', Date.now())
        : settleReply(reply, 'error', Date.now(), {
            kind: 'protocol', message: error instanceof Error ? error.message : '会话上下文准备失败。',
          })
      return
    }
    for (let attempt = 0; ; attempt += 1) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = true
      let receivedContent = false
      const imageActions = newImageActionStream()
      const textIndexes = new Map<number, number>()
      const thinkingIndexes = new Map<number, number>()
      const appendFiltered = (filtered: ReturnType<typeof finishImageActionText>) => {
        if (!filtered.visible.length && !filtered.thinking.length) {return}
        const blocks = [...reply.blocks]
        for (const [kind, pieces, indexes] of [
          ['text', filtered.visible, textIndexes], ['thinking', filtered.thinking, thinkingIndexes],
        ] as const) {
          for (const piece of pieces) {
            const index = indexes.get(piece.index)
            if (index === undefined) {continue}
            const block = blocks[index]
            if (kind === 'text' && block?.type === 'text') {blocks[index] = { ...block, text: block.text + piece.text }}
            if (kind === 'thinking' && block?.type === 'thinking') {blocks[index] = { ...block, thinking: block.thinking + piece.text }}
          }
        }
        reply = { ...reply, blocks }
      }
      const saveActionEvidence = () => {
        const trace = imageActionTrace(imageActions)
        // Hidden thinking no longer matches its upstream signature, so it cannot
        // be reused as a continuation prefix. Ordinary next-turn history omits it.
        if (trace) {reply = { ...reply, imageAction: trace, prefix: false }}
      }
      try {
        const prepared = await prepareFiles(sessionId, request, controller.signal)
        preparing = false
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = prepared.prefix
          ? prepared.prefix.latestReminder
          : createLatestReminder(useSettings.getState())
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        const messages = toRequestMessages(
          prepared.history,
          prepared.question,
          prepared.prefix,
          initial.thinking ?? false,
          latestReminder
        )
        const events = streamMessage(
          useSettings.getState().apiKey ?? '',
          {
            model: initial.model ?? MODEL,
            ...parameters,
            // Planning budgets the same-length protocol. Each actual request,
            // including an attachment retry, receives a fresh nonce.
            system: allowImageAction ? context.system.replaceAll(planningNonce, imageActions.nonce) : context.system,
            messages,
            thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
            safety_check: SAFETY_CHECK,
            tools: serverTools(initial.search ?? false),
            ...(titleRequests.has(controller) ? { title: { enabled: true } } : {}),
          },
          controller.signal
        )
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          const filtered = filterImageActionEvent(imageActions, event)
          reply = applyEvent(reply, filtered.event, Date.now(), blockIndexes)
          if (event.type === 'content_block_start') {
            const index = blockIndexes.get(event.index)
            if (index !== undefined) {
              if (event.content_block.type === 'text') {textIndexes.set(event.index, index)}
              if (event.content_block.type === 'thinking') {thinkingIndexes.set(event.index, index)}
            }
          }
          appendFiltered(filtered)
          saveActionEvidence()
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        controller.signal.throwIfAborted()
        reply = settleReply(reply, 'done', Date.now())
        const prompt = imageActionPrompt(
          imageActions, allowImageAction && plannedImageProvider === imageConfigurationIdentity(), canEditSource
        )
        saveActionEvidence()
        // Older histories used receipt-like prose. Repeating that prose cannot create an image job.
        if (prompt === undefined && allowImageAction && reply.stopReason === 'end_turn' &&
            /(?:^|\n)\s*已生成一张图片[。.]\s*实际生成提示词为\s*["“]/u.test(getReplyText(reply)) &&
            /(?:生成|画|绘制|绘画|出图)/u.test(request.question.content) &&
            !/(?:提示词|为什么|为何|解释|举例|示例|翻译|复述|总结|回顾|不要|不用|不必|暂不)/u.test(request.question.content)) {
          throw new Error('本轮只收到了文字描述，没有提交绘图任务。可使用回复下方的绘图操作。')
        }
        if (prompt !== undefined) {
          const current = getSession(sessionId)
          const path = current ? getVisibleMessages(current) : []
          const questionIndex = path.findIndex(message => message.id === request.question.id)
          const question = path[questionIndex]
          if (epoch !== historyEpoch || !isSessionActive() || getRuntime().user.id !== owner ||
              get().importingHistory || deletingSessions.has(sessionId) || getStreamController(sessionId) !== controller ||
              questionIndex < 0 || !question || sourceSignature([question]) !== questionSignature ||
              path[questionIndex + 1]?.id !== initial.id) {
            throw new Error('会话或账号状态已变化，请在当前会话重新发送绘图要求。')
          }
          reply = { ...reply, imageGeneration: true, imageOrigin: imageActions.editSource ? 'edit' : 'chat',
            imageJob: newLocalImageJob(imageActions.prompts), imagePrompt: prompt,
            status: 'pending', prefix: false }
          imageHandoff = prompt
          if (!current?.title) {
            updateSession(sessionId, session => ({ ...session, title: request.question.content.trim().slice(0, 32) || '图片生成' }))
          }
        }
        break
      } catch (error) {
        appendFiltered(finishImageActionText(imageActions))
        saveActionEvidence()
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        const personalFailure = error instanceof ApiError && error.code?.startsWith('personal_')
        // Personal errors may discard stale IDs, but only an explicit user retry may pay again.
        if (personalFailure && !receivedContent) {
          reuploadInvalidatedFiles(sessionId, request, error)
        }
        // 配套附件失效：重新补传后重发。收到过内容块后不自动重发。
        if (
          !personalFailure &&
          attempt < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, request, error)
        ) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason && reply.stopReason !== 'tool_use' && !reply.imageAction?.raw) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError && error.kind === 'interrupted' && reply.imageAction?.raw) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol', message: '绘图请求中断，图片尚未开始生成。请重新发送绘图要求。',
          })
        } else if (error instanceof ApiError) {
          if (error.code === 'personal_auth') {
            providerIssue = 'chatProviderPersonalAuth'
          } else if (error.code === 'managed_chat_unavailable') {
            providerIssue = 'chatProviderManagedSetupFailed'
          }
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: providerIssue ? { key: providerIssue } : error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id, active]) => id !== sessionId || active !== controller)
      ),
    }))
    persist(sessionId)
    if (providerIssue && !controller.signal.aborted && epoch === historyEpoch && isSessionActive() &&
        getRuntime().user.id === owner && get().activeId === sessionId && !get().importingHistory &&
        !deletingSessions.has(sessionId)) {
      openChatProviderForIssue(providerIssue)
    }
    if (imageHandoff !== undefined && !controller.signal.aborted && epoch === historyEpoch &&
        isSessionActive() && getRuntime().user.id === owner && !get().importingHistory && !deletingSessions.has(sessionId)) {
      void generateImageReply(sessionId, reply.id, 'create', imageHandoff)
    } else {
      resumeSessionImageJobs(sessionId)
      if (useSettings.getState().autoReadAloud && reply.status === 'done' && reply.stopReason !== 'refusal') {
        const stillCurrent = () => {
          const session = getSession(sessionId)
          return !controller.signal.aborted && epoch === historyEpoch && isSessionActive() &&
            getRuntime().user.id === owner && get().activeId === sessionId && !get().importingHistory &&
            !deletingSessions.has(sessionId) && !getStreamController(sessionId) && Boolean(session &&
              getVisibleMessages(session).at(-1)?.id === reply.id)
        }
        const text = buildReplyView(reply, false).answer?.text.trim()
        if (text && stillCurrent()) {
          void import('../speech/readAloud.js').then(({ autoReadAloudReply }) =>
            autoReadAloudReply(reply.id, text, stillCurrent)
          ).catch(() => {})
        }
      }
    }
  }
}
