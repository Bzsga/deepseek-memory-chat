@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package app.banzhan.deepseekcontinuation.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.banzhan.deepseekcontinuation.data.CHAT_PAGE
import app.banzhan.deepseekcontinuation.data.ChatWebViewProvider

@Composable
internal fun WebViewRecoveryScreen(
    provider: ChatWebViewProvider,
    onRecheck: () -> Unit,
    onMemories: () -> Unit,
    onSettings: () -> Unit,
    onDiagnostics: () -> Unit,
) {
    val context = LocalContext.current
    val packageName = provider.packageName
    val playPackage = provider.playUpdatePackage
    val label = provider.label?.takeIf { it.isNotBlank() } ?: packageName
    var playUnavailable by rememberSaveable(packageName, provider.versionName) { mutableStateOf(false) }
    val showPlayAction = playPackage != null && !playUnavailable
    var actionHint by remember(provider) { mutableStateOf<String?>(null) }

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            modifier = Modifier.widthIn(max = 520.dp).fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                if (packageName == null) "系统 WebView 暂不可用" else "应用内聊天需要更新 WebView",
                style = MaterialTheme.typography.titleLarge,
            )
            Surface(
                Modifier.fillMaxWidth(),
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surfaceVariant,
            ) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(label ?: "未检测到 WebView 组件", style = MaterialTheme.typography.titleSmall)
                    if (packageName != null && label != packageName) {
                        Text(packageName, style = MaterialTheme.typography.bodySmall)
                    }
                    Text(
                        "当前版本 ${provider.versionName ?: "未知"} · 要求 ${ChatWebViewProvider.MIN_VERSION} 或更高",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            Text(
                when {
                    showPlayAction -> "可先用浏览器继续聊天。若要恢复应用内聊天，请在 Google Play 更新组件，返回 App 后会自动检测。"
                    playUnavailable -> "无法打开 Google Play。可先用浏览器聊天，或在系统设置中搜索「软件更新」或「系统更新」。"
                    else -> "可先用浏览器聊天。若要更新组件，请在系统设置中搜索「软件更新」或「系统更新」。"
                },
                modifier = if (playUnavailable) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier,
                style = MaterialTheme.typography.bodyMedium,
            )
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                RecoveryAction("在浏览器继续聊天", "webview-recovery-browser", primary = true) {
                    actionHint = if (launchPublicChatInBrowser(context)) null else CHAT_BROWSER_UNAVAILABLE
                }
                Text(
                    "仅保存在 App 的聊天记录需回到 App 查看。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (showPlayAction) {
                    RecoveryAction("前往 Google Play", "webview-recovery-update", primary = false) {
                        actionHint = null
                        playUnavailable = !launchGooglePlay(context, playPackage)
                    }
                } else {
                    RecoveryAction("打开系统设置", "webview-recovery-update", primary = false) {
                        actionHint = if (launchSystemSettings(context)) null else "无法打开系统设置。请手动打开设置并检查系统更新。"
                    }
                }
            }
            actionHint?.let {
                Text(
                    it,
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            ActionRow {
                TextButton(
                    modifier = Modifier.testTag("webview-recovery-recheck"),
                    onClick = {
                        actionHint = if (packageName == null) "仍未检测到可用的 WebView。" else "当前 WebView 仍需更新。"
                        onRecheck()
                    },
                ) { Text("重新检测") }
                TextButton(onClick = onMemories) { Text("查看本机记忆") }
                TextButton(onClick = onSettings) { Text("本机设置") }
                TextButton(onClick = onDiagnostics) { Text("技术诊断") }
            }
        }
    }
}

@Composable
internal fun ChatStartupPanel(
    error: String?,
    onRetry: () -> Unit,
    onMemories: () -> Unit,
    onSettings: () -> Unit,
    onDiagnostics: () -> Unit,
) {
    val context = LocalContext.current
    var browserUnavailable by remember(error) { mutableStateOf(false) }
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 2.dp,
    ) {
        Box(contentAlignment = Alignment.TopCenter) {
            Column(
                modifier = Modifier.widthIn(max = 520.dp).fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (error == null) {
                    Text("正在打开聊天…", style = MaterialTheme.typography.bodyMedium)
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                } else {
                    Text("应用内聊天暂未打开", style = MaterialTheme.typography.titleMedium)
                    Text(
                        error,
                        Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    RecoveryAction("在浏览器继续聊天", "chat-startup-browser", primary = true) {
                        browserUnavailable = !launchPublicChatInBrowser(context)
                    }
                    if (browserUnavailable) {
                        Text(
                            CHAT_BROWSER_UNAVAILABLE,
                            Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    ActionRow {
                        TextButton(onClick = onRetry) { Text("重新加载") }
                        TextButton(onClick = onMemories) { Text("本机记忆") }
                        TextButton(onClick = onSettings) { Text("本机设置") }
                        TextButton(onClick = onDiagnostics) { Text("技术诊断") }
                    }
                }
            }
        }
    }
}

internal const val CHAT_BROWSER_UNAVAILABLE = "无法打开浏览器。请安装或启用浏览器后重试。"

internal fun launchPublicChatInBrowser(context: Context): Boolean = launchActivity(
    context,
    Intent(Intent.ACTION_VIEW, Uri.parse(CHAT_PAGE)).addCategory(Intent.CATEGORY_BROWSABLE),
)

@Composable
private fun RecoveryAction(label: String, tag: String, primary: Boolean, onClick: () -> Unit) {
    val modifier = Modifier.fillMaxWidth().testTag(tag)
    if (primary) {
        Button(onClick = onClick, modifier = modifier) { Text(label) }
    } else {
        OutlinedButton(onClick = onClick, modifier = modifier) { Text(label) }
    }
}

private fun launchGooglePlay(context: Context, packageName: String): Boolean {
    val page = Uri.parse("https://play.google.com/store/apps/details").buildUpon()
        .appendQueryParameter("id", packageName)
        .build()
    return launchActivity(context, Intent(Intent.ACTION_VIEW, page).setPackage("com.android.vending"))
}

@Suppress("DEPRECATION")
private fun launchSystemSettings(context: Context): Boolean {
    val intent = Intent(Settings.ACTION_SETTINGS)
    val settings = try {
        context.packageManager.queryIntentActivities(
            intent, PackageManager.MATCH_DEFAULT_ONLY or PackageManager.MATCH_SYSTEM_ONLY,
        ).firstOrNull()?.activityInfo
    } catch (_: SecurityException) {
        null
    }
    if (settings != null) {
        intent.setClassName(settings.packageName, settings.name)
    } else {
        intent.setPackage("com.android.settings")
    }
    return launchActivity(context, intent)
}

private fun launchActivity(context: Context, intent: Intent): Boolean = try {
    context.startActivity(intent)
    true
} catch (_: ActivityNotFoundException) {
    false
} catch (_: SecurityException) {
    false
}
