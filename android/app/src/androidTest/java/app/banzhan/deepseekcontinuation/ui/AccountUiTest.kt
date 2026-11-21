package app.banzhan.deepseekcontinuation.ui

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.text.AnnotatedString
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.banzhan.deepseekcontinuation.data.*
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Local form callbacks only: these tests never create a real account or contact a model. */
@RunWith(AndroidJUnit4::class)
class AccountUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun registrationKeepsUsernameAfterFailureButClearsThePassword() {
        val supplied = AtomicReference<Triple<String, String, String>?>(null)
        val signedIn = AtomicInteger()
        showAccount(onRegister = { username, password, invitationCode ->
            supplied.set(Triple(username, password, invitationCode))
            error("合成：用户名已被使用。")
        }, onSignedIn = { signedIn.incrementAndGet() })
        accountNode("account-register-mode").performClick()
        accountNode("account-username").performTextInput("合成用户")
        accountNode("account-password").performTextInput("  secret-pass  ")
        accountNode("account-submit").assertIsNotEnabled()
        accountNode("account-invitation-code").performTextInput("  SYN-REGISTER-123456  ")
        accountNode("account-invitation-code").performImeAction()
        accountNode("account-submit").performClick()
        compose.waitUntil(5_000) { supplied.get() != null }
        assertEquals(Triple("合成用户", "  secret-pass  ", "SYN-REGISTER-123456"), supplied.get())
        compose.onNodeWithText("合成：用户名已被使用。").performScrollTo().assertIsDisplayed()
        accountNode("account-username").assertTextContains("合成用户")
        accountNode("account-password").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        accountNode("account-submit").assertIsNotEnabled()
        assertEquals(0, signedIn.get())
        screenshot("registration-failure.png")
    }

    @Test fun pendingLoginDoesNotSubmitTwiceAndOnlySuccessReturns() {
        val attempts = CopyOnWriteArrayList<Pair<String, String>>()
        val release = CompletableDeferred<Unit>()
        val signedIn = AtomicInteger()
        showAccount(onLogin = { username, password ->
            attempts.add(username to password)
            release.await()
        }, onSignedIn = { signedIn.incrementAndGet() })
        compose.onNodeWithTag("account-invitation-code").assertDoesNotExist()
        accountNode("account-username").performTextInput("local-user")
        accountNode("account-password").performTextInput("my-password")
        accountNode("account-password").performImeAction()
        accountNode("account-submit").performClick()
        compose.waitUntil(5_000) { attempts.size == 1 }
        accountNode("account-submit").assertIsNotEnabled().performTouchInput { click(); click() }
        accountNode("account-register-mode").assertIsNotEnabled()
        assertEquals(listOf("local-user" to "my-password"), attempts.toList())
        assertEquals(0, signedIn.get())
        compose.runOnIdle { release.complete(Unit) }
        compose.waitUntil(5_000) { signedIn.get() == 1 }
        assertEquals(1, attempts.size)
    }

    @Test fun selfServiceRegistrationCanSubmitWithoutAnInvitation() {
        val supplied = AtomicReference<Triple<String, String, String>?>(null)
        showAccount(
            readSelfServiceRegistration = { true },
            onRegister = { username, password, invitationCode ->
                supplied.set(Triple(username, password, invitationCode))
            },
        )
        accountNode("account-register-mode").performClick()
        accountNode("account-username").performTextInput("合成用户")
        accountNode("account-password").performTextInput("synthetic-password")
        accountNode("account-submit").assertIsEnabled().performClick()
        compose.waitUntil(5_000) { supplied.get() != null }
        assertEquals(Triple("合成用户", "synthetic-password", ""), supplied.get())
    }

    @Test fun passwordAndInvitationAreNotRestoredWithTheForm() {
        val restoration = StateRestorationTester(compose)
        restoration.setContent {
            ContinuationTheme {
                val scope = rememberCoroutineScope()
                AccountTestFrame {
                    AccountScreenContent(AppState(), false, { action -> scope.launch { action() } },
                        { _, _ -> }, { _, _, _ -> }, {}, {})
                }
            }
        }
        accountNode("account-register-mode").performClick()
        accountNode("account-username").performTextInput("restore-user")
        accountNode("account-password").performTextInput("private-pass")
        accountNode("account-invitation-code").performTextInput("SYN-REGISTER-SECRET")
        accountNode("account-invitation-code").performImeAction()
        restoration.emulateSavedInstanceStateRestore()
        accountNode("account-username").assertTextContains("restore-user")
        accountNode("account-password").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        accountNode("account-invitation-code").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        accountNode("account-submit").assertIsNotEnabled()
    }

    @Test fun signedInAccountShowsOnlyPersonalQuotaAndCanLogOut() {
        val logouts = AtomicInteger()
        val state = mutableStateOf(AppState(
            account = AccountState(currentUser = AccountUser("synthetic-user", "合成账户", "public", "2026-11-14T00:00:00+08:00")),
            quota = CompanionQuota(true, null, null, "synthetic", "", weeklyLimit = 987654,
                weeklyRemaining = 876543, userWeeklyLimit = 5, userWeeklyRemaining = 3,
                weeklyReserved = 765432, userWeeklyReserved = 1, accessMode = "public"),
        ))
        showAccount(state = state, onLogout = {
            logouts.incrementAndGet()
            state.value = state.value.copy(account = AccountState(), quota = null)
        })
        compose.onNodeWithText("合成账户").assertIsDisplayed()
        compose.onNodeWithText("3 / 5 次").assertIsDisplayed()
        listOf("987654", "876543", "765432", "全站").forEach {
            compose.onNodeWithText(it, substring = true).assertDoesNotExist()
        }
        screenshot("account-personal-quota.png")
        accountNode("account-logout").performClick()
        compose.waitUntil(5_000) { logouts.get() == 1 }
        accountNode("account-login-mode").assertIsDisplayed()
    }

    @Test fun administratorCanRestoreTheDefaultLimitAndSetOnlyThisWeeksRemaining() {
        val saved = AtomicReference<Pair<Int?, Int?>?>(null)
        val user = UserUsage("synthetic-user", "public", "2026-11-14T00:00:00+08:00", null,
            9, 2, 1, 6, 3, 1, 0, 0, 0, 0, 0, username = "合成用户", registrationKind = "public", weeklyLimitOverride = 9, managedEligible = true)
        compose.setContent {
            ContinuationTheme {
                AccountTestFrame {
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                        RegisteredUserQuotaCard(user, 5, false) { limit, remaining -> saved.set(limit to remaining) }
                    }
                }
            }
        }
        compose.onNodeWithTag("admin-user-toggle:synthetic-user").performClick()
        compose.onNodeWithTag("admin-user-follow-default:synthetic-user").performScrollTo().assertIsOff().performClick()
        compose.onNodeWithText("仅本周的剩余次数（选填）").performScrollTo().performTextInput("4")
        compose.onNodeWithTag("admin-user-save:synthetic-user").performScrollTo().performClick()
        assertEquals(null to 4, saved.get())
        compose.onNodeWithText("个人每周免费次数").assertDoesNotExist()
        screenshot("admin-personal-quota.png")
    }

    @Test fun imageOnlyAccountShowsSharedQuotaAndSyncOnlyAccountShowsPermissions() {
        val imageOnly = AccountUser("synthetic-user", "合成账户", "invitation", "2026-11-14T00:00:00+08:00",
            managedEligible = false, permissions = ServicePermissions.None.copy(imageApi = true), inviteRedeemable = false)
        val state = mutableStateOf(AppState(
            account = AccountState(currentUser = imageOnly),
            quota = CompanionQuota(false, null, null, "synthetic", "", userWeeklyLimit = 5, userWeeklyRemaining = 3),
        ))
        showAccount(state = state)
        compose.onNodeWithText("3 / 5 次").assertIsDisplayed()
        compose.onNodeWithText("免费智能整理当前已暂停。").assertDoesNotExist()
        compose.runOnIdle {
            state.value = state.value.copy(account = AccountState(imageOnly.copy(
                permissions = ServicePermissions.None.copy(cloudSync = true))))
        }
        compose.onNodeWithText("已开通云同步。").assertIsDisplayed()
        compose.onNodeWithText("3 / 5 次").assertDoesNotExist()
        compose.onNodeWithText("兑换邀请码", substring = true).assertDoesNotExist()
    }

    @Test fun accountManagementActionsStayInDetailsAndRespectLoading() {
        val status = AtomicReference<Boolean?>(null)
        val resets = AtomicInteger()
        val loading = mutableStateOf(false)
        val user = UserUsage("synthetic-disabled", "public", "2026-11-14T00:00:00+08:00", null,
            35, 2, 0, 33, 2, 2, 0, 0, 0, 0, 0, username = "停用用户", registrationKind = "public", enabled = false)
        compose.setContent {
            ContinuationTheme {
                AccountTestFrame {
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                        RegisteredUserQuotaCard(user, 35, loading.value,
                            onSetEnabled = { status.set(it) }, onResetPassword = { resets.incrementAndGet() }) { _, _ -> }
                    }
                }
            }
        }
        compose.onNodeWithTag("admin-user-status:${user.id}").assertDoesNotExist()
        compose.onNodeWithTag("admin-user-toggle:${user.id}").performClick()
        compose.onNodeWithText("账号已停用").assertIsDisplayed()
        compose.onNodeWithTag("admin-user-status:${user.id}").performScrollTo().performClick()
        assertEquals(true, status.get())
        compose.onNodeWithTag("admin-user-reset:${user.id}").performScrollTo().performClick()
        assertEquals(1, resets.get())
        compose.runOnIdle { loading.value = true }
        compose.onNodeWithTag("admin-user-status:${user.id}").assertIsNotEnabled()
        compose.onNodeWithTag("admin-user-reset:${user.id}").assertIsNotEnabled()
    }

    @Test fun unusedInvitationRemainsVisibleAndCopiesItsCompleteCode() {
        val invitation = AdminRegistrationInvite("synthetic-invite", "SYN-REGISTER-COMPLETE-1234",
            "2026-11-21T00:00:00+08:00", "2026-11-14T00:00:00+08:00",
            permissions = ServicePermissions.None.copy(cloudSync = true))
        val generated = AtomicReference<Triple<Int, Int, ServicePermissions>?>(null)
        compose.setContent {
            ContinuationTheme {
                var expanded by remember { mutableStateOf(false) }
                AccountTestFrame {
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                        RegistrationInvitationControls(expanded, false, { expanded = !expanded }, {},
                            { count, days, permissions -> generated.set(Triple(count, days, permissions)) })
                        if (expanded) RegistrationInvitationCard(invitation)
                    }
                }
            }
        }
        compose.onNodeWithText("SYN-REGISTER-COMPLETE-1234").assertDoesNotExist()
        compose.onNodeWithTag("admin-invitations-toggle").performClick()
        compose.onNodeWithTag("admin-invitations-create").performScrollTo().performClick()
        assertEquals(Triple(1, 7, ServicePermissions.All), generated.get())
        compose.onNodeWithTag("admin-invite-permissions:image").performScrollTo().assertIsOn().performClick()
        compose.onNodeWithTag("admin-invitations-create").performScrollTo().performClick()
        assertEquals(Triple(1, 7, ServicePermissions.All.copy(imageApi = false)), generated.get())
        compose.onNodeWithText("SYN-REGISTER-COMPLETE-1234").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("权限 · 云同步").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("到期时间", substring = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("admin-invitation-copy:synthetic-invite").performScrollTo().performClick()
        compose.onNodeWithText("已复制").assertIsDisplayed()
        compose.runOnIdle {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            assertEquals("SYN-REGISTER-COMPLETE-1234", clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString())
        }
        screenshot("admin-unused-invitation.png")
    }

    @Test fun administratorEditsPermissionsIndependentlyAndImageOnlyKeepsQuotaControls() {
        val saved = AtomicReference<ServicePermissions?>(null)
        val user = UserUsage("image-user", "public", "2026-11-14T00:00:00+08:00", null,
            5, 2, 0, 3, 2, 2, 0, 0, 0, 0, 0, username = "生图用户",
            permissions = ServicePermissions.None.copy(imageApi = true))
        val listedUser = mutableStateOf(user)
        compose.setContent {
            ContinuationTheme {
                AccountTestFrame {
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                        RegisteredUserQuotaCard(listedUser.value, 5, false, onSavePermissions = { saved.set(it) }) { _, _ -> }
                    }
                }
            }
        }
        compose.onNodeWithText("3 / 5").assertIsDisplayed()
        compose.onNodeWithTag("admin-user-toggle:${user.id}").performClick()
        compose.onNodeWithTag("admin-user-save:${user.id}").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("admin-user-save-permissions:${user.id}").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("admin-user-permissions:${user.id}:chat").performScrollTo().assertIsOff().performClick()
        compose.onNodeWithTag("admin-user-permissions:${user.id}:image").performScrollTo().assertIsOn().performClick()
        compose.onNodeWithTag("admin-user-save-permissions:${user.id}").performScrollTo().performClick()
        assertEquals(ServicePermissions.None.copy(chatApi = true), saved.get())
        compose.runOnIdle { listedUser.value = user.copy(permissions = ServicePermissions.None, inviteRedeemable = true) }
        compose.onNodeWithTag("admin-user-save-permissions:${user.id}").performScrollTo().assertIsEnabled().performClick()
        assertEquals(ServicePermissions.None, saved.get())
        compose.runOnIdle { listedUser.value = listedUser.value.copy(inviteRedeemable = false) }
        compose.onNodeWithTag("admin-user-save-permissions:${user.id}").assertIsNotEnabled()
    }

    private fun showAccount(
        state: State<AppState> = mutableStateOf(AppState()),
        onLogin: suspend (String, String) -> Unit = { _, _ -> },
        onRegister: suspend (String, String, String) -> Unit = { _, _, _ -> },
        onLogout: suspend () -> Unit = {},
        onSignedIn: () -> Unit = {},
        readSelfServiceRegistration: suspend () -> Boolean = { false },
    ) {
        compose.setContent {
            ContinuationTheme {
                val scope = rememberCoroutineScope()
                AccountTestFrame {
                    AccountScreenContent(state.value, false, { action -> scope.launch { action() } },
                        onLogin, onRegister, onLogout, {}, onSignedIn, readSelfServiceRegistration)
                }
            }
        }
    }

    private fun accountNode(tag: String): SemanticsNodeInteraction {
        compose.onNodeWithTag("account-page").performScrollToNode(hasTestTag(tag))
        return compose.onNodeWithTag(tag).performScrollTo()
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun AccountTestFrame(content: @Composable () -> Unit) {
        Scaffold(topBar = {
            TopAppBar(title = { Text("账户") },
                navigationIcon = { IconButton(onClick = {}) { Icon(Icons.Outlined.ArrowBack, "返回") } },
                actions = { IconButton(onClick = {}) { Icon(Icons.Outlined.Checklist, "整理进度") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Mist))
        }) { padding -> Column(Modifier.fillMaxSize().padding(padding)) { content() } }
    }

    private fun screenshot(name: String) {
        compose.waitForIdle()
        val instrument = InstrumentationRegistry.getInstrumentation()
        instrument.waitForIdleSync()
        instrument.uiAutomation.waitForIdle(100, 2_000)
        val bitmap = instrument.uiAutomation.takeScreenshot() ?: error("Could not capture account UI")
        val directory = File(instrument.targetContext.filesDir, "account-ui-qa")
        check(directory.isDirectory || directory.mkdirs())
        try {
            File(directory, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        } finally { bitmap.recycle() }
    }
}
