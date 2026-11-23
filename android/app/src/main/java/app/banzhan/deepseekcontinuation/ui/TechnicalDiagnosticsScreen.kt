@file:Suppress("DEPRECATION")

package app.banzhan.deepseekcontinuation.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.banzhan.deepseekcontinuation.data.DiagnosticChoice
import app.banzhan.deepseekcontinuation.data.TechnicalDiagnosticEvent
import app.banzhan.deepseekcontinuation.data.TechnicalDiagnostics
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.launch

private const val CHOICE_DESCRIPTION = "协助排查崩溃和功能故障。发送故障阶段、版本、机型等技术信息。"

@Composable
internal fun TechnicalDiagnosticsStartChoice() {
    val scope = rememberCoroutineScope()
    var saving by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val choose: (Boolean) -> Unit = { enabled ->
        scope.launch {
            saving = true
            failed = !TechnicalDiagnostics.choose(enabled)
            saving = false
        }
    }
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("是否自动发送技术诊断？", style = MaterialTheme.typography.titleSmall)
            Text(CHOICE_DESCRIPTION, style = MaterialTheme.typography.bodySmall)
            if (failed) Text("暂时无法保存选择，请重试。", color = MaterialTheme.colorScheme.error)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                TextButton(onClick = { choose(false) }, enabled = !saving) { Text("暂不开启") }
                TextButton(onClick = { choose(true) }, enabled = !saving) { Text("开启自动发送") }
            }
        }
    }
}

@Composable
internal fun TechnicalDiagnosticsDialog(onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val choice by TechnicalDiagnostics.choice.collectAsStateWithLifecycle()
    val latest by TechnicalDiagnostics.latest.collectAsStateWithLifecycle()
    var preview by remember { mutableStateOf<TechnicalDiagnosticEvent?>(null) }
    var changing by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    val event = preview
    AlertDialog(
        onDismissRequest = { if (!sending) { if (event != null) preview = null else onDismiss() } },
        title = { Text(if (event == null) "技术诊断" else "发送本次诊断") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (event == null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("自动发送技术诊断", Modifier.weight(1f))
                        Switch(checked = choice == DiagnosticChoice.ENABLED, enabled = !changing, onCheckedChange = { enabled ->
                            scope.launch {
                                changing = true
                                note = if (TechnicalDiagnostics.choose(enabled)) null else "暂时无法保存选择，请重试。"
                                changing = false
                            }
                        })
                    }
                    Text(CHOICE_DESCRIPTION, style = MaterialTheme.typography.bodySmall)
                    Text("诊断在本机最多保留 30 天。开启自动发送后，联网时可补传。", style = MaterialTheme.typography.bodySmall)
                    if (latest == null) Text("暂无本机诊断记录。", style = MaterialTheme.typography.bodySmall)
                    else TextButton(onClick = { preview = latest; note = null }) { Text("查看最近一次诊断") }
                } else {
                    Text("仅发送以下技术信息。", style = MaterialTheme.typography.bodySmall)
                    Text(event.details(), style = MaterialTheme.typography.bodySmall)
                    Text("诊断编号：${event.id}", style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = {
                        context.getSystemService(ClipboardManager::class.java)
                            ?.setPrimaryClip(ClipData.newPlainText("诊断编号", event.id))
                        note = "已复制诊断编号。"
                    }) { Text("复制诊断编号") }
                }
                note?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            if (event == null) TextButton(onClick = onDismiss, enabled = !changing) { Text("关闭") }
            else Button(enabled = !sending, onClick = {
                scope.launch {
                    sending = true
                    note = if (TechnicalDiagnostics.sendOnce(event)) "诊断已发送，可随反馈附上该编号。"
                    else "暂未发送成功，请联网后再试。"
                    sending = false
                }
            }) { Text(if (sending) "正在发送" else "发送本次诊断") }
        },
        dismissButton = {
            if (event != null) TextButton(onClick = { preview = null; note = null }, enabled = !sending) { Text("返回") }
        },
    )
}

private fun TechnicalDiagnosticEvent.details(): String = buildList {
    add("功能：${when (area) {
        "startup" -> "启动"
        "webview" -> "内嵌网页"
        "runtime" -> "应用运行"
        "chat" -> "聊天"
        "image" -> "生图"
        "import" -> "导入"
        "attachment" -> "附件"
        "account" -> "账号"
        "sync" -> "云同步"
        "update" -> "应用更新"
        "organization" -> "记忆整理"
        else -> area
    }}")
    add("故障码：" + listOfNotNull(code, stage).joinToString(" · "))
    add("时间：" + DateFormat.getDateTimeInstance().format(Date(occurredAt * 1000)))
    add("版本：$release")
    androidSdk?.let { add("Android API：$it") }
    listOfNotNull(manufacturer, model).joinToString(" ").takeIf(String::isNotEmpty)?.let { add("机型：$it") }
    listOfNotNull(webViewProvider, webViewVersion).joinToString(" ").takeIf(String::isNotEmpty)?.let { add("WebView：$it") }
    httpStatus?.let { add("HTTP 状态：$it") }
    elapsedMs?.let { add("耗时：${it} 毫秒") }
    requestId?.let { add("服务器请求编号：$it") }
    technicalDetailLabel(detail)?.let { add("失败环节：$it") }
    technicalServiceLabel(serviceMode)?.let { add("服务类型：$it") }
    technicalInputLabel(inputFormat, inputSizeBand)?.let { add("导入文件类型与大小：$it") }
}.joinToString("\n")

internal fun technicalDetailLabel(detail: String?): String? = when (detail) {
    "import_empty" -> "文件为空"
    "import_size_limit" -> "原文件超过导入上限"
    "import_unsupported_file" -> "文件类型不受支持"
    "import_no_conversations" -> "未找到聊天内容"
    "import_zip_validation" -> "ZIP 校验失败或超出解压上限"
    "import_zip_read" -> "无法读取 ZIP"
    "import_json_syntax" -> "JSON 语法或解析限制"
    "import_json_structure" -> "会话结构检查"
    "import_json_read" -> "无法读取 UTF-8 JSON"
    "import_validation" -> "导入要求检查"
    "import_save" -> "保存导入结果"
    "webview_navigation" -> "等待网页开始加载"
    "webview_document" -> "等待网页文档加载完成"
    "webview_page_ready" -> "等待网页首屏就绪消息"
    "webview_visual_callback" -> "等待 WebView 绘制回调"
    "authentication_rejected" -> "服务拒绝鉴权"
    "network_before_headers" -> "收到响应头前连接中断或超时"
    "network_reading_body" -> "读取响应体时中断或超时"
    "invalid_model_response" -> "整理响应格式校验"
    "model_envelope_invalid" -> "整理响应格式无法识别"
    "model_finish_incomplete" -> "整理输出未完整结束"
    "model_content_blank" -> "整理响应的文本为空"
    "model_entries_invalid" -> "整理条目或来源校验"
    "upstream_http" -> "服务返回 HTTP 错误"
    "organization_local" -> "本机准备或保存整理任务"
    else -> null
}

internal fun technicalServiceLabel(mode: String?): String? = when (mode) {
    "managed" -> "配套 API"
    "personal" -> "个人 API"
    else -> null
}

internal fun technicalInputLabel(format: String?, sizeBand: String?): String? {
    val type = when (format) {
        "json" -> "JSON"
        "zip" -> "ZIP"
        "unknown" -> "未识别"
        else -> null
    }
    val size = when (sizeBand) {
        "empty" -> "空文件"
        "up_to_256_kib" -> "256 KiB 以内"
        "up_to_1_mib" -> "256 KiB 至 1 MiB"
        "up_to_8_mib" -> "1 至 8 MiB"
        "up_to_32_mib" -> "8 至 32 MiB"
        "over_32_mib" -> "超过 32 MiB"
        else -> null
    }
    return listOfNotNull(type, size).joinToString(" · ").ifEmpty { null }
}
