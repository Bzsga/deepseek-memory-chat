package app.banzhan.deepseekcontinuation.data

import java.io.IOException
import java.io.InterruptedIOException
import java.net.URI
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import okio.BufferedSource

internal data class PersonalMcpTool(val name: String, val title: String, val queryArgument: String)
internal data class PersonalMcpSource(val title: String, val url: String, val text: String)
internal data class PersonalMcpActionTool(
    val name: String,
    val title: String,
    val description: String,
    val inputSchema: JsonObject,
    val readOnly: Boolean,
    val revision: String,
)
internal data class PersonalMcpActionResult(val status: String, val text: String, val truncated: Boolean)
internal class PersonalMcpException(message: String) : IOException(message)

/** Device-local Streamable HTTP transport for reference lookup and explicitly approved actions. */
internal object PersonalMcpNetwork {
    private const val MAX_URL = 2048
    private const val MAX_QUERY = 2000
    private const val MAX_SOURCES = 4
    private const val MAX_RESPONSE_BYTES = 512L * 1024
    private const val MAX_TOOL_PAGES = 4
    private const val MAX_TOOLS = 40
    private const val MAX_ACTION_SCHEMA_BYTES = 24 * 1024
    private const val MAX_ACTION_ARGS_BYTES = 24 * 1024
    private const val MAX_ACTION_DEFINITION_BYTES = 64 * 1024
    private const val MAX_ACTION_CATALOG_BYTES = 256 * 1024
    private const val MAX_ACTION_JSON_DEPTH = 32
    private const val MAX_ACTION_RESULT_CHARS = 12_000
    private const val PROTOCOL_VERSION = "2025-11-25"
    private const val INVALID_RESPONSE = "MCP 服务返回了无法识别的响应。"
    private val supportedVersions = setOf(PROTOCOL_VERSION, "2025-06-18", "2025-03-26")
    private val toolNamePattern = Regex("[A-Za-z0-9_.-]{1,128}")
    private val revisionPattern = Regex("[0-9a-f]{64}")
    private val revisionFields = setOf("name", "title", "description", "inputSchema", "outputSchema", "annotations", "execution")
    private val displayJson = Json { prettyPrint = true }
    private val contentType = "application/json; charset=utf-8".toMediaType()

    internal val defaultClient: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        // These statuses can cause an OkHttp follow-up even with connection retries disabled.
        .addNetworkInterceptor { chain ->
            val response = chain.proceed(chain.request())
            if (response.code == 421 || response.code == 503) {
                val status = response.code
                response.close()
                throw httpError(status)
            }
            response
        }
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .callTimeout(9, TimeUnit.SECONDS)
        .build()

    fun validateEndpoint(endpoint: String): String = parseEndpoint(endpoint).toString()

    suspend fun discover(endpoint: String, token: String): List<PersonalMcpTool> =
        discover(endpoint, token, defaultClient)

    internal suspend fun discover(endpoint: String, token: String, client: Call.Factory): List<PersonalMcpTool> =
        useSession(endpoint, token, client) { tools() }

    suspend fun listTools(endpoint: String, token: String): List<PersonalMcpActionTool> =
        listTools(endpoint, token, defaultClient)

    internal suspend fun listTools(endpoint: String, token: String, client: Call.Factory): List<PersonalMcpActionTool> =
        useSession(endpoint, token, client) { actionTools() }

    suspend fun invokeTool(
        endpoint: String, token: String, toolName: String, revision: String, args: JsonObject,
    ): PersonalMcpActionResult = invokeTool(endpoint, token, toolName, revision, args, defaultClient)

    suspend fun invokeTool(
        endpoint: String, token: String, toolName: String, revision: String, args: JsonObject,
        canDispatch: () -> Boolean,
    ): PersonalMcpActionResult = invokeTool(endpoint, token, toolName, revision, args, defaultClient, canDispatch)

    internal suspend fun invokeTool(
        endpoint: String, token: String, toolName: String, revision: String, args: JsonObject,
        client: Call.Factory, canDispatch: () -> Boolean = { true },
    ): PersonalMcpActionResult {
        if (!toolNamePattern.matches(toolName) || !revisionPattern.matches(revision)) {
            throw PersonalMcpException("MCP 工具或版本无效，请重新选择工具。")
        }
        if (!boundedJson(args, MAX_ACTION_ARGS_BYTES)) {
            throw PersonalMcpException("MCP 工具参数过大、层级过深或含有无效字符。")
        }

        var submitted = false
        try {
            return useSession(endpoint, token, client) {
                val tool = actionTool(toolName)
                if (tool?.revision != revision) {
                    throw PersonalMcpException("MCP 工具定义已变化，请刷新工具并重新确认参数。")
                }
                val result = rpc("tools/call", buildJsonObject {
                    put("name", toolName)
                    put("arguments", args)
                }) {
                    if (!canDispatch()) throw PersonalMcpException("聊天页面已切换，MCP 工具未执行。")
                    submitted = true
                }
                actionResult(result)
            }
        } catch (error: Exception) {
            if (!submitted || error is CancellationException) throw error
            return PersonalMcpActionResult("uncertain", "未能确认 MCP 工具的执行结果。请先到对应服务核对。", false)
        }
    }

    suspend fun lookup(endpoint: String, token: String, toolName: String, query: String): List<PersonalMcpSource> =
        lookup(endpoint, token, toolName, query, defaultClient)

    internal suspend fun lookup(
        endpoint: String, token: String, toolName: String, query: String, client: Call.Factory,
    ): List<PersonalMcpSource> {
        val text = query.trim()
        if (text.isEmpty() || text.length > MAX_QUERY) {
            throw PersonalMcpException("请输入 1 至 2000 个字符的资料查询。")
        }
        if (!toolNamePattern.matches(toolName)) throw PersonalMcpException("资料查询工具无效。")
        return useSession(endpoint, token, client) {
            val tool = tools().firstOrNull { it.name == toolName }
                ?: throw PersonalMcpException("找不到尚可使用的资料查询工具，请重新选择。")
            val result = rpc("tools/call", buildJsonObject {
                put("name", tool.name)
                put("arguments", buildJsonObject { put(tool.queryArgument, text) })
            })
            if (result["isError"] == JsonPrimitive(true)) {
                throw PersonalMcpException("资料查询失败，请检查所选工具及服务权限。")
            }
            extractSources(result).ifEmpty {
                throw PersonalMcpException("资料库没有返回带有效网页地址的摘录。请更换关键词或查询工具。")
            }
        }
    }

    private suspend fun <T> useSession(
        endpoint: String, token: String, client: Call.Factory, work: suspend Session.() -> T,
    ): T {
        if (token.length > 8192 || token.any { it !in '!'..'~' }) {
            throw PersonalMcpException("MCP 访问令牌格式无效。")
        }
        val session = Session(parseEndpoint(endpoint), token, client)
        return withTimeoutOrNull(18_000) {
            try {
                session.initialize()
                session.work()
            } finally {
                session.close()
            }
        } ?: throw PersonalMcpException("连接 MCP 服务超时，请稍后手动重试。")
    }

    private class Session(private val endpoint: HttpUrl, private val token: String, private val client: Call.Factory) {
        private var sequence = 0
        private var sessionId: String? = null
        private var protocol: String? = null

        suspend fun initialize() {
            val id = ++sequence
            val reply = exchange(client, post("initialize", buildJsonObject {
                put("protocolVersion", PROTOCOL_VERSION)
                put("capabilities", buildJsonObject {})
                put("clientInfo", buildJsonObject {
                    put("name", "DeepSeek Memory Chat")
                    put("version", "1.0")
                })
            }, id), id)
            val response = requireResult(reply)
            protocol = response["protocolVersion"].string()?.takeIf(supportedVersions::contains)
                ?: throw PersonalMcpException("MCP 服务使用了此版本不支持的协议。")
            sessionId = reply.sessionId?.also {
                if (it.length !in 1..512 || it.any { ch -> ch !in '!'..'~' }) invalidResponse()
            }
            exchange(client, post("notifications/initialized"), null)
        }

        suspend fun tools(): List<PersonalMcpTool> {
            val tools = LinkedHashMap<String, PersonalMcpTool>()
            visitTools { definition ->
                val tool = readTool(definition)
                if (tool != null) tools.putIfAbsent(tool.name, tool)
                tools.size < MAX_TOOLS
            }
            return tools.values.toList()
        }

        suspend fun actionTools(): List<PersonalMcpActionTool> {
            val tools = LinkedHashMap<String, PersonalMcpActionTool>()
            val seen = HashSet<String>()
            var catalogBytes = 0
            visitTools { definition ->
                val name = definition["name"].string()
                if (name != null && !seen.add(name)) {
                    tools.remove(name)?.let { catalogBytes -= it.catalogBytes() }
                } else if (tools.size < MAX_TOOLS) {
                    val tool = readActionTool(definition)
                    if (tool != null) {
                        val bytes = tool.catalogBytes()
                        if (catalogBytes + bytes <= MAX_ACTION_CATALOG_BYTES) {
                            tools[tool.name] = tool
                            catalogBytes += bytes
                        }
                    }
                }
                true
            }
            return tools.values.toList()
        }

        suspend fun actionTool(name: String): PersonalMcpActionTool? {
            var found = false
            var tool: PersonalMcpActionTool? = null
            visitTools { definition ->
                if (definition["name"] == JsonPrimitive(name)) {
                    if (found) invalidResponse()
                    found = true
                    tool = readActionTool(definition)
                }
                true
            }
            return tool
        }

        private suspend fun visitTools(visit: (JsonObject) -> Boolean) {
            val cursors = HashSet<String>()
            var cursor: String? = null
            repeat(MAX_TOOL_PAGES) {
                val result = rpc("tools/list", buildJsonObject {
                    cursor?.let { put("cursor", it) }
                })
                val page = result["tools"] as? JsonArray ?: invalidResponse()
                for (item in page) {
                    if (!visit(item as? JsonObject ?: continue)) return
                }
                val next = result["nextCursor"] ?: return
                if (next == JsonNull) return
                cursor = next.string()?.takeIf { it.length in 1..2048 && cursors.add(it) } ?: invalidResponse()
            }
        }

        suspend fun rpc(method: String, params: JsonObject, beforeDispatch: () -> Unit = {}): JsonObject {
            val id = ++sequence
            val request = post(method, params, id)
            beforeDispatch()
            return requireResult(exchange(client, request, id))
        }

        private fun request() = Request.Builder().url(endpoint)
            .header("Accept", "application/json, text/event-stream")
            .header("Cache-Control", "no-store")
            .apply {
                if (token.isNotEmpty()) header("Authorization", "Bearer " + token)
                protocol?.let { header("MCP-Protocol-Version", it) }
                sessionId?.let { header("Mcp-Session-Id", it) }
            }

        private fun post(method: String, params: JsonObject? = null, id: Int? = null): Request =
            request().post(OneShotBody(buildJsonObject {
                put("jsonrpc", "2.0")
                put("method", method)
                id?.let { put("id", it) }
                params?.let { put("params", it) }
            }.toString().toRequestBody(contentType))).build()

        fun close() {
            if (sessionId == null) return
            // Session termination is optional and independent of the tool request's outcome.
            runCatching {
                val call = client.newCall(request().delete().build())
                call.timeout().timeout(2, TimeUnit.SECONDS)
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) = Unit
                    override fun onResponse(call: Call, response: Response) = response.close()
                })
            }
        }
    }

    private data class RpcReply(val message: JsonObject?, val sessionId: String?)

    private suspend fun exchange(client: Call.Factory, request: Request, id: Int?): RpcReply =
        suspendCancellableCoroutine { continuation ->
            val call = client.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resumeWithException(safeFailure(e))
                }

                override fun onResponse(call: Call, response: Response) {
                    try {
                        val reply = response.use {
                            if (!it.isSuccessful) throw httpError(it.code)
                            RpcReply(if (id == null) null else readReply(it, id), it.header("Mcp-Session-Id"))
                        }
                        if (continuation.isActive) continuation.resume(reply)
                    } catch (error: Exception) {
                        if (continuation.isActive) continuation.resumeWithException(safeFailure(error))
                    }
                }
            })
        }

    private fun readReply(response: Response, id: Int): JsonObject {
        val body = response.body ?: invalidResponse()
        val source = body.source()
        return when (body.contentType()?.toString()?.substringBefore(';')?.trim()?.lowercase()) {
            "application/json" -> {
                if (body.contentLength() > MAX_RESPONSE_BYTES || source.request(MAX_RESPONSE_BYTES + 1)) tooLarge()
                val message = parse(source.readUtf8()) as? JsonObject ?: invalidResponse()
                message.takeIf { matchesReply(it, id) } ?: invalidResponse()
            }
            "text/event-stream" -> readEventReply(source, id)
            else -> invalidResponse()
        }
    }

    /** Stop at the matching result. Servers may keep the event stream open after it. */
    private fun readEventReply(source: BufferedSource, id: Int): JsonObject {
        val data = StringBuilder()
        var remaining = MAX_RESPONSE_BYTES
        while (remaining > 0 && !source.exhausted()) {
            val end = source.indexOf('\n'.code.toByte(), 0, remaining)
            if (end < 0) {
                if (source.buffer.size >= remaining) tooLarge()
                invalidResponse()
            }
            val rawLine = source.readUtf8LineStrict(end)
            val line = if (remaining == MAX_RESPONSE_BYTES) rawLine.removePrefix("\uFEFF") else rawLine
            remaining -= end + 1
            if (line.isEmpty()) {
                if (data.isEmpty()) continue
                val message = parse(data.toString()) as? JsonObject
                if (message != null && matchesReply(message, id)) return message
                data.clear()
            } else if (line.startsWith("data:")) {
                if (data.isNotEmpty()) data.append('\n')
                data.append(line.substringAfter(':').removePrefix(" "))
            }
        }
        if (remaining <= 0) tooLarge()
        invalidResponse()
    }

    private fun matchesReply(message: JsonObject, id: Int): Boolean =
        message["jsonrpc"] == JsonPrimitive("2.0") && message["id"] == JsonPrimitive(id)

    private fun requireResult(reply: RpcReply): JsonObject {
        val message = reply.message ?: invalidResponse()
        if ("error" in message) throw PersonalMcpException("MCP 服务拒绝了请求，请检查服务或工具配置。")
        return message["result"] as? JsonObject ?: invalidResponse()
    }

    private fun readTool(tool: JsonObject): PersonalMcpTool? {
        val name = tool["name"].string()?.takeIf(toolNamePattern::matches) ?: return null
        val annotations = tool["annotations"] as? JsonObject ?: return null
        if (annotations["readOnlyHint"] != JsonPrimitive(true)) return null
        val schema = tool["inputSchema"] as? JsonObject ?: return null
        if (schema["type"] != JsonPrimitive("object")) return null
        val required = schema["required"] as? JsonArray ?: return null
        val query = required.singleOrNull().string()?.takeIf {
            it.length in 1..80 && it.none(Char::isISOControl)
        } ?: return null
        val properties = schema["properties"] as? JsonObject ?: return null
        val queryProperty = properties[query] as? JsonObject ?: return null
        if (queryProperty["type"] != JsonPrimitive("string")) return null
        val title = (tool["title"].string() ?: annotations["title"].string())?.plainText(160)
        return PersonalMcpTool(name, title?.takeIf(String::isNotBlank) ?: name, query)
    }

    private fun readActionTool(tool: JsonObject): PersonalMcpActionTool? {
        val name = tool["name"].string()?.takeIf(toolNamePattern::matches) ?: return null
        val schema = tool["inputSchema"] as? JsonObject ?: return null
        if (schema["type"] != JsonPrimitive("object") || !boundedJson(schema, MAX_ACTION_SCHEMA_BYTES)) return null
        val description = tool["description"]?.let { it.string()?.takeIf { value -> value.length <= 4096 } ?: return null }.orEmpty()
        val annotations = tool["annotations"] as? JsonObject
        val title = (tool["title"].string() ?: annotations?.get("title").string())?.takeUnless(String::isBlank) ?: name
        if (title.length > 240) return null
        // A task-required tool cannot run as a synchronous call in this client.
        val execution = tool["execution"] as? JsonObject
        if (execution?.get("taskSupport") == JsonPrimitive("required")) return null

        val definition = JsonObject(tool.filterKeys(revisionFields::contains))
        if (!boundedJson(definition, MAX_ACTION_DEFINITION_BYTES)) return null
        val digest = MessageDigest.getInstance("SHA-256").digest(canonicalJson(definition).toString().toByteArray(Charsets.UTF_8))
        val revision = digest.joinToString("") { it.toUByte().toString(16).padStart(2, '0') }
        return PersonalMcpActionTool(name, title, description, schema, annotations?.get("readOnlyHint") == JsonPrimitive(true), revision)
    }

    private fun PersonalMcpActionTool.catalogBytes(): Int =
        256 + name.length + JsonPrimitive(title).toString().toByteArray(Charsets.UTF_8).size +
            JsonPrimitive(description).toString().toByteArray(Charsets.UTF_8).size + inputSchema.toString().toByteArray(Charsets.UTF_8).size

    private fun boundedJson(value: JsonElement, maxBytes: Int): Boolean {
        if (!withinJsonDepth(value, MAX_ACTION_JSON_DEPTH)) return false
        val encoded = value.toString()
        return encoded.length <= maxBytes && Charsets.UTF_8.newEncoder().canEncode(encoded) &&
            encoded.toByteArray(Charsets.UTF_8).size <= maxBytes
    }

    private fun withinJsonDepth(value: JsonElement, remaining: Int): Boolean = when (value) {
        is JsonObject -> remaining > 0 && value.values.all { withinJsonDepth(it, remaining - 1) }
        is JsonArray -> remaining > 0 && value.all { withinJsonDepth(it, remaining - 1) }
        else -> true
    }

    private fun canonicalJson(value: JsonElement): JsonElement = when (value) {
        is JsonObject -> JsonObject(value.toSortedMap().mapValues { canonicalJson(it.value) })
        is JsonArray -> JsonArray(value.map(::canonicalJson))
        else -> value
    }

    private fun actionResult(result: JsonObject): PersonalMcpActionResult {
        val status = when (result["isError"]) {
            null, JsonPrimitive(false) -> "success"
            JsonPrimitive(true) -> "tool_error"
            else -> invalidResponse()
        }
        val structured = result["structuredContent"]?.let { it as? JsonObject ?: invalidResponse() }
        val content = result["content"]?.let { it as? JsonArray ?: invalidResponse() }
        if (structured == null && content == null) invalidResponse()
        var omitted = false
        val parts = buildList {
            if (structured != null) {
                if (withinJsonDepth(structured, MAX_ACTION_JSON_DEPTH)) {
                    val compact = structured.toString()
                    add(if (compact.length <= MAX_ACTION_RESULT_CHARS) {
                        displayJson.encodeToString(JsonObject.serializer(), structured)
                    } else compact)
                } else {
                    omitted = true
                }
            }
            for (value in content.orEmpty()) {
                val item = value as? JsonObject ?: invalidResponse()
                val text = when (item["type"].string() ?: invalidResponse()) {
                    "text" -> item["text"].string() ?: invalidResponse()
                    "resource_link" -> item["uri"].string() ?: invalidResponse()
                    "resource" -> (item["resource"] as? JsonObject)?.get("text").string()
                    else -> null
                }
                if (text == null) omitted = true
                else if (structured == null || parse(text) != structured) add(text)
            }
        }
        val joined = parts.joinToString("\n\n").plainText(Int.MAX_VALUE)
        val text = joined.take(MAX_ACTION_RESULT_CHARS).trimEnd { it.isHighSurrogate() }.ifBlank {
            when {
                omitted -> "MCP 工具返回了 App 无法显示的内容。"
                status == "tool_error" -> "MCP 工具返回错误。"
                else -> "MCP 工具执行完成，未返回文本。"
            }
        }
        return PersonalMcpActionResult(status, text, omitted || joined.length > MAX_ACTION_RESULT_CHARS)
    }

    private fun extractSources(result: JsonObject): List<PersonalMcpSource> {
        val found = LinkedHashMap<String, PersonalMcpSource>()
        fun add(source: PersonalMcpSource?) {
            if (source != null && found.size < MAX_SOURCES) found.putIfAbsent(source.url, source)
        }
        fun addRecords(value: JsonElement?) {
            val records = when (value) {
                is JsonArray -> value
                is JsonObject -> (value["results"] ?: value["sources"] ?: value["documents"] ?: value["items"])
                    as? JsonArray ?: listOf(value)
                else -> emptyList()
            }
            for (record in records) {
                if (found.size >= MAX_SOURCES) break
                if (record is JsonObject) add(readSource(record))
            }
        }
        addRecords(result["structuredContent"])
        for (raw in (result["content"] as? JsonArray).orEmpty()) {
            if (found.size >= MAX_SOURCES) break
            val item = raw as? JsonObject ?: continue
            when (item["type"].string()) {
                "text" -> addRecords(item["text"].string()?.let(::parse))
                "resource_link" -> add(readSource(item))
                "resource" -> add((item["resource"] as? JsonObject)?.let(::readSource))
            }
        }
        return found.values.toList()
    }

    private fun readSource(record: JsonObject): PersonalMcpSource? {
        val address = record.readText("url", "uri", "href", "link") ?: return null
        val url = httpAddress(address) ?: return null
        val quote = record.readText("text", "excerpt", "snippet", "content", "description")
            ?.plainText(1200)?.takeIf(String::isNotBlank) ?: return null
        val title = record.readText("title", "name")?.plainText(160)?.takeIf(String::isNotBlank) ?: url.host
        return PersonalMcpSource(title, url.toString(), quote)
    }

    private fun JsonObject.readText(vararg keys: String): String? =
        keys.firstNotNullOfOrNull { key -> this[key].string()?.takeIf(String::isNotBlank) }

    private fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun String.plainText(limit: Int): String =
        filter { !it.isISOControl() || it in "\n\t" }
            .trim().take(limit).trimEnd { it.isHighSurrogate() }

    private fun parse(value: String): JsonElement? = runCatching { Json.parseToJsonElement(value) }.getOrNull()

    private fun parseEndpoint(input: String): HttpUrl =
        httpAddress(input.trim())?.takeIf { it.isHttps && it.fragment == null }
            ?: throw PersonalMcpException("请填写不含用户信息和片段的 HTTPS MCP 地址。")

    private fun httpAddress(input: String): HttpUrl? {
        if (input.length !in 1..MAX_URL || input.any(Char::isISOControl)) return null
        val authority = runCatching { URI(input).rawAuthority }.getOrNull() ?: return null
        if ('@' in authority) return null
        return input.toHttpUrlOrNull()?.takeIf { it.toString().length <= MAX_URL }
    }

    private fun invalidResponse(): Nothing = throw PersonalMcpException(INVALID_RESPONSE)

    private fun tooLarge(): Nothing = throw PersonalMcpException("MCP 响应过大，请缩小查询范围。")

    private fun httpError(status: Int) = PersonalMcpException(when (status) {
        401, 403 -> "MCP 服务拒绝访问，请检查令牌和权限。"
        404 -> "未找到 MCP 端点，或连接会话已失效。"
        in 300..399 -> "MCP 服务返回重定向，请填写最终 HTTPS 地址。"
        else -> "MCP 服务请求失败（HTTP " + status + "）。"
    })

    private fun safeFailure(error: Exception): Exception = when (error) {
        is PersonalMcpException, is CancellationException -> error
        is InterruptedIOException -> PersonalMcpException("连接 MCP 服务超时，请稍后手动重试。")
        is IOException -> PersonalMcpException("无法连接 MCP 服务，请检查地址和网络。")
        else -> PersonalMcpException(INVALID_RESPONSE)
    }

    private class OneShotBody(private val delegate: RequestBody) : RequestBody() {
        override fun contentType() = delegate.contentType()
        override fun contentLength() = delegate.contentLength()
        override fun isOneShot() = true
        override fun writeTo(sink: BufferedSink) = delegate.writeTo(sink)
    }
}
