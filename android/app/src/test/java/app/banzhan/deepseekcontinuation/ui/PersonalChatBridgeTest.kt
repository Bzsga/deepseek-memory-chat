package app.banzhan.deepseekcontinuation.ui

import android.content.ContextWrapper
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class PersonalChatBridgeTest {
    private val context = ContextWrapper(null)
    private val payload = buildJsonObject {
        put("jobId", "test-job-1")
        put("url", "https://provider.example.invalid/anthropic/v1/messages")
        put("key", "synthetic-key")
        put("body", "{}")
        put("filesBeta", false)
    }

    @Test fun startIsRejectedWhenChatIsNotVisible() {
        val response = response("personal.chat.start", false, request(payload))
        assertEquals("personal.chat.response", response["type"]?.jsonPrimitive?.content)
        assertEquals("synthetic-call", response["id"]?.jsonPrimitive?.content)
        assertEquals("personal_chat_foreground_required", response["code"]?.jsonPrimitive?.content)
        assertFalse(response["ok"]?.jsonPrimitive?.booleanOrNull ?: true)
    }

    @Test fun rejectsInvalidPayloadWithoutEchoingKey() {
        val keyWithSpace = "synthetic secret"
        val malformedPayload = JsonObject(payload + ("key" to JsonPrimitive(keyWithSpace)))
        val response = response("personal.chat.start", true, request(malformedPayload))
        assertEquals("personal_chat_invalid_request", response["code"]?.jsonPrimitive?.content)
        assertFalse(response.toString().contains(keyWithSpace))
    }

    @Test fun rejectsUnknownVersion() {
        assertNull(personalChatBridgeResponse(context, "guest", false, "personal.chat.start", request(payload, 2)))
    }

    private fun request(payload: JsonObject, version: Int = 1) = buildJsonObject {
        put("version", version)
        put("id", "synthetic-call")
        put("payload", payload)
    }

    private fun response(type: String, visible: Boolean, request: JsonObject): JsonObject =
        Json.parseToJsonElement(checkNotNull(personalChatBridgeResponse(context, "guest", visible, type, request))).jsonObject
}
