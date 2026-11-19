package app.banzhan.deepseekcontinuation.data

import android.content.Context
import java.io.File
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*

internal const val CHAT_PAGE = "https://digimonlegend.com/deepseek/"
internal const val CHAT_ORIGIN = "https://digimonlegend.com"
internal const val CHAT_API = "https://digimonlegend.com/deepseek-api"
internal enum class NativeSettingsSection(val route: String, val returnFragment: String) {
    SERVICE("service", "#settings"),
    DATA("data", "#settings/data"),
    ABOUT("about", "#settings/about"),
    DEVELOPER("developer", "#settings/about");

    companion object {
        fun fromPayload(payload: JsonElement?): NativeSettingsSection? {
            if (payload == null) return null // Older pages opened the device settings index.
            val value = (payload as? JsonObject)?.get("section")
            require(value is JsonPrimitive && value.isString) { "设置分组无效。" }
            return entries.firstOrNull { it.route == value.content } ?: error("未知的设置分组。")
        }
    }
}

internal const val CHAT_BRIDGE_LIMIT = 2 * 1024 * 1024

@Serializable
internal data class ChatContinuationDraft(
    val id: String = UUID.randomUUID().toString(),
    val title: String,
    val text: String,
    val sourceArchiveId: String,
    val recipient: String? = null,
) {
    fun matchesAccount(ownerId: String?): Boolean =
        if (recipient == null) ownerId != null else recipient == continuationRecipient(ownerId)


    fun message(): String = buildJsonObject {
        put("version", 1); put("id", id); put("type", "continuation.create")
        putJsonObject("payload") {
            put("title", title); put("text", text); put("sourceArchiveId", sourceArchiveId)
        }
    }.toString()
}

internal fun matchesChatBridgeOwner(payload: JsonObject, userId: String?): Boolean {
    val owner = payload["ownerId"] as? JsonPrimitive ?: return false
    val guest = payload["guest"] as? JsonPrimitive ?: return false
    return owner.isString && owner.content == (userId ?: "local") &&
        !guest.isString && guest.booleanOrNull == (userId == null)
}

internal fun continuationRecipient(ownerId: String?) = ownerId?.let { "account:$it" } ?: "guest"

/** The handoff is private local data, kept until the web database acknowledges its durable save. */
internal object ChatHandoff {
    fun account(context: Context, userId: String?, serviceUrl: String): AccountSession? {
        if (userId == null || serviceUrl.trimEnd('/') != CHAT_API) return null
        return runCatching {
            appJson.decodeFromString<AccountSession>(SecureCredentials(context).get("current_account"))
                .takeIf { it.user.id == userId && it.serviceUrl.trimEnd('/') == CHAT_API && !accountSessionExpired(it) }
        }.getOrNull()
    }

    private fun pendingFile(context: Context) = File(context.filesDir, "chat-continuation-pending.json")

    fun pending(context: Context): ChatContinuationDraft? = runCatching {
        val file = pendingFile(context)
        if (!file.isFile || file.length() > CHAT_BRIDGE_LIMIT) null
        else appJson.decodeFromString<ChatContinuationDraft>(file.readText())
    }.getOrNull()

    fun save(context: Context, draft: ChatContinuationDraft) {
        val serialized = appJson.encodeToString(draft)
        require(draft.text.isNotBlank() && draft.message().toByteArray().size <= CHAT_BRIDGE_LIMIT) {
            "续聊内容超过本机传递上限，请保存文件后选取较短的内容。"
        }
        val file = pendingFile(context)
        val temporary = File(file.parentFile, file.name + ".tmp")
        temporary.writeText(serialized)
        check(temporary.renameTo(file)) { "续聊内容暂存失败，请重试。" }
    }

    fun acknowledge(context: Context, id: String) {
        if (pending(context)?.id == id) pendingFile(context).delete()
    }
}

/** Imported chats are data. Only explicit, bounded user/assistant text is admitted to the source store. */
internal fun chatOrganizeImport(payload: JsonObject): ByteArray {
    val conversationId = payload["conversationId"]?.jsonPrimitive?.content.orEmpty()
    require(conversationId.isNotBlank() && conversationId.length <= 200) { "聊天标识无效。" }
    val title = payload["title"]?.jsonPrimitive?.content.orEmpty().take(200).ifBlank { "聊天记忆" }
    val messages = payload["messages"] as? JsonArray ?: error("没有找到可整理的聊天原文。")
    require(messages.isNotEmpty() && messages.size <= 10000) { "请选择一段包含消息的聊天。" }
    val identities = mutableSetOf<String>()
    val copied = messages.map { element ->
        val message = element as? JsonObject ?: error("聊天消息格式无效。")
        val id = message["id"]?.jsonPrimitive?.content.orEmpty()
        val role = message["role"]?.jsonPrimitive?.content.orEmpty()
        val content = message["content"]?.jsonPrimitive?.content ?: error("聊天原文缺失。")
        require(id.isNotBlank() && id.length <= 200 && identities.add(id)) { "消息标识重复或无效。" }
        require(role == "user" || role == "assistant") { "只支持明确的用户与助手发言。" }
        buildJsonObject {
            put("id", id); put("role", role); put("content", content)
            message["createdAt"]?.let { put("created_at", it) }
        }
    }
    require(copied.any { it["content"]!!.jsonPrimitive.content.isNotBlank() }) { "这段聊天没有可整理的文字。" }
    val document = buildJsonObject {
        put("id", "local-chat:$conversationId"); put("title", title)
        put("messages", JsonArray(copied))
    }.toString().toByteArray(Charsets.UTF_8)
    require(document.size <= CHAT_BRIDGE_LIMIT) { "聊天较长，请选取较短的一段。" }
    return document
}
