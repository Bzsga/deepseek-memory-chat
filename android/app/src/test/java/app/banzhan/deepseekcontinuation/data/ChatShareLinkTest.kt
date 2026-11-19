package app.banzhan.deepseekcontinuation.data

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ChatShareLinkTest {
    private val prefix = "$CHAT_ORIGIN/deepseek/share/"
    private val token = "AbCd0123456789_-"

    @Test fun officialLinksKeepTheirExactUrlAndTitle() {
        listOf("A".repeat(16), token.repeat(8)).forEach { id ->
            val url = prefix + id
            val title = "周末安排\n我们说过的话"
            assertEquals(ChatShareLink(url, title), chatShareLink(payload(url, title)))
        }
        assertEquals("", chatShareLink(payload(prefix + token, "")).title)
        assertEquals("题".repeat(200), chatShareLink(payload(prefix + token, "题".repeat(200))).title)
    }

    @Test fun otherDestinationsAndUrlAdditionsAreRejected() {
        listOf(
            "http://digimonlegend.com/deepseek/share/$token",
            "javascript:alert(1)",
            "https://other.example/deepseek/share/$token",
            "https://digimonlegend.com.other.example/deepseek/share/$token",
            "https://digimonlegend.com@other.example/deepseek/share/$token",
            "https://user@digimonlegend.com/deepseek/share/$token",
            "https://digimonlegend.com:8443/deepseek/share/$token",
            "$prefix$token?key=value",
            "$prefix$token?",
            "$prefix$token#fragment",
            "$prefix$token#",
            "$prefix$token/",
            " $prefix$token",
            "$prefix$token\n",
            "https://digimonlegend.com/deepseek/../deepseek/share/$token",
            "https://digimonlegend.com/deepseek/share%2F$token",
            "$prefix%41${"A".repeat(15)}",
        ).forEach { url ->
            assertThrows(url, IllegalArgumentException::class.java) { chatShareLink(payload(url, "分享")) }
        }
    }

    @Test fun tokenAndTextBoundsAreEnforced() {
        listOf("A".repeat(15), "A".repeat(129), "A".repeat(15) + ".", "中".repeat(16)).forEach { id ->
            assertThrows(IllegalArgumentException::class.java) { chatShareLink(payload(prefix + id, "分享")) }
        }
        assertThrows(IllegalArgumentException::class.java) { chatShareLink(payload("x".repeat(2049), "分享")) }
        assertThrows(IllegalArgumentException::class.java) { chatShareLink(payload(prefix + token, "题".repeat(201))) }
    }

    @Test fun requiredFieldsMustBeStrings() {
        listOf(
            buildJsonObject { put("url", prefix + token) },
            buildJsonObject { put("title", "分享") },
            buildJsonObject { put("url", prefix + token); put("title", 123) },
            buildJsonObject { put("url", prefix + token); put("title", JsonNull) },
            buildJsonObject { put("url", JsonPrimitive(123)); put("title", "分享") },
        ).forEach { input ->
            assertThrows(IllegalArgumentException::class.java) { chatShareLink(input) }
        }
    }

    private fun payload(url: String, title: String): JsonObject = buildJsonObject {
        put("url", url)
        put("title", title)
    }
}
