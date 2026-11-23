package app.banzhan.deepseekcontinuation.core

import java.io.ByteArrayOutputStream
import app.banzhan.deepseekcontinuation.ui.chatImportJson
import kotlinx.serialization.json.*
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.*
import org.junit.Test

class DeepSeekImporterTest {
    @Test fun diagnosticSeparatesSyntaxStructureAndArchiveFailures() {
        fun reason(document: String, fileName: String): String = try {
            DeepSeekImporter.parse(document.toByteArray(), fileName)
            error("Expected import failure")
        } catch (error: ImportFailure) {
            error.detail
        }
        assertEquals("import_json_syntax", reason("[{", "broken.json"))
        assertEquals("import_json_structure", reason("[1]", "unrecognized.json"))
        assertEquals("import_zip_read", reason("broken zip", "broken.zip"))
        assertEquals("import_unsupported_file", reason("not an export", "text.txt"))
    }

    private fun parse(source: String) = DeepSeekImporter.parse(source.toByteArray(), "conversations.json")

    private fun fixture(name: String): ByteArray {
        val paths = listOf(File("../../fixtures/$name"), File("../fixtures/$name"), File("fixtures/$name"))
        return paths.firstOrNull { it.isFile }?.readBytes() ?: error("Fixture not found: $name")
    }

    private fun assertRejected(fragment: String, action: () -> Unit) {
        val thrown = runCatching(action).exceptionOrNull()
        assertTrue("Expected IllegalArgumentException, got $thrown", thrown is IllegalArgumentException)
        assertTrue("Expected message containing $fragment, got ${thrown?.message}", thrown?.message?.contains(fragment) == true)
    }

    @Test fun messageArraysRecognizeOfficialFragmentsWithoutPlainContentFields() {
        val messages = """
            [{"id":1,"parent_id":null,"fragments":[{"type":"REQUEST","content":"示例问题"}]},
             {"id":2,"parent_id":1,"role":"ASSISTANT","fragments":[
              {"type":"THINK","content":"不导入的推理"},{"type":"RESPONSE","content":"示例回答"}]}]
        """.trimIndent()
        for (document in listOf(messages, """{"data":$messages}""")) {
            val branch = parse(document).conversations.single().branches.single()
            assertEquals(listOf("user", "assistant"), branch.messages.map { it.role })
            assertEquals(listOf("示例问题", "示例回答"), branch.messages.map { it.content })
        }
        val mixed = messages.dropLast(1) + """,{"id":"metadata","title":"无聊天内容"}]"""
        assertRejected("会话数组含无法识别的对象") { parse(mixed) }
    }

    @Test fun sharedZipKeepsAllChatsAndTheSelectedAnswer() {
        val forks = Json.parseToJsonElement(fixture("official-fragments-forks.json").decodeToString()).jsonArray.single()
        val selected = Json.parseToJsonElement(fixture("mapping-current-branch.json").decodeToString())
        val archive = zip(listOf("conversations.json" to JsonArray(listOf(forks, selected)).toString().toByteArray()))
        val chats = DeepSeekImporter.parse(archive, "export.zip").conversations.map {
            Json.parseToJsonElement(it.chatImportJson()).jsonObject
        }
        assertEquals(listOf(forks, selected).map { it.jsonObject["title"] }.toSet(), chats.map { it["title"] }.toSet())
        val chat = chats.single { it["title"] == selected.jsonObject["title"] }
        val nodes = chat.getValue("messages").jsonArray.map { it.jsonObject }.associateBy { it.getValue("id") }
        val root = nodes.getValue(chat.getValue("root"))
        assertEquals("路线 B", nodes.getValue(root.getValue("next")).getValue("text").jsonPrimitive.content)
        assertEquals(3, nodes.size)
    }

    @Test fun officialSplitZipImportsChatsWithTheirCurrentBranches() {
        val firstId = "11111111-1111-4111-8111-111111111111"
        val secondId = "22222222-2222-4222-8222-222222222222"
        val timestamp = "2026-11-01T08:00:00Z"
        val index = """
            [{"id":"$firstId","title":"路线比较","inserted_at":"$timestamp","updated_at":"$timestamp","message_count":3,"pinned":true},
             {"id":"$secondId","title":null,"inserted_at":"$timestamp","updated_at":"$timestamp","message_count":2,"pinned":false}]
        """.trimIndent()
        val first = """
            {"id":"$firstId","title":"路线比较","inserted_at":"$timestamp","updated_at":"$timestamp",
             "current_message_id":3,"messages":[
              {"id":1,"parent_id":null,"role":"USER","fragments":[
               {"type":"REQUEST","content":"选择哪条路线？"},
               {"type":"FILE","files":[{"file_name":"地图.pdf","mime_type":"application/pdf","size":32}]}]},
              {"id":2,"parent_id":1,"role":"ASSISTANT","fragments":[{"type":"RESPONSE","content":"路线 A"}]},
              {"id":3,"parent_id":1,"role":"ASSISTANT","fragments":[{"type":"RESPONSE","content":"路线 B"}]}]}
        """.trimIndent()
        val second = """
            {"id":"$secondId","title":"独立会话","inserted_at":"$timestamp","updated_at":"$timestamp",
             "current_message_id":2,"messages":[
              {"id":1,"parent_id":null,"role":"USER","fragments":[{"type":"REQUEST","content":"第二个问题"}]},
              {"id":2,"parent_id":1,"role":"ASSISTANT","fragments":[{"type":"RESPONSE","content":"第二个回答"}]}]}
        """.trimIndent()
        val entries = listOf(
            "manifest.json" to """{"export_format_version":3}""",
            "user.json" to """{"id":"fixture-user"}""",
            "chat_session_index.json" to index,
            "chat_sessions/$firstId.json" to first,
            "chat_sessions/$secondId.json" to second,
        )
        val archive = zip(entries.map { (path, contents) -> path to contents.toByteArray() })
        val chats = DeepSeekImporter.parse(archive, "export.zip").conversations.associateBy { it.title }
        assertEquals(setOf("路线比较", "独立会话"), chats.keys)
        val routed = chats.getValue("路线比较")
        assertEquals(timestamp, routed.createdAt)
        assertEquals(timestamp, routed.updatedAt)
        val selected = routed.branches.single { it.isCurrent }
        assertEquals(selected.id, routed.currentBranchId)
        assertEquals(listOf("选择哪条路线？", "路线 B"), selected.messages.map { it.content })
        assertEquals(listOf("user", "assistant"), selected.messages.map { it.role })
        assertEquals("地图.pdf", Json.parseToJsonElement(selected.messages.first().attachments.single())
            .jsonObject.getValue("file_name").jsonPrimitive.content)
        assertEquals(listOf("选择哪条路线？", "路线 A"), routed.branches.single { !it.isCurrent }.messages.map { it.content })
        val other = chats.getValue("独立会话").branches.single().messages
        assertEquals(listOf("第二个问题", "第二个回答"), other.map { it.content })
        assertNotEquals(selected.messages.first().id, other.first().id)

        val chat = Json.parseToJsonElement(routed.chatImportJson()).jsonObject
        val messages = chat.getValue("messages").jsonArray.map { it.jsonObject }.associateBy { it.getValue("id") }
        val root = messages.getValue(chat.getValue("root"))
        assertEquals("路线 B", messages.getValue(root.getValue("next")).getValue("text").jsonPrimitive.content)
    }

    @Test fun appSessionExportPreservesSourceIdentityAndBranchesFromJsonAndZip() {
        val session = """
            {"id":"synthetic-session","title":"示例会话","current_message_id":3,"messages":[
                {"id":1,"parent_id":null,"role":"USER","fragments":[
                    {"type":"REQUEST","content":"示例提问"},
                    {"type":"FILE","files":[{"file_name":"synthetic.png","export_path":"chat_sessions/synthetic-session_files/image.png"}]}]},
                {"id":2,"parent_id":1,"role":"ASSISTANT","fragments":[{"type":"RESPONSE","content":"原分支"}]},
                {"id":3,"parent_id":1,"role":"ASSISTANT","fragments":[{"type":"RESPONSE","content":"当前分支"}]}]}
        """.trimIndent()
        val files = """[{"path":"chat_sessions/synthetic-session_files/image.png","mime_type":"image/png",
            "data_base64":"U1lOVEhFVElDLUlNQUdFLUJPRFk="}]"""
        val wrapped = """{"format":"deepseek-session","version":1,"manifest":{"export_format_version":3},
            "session":$session,"files":$files}"""
        val original = parse(session).conversations.single()
        val direct = parse(wrapped).conversations.single()
        val zipped = DeepSeekImporter.parse(zip(listOf("session.json" to wrapped.toByteArray())), "session.zip")
            .conversations.single()
        assertEquals(original, direct)
        assertEquals(direct, zipped)
        val current = direct.branches.single { it.isCurrent }
        assertEquals(listOf("示例提问", "当前分支"), current.messages.map { it.content })
        assertEquals(listOf("user", "assistant"), current.messages.map { it.role })
        assertEquals(current.messages.first().id, direct.branches.single { !it.isCurrent }.messages.first().id)
        assertEquals("synthetic.png", Json.parseToJsonElement(current.messages.first().attachments.single())
            .jsonObject.getValue("file_name").jsonPrimitive.content)
        assertFalse(direct.toString().contains("U1lOVEhFVElDLUlNQUdFLUJPRFk="))
    }

    @Test fun appSessionExportRequiresRecognizedVersionsAndConversation() {
        val valid = """{"format":"deepseek-session","version":1,"manifest":{"export_format_version":3},
            "session":{"messages":[{"role":"user","content":"示例正文"}]},"files":[]}"""
        listOf(
            valid.replace("deepseek-session", "unrecognized-export") to "import_no_conversations",
            valid.replace("\"version\":1", "\"version\":2") to "import_json_structure",
            valid.replace("\"export_format_version\":3", "\"export_format_version\":4") to "import_json_structure",
            valid.replace("\"messages\"", "\"unrecognized-field\"") to "import_json_structure",
            valid.replace("\"files\":[]", "\"files\":null") to "import_json_structure"
        ).forEach { (document, expected) ->
            val direct = assertThrows(ImportFailure::class.java) { parse(document) }
            assertEquals(expected, direct.detail)
            val zipped = assertThrows(ImportFailure::class.java) {
                DeepSeekImporter.parse(zip(listOf("session.json" to document.toByteArray())), "session.zip")
            }
            assertEquals(expected, zipped.detail)
        }
    }

    @Test fun splitZipRequiresActualValidConversationDocuments() {
        val id = "33333333-3333-4333-8333-333333333333"
        val indexPath = "chat_session_index.json"
        val chatPath = "chat_sessions/$id.json"
        val metadata = """
            {"id":"$id","title":"示例会话","inserted_at":"2026-11-01T08:00:00Z","updated_at":"2026-11-01T08:00:00Z"}
        """.trimIndent()
        val index = indexPath to "[$metadata]".toByteArray()
        assertRejected("未找到") { DeepSeekImporter.parse(zip(listOf(index)), "index-only.zip") }
        val archive = zip(listOf(
            index,
            chatPath to """{"id":"$id","title":"示例会话","messages":[null]}""".toByteArray(),
        ))
        assertRejected("消息必须是对象") { DeepSeekImporter.parse(archive, "export.zip") }

        val record = """{"id":"$id","title":"示例会话","messages":[{"id":1,"role":"USER","content":"测试正文"}]}"""
        for (rows in listOf("[$metadata,$record]", "[$record,$metadata]")) {
            val mixed = zip(listOf(indexPath to rows.toByteArray(), chatPath to record.toByteArray()))
            assertThrows(IllegalArgumentException::class.java) { DeepSeekImporter.parse(mixed, "mixed-index.zip") }
        }
    }

    @Test fun officialFragmentsPreserveForksRolesAttachmentsAndExcludeThinking() {
        val result = DeepSeekImporter.parse(fixture("official-fragments-forks.json"), "conversations.json")
        val conversation = result.conversations.single()
        assertEquals(2, conversation.branches.size)
        assertNull(conversation.currentBranchId)
        assertTrue(result.warnings.any { it.contains("未标记当前分支") })
        val branches = conversation.branches.map { it.messages }
        assertTrue(branches.all { it.map(ChatMessage::role) == listOf("user", "assistant") })
        assertEquals(branches[0][0].id, branches[1][0].id)
        assertNotEquals(branches[0][1].id, branches[1][1].id)
        assertTrue(branches[0][0].attachments.single().contains("世界观草稿.pdf"))
        assertTrue(branches.flatten().none { it.content.contains("这段推理过程") })
        assertEquals("2026-11-01T08:00:00Z", conversation.createdAt)
    }

    @Test fun currentBranchIsSelectedByMarkerWithoutFlatteningAlternates() {
        val result = DeepSeekImporter.parse(fixture("mapping-current-branch.json"), "conversations.json")
        val conversation = result.conversations.single()
        assertEquals(2, conversation.branches.size)
        val selected = conversation.branches.single { it.isCurrent }
        assertEquals(conversation.currentBranchId, selected.id)
        assertEquals(listOf("选择哪条路线？", "路线 B"), selected.messages.map { it.content })
        assertTrue(conversation.branches.flattenMessages().none { it.content.contains("不应被导入") })
    }

    @Test fun internalCurrentNodeProducesExactPrefixBranch() {
        val result = parse("""{"id":"c","current_node":"q","mapping":{"q":{"message":{"role":"user","content":"q"},"children":["a"]},"a":{"message":{"role":"assistant","content":"a"}}}}""")
        val conversation = result.conversations.single()
        assertEquals(2, conversation.branches.size)
        assertEquals(listOf("q"), conversation.branches.single { it.isCurrent }.messages.map { it.content })
    }

    @Test fun explicitRolesNeverAlternateByPositionAndIdsAreScoped() {
        val result = parse("""[{"id":"one","messages":[{"id":"same","role":"assistant","content":"a"},{"id":"two","role":"assistant","content":"b"}]},{"id":"two","messages":[{"id":"same","role":"user","content":"a"}]}]""")
        val messages = result.conversations.flatMap { it.branches.single().messages }
        assertEquals(listOf("assistant", "assistant", "user"), messages.map { it.role })
        assertEquals(3, messages.map { it.id }.toSet().size)
        assertEquals(result, parse("""[{"id":"one","messages":[{"id":"same","role":"assistant","content":"a"},{"id":"two","role":"assistant","content":"b"}]},{"id":"two","messages":[{"id":"same","role":"user","content":"a"}]}]"""))
    }

    @Test fun unknownAndConflictingRolesRemainUnconfirmedAndVisible() {
        val result = parse("""{"id":"c","messages":[{"content":"角色缺失"},{"role":"user","fragments":[{"type":"RESPONSE","content":"角色冲突"}]}]}""")
        assertEquals(listOf("unknown", "unknown"), result.conversations.single().branches.single().messages.map { it.role })
        assertTrue(result.warnings.any { it.contains("无法确定角色") })
        assertTrue(result.warnings.any { it.contains("相互冲突") })
    }

    @Test fun rejectsCyclesIncludingDisconnectedCycles() {
        assertRejected("循环") {
            parse("""{"id":"c","mapping":{"q":{"message":{"role":"user","content":"valid"}},"a":{"parent":"b","message":null},"b":{"parent":"a","message":null}}}""")
        }
    }

    @Test fun rejectsDuplicateJsonKeysEvenWhenEscaped() {
        assertRejected("重复字段") { parse("""{"id":"c","messages":[],"messa\u0067es":[]}""") }
        assertRejected("重复字段") { parse("""{"mapping":{"a":{},"a":{}}}""") }
    }

    @Test fun rejectsDuplicateNodeAndMessageIds() {
        assertRejected("重复消息") { parse("""{"id":"c","messages":[{"id":"a","role":"user","content":"x"},{"id":"a","role":"user","content":"y"}]}""") }
        assertRejected("重复节点") { parse("""{"id":"c","nodes":[{"id":"a","role":"user","content":"x"},{"id":"a","role":"user","content":"y"}]}""") }
    }

    @Test fun rejectsConflictingParents() {
        assertRejected("多个父节点") {
            parse("""{"mapping":{"a":{"children":["c"]},"b":{"children":["c"]},"c":{"message":{"role":"user","content":"x"}}}}""")
        }
    }

    @Test fun missingReferencesPreserveReadableBranchWithWarning() {
        val result = parse("""{"id":"c","mapping":{"a":{"parent":"missing","children":["gone"],"message":{"role":"user","content":"可保留"}}}}""")
        assertEquals("可保留", result.conversations.single().branches.single().messages.single().content)
        assertTrue(result.warnings.any { it.contains("缺失父节点") })
        assertTrue(result.warnings.any { it.contains("缺失子节点") })
    }

    @Test fun nestedTreeAndFlatParentReferencesPreserveBranches() {
        val nested = parse("""{"id":"c","tree":{"id":"q","role":"user","content":"q","children":[{"id":"a","role":"assistant","content":"a"},{"id":"b","role":"assistant","content":"b"}]}}""")
        assertEquals(2, nested.conversations.single().branches.size)
        val flat = parse("""{"id":"c","messages":[{"id":"q","parent":null,"role":"user","content":"q"},{"id":"a","parent":"q","role":"assistant","content":"a"},{"id":"b","parent":"q","role":"assistant","content":"b"}]}""")
        assertEquals(2, flat.conversations.single().branches.size)
        assertEquals(nested.conversations.single().branches, flat.conversations.single().branches)
    }

    @Test fun contentTypesDoNotImportReasoningObjectsOrBinaryData() {
        val result = parse("""{"id":"c","messages":[{"role":"assistant","content":[{"type":"reasoning","text":"secret"},{"type":"text","text":"answer"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}},{"type":"unexpected","text":"unknown payload"}]}]}""")
        val message = result.conversations.single().branches.single().messages.single()
        assertEquals("answer", message.content)
        assertFalse(message.attachments.joinToString().contains("base64"))
        assertTrue(result.warnings.any { it.contains("推理过程") })
        assertTrue(result.warnings.any { it.contains("不受支持的正文") })
    }

    @Test fun importsZipWithoutExtractingAttachments() {
        val result = DeepSeekImporter.parse(zip(listOf("folder/conversations.json" to fixture("official-fragments-forks.json"), "notes.txt" to "ignored".toByteArray())), "data.zip")
        assertEquals(1, result.conversations.size)
        assertTrue(result.warnings.any { it.contains("非 JSON") })
    }

    @Test fun importsSplitZipWithStoredAttachmentDataDescriptors() {
        // A nonseekable writer places the STORED WebP size and CRC in a data descriptor.
        val result = DeepSeekImporter.parse(fixture("official-split-stored-descriptor.zip.fixture"), "data.zip")
        val chat = result.conversations.single()
        assertEquals("Descriptor fixture", chat.title)
        assertEquals("Test message", chat.branches.single().messages.single().content)
        assertTrue(result.warnings.any { it.contains("非 JSON") })
    }

    @Test fun rejectsUnsafeDuplicateAndOversizedZipEntries() {
        assertRejected("不安全路径") { DeepSeekImporter.parse(zip(listOf("../conversations.json" to "[]".toByteArray())), "data.zip") }
        assertRejected("重复路径") { DeepSeekImporter.parse(zip(listOf("a.json" to "[]".toByteArray(), "A.JSON" to "[]".toByteArray())), "data.zip") }
        assertRejected("32 MiB") { DeepSeekImporter.parse(zip(listOf("bomb.json" to ByteArray(32 * 1024 * 1024 + 1) { 32 })), "data.zip") }
    }

    @Test fun rejectsExcessiveDepthMalformedUtf8AndEmptyExports() {
        assertRejected("128") { parse("[".repeat(129) + "0" + "]".repeat(129)) }
        assertRejected("UTF-8") { DeepSeekImporter.parse(byteArrayOf(0xc3.toByte(), 0x28), "broken.json") }
        assertRejected("未找到") { parse("[]") }
        assertRejected("没有可识别") { parse("""{"messages":[]}""") }
    }

    @Test fun longFixtureImportsLosslesslyAndChunkSourcesRemainStable() {
        val result = DeepSeekImporter.parse(fixture("long-content.json"), "long-content.json")
        val messages = result.conversations.single().branches.single().messages
        assertTrue(messages.first().content.length > 12_000)
        val chunks = ArchiveLogic.chunks(messages)
        assertTrue(chunks.size > 2)
        assertEquals(messages.joinToString("") { it.content }, chunks.flatMap { it.messages }.joinToString("") { it.content })
        assertEquals(messages.map { it.id }.toSet(), chunks.flatMap { it.messages }.map { it.id }.toSet())
    }

    @Test fun largeAccountZipImportsWithoutRetainingAllSourceDocuments() {
        // Over 20 MiB expanded. Build it incrementally so the fixture itself does not
        // dominate the constrained-heap regression run (128 MiB).
        val content = "正文\"\\\n".repeat(24_000)
        val reasoning = "discarded-reasoning ".repeat(12_000)
        val output = ByteArrayOutputStream()
        ZipOutputStream(output).use { zip ->
            zip.putNextEntry(ZipEntry("conversations.json"))
            zip.write('['.code)
            repeat(48) { index ->
                if (index > 0) zip.write(','.code)
                val conversation = kotlinx.serialization.json.buildJsonObject {
                    put("id", kotlinx.serialization.json.JsonPrimitive("large-$index"))
                    put("messages", kotlinx.serialization.json.buildJsonArray {
                        add(kotlinx.serialization.json.buildJsonObject {
                            put("id", kotlinx.serialization.json.JsonPrimitive("message"))
                            put("role", kotlinx.serialization.json.JsonPrimitive("assistant"))
                            put("content", kotlinx.serialization.json.JsonPrimitive(content))
                            put("reasoning_content", kotlinx.serialization.json.JsonPrimitive(reasoning))
                        })
                    })
                }
                zip.write(conversation.toString().toByteArray())
            }
            zip.write(']'.code)
            zip.closeEntry()
        }
        val result = DeepSeekImporter.parse(output.toByteArray(), "account.zip")
        assertEquals(48, result.conversations.size)
        assertTrue(result.conversations.all { it.branches.single().messages.single().content == content })
        assertTrue(result.warnings.any { it.contains("排除推理过程") })
    }

    @Test fun streamedArraysPreserveStableIdsAndRejectTrailingOrMixedData() {
        val input = """[{"messages":[{"content":"中文\\\"[]{}","role":"user"}]}]"""
        val canonicalMessage = """{"content":"中文\\\"[]{}","role":"user"}"""
        val canonicalConversation = """{"messages":[$canonicalMessage]}"""
        fun digest(value: String) = java.security.MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
        val conversation = parse(input).conversations.single()
        assertEquals("conversation-${digest(canonicalConversation)}", conversation.id)
        assertEquals("${conversation.id}:message:${digest("generated-${digest(canonicalMessage)}-0")}",
            conversation.branches.single().messages.single().id)
        assertRejected("尾随") { parse("""[{"messages":[{"role":"user","content":"a"}]},]""") }
        assertRejected("多余") { parse("$input {}") }
        assertRejected("无法识别") { parse("""[{"role":"user","content":"a"},{"messages":[{"role":"user","content":"b"}]}]""") }
        assertRejected("重复字段") { parse("""[{"messages":[{"role":"user","content":"a"}]},{"messages":[],"messages":[]}]""") }
    }

    @Test fun streamedZipDetectsConflictsAcrossDocumentsAndAcceptsIdenticalReorderedObjects() {
        val first = """{"id":"same","messages":[{"role":"user","content":"a"}]}"""
        val reordered = """{"messages":[{"content":"a","role":"user"}],"id":"same"}"""
        val result = DeepSeekImporter.parse(zip(listOf("one.json" to first.toByteArray(), "two.json" to reordered.toByteArray())), "data.zip")
        assertEquals(1, result.conversations.size)
        assertTrue(result.warnings.any { it.contains("忽略重复会话") })
        assertRejected("ID 相同") {
            DeepSeekImporter.parse(zip(listOf("one.json" to first.toByteArray(), "two.json" to first.replace("\"a\"", "\"b\"").toByteArray())), "data.zip")
        }
    }

    private fun List<ConversationBranch>.flattenMessages() = flatMap { it.messages }

    private fun zip(entries: List<Pair<String, ByteArray>>): ByteArray {
        val output = ByteArrayOutputStream()
        ZipOutputStream(output).use { zip ->
            entries.forEach { (name, bytes) ->
                zip.putNextEntry(ZipEntry(name))
                zip.write(bytes)
                zip.closeEntry()
            }
        }
        return output.toByteArray()
    }
}
