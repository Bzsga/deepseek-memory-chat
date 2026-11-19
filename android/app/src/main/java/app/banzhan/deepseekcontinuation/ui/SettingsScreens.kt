@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package app.banzhan.deepseekcontinuation.ui

import android.widget.Toast
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.banzhan.deepseekcontinuation.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

@Composable
internal fun MemoryDataSettings(
    busy: Boolean,
    run: (suspend () -> Unit) -> Unit,
    onBackup: () -> Unit,
    onRestore: () -> Unit,
    onClearLocalData: suspend () -> Unit,
) {
    var clearConfirmation by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("备份包含导入的原文、记忆档案与整理进度。", style = MaterialTheme.typography.bodyMedium)
        ActionRow {
            OutlinedButton(onClick = onBackup, enabled = !busy) { Text("导出备份") }
            OutlinedButton(onClick = onRestore, enabled = !busy) { Text("恢复备份") }
        }
        HorizontalDivider()
        TextButton(onClick = { clearConfirmation = true }, enabled = !busy) {
            Text("清除本机记忆资料", color = MaterialTheme.colorScheme.error)
        }
    }
    if (clearConfirmation)
        AlertDialog(
            onDismissRequest = { clearConfirmation = false },
            title = { Text("清除本地资料？") },
            text = { Text("将清除导入的对话原件、记忆档案、历史版本、整理任务和缓存、检查副本与粘贴草稿。请先备份需要保存的资料。聊天及图片请在聊天设置的「数据管理」中清除。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        run {
                            onClearLocalData()
                            clearConfirmation = false
                        }
                    }
                ) {
                    Text("确认清除", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { clearConfirmation = false }) { Text("取消") } },
        )
}

@Composable
internal fun LocalSettingsIndex(
    state: AppState,
    onAccount: () -> Unit,
    onOpen: (NativeSettingsSection) -> Unit,
) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { AccountSummaryCard(state, onAccount) }
        items(listOf(NativeSettingsSection.DATA to "本机记忆资料",
            NativeSettingsSection.ABOUT to "版本与更新", NativeSettingsSection.DEVELOPER to "开发者选项")
            .filter { (section, _) -> section != NativeSettingsSection.DEVELOPER || state.developerPrefs.sessionToken.isNotEmpty() }) { (section, label) ->
            OutlinedButton(onClick = { onOpen(section) }, modifier = Modifier.fillMaxWidth()) { Text(label) }
        }
    }
}

@Composable
private fun AccountSummaryCard(state: AppState, onAccount: () -> Unit) {
    val user = state.account.currentUser
    Card(onClick = onAccount,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Row(Modifier.fillMaxWidth().padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.AccountCircle, null, tint = Blue)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(user?.username ?: "登录 / 注册", fontWeight = FontWeight.SemiBold)
                Text(
                    if (user == null) "登录账号，或注册新账号"
                    else if (!user.managedEligible) "使用个人 API"
                    else state.quota?.userWeeklyRemaining?.let { "本周还可用 $it 次" }
                        ?: "管理账户与个人免费次数",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Icon(Icons.Outlined.ChevronRight, "打开账户")
        }
    }
}

@Composable
internal fun TasksScreen(
    tasks: List<OrganizationTask>,
    controller: AppController,
    run: (suspend () -> Unit) -> Unit,
    onAccount: () -> Unit = {},
    onArchive: (String) -> Unit,
) {
    val currentState by controller.state.collectAsState()
    var resume by remember { mutableStateOf<OrganizationTask?>(null) }
    var cancel by remember { mutableStateOf<OrganizationTask?>(null) }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item { SectionTitle("整理任务", "每个完成的分块都会保存。暂停后可从进度继续。") }
        if (tasks.isEmpty()) item { NoticeCard("还没有整理任务。在对话范围选择页点击「AI 整理」即可开始。") }
        items(tasks, key = { it.id }) { task ->
            val needsLogin = task.serviceMode == "companion" && currentState.account.currentUser == null
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
            ) {
                Column(
                    Modifier.fillMaxWidth().padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(task.label, fontWeight = FontWeight.SemiBold)
                    Text(
                        task.provider,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    LinearProgressIndicator(
                        progress = { if (task.total > 0) task.done.toFloat() / task.total else 0f },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        "${taskStatus(task.status)} · ${task.done} / ${task.total} 分块",
                        style = MaterialTheme.typography.labelLarge,
                        color = Blue,
                    )
                    if (task.message.isNotBlank())
                        Text(task.message, style = MaterialTheme.typography.bodySmall)
                    ActionRow {
                        if (task.status in setOf("queued", "running"))
                            TextButton(onClick = { run { controller.pauseTask(task.id) } }) {
                                Text("暂停")
                            }
                        if (task.status in setOf("paused", "cancelled", "failed", "uncertain"))
                            TextButton(
                                onClick = {
                                    if (needsLogin) onAccount()
                                    else if (task.uncertain) resume = task
                                    else run { controller.resumeTask(task.id, false) }
                                }
                            ) {
                                Text(if (needsLogin) "登录后继续整理" else "继续")
                            }
                        if (task.status !in setOf("completed", "cancelled"))
                            TextButton(onClick = { cancel = task }) { Text("取消任务") }
                        TextButton(onClick = { onArchive(task.archiveId) }) { Text("查看档案") }
                    }
                }
            }
        }
    }
    resume?.let { task ->
        val needsLogin = task.serviceMode == "companion" && currentState.account.currentUser == null
        AlertDialog(
            onDismissRequest = { resume = null },
            title = { Text("确认继续整理") },
            text = { Text(task.requestUncertaintyText() + "\n\n${task.provider}") },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (needsLogin) {
                            resume = null
                            onAccount()
                        } else run {
                            controller.resumeTask(task.id, true)
                            resume = null
                        }
                    }
                ) {
                    Text(if (needsLogin) "登录后继续整理" else if (task.serviceMode == "companion") "确认消耗次数并继续" else "确认可能的额外费用并继续")
                }
            },
            dismissButton = { TextButton(onClick = { resume = null }) { Text("暂不继续") } },
        )
    }
    cancel?.let { task ->
        AlertDialog(
            onDismissRequest = { cancel = null },
            title = { Text("取消整理任务？") },
            text = { Text(task.cancelRequestText()) },
            confirmButton = {
                TextButton(
                    onClick = {
                        run {
                            controller.cancelTask(task.id)
                            cancel = null
                        }
                    }
                ) {
                    Text("取消任务")
                }
            },
            dismissButton = { TextButton(onClick = { cancel = null }) { Text("返回") } },
        )
    }
}

private fun taskStatus(value: String) =
    when (value) {
        "queued" -> "等待中"
        "running" -> "整理中"
        "paused" -> "已暂停"
        "completed" -> "已完成"
        "cancelled" -> "已取消"
        "uncertain" -> "结果待确认"
        else -> "需要处理"
    }

private data class LicenseItem(
    val name: String,
    val version: String,
    val author: String,
    val url: String,
    val license: String,
    val textAsset: String,
)

@Composable
internal fun AboutScreen(
    updateState: AppUpdateState = AppUpdateState(),
    installBlockedReason: String? = null,
    installPermissionRequired: Boolean = false,
    onCheckUpdates: () -> Unit = {},
    onDownloadUpdate: () -> Unit = {},
    onCancelUpdate: () -> Unit = {},
    onInstallUpdate: () -> Unit = {},
    onFeedback: () -> Unit,
) {
    val context = LocalContext.current
    val uriHandler = LocalUriHandler.current
    var licenses by remember { mutableStateOf<List<LicenseItem>>(emptyList()) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<LicenseItem?>(null) }
    var licenseText by remember { mutableStateOf("") }
    LaunchedEffect(Unit) {
        runCatching {
                withContext(Dispatchers.IO) {
                    val json =
                        context.assets.open("licenses/index.json").bufferedReader().use {
                            it.readText()
                        }
                    Json.parseToJsonElement(json).jsonObject["components"]!!.jsonArray.map { value
                        ->
                        val row = value.jsonObject
                        fun field(name: String) = row[name]?.jsonPrimitive?.content.orEmpty()
                        LicenseItem(
                            field("name"),
                            field("version"),
                            field("author"),
                            field("url"),
                            field("license"),
                            field("textAsset"),
                        )
                    }
                }
            }
            .onSuccess { licenses = it }
            .onFailure { loadError = "开源清单暂时无法读取。${it.message.orEmpty()}" }
    }
    LaunchedEffect(selected) {
        licenseText = ""
        selected?.let { item ->
            licenseText =
                withContext(Dispatchers.IO) {
                    runCatching {
                            context.assets.open(item.textAsset).bufferedReader().use {
                                it.readText()
                            }
                        }
                        .getOrElse { "许可证正文读取失败。${it.message.orEmpty()}" }
                }
        }
    }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            AppUpdateCard(
                state = updateState,
                installBlockedReason = installBlockedReason,
                installPermissionRequired = installPermissionRequired,
                onCheck = onCheckUpdates,
                onDownload = onDownloadUpdate,
                onCancelDownload = onCancelUpdate,
                onInstall = onInstallUpdate,
            )
        }
        item {
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 4.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Whale(Modifier.width(66.dp).height(50.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text("DeepSeek 记忆聊天", style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold)
                        Text("基于 DeepSeek chat-demo 的独立开源应用", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Text("导入聊天记录、整理本机记忆，也可从分享链接继续对话。",
                    style = MaterialTheme.typography.bodyMedium)
                Text("作者：半盏丶时光 · 由GPT-6制作", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("作者 QQ：1076755135", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                ActionRow {
                    OutlinedButton(onClick = {
                        try {
                            uriHandler.openUri("https://github.com/Bzsga/deepseek-memory-chat")
                        } catch (_: IllegalArgumentException) {
                            Toast.makeText(context, "无法打开 GitHub，请检查默认浏览器。", Toast.LENGTH_SHORT).show()
                        }
                    }) { Text("GitHub 源码") }
                    TextButton(onClick = onFeedback) { Text("意见反馈") }
                }
            }
        }
        item { SectionTitle("第三方许可证", "点按组件可离线查看许可证全文。") }
        loadError?.let { item { NoticeCard(it) } }
        items(licenses, key = { it.name + it.version }) { item ->
            Card(
                onClick = { selected = item },
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Column(
                    Modifier.fillMaxWidth().padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Text("${item.name} ${item.version}", fontWeight = FontWeight.SemiBold)
                    Text(item.author, style = MaterialTheme.typography.bodySmall)
                    Text(item.license, style = MaterialTheme.typography.labelMedium, color = Blue)
                }
            }
        }
    }
    selected?.let { item ->
        AppDialog(
            item.name,
            { selected = null },
            actions = { TextButton(onClick = { selected = null }) { Text("关闭") } },
        ) {
            Text(item.url, style = MaterialTheme.typography.bodySmall, color = Blue)
            SelectionContainer {
                Text(licenseText.ifBlank { "读取许可证……" }, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
