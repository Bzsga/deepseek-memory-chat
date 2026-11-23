@file:Suppress("DEPRECATION")

package app.banzhan.deepseekcontinuation.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.ClipData
import android.content.pm.PackageManager
import android.net.Uri
import android.os.SystemClock
import android.provider.MediaStore
import android.view.LayoutInflater
import android.webkit.*
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.banzhan.deepseekcontinuation.R
import app.banzhan.deepseekcontinuation.data.*
import app.banzhan.deepseekcontinuation.core.ImportedConversation
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeout
import java.io.File
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

private const val CHAT_STARTUP_DELAYED = "聊天页面迟迟没有响应。"

@Composable
internal fun ChatScreen(
    session: AccountSession?,
    sharedImport: PendingIncomingImport? = null,
    sourceConversations: List<ImportedConversation> = emptyList(),
    onImportSaved: (String, Int) -> Unit = { _, _ -> },
    continuation: ChatContinuationDraft?,
    onContinuationSaved: (String) -> Unit,
    onOrganize: suspend (ByteArray, String?) -> Unit,
    onMemories: (String?) -> Unit,
    onReadArchive: suspend (String) -> JsonObject,
    onAccount: (resumeSyncSettings: Boolean) -> Unit,
    onSettings: suspend (NativeSettingsSection?) -> Unit,
    onDiagnostics: () -> Unit = {},
    onChatProvider: suspend (String, String, String?, String?, String?) -> Unit,
    personalMcpAllowed: () -> Boolean = { false },
    onThemePreference: (String?, String) -> Unit,
    initialFragment: String = "",
    onReturnFromSettings: (() -> Unit)? = null,
    webViewProvider: ChatWebViewProvider,
    webViewHandlesIme: Boolean,
    onRecheckWebView: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    val currentOrganize by rememberUpdatedState(onOrganize)
    val currentMemories by rememberUpdatedState(onMemories)
    val currentReadArchive by rememberUpdatedState(onReadArchive)
    val currentAccount by rememberUpdatedState(onAccount)
    val currentSettings by rememberUpdatedState(onSettings)
    val currentDiagnostics by rememberUpdatedState(onDiagnostics)
    val returnFromSettings by rememberUpdatedState(onReturnFromSettings)
    val liveSession by rememberUpdatedState(session)
    val currentProvider by rememberUpdatedState(onChatProvider)
    val currentMcpAllowed by rememberUpdatedState(personalMcpAllowed)
    val currentTheme by rememberUpdatedState(onThemePreference)
    val currentSaved by rememberUpdatedState(onContinuationSaved)
    var reload by remember { mutableIntStateOf(0) }
    var error by remember(session?.token, reload) { mutableStateOf<String?>(null) }
    var rendererGone by remember(session?.token, reload) { mutableStateOf(false) }
    var pageReady by remember(session?.token, reload) { mutableStateOf(false) }
    var viewingSettings by remember(session?.token, reload) { mutableStateOf(false) }
    var hasHistory by remember(session?.token, reload) { mutableStateOf(false) }
    var web by remember { mutableStateOf<WebView?>(null) }
    var browser by remember { mutableStateOf<ChatBrowser?>(null) }
    var fileResult by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
    var capturePath by rememberSaveable { mutableStateOf<String?>(null) }
    var audioRequest by remember { mutableStateOf<PermissionRequest?>(null) }
    var audioPermissionPending by remember { mutableStateOf(false) }
    var exportPath by rememberSaveable { mutableStateOf<String?>(null) }

    val chooseFile = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val capture = capturePath?.let(::File)
        capturePath = null
        val callback = fileResult
        fileResult = null
        val selected = if (capture != null) {
            if (result.resultCode == Activity.RESULT_OK && capture.isFile && capture.length() > 0 && callback != null)
                arrayOf(FileProvider.getUriForFile(context, "${context.packageName}.files", capture))
            else { capture.delete(); null }
        } else {
            parseChatFilePickerResult(result.resultCode, result.data, context.packageName).also {
                if (it == null && callback != null && result.resultCode == Activity.RESULT_OK) {
                    TechnicalDiagnostics.record("attachment", "operation_failed", "read")
                    Toast.makeText(context, "未能读取所选文件，请换一个文件来源后重试。", Toast.LENGTH_SHORT).show()
                }
            }
        }
        callback?.onReceiveValue(selected)
    }
    val recordAudio = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        audioPermissionPending = false
        val request = audioRequest
        audioRequest = null
        if (granted && request != null && request.origin.toString().trimEnd('/') == CHAT_ORIGIN &&
            web?.url?.let(::trustedChatPage) == true) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        else request?.deny()
    }
    val saveFile = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val file = exportPath?.let(::File)
        exportPath = null
        scope.launch {
            try {
                if (result.resultCode == Activity.RESULT_OK && result.data?.data != null && file != null) {
                    withContext(Dispatchers.IO) {
                        context.contentResolver.openOutputStream(result.data!!.data!!, "w")!!.use { out ->
                            file.inputStream().use { it.copyTo(out) }
                        }
                    }
                }
            } catch (_: Exception) {
                error = "文件未保存，请重新导出。"
            } finally { file?.delete() }
        }
    }
    val saveImageToGallery = rememberChatGallerySaver { error = it }
    fun stageExport(file: File, name: String, mime: String) {
        if (saveImageToGallery(file, name, mime)) return
        if (exportPath != null) { file.delete(); error = "请先完成当前文件保存。"; return }
        exportPath = file.absolutePath
        try {
            saveFile.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mime).putExtra(Intent.EXTRA_TITLE, name))
        } catch (_: Exception) {
            exportPath = null; file.delete(); error = "无法打开文件保存窗口，请重试。"
        }
    }

    if (!webViewProvider.isCompatible) {
        LaunchedEffect(webViewProvider.packageName, webViewProvider.versionName) {
            TechnicalDiagnostics.recordWebViewInitialization(webViewProvider)
        }
        if (initialFragment.isNotEmpty()) {
            LaunchedEffect(Unit) { currentSettings(null) }
            return
        }
        WebViewRecoveryScreen(
            provider = webViewProvider,
            onRecheck = onRecheckWebView,
            onMemories = { onMemories(null) },
            onSettings = { scope.launch { currentSettings(null) } },
            onDiagnostics = { currentDiagnostics() },
        )
        return
    }
    BackHandler(viewingSettings || hasHistory || returnFromSettings != null) {
        returnFromSettings?.let { back ->
            back()
            return@BackHandler
        }
        val view = web ?: return@BackHandler
        if (view.canGoBack()) view.goBack()
        else if (viewingSettings && trustedChatPage(view.url.orEmpty())) {
            view.evaluateJavascript(
                """history.replaceState(history.state, '', location.pathname + location.search);
                   window.dispatchEvent(new HashChangeEvent('hashchange'));""", null)
            viewingSettings = false
        }
    }
    DisposableEffect(session?.token, reload) {
        onDispose {
            fileResult?.onReceiveValue(null); fileResult = null
            capturePath?.let(::File)?.delete(); capturePath = null
            audioRequest?.deny(); audioRequest = null
        }
    }
    LaunchedEffect(continuation?.id, browser, session?.token) {
        browser?.continuation(continuation)
    }
    val host = browser
    LaunchedEffect(sharedImport?.id, host, host?.archiveReady, session?.token) {
        val batch = sharedImport ?: return@LaunchedEffect
        if (host == null || !host.archiveReady || batch.recipient != continuationRecipient(session?.user?.id)) return@LaunchedEffect
        try {
            val sources = sourceConversations.associateBy { it.id }
            for (id in batch.conversationIds) {
                val source = sources[id] ?: error("导入的会话尚未就绪，请重新加载。")
                val text = withContext(Dispatchers.Default) { source.chatImportJson() }
                var offset = 0
                while (offset < text.length) {
                    var end = minOf(offset + 64000, text.length)
                    if (end < text.length && text[end-1].isHighSurrogate()) end--
                    host.importFrame(buildJsonObject {
                        put("source", id); put("offset", offset); put("text", text.substring(offset, end)); put("last", end == text.length)
                    })
                    offset = end
                }
            }
            host.importFrame(buildJsonObject { put("finished", true) })
            onImportSaved(batch.id, batch.conversationIds.size)
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            if (cancelled !is kotlinx.coroutines.TimeoutCancellationException) throw cancelled
            TechnicalDiagnostics.record("import", "timeout", "save")
            error = "聊天列表保存超时，请重新加载以继续。"
        } catch (failure: Exception) {
            TechnicalDiagnostics.failure("import", "save", failure)
            error = failure.message ?: "聊天列表导入失败，请重新加载。"
        }
    }
    val keyboardPadding = if (webViewHandlesIme) Modifier else Modifier.imePadding()
    Column(Modifier.fillMaxSize().then(keyboardPadding)) {
        if (!pageReady || rendererGone) {
            ChatStartupPanel(
                error = error,
                onRetry = { reload++ },
                onMemories = { onMemories(null) },
                onSettings = { scope.launch { currentSettings(null) } },
                onDiagnostics = { currentDiagnostics() },
            )
        } else error?.let { message ->
            Surface(color = MaterialTheme.colorScheme.errorContainer) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                    Text(message, Modifier.padding(top = 12.dp), style = MaterialTheme.typography.bodySmall)
                    Row {
                        TextButton(onClick = { error = null; reload++ }) { Text("重新加载") }
                        TextButton(onClick = { onMemories(null) }) { Text("本机记忆") }
                        TextButton(onClick = { scope.launch { currentSettings(null) } }) { Text("本机设置") }
                    }
                    TextButton(onClick = { currentDiagnostics() }) { Text("技术诊断") }
                }
            }
        }
        if (!rendererGone) key(session?.token, reload) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = {
                    val personalMcp by lazy { PersonalMcpBridge(context) }
                    val managed = try { ChatBrowser(context,
                        onError = { error = it },
                        onRendererGone = { rendererGone = true },
                        onPageReady = {
                            pageReady = true
                            if (error == CHAT_STARTUP_DELAYED) error = null
                        },
                        onHistory = { url, canGoBack ->
                            val hash = Uri.parse(url).fragment.orEmpty()
                            val returnsToMemory = viewingSettings && hash.isEmpty() && trustedChatPage(url)
                            viewingSettings = trustedChatPage(url) && (hash == "settings" || hash.startsWith("settings/"))
                            hasHistory = canGoBack
                            if (returnsToMemory) returnFromSettings?.invoke()
                        },
                        onLoadingStarted = { pageReady = false },
                        personalImageSessionActive = {
                            session?.token == liveSession?.token && session?.user?.id == liveSession?.user?.id
                        },
                        onMessage = { raw, active, reply, personalImages ->
                            scope.launch {
                                var id = ""
                                var safeError: String? = "聊天消息格式无效。"
                                try {
                                    if (!active()) return@launch
                                    require(raw.length <= CHAT_BRIDGE_LIMIT && raw.toByteArray().size <= CHAT_BRIDGE_LIMIT) {
                                        "传递内容过大。"
                                    }
                                    val message = Json.parseToJsonElement(raw).jsonObject
                                    val type = message["type"]?.jsonPrimitive?.content
                                    if (type?.startsWith("image.") == true) {
                                        personalImages.message(type, message, raw.length)
                                        return@launch
                                    }
                                    if (type?.startsWith("mcp.") == true) {
                                        val mcpSessionActive = {
                                            active() && session?.token == liveSession?.token &&
                                                session?.user?.id == liveSession?.user?.id &&
                                                (session == null || !accountSessionExpired(session)) &&
                                                lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) &&
                                                web?.let { it.isAttachedToWindow && it.isShown && it.windowVisibility == android.view.View.VISIBLE } == true
                                        }
                                        if (mcpSessionActive()) {
                                            personalMcp.respond(type, message, raw.toByteArray(Charsets.UTF_8).size,
                                                session?.user?.id, mcpSessionActive, currentMcpAllowed,
                                                portIdentity = active)?.let(reply)
                                        }
                                        return@launch
                                    }
                                    if (type?.startsWith("personal.chat.") == true) {
                                        if (session?.token != liveSession?.token || session?.user?.id != liveSession?.user?.id) return@launch
                                        val visible = lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) &&
                                            web?.let { it.isAttachedToWindow && it.isShown && it.windowVisibility == android.view.View.VISIBLE } == true
                                        personalChatBridgeResponse(context, continuationRecipient(session?.user?.id), visible, type, message)
                                            ?.let(reply)
                                        return@launch
                                    }
                                    if (session != liveSession) return@launch
                                    require(message["version"]?.jsonPrimitive?.int == 1) { "聊天连接版本不匹配。" }
                                    id = message["id"]?.jsonPrimitive?.content.orEmpty()
                                    require(id.isNotBlank() && id.length <= 100) { "请求标识无效。" }
                                    safeError = if (type == "chat.provider" || type == "chat.theme") "未能同步聊天设置。" else null
                                    when (type) {
                                        "archive.ready" -> {
                                            require(matchesChatBridgeOwner(message["payload"]!!.jsonObject, session?.user?.id))
                                            browser?.let { host -> host.archiveReady = true; host.markPageReady() }
                                        }
                                        "diagnostics.ready" -> browser?.markPageReady()
                                        "diagnostics.record" -> {
                                            val payload = message["payload"] as? JsonObject
                                            if (payload == null || raw.length > 1024 || !TechnicalDiagnostics.recordFromWeb(payload)) {
                                                reply(bridgeAck(id, "诊断格式无效。"))
                                                return@launch
                                            }
                                        }
                                        "diagnostics.open" -> currentDiagnostics()
                                        "chat.provider", "chat.theme" -> {
                                            val payload = message["payload"] as? JsonObject ?: error("invalid payload")
                                            val expectedId = session?.user?.id ?: "local"
                                            require(matchesChatBridgeOwner(payload, session?.user?.id))
                                            if (type == "chat.theme") {
                                                val preference = payload.stringField("preference")
                                                require(preference in setOf("system", "light", "dark"))
                                                currentTheme(session?.user?.id, requireNotNull(preference))
                                            } else {
                                                val mode = payload.stringField("mode")
                                                require(mode == "personal" || mode == "managed" && session != null)
                                                val detailKeys = setOf("apiKey", "baseUrl", "model")
                                                val hasDetails = detailKeys.any(payload::containsKey)
                                                require(!hasDetails || mode == "personal" && detailKeys.all { !payload.stringField(it).isNullOrBlank() })
                                                currentProvider(expectedId, requireNotNull(mode), payload.stringField("apiKey"),
                                                    payload.stringField("baseUrl"), payload.stringField("model"))
                                            }
                                        }
                                        "organize" -> {
                                            val payload = message["payload"]!!.jsonObject
                                            val bytes = chatOrganizeImport(payload)
                                            val target = payload["sourceArchiveId"]?.jsonPrimitive?.content
                                            require(target == null || target.length <= 200) { "来源记忆标识无效。" }
                                            currentOrganize(bytes, target)
                                        }
                                        "memory.open" -> {
                                            val source = (message["payload"] as? JsonObject)?.stringField("archiveId")
                                            require(source == null || source.isNotBlank() && source.length <= 200) {
                                                "来源记忆标识无效。"
                                            }
                                            currentMemories(source)
                                        }
                                        "memory.refresh" -> {
                                            val source = (message["payload"] as? JsonObject)?.stringField("archiveId")
                                            require(source != null && source.isNotBlank() && source.length <= 200) {
                                                "来源记忆标识无效。"
                                            }
                                            val snapshot = currentReadArchive(source)
                                            if (!active() || session != liveSession) return@launch
                                            val response = bridgeAck(id, null, snapshot)
                                            require(response.toByteArray(Charsets.UTF_8).size <= CHAT_BRIDGE_LIMIT) {
                                                "续聊资料过长，请减少档案内容后再刷新。"
                                            }
                                            reply(response)
                                            return@launch
                                        }
                                        "account.open" -> currentAccount(
                                            (message["payload"] as? JsonObject)?.stringField("section") == "data"
                                        )
                                        "settings.open" -> currentSettings(NativeSettingsSection.fromPayload(message["payload"]))
                                        "share.link" -> {
                                            val link = chatShareLink(message["payload"]!!.jsonObject)
                                            val send = Intent(Intent.ACTION_SEND).setType("text/plain")
                                                .putExtra(Intent.EXTRA_TEXT, link.url)
                                                .putExtra(Intent.EXTRA_TITLE, link.title)
                                            context.startActivity(Intent.createChooser(send, "分享会话"))
                                        }
                                        "ack" -> {
                                            if (browser?.importAck(id, message) == true) return@launch
                                            if (message["ok"]?.jsonPrimitive?.boolean == true) currentSaved(id)
                                            else error = message["error"]?.jsonPrimitive?.content ?: "记忆尚未带入，请重试。"
                                            return@launch
                                        }
                                        else -> throw IllegalArgumentException("不支持的聊天操作。")
                                    }
                                    reply(bridgeAck(id, null))
                                } catch (failure: Exception) {
                                    val message = safeError ?: failure.message ?: "操作未完成，请重试。"
                                    error = message
                                    if (id.isNotBlank()) reply(bridgeAck(id, message))
                                }
                            }
                        },
                        onExport = ::stageExport,
                        onAccount = { currentAccount(false) },
                        onChooseFile = { callback, params ->
                            fileResult?.onReceiveValue(null)
                            capturePath?.let(::File)?.delete(); capturePath = null
                            fileResult = callback
                            try {
                                val imageCapture = params.isCaptureEnabled && params.acceptTypes.any { it.startsWith("image/") }
                                val intent = if (imageCapture) {
                                    val directory = File(context.cacheDir, "chat-captures").apply { mkdirs() }
                                    // Retain successful captures while WebView may still be reading them.
                                    directory.listFiles()?.filter { it.lastModified() < System.currentTimeMillis() - 86_400_000 }
                                        ?.forEach { it.delete() }
                                    val capture = File.createTempFile("camera-", ".jpg", directory)
                                    capturePath = capture.absolutePath
                                    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", capture)
                                    Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri)
                                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                                        .apply { clipData = ClipData.newRawUri("chat-camera", uri) }
                                } else params.createIntent()
                                chooseFile.launch(intent)
                            } catch (_: Exception) {
                                TechnicalDiagnostics.record("attachment", "operation_failed", "initialize")
                                capturePath?.let(::File)?.delete(); capturePath = null
                                callback.onReceiveValue(null); fileResult = null
                                error = if (params.isCaptureEnabled) "无法打开相机，请从相册或文件选择图片。" else "无法打开文件选择器。"
                            }
                        },
                        onMicrophone = { request ->
                            if (audioRequest != null) request.deny()
                            else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                                request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                            else {
                                audioRequest = request
                                if (!audioPermissionPending) {
                                    audioPermissionPending = true
                                    try {
                                        recordAudio.launch(Manifest.permission.RECORD_AUDIO)
                                    } catch (_: Exception) {
                                        audioPermissionPending = false
                                        audioRequest = null
                                        request.deny()
                                    }
                                }
                            }
                        },
                        onMicrophoneCanceled = { request ->
                            if (audioRequest === request) audioRequest = null
                        },
                    ) } catch (failure: RuntimeException) {
                        TechnicalDiagnostics.failure("webview", "initialize", failure)
                        error = "无法启动聊天页面，请重试。"
                        null
                    }
                    if (managed == null) {
                        android.view.View(context)
                    } else {
                        browser = managed; web = managed.view
                        managed.continuation(continuation)
                        managed.load(session, initialFragment)
                        managed.view.apply { tag = managed }
                    }
                },
                onRelease = { released ->
                    (released.tag as? ChatBrowser)?.close()
                    released.tag = null
                    if (web === released) { web = null; browser = null }
                    (released as? WebView)?.destroy()
                },
            )
        }
    }
}

internal fun parseChatFilePickerResult(resultCode: Int, data: Intent?, packageName: String): Array<Uri>? {
    // WebView's default parser reads only Intent.data. Gallery and Files can return ClipData instead.
    return ActivityResultContracts.GetMultipleContents().parseResult(resultCode, data)
        .filter { it.scheme == ContentResolver.SCHEME_CONTENT && it.host != null && it.host != "$packageName.files" }
        .takeIf { it.isNotEmpty() }
        ?.toTypedArray()
}

private fun JsonObject.stringField(name: String): String? = (get(name) as? JsonPrimitive)?.takeIf { it.isString }?.content

internal fun bridgeAck(id: String, error: String?, payload: JsonObject? = null) = buildJsonObject {
    put("version", 1); put("id", id); put("type", "ack"); put("ok", error == null)
    if (error != null) put("error", error)
    if (payload != null) put("payload", payload)
}.toString()

internal fun trustedChatPage(url: String): Boolean = runCatching {
    val uri = Uri.parse(url)
    uri.scheme == "https" && uri.host == "digimonlegend.com" && (uri.port == -1 || uri.port == 443) &&
        uri.userInfo == null && uri.path == "/deepseek/"
}.getOrDefault(false)

internal class ChatVisualReadiness {
    private enum class State { INACTIVE, WAITING_FOR_PAGE, WAITING_FOR_DRAW }

    private var generation = 0L
    private var state = State.INACTIVE

    fun beginNavigation() {
        generation++
        state = State.WAITING_FOR_PAGE
    }

    fun requestDraw(): Long? {
        if (state != State.WAITING_FOR_PAGE) return null
        state = State.WAITING_FOR_DRAW
        return generation
    }

    val waitingForDraw: Boolean get() = state == State.WAITING_FOR_DRAW

    fun confirmDraw(requestId: Long): Boolean {
        if (state != State.WAITING_FOR_DRAW || requestId != generation) return false
        invalidate()
        return true
    }

    fun invalidate() {
        state = State.INACTIVE
    }
}

@SuppressLint("SetJavaScriptEnabled", "InflateParams")
private class ChatBrowser(
    private val context: Context,
    private val onError: (String) -> Unit,
    private val onRendererGone: () -> Unit,
    private val onPageReady: () -> Unit,
    private val onLoadingStarted: () -> Unit,
    private val onHistory: (String, Boolean) -> Unit,
    private val personalImageSessionActive: () -> Boolean,
    private val onMessage: (String, () -> Boolean, (String) -> Unit, PersonalImageChannel) -> Unit,
    private val onExport: (File, String, String) -> Unit,
    private val onAccount: () -> Unit,
    private val onChooseFile: (ValueCallback<Array<Uri>>, WebChromeClient.FileChooserParams) -> Unit,
    private val onMicrophone: (PermissionRequest) -> Unit,
    private val onMicrophoneCanceled: (PermissionRequest) -> Unit,
) {
    // Chromium reads contentSensitivity during WebView initialization.
    val view = LayoutInflater.from(context).inflate(R.layout.chat_webview, null, false) as WebView
    private var port: WebMessagePort? = null
    private var personalImages: PersonalImageChannel? = null
    private var pending: ChatContinuationDraft? = null
    private var sentId: String? = null
    private var exportPort: WebMessagePort? = null
    private var transfer: ChatBlobTransfer? = null
    private var disposed = false
    private var rendererGone = false
    private var loadStage: String? = null
    private var loadStartedAt = 0L
    private val visualReadiness = ChatVisualReadiness()
    private val startupTimeout = Runnable {
        val stage = loadStage ?: return@Runnable
        if (disposed || rendererGone) return@Runnable
        val detail = when (stage) {
            "navigate" -> "webview_navigation"
            "document" -> "webview_document"
            else -> if (visualReadiness.waitingForDraw) "webview_visual_callback" else "webview_page_ready"
        }
        TechnicalDiagnostics.record("webview", "timeout", stage, elapsedMs = loadElapsed(), detail = detail)
        onError(CHAT_STARTUP_DELAYED)
        finishLoading()
    }
    private val scrollCapture = installChatScrollCapture(view) {
        !disposed && trustedChatPage(view.url.orEmpty())
    }

    init {
        view.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true
            allowFileAccess = false; allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString ${TechnicalDiagnostics.USER_AGENT_MARKER}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(web: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return true
                val uri = request.url
                if (uri.host == "digimonlegend.com" && uri.scheme == "https" &&
                    uri.path?.startsWith("/deepseek-api/chat/") == true) { onAccount(); return true }
                if (trustedChatPage(uri.toString())) return false
                if (uri.scheme in setOf("https", "http")) runCatching {
                    context.startActivity(Intent(Intent.ACTION_VIEW, uri))
                }
                return true
            }
            override fun shouldInterceptRequest(web: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (request.url.scheme in setOf("file", "content")) return WebResourceResponse("text/plain", "utf-8", "".byteInputStream())
                return super.shouldInterceptRequest(web, request)
            }
            override fun doUpdateVisitedHistory(web: WebView, url: String, isReload: Boolean) {
                onHistory(url, web.canGoBack())
            }
            override fun onPageStarted(web: WebView, url: String, favicon: android.graphics.Bitmap?) {
                scrollCapture?.reset()
                resetPorts()
                if (loadStage != "navigate") beginLoading()
                loadStage = "document"
            }
            override fun onPageFinished(web: WebView, url: String) {
                if (loadStage == "document") loadStage = "render"
                onHistory(url, web.canGoBack())
                // Same-document history updates can also finish. Keep the active channels for this page.
                if (port == null && !disposed && !rendererGone && trustedChatPage(url) && trustedChatPage(web.url.orEmpty())) {
                    try {
                        connect()
                    } catch (error: RuntimeException) {
                        resetPorts()
                        renderFailed(error)
                    }
                }
            }
            override fun onReceivedError(web: WebView, request: WebResourceRequest, error: WebResourceError) {
                val stage = if (request.isForMainFrame) "document" else if (isChatAsset(request.url)) "render" else return
                TechnicalDiagnostics.record("webview", if (error.errorCode == WebViewClient.ERROR_TIMEOUT) "timeout" else "load_failed",
                    stage, elapsedMs = loadElapsed())
                if (request.isForMainFrame) {
                    failLoading()
                    onError("聊天暂时无法连接，请检查网络后重试。")
                }
            }
            override fun onReceivedHttpError(web: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                val stage = if (request.isForMainFrame) "document" else if (isChatAsset(request.url)) "render" else return
                if (response.statusCode < 400) return
                TechnicalDiagnostics.record("webview", "http_error", stage, response.statusCode, loadElapsed())
                if (request.isForMainFrame) {
                    failLoading()
                    onError("页面暂时无法加载，请重试或打开本机设置。")
                }
            }
            override fun onReceivedSslError(web: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
                handler.cancel()
                TechnicalDiagnostics.record("webview", "load_failed", loadStage ?: "document", elapsedMs = loadElapsed())
                failLoading()
                onError("安全连接未建立，请稍后重试。")
            }
            override fun onRenderProcessGone(web: WebView, detail: RenderProcessGoneDetail): Boolean {
                rendererGone = true
                TechnicalDiagnostics.record("webview", "render_gone", loadStage ?: "render", elapsedMs = loadElapsed())
                failLoading()
                onError("聊天页面意外关闭，请重新加载。")
                onRendererGone()
                return true
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(web: WebView, callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
                if (!trustedChatPage(web.url.orEmpty())) return false
                onChooseFile(callback, params); return true
            }
            override fun onPermissionRequest(request: PermissionRequest) {
                if (trustedChatPage(view.url.orEmpty()) && request.origin.toString().trimEnd('/') == CHAT_ORIGIN &&
                    request.resources.toSet() == setOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) onMicrophone(request)
                else request.deny()
            }
            override fun onPermissionRequestCanceled(request: PermissionRequest) { onMicrophoneCanceled(request) }
        }
        view.setDownloadListener { url, _, _, _, _ ->
            if (url.startsWith("blob:$CHAT_ORIGIN/")) view.evaluateJavascript(
                "window.__deepseekNativeBlobDownload && window.__deepseekNativeBlobDownload(${JsonPrimitive(url)}, '');", null)
            else onError("请使用聊天中的导出或保存图片按钮。")
        }
    }

    fun load(session: AccountSession?, initialFragment: String) {
        require(initialFragment.isEmpty() || NativeSettingsSection.entries.any { it.returnFragment == initialFragment })
        // The cookie is HttpOnly: React never receives or stores the native account token.
        val cookie = if (session != null)
            "deepseek_session=${session.token}; Path=/deepseek-api; Secure; HttpOnly; SameSite=Strict"
        else "deepseek_session=; Path=/deepseek-api; Max-Age=0; Secure; HttpOnly; SameSite=Strict"
        beginLoading()
        try {
            CookieManager.getInstance().setCookie(CHAT_API, cookie) {
                if (!disposed && !rendererGone) {
                    try {
                        CookieManager.getInstance().flush()
                        view.loadUrl(CHAT_PAGE + initialFragment)
                    } catch (error: RuntimeException) { navigationFailed(error) }
                }
            }
        } catch (error: RuntimeException) { navigationFailed(error) }
    }

    private fun beginLoading() {
        view.removeCallbacks(startupTimeout)
        visualReadiness.beginNavigation()
        loadStartedAt = SystemClock.elapsedRealtime()
        loadStage = "navigate"
        onLoadingStarted()
        view.postDelayed(startupTimeout, TechnicalDiagnostics.STARTUP_TIMEOUT_MS)
    }

    private fun finishLoading() {
        view.removeCallbacks(startupTimeout)
        loadStage = null
    }

    fun markPageReady() {
        if (disposed || rendererGone || !trustedChatPage(view.url.orEmpty())) return
        val requestId = visualReadiness.requestDraw() ?: return
        // The bridge runs before WebView's visual state necessarily contains the updated DOM.
        // Keep the watchdog active until the same navigation is ready for the next draw.
        try {
            view.postVisualStateCallback(requestId, object : WebView.VisualStateCallback() {
                override fun onComplete(requestId: Long) {
                    if (disposed || rendererGone || !trustedChatPage(view.url.orEmpty())) return
                    if (!visualReadiness.confirmDraw(requestId)) return
                    finishLoading()
                    onPageReady()
                }
            })
        } catch (error: RuntimeException) {
            renderFailed(error)
        }
    }

    private fun loadElapsed() = if (loadStage == null) null else SystemClock.elapsedRealtime() - loadStartedAt

    private fun navigationFailed(error: RuntimeException) {
        TechnicalDiagnostics.failure("webview", "navigate", error)
        failLoading()
        onError("无法启动聊天页面，请重新加载。")
    }

    private fun renderFailed(error: RuntimeException) {
        TechnicalDiagnostics.failure("webview", "render", error)
        failLoading()
        onError("聊天页面无法完成显示，请重新加载。")
    }

    private fun failLoading() {
        visualReadiness.invalidate()
        finishLoading()
    }

    private fun isChatAsset(uri: Uri): Boolean {
        val path = uri.path.orEmpty()
        return uri.scheme == "https" && uri.host == "digimonlegend.com" && uri.port in setOf(-1, 443) &&
            (path.startsWith("/deepseek/static/js/") || path.startsWith("/deepseek/static/css/"))
    }

    fun continuation(draft: ChatContinuationDraft?) { pending = draft; sendPending() }

    var archiveReady by mutableStateOf(false)
    private var frameAck: Pair<String, CompletableDeferred<Unit>>? = null
    suspend fun importFrame(payload: JsonObject) {
        val channel = checkNotNull(port)
        check(archiveReady && trustedChatPage(view.url.orEmpty()))
        val id = "archive-${UUID.randomUUID()}"
        val ack = CompletableDeferred<Unit>()
        frameAck = id to ack
        try {
            channel.postMessage(WebMessage(buildJsonObject {
                put("version", 1); put("id", id); put("type", "archive.frame"); put("payload", payload)
            }.toString()))
            withTimeout(60000) { ack.await() }
        } finally { if (frameAck?.first == id) frameAck = null }
    }
    fun importAck(id: String, message: JsonObject): Boolean {
        if (!id.startsWith("archive-")) return false
        val ack = frameAck?.takeIf { it.first == id }?.second ?: return true
        if (message["ok"]?.jsonPrimitive?.boolean == true) ack.complete(Unit)
        else ack.completeExceptionally(IllegalStateException(message["error"]?.jsonPrimitive?.content ?: "保存失败"))
        return true
    }

    private fun connect() {
        val channels = view.createWebMessageChannel()
        val local = channels[0]
        port = local
        val active = { !disposed && !rendererGone && local === port && trustedChatPage(view.url.orEmpty()) }
        val images = PersonalImageChannel(
            active = { active() && personalImageSessionActive() },
            post = { local.postMessage(WebMessage(it)) },
        )
        personalImages = images
        local.setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
            override fun onMessage(received: WebMessagePort, message: WebMessage) {
                if (received === local && active())
                    onMessage(message.data.orEmpty(), active, { reply ->
                        if (active()) runCatching { received.postMessage(WebMessage(reply)) }
                    }, images)
            }
        })
        val hello = buildJsonObject {
            put("type", "deepseek.connect")
            put("version", 1)
            put("settingsSections", true)
            put("archiveImport", true)
            put("chatProvider", true)
            put("themePreference", true)
            put("memoryRefresh", true)
            put("organizationUsesChatProvider", true)
            put("imageOverlayHistory", true)
            put("personalImage", true)
            put("diagnostics", true)
        }
        view.postWebMessage(WebMessage(hello.toString(), arrayOf(channels[1])), Uri.parse(CHAT_ORIGIN))
        // Deployed pages accept at most 256 characters in the initial handshake.
        val capabilities = buildJsonObject {
            put("version", 1)
            put("id", "personal-chat-capability")
            put("type", "personal.chat.capability")
            put("personalBackgroundChat", true)
        }
        runCatching { local.postMessage(WebMessage(capabilities.toString())) }
        val mcpCapability = buildJsonObject {
            put("version", 1)
            put("id", "personal-mcp-capability")
            put("type", "personal.mcp.capability")
            put("personalMcp", true)
            put("personalMcpActions", true)
        }
        runCatching { local.postMessage(WebMessage(mcpCapability.toString())) }
        sendPending()
        connectExport()
    }

    private fun sendPending() {
        val draft = pending ?: return
        val channel = port ?: return
        if (sentId == draft.id) return
        runCatching { channel.postMessage(WebMessage(draft.message())); sentId = draft.id }
            .onFailure { onError("记忆暂时未能带入，请重新加载聊天。") }
    }

    private fun connectExport() {
        val nonce = UUID.randomUUID().toString()
        val script = context.assets.open("chat-export-bridge.js").bufferedReader().use { it.readText() }
            .replace("__DEEPSEEK_NATIVE_NONCE__", nonce)
        view.evaluateJavascript(script) {
            if (disposed || !trustedChatPage(view.url.orEmpty())) return@evaluateJavascript
            val channels = view.createWebMessageChannel()
            exportPort = channels[0]
            channels[0].setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                override fun onMessage(received: WebMessagePort, message: WebMessage) {
                    if (disposed || received !== exportPort || !trustedChatPage(view.url.orEmpty())) return
                    var id = 0
                    var failure: String? = null
                    try {
                        val raw = message.data.orEmpty()
                        require(raw.length <= 100000)
                        val item = Json.parseToJsonElement(raw).jsonObject
                        id = item["id"]!!.jsonPrimitive.int
                        when (item["type"]!!.jsonPrimitive.content) {
                            "start" -> {
                                check(transfer == null) { "请先完成当前导出。" }
                                transfer = ChatBlobTransfer(context, item)
                            }
                            "chunk" -> (transfer ?: error("文件传输尚未开始。"))
                                .append(item["data"]!!.jsonPrimitive.content)
                            "finish" -> {
                                val saved = transfer ?: error("文件传输尚未开始。")
                                saved.finish(); transfer = null
                                onExport(saved.file, saved.name, saved.mime)
                            }
                            "cancel" -> { transfer?.cancel(); transfer = null }
                            else -> error("未知的文件传输操作。")
                        }
                    } catch (error: Exception) {
                        failure = error.message ?: "文件导出失败，请重试。"
                        transfer?.cancel(); transfer = null
                    }
                    runCatching { received.postMessage(WebMessage(buildJsonObject {
                        put("id", id); put("ok", failure == null); failure?.let { put("error", it) }
                    }.toString())) }
                }
            })
            view.postWebMessage(WebMessage(nonce, arrayOf(channels[1])), Uri.parse(CHAT_ORIGIN))
        }
    }

    private fun resetPorts() {
        archiveReady = false
        frameAck?.second?.cancel(); frameAck = null
        personalImages?.close(); personalImages = null
        runCatching { port?.close() }; port = null; sentId = null
        runCatching { exportPort?.close() }; exportPort = null
        transfer?.cancel(); transfer = null
    }

    fun close() {
        disposed = true
        view.removeCallbacks(startupTimeout)
        scrollCapture?.close()
        resetPorts()
        if (!rendererGone) view.stopLoading()
    }
}

private class ChatBlobTransfer(context: Context, item: JsonObject) {
    val mime = item["mime"]!!.jsonPrimitive.content
    private val expected = item["size"]!!.jsonPrimitive.long
    val name: String
    val file: File
    private val out: java.io.OutputStream
    private var received = 0L
    init {
        val extension = when (mime) {
            "application/zip" -> ".zip"; "image/png" -> ".png"; "image/jpeg" -> ".jpg"
            "image/webp" -> ".webp"; "image/gif" -> ".gif"
            "text/markdown" -> ".md"; "text/plain" -> ".txt"; "application/json" -> ".json"
            else -> error("不支持的文件类型。")
        }
        require(expected in 1..(128L * 1024 * 1024)) { "文件为空或超过 128 MB。" }
        name = item["name"]!!.jsonPrimitive.content.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[\\p{Cntrl}<>:\"/\\\\|?*]"), "_").take(120).substringBeforeLast('.', "deepseek-export") + extension
        file = File(context.cacheDir, "chat-exports").apply { mkdirs() }.let { File.createTempFile("export-", extension, it) }
        out = file.outputStream()
    }
    fun append(encoded: String) {
        val bytes = android.util.Base64.decode(encoded, android.util.Base64.DEFAULT)
        require(bytes.isNotEmpty() && bytes.size <= 49152 && received + bytes.size <= expected) { "文件块长度无效。" }
        out.write(bytes); received += bytes.size
    }
    fun finish() {
        out.close()
        require(received == expected) { "文件尚未传输完整。" }
        val head = file.inputStream().use { input -> ByteArray(12).let { bytes -> bytes.copyOf(input.read(bytes).coerceAtLeast(0)) } }
        val valid = when (mime) {
            "application/zip" -> head.size >= 4 && head[0] == 0x50.toByte() && head[1] == 0x4b.toByte()
            "image/png" -> head.take(8).toByteArray().contentEquals(byteArrayOf(-119,80,78,71,13,10,26,10))
            "image/jpeg" -> head.size >= 3 && head[0] == (-1).toByte() && head[1] == (-40).toByte()
            "image/gif" -> String(head.take(6).toByteArray()).startsWith("GIF8")
            "image/webp" -> String(head.take(4).toByteArray()) == "RIFF" && String(head.drop(8).toByteArray()) == "WEBP"
            "text/markdown", "text/plain", "application/json" -> validUtf8Text(file)
            else -> false
        }
        require(valid) { "文件内容与类型不符。" }
    }
    fun cancel() { runCatching { out.close() }; file.delete() }
}

private fun validUtf8Text(file: File): Boolean = runCatching {
    val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
        .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
    java.io.InputStreamReader(file.inputStream(), decoder).use { reader ->
        val buffer = CharArray(8192)
        while (true) {
            val count = reader.read(buffer)
            if (count < 0) break
            require((0 until count).none { buffer[it] == '\u0000' })
        }
    }
    true
}.getOrDefault(false)
