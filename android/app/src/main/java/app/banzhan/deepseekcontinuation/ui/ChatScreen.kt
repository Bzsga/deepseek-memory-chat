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

@Composable
internal fun ChatScreen(
    session: AccountSession?,
    sharedImport: PendingIncomingImport? = null,
    sourceConversations: List<ImportedConversation> = emptyList(),
    onImportSaved: (String, Int) -> Unit = { _, _ -> },
    continuation: ChatContinuationDraft?,
    onContinuationSaved: (String) -> Unit,
    onOrganize: suspend (ByteArray, String?) -> Unit,
    onMemories: () -> Unit,
    onAccount: (resumeSyncSettings: Boolean) -> Unit,
    onSettings: suspend (NativeSettingsSection?) -> Unit,
    onChatProvider: suspend (String, String, String?, String?, String?) -> Unit,
    onThemePreference: (String?, String) -> Unit,
    initialFragment: String = "",
    onReturnFromSettings: (() -> Unit)? = null,
    webViewMajor: Int,
    webViewHandlesIme: Boolean,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val currentOrganize by rememberUpdatedState(onOrganize)
    val currentMemories by rememberUpdatedState(onMemories)
    val currentAccount by rememberUpdatedState(onAccount)
    val currentSettings by rememberUpdatedState(onSettings)
    val returnFromSettings by rememberUpdatedState(onReturnFromSettings)
    val liveSession by rememberUpdatedState(session)
    val currentProvider by rememberUpdatedState(onChatProvider)
    val currentTheme by rememberUpdatedState(onThemePreference)
    val currentSaved by rememberUpdatedState(onContinuationSaved)
    var error by remember(session?.user?.id) { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(false) }
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

    if (webViewMajor in 1..104) {
        if (initialFragment.isNotEmpty()) {
            LaunchedEffect(Unit) { currentSettings(null) }
            return
        }
        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("更新系统 WebView 后开始聊天", style = MaterialTheme.typography.titleLarge)
            Text("聊天页面需要较新的 Android System WebView。本机记忆和导入资料仍可使用。")
            Button(onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW,
                Uri.parse("market://details?id=com.google.android.webview"))) }.onFailure {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.webview")))
            } }) { Text("更新 WebView") }
            TextButton(onClick = onMemories) { Text("查看本机记忆") }
            TextButton(onClick = { scope.launch { currentSettings(null) } }) { Text("本机设置") }
            TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(CHAT_PAGE))) }) { Text("在浏览器打开") }
        }
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
            if (cancelled is kotlinx.coroutines.TimeoutCancellationException) error = "聊天列表保存超时，请重新加载以继续。" else throw cancelled
        } catch (failure: Exception) { error = failure.message ?: "聊天列表导入失败，请重新加载。" }
    }
    val keyboardPadding = if (webViewHandlesIme) Modifier else Modifier.imePadding()
    Column(Modifier.fillMaxSize().then(keyboardPadding)) {
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { message ->
            Surface(color = MaterialTheme.colorScheme.errorContainer) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                    Text(message, Modifier.padding(top = 12.dp), style = MaterialTheme.typography.bodySmall)
                    Row {
                        TextButton(onClick = { error = null; reload++ }) { Text("重新加载") }
                        TextButton(onClick = onMemories) { Text("本机记忆") }
                        TextButton(onClick = { scope.launch { currentSettings(null) } }) { Text("本机设置") }
                    }
                }
            }
        }
        key(session?.token, reload) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = {
                    val managed = ChatBrowser(context,
                        onError = { error = it },
                        onHistory = { url, canGoBack ->
                            val hash = Uri.parse(url).fragment.orEmpty()
                            val returnsToMemory = viewingSettings && hash.isEmpty() && trustedChatPage(url)
                            viewingSettings = trustedChatPage(url) && (hash == "settings" || hash.startsWith("settings/"))
                            hasHistory = canGoBack
                            if (returnsToMemory) returnFromSettings?.invoke()
                        },
                        onLoading = { loading = it },
                        personalImageSessionActive = {
                            session?.token == liveSession?.token && session?.user?.id == liveSession?.user?.id
                        },
                        onMessage = { raw, active, reply, personalImages ->
                            scope.launch {
                                var id = ""
                                var safeError: String? = "聊天消息格式无效。"
                                try {
                                    if (!active()) return@launch
                                    require(raw.toByteArray().size <= CHAT_BRIDGE_LIMIT) { "传递内容过大。" }
                                    val message = Json.parseToJsonElement(raw).jsonObject
                                    val type = message["type"]?.jsonPrimitive?.content
                                    if (type?.startsWith("image.") == true) {
                                        personalImages.message(type, message, raw.length)
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
                                            browser?.archiveReady = true
                                        }
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
                                        "memory.open" -> currentMemories()
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
                    )
                    browser = managed; web = managed.view
                    managed.continuation(continuation)
                    managed.load(session, initialFragment)
                    managed.view.apply { tag = managed }
                },
                onRelease = { released ->
                    (released.tag as? ChatBrowser)?.close()
                    released.tag = null
                    if (web === released) { web = null; browser = null }
                    released.destroy()
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

private fun bridgeAck(id: String, error: String?) = buildJsonObject {
    put("version", 1); put("id", id); put("type", "ack"); put("ok", error == null)
    if (error != null) put("error", error)
}.toString()

internal fun trustedChatPage(url: String): Boolean = runCatching {
    val uri = Uri.parse(url)
    uri.scheme == "https" && uri.host == "digimonlegend.com" && (uri.port == -1 || uri.port == 443) &&
        uri.userInfo == null && uri.path == "/deepseek/"
}.getOrDefault(false)

@SuppressLint("SetJavaScriptEnabled", "InflateParams")
private class ChatBrowser(
    private val context: Context,
    private val onError: (String) -> Unit,
    private val onLoading: (Boolean) -> Unit,
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
                resetPorts(); onLoading(true)
            }
            override fun onPageFinished(web: WebView, url: String) {
                onLoading(false)
                onHistory(url, web.canGoBack())
                // Same-document history updates can also finish. Keep the active channels for this page.
                if (port == null && !disposed && trustedChatPage(url) && trustedChatPage(web.url.orEmpty())) connect()
            }
            override fun onReceivedError(web: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) { onLoading(false); onError("聊天暂时无法连接，请检查网络后重试。") }
            }
            override fun onReceivedHttpError(web: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame && response.statusCode >= 400) {
                    onLoading(false)
                    onError("页面暂时无法加载，请重试或打开本机设置。")
                }
            }
            override fun onReceivedSslError(web: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
                handler.cancel(); onLoading(false); onError("安全连接未建立，请稍后重试。")
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
        CookieManager.getInstance().setCookie(CHAT_API,
            cookie) {
            if (!disposed) { CookieManager.getInstance().flush(); view.loadUrl(CHAT_PAGE + initialFragment) }
        }
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
        val active = { !disposed && local === port && trustedChatPage(view.url.orEmpty()) }
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
        view.postWebMessage(WebMessage("{\"type\":\"deepseek.connect\",\"version\":1,\"settingsSections\":true,\"archiveImport\":true,\"chatProvider\":true,\"themePreference\":true,\"organizationUsesChatProvider\":true,\"imageOverlayHistory\":true,\"personalImage\":true}", arrayOf(channels[1])), Uri.parse(CHAT_ORIGIN))
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

    fun close() { scrollCapture?.close(); disposed = true; resetPorts(); view.stopLoading() }
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
