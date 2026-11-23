package app.banzhan.deepseekcontinuation.ui

import android.content.Context
import app.banzhan.deepseekcontinuation.data.PersonalMcpActionResult
import app.banzhan.deepseekcontinuation.data.PersonalMcpActionTool
import app.banzhan.deepseekcontinuation.data.PersonalMcpException
import app.banzhan.deepseekcontinuation.data.PersonalMcpNetwork
import app.banzhan.deepseekcontinuation.data.PersonalMcpSource
import app.banzhan.deepseekcontinuation.data.PersonalMcpTool
import app.banzhan.deepseekcontinuation.data.SecureCredentials
import app.banzhan.deepseekcontinuation.data.appJson
import app.banzhan.deepseekcontinuation.data.continuationRecipient
import app.banzhan.deepseekcontinuation.data.matchesChatBridgeOwner
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

private const val MAX_MCP_FRAME_BYTES = 12 * 1024
private const val MAX_MCP_INVOKE_FRAME_BYTES = 32 * 1024
private const val MAX_MCP_INVOCATIONS_PER_PORT = 1024
private const val MCP_REQUEST_TIMEOUT_MS = 20_000L
private val mcpCallId = Regex("[A-Za-z0-9_.:-]{1,100}")
private val mcpToolName = Regex("[A-Za-z0-9_.-]{1,128}")
private val mcpToolRevision = Regex("[0-9a-f]{64}")

/** The token stays in Android's encrypted preferences. Each trusted chat workspace has its own source. */
internal class PersonalMcpBridge(
    private val readCredential: suspend (String) -> String,
    private val writeCredential: (String, String) -> Unit,
    private val validateEndpoint: (String) -> String = PersonalMcpNetwork::validateEndpoint,
    private val discover: suspend (String, String) -> List<PersonalMcpTool> = PersonalMcpNetwork::discover,
    private val lookup: suspend (String, String, String, String) -> List<PersonalMcpSource> = PersonalMcpNetwork::lookup,
    private val listTools: suspend (String, String) -> List<PersonalMcpActionTool> = PersonalMcpNetwork::listTools,
    private val invokeTool: suspend (String, String, String, String, JsonObject, () -> Boolean) -> PersonalMcpActionResult =
        PersonalMcpNetwork::invokeTool,
) {
    constructor(context: Context) : this(SecureCredentials(context.applicationContext))

    private constructor(credentials: SecureCredentials) : this(
        readCredential = { name -> withContext(Dispatchers.IO) { credentials.get(name) } },
        writeCredential = credentials::put,
    )

    private val operations = Mutex()
    private var invocationPort: Any? = null
    private val invocationIds = mutableSetOf<String>()

    /** Called on the chat screen's coroutine context. Network and credential reads can suspend. */
    suspend fun respond(
        type: String,
        message: JsonObject,
        frameBytes: Int,
        ownerId: String?,
        active: () -> Boolean,
        personalAllowed: () -> Boolean,
        portIdentity: Any = this,
    ): String? {
        val id = message.text("id")?.takeIf(mcpCallId::matches) ?: return null
        if (!active()) return null
        val version = (message["version"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
        val payload = message["payload"] as? JsonObject
        val invoking = type == "mcp.invoke"
        val frameLimit = if (invoking) MAX_MCP_INVOKE_FRAME_BYTES else MAX_MCP_FRAME_BYTES
        if (version != 1 || frameBytes !in 1..frameLimit || payload == null) {
            return bridgeAck(id, "MCP 请求格式无效。")
        }
        if (!matchesChatBridgeOwner(payload, ownerId)) {
            return bridgeAck(id, "聊天账号已变化，请重新打开聊天后重试。")
        }
        if (invoking) {
            if (invocationPort !== portIdentity) {
                invocationPort = portIdentity
                invocationIds.clear()
            }
            // The first delivery owns the ACK, including when a duplicate arrives while it is pending.
            if (id in invocationIds) return null
            if (invocationIds.size >= MAX_MCP_INVOCATIONS_PER_PORT) {
                return bridgeAck(id, "当前聊天页面已达到工具调用上限，请重新打开聊天。")
            }
            // A request refused while busy must never execute if the same frame is delivered again.
            invocationIds.add(id)
        }
        if (!operations.tryLock()) return bridgeAck(id, "正在处理资料库请求，请稍后重试。")
        var dispatched = false
        try {
            val slot = "personal-mcp:" + continuationRecipient(ownerId)
            val result = withTimeoutOrNull(MCP_REQUEST_TIMEOUT_MS) {
                handle(type, slot, payload, active, personalAllowed) {
                    active().also { if (it) dispatched = true }
                }
            } ?: if (dispatched) uncertainMcpInvocation() else throw InvalidMcpRequest("资料库响应超时，请稍后重试。")
            return if (active()) bridgeAck(id, null, result) else null
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (!active()) return null
            if (dispatched) return bridgeAck(id, null, uncertainMcpInvocation())
            val detail = when (error) {
                is InvalidMcpRequest, is PersonalMcpException -> error.message
                else -> null
            }
            return bridgeAck(id, detail ?: "无法完成资料库操作，请检查配置后重试。")
        } finally {
            operations.unlock()
        }
    }

    private suspend fun handle(
        type: String,
        slot: String,
        payload: JsonObject,
        active: () -> Boolean,
        personalAllowed: () -> Boolean,
        canDispatch: () -> Boolean,
    ): JsonObject = when (type) {
        "mcp.settings" -> {
            payload.allowFields()
            mcpSettings(readConfig(slot))
        }

        "mcp.discover", "mcp.save" -> {
            val saving = type == "mcp.save"
            if (saving) payload.allowFields("endpoint", "token", "toolName")
            else payload.allowFields("endpoint", "token")
            val endpoint = validateEndpoint(payload.readText("endpoint", 2048))
            val stored = readConfig(slot)
            val token = payload.token(stored?.takeIf { it.endpoint == endpoint }?.token.orEmpty())
            val toolName = if (saving) payload.text("toolName")?.takeIf { it.isEmpty() || mcpToolName.matches(it) }
                ?: throw InvalidMcpRequest("MCP 请求缺少有效的查询工具名称。") else null
            requireActive(active)
            val tools = if (toolName == "") {
                listTools(endpoint, token)
                emptyList()
            } else discover(endpoint, token)
            requireActive(active)
            if (toolName != null) {
                val tool = tools.firstOrNull { it.name == toolName }
                if (tool == null && toolName.isNotEmpty()) {
                    throw InvalidMcpRequest("请重新选择资料库提供的只读查询工具。")
                }
                val next = McpConfig(endpoint, token, toolName, tool?.title.orEmpty())
                // The port and account check above and the small encrypted write share a UI turn.
                writeCredential(slot, appJson.encodeToString(McpConfig.serializer(), next))
                mcpSettings(next)
            } else {
                buildJsonObject {
                    put("tools", JsonArray(tools.map { tool ->
                        buildJsonObject {
                            put("name", tool.name)
                            put("title", tool.title)
                        }
                    }))
                }
            }
        }

        "mcp.tools" -> {
            payload.allowFields()
            val config = requireConfig(slot)
            requireActive(active)
            val tools = listTools(config.endpoint, config.token)
            buildJsonObject {
                put("tools", JsonArray(tools.map { tool ->
                    buildJsonObject {
                        put("name", tool.name)
                        put("title", tool.title)
                        put("description", tool.description)
                        put("inputSchema", tool.inputSchema)
                        put("readOnly", tool.readOnly)
                        put("revision", tool.revision)
                    }
                }))
            }
        }

        "mcp.invoke" -> {
            payload.allowFields("endpoint", "toolName", "revision", "arguments")
            val config = requireConfig(slot)
            if (payload.text("endpoint") != config.endpoint) {
                throw InvalidMcpRequest("MCP 服务已切换，请重新打开工具并确认。")
            }
            val name = payload.text("toolName")?.takeIf(mcpToolName::matches)
            val revision = payload.text("revision")?.takeIf(mcpToolRevision::matches)
            val args = payload["arguments"] as? JsonObject
            if (name == null || revision == null || args == null) {
                throw InvalidMcpRequest("MCP 工具请求格式无效。")
            }
            requireActive(active)
            val result = invokeTool(config.endpoint, config.token, name, revision, args, canDispatch)
            mcpInvocationResult(result.status, result.text, result.truncated)
        }

        "mcp.clear" -> {
            payload.allowFields()
            requireActive(active)
            writeCredential(slot, "")
            mcpSettings(null)
        }

        "mcp.lookup" -> {
            payload.allowFields("query")
            val query = payload.readText("query", 2000)
            requirePersonalMode(personalAllowed)
            val config = requireConfig(slot)
            if (config.toolName.isEmpty()) throw InvalidMcpRequest("请先选择 MCP 只读查询工具。")
            requireActive(active)
            requirePersonalMode(personalAllowed)
            val sources = lookup(config.endpoint, config.token, config.toolName, query)
            requireActive(active)
            requirePersonalMode(personalAllowed)
            buildJsonObject {
                put("sources", JsonArray(sources.map { source ->
                    buildJsonObject {
                        put("title", source.title)
                        put("url", source.url)
                        put("text", source.text)
                    }
                }))
            }
        }

        else -> throw InvalidMcpRequest("此操作不受支持。")
    }

    private suspend fun readConfig(slot: String): McpConfig? {
        val encoded = readCredential(slot)
        return encoded.takeIf(String::isNotEmpty)?.let { appJson.decodeFromString(McpConfig.serializer(), it) }
    }

    private suspend fun requireConfig(slot: String): McpConfig =
        readConfig(slot) ?: throw InvalidMcpRequest("请先配置 MCP 服务。")
}

@Serializable
private data class McpConfig(
    val endpoint: String,
    val token: String,
    val toolName: String,
    val toolTitle: String,
)

private fun mcpSettings(config: McpConfig?) = buildJsonObject {
    put("endpoint", config?.endpoint.orEmpty())
    put("toolName", config?.toolName.orEmpty())
    put("toolTitle", config?.toolTitle.orEmpty())
    put("hasToken", !config?.token.isNullOrEmpty())
}

private fun mcpInvocationResult(status: String, text: String, truncated: Boolean) = buildJsonObject {
    put("status", status)
    put("text", text)
    put("truncated", truncated)
}

private fun uncertainMcpInvocation() = mcpInvocationResult(
    "uncertain", "无法确认工具是否已执行，请先到服务中核对结果。", false,
)

private class InvalidMcpRequest(message: String) : IllegalArgumentException(message)

private fun requireActive(active: () -> Boolean) {
    if (!active()) throw InvalidMcpRequest("聊天页面已切换，请重试。")
}

private fun requirePersonalMode(personalAllowed: () -> Boolean) {
    if (!personalAllowed()) throw InvalidMcpRequest("请切换到已配置 Key 的个人聊天 API。")
}

private fun JsonObject.allowFields(vararg fields: String) {
    if (keys.any { it != "ownerId" && it != "guest" && it !in fields }) {
        throw InvalidMcpRequest("MCP 请求格式无效。")
    }
}

private fun JsonObject.text(name: String): String? = (get(name) as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.readText(name: String, limit: Int): String =
    text(name)?.takeIf { it.length <= limit }?.trim()?.takeIf(String::isNotEmpty)
        ?: throw InvalidMcpRequest("MCP 请求包含缺失或过长的内容。")

private fun JsonObject.token(fallback: String): String {
    if (!containsKey("token")) return fallback
    return text("token")?.takeIf { it.length <= 4096 && it.all { character -> character in '!'..'~' } }
        ?: throw InvalidMcpRequest("资料库访问令牌格式无效。")
}
