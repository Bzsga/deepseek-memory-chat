package app.banzhan.deepseekcontinuation.data

import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PersonalChatTasksTest {
    private val owner = "a"
    private val id = "job-01"
    private val provider = "https://provider.test/v1/chat/completions"
    private val body = """{"model":"test-model","messages":[],"stream":true}"""
    private val key = "test-local-secret"

    @Test
    fun validatesAndBuildsOfficialAndCompatibleRequests() {
        val official = personalChatRequest("https://api.deepseek.com/anthropic/v1/messages", key, body, true)!!
        assertEquals("Bearer $key", official.header("Authorization"))
        assertEquals("files-api-2025-04-14", official.header("anthropic-beta"))
        assertEquals("text/event-stream", official.header("Accept"))
        assertTrue(official.body!!.isOneShot())
        assertEquals(body, Buffer().also(official.body!!::writeTo).readUtf8())
        assertNull(personalChatRequest(provider, key, body, false)?.header("anthropic-beta"))
        assertNull(personalChatRequest(provider, key, body, true))
        assertNull(personalChatRequest(provider.replace("https", "http"), key, body, false))
        assertNull(personalChatRequest("https://user@provider.test/v1/chat/completions", key, body, false))
        assertNull(personalChatRequest("$provider?token=bad", key, body, false))
        assertNull(personalChatRequest("$provider#bad", key, body, false))
        assertNull(personalChatRequest("https://other.test/anthropic/v1/messages", key, body, false))
        assertNull(personalChatRequest(provider, "invalid key", body, false))
        assertNull(personalChatRequest(provider, key, "汉".repeat(700_000), false))
    }

    @Test
    fun startsOnlyWhenDispatchedAndReadsTerminalBytesByOwnerAndOffset() = MockWebServer().use { server ->
        val payload = ByteArray(86_731) { (it and 255).toByte() }
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream; charset=utf-8")
            .setBody(Buffer().write(payload)))
        val jobs = store(server)
        var launches = 0
        val request = request()
        assertEquals("running", jobs.start(owner, id, request) { launches++ }.text("state"))
        assertEquals("running", jobs.start(owner, id, request) { launches++ }.text("state"))
        assertEquals(1, launches)
        assertEquals(0, server.requestCount)
        assertEquals("personal_chat_not_found", jobs.cancel("other", id).text("code"))
        val missing = jobs.read("other", id, 37)
        assertEquals("personal_chat_not_found", missing.text("code"))
        assertEquals(37, missing.number("nextOffset"))

        val idle = CountDownLatch(1)
        jobs.dispatch(idle::countDown)
        jobs.dispatch(idle::countDown)
        assertTrue(idle.await(5, TimeUnit.SECONDS))
        val received = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("Bearer $key", received.getHeader("Authorization"))
        assertEquals(body, received.body.readUtf8())
        assertEquals(1, server.requestCount)

        val first = jobs.read(owner, id, 0)
        assertEquals("done", first.text("state"))
        assertEquals(200, first.number("status"))
        assertEquals("text/event-stream", first.text("contentType"))
        assertEquals(65_536, first.number("nextOffset"))
        val last = jobs.read(owner, id, first.number("nextOffset"))
        assertEquals("done", last.text("state"))
        assertEquals(payload.size, last.number("nextOffset"))
        assertArrayEquals(payload, first.decodeChunk() + last.decodeChunk())
        val eof = jobs.read(owner, id, payload.size)
        assertEquals("done", eof.text("state"))
        assertEquals(payload.size, eof.number("nextOffset"))
        assertNull(eof["chunk"])
        assertEquals("personal_chat_invalid_offset", jobs.read(owner, id, payload.size + 1).text("code"))
        assertEquals("done", jobs.start(owner, id, request) { launches++ }.text("state"))
        assertEquals(1, launches)
    }

    @Test
    fun retainsProviderHttpFailuresWithoutRedirectOrRetry() = MockWebServer().use { server ->
        for ((index, status) in listOf(307, 421, 503).withIndex()) {
            val jobId = "http-$index"
            val prevCount = server.requestCount
            server.enqueue(MockResponse().setResponseCode(status)
                .setHeader("Location", server.url("/must-not-follow"))
                .setHeader("Retry-After", "0")
                .setBody("provider-status-$status"))
            val jobs = store(server)
            val idle = CountDownLatch(1)
            jobs.start(owner, jobId, request()) {}
            jobs.dispatch(idle::countDown)
            assertTrue(idle.await(5, TimeUnit.SECONDS))
            val answer = jobs.read(owner, jobId, 0)
            assertEquals("done", answer.text("state"))
            assertEquals(status, answer.number("status"))
            assertEquals("provider-status-$status", answer.decodeChunk().toString(Charsets.UTF_8))
            assertEquals(prevCount + 1, server.requestCount)
        }
    }

    @Test
    fun cancellationAndForegroundLaunchFailureLeaveTerminalResults() = MockWebServer().use { server ->
        val jobs = store(server)
        val deniedId = "denied"
        val denied = jobs.start(owner, deniedId, request()) { throw SecurityException("private") }
        assertEquals("failed", denied.text("state"))
        assertEquals("personal_chat_unavailable", denied.text("code"))
        assertEquals(0, server.requestCount)
        assertEquals("personal_chat_unavailable", jobs.read(owner, deniedId, 0).text("code"))
        assertEquals("failed", jobs.start(owner, deniedId, request()) { error("dispatch must not repeat") }.text("state"))

        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        assertEquals("running", jobs.start(owner, id, request()) {}.text("state"))
        val idle = CountDownLatch(1)
        jobs.dispatch(idle::countDown)
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        assertEquals("cancelled", jobs.cancel(owner, id).text("state"))
        assertTrue(idle.await(5, TimeUnit.SECONDS))
        assertEquals("personal_chat_cancelled", jobs.read(owner, id, 0).text("code"))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun capsActiveTasksAndDoesNotRestartAnExpiredId() {
        var ticks = 0L
        val jobs = PersonalChatTaskStore(now = { ticks })
        jobs.start(owner, id, request()) {}
        jobs.start(owner, "second", request()) {}
        assertEquals("personal_chat_capacity", jobs.start(owner, "third", request()) {}.text("code"))
        jobs.cancel(owner, id)
        ticks = TimeUnit.MINUTES.toNanos(16)
        assertEquals("personal_chat_expired", jobs.read(owner, id, 0).text("code"))
        assertEquals("personal_chat_expired", jobs.start(owner, id, request()) { error("must not restart") }.text("code"))
        assertEquals("running", jobs.start(owner, "third", request()) {}.text("state"))
        jobs.stop()
    }

    private fun request() = personalChatRequest(provider, key, body, false)!!

    // Only the test transport rewrites the validated HTTPS target to loopback.
    private fun store(server: MockWebServer) = PersonalChatTaskStore(
        personalChatClient().newBuilder().addInterceptor { chain ->
            val request = chain.request()
            chain.proceed(request.newBuilder().url(server.url(request.url.encodedPath)).build())
        }.build(),
    )

    private fun JsonObject.text(name: String) = this[name]?.jsonPrimitive?.content
    private fun JsonObject.number(name: String) = getValue(name).jsonPrimitive.int
    private fun JsonObject.decodeChunk() = Base64.getDecoder().decode(text("chunk")!!)
}
