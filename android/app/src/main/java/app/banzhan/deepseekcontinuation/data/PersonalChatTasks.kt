package app.banzhan.deepseekcontinuation.data

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import java.io.IOException
import java.io.InterruptedIOException
import java.net.URI
import java.net.URISyntaxException
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.Buffer
import okio.BufferedSink

internal object PersonalChatTasks {
    private val jobs = PersonalChatTaskStore()

    fun start(
        context: Context, owner: String, jobId: String, url: String,
        key: String, body: String, filesBeta: Boolean,
    ): JsonObject {
        if (owner.isBlank() || owner.length > 256 || !jobIdPattern.matches(jobId)) {
            return failedChat("personal_chat_invalid_request", "个人 API 聊天请求编号无效。")
        }
        val request = personalChatRequest(url, key, body, filesBeta)
            ?: return failedChat("personal_chat_invalid_request", "请检查个人 API 地址、Key 和消息大小。")
        return jobs.start(owner, jobId, request) {
            val app = context.applicationContext
            checkNotNull(ContextCompat.startForegroundService(app, Intent(app, PersonalChatService::class.java)))
        }
    }

    fun read(owner: String, jobId: String, offset: Int): JsonObject = jobs.read(owner, jobId, offset)

    fun cancel(owner: String, jobId: String): JsonObject = jobs.cancel(owner, jobId)

    fun dispatch(onIdle: () -> Unit) = jobs.dispatch(onIdle)

    fun hasActiveTasks(): Boolean = jobs.hasActiveTasks()

    fun cancelAll() = jobs.stop()

    fun serviceFailed(code: String, message: String, dispatchedOnly: Boolean = false) =
        jobs.stop(ChatFailure(code, message), dispatchedOnly)
}

private const val MIB = 1024 * 1024
private const val MAX_REQUEST_BYTES = 2 * MIB
private const val MAX_RESULT_BYTES = 4 * MIB
private const val MAX_FRAME_BYTES = 64 * 1024
private const val MAX_ACTIVE_TASKS = 2
private const val MAX_RETAINED_TASKS = 8
private const val MAX_RETIRED_IDS = 128
private val resultTtl = TimeUnit.MINUTES.toNanos(15)
private val jobIdPattern = Regex("[A-Za-z0-9_-]{1,128}")
private val jsonContentType = "application/json; charset=utf-8".toMediaType()
private val missingChat = ChatFailure("personal_chat_not_found", "个人 API 聊天任务已不存在。")
private val expiredChat = ChatFailure("personal_chat_expired", "个人 API 聊天结果已超过暂存时间或上限。")
private val cancelledChat = ChatFailure("personal_chat_cancelled", "已停止生成。")
private val launchFailed = ChatFailure("personal_chat_unavailable", "无法启动后台聊天，请返回聊天页面后重试。")
private val responseTooLarge = ChatFailure("personal_chat_result_too_large", "个人 API 回复超过暂存上限。")
private val interrupted = ChatFailure(
    "personal_chat_interrupted", "个人 API 聊天连接中断，请先确认服务商是否已处理本次请求。",
)
private val timedOut = ChatFailure(
    "personal_chat_timeout", "个人 API 聊天连接超时，请先确认服务商是否已处理本次请求。",
)

internal data class ChatFailure(val code: String, val message: String)

private fun failedChat(code: String, message: String, offset: Int? = null) = buildJsonObject {
    put("state", "failed")
    put("code", code)
    put("message", message)
    offset?.let { put("nextOffset", it) }
}

internal fun personalChatRequest(url: String, key: String, body: String, filesBeta: Boolean): Request? {
    if (url.length !in 1..2080 || !url.startsWith("https://", ignoreCase = true) ||
        key.length !in 1..8192 || key.any { it !in '!'..'~' } || body.length !in 1..MAX_REQUEST_BYTES
    ) return null
    val authority = try { URI(url).rawAuthority } catch (_: URISyntaxException) { return null }
    if (authority.isNullOrEmpty() || '@' in authority) return null
    val target = url.toHttpUrlOrNull() ?: return null
    if (!target.isHttps || target.query != null || target.fragment != null) return null
    val official = target.host == "api.deepseek.com" && target.port == 443 &&
        target.encodedPath == "/anthropic/v1/messages"
    if (!official && (filesBeta || !target.encodedPath.endsWith("/chat/completions"))) return null
    val bytes = body.toByteArray(Charsets.UTF_8)
    if (bytes.size > MAX_REQUEST_BYTES) return null
    return Request.Builder().url(target)
        .header("Authorization", "Bearer $key")
        .header("Accept", "text/event-stream")
        .header("Cache-Control", "no-store")
        .apply { if (filesBeta) header("anthropic-beta", "files-api-2025-04-14") }
        .post(object : RequestBody() {
            override fun contentType() = jsonContentType
            override fun contentLength() = bytes.size.toLong()
            // Also suppresses OkHttp's HTTP 421/503 follow-up requests for this POST.
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) { sink.write(bytes) }
        }).build()
}

internal fun personalChatClient() = OkHttpClient.Builder()
    .cookieJar(CookieJar.NO_COOKIES)
    .authenticator(Authenticator.NONE)
    .proxyAuthenticator(Authenticator.NONE)
    .followRedirects(false)
    .followSslRedirects(false)
    .retryOnConnectionFailure(false)
    .connectTimeout(15, TimeUnit.SECONDS)
    .writeTimeout(45, TimeUnit.SECONDS)
    .readTimeout(4, TimeUnit.MINUTES)
    .callTimeout(8, TimeUnit.MINUTES)
    .build()

/** In-memory only. Pending requests can be dispatched after the service has entered foreground. */
internal class PersonalChatTaskStore(
    private val client: OkHttpClient = personalChatClient(),
    private val now: () -> Long = System::nanoTime,
) {
    private data class JobKey(val owner: String, val id: String)
    private enum class State(val wire: String) {
        RUNNING("running"), DONE("done"), FAILED("failed"), CANCELLED("cancelled"),
    }

    private class Job(var call: Call?) {
        var dispatched = false
        var state = State.RUNNING
        var completedAt = 0L
        var status: Int? = null
        var contentType: String? = null
        var failure: ChatFailure? = null
        val result = Buffer()

        fun snapshot(offset: Int? = null) = buildJsonObject {
            put("state", state.wire)
            if (offset != null) {
                val length = minOf(MAX_FRAME_BYTES.toLong(), result.size - offset)
                if (length > 0) {
                    val bytes = Buffer()
                    result.copyTo(bytes, offset.toLong(), length)
                    put("chunk", bytes.readByteString().base64())
                }
                put("nextOffset", offset + length.toInt())
            }
            status?.let { put("status", it) }
            contentType?.let { put("contentType", it) }
            failure?.let { put("code", it.code); put("message", it.message) }
        }
    }

    private val lock = Any()
    private val jobs = LinkedHashMap<JobKey, Job>()
    private val retired = LinkedHashSet<JobKey>()
    private var idleListener: (() -> Unit)? = null

    fun start(owner: String, id: String, request: Request, launch: () -> Unit): JsonObject {
        val key = JobKey(owner, id)
        val job = synchronized(lock) {
            pruneFinished()
            jobs[key]?.let { return it.snapshot() }
            if (key in retired) return failedChat(expiredChat.code, expiredChat.message)
            if (jobs.values.count { it.state == State.RUNNING } >= MAX_ACTIVE_TASKS) {
                return failedChat("personal_chat_capacity", "后台聊天任务已满，请稍后再发送。")
            }
            if (jobs.size == MAX_RETAINED_TASKS) {
                val oldest = jobs.entries.first { it.value.state != State.RUNNING }
                retire(oldest.key)
            }
            Job(client.newCall(request)).also { jobs[key] = it }
        }
        try {
            launch()
        } catch (_: RuntimeException) {
            finish(job, State.FAILED, launchFailed)
        }
        return synchronized(lock) { job.snapshot() }
    }

    fun read(owner: String, id: String, offset: Int): JsonObject = synchronized(lock) {
        pruneFinished()
        val key = JobKey(owner, id)
        val job = jobs[key]
        when {
            job == null -> {
                val error = if (key in retired) expiredChat else missingChat
                failedChat(error.code, error.message, offset)
            }
            offset < 0 || offset > job.result.size -> failedChat(
                "personal_chat_invalid_offset", "个人 API 聊天进度无效。", offset,
            )
            else -> job.snapshot(offset)
        }
    }

    fun cancel(owner: String, id: String): JsonObject {
        val key = JobKey(owner, id)
        val job = synchronized(lock) {
            pruneFinished()
            jobs[key] ?: return failedChat(missingChat.code, missingChat.message)
        }
        finish(job, State.CANCELLED, cancelledChat, cancelCall = true)
        return synchronized(lock) { job.snapshot() }
    }

    fun dispatch(onIdle: () -> Unit) {
        val pending = synchronized(lock) {
            idleListener = onIdle
            jobs.values.mapNotNull { job ->
                if (job.dispatched) null else job.call?.let { call ->
                    job.dispatched = true
                    job to call
                }
            }
        }
        for ((job, call) in pending) {
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) = failIo(job, e)

                override fun onResponse(call: Call, response: Response) {
                    try {
                        response.use { readResponse(job, it) }
                    } catch (error: IOException) {
                        failIo(job, error)
                    }
                }
            })
        }
    }

    fun hasActiveTasks(): Boolean = synchronized(lock) { hasActiveTasksLocked() }

    fun stop(failure: ChatFailure = cancelledChat, dispatchedOnly: Boolean = false) {
        val calls = synchronized(lock) {
            val state = if (failure == cancelledChat) State.CANCELLED else State.FAILED
            jobs.values.mapNotNull { job ->
                if (!dispatchedOnly || job.dispatched) completeLocked(job, state, failure) else null
            }
        }
        calls.forEach(Call::cancel)
        notifyIdle()
    }

    private fun readResponse(job: Job, response: Response) {
        val body = response.body
        synchronized(lock) {
            if (job.state != State.RUNNING) return
            job.status = response.code
            job.contentType = body?.contentType()?.let { "${it.type}/${it.subtype}" }?.take(160)
        }
        if (body != null) {
            if (body.contentLength() > MAX_RESULT_BYTES) {
                finish(job, State.FAILED, responseTooLarge)
                return
            }
            val source = body.source()
            val incoming = Buffer()
            while (true) {
                val count = source.read(incoming, MAX_FRAME_BYTES.toLong())
                if (count == -1L) break
                val fits = synchronized(lock) {
                    if (job.state != State.RUNNING) return
                    if (job.result.size + count > MAX_RESULT_BYTES) false else {
                        job.result.write(incoming, count)
                        true
                    }
                }
                if (!fits) {
                    finish(job, State.FAILED, responseTooLarge)
                    return
                }
            }
        }
        finish(job, State.DONE)
    }

    private fun failIo(job: Job, error: IOException) {
        finish(job, State.FAILED, if (error is InterruptedIOException) timedOut else interrupted)
    }

    private fun finish(job: Job, state: State, failure: ChatFailure? = null, cancelCall: Boolean = false) {
        val call = synchronized(lock) { completeLocked(job, state, failure) } ?: return
        if (cancelCall) call.cancel()
        notifyIdle()
    }

    private fun completeLocked(job: Job, state: State, failure: ChatFailure?): Call? {
        val call = job.call ?: return null
        job.state = state
        job.completedAt = now()
        job.failure = failure
        job.call = null
        return call
    }

    private fun notifyIdle() {
        val listener = synchronized(lock) {
            if (hasActiveTasksLocked()) null else idleListener.also { idleListener = null }
        }
        listener?.invoke()
    }

    private fun hasActiveTasksLocked() = jobs.values.any { it.state == State.RUNNING }

    private fun pruneFinished() {
        val time = now()
        jobs.filterValues { it.state != State.RUNNING && time - it.completedAt >= resultTtl }
            .keys.forEach(::retire)
    }

    private fun retire(key: JobKey) {
        jobs.remove(key)
        if (retired.size == MAX_RETIRED_IDS) retired.remove(retired.first())
        retired.add(key)
    }
}
