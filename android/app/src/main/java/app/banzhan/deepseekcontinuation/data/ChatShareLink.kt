package app.banzhan.deepseekcontinuation.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal data class ChatShareLink(val url: String, val title: String)

private val chatShareLinkPattern =
    Regex("${Regex.escape(CHAT_ORIGIN)}/deepseek/share/[A-Za-z0-9_-]{16,128}")

internal fun chatShareLink(payload: JsonObject): ChatShareLink {
    val url = (payload["url"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    val title = (payload["title"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    require(url != null && url.length <= 2048 && chatShareLinkPattern.matches(url)) { "分享链接无效。" }
    require(title != null && title.length <= 200) { "分享标题无效或过长。" }
    return ChatShareLink(url, title)
}
