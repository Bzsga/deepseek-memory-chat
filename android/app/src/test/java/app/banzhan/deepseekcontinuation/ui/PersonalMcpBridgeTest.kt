package app.banzhan.deepseekcontinuation.ui

import app.banzhan.deepseekcontinuation.data.PersonalMcpActionResult
import app.banzhan.deepseekcontinuation.data.PersonalMcpActionTool
import app.banzhan.deepseekcontinuation.data.PersonalMcpException
import app.banzhan.deepseekcontinuation.data.PersonalMcpSource
import app.banzhan.deepseekcontinuation.data.PersonalMcpTool
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PersonalMcpBridgeTest {
    private class Fixture {
        val credentials = mutableMapOf<String, String>()
        val discovery = mutableListOf<Pair<String, String>>()
        val catalogs = mutableListOf<Pair<String, String>>()
        val searches = mutableListOf<List<String>>()
        val invocations = mutableListOf<List<String>>()
        var beforeDispatch: suspend () -> Unit = {}
        var afterDispatch: suspend () -> Unit = {}
        var discoverHook: suspend () -> Unit = {}
        var active = true
        var personal = true
        private var requestCount = 0
        val bridge = PersonalMcpBridge(
            readCredential = { credentials[it].orEmpty() },
            writeCredential = { slot, value ->
                if (value.isEmpty()) credentials.remove(slot) else credentials[slot] = value
            },
            validateEndpoint = { it },
            discover = { endpoint, token ->
                discovery += endpoint to token
                discoverHook()
                listOf(PersonalMcpTool("search", "Search archive", "query"))
            },
            lookup = { endpoint, token, name, query ->
                searches += listOf(endpoint, token, name, query)
                listOf(PersonalMcpSource("Guide", "https://docs.example/guide", "Quoted excerpt."))
            },
            listTools = { endpoint, token ->
                catalogs += endpoint to token
                listOf(PersonalMcpActionTool("create_note", "Create note", "Writes a note.", schema, false, revision))
            },
            invokeTool = { endpoint, token, name, fingerprint, args, canDispatch ->
                beforeDispatch()
                if (!canDispatch()) throw PersonalMcpException("工具调用已取消。")
                invocations += listOf(endpoint, token, name, fingerprint, args.toString())
                afterDispatch()
                PersonalMcpActionResult("success", "Created item", false)
            },
        )

        suspend fun request(
            type: String,
            vararg fields: Pair<String, String>,
            owner: String? = "a",
            payloadOwner: String? = owner,
            id: String = "mcp-test-${++requestCount}",
            arguments: JsonObject? = null,
        ): JsonObject? {
            val frame = buildJsonObject {
                put("id", id)
                put("version", 1)
                put("payload", buildJsonObject {
                    put("ownerId", payloadOwner ?: "local")
                    put("guest", payloadOwner == null)
                    for ((name, value) in fields) put(name, value)
                    arguments?.let { put("arguments", it) }
                })
            }
            return bridge.respond(type, frame, frame.toString().toByteArray().size, owner,
                active = { active }, personalAllowed = { personal })
                ?.let { Json.parseToJsonElement(it).jsonObject }
        }

        suspend fun save(endpoint: String, vararg fields: Pair<String, String>, owner: String? = "a") =
            requireNotNull(request("mcp.save", "endpoint" to endpoint, "toolName" to "search", *fields, owner = owner))

        suspend fun invoke(endpoint: String, args: JsonObject, id: String = "invoke-${++requestCount}") =
            request("mcp.invoke", "endpoint" to endpoint, "toolName" to "create_note", "revision" to revision,
                id = id, arguments = args)
    }

    @Test
    fun tokenIsScopedToEndpointAndNeverAppearsInAcknowledgement() = runTest {
        val fixture = Fixture()
        val first = "https://mcp.example/a"
        val second = "https://mcp.example/b"
        val secret = "provided-secret"
        val saved = fixture.save(first, "token" to secret)
        assertTrue(saved.data()["hasToken"]!!.jsonPrimitive.boolean)
        assertFalse(saved.toString().contains(secret))
        assertEquals(first to secret, fixture.discovery.last())
        assertTrue(fixture.save(first).data()["hasToken"]!!.jsonPrimitive.boolean)
        assertEquals(first to secret, fixture.discovery.last())
        assertFalse(fixture.save(first, "token" to "").data()["hasToken"]!!.jsonPrimitive.boolean)
        assertEquals(first to "", fixture.discovery.last())
        fixture.save(first, "token" to secret)
        assertFalse(fixture.save(second).data()["hasToken"]!!.jsonPrimitive.boolean)
        assertEquals(second to "", fixture.discovery.last())
    }

    @Test
    fun eachWorkspaceHasIndependentSettingsAndUnapprovedToolsCannotBeSaved() = runTest {
        val fixture = Fixture()
        val first = "https://mcp.example/a"
        val second = "https://mcp.example/guest"
        fixture.save(first)
        fixture.save(second, owner = null)
        val wrong = requireNotNull(fixture.request("mcp.settings", owner = "a", payloadOwner = null))
        assertFalse(wrong["ok"]!!.jsonPrimitive.boolean)
        assertEquals("", requireNotNull(fixture.request("mcp.settings", owner = "b"))
            .data()["endpoint"]!!.jsonPrimitive.content)
        val unsupported = requireNotNull(fixture.request("mcp.save",
            "endpoint" to "https://mcp.example/unapproved", "toolName" to "other"))
        assertFalse(unsupported["ok"]!!.jsonPrimitive.boolean)
        val guest = requireNotNull(fixture.request("mcp.settings", owner = null)).data()
        assertEquals(second, guest["endpoint"]!!.jsonPrimitive.content)
        assertEquals(first, requireNotNull(fixture.request("mcp.settings")).data()["endpoint"]!!.jsonPrimitive.content)
        assertTrue(requireNotNull(fixture.request("mcp.clear"))["ok"]!!.jsonPrimitive.boolean)
        assertEquals("", requireNotNull(fixture.request("mcp.settings")).data()["endpoint"]!!.jsonPrimitive.content)
    }

    @Test
    fun lookupRequiresPersonalModeAndReturnsOnlySources() = runTest {
        val fixture = Fixture()
        val url = "https://mcp.example/path"
        fixture.save(url, "token" to "mcp-secret")
        fixture.personal = false
        assertFalse(requireNotNull(fixture.request("mcp.lookup", "query" to "question"))["ok"]!!.jsonPrimitive.boolean)
        assertTrue(fixture.searches.isEmpty())
        fixture.personal = true
        val invalid = requireNotNull(fixture.request("mcp.lookup", "query" to "question", "token" to "other"))
        assertFalse(invalid["ok"]!!.jsonPrimitive.boolean)
        assertTrue(fixture.searches.isEmpty())
        val result = requireNotNull(fixture.request("mcp.lookup", "query" to "question"))
        assertEquals(setOf("sources"), result.data().keys)
        assertTrue(result.toString().contains("https://docs.example/guide"))
        assertFalse(result.toString().contains("mcp-secret"))
        assertEquals(listOf(url, "mcp-secret", "search", "question"), fixture.searches.single())
    }

    @Test
    fun lateDiscoveryCannotSaveAfterWorkspaceSwitchAndTimeoutDoesNotLeaveLock() = runTest {
        val fixture = Fixture()
        fixture.discoverHook = { fixture.active = false }
        assertNull(fixture.request("mcp.save", "endpoint" to "https://mcp.example/a", "toolName" to "search"))
        assertTrue(fixture.credentials.isEmpty())
        fixture.active = true
        fixture.discoverHook = { delay(30_000) }
        val timeout = fixture.save("https://mcp.example/a")
        assertEquals("资料库响应超时，请稍后重试。", timeout["error"]!!.jsonPrimitive.content)
        fixture.discoverHook = {}
        assertTrue(fixture.save("https://mcp.example/a")["ok"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun toolsAndActionsWorkWithoutDefaultLookupOrChatKey() = runTest {
        val fixture = Fixture().apply { personal = false }
        val endpoint = "https://mcp.example/tasks"
        val saved = requireNotNull(fixture.request("mcp.save", "endpoint" to endpoint, "toolName" to "",
            "token" to "tool-secret"))
        assertEquals("", saved.data()["toolName"]!!.jsonPrimitive.content)
        assertTrue(fixture.discovery.isEmpty())
        assertEquals(listOf(endpoint to "tool-secret"), fixture.catalogs)
        val result = requireNotNull(fixture.request("mcp.tools"))
        val tool = result.data()["tools"]!!.jsonArray.single().jsonObject
        assertEquals(schema, tool["inputSchema"])
        assertEquals(revision, tool["revision"]!!.jsonPrimitive.content)
        assertFalse(tool["readOnly"]!!.jsonPrimitive.boolean)
        assertFalse(result.toString().contains("tool-secret"))
        val args = buildJsonObject { put("title", "x".repeat(23_000)) }
        assertFalse(requireNotNull(fixture.invoke("$endpoint/", args))["ok"]!!.jsonPrimitive.boolean)
        assertTrue(fixture.invocations.isEmpty())
        val action = requireNotNull(fixture.invoke(endpoint, args))
        assertEquals("success", action.data()["status"]!!.jsonPrimitive.content)
        assertEquals(listOf(endpoint, "tool-secret", "create_note", revision, args.toString()), fixture.invocations.single())
        assertFalse(action.toString().contains("tool-secret"))
        fixture.personal = true
        assertFalse(requireNotNull(fixture.request("mcp.lookup", "query" to "question"))["ok"]!!.jsonPrimitive.boolean)
        assertTrue(fixture.searches.isEmpty())
    }

    @Test
    fun samePortAndRequestIdNeverDispatchTwiceAndTimeoutIsUncertain() = runTest {
        val fixture = Fixture()
        val endpoint = "https://mcp.example/tasks"
        fixture.save(endpoint)
        val continuation = CompletableDeferred<Unit>()
        fixture.afterDispatch = { continuation.await() }
        val args = buildJsonObject { put("title", "test note") }
        val original = async(start = CoroutineStart.UNDISPATCHED) { fixture.invoke(endpoint, args, "same") }
        assertNull(fixture.invoke(endpoint, args, "same"))
        val refused = requireNotNull(fixture.invoke(endpoint, args, "busy"))
        assertFalse(refused["ok"]!!.jsonPrimitive.boolean)
        continuation.complete(Unit)
        assertEquals("success", requireNotNull(original.await()).data()["status"]!!.jsonPrimitive.content)
        assertNull(fixture.invoke(endpoint, args, "same"))
        assertNull(fixture.invoke(endpoint, args, "busy"))
        assertEquals(1, fixture.invocations.size)
        fixture.afterDispatch = { delay(30_000) }
        val timeout = requireNotNull(fixture.invoke(endpoint, args))
        assertEquals("uncertain", timeout.data()["status"]!!.jsonPrimitive.content)
        assertEquals(2, fixture.invocations.size)
    }

    @Test
    fun portThatBecomesInactiveDuringPreflightCannotInvoke() = runTest {
        val fixture = Fixture()
        val endpoint = "https://mcp.example/tasks"
        fixture.save(endpoint)
        fixture.beforeDispatch = { fixture.active = false }
        assertNull(fixture.invoke(endpoint, buildJsonObject { put("title", "test note") }))
        assertTrue(fixture.invocations.isEmpty())
    }

    private companion object {
        val revision = "a".repeat(64)
        val schema = buildJsonObject { put("type", "object") }
    }
}

private fun JsonObject.data(): JsonObject = get("payload")!!.jsonObject
