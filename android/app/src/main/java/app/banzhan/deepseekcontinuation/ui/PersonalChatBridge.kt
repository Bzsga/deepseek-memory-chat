package app.banzhan.deepseekcontinuation.ui

import android.content.Context
import app.banzhan.deepseekcontinuation.data.CHAT_BRIDGE_LIMIT
import app.banzhan.deepseekcontinuation.data.PersonalChatTasks
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

private val bridgeCallId = Regex("[A-Za-z0-9_.:-]{1,100}")
private val chatJobId = Regex("[A-Za-z0-9_-]{1,128}")

internal fun personalChatBridgeResponse(
    context: Context,
    owner: String,
    visible: Boolean,
    type: String,
    message: JsonObject,
): String? {
    val id = message.text("id")?.takeIf(bridgeCallId::matches) ?: return null
    if (message.literal("version")?.intOrNull != 1) return null
    val payload = message["payload"] as? JsonObject
    val jobId = payload?.text("jobId")?.takeIf(chatJobId::matches)

    fun respond(result: JsonObject? = null, error: String? = null, code: String? = null) = buildJsonObject {
        put("version", 1)
        put("id", id)
        put("type", "personal.chat.response")
        put("ok", result != null)
        if (result != null) put("payload", result)
        if (error != null) put("error", error)
        if (code != null) put("code", code)
    }.toString()

    fun invalid() = respond(error = "个人聊天请求格式无效。", code = "personal_chat_invalid_request")
    if (payload == null || jobId == null) return invalid()

    return try {
        val result = when (type) {
            "personal.chat.start" -> {
                if (!visible) return respond(error = "请返回聊天页面后发送消息。", code = "personal_chat_foreground_required")
                val url = payload.text("url")?.takeIf { it.length in 1..2080 } ?: return invalid()
                val key = payload.text("key")?.takeIf { it.length in 1..8192 && it.all { ch -> ch in '!'..'~' } }
                    ?: return invalid()
                val body = payload.text("body")?.takeIf { it.isNotEmpty() && it.length <= CHAT_BRIDGE_LIMIT }
                    ?: return invalid()
                val filesBeta = payload.literal("filesBeta")?.booleanOrNull ?: return invalid()
                PersonalChatTasks.start(context, owner, jobId, url, key, body, filesBeta)
            }
            "personal.chat.read" -> {
                val offset = payload.literal("offset")?.intOrNull?.takeIf { it >= 0 } ?: return invalid()
                PersonalChatTasks.read(owner, jobId, offset)
            }
            "personal.chat.cancel" -> PersonalChatTasks.cancel(owner, jobId)
            else -> return invalid()
        }
        respond(result)
    } catch (_: Exception) {
        // If the native acknowledgement fails after start, the page can still read the original job ID.
        respond(error = "个人聊天暂时无法处理该操作。", code = "personal_chat_bridge")
    }
}

private fun JsonObject.text(name: String): String? = (get(name) as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.literal(name: String): JsonPrimitive? = (get(name) as? JsonPrimitive)?.takeUnless { it.isString }
