package app.banzhan.deepseekcontinuation.ui

import app.banzhan.deepseekcontinuation.core.ImportedConversation
import kotlinx.serialization.json.*

/** Send each original chat node once, even when many branches share its prefix. */
internal fun ImportedConversation.chatImportJson(): String {
    val nodes = linkedMapOf<String, JsonObject>()
    val children = mutableMapOf<String, String>()
    var root: String? = null
    for (branch in branches.sortedByDescending { it.id == currentBranchId || it.isCurrent }) {
        var parent: String? = null
        for (message in branch.messages) {
            if (message.role !in setOf("user", "assistant")) continue
            if (root == null) root = message.id
            parent?.let { children.putIfAbsent(it, message.id) }
            nodes.getOrPut(message.id) { buildJsonObject {
                put("id", message.id); put("role", message.role); put("text", message.content)
                put("time", message.timestamp); parent?.let { put("parent", it) }
                put("attachments", buildJsonArray { message.attachments.forEach { add(it) } })
            } }
            parent = message.id
        }
    }
    return buildJsonObject {
        put("id", id); put("title", title); put("created", createdAt); put("updated", updatedAt)
        root?.let { put("root", it) }
        put("messages", buildJsonArray { nodes.forEach { (id, node) -> add(buildJsonObject {
            node.forEach { (key, value) -> put(key, value) }; children[id]?.let { put("next", it) }
        }) } })
    }.toString()
}
