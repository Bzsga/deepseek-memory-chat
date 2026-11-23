package app.banzhan.deepseekcontinuation.ui

import android.util.Base64
import app.banzhan.deepseekcontinuation.data.PersonalImageException
import app.banzhan.deepseekcontinuation.data.PersonalImageFile
import app.banzhan.deepseekcontinuation.data.PersonalImageNetwork
import app.banzhan.deepseekcontinuation.data.TechnicalDiagnostics
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/** One image transport per trusted WebMessagePort. Its state is confined to the main thread. */
internal class PersonalImageChannel(
    private val active: () -> Boolean,
    private val post: (String) -> Unit,
    private val exchange: suspend (
        operation: String, url: String, key: String, model: String?, prompt: String?, files: List<PersonalImageFile>,
    ) -> String = PersonalImageNetwork::execute,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val requests = mutableMapOf<String, Request>()

    fun message(type: String, message: JsonObject, frameLength: Int) {
        if (!active()) return
        val id = message.string("id")?.takeIf(requestId::matches) ?: return
        if ((message["version"] as? JsonPrimitive)?.intOrNull != 1) return
        try {
            require(frameLength <= MAX_CHUNK_CHARS + 1024)
            when (type) {
                "image.request" -> begin(id, message)
                "image.chunk" -> append(id, message)
                "image.run" -> run(id)
                "image.cancel" -> discard(id)
            }
        } catch (_: IllegalArgumentException) {
            reject(id, "个人生图请求无效，请检查配置和参考图后重试。")
        }
    }

    fun close() {
        scope.cancel()
        requests.clear()
    }

    private fun begin(id: String, message: JsonObject) {
        if (id in requests) return
        if (requests.size >= 2) {
            reply("image.error", id) { put("message", "个人生图服务繁忙，请等当前请求结束后重试。") }
            return
        }
        val operation = requireNotNull(message.string("operation"))
        require(operation in setOf("models", "generate", "edit"))
        val url = requireNotNull(message.string("url"))
        require(url.length in 1..2080)
        val key = requireNotNull(message.string("key"))
        require(key.length in 1..8192 && key.all { it in '!'..'~' })
        val model = message.string("model")
        val prompt = message.string("prompt")
        if (operation != "models") {
            require(!model.isNullOrBlank() && model.length <= 128)
            require(!prompt.isNullOrBlank() && prompt.length <= 8000)
        }
        val files = message["files"]?.let { requireNotNull(it as? JsonArray) } ?: emptyList()
        require(if (operation == "edit") files.size in 1..4 else files.isEmpty())
        val entries = files.map { entry ->
            val file = requireNotNull(entry as? JsonObject)
            val mime = requireNotNull(file.string("mime"))
            require(mime in imageTypes)
            val name = requireNotNull(file.string("name"))
                .substringAfterLast('/').substringAfterLast('\\')
                .filterNot(Char::isISOControl).take(120).ifBlank { "reference" }
            val size = requireNotNull((file["size"] as? JsonPrimitive)?.intOrNull)
            require(size in 1..12 * MIB)
            FileEntry(name, mime, size)
        }
        require(entries.sumOf { it.size } <= 24 * MIB)
        val request = Request(operation, url, key, model, prompt, entries.map { Upload(it) })
        requests[id] = request
        acknowledge(id, request)
    }

    private fun append(id: String, message: JsonObject) {
        val request = requests[id] ?: return
        if (request.job != null) return
        val index = requireNotNull((message["index"] as? JsonPrimitive)?.intOrNull)
        val upload = requireNotNull(request.uploads.getOrNull(index))
        val encoded = requireNotNull(message.string("data"))
        require(encoded.length in 4..MAX_CHUNK_CHARS && encoded.length % 4 == 0 && base64.matches(encoded))
        val bytes = Base64.decode(encoded, Base64.DEFAULT)
        require(bytes.size in 1..MAX_CHUNK_BYTES && bytes.size <= upload.bytes.size - upload.received)
        bytes.copyInto(upload.bytes, upload.received)
        upload.received += bytes.size
        acknowledge(id, request)
    }

    private fun acknowledge(id: String, request: Request) {
        if (!reply("image.ack", id)) {
            discard(id)
            return
        }
        request.expiry?.cancel()
        request.expiry = scope.launch {
            delay(60_000)
            reject(id, "个人生图请求准备超时，请重试。")
        }
    }

    private fun run(id: String) {
        val request = requests[id] ?: return
        if (request.job != null) return
        require(request.uploads.all { it.received == it.bytes.size })
        request.expiry?.cancel()
        request.expiry = null
        request.job = scope.launch {
            try {
                if (!active()) return@launch
                val files = request.uploads.map { PersonalImageFile(it.entry.name, it.entry.mime, it.bytes) }
                request.uploads = emptyList()
                val result = exchange(request.operation, request.url, request.key, request.model, request.prompt, files)
                var offset = 0
                while (offset < result.length) {
                    var end = minOf(offset + MAX_RESULT_CHARS, result.length)
                    if (end < result.length && result[end - 1].isHighSurrogate() && result[end].isLowSurrogate()) end--
                    if (!reply("image.result", id) { put("data", result.substring(offset, end)) }) return@launch
                    offset = end
                    yield()
                }
                reply("image.done", id)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                val providerFailure = failure as? PersonalImageException
                providerFailure?.diagnosticCode?.let { TechnicalDiagnostics.record(
                    "image", it, providerFailure.diagnosticStage, providerFailure.httpStatus)
                }
                if (providerFailure == null) TechnicalDiagnostics.failure("image", "response", failure)
                val message = providerFailure?.message ?: "个人生图请求未完成，请检查服务状态后重试。"
                reply("image.error", id) { put("message", message.take(200)) }
            } finally {
                if (requests[id] === request) requests.remove(id)
            }
        }
    }

    private fun reject(id: String, message: String) {
        discard(id)
        reply("image.error", id) { put("message", message) }
    }

    private fun discard(id: String) {
        val request = requests.remove(id) ?: return
        request.expiry?.cancel()
        request.job?.cancel()
    }

    private fun reply(type: String, id: String, body: JsonObjectBuilder.() -> Unit = {}): Boolean = active() && runCatching {
        post(buildJsonObject {
            put("version", 1)
            put("type", type)
            put("id", id)
            body()
        }.toString())
    }.isSuccess

    private fun JsonObject.string(field: String): String? = (get(field) as? JsonPrimitive)?.takeIf { it.isString }?.content

    private class FileEntry(val name: String, val mime: String, val size: Int)

    private class Upload(val entry: FileEntry) {
        val bytes = ByteArray(entry.size)
        var received = 0
    }

    private class Request(
        val operation: String,
        val url: String,
        val key: String,
        val model: String?,
        val prompt: String?,
        var uploads: List<Upload>,
    ) {
        var expiry: Job? = null
        var job: Job? = null
    }

    private companion object {
        const val MIB = 1024 * 1024
        const val MAX_CHUNK_BYTES = 96 * 1024
        const val MAX_CHUNK_CHARS = MAX_CHUNK_BYTES / 3 * 4
        const val MAX_RESULT_CHARS = 128 * 1024
        val requestId = Regex("[A-Za-z0-9_.:-]{1,100}")
        val base64 = Regex("[A-Za-z0-9+/]+={0,2}")
        val imageTypes = setOf("image/png", "image/jpeg", "image/webp")
    }
}
