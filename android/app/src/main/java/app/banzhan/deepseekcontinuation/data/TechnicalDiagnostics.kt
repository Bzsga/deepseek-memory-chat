package app.banzhan.deepseekcontinuation.data

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.SystemClock
import android.util.AtomicFile
import app.banzhan.deepseekcontinuation.BuildConfig
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

internal enum class DiagnosticChoice { UNDECIDED, ENABLED, DISABLED }

@Serializable
internal data class TechnicalDiagnosticEvent(
    @SerialName("event_id") val id: String,
    @SerialName("occurred_at") val occurredAt: Long,
    val source: String,
    val release: String,
    val area: String,
    val code: String,
    val stage: String? = null,
    @SerialName("android_sdk") val androidSdk: Int? = null,
    val manufacturer: String? = null,
    val model: String? = null,
    @SerialName("webview_version") val webViewVersion: String? = null,
    @SerialName("webview_provider") val webViewProvider: String? = null,
    @SerialName("http_status") val httpStatus: Int? = null,
    @SerialName("elapsed_ms") val elapsedMs: Long? = null,
    @SerialName("request_id") val requestId: String? = null,
    val detail: String? = null,
    @SerialName("input_format") val inputFormat: String? = null,
    @SerialName("input_size_band") val inputSizeBand: String? = null,
    @SerialName("service_mode") val serviceMode: String? = null,
)

@Serializable
private data class PendingDiagnostics(
    val latest: TechnicalDiagnosticEvent? = null,
    val pending: List<TechnicalDiagnosticEvent> = emptyList(),
)

@Serializable
private data class DiagnosticsBatch(val events: List<TechnicalDiagnosticEvent>)

@Serializable
private data class DiagnosticsAcknowledgement(@SerialName("accepted_event_ids") val accepted: List<String>)

/** Device-scoped queue, with authorization checked immediately before issuing an HTTP call. */
internal object TechnicalDiagnostics {
    const val USER_AGENT_MARKER = "DeepSeekNativeDiagnostics/1"
    const val STARTUP_TIMEOUT_MS = 20_000L
    private const val DAYS_TO_KEEP = 30L * 24 * 3600
    private const val MAX_PENDING = 48
    private const val MAX_RESPONSE = 8192L
    private const val URL = "https://digimonlegend.com/deepseek-api/v1/technical-diagnostics/events"
    private const val PREF_CHOICE = "automatic_diagnostics"
    private val areas = setOf("startup", "webview", "runtime", "chat", "image", "import", "attachment",
        "account", "sync", "update", "organization")
    private val codes = setOf("timeout", "load_failed", "http_error", "network_error", "crash", "render_gone",
        "invalid_response", "operation_failed", "storage_error", "integrity_error", "unexpected_error", "update_required")
    private val stages = setOf("initialize", "navigate", "document", "render", "request", "response",
        "download", "verify", "save", "read", "parse", "upload", "apply", "install")
    private val releasePattern = Regex("[A-Za-z0-9._+\\-]{1,80}")
    private val webViewPattern = Regex("[0-9]{1,4}(?:\\.[0-9]{1,10}){0,5}")
    private val webViewProviderPattern = Regex("[A-Za-z0-9_.]{1,120}")
    private val idPattern = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true }
    private val gate = Any()
    private val reportedWebViewProblems = mutableSetOf<Pair<String?, String?>>()
    private val sending = Mutex()
    private var preferences: SharedPreferences? = null
    private var file: AtomicFile? = null
    private var state = PendingDiagnostics()
    private var automaticCall: Call? = null
    private var lastAttempt: Long? = null
    private var initialized = false
    @Volatile private var webViewDetails: Pair<String?, String?> = null to null
    private val currentChoice = MutableStateFlow(DiagnosticChoice.UNDECIDED)
    private val currentLatest = MutableStateFlow<TechnicalDiagnosticEvent?>(null)
    val choice = currentChoice.asStateFlow()
    val latest = currentLatest.asStateFlow()

    private val client by lazy {
        OkHttpClient.Builder().retryOnConnectionFailure(false).followRedirects(false).followSslRedirects(false)
            .callTimeout(12, TimeUnit.SECONDS).build()
    }

    fun initialize(context: Context) = synchronized(gate) {
        if (initialized) return@synchronized
        initialized = true
        val prefs = context.getSharedPreferences("technical-diagnostics", Context.MODE_PRIVATE)
        preferences = prefs
        currentChoice.value = when (prefs.getString(PREF_CHOICE, null)) {
            "enabled" -> DiagnosticChoice.ENABLED
            "disabled" -> DiagnosticChoice.DISABLED
            else -> DiagnosticChoice.UNDECIDED
        }
        val storage = AtomicFile(File(context.noBackupFilesDir, "technical-diagnostics.json"))
        file = storage
        state = runCatching {
            if (storage.baseFile.length() > 65_536) PendingDiagnostics()
            else json.decodeFromString<PendingDiagnostics>(storage.readFully().decodeToString())
        }.getOrDefault(PendingDiagnostics()).recent()
        currentLatest.value = state.latest
        Unit
    }

    fun setWebViewProvider(packageName: String?, version: String?) {
        webViewDetails = webViewMetadata(packageName, version)
    }

    private fun webViewMetadata(packageName: String?, version: String?) =
        version?.take(40)?.takeIf(webViewPattern::matches) to packageName?.takeIf(webViewProviderPattern::matches)

    fun recordWebViewInitialization(provider: ChatWebViewProvider): Boolean {
        if (provider.isCompatible) return false
        val (version, packageName) = webViewMetadata(provider.packageName, provider.versionName)
        val metadata = (version ?: provider.majorVersion?.toString()) to packageName
        if (!synchronized(gate) { reportedWebViewProblems.add(metadata) }) return false
        val code = if (provider.packageName == null) "load_failed" else "update_required"
        val event = createEvent("webview", code, "initialize", webView = metadata) ?: return false
        scope.launch { append(event); requestUpload() }
        return true
    }

    suspend fun choose(enabled: Boolean): Boolean = withContext(Dispatchers.IO) {
        val saved = synchronized(gate) {
            val before = currentChoice.value
            if (!enabled) {
                currentChoice.value = DiagnosticChoice.DISABLED
                automaticCall?.cancel()
            }
            val configured = if (enabled) "enabled" else "disabled"
            val stored = preferences?.edit()?.putString(PREF_CHOICE, configured)?.commit() == true
            if (enabled && stored) {
                currentChoice.value = DiagnosticChoice.ENABLED
                if (before != DiagnosticChoice.ENABLED) lastAttempt = null
            }
            stored
        }
        if (enabled && saved) requestUpload()
        saved
    }

    fun record(area: String, code: String, stage: String? = null, httpStatus: Int? = null,
        elapsedMs: Long? = null, detail: String? = null, inputFormat: String? = null,
        inputSizeBand: String? = null, serviceMode: String? = null, requestId: String? = null) {
        val event = createEvent(area, code, stage, httpStatus, elapsedMs,
            requestId = requestId?.takeIf(idPattern::matches), detail = detail, inputFormat = inputFormat,
            inputSizeBand = inputSizeBand, serviceMode = serviceMode) ?: return
        scope.launch { append(event); requestUpload() }
    }

    fun crash() {
        // Only capture fixed values here. The uncaught handler must never wait for the network.
        createEvent("runtime", "crash", null)?.let(::append)
    }

    fun failure(area: String, stage: String, error: Throwable, unexpectedOnly: Boolean = false,
        elapsedMs: Long? = null, detail: String? = null, inputFormat: String? = null,
        inputSizeBand: String? = null, serviceMode: String? = null) {
        if (error is CancellationException) return
        val summary = error as? SummaryFailure
        val status = summary?.statusCode
        if (unexpectedOnly && status != null && status in 400..499 && status != 408) return
        val code = when {
            error is InterruptedIOException || summary?.timedOut == true || status == 408 || status == 504 -> "timeout"
            status != null -> "http_error"
            summary?.failureDetail == "invalid_model_response" ||
                PersonalSummaryResponseFailure.entries.any { it.detail == summary?.failureDetail } ||
                error is kotlinx.serialization.SerializationException -> "invalid_response"
            error is IOException -> "network_error"
            else -> "operation_failed"
        }
        record(area, code, stage, status, elapsedMs, detail, inputFormat, inputSizeBand, serviceMode,
            requestId = if (serviceMode == "managed") summary?.requestId else null)
    }

    fun recordFromWeb(payload: JsonObject): Boolean {
        val allowed = setOf("area", "code", "release", "stage", "http_status", "request_id")
        if (!payload.keys.all(allowed::contains)) return false
        fun text(name: String) = (payload[name] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        val release = text("release")?.takeIf(releasePattern::matches) ?: return false
        val area = text("area")?.takeIf(areas::contains) ?: return false
        val code = text("code")?.takeIf(codes::contains) ?: return false
        val stage = text("stage")?.takeIf(stages::contains)
        val status = (payload["http_status"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull?.takeIf { it in 100..599 }
        val requestId = text("request_id")?.takeIf(idPattern::matches)
        if ("stage" in payload && stage == null || "http_status" in payload && status == null ||
            "request_id" in payload && requestId == null) return false
        val event = createEvent(area, code, stage, status, source = "web", release = release, requestId = requestId)
            ?: return false
        scope.launch { append(event); requestUpload() }
        return true
    }

    private fun createEvent(area: String, code: String, stage: String?, httpStatus: Int? = null,
        elapsedMs: Long? = null, source: String = "android",
        release: String = "${DiagnosticPrivacy.version(BuildConfig.VERSION_NAME)}+${BuildConfig.VERSION_CODE}",
        requestId: String? = null, webView: Pair<String?, String?> = webViewDetails,
        detail: String? = null, inputFormat: String? = null, inputSizeBand: String? = null,
        serviceMode: String? = null): TechnicalDiagnosticEvent? {
        if (area !in areas || code !in codes || stage != null && stage !in stages) return null
        if (code == "update_required" && (source != "android" || area != "webview" || stage != "initialize")) return null
        val (webViewVersion, webViewProvider) = webView
        return TechnicalDiagnosticEvent(UUID.randomUUID().toString(), now(), source, release, area, code, stage,
            Build.VERSION.SDK_INT, DiagnosticPrivacy.device(Build.MANUFACTURER.orEmpty()).ifBlank { null },
            DiagnosticPrivacy.device(Build.MODEL.orEmpty()).ifBlank { null }, webViewVersion, webViewProvider,
            httpStatus?.takeIf { it in 100..599 }, elapsedMs?.coerceIn(0, 86_400_000), requestId,
            detail, inputFormat, inputSizeBand, serviceMode)
    }

    private fun append(event: TechnicalDiagnosticEvent) {
        synchronized(gate) {
            val pending = (state.recent().pending + event).takeLast(MAX_PENDING)
            state = PendingDiagnostics(event, pending)
            currentLatest.value = event
            persist()
        }
    }

    private fun now() = System.currentTimeMillis() / 1000

    private fun PendingDiagnostics.recent(): PendingDiagnostics {
        val cutoff = now() - DAYS_TO_KEEP
        return PendingDiagnostics(latest?.takeIf { it.occurredAt >= cutoff },
            pending.filter { it.occurredAt >= cutoff }.takeLast(MAX_PENDING))
    }

    private fun persist() {
        val storage = file ?: return
        val output = runCatching { storage.startWrite() }.getOrNull() ?: return
        try {
            output.write(json.encodeToString(state).encodeToByteArray())
            storage.finishWrite(output)
        } catch (_: Throwable) { storage.failWrite(output) }
    }

    fun requestUpload() {
        if (choice.value != DiagnosticChoice.ENABLED) return
        scope.launch {
            if (!sending.tryLock()) return@launch
            try {
                val mayStart = synchronized(gate) {
                    val time = SystemClock.elapsedRealtime()
                    val recent = state.recent()
                    if (recent != state) {
                        state = recent
                        currentLatest.value = state.latest
                        persist()
                    }
                    if (currentChoice.value != DiagnosticChoice.ENABLED || state.pending.isEmpty() ||
                        lastAttempt?.let { time - it < 30_000 } == true) false
                    else {
                        lastAttempt = time
                        true
                    }
                }
                if (!mayStart) return@launch
                repeat(5) {
                    val batch = synchronized(gate) { state.pending.take(10) }
                    if (batch.isEmpty() || send(batch, automatic = true).isEmpty()) return@launch
                }
            } finally { sending.unlock() }
        }
    }

    /** Explicit preview confirmation authorizes only the displayed event. */
    suspend fun sendOnce(event: TechnicalDiagnosticEvent): Boolean = withContext(Dispatchers.IO) {
        sending.withLock { event.occurredAt >= now() - DAYS_TO_KEEP && event.id in send(listOf(event), automatic = false) }
    }

    private fun send(events: List<TechnicalDiagnosticEvent>, automatic: Boolean): Set<String> {
        val payload = json.encodeToString(DiagnosticsBatch(events))
        val request = Request.Builder().url(URL)
            .post(payload.toRequestBody("application/json; charset=utf-8".toMediaType())).build()
        val call = synchronized(gate) {
            if (automatic && currentChoice.value != DiagnosticChoice.ENABLED) return emptySet()
            client.newCall(request).also { if (automatic) automaticCall = it }
        }
        try {
            val accepted = call.execute().use { response ->
                if (!response.isSuccessful) return emptySet()
                val body = response.body?.source() ?: return emptySet()
                body.request(MAX_RESPONSE + 1)
                if (body.buffer.size > MAX_RESPONSE) return emptySet()
                val sent = events.mapTo(mutableSetOf()) { it.id }
                json.decodeFromString<DiagnosticsAcknowledgement>(body.readUtf8()).accepted
                    .filterTo(mutableSetOf(), sent::contains)
            }
            if (accepted.isNotEmpty()) synchronized(gate) {
                state = state.copy(pending = state.pending.filterNot { it.id in accepted })
                persist()
            }
            return accepted
        } catch (_: Exception) {
            return emptySet()
        } finally {
            synchronized(gate) { if (automaticCall === call) automaticCall = null }
        }
    }
}
