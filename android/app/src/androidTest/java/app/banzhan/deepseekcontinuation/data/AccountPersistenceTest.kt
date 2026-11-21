package app.banzhan.deepseekcontinuation.data

import android.app.Application
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.banzhan.deepseekcontinuation.core.*
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.decodeFromString
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Synthetic account/organization transports with real Keystore and Room; never opens a socket. */
@RunWith(AndroidJUnit4::class)
class AccountPersistenceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val application = instrumentation.targetContext.applicationContext as Application
    private val service = CHAT_API
    private val quota = CompanionQuota(true, null, null, "synthetic-model", "", weeklyLimit = 500,
        weeklyRemaining = 500, userWeeklyLimit = 5, userWeeklyRemaining = 5, accessMode = "public",
        contextTokens = 64000, maxOutputTokens = 4096, organizationProtocolVersion = 12)

    private fun controller(name: String, network: FakeOrganization, accounts: FakeAccounts): Pair<ViewModelStore, AppController> {
        val store = ViewModelStore()
        lateinit var result: AppController
        instrumentation.runOnMainSync {
            result = ViewModelProvider(store, object : ViewModelProvider.Factory {
                @Suppress("UNCHECKED_CAST")
                override fun <T : ViewModel> create(modelClass: Class<T>): T = AppController(application, name).also {
                    it.organizationNetwork = network
                    it.accountNetwork = accounts
                } as T
            })[AppController::class.java]
        }
        return store to result
    }

    private suspend fun initialize(controller: AppController) {
        controller.backup()
        controller.logoutAccount()
        controller.updateChatProvider("local", "personal", null, null, null)
        controller.saveSettings(ServiceSettings(companionUrl = service, trialToken = "legacy-token",
            model = "synthetic-model", contextTokens = 64000, maxOutputTokens = 4096))
    }

    private suspend fun archive(controller: AppController): Triple<String, String, String> {
        controller.loadDemo()
        val source = controller.state.value.conversations.single()
        val branch = source.branches.single()
        val id = controller.createArchive("合成账户档案", source, branch.id, branch.messages.map { it.id }.toSet(), "",
            includeRawEntries = false)
        return Triple(id, source.id, branch.id)
    }

    private suspend fun backup(controller: AppController): BackupDocument = appJson.decodeFromString(controller.backup())
    private suspend fun task(database: AppDatabase) = database.records().tasks().single().decodeTask()
    private suspend fun awaitCondition(predicate: suspend () -> Boolean) = withTimeout(20_000) {
        while (!predicate()) delay(20)
    }
    private fun close(store: ViewModelStore) = instrumentation.runOnMainSync { store.clear() }

    @Test fun legacyIdentityCannotStartFreeWorkWhileLocalAndByokStayAvailable() = runBlocking<Unit> {
        val network = FakeOrganization()
        val accounts = FakeAccounts()
        val (store, controller) = controller("account-gate-${UUID.randomUUID()}.db", network, accounts)
        try {
            initialize(controller)
            val (archiveId, conversationId, branchId) = archive(controller)
            assertTrue(controller.checkOrganizationAvailability().orEmpty().contains("API Key"))
            assertTrue(runCatching { controller.refreshQuota() }.isFailure)
            val ids = controller.state.value.conversations.single().branches.single().messages.map { it.id }.toSet()
            assertTrue(runCatching { controller.organize(archiveId, conversationId, branchId, ids) }.isFailure)
            controller.prepareDiagnosticsIdentity()
            assertEquals(0, network.sessions.get())
            assertEquals(0, network.quotaReads.get())
            assertTrue(network.submissions.isEmpty())
            assertEquals(0, accounts.logins.get())
            assertEquals(1, controller.state.value.archives.size)
            controller.updateChatProvider("local", "personal", "synthetic-byok-key",
                "https://api.synthetic.invalid/compatible", "synthetic-personal-model")
            assertNull(controller.checkOrganizationAvailability())
            assertEquals("https://api.synthetic.invalid/compatible", controller.state.value.organizationSettings.baseUrl)
            assertEquals("synthetic-personal-model", controller.state.value.organizationSettings.model)
            assertNull(controller.state.value.account.currentUser)
            assertEquals(0, network.sessions.get())
        } finally {
            controller.updateChatProvider("local", "personal", null, null, null)
            close(store)
        }
    }

    @Test fun logoutAndBackupPreserveTaskIdentityAndOnlySameOwnerMayRebind() = runBlocking<Unit> {
        val network = FakeOrganization()
        val accounts = FakeAccounts()
        val databaseName = "account-owner-${UUID.randomUUID()}.db"
        val (store, controller) = controller(databaseName, network, accounts)
        val observed = Room.databaseBuilder(application, AppDatabase::class.java, databaseName)
            .addMigrations(AppDatabase.MIGRATION_1_2).build()
        try {
            initialize(controller)
            controller.loginAccount("ownerA", "synthetic-password")
            controller.redeemInvite("synthetic-invitation")
            controller.updateChatProvider("id-ownerA", "managed", null, null, null)
            val settings = controller.state.value.settings
            assertEquals("legacy-token", settings.trialToken)
            val (archiveId, conversationId, branchId) = archive(controller)
            val ids = controller.state.value.conversations.single().branches.single().messages.map { it.id }.toSet()
            controller.organize(archiveId, conversationId, branchId, ids)
            awaitCondition { task(observed).chunks.single().remoteJobId.isNotBlank() }
            val before = task(observed)
            val originalSecret = SecureCredentials(application).get(before.secretRef)
            assertTrue(originalSecret.isNotBlank())
            assertEquals("id-ownerA", before.ownerUserId)
            controller.logoutAccount()
            assertNull(controller.state.value.account.currentUser)
            assertEquals(originalSecret, SecureCredentials(application).get(before.secretRef))
            assertEquals(settings.copy(mode = "byok"), controller.state.value.settings)
            assertEquals(1, controller.state.value.archives.size)
            val saved = controller.backup()
            assertFalse(saved.contains(originalSecret))
            assertFalse(saved.contains("synthetic-password"))
            assertFalse(saved.contains("current_account"))
            assertEquals("", appJson.decodeFromString<BackupDocument>(saved).tasks.single().decodeTask().secretRef)
            val paused = task(observed)
            assertEquals("paused", paused.status)
            assertEquals(before.chunks.single().remoteJobId, paused.chunks.single().remoteJobId)
            assertEquals(before.chunks.single().attempt, paused.chunks.single().attempt)
            controller.restoreBackup(saved)
            assertEquals("", task(observed).secretRef)
            controller.loginAccount("ownerB", "synthetic-password")
            assertTrue(runCatching { controller.resumeTask(before.id, acknowledgeCost = true) }.isFailure)
            assertEquals(1, network.submissions.size)
            controller.logoutAccount()
            controller.loginAccount("ownerA", "synthetic-password")
            controller.resumeTask(before.id, acknowledgeCost = true)
            awaitCondition { network.pollTokens.any { it != originalSecret } }
            val resumed = task(observed)
            assertEquals(before.settings, resumed.settings)
            assertEquals(before.promptVersion, resumed.promptVersion)
            assertEquals(before.chunks.single().cacheKey, resumed.chunks.single().cacheKey)
            assertEquals(before.chunks.single().remoteJobId, resumed.chunks.single().remoteJobId)
            network.complete.complete(Unit)
            awaitCondition { task(observed).status == "completed" }
            assertEquals(1, network.submissions.size)
            BackupValidation.validate(backup(controller))
        } finally {
            network.complete.complete(Unit)
            controller.logoutAccount()
            close(store)
            observed.close()
        }
    }

    @Test fun storedSessionRestoresWithoutLoginAnd401CannotCreateAnonymousFallback() = runBlocking<Unit> {
        val name = "account-expiry-${UUID.randomUUID()}.db"
        val network = FakeOrganization()
        val accounts = FakeAccounts().apply { managedEligibility = false }
        val first = controller(name, network, accounts)
        var second: Pair<ViewModelStore, AppController>? = null
        try {
            initialize(first.second)
            first.second.loginAccount("ownerA", "synthetic-password")
            assertFalse(first.second.state.value.account.currentUser!!.managedEligible)
            // A web redemption updates the server before the native profile cache.
            accounts.managedEligibility = true
            first.second.updateChatProvider("id-ownerA", "managed", null, null, null)
            assertTrue(first.second.state.value.account.currentUser!!.managedEligible)
            assertEquals("ownerA", first.second.state.value.account.currentUser?.username)
            assertEquals(1, accounts.logins.get())
            close(first.first)
            val recreated = controller(name, network, accounts)
            second = recreated
            recreated.second.backup()
            assertEquals("ownerA", recreated.second.state.value.account.currentUser?.username)
            assertEquals(1, accounts.logins.get())
            network.rejectQuota = true
            assertTrue(runCatching { recreated.second.refreshQuota() }.isFailure)
            assertNull(recreated.second.state.value.account.currentUser)
            assertEquals("", SecureCredentials(application).get("current_account"))
            val requests = network.quotaReads.get()
            assertTrue(runCatching { recreated.second.refreshQuota() }.isFailure)
            assertEquals(requests, network.quotaReads.get())
            assertEquals(0, network.sessions.get())
            assertEquals(1, accounts.logins.get())
        } finally {
            second?.let { close(it.first) }
            close(first.first)
        }
    }

    @Test fun invitedRegistrationDefaultsToManagedAndLaterLoginRestoresPersonalChoice() = runBlocking<Unit> {
        val username = "new-user-${UUID.randomUUID().toString().take(8)}"
        val invitation = "SYN-REGISTER-123456"
        val accounts = FakeAccounts()
        val (store, controller) = controller("invited-registration-${UUID.randomUUID()}.db", FakeOrganization(), accounts)
        try {
            initialize(controller)
            controller.registerAccount(username, "synthetic-password", invitation)
            assertEquals(invitation, accounts.registrationCode)
            assertEquals("invitation", controller.state.value.account.currentUser?.registrationKind)
            assertTrue(controller.state.value.account.currentUser?.managedEligible == true)
            assertEquals("managed", controller.state.value.chatProvider?.mode)
            assertEquals("companion", controller.state.value.organizationSettings.mode)

            controller.updateChatProvider("id-$username", "personal", "synthetic-byok-key",
                "https://api.synthetic.invalid/compatible", "synthetic-personal-model")
            controller.logoutAccount()
            controller.loginAccount(username, "synthetic-password")
            assertEquals("personal", controller.state.value.chatProvider?.mode)
            assertEquals("synthetic-personal-model", controller.state.value.organizationSettings.model)
        } finally {
            controller.logoutAccount()
            SecureCredentials(application).put("chat-provider:user:id-$username", "")
            close(store)
        }
    }

    @Test fun adminScopeFollowsVerifiedRoleAndNeverReusesStoredOperatorToken() = runBlocking<Unit> {
        val storage = SecureCredentials(application)
        storage.put("developer_prefs", """{"sessionToken":"synthetic-retired-operator-token"}""")
        val accounts = FakeAccounts()
        val (store, controller) = controller("admin-scope-${UUID.randomUUID()}.db", FakeOrganization(), accounts)
        try {
            initialize(controller)
            assertEquals("", storage.get("developer_prefs"))
            assertTrue(runCatching { controller.verifyAdminAccess() }.isFailure)
            controller.loginAccount("synthetic", "synthetic-password")
            assertTrue(runCatching { controller.verifyAdminAccess() }.isFailure)
            accounts.role = "admin"
            controller.verifyAdminAccess()
            val admin = controller.state.value.developerPrefs
            assertEquals("account-token-1", admin.sessionToken)
            assertEquals(service, admin.serviceUrl)
            accounts.role = "user"
            assertTrue(runCatching { controller.verifyAdminAccess() }.isFailure)
            assertEquals("", controller.state.value.developerPrefs.sessionToken)
            accounts.role = "admin"
            controller.verifyAdminAccess()
            controller.logoutAccount()
            assertEquals("", controller.state.value.developerPrefs.sessionToken)
            assertNull(controller.state.value.adminUsers)
        } finally {
            close(store)
        }
    }

    private inner class FakeAccounts : AccountTransport {
        var role = "user"
        var managedEligibility: Boolean? = null
        var registrationCode: String? = null
        val logins = AtomicInteger()
        override suspend fun register(serviceUrl: String, username: String, password: String, invitationCode: String): AccountAuthentication {
            registrationCode = invitationCode
            val created = login(serviceUrl, username, password)
            val user = created.session.user.copy(registrationKind = "invitation", managedEligible = true)
            return created.copy(session = created.session.copy(user = user))
        }
        override suspend fun login(serviceUrl: String, username: String, password: String): AccountAuthentication {
            val count = logins.incrementAndGet()
            return AccountAuthentication(AccountSession(serviceUrl, "account-token-$count", "2099-01-01T00:00:00+08:00",
                AccountUser("id-$username", username, "public", "2026-11-14T00:00:00+08:00",
                    managedEligible = managedEligibility ?: true)), quota)
        }
        override suspend fun me(session: AccountSession) = AccountProfile(
            session.user.copy(role = role, managedEligible = managedEligibility ?: session.user.managedEligible), quota)
        override suspend fun redeem(session: AccountSession, code: String) = AccountProfile(session.user.copy(managedEligible = true), quota)
        override suspend fun logout(session: AccountSession) = Unit
    }

    private inner class FakeOrganization : OrganizationNetwork {
        val sessions = AtomicInteger()
        val quotaReads = AtomicInteger()
        val submissions = CopyOnWriteArrayList<String>()
        val pollTokens = CopyOnWriteArrayList<String>()
        val complete = CompletableDeferred<Unit>()
        @Volatile var rejectQuota = false
        private var messages: List<ChatMessage> = emptyList()
        override suspend fun createSession(settings: ServiceSettings): CompanionSession {
            sessions.incrementAndGet()
            error("No anonymous sessions are allowed in this fixture")
        }
        override suspend fun quota(settings: ServiceSettings): CompanionQuota {
            quotaReads.incrementAndGet()
            if (rejectQuota) throw SummaryFailure("synthetic session expired", false, statusCode = 401)
            return quota
        }
        override suspend fun submit(settings: ServiceSettings, messages: List<ChatMessage>, key: String): RemoteJob {
            submissions += key
            this.messages = messages
            return RemoteJob("synthetic-remote", "queued")
        }
        override suspend fun poll(settings: ServiceSettings, remoteId: String): RemoteJob {
            pollTokens += settings.trialToken
            complete.await()
            return RemoteJob(remoteId, "completed", listOf(ArchiveEntry("result", EntryCategory.RECENT,
                "已确定周六见面，雨天改去展览。", messages.map { it.id })))
        }
        override suspend fun cancel(settings: ServiceSettings, remoteId: String) = RemoteJob(remoteId, "cancelled")
        override suspend fun summarize(settings: ServiceSettings, messages: List<ChatMessage>, promptVersion: String): List<ArchiveEntry> =
            error("This fixture uses only the fake companion transport")
    }
}
