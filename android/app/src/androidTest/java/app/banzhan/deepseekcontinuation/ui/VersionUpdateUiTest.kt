package app.banzhan.deepseekcontinuation.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
        compose.setContent {
            MaterialTheme {
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
        compose.onNodeWithText("已安装版本").assertIsDisplayed()
        compose.onNodeWithText(BuildConfig.VERSION_NAME).assertIsDisplayed()
        compose.onNodeWithText("检查更新").assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals(1, checks)
            update.value = AppUpdateState(
                status = AppUpdateStatus.AVAILABLE,
                manifest = AppUpdateManifest(
                    schemaVersion = 1,
                    packageName = BuildConfig.APPLICATION_ID,
                    versionCode = 99,
                    versionName = "9.9.0",
                    apkUrl = "https://example.invalid/app.apk",
                    apkSize = 14 * 1024 * 1024L,
                    sha256 = "0".repeat(64),
                    minSdk = 26,
                    releasedAt = "2026-11-19T09:00:00Z",
                    changelog = listOf("记忆整理直接使用当前聊天 API。"),
                ),
            )
        }
        compose.onNodeWithText("可更新至 9.9.0").assertIsDisplayed()
        compose.onNodeWithText("记忆整理直接使用当前聊天 API。").assertIsDisplayed()
        compose.onNodeWithText("下载更新").assertIsDisplayed().performClick()
        compose.runOnIdle { assertEquals(1, downloads) }
    }
}
