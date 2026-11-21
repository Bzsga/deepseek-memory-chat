package app.banzhan.deepseekcontinuation.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import app.banzhan.deepseekcontinuation.BuildConfig
import app.banzhan.deepseekcontinuation.core.AppUpdateManifest
import app.banzhan.deepseekcontinuation.data.AppUpdateState
import app.banzhan.deepseekcontinuation.data.AppUpdateStatus
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class VersionUpdateUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun updateActionsAndNotesFitOnANarrowScreen() {
        val update = mutableStateOf(AppUpdateState())
        var checks = 0
        var downloads = 0
        var openedUrl: String? = null
        val uriHandler = object : UriHandler {
            override fun openUri(uri: String) { openedUrl = uri }
        }
        compose.setContent {
            MaterialTheme {
                CompositionLocalProvider(LocalUriHandler provides uriHandler) {
                    Box(Modifier.width(320.dp).fillMaxHeight()) {
                        AboutScreen(
                            updateState = update.value,
                            onCheckUpdates = { checks++ },
                            onDownloadUpdate = { downloads++ },
                            onFeedback = {},
                        )
                    }
                }
            }
        }
        compose.onNodeWithText("已安装版本").assertIsDisplayed()
        compose.onNodeWithText(BuildConfig.VERSION_NAME).assertIsDisplayed()
        compose.onNodeWithText("更新历史").assertIsDisplayed().performClick()
        compose.onNodeWithText("检查更新").assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals("https://digimonlegend.com/deepseek/changelog.html", openedUrl)
            assertEquals(1, checks)
            update.value = AppUpdateState(
                status = AppUpdateStatus.AVAILABLE,
                manifest = manifest(listOf("记忆整理直接使用当前聊天 API。")),
            )
        }
        compose.onNodeWithText("可更新至 9.9.0").assertIsDisplayed()
        compose.onNodeWithText("记忆整理直接使用当前聊天 API。").assertIsDisplayed()
        compose.onNodeWithText("下载更新").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(1, downloads) }
    }

    @Test fun bannerNotesOpenBeforeAndDuringDownload() {
        val notes = List(8) { "第 ${it + 1} 条：${"这是用于检查窄屏滚动的更新说明。".repeat(10)}" }
        val manifest = manifest(notes)
        val update = mutableStateOf(AppUpdateState(status = AppUpdateStatus.AVAILABLE, manifest = manifest))
        var downloads = 0
        var cancelled = 0
        var deferred = 0
        compose.setContent {
            MaterialTheme {
                Box(Modifier.width(320.dp)) {
                    AppUpdateBanner(
                        state = update.value,
                        onDownload = {
                            downloads++
                            update.value = update.value.copy(
                                status = AppUpdateStatus.DOWNLOADING,
                                downloadedBytes = manifest.apkSize / 4,
                                totalBytes = manifest.apkSize,
                            )
                        },
                        onCancelDownload = { cancelled++ },
                        onInstall = {},
                        onLater = { deferred++ },
                    )
                }
            }
        }

        compose.onNodeWithText("查看更新内容").assertIsDisplayed().performClick()
        compose.onNodeWithText("9.9.0 更新内容").assertIsDisplayed()
        compose.onNodeWithText(notes.first()).assertIsDisplayed()
        compose.onNodeWithText(notes.last()).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("关闭").assertIsDisplayed().performClick()
        compose.onNodeWithText("下载更新").assertIsDisplayed().performClick()

        compose.onNodeWithText("正在下载 25%", substring = true).assertIsDisplayed()
        compose.onNodeWithText("查看更新内容").assertIsDisplayed().performClick()
        compose.onNodeWithText("9.9.0 更新内容").assertIsDisplayed()
        compose.runOnIdle { update.value = update.value.copy(downloadedBytes = manifest.apkSize / 2) }
        compose.onNodeWithText("关闭").performClick()
        compose.onNodeWithText("正在下载 50%", substring = true).assertIsDisplayed()
        compose.onNodeWithText("取消更新").assertIsDisplayed()
        compose.onNodeWithText("收起").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(1, downloads)
            assertEquals(0, cancelled)
            assertEquals(0, deferred)
        }
    }

    private fun manifest(notes: List<String>) = AppUpdateManifest(
        schemaVersion = 1,
        packageName = BuildConfig.APPLICATION_ID,
        versionCode = 99,
        versionName = "9.9.0",
        apkUrl = "https://example.invalid/app.apk",
        apkSize = 14 * 1024 * 1024L,
        sha256 = "0".repeat(64),
        minSdk = 26,
        releasedAt = "2026-11-19T09:00:00Z",
        changelog = notes,
    )
}
