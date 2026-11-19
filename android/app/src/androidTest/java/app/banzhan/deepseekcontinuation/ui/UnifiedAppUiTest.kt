package app.banzhan.deepseekcontinuation.ui

import android.app.Application
import android.graphics.Bitmap
import android.webkit.WebView
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.banzhan.deepseekcontinuation.core.Archive
import app.banzhan.deepseekcontinuation.core.ArchiveEntry
import app.banzhan.deepseekcontinuation.core.ArchiveLogic
import app.banzhan.deepseekcontinuation.core.EntryCategory
import app.banzhan.deepseekcontinuation.data.AppController
import app.banzhan.deepseekcontinuation.data.ChatContinuationDraft
import app.banzhan.deepseekcontinuation.data.ChatHandoff
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Actual navigation with automatic update checks disabled; anonymous local data only, no model calls. */
@RunWith(AndroidJUnit4::class)
class UnifiedAppUiTest {
    @get:Rule val compose = createComposeRule()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val application = instrumentation.targetContext.applicationContext as Application

    @Test fun oldWebViewFallbackKeepsMemorySettingsAndImportReachableWithoutLogin() {
        // Modern chat navigation lives in the trusted web page, not in Compose tabs.
        val webViewMajor = WebView.getCurrentWebViewPackage()?.versionName?.substringBefore('.')?.toIntOrNull() ?: 0
        assumeTrue("This test covers the native old-WebView fallback only", webViewMajor in 1..104)
        val store = ViewModelStore()
        val databaseName = "unified-navigation-${UUID.randomUUID()}.db"
        try {
            lateinit var controller: AppController
            instrumentation.runOnMainSync {
                controller = AppController(application, databaseName)
                store.put("controller", controller)
            }
            compose.setContent {
                val focus = LocalFocusManager.current
                val keyboard = LocalSoftwareKeyboardController.current
                LaunchedEffect(Unit) {
                    focus.clearFocus(force = true)
                    keyboard?.hide()
                }
                ContinuationApp(controller, automaticUpdateChecks = false)
            }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("查看本机记忆").fetchSemanticsNodes().isNotEmpty()
            }
            tab("聊天").assertDoesNotExist()
            screenshot("unified-chat-entry.png")
            compose.onNodeWithText("查看本机记忆").performClick()
            tab("记忆").assertIsSelected()
            screenshot("unified-memory.png")
            compose.onNodeWithContentDescription("导入与资料").assertIsDisplayed().performClick()
            compose.onNodeWithText("导入分享链接").performScrollTo().assertIsDisplayed()
            screenshot("unified-import-tools.png")
            tab("设置").performClick()
            compose.onNodeWithText("本机设置").assertIsDisplayed()
            compose.onNodeWithText("本机记忆资料").performClick()
            compose.onNodeWithText("导出备份").assertIsDisplayed()
            compose.onNodeWithContentDescription("返回").performClick()
            compose.onNodeWithText("关于与反馈").performClick()
            compose.onNode(hasScrollAction()).performScrollToNode(hasText("意见反馈"))
            compose.onNodeWithText("意见反馈").performClick()
            compose.onNodeWithText("意见信箱").assertIsDisplayed()
            compose.onNodeWithContentDescription("返回").performClick()
            compose.onNodeWithText("关于该软件").assertIsDisplayed()
            compose.onNodeWithContentDescription("返回").performClick()
            compose.onNodeWithText("开发者选项").assertDoesNotExist()
            screenshot("unified-settings.png")
            compose.onNodeWithContentDescription("返回").performClick()
            compose.onNodeWithText("更新系统 WebView 后开始聊天").assertIsDisplayed()
            tab("聊天").assertDoesNotExist()
        } catch (failure: Throwable) {
            runCatching { screenshot("unified-navigation-failed.png") }
            runCatching {
                val directory = File(application.filesDir, "unified-qa").apply { mkdirs() }
                File(directory, "unified-navigation-semantics.txt").writeText(
                    compose.onRoot(useUnmergedTree = true).printToString(maxDepth = 30))
            }
            throw failure
        } finally {
            instrumentation.runOnMainSync { store.clear() }
            application.deleteDatabase(databaseName)
        }
    }

    @Test fun continueHereHandsOffTheExactPreviewWithoutCallingExternalActions() {
        val archive = Archive("synthetic-unified-memory", "合成 · 再次相遇", emptyList(), listOf(
            ArchiveEntry("entry", EntryCategory.RECENT, "我们说好，等有空再一起去海边。", edited = true),
        ), updatedAt = 1, generationMode = "summary")
        val continued = AtomicReference<String?>(null)
        val external = AtomicReference<String?>(null)
        compose.setContent {
            ContinuationTheme {
                ContinuationResultScreen(archive, null, emptyList(), {}, external::set, {}, {}, {}, {},
                    onContinueHere = continued::set)
            }
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("在这里继续聊").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("在这里继续聊").assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals(ArchiveLogic.continuationExport(archive, emptyList()).text, continued.get())
            assertNull(external.get())
        }
        screenshot("unified-memory-handoff.png")
    }

    @Test fun pendingHandoffSurvivesUntilMatchingDurableAcknowledgement() {
        check(ChatHandoff.pending(application) == null) { "Use an isolated QA installation without a real pending handoff." }
        val draft = ChatContinuationDraft(title = "合成记忆", text = "我们保留原来的语气。", sourceArchiveId = "synthetic-archive")
        try {
            ChatHandoff.save(application, draft)
            assertEquals(draft, ChatHandoff.pending(application))
            ChatHandoff.acknowledge(application, "unrelated-id")
            assertEquals(draft, ChatHandoff.pending(application))
            ChatHandoff.acknowledge(application, draft.id)
            assertNull(ChatHandoff.pending(application))
        } finally { ChatHandoff.acknowledge(application, draft.id) }
    }

    @Test fun bridgeOriginAcceptsOnlyTheTrustedMainDocument() {
        assertTrue(trustedChatPage("https://digimonlegend.com/deepseek/"))
        assertTrue(trustedChatPage("https://digimonlegend.com/deepseek/#settings/data"))
        listOf("http://digimonlegend.com/deepseek/", "https://digimonlegend.com.evil.test/deepseek/",
            "https://user@digimonlegend.com/deepseek/", "https://digimonlegend.com:444/deepseek/",
            "https://digimonlegend.com/deepseek/other", "https://digimonlegend.com/deepseek-api/chat/login")
            .forEach { assertFalse(it, trustedChatPage(it)) }
    }

    private fun tab(label: String) = compose.onNode(hasText(label) and hasClickAction())

    private fun screenshot(name: String) {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        // SurfaceFlinger can still hold the previous frame after Compose semantics settle.
        android.os.SystemClock.sleep(150)
        val bitmap = instrumentation.uiAutomation.takeScreenshot() ?: error("Screenshot unavailable")
        val directory = File(application.filesDir, "unified-qa").apply { mkdirs() }
        try { File(directory, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) } }
        finally { bitmap.recycle() }
    }
}
