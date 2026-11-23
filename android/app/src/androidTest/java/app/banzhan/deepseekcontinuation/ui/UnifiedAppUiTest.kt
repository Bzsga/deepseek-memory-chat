package app.banzhan.deepseekcontinuation.ui

import android.app.Application
import android.content.ActivityNotFoundException
import android.content.ContextWrapper
import android.content.Intent
import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
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
import app.banzhan.deepseekcontinuation.data.ChatWebViewProvider
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
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
        val provider = ChatWebViewProvider.read(application)
        assumeTrue("This test covers the native old-WebView fallback only",
            provider.majorVersion != null && !provider.isCompatible)
        val rechecks = AtomicInteger()
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
                ContinuationApp(
                    controller,
                    automaticUpdateChecks = false,
                    webViewProvider = provider,
                    onRecheckWebView = { rechecks.incrementAndGet() },
                )
            }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithText("查看本机记忆").fetchSemanticsNodes().isNotEmpty()
            }
            tab("聊天").assertDoesNotExist()
            compose.onNodeWithText("当前版本 ${provider.versionName}", substring = true).assertIsDisplayed()
            compose.onNodeWithTag("webview-recovery-update").assertIsDisplayed()
            compose.onNodeWithTag("webview-recovery-browser").assertIsDisplayed()
            screenshot("unified-chat-entry.png")
            compose.onNodeWithTag("webview-recovery-recheck").performScrollTo().performClick()
            compose.onNodeWithText("当前 WebView 仍需更新。").assertIsDisplayed()
            compose.runOnIdle { assertEquals(1, rechecks.get()) }
            compose.onNodeWithText("查看本机记忆").performScrollTo().performClick()
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
            compose.onNodeWithText("版本与更新").performClick()
            compose.onNode(hasScrollAction()).performScrollToNode(hasText("意见反馈"))
            compose.onNodeWithText("意见反馈").performClick()
            compose.onNodeWithText("意见信箱").assertIsDisplayed()
            compose.onNodeWithContentDescription("返回").performClick()
            compose.onNodeWithText("版本与更新").assertIsDisplayed()
            compose.onNodeWithContentDescription("返回").performClick()
            compose.onNodeWithText("开发者选项").assertDoesNotExist()
            screenshot("unified-settings.png")
            compose.onNodeWithContentDescription("返回").performClick()
            compose.onNodeWithText("应用内聊天需要更新 WebView").assertIsDisplayed()
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

    @Test fun oldGoogleWebViewShowsThePublicBrowserBeforeItsPlayListing() {
        val requests = mutableListOf<Intent>()
        val provider = ChatWebViewProvider("com.google.android.webview", "102.0.5005.125", "Android System WebView")
        compose.setContent {
            val base = LocalContext.current
            val context = remember(base) {
                object : ContextWrapper(base) {
                    override fun startActivity(intent: Intent) {
                        requests.add(intent)
                    }
                }
            }
            ContinuationTheme {
                CompositionLocalProvider(LocalContext provides context) {
                    WebViewRecoveryScreen(provider, onRecheck = {}, onMemories = {}, onSettings = {}, onDiagnostics = {})
                }
            }
        }
        compose.onNodeWithText("当前版本 81.0.4044.138 · 要求 83 或更高").assertIsDisplayed()
        val browser = compose.onNodeWithTag("webview-recovery-browser")
        val update = compose.onNodeWithTag("webview-recovery-update")
        assertTrue(browser.getBoundsInRoot().top < update.getBoundsInRoot().top)
        browser.performClick()
        update.performClick()
        compose.runOnIdle {
            assertEquals(2, requests.size)
            assertEquals(Intent.ACTION_VIEW, requests[0].action)
            assertEquals("https://digimonlegend.com/deepseek/", requests[0].dataString)
            assertEquals(Intent.ACTION_VIEW, requests[1].action)
            assertEquals("com.android.vending", requests[1].`package`)
            assertEquals("https://play.google.com/store/apps/details?id=com.google.android.webview", requests[1].dataString)
        }
    }

    @Test fun unavailablePlayStaysOnRecoveryPageAndShowsExplicitAlternatives() {
        val requests = mutableListOf<Intent>()
        val provider = ChatWebViewProvider("com.google.android.webview", "102.0.5005.125", "Android System WebView")
        compose.setContent {
            val base = LocalContext.current
            val context = remember(base) {
                object : ContextWrapper(base) {
                    override fun startActivity(intent: Intent) {
                        requests.add(intent)
                        if (intent.`package` == "com.android.vending") throw ActivityNotFoundException()
                    }
                }
            }
            ContinuationTheme {
                CompositionLocalProvider(LocalContext provides context) {
                    WebViewRecoveryScreen(provider, onRecheck = {}, onMemories = {}, onSettings = {}, onDiagnostics = {})
                }
            }
        }
        val browser = compose.onNodeWithTag("webview-recovery-browser")
        val update = compose.onNodeWithTag("webview-recovery-update")
        update.performClick()
        compose.onNodeWithText("无法打开 Google Play", substring = true).assertIsDisplayed()
        compose.onNodeWithText("软件更新", substring = true).assertIsDisplayed()
        update.assertTextEquals("打开系统设置")
        assertTrue(browser.getBoundsInRoot().top < update.getBoundsInRoot().top)
        compose.runOnIdle {
            assertEquals(1, requests.size)
            assertEquals("com.android.vending", requests.single().`package`)
        }
        browser.performClick()
        update.performClick()
        compose.runOnIdle {
            assertEquals(3, requests.size)
            assertEquals("https://digimonlegend.com/deepseek/", requests[1].dataString)
            assertEquals(Settings.ACTION_SETTINGS, requests[2].action)
        }
    }

    @Test fun startupPanelShowsLoadingAndOffersBrowserAndRecoveryAfterFailure() {
        val requests = mutableListOf<Intent>()
        val error = mutableStateOf<String?>(null)
        val retries = AtomicInteger()
        val diagnostics = AtomicInteger()
        compose.setContent {
            val base = LocalContext.current
            val context = remember(base) {
                object : ContextWrapper(base) {
                    override fun startActivity(intent: Intent) { requests.add(intent) }
                }
            }
            ContinuationTheme {
                CompositionLocalProvider(LocalContext provides context) {
                    ChatStartupPanel(error.value, { retries.incrementAndGet() }, {}, {}, { diagnostics.incrementAndGet() })
                }
            }
        }
        compose.onNodeWithText("正在打开聊天…").assertIsDisplayed()
        compose.onNodeWithTag("chat-startup-browser").assertDoesNotExist()
        compose.runOnIdle { error.value = "聊天页面迟迟没有响应。" }
        compose.onNodeWithText("聊天页面迟迟没有响应。").assertIsDisplayed()
        compose.onNodeWithTag("chat-startup-browser").assertIsDisplayed().performClick()
        compose.onNodeWithText("重新加载").performClick()
        compose.onNodeWithText("技术诊断").performClick()
        compose.runOnIdle {
            assertEquals("https://digimonlegend.com/deepseek/", requests.single().dataString)
            assertEquals(1, retries.get())
            assertEquals(1, diagnostics.get())
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
