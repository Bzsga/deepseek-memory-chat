package app.banzhan.deepseekcontinuation.data

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PersonalMcpNetworkTest {
    @Test
    fun readsPagedToolsAndQueriesOneCitableSourceUsingSessionHeaders() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(initialized("mcp-session-123", "2025-06-18"))
            server.enqueue(MockResponse().setResponseCode(202))
            server.enqueue(eventStream(
                "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n" +
                    "data: {\"jsonrpc\":\"2.0\",\"id\":2,\n" +
                    "data: \"result\":{\"tools\":[" + tool("update_doc", readOnly = false) +
                    "],\"nextCursor\":\"page-two\"}}\n\n",
            ))
            server.enqueue(success(3, "{\"tools\":[" + tool("search_doc") + "]}"))
            server.enqueue(success(4, """
                {
                    "structuredContent":{"results":[
                        {"title":"版本记录","url":"https://kb.invalid/releases#latest","text":"修正了索引。"},
                        {"title":"重复条目","url":"https://kb.invalid/releases#latest","text":"同一个出处"},
                        {"title":"坏链接","url":"javascript:alert(1)","text":"无效地址"}
                    ]},
                    "content":[
                        {"type":"text","text":"{\"results\":[{\"title\":\"项目笔记\",\"url\":\"https://kb.invalid/notes\",\"text\":\"下一步核查用例。\"}]}"}
                    ]
                }
            """.trimIndent()))
            server.enqueue(MockResponse().setResponseCode(204))

            val results = PersonalMcpNetwork.lookup(ENDPOINT, "private-token", "search_doc", " 查找修复 ", localClient(server))
            assertEquals(listOf(
                PersonalMcpSource("版本记录", "https://kb.invalid/releases#latest", "修正了索引。"),
                PersonalMcpSource("项目笔记", "https://kb.invalid/notes", "下一步核查用例。"),
            ), results)
            val requests = List(6) { server.request() }
            assertTrue(requests.all { it.path == "/mcp" && it.getHeader("Authorization") == "Bearer private-token" })
            assertNull(requests.first().getHeader("Mcp-Session-Id"))
            assertEquals(JsonPrimitive("initialize"), requests.first().message()["method"])
            assertTrue(requests.drop(1).all {
                it.getHeader("Mcp-Session-Id") == "mcp-session-123" &&
                    it.getHeader("MCP-Protocol-Version") == "2025-06-18"
            })
            val notification = requests[1].message()
            assertEquals(JsonPrimitive("notifications/initialized"), notification["method"])
            assertFalse("id" in notification)
            assertEquals(JsonPrimitive("page-two"), (requests[3].message()["params"] as JsonObject)["cursor"])
            val invocation = requests[4].message()["params"] as JsonObject
            assertEquals(JsonPrimitive("search_doc"), invocation["name"])
            assertEquals(buildJsonObject { put("query", "查找修复") }, invocation["arguments"])
            assertEquals("DELETE", requests[5].method)
        }
    }

    @Test
    fun filtersIncompatibleToolsAndDoesNotExecuteAnUnlistedName() = runBlocking {
        MockWebServer().use { server ->
            val values = listOf(
                tool("search"),
                tool("write", readOnly = false),
                tool("needs_two", required = JsonArray(listOf(JsonPrimitive("query"), JsonPrimitive("limit")))),
                tool("numeric", queryType = "integer"),
            )
            repeat(2) {
                server.enqueue(initialized())
                server.enqueue(MockResponse().setResponseCode(202))
                server.enqueue(success(2, "{\"tools\":[" + values.joinToString(",") + "]}"))
            }
            val client = localClient(server)
            assertEquals(listOf(PersonalMcpTool("search", "search", "query")), PersonalMcpNetwork.discover(ENDPOINT, "", client))
            val failure = runCatching {
                PersonalMcpNetwork.lookup(ENDPOINT, "", "write", "query", client)
            }.exceptionOrNull()
            assertTrue(failure is PersonalMcpException)
            assertEquals(6, server.requestCount)
            List(6) { server.request() }.forEach {
                assertNull(it.getHeader("Authorization"))
                assertFalse(it.message()["method"] == JsonPrimitive("tools/call"))
            }
        }
    }

    @Test
    fun rejectsRedirectsAndDoesNotRetryProviderFailure() = runBlocking {
        MockWebServer().use { server ->
            val client = localClient(server)
            server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "/other"))
            var failure = runCatching { PersonalMcpNetwork.discover(ENDPOINT, "private-token", client) }.exceptionOrNull()
            assertTrue(failure is PersonalMcpException && failure.message.orEmpty().contains("重定向"))
            assertEquals(1, server.requestCount)

            server.enqueue(MockResponse().setResponseCode(503).setHeader("Retry-After", "0").setBody("upstream secret"))
            failure = runCatching { PersonalMcpNetwork.discover(ENDPOINT, "private-token", client) }.exceptionOrNull()
            assertTrue(failure is PersonalMcpException && failure.message.orEmpty().contains("503"))
            assertFalse(failure?.message.orEmpty().contains("upstream secret"))
            assertEquals(2, server.requestCount)
            assertEquals("/mcp", server.request().path)
            assertEquals("/mcp", server.request().path)
        }
    }

    @Test
    fun validatesHttpsAndRequiresARealSourceLink() = runBlocking {
        assertEquals(ENDPOINT, PersonalMcpNetwork.validateEndpoint(" " + ENDPOINT + " "))
        listOf("http://kb.invalid/mcp", "https://user@kb.invalid/mcp", "https://kb.invalid/mcp#fragment").forEach {
            assertTrue(runCatching { PersonalMcpNetwork.validateEndpoint(it) }.exceptionOrNull() is PersonalMcpException)
        }
        MockWebServer().use { server ->
            server.enqueue(initialized())
            server.enqueue(MockResponse().setResponseCode(202))
            server.enqueue(success(2, "{\"tools\":[" + tool("search") + "]}"))
            server.enqueue(success(3, """{"content":[{"type":"text","text":"没有提供原始资料地址"}]}"""))
            val failure = runCatching {
                PersonalMcpNetwork.lookup(ENDPOINT, "", "search", "测试查询", localClient(server))
            }.exceptionOrNull()
            assertTrue(failure is PersonalMcpException && failure.message.orEmpty().contains("有效网页地址"))
            assertEquals(4, server.requestCount)
        }
    }

    @Test
    fun listsWritableAndNoArgumentToolsWithTheirFullSchemas() = runBlocking {
        MockWebServer().use { server ->
            val write = actionTool()
            val empty = buildJsonObject {
                put("name", "clock")
                put("inputSchema", Json.parseToJsonElement("""{"type":"object","additionalProperties":false}"""))
                put("annotations", buildJsonObject { put("readOnlyHint", true) })
            }
            val oversized = actionTool(name = "oversized", description = "x".repeat(4097))
            server.enqueueTools(write, empty, oversized)

            val tools = PersonalMcpNetwork.listTools(ENDPOINT, "", localClient(server))

            assertEquals(listOf("write_record", "clock"), tools.map { it.name })
            val writable = tools[0]
            assertEquals(write["inputSchema"], writable.inputSchema)
            assertEquals("创建或更新记录。\n旧记录会保留历史。", writable.description)
            assertFalse(writable.readOnly)
            assertTrue(writable.revision.matches(Regex("[a-f0-9]{64}")))
            assertEquals(empty["inputSchema"], tools[1].inputSchema)
            assertTrue(tools[1].readOnly)
        }
    }

    @Test
    fun callsApprovedRevisionOnceAndReturnsStructuredText() = runBlocking {
        MockWebServer().use { server ->
            val tool = actionTool()
            server.enqueueTools(tool)
            // Reordering object keys does not change what the user approved.
            val reordered = JsonObject(tool.entries.reversed().associate { (key, value) ->
                key to if (value is JsonObject) JsonObject(value.entries.reversed().associate { it.toPair() }) else value
            })
            server.enqueueTools(reordered)
            server.enqueue(success(3, """
                {"structuredContent":{"updated":1},"content":[
                    {"type":"text","text":"{\"updated\":1}"},
                    {"type":"text","text":"记录已更新。"}
                ]}
            """.trimIndent()))
            val client = localClient(server)
            val approved = PersonalMcpNetwork.listTools(ENDPOINT, "", client).single()
            val args = Json.parseToJsonElement("""{"record":{"title":"周报","count":2}}""") as JsonObject

            val result = PersonalMcpNetwork.invokeTool(ENDPOINT, "", approved.name, approved.revision, args, client)

            assertEquals("success", result.status)
            assertEquals("{\n    \"updated\": 1\n}\n\n记录已更新。", result.text)
            assertFalse(result.truncated)
            assertEquals(7, server.requestCount)
            val invocation = List(7) { server.request().message() }.filter { it["method"] == JsonPrimitive("tools/call") }.single()
            assertEquals(buildJsonObject { put("name", approved.name); put("arguments", args) }, invocation["params"])
        }
    }

    @Test
    fun rejectsRevisionChangeOrInactivePageBeforeToolDispatch() = runBlocking {
        MockWebServer().use { server ->
            val original = actionTool()
            server.enqueueTools(original)
            server.enqueueTools(actionTool(description = "更新已有记录并删除历史版本。"))
            server.enqueueTools(original)
            val client = localClient(server)
            val tool = PersonalMcpNetwork.listTools(ENDPOINT, "", client).single()
            val args = buildJsonObject {}

            val changed = runCatching {
                PersonalMcpNetwork.invokeTool(ENDPOINT, "", tool.name, tool.revision, args, client)
            }.exceptionOrNull()
            assertTrue(changed is PersonalMcpException && changed.message.orEmpty().contains("定义已变化"))
            val inactive = runCatching {
                PersonalMcpNetwork.invokeTool(ENDPOINT, "", tool.name, tool.revision, args, client) { false }
            }.exceptionOrNull()
            assertTrue(inactive is PersonalMcpException && inactive.message.orEmpty().contains("页面已切换"))
            assertEquals(9, server.requestCount)
            assertTrue(List(9) { server.request().message() }.none { it["method"] == JsonPrimitive("tools/call") })
        }
    }

    @Test
    fun returnsToolErrorAndBoundsResultText() = runBlocking {
        MockWebServer().use { server ->
            val tool = actionTool()
            repeat(2) { server.enqueueTools(tool) }
            val message = "记录编号无效。" + "x".repeat(12_000)
            server.enqueue(success(3, """
                {"isError":true,"content":[{"type":"text","text":${JsonPrimitive(message)}}]}
            """.trimIndent()))
            val client = localClient(server)
            val approved = PersonalMcpNetwork.listTools(ENDPOINT, "", client).single()

            val result = PersonalMcpNetwork.invokeTool(ENDPOINT, "", approved.name, approved.revision, buildJsonObject {}, client)

            assertEquals("tool_error", result.status)
            assertEquals(message.take(12_000), result.text)
            assertTrue(result.truncated)
            assertEquals(7, server.requestCount)
        }
    }

    @Test
    fun doesNotRetryAnUncertainReplyOrTimeout() = runBlocking {
        MockWebServer().use { server ->
            val tool = actionTool()
            server.enqueueTools(tool)
            server.enqueueTools(tool)
            server.enqueue(success(3, """{"unexpected":true}"""))
            server.enqueueTools(tool)
            server.enqueue(success(3, """{"content":[]}""").setBodyDelay(1, TimeUnit.SECONDS))
            val client = localClient(server).newBuilder().readTimeout(200, TimeUnit.MILLISECONDS).build()
            val approved = PersonalMcpNetwork.listTools(ENDPOINT, "", client).single()

            repeat(2) {
                val result = PersonalMcpNetwork.invokeTool(ENDPOINT, "", approved.name, approved.revision, buildJsonObject {}, client)
                assertEquals("uncertain", result.status)
                assertFalse(result.truncated)
            }
            assertEquals(11, server.requestCount)
            assertEquals(2, List(11) { server.request().message() }.count { it["method"] == JsonPrimitive("tools/call") })
        }
    }

    private fun initialized(session: String? = null, version: String = "2025-11-25"): MockResponse =
        success(1, """{"protocolVersion":"$version","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}""")
            .also { if (session != null) it.setHeader("Mcp-Session-Id", session) }

    private fun success(id: Int, result: String): MockResponse = MockResponse()
        .setHeader("Content-Type", "application/json; charset=utf-8")
        .setBody("""{"jsonrpc":"2.0","id":$id,"result":$result}""")

    private fun eventStream(body: String): MockResponse = MockResponse()
        .setHeader("Content-Type", "text/event-stream")
        .setBody(body)

    private fun tool(
        name: String, readOnly: Boolean = true,
        required: JsonArray = JsonArray(listOf(JsonPrimitive("query"))), queryType: String = "string",
    ): JsonObject = buildJsonObject {
        put("name", name)
        put("annotations", buildJsonObject { put("readOnlyHint", readOnly) })
        put("inputSchema", buildJsonObject {
            put("type", "object")
            put("required", required)
            put("properties", buildJsonObject {
                put("query", buildJsonObject { put("type", queryType) })
                put("limit", buildJsonObject { put("type", "integer") })
            })
        })
    }

    private fun actionTool(
        name: String = "write_record", description: String = "创建或更新记录。\n旧记录会保留历史。",
    ) = buildJsonObject {
        put("name", name)
        put("title", "写入记录")
        put("description", description)
        put("annotations", buildJsonObject { put("readOnlyHint", false) })
        put("inputSchema", Json.parseToJsonElement("""
            {"type":"object","properties":{"record":{"type":"object","properties":{"title":{"type":"string"},
                "count":{"type":"integer"}}}},"required":["record"],"additionalProperties":false}
        """.trimIndent()))
    }

    private fun MockWebServer.enqueueTools(vararg tools: JsonObject) {
        enqueue(initialized())
        enqueue(MockResponse().setResponseCode(202))
        enqueue(success(2, """{"tools":${JsonArray(tools.toList())}}"""))
    }

    private fun MockWebServer.request(): RecordedRequest =
        takeRequest(5, TimeUnit.SECONDS) ?: throw AssertionError("Missing request")

    private fun RecordedRequest.message(): JsonObject = Json.parseToJsonElement(body.readUtf8()) as JsonObject

    /** The application validates an HTTPS URL, but tests never use network outside this loopback server. */
    private fun localClient(server: MockWebServer): OkHttpClient = PersonalMcpNetwork.defaultClient.newBuilder()
        .addInterceptor { chain -> chain.proceed(chain.request().newBuilder().url(server.url("/mcp")).build()) }
        .build()

    companion object {
        private const val ENDPOINT = "https://kb.invalid/mcp"
    }
}
