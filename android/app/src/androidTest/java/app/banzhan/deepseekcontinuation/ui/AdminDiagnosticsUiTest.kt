package app.banzhan.deepseekcontinuation.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import app.banzhan.deepseekcontinuation.data.AccountState
import app.banzhan.deepseekcontinuation.data.AccountUser
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticDetail
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticEvent
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticGroup
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticModel
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticRelease
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticResolution
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticsPage
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticsRange
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticsStatus
import app.banzhan.deepseekcontinuation.data.AdminStorage
import app.banzhan.deepseekcontinuation.data.AppController
import app.banzhan.deepseekcontinuation.data.AppState
import app.banzhan.deepseekcontinuation.data.DeveloperPrefs
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class AdminDiagnosticsUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun faultDiagnosticsAndServerStorageAreVisibleInDeveloperTools() {
        val controller = rule.runOnIdle { ViewModelProvider(rule.activity)[AppController::class.java] }
        val state = AppState(
            account = AccountState(currentUser = AccountUser("demo-admin", "测试管理员", "public", "2026-11-10T12:00:00+08:00", "admin")),
            developerPrefs = DeveloperPrefs(sessionToken = "synthetic-admin"),
            adminDiagnostics = page,
            adminStorage = AdminStorage(12_000L, 100_000L, 8_000L, 100_000L, 99_000L, 10_000L, warning = true),
        )
        rule.setContent {
            ContinuationTheme {
                Box(Modifier.widthIn(max = 360.dp).fillMaxHeight()) {
                    DeveloperScreen(state, controller, run = {})
                }
            }
        }
        rule.onNodeWithTag("developer-tab:diagnostics").assertIsDisplayed().performClick()
        rule.onNodeWithTag("admin-diagnostics-group:$eventId").assertIsDisplayed()
        rule.onNodeWithTag("developer-tab:server").assertIsDisplayed().performClick()
        rule.onNodeWithText("服务器存储").assertIsDisplayed()
        rule.onNodeWithText("多端同步").assertIsDisplayed()
        rule.onNodeWithText("部分存储用量或磁盘余量已达到预警阈值。").assertIsDisplayed()
    }

    @Test
    fun rangesAndCanonicalDiagnosticIdsReachTheCorrectQueries() {
        val result = mutableStateOf(page)
        val detail = mutableStateOf<AdminDiagnosticDetail?>(null)
        val loadedEvent = mutableStateOf(event)
        val ranges = mutableListOf<AdminDiagnosticsRange>()
        val lookups = mutableListOf<String>()
        rule.setContent {
            ContinuationTheme {
                AdminDiagnosticsContent(
                    page = result.value,
                    loading = false,
                    error = null,
                    detail = detail.value,
                    detailLoading = false,
                    detailError = null,
                    onRefresh = { range, _ ->
                        ranges.add(range)
                        result.value = page.copy(range = range)
                    },
                    onLookup = { id ->
                        lookups.add(id)
                        detail.value = AdminDiagnosticDetail(loadedEvent.value, emptyList(), 30)
                    },
                    onCloseDetail = { detail.value = null },
                )
            }
        }
        rule.onNodeWithTag("admin-diagnostics-range:LAST_7_DAYS").performClick()
        rule.runOnIdle {
            assertEquals(listOf(AdminDiagnosticsRange.LAST_24_HOURS, AdminDiagnosticsRange.LAST_7_DAYS), ranges)
        }
        rule.onNodeWithTag("admin-diagnostics-group:$eventId").performClick()
        rule.onNodeWithText("故障详情").assertIsDisplayed()
        rule.onNodeWithTag("admin-diagnostics-resolve-single").assertDoesNotExist()
        rule.onNodeWithText("WebView 103 低于应用内聊天所需的版本 105。").assertIsDisplayed()
        rule.onNodeWithText(eventId).assertIsDisplayed()
        rule.onNodeWithTag("admin-diagnostics-copy").performClick()
        rule.onNodeWithText("已复制").assertIsDisplayed()
        rule.onNodeWithText("关闭").performClick()
        rule.onNodeWithText("故障详情").assertDoesNotExist()

        val input = rule.onNodeWithTag("admin-diagnostics-search")
        val submit = rule.onNodeWithTag("admin-diagnostics-search-submit")
        input.performTextInput("invalid-id")
        submit.performClick()
        rule.onNodeWithText("请输入完整的诊断编号。").assertIsDisplayed()
        rule.runOnIdle { loadedEvent.value = event.copy(release = "2.6.18-compat.1+56") }
        input.performTextReplacement(eventId.uppercase(Locale.ROOT))
        submit.performClick()
        rule.onNodeWithText("故障详情").assertIsDisplayed()
        rule.onNode(hasText("内嵌网页 · 加载失败") and hasAnyAncestor(isDialog())).assertIsDisplayed()
        rule.onNodeWithText("WebView 103 低于应用内聊天所需的版本 105。").assertDoesNotExist()
        rule.runOnIdle { assertEquals(listOf(eventId, eventId), lookups) }
    }

    @Test
    fun resolutionUsesTheViewedGroupSnapshotAndLetsTheAdminReopenAnEvent() {
        val pending = page.copy(since = occurredAt - 86_400L, supportsResolution = true)
        val result = mutableStateOf(pending)
        val detail = mutableStateOf<AdminDiagnosticDetail?>(null)
        val resolved = mutableStateOf(false)
        val changes = mutableListOf<AdminDiagnosticResolution>()
        rule.setContent {
            ContinuationTheme {
                AdminDiagnosticsContent(
                    page = result.value,
                    loading = false,
                    error = null,
                    detail = detail.value,
                    detailLoading = false,
                    detailError = null,
                    onRefresh = { range, status ->
                        result.value = pending.copy(range = range, status = status,
                            groups = if ((status == AdminDiagnosticsStatus.RESOLVED) == resolved.value) pending.groups else emptyList())
                    },
                    onLookup = {
                        detail.value = AdminDiagnosticDetail(event.copy(resolvedAt = event.receivedAt.takeIf { resolved.value }),
                            emptyList(), 30, supportsResolution = true)
                    },
                    onCloseDetail = { detail.value = null },
                    onResolve = { change ->
                        changes.add(change)
                        resolved.value = change.resolved
                        if (change.groupSince == null) 1 else 3
                    },
                )
            }
        }
        rule.onNodeWithTag("admin-diagnostics-group:$eventId").performClick()
        rule.onNodeWithTag("admin-diagnostics-resolve-group").performClick()
        rule.onNodeWithTag("admin-diagnostics-confirm-group").performClick()
        rule.onNodeWithText("已将 3 条记录标为已解决。").assertIsDisplayed()
        rule.onNodeWithTag("admin-diagnostics-group:$eventId").assertDoesNotExist()
        rule.onNodeWithTag("admin-diagnostics-status:RESOLVED").performClick()
        rule.onNodeWithTag("admin-diagnostics-group:$eventId").performClick()
        rule.onNodeWithText("移回待处理").assertIsDisplayed()
        rule.onNodeWithTag("admin-diagnostics-resolve-single").performClick()
        rule.onNodeWithTag("admin-diagnostics-group:$eventId").assertDoesNotExist()
        rule.runOnIdle {
            assertEquals(listOf(AdminDiagnosticResolution(eventId, true, pending.since),
                AdminDiagnosticResolution(eventId, false)), changes)
        }
    }

    private companion object {
        const val eventId = "305abf01-8320-4ba0-83be-98f3e06b1209"
        const val occurredAt = 1_795_208_400L
        val event = AdminDiagnosticEvent(
            eventId = eventId, occurredAt = occurredAt, receivedAt = occurredAt + 30,
            source = "android", release = "2.6.15+53", area = "webview", code = "load_failed",
            stage = "initialize", androidSdk = 33, manufacturer = "Synthetic", model = "Demo Phone",
            webviewVersion = "103.0.5060.129", webviewProvider = "com.google.android.webview",
            httpStatus = null, elapsedMs = 600L, requestId = null,
        )
        val page = AdminDiagnosticsPage(
            range = AdminDiagnosticsRange.LAST_24_HOURS,
            retentionDays = 30,
            groups = listOf(
                AdminDiagnosticGroup(
                    source = event.source, area = event.area, code = event.code, stage = event.stage, count = 3,
                    firstAt = occurredAt - 3600, lastAt = occurredAt, lastReceivedAt = occurredAt + 30,
                    latestEventId = eventId, releases = listOf(AdminDiagnosticRelease(event.release, 3)),
                    models = listOf(AdminDiagnosticModel(event.manufacturer, "Demo Phone", 3)),
                ),
            ),
        )
    }
}
