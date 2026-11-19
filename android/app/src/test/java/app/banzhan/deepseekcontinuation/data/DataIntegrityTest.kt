package app.banzhan.deepseekcontinuation.data

import app.banzhan.deepseekcontinuation.core.Archive
import app.banzhan.deepseekcontinuation.core.ArchiveEntry
import app.banzhan.deepseekcontinuation.core.ChatMessage
import app.banzhan.deepseekcontinuation.core.ConversationBranch
import app.banzhan.deepseekcontinuation.core.EntryCategory
import app.banzhan.deepseekcontinuation.core.EntryKind
import app.banzhan.deepseekcontinuation.core.ImportedConversation
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class DataIntegrityTest {
    private val message = ChatMessage("c:m1", "user", "周六见面")
    private val conversation = ImportedConversation("c", "计划", branches = listOf(ConversationBranch("b", "当前", listOf(message), true)), currentBranchId = "b")
    private val archive = Archive("a", "续聊", listOf("c"), listOf(ArchiveEntry("e", EntryCategory.RECENT, "周六见面", listOf(message.id))), updatedAt = 1)

    @Test fun incrementalImportKeepsOldBranchAndSourceIdentity() {
        val next = conversation.copy(branches = listOf(conversation.branches.first().copy(messages = listOf(message, ChatMessage("c:m2", "assistant", "收到")))))
        val merged = mergeImportedConversation(conversation, next)
        assertEquals("c", merged.id)
        assertEquals(2, merged.branches.size)
        assertTrue(merged.branches.all { it.messages.first() == message })
        assertEquals(merged, mergeImportedConversation(merged, next))
    }

    @Test fun changedSourceCreatesSeparateVersion() {
        val changed = conversation.copy(branches = listOf(conversation.branches.first().copy(messages = listOf(message.copy(content = "改成周日")))))
        val version = mergeImportedConversation(conversation, changed)
        assertNotEquals(conversation.id, version.id)
        assertNotEquals(message.id, version.branches.first().messages.first().id)
        assertEquals("周六见面", conversation.branches.first().messages.first().content)
        assertEquals(version, mergeImportedConversation(conversation, changed))
    }

    @Test fun validBackupRoundTripsAndRejectsDanglingSourcesBeforeWrites() {
        val backup = fixture()
        BackupValidation.validate(appJson.decodeFromString(appJson.encodeToString(backup)))
        val bad = archive.copy(entries = listOf(archive.entries.first().copy(sourceIds = listOf("missing"))))
        assertThrows(IllegalArgumentException::class.java) {
            BackupValidation.validate(backup.copy(archives = listOf(ArchiveRow(bad.id, bad.updatedAt, appJson.encodeToString(bad)))))
        }
    }

    @Test fun backupRejectsCapturedSecretsAndInvalidTaskReferences() {
        assertThrows(IllegalArgumentException::class.java) { BackupValidation.validate(fixture().copy(settings = ServiceSettings(apiKey = "secret"))) }
        val task = TaskRecord("t", "a", "整理", ServiceSettings(), "task:t", listOf(TaskChunk("part", listOf(message), "cache")))
        assertThrows(IllegalArgumentException::class.java) {
            BackupValidation.validate(fixture().copy(tasks = listOf(TaskRow(task.id, task.archiveId, 1, appJson.encodeToString(task)))))
        }
        val safe = task.copy(secretRef = "")
        BackupValidation.validate(fixture().copy(tasks = listOf(TaskRow(safe.id, safe.archiveId, 1, appJson.encodeToString(safe)))))
    }

    @Test fun processDeathPausesAndRequiresAcknowledgmentOnlyForUnknownPaidRequest() {
        val chunk = TaskChunk("part", listOf(message), "cache")
        val running = TaskRecord("t", "a", "整理", ServiceSettings(), "task:t", listOf(chunk), status = "running", inFlight = true)
        val restored = appJson.decodeFromString<TaskRecord>(appJson.encodeToString(running)).afterProcessDeath()
        assertEquals("paused", restored.status)
        assertTrue(restored.uncertain)
        assertFalse(running.copy(inFlight = false).afterProcessDeath().uncertain)
        assertFalse(running.copy(chunks = listOf(chunk.copy(remoteJobId = "server-id"))).afterProcessDeath().uncertain)
        val done = running.copy(status = "completed", inFlight = false)
        assertEquals(done, done.afterProcessDeath())
    }

    @Test fun budgetedChunksReserveOutputAndPreserveEveryCharacter() {
        val messages = (1..200).map { ChatMessage("long-source-${it.toString().padStart(80, '0')}", "user", "消息$it") }
        val settings = ServiceSettings(contextTokens = 4096)
        val chunks = budgetedChunks(messages, settings)
        assertTrue(chunks.size > 1)
        chunks.forEach { SummaryProtocol.validateForRequest(settings, it.messages) }
        assertEquals(messages.joinToString("") { it.content }, chunks.flatMap { it.messages }.joinToString("") { it.content })
    }

    @Test fun largeContextStillUsesSummarySizedRequestsAndLowOutputShrinksThem() {
        val input = listOf(message.copy(content = "汉语🐳".repeat(5000)))
        val settings = ServiceSettings(contextTokens = 64000, maxOutputTokens = 4096)
        val chunks = budgetedChunks(input, settings)
        assertTrue(chunks.size > 1)
        assertTrue(chunks.all { it.messages.sumOf { part -> part.content.length } <= 6000 })
        assertEquals(input.single().content, chunks.flatMap { it.messages }.joinToString("") { it.content })
        chunks.forEach { SummaryProtocol.validateForRequest(settings, it.messages) }
        assertTrue(budgetedChunks(input, settings.copy(maxOutputTokens = 512)).size > chunks.size)
    }

    @Test fun explicitResumeSplitsOnlyUnfinishedSafeChunksAndNeverReusesOldRequestIdentity() {
        val settings = ServiceSettings(contextTokens = 64000, maxOutputTokens = 4096)
        val long = message.copy(content = "片段🐳".repeat(4000))
        val completed = TaskChunk("done", listOf(message), "paid-cache", completed = true, remoteJobId = "paid")
        val failed = TaskChunk("long", listOf(long), "failed-cache", remoteJobId = "old-job", remoteStatus = "uncertain", attempt = 2)
        val queued = TaskChunk("next", listOf(message.copy(id = "next")), "next-cache")
        val task = TaskRecord("t", "a", "整理", settings, "task:t", listOf(completed, failed, queued), status = "paused", uncertain = true)
        val resumed = task.chunksForExplicitResume()
        assertEquals(completed, resumed.first())
        assertEquals(queued, resumed.last())
        val split = resumed.drop(1).dropLast(1)
        assertTrue(split.size > 1)
        assertEquals(long.content, split.flatMap { it.messages }.joinToString("") { it.content })
        assertTrue(split.all { it.attempt == 3 && it.remoteJobId.isEmpty() && it.remoteStatus.isEmpty() })
        assertEquals(split.size, split.map { it.id }.distinct().size)
        assertTrue(split.none { it.id == failed.id || it.cacheKey == failed.cacheKey })
        assertEquals(resumed, task.chunksForExplicitResume())
        assertEquals(resumed, task.copy(chunks = resumed).chunksForExplicitResume())
        val unknownRemote = failed.copy(remoteStatus = "")
        assertEquals(listOf(unknownRemote), task.copy(chunks = listOf(unknownRemote)).chunksForExplicitResume())
        assertEquals(task.chunks, task.afterProcessDeath().chunks)
    }

    @Test fun addressChangesNeverCarryOldCredentialsToNewService() {
        val old = ServiceSettings(apiKey = "old-api", trialToken = "old-token")
        val changed = settingsForSave(old, old.copy(baseUrl = "https://other.example/v1", companionUrl = "https://trial.example"))
        assertEquals("", changed.apiKey)
        assertEquals("", changed.trialToken)
        assertEquals("old-api", settingsForSave(old, old.copy(model = "another-model")).apiKey)
        assertEquals("explicit-new-key", settingsForSave(old, old.copy(baseUrl = "https://other.example", apiKey = "explicit-new-key")).apiKey)
    }

    @Test fun organizationPreflightUsesSameLocalConfigurationValidationAsStart() {
        assertThrows(IllegalArgumentException::class.java) { validateOrganizationConfiguration(ServiceSettings()) }
        assertThrows(IllegalArgumentException::class.java) {
            validateOrganizationConfiguration(ServiceSettings(mode = "companion", apiKey = "byok-key-cannot-be-used-as-trial-token"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            validateOrganizationConfiguration(ServiceSettings(mode = "byok", apiKey = "first\nsecond"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            validateOrganizationConfiguration(ServiceSettings(mode = "byok", baseUrl = "http://insecure.example", apiKey = "synthetic"))
        }
        val byok = ServiceSettings(mode = "byok", apiKey = "synthetic-no-network")
        assertEquals(byok, validateOrganizationConfiguration(byok))
        val companion = ServiceSettings(mode = "companion", trialToken = "synthetic-token-no-network")
        assertEquals(companion, validateOrganizationConfiguration(companion))
    }

    @Test fun personalDefaultAndManagedGrantPreserveExistingKeyAndServiceIdentity() {
        val original = ServiceSettings(apiKey = "owned-key")
        assertEquals("byok", original.mode)
        assertEquals(original, original.forAccount(true))
        val invited = original.forAccount(true, selectManaged = true)
        assertEquals("companion", invited.mode)
        assertEquals(original, invited.forAccount(false))
        assertEquals(companionIdentityKey("https://EXAMPLE.com/api/"), companionIdentityKey("https://example.com/api"))
        assertNotEquals(companionIdentityKey("https://example.com/api"), companionIdentityKey("https://other.example/api"))
    }

    @Test fun retiredOfficialServiceMigratesWithoutChangingByokSettings() {
        listOf("https://digimonlegend.com/continuation-api", "https://digimonlegend.com/continuation-api/",
            "https://DIGIMONLEGEND.com/continuation-api/v1/").forEach { retiredUrl ->
            val previous = ServiceSettings(mode = "byok", baseUrl = "https://owned.example/v1", model = "owned-model",
                apiKey = "owned-key", companionUrl = retiredUrl, trialToken = "old-anonymous-token",
                contextTokens = 16384, maxOutputTokens = 2048)
            val migrated = migrateRetiredOfficialService(previous)
            assertEquals(previous.copy(companionUrl = ServiceSettings().companionUrl, trialToken = ""), migrated)
            assertEquals(migrated, migrateRetiredOfficialService(migrated))
        }
    }

    @Test fun retiredMigrationPreservesCustomAndUnrelatedAddresses() {
        listOf("https://custom.example/continuation-api", "https://digimonlegend.com/custom-api",
            "https://digimonlegend.com/continuation-api/custom", "https://digimonlegend.com:8443/continuation-api",
            "https://digimonlegend.com/continuation-api?custom=1", "https://user@digimonlegend.com/continuation-api",
            "http://digimonlegend.com/continuation-api", ServiceSettings().companionUrl).forEach { url ->
            val customized = ServiceSettings(companionUrl = url, trialToken = "preserved-token")
            assertEquals(customized, migrateRetiredOfficialService(customized))
        }
    }

    @Test fun serverBudgetIsCapturedWithoutOverwritingLocalByokParameters() {
        val local = ServiceSettings(model = "local-model", contextTokens = 32768, maxOutputTokens = 2048, trialToken = "same-identity")
        val quota = CompanionQuota(true, 0.0, 0.0, "server-model", "", contextTokens = 8192, maxOutputTokens = 1024)
        val captured = settingsWithServerBudget(local, quota)
        assertEquals("server-model", captured.model)
        assertEquals(8192, captured.contextTokens)
        assertEquals(1024, captured.maxOutputTokens)
        assertEquals("same-identity", captured.trialToken)
        assertEquals("local-model", local.model)
        assertEquals(32768, local.contextTokens)
        assertThrows(IllegalStateException::class.java) { settingsWithServerBudget(local, quota.copy(contextTokens = null)) }
    }

    @Test fun adminCredentialComesOnlyFromTheCurrentAdministratorAccount() {
        val base = AccountSession("https://service.example", "synthetic-bearer", "2099-01-01T00:00:00Z",
            AccountUser("id", "Alice", "public", "2026-01-01T00:00:00Z"))
        assertEquals("", base.adminCredentials().sessionToken)
        assertEquals("", (null as AccountSession?).adminCredentials().sessionToken)
        val admin = base.copy(user = base.user.copy(role = "admin"))
        assertEquals(base.token, admin.adminCredentials().sessionToken)
        assertEquals(base.serviceUrl, admin.adminCredentials().serviceUrl)
        assertFalse(admin.adminCredentials().toString().contains(base.token))
        assertEquals("", admin.copy(expiresAt = "2001-01-01T00:00:00Z").adminCredentials().sessionToken)
    }

    @Test fun currentServiceMigrationKeepsFrozenUnknownTasksOnTheirOriginalService() {
        val retired = ServiceSettings(companionUrl = "https://digimonlegend.com/continuation-api", trialToken = "old-task-token")
        val frozen = task("old-task").copy(settings = retired, uncertain = true,
            chunks = task("old-task").chunks.map { it.copy(requestStarted = true, remoteJobId = "old-job") })
        val encoded = appJson.encodeToString(frozen)
        val current = migrateRetiredOfficialService(retired.withoutSecrets())
        assertEquals(ServiceSettings().companionUrl, current.companionUrl)
        assertEquals(encoded, appJson.encodeToString(frozen))
        assertEquals("https://digimonlegend.com/continuation-api/v1/jobs/old-job",
            SummaryNetwork.companionEndpoint(frozen.settings.companionUrl, "jobs", "old-job").toString())
        assertTrue(frozen.uncertain)
        assertTrue(frozen.chunks.single().requestStarted)
        assertEquals("old-job", frozen.chunks.single().remoteJobId)
    }

    @Test fun resumingCancelledTaskCannotBypassAnotherArchiveTask() {
        val cancelled = task("a-task").copy(status = "cancelled")
        val replacement = task("b-task").copy(status = "running")
        assertThrows(IllegalArgumentException::class.java) { requireTaskSlot("a", cancelled.id, listOf(cancelled, replacement)) }
        assertThrows(IllegalArgumentException::class.java) { requireTaskSlot("a", cancelled.id, listOf(cancelled, replacement.copy(status = "paused"))) }
        requireTaskSlot("a", cancelled.id, listOf(cancelled, replacement.copy(archiveId = "another-archive")))
    }

    @Test fun restoringEarlierSourcesIdentifiesObsoleteTasks() {
        val old = task("a-task")
        val later = old.copy(id = "b-task", chunks = listOf(TaskChunk("b-part", listOf(ChatMessage("b:m1", "user", "另一会话")), "cache-b")))
        assertTrue(taskSourcesFit(old, setOf(message.id)))
        assertFalse(taskSourcesFit(later, setOf(message.id)))
        assertTrue(taskSourcesFit(later, setOf(message.id, "b:m1")))
    }

    @Test fun aggregationKeepsAllPiecesWithoutDependingOnChunkBoundaries() {
        val first = summary("第一段事实")
        val second = summary("第二段事实")
        val one = aggregateChunkEntries(listOf(listOf(first)))
        val both = aggregateChunkEntries(listOf(listOf(first), listOf(second)))
        assertEquals(first.id, both.single().id)
        assertEquals("第一段事实\n第二段事实", both.single().text)
        val merged = mergeTaskProgress(one, one, both)
        assertEquals(both, merged.entries)
        assertTrue(merged.conflicts.isEmpty())
        val repeated = aggregateChunkEntries(listOf(listOf(first), listOf(second), listOf(first)))
        assertEquals(both, repeated)
    }

    @Test fun changedChunkingNeverBypassesManualOrDeletedEntryProtection() {
        val previous = summary("之前的摘要")
        val updated = summary("新摘要")
        val protected = listOf(previous.copy(text = "本人修订", edited = true), previous.copy(deleted = true), previous.copy(pinned = true))
        protected.forEach { saved ->
            val merged = mergeTaskProgress(listOf(saved), listOf(previous), listOf(updated))
            assertEquals(saved, merged.entries.single())
            assertEquals(updated, merged.conflicts.single().proposed)
        }
    }

    @Test fun expiredJobChangesIdempotencyOnlyOnExplicitResume() {
        val expired = task("expired").copy(status = "paused", uncertain = true,
            chunks = listOf(task("x").chunks.first().copy(remoteJobId = "old-job", remoteStatus = "expired", attempt = 2)))
        assertEquals("old-job", expired.afterProcessDeath().chunks.single().remoteJobId)
        assertEquals(2, expired.afterProcessDeath().chunks.single().attempt)
        val resumed = expired.chunksForExplicitResume().single()
        assertEquals("", resumed.remoteJobId)
        assertEquals(3, resumed.attempt)
        val done = expired.copy(chunks = listOf(expired.chunks.single().copy(completed = true)))
        assertEquals(done.chunks, done.chunksForExplicitResume())
    }

    private fun task(id: String) = TaskRecord(id, "a", "整理", ServiceSettings(), "", listOf(TaskChunk("part", listOf(message), "cache")))

    private fun summary(text: String): ArchiveEntry = SummaryProtocol.validateEntries(
        listOf(ArchiveEntry("model-id", EntryCategory.RECENT, text, listOf(message.id), EntryKind.USER_FACT)), listOf(message),
    ).single()

    private fun fixture() = BackupDocument(settings = ServiceSettings(), sources = emptyList(),
        conversations = listOf(ConversationRow(conversation.id, appJson.encodeToString(conversation))),
        archives = listOf(ArchiveRow(archive.id, archive.updatedAt, appJson.encodeToString(archive))),
        revisions = emptyList(), conflicts = emptyList(), tasks = emptyList(), cache = emptyList())
}
