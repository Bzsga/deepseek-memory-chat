@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package app.banzhan.deepseekcontinuation.ui

import android.text.format.DateFormat
import android.text.format.Formatter
import android.widget.Toast
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SystemUpdate
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.banzhan.deepseekcontinuation.BuildConfig
import app.banzhan.deepseekcontinuation.core.AppUpdateManifest
import app.banzhan.deepseekcontinuation.data.AppUpdateState
import app.banzhan.deepseekcontinuation.data.AppUpdateStatus
import java.time.Instant
import java.util.Date

/** Compact actions for the foreground update prompt. */
@Composable
internal fun AppUpdateBanner(
    state: AppUpdateState,
    installBlockedReason: String? = null,
    installPermissionRequired: Boolean = false,
    onDownload: () -> Unit,
    onCancelDownload: () -> Unit,
    onInstall: () -> Unit,
    onLater: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val manifest = state.manifest ?: return
    var showNotes by rememberSaveable(manifest.versionCode) { mutableStateOf(false) }
    Surface(
        modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.primaryContainer,
        shape = MaterialTheme.shapes.medium,
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            UpdateSummary(manifest, showReleaseDate = false)
            UpdateFeedback(state)
            UpdateInstallGuidance(state, installBlockedReason, installPermissionRequired)
            ActionRow {
                UpdateActions(
                    state,
                    installBlockedReason,
                    installPermissionRequired,
                    onDownload,
                    onCancelDownload,
                    onInstall,
                )
                TextButton(onClick = onLater) {
                    Text(
                        if (
                            state.status in
                                setOf(AppUpdateStatus.DOWNLOADING, AppUpdateStatus.VERIFYING)
                        )
                            "收起"
                        else "稍后"
                    )
                }
                if (manifest.changelog.isNotEmpty()) {
                    TextButton(onClick = { showNotes = true }) { Text("查看更新内容") }
                }
            }
        }
    }
    if (showNotes && manifest.changelog.isNotEmpty()) {
        val closeNotes = { showNotes = false }
        AlertDialog(
            onDismissRequest = closeNotes,
            title = { Text("${manifest.versionName} 更新内容") },
            text = { UpdateNotes(manifest.changelog, Modifier.verticalScroll(rememberScrollState())) },
            confirmButton = { TextButton(onClick = closeNotes) { Text("关闭") } },
        )
    }
}

@Composable
internal fun AppUpdateCard(
    state: AppUpdateState,
    installBlockedReason: String? = null,
    installPermissionRequired: Boolean = false,
    onCheck: () -> Unit,
    onDownload: () -> Unit,
    onCancelDownload: () -> Unit,
    onInstall: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val uriHandler = LocalUriHandler.current
    val activeTransfer = state.status == AppUpdateStatus.DOWNLOADING || state.status == AppUpdateStatus.VERIFYING
    OutlinedCard(
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        colors = CardDefaults.outlinedCardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        "已安装版本",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        BuildConfig.VERSION_NAME,
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    OutlinedButton(
                        onClick = onCheck,
                        enabled = !state.checking && !activeTransfer,
                    ) {
                        Text(if (state.checking) "正在检查…" else "检查更新")
                    }
                    TextButton(onClick = {
                        try {
                            uriHandler.openUri("https://digimonlegend.com/deepseek/changelog.html")
                        } catch (_: IllegalArgumentException) {
                            Toast.makeText(context, "无法打开更新历史，请检查默认浏览器。", Toast.LENGTH_SHORT).show()
                        }
                    }) { Text("更新历史") }
                }
            }
            if (state.checking) LinearProgressIndicator(Modifier.fillMaxWidth())
            state.manifest?.let { manifest ->
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                UpdateSummary(manifest, showReleaseDate = true)
            }
            UpdateFeedback(state)
            UpdateInstallGuidance(state, installBlockedReason, installPermissionRequired)
            if (state.manifest != null) {
                UpdateActions(
                    state,
                    installBlockedReason,
                    installPermissionRequired,
                    onDownload,
                    onCancelDownload,
                    onInstall,
                )
                if (state.manifest.changelog.isNotEmpty()) {
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    UpdateNotes(state.manifest.changelog, heading = "本次更新")
                }
            }
        }
    }
}

@Composable
private fun UpdateSummary(manifest: AppUpdateManifest, showReleaseDate: Boolean) {
    val context = LocalContext.current
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceVariant) {
            Box(Modifier.size(42.dp), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.SystemUpdate, null, Modifier.size(23.dp), tint = MaterialTheme.colorScheme.primary)
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                "可更新至 ${manifest.versionName}",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            val size = Formatter.formatShortFileSize(context, manifest.apkSize)
            val releaseDate = if (showReleaseDate) {
                runCatching {
                    DateFormat.getDateFormat(context).format(Date.from(Instant.parse(manifest.releasedAt)))
                }.getOrNull()
            } else null
            Text(
                if (releaseDate == null) "安装包 $size" else "$releaseDate 发布 · 安装包 $size",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun UpdateNotes(notes: List<String>, modifier: Modifier = Modifier, heading: String? = null) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (heading != null) {
            Text(heading, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        }
        notes.forEach { note ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("•", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
                Text(
                    note,
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun UpdateFeedback(state: AppUpdateState) {
    val context = LocalContext.current
    when (state.status) {
        AppUpdateStatus.DOWNLOADING -> {
            val total = state.totalBytes.takeIf { it > 0 } ?: state.manifest?.apkSize ?: 0L
            if (total > 0) {
                val progress =
                    (state.downloadedBytes.toDouble() / total).coerceIn(0.0, 1.0).toFloat()
                LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                Text(
                    "正在下载 ${(progress * 100).toInt()}% · ${Formatter.formatShortFileSize(context, state.downloadedBytes)} / ${Formatter.formatShortFileSize(context, total)}",
                    style = MaterialTheme.typography.bodySmall,
                )
            } else {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text(
                    "正在下载 · ${Formatter.formatShortFileSize(context, state.downloadedBytes)}",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Text(
                state.message ?: "离开此页后，下载会在后台继续。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        AppUpdateStatus.VERIFYING -> {
            LinearProgressIndicator(Modifier.fillMaxWidth())
            Text("正在校验更新包…", style = MaterialTheme.typography.bodySmall)
        }
        AppUpdateStatus.READY -> Text("安装包已校验，安装时需在系统界面确认。", style = MaterialTheme.typography.bodySmall)
        else -> Unit
    }
    val error = state.error?.takeIf { it.isNotBlank() }
    val message = error ?: state.message?.takeIf { it.isNotBlank() && state.status != AppUpdateStatus.DOWNLOADING }
    if (message != null) {
        Text(
            message,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            color = if (error == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
private fun UpdateInstallGuidance(
    state: AppUpdateState,
    installBlockedReason: String?,
    installPermissionRequired: Boolean,
) {
    if (state.status != AppUpdateStatus.READY) return
    if (!installBlockedReason.isNullOrBlank()) {
        Text(
            installBlockedReason,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    } else if (installPermissionRequired) {
        Text(
            "请在系统设置中允许本应用安装更新包，返回后继续安装。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun UpdateActions(
    state: AppUpdateState,
    installBlockedReason: String?,
    installPermissionRequired: Boolean,
    onDownload: () -> Unit,
    onCancelDownload: () -> Unit,
    onInstall: () -> Unit,
) {
    when (state.status) {
        AppUpdateStatus.AVAILABLE,
        AppUpdateStatus.FAILED -> {
            if (state.manifest != null)
                Button(onClick = onDownload, enabled = !state.checking) {
                    Text(if (state.status == AppUpdateStatus.FAILED) "重试下载" else "下载更新")
                }
        }
        AppUpdateStatus.DOWNLOADING,
        AppUpdateStatus.VERIFYING -> OutlinedButton(onClick = onCancelDownload) { Text("取消更新") }
        AppUpdateStatus.READY ->
            Button(
                onClick = onInstall,
                enabled = !state.checking && installBlockedReason.isNullOrBlank(),
            ) {
                Text(if (installPermissionRequired) "允许安装更新" else "安装更新")
            }
        AppUpdateStatus.IDLE -> Unit
    }
}
