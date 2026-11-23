package app.banzhan.deepseekcontinuation.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class OrganizationAuthenticationTest {
    @Test fun personal401RemainsDefiniteWithOversizedErrorBody() = runBlocking {
        MockWebServer().use { provider ->
            provider.enqueue(MockResponse().setResponseCode(401).setBody("sensitive-provider-error".repeat(4)))
            val request = Request.Builder().url(provider.url("/v1/chat/completions"))
                .header("Authorization", "Bearer old-test-key").post("{}".toRequestBody()).build()
            val failure = try {
                SummaryNetwork.exchange(request, mutation = true, maxResponseBytes = 16, personalOrganization = true)
                error("Expected authentication refusal")
            } catch (error: SummaryFailure) {
                error
            }
            assertEquals(401, failure.statusCode)
            assertFalse(failure.ambiguous)
            assertFalse(failure.message.orEmpty().contains("sensitive-provider-error"))
            assertEquals(1, provider.requestCount)
        }
    }

    @Test fun older401TaskCanSelectUpdatedKeyForSameProviderAndPreserveProgress() {
        val frozen = ServiceSettings(baseUrl = "https://provider.example/v1", model = "model")
        val done = TaskChunk("done", emptyList(), "stored", completed = true)
        val pending = TaskChunk("pending", emptyList(), "pending")
        val legacy = TaskRecord("task", "archive", "label", frozen, "task:task", listOf(done, pending),
            status = "paused", message = "服务返回 HTTP 401，旧服务拒绝了凭据")
        val oldJson = Json.parseToJsonElement(appJson.encodeToString(TaskRecord.serializer(), legacy))
            as kotlinx.serialization.json.JsonObject
        val restored = appJson.decodeFromString(TaskRecord.serializer(),
            kotlinx.serialization.json.JsonObject(oldJson - "personalKeyRejected").toString())
        val current = frozen.copy(baseUrl = "https://provider.example/v1/", apiKey = "changed-key")
        assertTrue(restored.needsPersonalKey)
        assertFalse(restored.copy(settings = frozen.copy(mode = "companion")).needsPersonalKey)
        assertEquals("changed-key", replacementOrganizationKey(restored.settings, current))
        assertEquals(done, restored.chunksForExplicitResume().first())
        assertThrows(IllegalArgumentException::class.java) {
            replacementOrganizationKey(restored.settings, current.copy(baseUrl = "https://different.example/v1"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            replacementOrganizationKey(restored.settings, current.copy(model = "different"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            replacementOrganizationKey(restored.settings, current.copy(apiKey = ""))
        }
    }
}
