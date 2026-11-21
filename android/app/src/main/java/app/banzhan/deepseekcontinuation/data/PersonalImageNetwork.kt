package app.banzhan.deepseekcontinuation.data

import java.io.IOException
import java.net.URI
import java.net.URISyntaxException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromStream
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import okio.BufferedSource

internal data class PersonalImageFile(val name: String, val mime: String, val bytes: ByteArray)
internal class PersonalImageException(message: String) : IOException(message)

/** Independent of the app account, WebView cookies and managed model service. */
internal object PersonalImageNetwork {
    private const val MIB = 1024 * 1024
    private const val MAX_IMAGE_BYTES = 20 * MIB
    private const val MAX_BASE64 = ((MAX_IMAGE_BYTES + 2) / 3) * 4
    private const val INVALID_RESULT = "生成结果不是可保存的图片，请稍后重试。"
    private const val DOWNLOAD_FAILED = "个人生图结果下载失败。"
    private val imageMimeTypes = setOf("image/jpeg", "image/png", "image/webp")
    private val jsonContentType = "application/json; charset=utf-8".toMediaType()
    private val providerJson = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        // OkHttp may follow up on HTTP/2 421 or a 503 with Retry-After: 0.
        .addNetworkInterceptor { chain ->
            val response = chain.proceed(chain.request())
            if (response.code == 421 || response.code == 503) {
                response.close()
                throw UpstreamStatus(response.code)
            }
            response
        }
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .readTimeout(4, TimeUnit.MINUTES)
        .build()

    @Serializable
    private data class ImageResponse(val data: List<ProviderImage>)

    @Serializable
    private data class ProviderImage(
        @SerialName("b64_json") val base64: String? = null,
        val url: String? = null,
        @SerialName("mime_type") val mime: String? = null,
    )

    private enum class Operation(val path: String) {
        MODELS("/models"), GENERATE("/images/generations"), EDIT("/images/edits")
    }

    suspend fun execute(
        operation: String,
        url: String,
        key: String,
        model: String?,
        prompt: String?,
        files: List<PersonalImageFile>,
    ): String = withContext(Dispatchers.Default) {
        val action = when (operation) {
            "models" -> Operation.MODELS
            "generate" -> Operation.GENERATE
            "edit" -> Operation.EDIT
            else -> throw PersonalImageException("个人生图操作无效。")
        }
        val target = httpsUrl(url)
        if (target == null || url.length > 2080 || target.query != null || target.fragment != null ||
            !target.encodedPath.endsWith(action.path)) {
            throw PersonalImageException("请填写有效的 HTTPS 生图服务地址。")
        }
        if (key.length !in 1..8192 || key.any { it !in '!'..'~' }) {
            throw PersonalImageException("请填写有效的生图 API Key。")
        }
        val request = Request.Builder().url(target)
            .header("Authorization", "Bearer $key").header("Cache-Control", "no-store")
        if (action == Operation.MODELS) {
            return@withContext read(request.get().build(), 30, 2 * MIB, action) { it.readUtf8() }
        }
        if (model.isNullOrBlank() || model.length > 128 || prompt.isNullOrBlank() || prompt.length > 8000) {
            throw PersonalImageException("请检查生图模型和提示词。")
        }
        val body = if (action == Operation.EDIT) editBody(model, prompt, files) else buildJsonObject {
            put("model", model)
            put("prompt", prompt)
            put("n", 1)
        }.toString().toRequestBody(jsonContentType)
        val result = read(request.post(OneShotBody(body)).build(), 240, 29 * MIB, action, ::parseImage)
        val image = if (!result.base64.isNullOrEmpty()) {
            if (result.mime != null && result.mime !in imageMimeTypes) throw PersonalImageException(INVALID_RESULT)
            ProviderImage(base64 = compactBase64(result.base64), mime = result.mime)
        } else {
            val resultUrl = result.url?.let(::httpsUrl) ?: throw PersonalImageException(INVALID_RESULT)
            // Signed result links may use a query. No provider Key, Cookie or Referer is attached.
            read(Request.Builder().url(resultUrl).get().build(), 45, MAX_IMAGE_BYTES, null) {
                if (it.exhausted()) throw PersonalImageException(INVALID_RESULT)
                ProviderImage(base64 = it.readByteString().base64())
            }
        }
        providerJson.encodeToString(ImageResponse(listOf(image)))
    }

    private fun httpsUrl(input: String): HttpUrl? {
        if (input.length > 8192 || !input.startsWith("https://", ignoreCase = true)) return null
        val authority = try { URI(input).rawAuthority } catch (_: URISyntaxException) { return null }
        if (authority.isNullOrEmpty() || '@' in authority) return null
        return input.toHttpUrlOrNull()?.takeIf { it.isHttps }
    }

    private fun editBody(model: String, prompt: String, files: List<PersonalImageFile>): MultipartBody {
        if (files.size !in 1..4 || files.sumOf { it.bytes.size.toLong() } > 24L * MIB ||
            files.any {
                it.bytes.size !in 1..(12 * MIB) || it.mime !in imageMimeTypes ||
                    it.name.isBlank() || it.name.length > 120 || it.name.any { ch -> ch.isISOControl() || ch == '/' || ch == '\\' }
            }) {
            throw PersonalImageException("参考图无效或超过大小限制。")
        }
        val field = if (files.size == 1) "image" else "image[]"
        return MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("model", model).addFormDataPart("prompt", prompt).addFormDataPart("n", "1")
            .apply { files.forEach { addFormDataPart(field, it.name, it.bytes.toRequestBody(it.mime.toMediaType())) } }
            .build()
    }

    @OptIn(ExperimentalSerializationApi::class)
    private fun parseImage(source: BufferedSource): ProviderImage =
        providerJson.decodeFromStream<ImageResponse>(source.inputStream()).data.singleOrNull()
            ?: throw PersonalImageException("个人生图服务没有返回单张图片。")

    private fun compactBase64(value: String): String {
        if (value.length > MAX_BASE64 + 65536 || value.any {
                it !in 'A'..'Z' && it !in 'a'..'z' && it !in '0'..'9' &&
                    it != '+' && it != '/' && it != '=' && !base64Space(it)
            }) {
            throw PersonalImageException(INVALID_RESULT)
        }
        val compact = if (value.any(::base64Space)) value.filterNot(::base64Space) else value
        if (compact.length !in 1..MAX_BASE64) throw PersonalImageException(INVALID_RESULT)
        return compact
    }

    private fun base64Space(char: Char) = char == ' ' || char == '\t' || char == '\n' || char == '\r'

    private suspend fun <T> read(
        request: Request, timeoutSeconds: Long, limit: Int, action: Operation?, parse: (BufferedSource) -> T,
    ): T = suspendCancellableCoroutine { continuation ->
        val call = client.newCall(request)
        call.timeout().timeout(timeoutSeconds, TimeUnit.SECONDS)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resumeWithException(
                    (e as? UpstreamStatus)?.let { httpError(action, it.code) }
                        ?: PersonalImageException(connectionFailure(action)),
                )
            }

            override fun onResponse(call: Call, response: Response) {
                try {
                    val value = response.use {
                        if (!continuation.isActive) throw CancellationException()
                        if (!it.isSuccessful) throw httpError(action, it.code)
                        val body = it.body ?: throw PersonalImageException(emptyResponse(action))
                        val source = body.source()
                        if (body.contentLength() > limit || source.request(limit.toLong() + 1)) {
                            throw PersonalImageException("个人生图服务的响应超过大小限制。")
                        }
                        if (!continuation.isActive) throw CancellationException()
                        parse(source)
                    }
                    if (continuation.isActive) continuation.resume(value)
                } catch (e: Exception) {
                    if (continuation.isActive) {
                        continuation.resumeWithException(when (e) {
                            is PersonalImageException, is CancellationException -> e
                            is IOException -> PersonalImageException(connectionFailure(action))
                            else -> PersonalImageException(emptyResponse(action))
                        })
                    }
                }
            }
        })
    }

    private fun emptyResponse(action: Operation?): String = when (action) {
        Operation.MODELS -> "服务未返回兼容的模型列表。"
        else -> INVALID_RESULT
    }

    private fun connectionFailure(action: Operation?): String = when (action) {
        null -> DOWNLOAD_FAILED
        Operation.MODELS -> "无法连接个人生图服务，请检查服务地址和手机网络。"
        else -> "个人生图连接中断或超时，请先在服务商处确认本次请求是否已处理。"
    }

    private fun httpError(action: Operation?, code: Int) = PersonalImageException(when (action) {
        null -> DOWNLOAD_FAILED
        Operation.MODELS -> "获取模型列表失败（HTTP $code）。"
        Operation.EDIT -> if (code in setOf(404, 405, 501))
            "个人生图服务的图片编辑接口不可用（HTTP $code）。请检查服务地址及模型是否支持图片编辑。"
        else "个人生图服务未能编辑图片（HTTP $code）。请检查服务配置、模型和参考图。"
        Operation.GENERATE -> "个人生图服务返回 HTTP $code。"
    })

    private class UpstreamStatus(val code: Int) : IOException()

    private class OneShotBody(private val delegate: RequestBody) : RequestBody() {
        override fun contentType() = delegate.contentType()
        override fun contentLength() = delegate.contentLength()
        override fun isOneShot() = true
        override fun writeTo(sink: BufferedSink) = delegate.writeTo(sink)
    }
}
