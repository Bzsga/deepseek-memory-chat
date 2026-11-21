package app.banzhan.deepseekcontinuation.ui

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.banzhan.deepseekcontinuation.data.PersonalImageFile
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PersonalImageChannelTest {
    @Test
    fun assemblesMultipleFilesAndKeepsUnicodeWholeAcrossResponseFrames() = runBlocking {
        withContext(Dispatchers.Main) {
            val chunkSize = 96 * 1024
            val first = ByteArray(chunkSize + 11) { (it % 251).toByte() }
            val second = byteArrayOf(1, 2, 3, 4)
            val responseHead = "{\"data\":[{\"id\":\""
            val split = 128 * 1024 - 1
            val response = responseHead + "x".repeat(split - responseHead.length) + "🖼️\"}]}"
            lateinit var uploaded: List<PersonalImageFile>
            val transport = Transport { uploaded = it; response }
            try {
                transport.send("image.request") {
                    put("operation", "edit")
                    put("url", "https://example.invalid/v1/images/edits")
                    put("key", "fixture-key")
                    put("model", "fixture-model")
                    put("prompt", "参考图")
                    put("files", buildJsonArray {
                        add(fileEntry("第一张.png", "image/png", first.size))
                        add(fileEntry("second.jpg", "image/jpeg", second.size))
                    })
                }
                transport.expect("image.ack")
                transport.upload(0, first.copyOfRange(0, chunkSize))
                transport.upload(0, first.copyOfRange(chunkSize, first.size))
                transport.upload(1, second)
                transport.send("image.run")

                val frame1 = transport.expect("image.result").getValue("data").jsonPrimitive.content
                val frame2 = transport.expect("image.result").getValue("data").jsonPrimitive.content
                transport.expect("image.done")
                assertEquals(split, frame1.length)
                assertEquals(response, frame1 + frame2)
                assertEquals(listOf("第一张.png", "second.jpg"), uploaded.map { it.name })
                assertArrayEquals(first, uploaded[0].bytes)
                assertArrayEquals(second, uploaded[1].bytes)
            } finally {
                transport.close()
            }
        }
    }

    @Test
    fun cancelStopsTheExchangeWithoutSendingAResult() = runBlocking {
        withContext(Dispatchers.Main) {
            val started = CompletableDeferred<Unit>()
            val cancelled = CompletableDeferred<Unit>()
            val transport = Transport {
                try {
                    started.complete(Unit)
                    awaitCancellation()
                } finally {
                    cancelled.complete(Unit)
                }
            }
            try {
                transport.requestModels()
                withTimeout(5_000) { started.await() }
                transport.send("image.cancel")
                withTimeout(5_000) { cancelled.await() }
                assertTrue(transport.replies.tryReceive().isFailure)
            } finally {
                transport.close()
            }
        }
    }

    @Test
    fun discardsRepliesWhenThePageIsNoLongerActive() = runBlocking {
        withContext(Dispatchers.Main) {
            var active = true
            val transport = Transport(active = { active }) {
                active = false
                "{\"data\":[]}"
            }
            try {
                transport.requestModels()
                assertFalse(active)
                assertTrue(transport.replies.tryReceive().isFailure)
            } finally {
                transport.close()
            }
        }
    }

    private fun fileEntry(name: String, mime: String, size: Int) = buildJsonObject {
        put("name", name)
        put("mime", mime)
        put("size", size)
    }

    private class Transport(
        active: () -> Boolean = { true },
        exchange: suspend (List<PersonalImageFile>) -> String,
    ) {
        val replies = Channel<JsonObject>(Channel.UNLIMITED)
        private val channel = PersonalImageChannel(
            active,
            post = { replies.trySend(Json.parseToJsonElement(it).jsonObject) },
            exchange = { _, _, _, _, _, files -> exchange(files) },
        )

        fun send(type: String, body: JsonObjectBuilder.() -> Unit = {}) {
            val frame = buildJsonObject {
                put("type", type)
                put("id", "image-fixture")
                put("version", 1)
                body()
            }
            channel.message(type, frame, frame.toString().length)
        }

        suspend fun expect(type: String): JsonObject = withTimeout(5_000) {
            replies.receive().also {
                assertEquals(type, it.getValue("type").jsonPrimitive.content)
                assertEquals("1", it.getValue("version").jsonPrimitive.content)
                assertEquals("image-fixture", it.getValue("id").jsonPrimitive.content)
            }
        }

        suspend fun upload(index: Int, bytes: ByteArray) {
            send("image.chunk") {
                put("index", index)
                put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
            }
            expect("image.ack")
        }

        suspend fun requestModels() {
            send("image.request") {
                put("operation", "models")
                put("url", "https://example.invalid/v1/models")
                put("key", "fixture-key")
            }
            expect("image.ack")
            send("image.run")
        }

        fun close() = channel.close()
    }
}
