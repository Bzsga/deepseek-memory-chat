import './app/browserCompatibility.js'
import { bindNativeBridge, nativeDiagnosticsAvailable, sendNative } from './services/nativeBridge.js'
import {
  LoginRequired,
  bindAuthChannel,
  fetchRuntime,
  getRuntime,
  initializeRuntime,
  localGuestRuntime,
  isGuestWorkspace,
  isSessionActive,
  refreshRuntime,
  setSessionEndHandler,
} from './services/runtime.js'
import { rememberConversationShareQuery } from './services/pendingConversationShare.js'
import {
  bindTechnicalDiagnostics, diagnosticsFirstRender, latestDiagnostic, nativeOwnsDiagnostics,
  recordDiagnostic, sendOneDiagnostic,
} from './services/technicalDiagnostics.js'

bindTechnicalDiagnostics()
rememberConversationShareQuery()

const rootElement = document.getElementById('root') as HTMLElement
const statusElement = document.getElementById('session-bootstrap') as HTMLElement
const chinese = navigator.language.toLowerCase().startsWith('zh')

const showStatus = (message: string, retry?: () => void) => {
  statusElement.textContent = ''
  const text = document.createElement('p')
  text.textContent = message
  statusElement.append(text)
  if (retry) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = chinese ? '重试' : 'Retry'
    button.addEventListener('click', retry)
    statusElement.append(button)
  }
  statusElement.hidden = false
}

const hideStatus = () => {
  statusElement.hidden = true
  rootElement.style.visibility = ''
}

const showStartupDiagnostic = () => {
  if (nativeOwnsDiagnostics()) {
    if (nativeDiagnosticsAvailable()) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = chinese ? '查看技术诊断' : 'View diagnostics'
      button.addEventListener('click', () => { void sendNative('diagnostics.open').catch(() => {}) })
      statusElement.append(button)
    }
    return
  }
  const report = latestDiagnostic()
  if (!report) { return }
  const details = document.createElement('details')
  const label = document.createElement('summary')
  label.textContent = chinese ? '查看本次技术诊断' : 'View this report'
  const preview = document.createElement('pre')
  preview.textContent = JSON.stringify(report, null, 2)
  const send = document.createElement('button')
  send.type = 'button'
  send.textContent = chinese ? '发送本次诊断' : 'Send this report'
  send.addEventListener('click', async () => {
    send.disabled = true
    const sent = await sendOneDiagnostic(report.event_id)
    send.disabled = sent
    send.textContent = sent
      ? chinese ? '已发送诊断' : 'Report sent'
      : chinese ? '发送失败，点此重试' : 'Could not send. Retry'
  })
  details.append(label, preview, send)
  statusElement.append(details)
}

let resolveWorkspaceReady: () => void
const workspaceReady = new Promise<void>(resolve => { resolveWorkspaceReady = resolve })
bindNativeBridge(async (payload, id) => {
  await workspaceReady
  if (!isSessionActive()) {
    throw new Error(chinese ? '工作区已切换，请重新打开。' : 'Workspace changed. Please reopen.')
  }
  const [{ createContinuationChat }, { validateContinuationPayload }] = await Promise.all([
    import('./services/chat/store.js'),
    import('./services/chat/continuity.js'),
  ])
  await createContinuationChat(validateContinuationPayload(payload), id)
}, {
  identity: async () => {
    await workspaceReady
    return { ownerId: getRuntime().user.id, guest: isGuestWorkspace() }
  },
  frame: async (payload, live) => {
    await workspaceReady
    const module = await import('./services/chat/nativeArchive.js')
    await module.importArchiveFrame(payload, live)
  },
})

let app: typeof import('./app/start.js') | undefined
let chatProvider: typeof import('./services/chatProvider.js') | undefined
setSessionEndHandler(() => {
  rootElement.style.visibility = 'hidden'
  showStatus(chinese ? '登录状态已变化，正在重新加载…' : 'Your session changed. Reloading…')
  app?.stopAppSession()
  chatProvider?.disposeChatProvider()
  window.location.reload()
})

let starting = false
let initialized = false
let rendered = false
const showRenderFailure = () => {
  recordDiagnostic(rendered ? 'runtime' : 'startup', 'unexpected_error', { stage: 'render' })
  showStatus(
    chinese ? '聊天界面加载失败，请重新加载。' : 'The chat interface could not render. Please reload.',
    () => window.location.reload()
  )
  showStartupDiagnostic()
}

const start = async (localOnly = false) => {
  if (starting) {
    return
  }
  starting = true
  showStatus(chinese ? '正在加载 DeepSeek 记忆聊天…' : 'Loading DeepSeek Chat…', () => window.location.reload())
  try {
    const workspace = localOnly ? localGuestRuntime() : await fetchRuntime().catch(error => {
      if (error instanceof LoginRequired) {return localGuestRuntime()}
      throw error
    })
    initializeRuntime(workspace)
    initialized = true
    chatProvider = await import('./services/chatProvider.js')
    await Promise.all([chatProvider.initializeChatProvider(), import('./services/imageProvider.js').then(m => m.initializeImageProvider())])
    app = await import('./app/start.js')
    // Mobile WebView can focus between touch-down and click. Keep the UI mounted
    // while account and permission checks run in the background.
    bindAuthChannel(() => void refreshRuntime())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void refreshRuntime()
      }
    })
    window.addEventListener('focus', () => void refreshRuntime())
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        void refreshRuntime()
      }
    })
    app.startApp(() => {
      rendered = true
      resolveWorkspaceReady()
      hideStatus()
      diagnosticsFirstRender()
    }, showRenderFailure)
  } catch (error) {
    if (initialized) { recordDiagnostic('startup', 'load_failed', { stage: 'initialize' }) }
    showStatus(
      chinese ? '暂时无法连接服务。' : 'Unable to connect to the service.',
      () => initialized ? window.location.reload() : void start()
    )
    if (!initialized) {
      const local = document.createElement('button')
      local.textContent = chinese ? '进入本机聊天' : 'Open local chat'
      local.addEventListener('click', () => void start(true))
      statusElement.append(local)
    }
    showStartupDiagnostic()
  } finally {
    starting = false
  }
}

void start()
