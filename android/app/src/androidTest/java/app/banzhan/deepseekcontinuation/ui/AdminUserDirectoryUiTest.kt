package app.banzhan.deepseekcontinuation.ui

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.isDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import app.banzhan.deepseekcontinuation.data.AccountState
import app.banzhan.deepseekcontinuation.data.AccountUser
import app.banzhan.deepseekcontinuation.data.AdminUserStatusFilter
import app.banzhan.deepseekcontinuation.data.AdminUsersPage
import app.banzhan.deepseekcontinuation.data.AppController
import app.banzhan.deepseekcontinuation.data.AppState
import app.banzhan.deepseekcontinuation.data.DeveloperPrefs
import app.banzhan.deepseekcontinuation.data.ServicePermissions
import app.banzhan.deepseekcontinuation.data.UserUsage
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class AdminUserDirectoryUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun listsAccountsAndKeepsSearchAndStatusInPaginationRequests() {
        val users = listOf(
            user("demo-a", "demo_may", enabled = true, remaining = 17),
            user("demo-b", "demo_north", enabled = false, remaining = 0),
        )
        val page = mutableStateOf(AdminUsersPage(25, 0, 28, users))
        val requests = mutableListOf<Triple<Int, String, AdminUserStatusFilter>>()
        var selected: String? = null
        rule.setContent {
            ContinuationTheme {
                Box(Modifier.fillMaxSize()) {
                    AdminUserDirectory(page.value, false, null,
                        onPage = { offset, query, filter -> requests.add(Triple(offset, query, filter)) },
                        onUser = { selected = it.id })
                }
            }
        }
        rule.onNodeWithText("demo_may").assertIsDisplayed()
        rule.onNodeWithTag("admin-user-row:demo-a").performClick()
        rule.runOnIdle { assertEquals("demo-a", selected) }
        rule.onNodeWithTag("admin-user-search").performTextInput("north")
        rule.onNodeWithTag("admin-user-search-submit").performClick()
        rule.runOnIdle {
            assertEquals(Triple(0, "north", AdminUserStatusFilter.ALL), requests.last())
            page.value = AdminUsersPage(25, 0, 26, listOf(users[1]), query = "north")
        }
        rule.onNodeWithTag("admin-user-filter:disabled").performClick()
        rule.runOnIdle {
            assertEquals(Triple(0, "north", AdminUserStatusFilter.DISABLED), requests.last())
            page.value = page.value.copy(statusFilter = AdminUserStatusFilter.DISABLED)
        }
        val nextPage = rule.onNodeWithTag("admin-user-next")
        rule.waitUntil(5_000) { nextPage.isDisplayed() }
        nextPage.performClick()
        rule.runOnIdle { assertEquals(Triple(25, "north", AdminUserStatusFilter.DISABLED), requests.last()) }
    }

    @Test
    fun developerToolsOpensAccountDetailsAndManagementSections() {
        val users = listOf(
            user("demo-a", "青禾", enabled = true, remaining = 17),
            user("demo-b", "望川", enabled = false, remaining = 0),
            user("demo-c", "小满", enabled = true, remaining = 5).copy(role = "user",
                effectivePermissions = ServicePermissions.None.copy(imageApi = true)),
            user("demo-d", "松间", enabled = true, remaining = 0).copy(role = "user",
                effectivePermissions = ServicePermissions.None.copy(cloudSync = true)),
            user("demo-e", "南枝", enabled = true, remaining = 0).copy(role = "user",
                effectivePermissions = ServicePermissions.None),
        ) + (6..25).map { index ->
            user("demo-$index", "测试用户 $index", enabled = true, remaining = 0).copy(role = "user",
                effectivePermissions = ServicePermissions.None)
        }
        val state = AppState(
            account = AccountState(currentUser = AccountUser("demo-a", "青禾", "public", "2026-11-10T12:00:00+08:00", "admin")),
            developerPrefs = DeveloperPrefs(sessionToken = "synthetic-admin"),
            adminUsers = AdminUsersPage(25, 0, 28, users),
            adminRegistrationInvites = emptyList(),
            adminSelfServiceRegistration = false,
            adminOpenPermissions = ServicePermissions.None,
        )
        val controller = rule.runOnIdle { ViewModelProvider(rule.activity)[AppController::class.java] }
        rule.setContent {
            ContinuationTheme {
                DeveloperScreen(state, controller, run = {})
            }
        }
        rule.onNodeWithText("用户管理").performClick()
        rule.onNodeWithTag("admin-users-section:users").assertIsDisplayed()
        rule.onNodeWithText("青禾").assertIsDisplayed()
        rule.onNodeWithTag("admin-user-next").assertIsDisplayed()
        captureIfRequested("directory")

        rule.onNodeWithTag("admin-user-row:demo-a").performClick()
        rule.onNodeWithText("账号详情").assertIsDisplayed()
        captureIfRequested("detail")
        rule.onNodeWithTag("admin-user-open-permissions:demo-a").performClick()
        rule.onNodeWithText("保存权限").assertIsDisplayed()
        captureIfRequested("permissions")
        rule.onNodeWithTag("admin-user-save-permissions:demo-a").assertIsDisplayed()

        rule.onNodeWithContentDescription("关闭账号详情").performClick()
        rule.onNodeWithTag("admin-users-section:invitations").performClick()
        rule.onNodeWithTag("admin-invitations-toggle").assertIsDisplayed()
        rule.onNodeWithTag("admin-users-section:rules").performClick()
        rule.onNodeWithText("开放自助注册").assertExists()
        rule.onNodeWithTag("admin-users-section:users").performClick()
        rule.onNodeWithText("青禾").assertIsDisplayed()
    }

    private fun captureIfRequested(name: String) {
        val capture = InstrumentationRegistry.getArguments().getString("adminLayoutCapture") ?: return
        if (!capture.matches(Regex("[a-z0-9-]{1,24}"))) return
        rule.waitForIdle()
        val instrument = InstrumentationRegistry.getInstrumentation()
        instrument.uiAutomation.waitForIdle(100, 2_000)
        val bitmap = checkNotNull(instrument.uiAutomation.takeScreenshot())
        try {
            File(instrument.targetContext.cacheDir, "admin-$name-$capture.png").outputStream().use { output ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
            }
        } finally {
            bitmap.recycle()
        }
    }

    private fun user(id: String, name: String, enabled: Boolean, remaining: Int) = UserUsage(
        id = id, username = name, accessMode = "public", createdAt = "2026-11-10T12:00:00+08:00",
        lastSeenAt = "2026-11-20T18:00:00+08:00", weeklyLimit = 35, weeklyUsed = 18,
        weeklyReserved = 0, weeklyRemaining = remaining, totalRequests = 125,
        completed = 0, failed = 0, uncertain = 0, cancelled = 0, inputTokens = 0, outputTokens = 0,
        registrationKind = "public", enabled = enabled, role = if (enabled) "admin" else "user",
        permissions = ServicePermissions.All,
        effectivePermissions = if (enabled) ServicePermissions.All else ServicePermissions.None,
    )
}
