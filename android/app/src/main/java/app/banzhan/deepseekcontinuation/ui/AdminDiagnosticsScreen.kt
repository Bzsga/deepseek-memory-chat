@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@file:Suppress("DEPRECATION")

package app.banzhan.deepseekcontinuation.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticDetail
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticEvent
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticGroup
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticResolution
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticsPage
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticsRange
import app.banzhan.deepseekcontinuation.data.AdminDiagnosticsStatus
import app.banzhan.deepseekcontinuation.data.AppController
import app.banzhan.deepseekcontinuation.data.AppState
import app.banzhan.deepseekcontinuation.data.ChatWebViewProvider
import app.banzhan.deepseekcontinuation.data.SummaryFailure
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

private val diagnosticIdPattern = Regex("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
private val diagnosticTimeFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss", Locale.CHINA)
    .withZone(ZoneId.of("Asia/Shanghai"))

@Composable
internal fun AdminDiagnosticsScreen(
    state: AppState,
    controller: AppController,
    run: (suspend () -> Unit) -> Unit,
) {
    val access = state.developerPrefs
    key(access) {
        AdminDiagnosticsContent(
            page = state.adminDiagnostics,
            loading = state.adminDiagnosticsLoading,
            error = state.adminDiagnosticsError,
            detail = state.adminDiagnosticDetail,
            detailLoading = state.adminDiagnosticDetailLoading,
            detailError = state.adminDiagnosticDetailError,
            onRefresh = { range, status -> run { controller.refreshAdminDiagnostics(range, status, access) } },
            onLookup = { id -> run { controller.loadAdminDiagnostic(id, access) } },
            onCloseDetail = controller::clearAdminDiagnostic,
            onResolve = { change -> controller.setAdminDiagnosticResolution(access, change) },
        )
    }
}

@Composable
internal fun AdminDiagnosticsContent(
    page: AdminDiagnosticsPage?,
    loading: Boolean,
    error: String?,
    detail: AdminDiagnosticDetail?,
    detailLoading: Boolean,
    detailError: String?,
    onRefresh: (AdminDiagnosticsRange, AdminDiagnosticsStatus) -> Unit,
    onLookup: (String) -> Unit,
    onCloseDetail: () -> Unit,
    onResolve: suspend (AdminDiagnosticResolution) -> Int = { error("诊断状态更新不可用。") },
) {
    var range by rememberSaveable { mutableStateOf(AdminDiagnosticsRange.LAST_24_HOURS) }
    var status by rememberSaveable { mutableStateOf(AdminDiagnosticsStatus.PENDING) }
    var input by rememberSaveable { mutableStateOf("") }
    var inputError by remember { mutableStateOf(false) }
    var selectedId by remember { mutableStateOf<String?>(null) }
    var selectedGroup by remember { mutableStateOf<Pair<AdminDiagnosticGroup, Long>?>(null) }
    var confirmation by remember(selectedId) { mutableStateOf<AdminDiagnosticResolution?>(null) }
    var saving by remember(selectedId) { mutableStateOf(false) }
    var resolutionError by remember(selectedId) { mutableStateOf<String?>(null) }
    var resolutionNotice by remember(range, status) { mutableStateOf<String?>(null) }
    val focus = LocalFocusManager.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    val current = page?.takeIf { it.range == range && it.status == status }

    LaunchedEffect(range, status) { onRefresh(range, status) }
    LaunchedEffect(page?.status, page?.supportsResolution) {
        if (page?.status == AdminDiagnosticsStatus.RESOLVED && !page.supportsResolution) {
            status = AdminDiagnosticsStatus.PENDING
        }
    }

    fun openDetail(id: String, group: Pair<AdminDiagnosticGroup, Long>? = null) {
        focus.clearFocus()
        selectedId = id
        selectedGroup = group
        onLookup(id)
    }

    fun closeDetail() {
        selectedId = null
        selectedGroup = null
        onCloseDetail()
    }

    fun saveResolution(change: AdminDiagnosticResolution) {
        if (saving) return
        saving = true
        confirmation = null
        resolutionError = null
        scope.launch {
            try {
                val updated = onResolve(change)
                resolutionNotice = when {
                    updated == 0 -> "记录已处于所选状态。"
                    change.resolved -> "已将 $updated 条记录标为已解决。"
                    else -> "已将 $updated 条记录移回待处理。"
                }
                closeDetail()
                onRefresh(range, status)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                resolutionError = if (error is SummaryFailure && error.ambiguous) {
                    onRefresh(range, status)
                    onLookup(change.eventId)
                    "尚无法确认更新结果，正在重新读取诊断。"
                } else error.message ?: "更新诊断状态失败，请重试。"
            } finally {
                saving = false
            }
        }
    }

    fun search() {
        val id = input.trim().lowercase(Locale.ROOT)
        inputError = !diagnosticIdPattern.matches(id)
        if (!inputError) openDetail(id)
    }

    Box(Modifier.fillMaxSize().imePadding(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 780.dp).fillMaxSize()) {
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = input,
                        onValueChange = {
                            input = it.take(80)
                            inputError = false
                        },
                        modifier = Modifier.weight(1f).testTag("admin-diagnostics-search"),
                        label = { Text("诊断编号") },
                        trailingIcon = {
                            IconButton(onClick = {
                                clipboard.getText()?.text?.trim()?.takeIf { it.isNotEmpty() }?.let {
                                    input = it.take(80)
                                    inputError = false
                                }
                            }) {
                                Icon(Icons.Outlined.ContentPaste, contentDescription = "粘贴诊断编号")
                            }
                        },
                        singleLine = true,
                        isError = inputError,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Search),
                        keyboardActions = KeyboardActions(onSearch = { search() }),
                    )
                    TextButton(
                        onClick = ::search,
                        enabled = input.isNotBlank(),
                        modifier = Modifier.testTag("admin-diagnostics-search-submit"),
                    ) { Text("查找") }
                }
                if (inputError) {
                    Text(
                        "请输入完整的诊断编号。",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                if (page?.supportsResolution == true) ActionRow {
                    AdminDiagnosticsStatus.entries.forEach { value ->
                        FilterChip(
                            selected = status == value,
                            onClick = { status = value },
                            label = { Text(value.diagnosticStatusLabel()) },
                            modifier = Modifier.testTag("admin-diagnostics-status:${value.name}"),
                        )
                    }
                }
                ActionRow {
                    AdminDiagnosticsRange.entries.forEach { value ->
                        FilterChip(
                            selected = range == value,
                            onClick = { range = value },
                            label = { Text(value.diagnosticRangeLabel()) },
                            modifier = Modifier.testTag("admin-diagnostics-range:${value.name}"),
                        )
                    }
                    TextButton(onClick = { onRefresh(range, status) }, enabled = !loading) { Text("刷新") }
                }
            }
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            LazyColumn(
                Modifier.fillMaxWidth().weight(1f).testTag("admin-diagnostics-groups"),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                resolutionNotice?.let { message -> item { NoticeCard(message) } }
                error?.let { message ->
                    item { NoticeCard(if (current == null) message else "$message\n显示上次读取的结果。") }
                }
                if (current != null) {
                    item {
                        Text(
                            "显示 ${current.groups.size} 组 · 保留 ${current.retentionDays} 天 · 北京时间",
                            modifier = Modifier.padding(vertical = 4.dp),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (current.groups.isEmpty() && !loading) item {
                        NoticeCard(when {
                            !current.supportsResolution -> "这个时间范围内暂无故障报告。"
                            status == AdminDiagnosticsStatus.RESOLVED -> "这个时间范围内暂无已解决记录。"
                            else -> "这个时间范围内暂无待处理记录。"
                        })
                    }
                    items(current.groups, key = { it.latestEventId }) { group ->
                        DiagnosticGroupCard(group) { openDetail(group.latestEventId, group to current.since) }
                    }
                }
            }
        }
    }

    selectedId?.let { id ->
        val selectedDetail = detail?.takeIf { it.event == null || it.event.eventId == id }
        val event = selectedDetail?.event
        val groupSnapshot = selectedGroup
        val group = groupSnapshot?.first
        val change = confirmation
        val canResolve = selectedDetail?.supportsResolution == true && event != null
        val resolved = event?.resolvedAt != null
        if (change != null) {
            AlertDialog(
                onDismissRequest = { confirmation = null },
                title = { Text(if (change.resolved) "整组标为已解决" else "整组移回待处理") },
                text = {
                    Text("只处理打开这组时显示的 ${range.diagnosticRangeLabel()}内记录。之后上报的故障仍可单独处理。")
                },
                confirmButton = {
                    TextButton(onClick = { saveResolution(change) },
                        modifier = Modifier.testTag("admin-diagnostics-confirm-group")) { Text("确认") }
                },
                dismissButton = { TextButton(onClick = { confirmation = null }) { Text("取消") } },
            )
        } else {
            DiagnosticDetailsDialog(
                event,
                selectedDetail?.relatedEvents.orEmpty(),
                group,
                detailLoading || (selectedDetail == null && detailError == null),
                detailError,
                saving = saving,
                resolutionError = resolutionError,
                onResolve = if (canResolve) ({ saveResolution(AdminDiagnosticResolution(id, !resolved)) }) else null,
                onResolveGroup = if (canResolve && groupSnapshot != null && groupSnapshot.first.count > 1 &&
                    (status == AdminDiagnosticsStatus.RESOLVED) == resolved) ({
                    confirmation = AdminDiagnosticResolution(id, !resolved, groupSnapshot.second)
                }) else null,
                onDismiss = { if (!saving) closeDetail() },
                onRetry = { onLookup(id) },
                onRelated = { openDetail(it) },
            )
        }
    }
}

@Composable
private fun DiagnosticGroupCard(group: AdminDiagnosticGroup, onOpen: () -> Unit) {
    Surface(
        onClick = onOpen,
        modifier = Modifier.fillMaxWidth().testTag("admin-diagnostics-group:${group.latestEventId}"),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    diagnosticTitle(group.area, group.code),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                DiagnosticSupportingText(diagnosticOrigin(group.source, group.stage))
                DiagnosticSupportingText("最近发生 · ${diagnosticTime(group.lastAt)}")
                if (group.lastAt != group.lastReceivedAt) {
                    DiagnosticSupportingText("最近收到 · ${diagnosticTime(group.lastReceivedAt)}")
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("${group.count} 次", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
                Icon(
                    Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun DiagnosticDetailsDialog(
    event: AdminDiagnosticEvent?,
    related: List<AdminDiagnosticEvent>,
    group: AdminDiagnosticGroup?,
    loading: Boolean,
    error: String?,
    saving: Boolean,
    resolutionError: String?,
    onResolve: (() -> Unit)?,
    onResolveGroup: (() -> Unit)?,
    onDismiss: () -> Unit,
    onRetry: () -> Unit,
    onRelated: (String) -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(event?.eventId) { mutableStateOf(false) }
    AlertDialog(
        modifier = Modifier.testTag("admin-diagnostics-detail"),
        onDismissRequest = onDismiss,
        title = { Text("故障详情") },
        text = {
            Column(
                Modifier.fillMaxWidth().heightIn(max = 440.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (loading || saving) LinearProgressIndicator(Modifier.fillMaxWidth())
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = onRetry, enabled = !loading && !saving) { Text("重试") }
                }
                resolutionError?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                if (event == null && !loading && error == null) {
                    Text("未找到该诊断记录。请核对编号，或确认记录是否已超过保留期限。")
                }
                if (onResolve != null) ActionRow {
                    val resolved = event?.resolvedAt != null
                    TextButton(onClick = onResolve, enabled = !loading && !saving,
                        modifier = Modifier.testTag("admin-diagnostics-resolve-single")) {
                        Text(if (resolved) "移回待处理" else "标为已解决")
                    }
                    if (onResolveGroup != null) {
                        TextButton(onClick = onResolveGroup, enabled = !loading && !saving,
                            modifier = Modifier.testTag("admin-diagnostics-resolve-group")) {
                            Text(if (resolved) "整组移回待处理" else "整组标为已解决")
                        }
                    }
                }
                if (event != null) {
                    val outdatedWebView = event.outdatedWebViewDescription()
                    SelectionContainer {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                diagnosticTitle(event.area, if (outdatedWebView != null) "update_required" else event.code),
                                style = MaterialTheme.typography.titleMedium,
                            )
                            if (outdatedWebView != null) {
                                DiagnosticSupportingText(outdatedWebView)
                            }
                            DiagnosticField("标为已解决时间（北京时间）", event.resolvedAt?.let(::diagnosticTime))
                            DiagnosticField("来源与阶段", diagnosticOrigin(event.source, event.stage))
                            DiagnosticField("失败环节", technicalDetailLabel(event.detail))
                            DiagnosticField("服务类型", technicalServiceLabel(event.serviceMode))
                            DiagnosticField("导入文件类型与大小", technicalInputLabel(event.inputFormat, event.inputSizeBand))
                            DiagnosticField("诊断编号", event.eventId)
                            DiagnosticField("发生时间（北京时间）", diagnosticTime(event.occurredAt))
                            DiagnosticField("收到时间（北京时间）", diagnosticTime(event.receivedAt))
                            DiagnosticField("版本", event.release)
                            DiagnosticField("设备", listOfNotNull(event.manufacturer, event.model).joinToString(" "))
                            DiagnosticField("Android SDK", event.androidSdk?.toString())
                            DiagnosticField("WebView 提供程序", event.webviewProvider)
                            DiagnosticField("WebView 版本", event.webviewVersion)
                            DiagnosticField("HTTP 状态", event.httpStatus?.toString())
                            DiagnosticField("耗时", event.elapsedMs?.let { "$it 毫秒" })
                            DiagnosticField("关联请求编号", event.requestId)
                        }
                    }
                }
                group?.let {
                    Text("分组统计", style = MaterialTheme.typography.titleSmall)
                    DiagnosticField("首次 / 最近发生（北京时间）", "${diagnosticTime(it.firstAt)}\n${diagnosticTime(it.lastAt)}")
                    DiagnosticField("版本分布", it.releases.joinToString("、") { release ->
                        "${release.release} × ${release.count}"
                    })
                    DiagnosticField("机型分布", it.models.joinToString("、") { model ->
                        "${listOfNotNull(model.manufacturer, model.model).joinToString(" ")} × ${model.count}"
                    })
                }
                if (event != null && related.isNotEmpty()) {
                    Text("同一请求的记录", style = MaterialTheme.typography.titleSmall)
                    related.forEach { record ->
                        Surface(
                            onClick = { onRelated(record.eventId) },
                            enabled = !saving,
                            modifier = Modifier.fillMaxWidth(),
                            shape = MaterialTheme.shapes.small,
                            color = MaterialTheme.colorScheme.surfaceContainerLow,
                        ) {
                            Column(Modifier.fillMaxWidth().padding(10.dp)) {
                                Text(diagnosticTitle(record.area, record.code), style = MaterialTheme.typography.bodyMedium)
                                DiagnosticSupportingText("${diagnosticOrigin(record.source, record.stage)} · ${diagnosticTime(record.occurredAt)}")
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onDismiss, enabled = !saving) { Text("关闭") } },
        dismissButton = {
            if (event != null) {
                TextButton(
                    onClick = {
                        clipboard.setText(AnnotatedString(event.eventId))
                        copied = true
                    },
                    modifier = Modifier.testTag("admin-diagnostics-copy"),
                ) { Text(if (copied) "已复制" else "复制诊断编号") }
            }
        },
    )
}

@Composable
private fun DiagnosticField(label: String, value: String?) {
    if (!value.isNullOrBlank()) {
        Column {
            DiagnosticSupportingText(label)
            Text(value, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun DiagnosticSupportingText(value: String) {
    Text(value, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

private fun diagnosticTime(seconds: Long): String = diagnosticTimeFormat.format(Instant.ofEpochSecond(seconds))

private fun AdminDiagnosticEvent.outdatedWebViewDescription(): String? {
    if (source != "android" || area != "webview" || stage != "initialize") return null
    val minimum = ChatWebViewProvider.minimumVersionForDiagnostic(release, code) ?: return null
    val major = ChatWebViewProvider(webviewProvider, webviewVersion).majorVersion ?: return null
    return if (major < minimum) "WebView $major 低于应用内聊天所需的版本 $minimum。" else null
}

private fun AdminDiagnosticsRange.diagnosticRangeLabel() = when (this) {
    AdminDiagnosticsRange.LAST_24_HOURS -> "24 小时"
    AdminDiagnosticsRange.LAST_7_DAYS -> "7 天"
    AdminDiagnosticsRange.LAST_30_DAYS -> "30 天"
}

private fun AdminDiagnosticsStatus.diagnosticStatusLabel() = when (this) {
    AdminDiagnosticsStatus.PENDING -> "待处理"
    AdminDiagnosticsStatus.RESOLVED -> "已解决"
}

private val diagnosticAreas = mapOf(
    "startup" to "启动", "webview" to "内嵌网页", "runtime" to "运行",
    "chat" to "聊天", "image" to "生图", "import" to "导入", "attachment" to "附件",
    "account" to "账号", "sync" to "多端同步", "update" to "版本更新", "organization" to "记忆整理",
)

private val diagnosticCodes = mapOf(
    "timeout" to "超时", "load_failed" to "加载失败", "http_error" to "HTTP 错误",
    "network_error" to "网络错误", "crash" to "崩溃", "render_gone" to "渲染进程退出",
    "invalid_response" to "响应异常", "operation_failed" to "操作失败", "storage_error" to "存储错误",
    "integrity_error" to "校验失败", "unexpected_error" to "程序异常", "update_required" to "需要更新",
)

private val diagnosticStages = mapOf(
    "initialize" to "初始化", "navigate" to "打开页面", "document" to "加载文档", "render" to "渲染",
    "request" to "发送请求", "response" to "处理响应", "download" to "下载", "verify" to "校验",
    "save" to "保存", "read" to "读取", "parse" to "解析", "upload" to "上传", "apply" to "应用变更",
    "install" to "安装",
)

private val diagnosticSources = mapOf("android" to "Android", "web" to "网页", "server" to "服务器")

private fun diagnosticTitle(area: String, code: String): String =
    "${diagnosticAreas[area] ?: area} · ${diagnosticCodes[code] ?: code}"

private fun diagnosticOrigin(source: String, stage: String?): String = listOfNotNull(
    diagnosticSources[source] ?: source,
    stage?.let { diagnosticStages[it] ?: it },
).joinToString(" · ")
