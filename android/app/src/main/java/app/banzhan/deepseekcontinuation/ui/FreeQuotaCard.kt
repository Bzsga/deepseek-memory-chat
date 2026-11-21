package app.banzhan.deepseekcontinuation.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.banzhan.deepseekcontinuation.data.AppState
import app.banzhan.deepseekcontinuation.data.automaticFallbackNotice
import app.banzhan.deepseekcontinuation.data.fallbackAttemptLimit

@Composable
internal fun FreeQuotaCard(state: AppState, onRefresh: () -> Unit) {
    val user = state.account.currentUser
    val permissions = user?.servicePermissions
    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surface) {
        Column(
            Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(if (permissions?.hasManagedApi == false) "服务权限" else "本周免费次数",
                    Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                if (user != null) TextButton(onClick = onRefresh, enabled = !state.quotaLoading && !state.account.loading) {
                    Text(if (state.quotaLoading || state.account.loading) "获取中" else "刷新")
                }
            }
            val quota = state.quota
            when {
                user == null || permissions == null -> Text(
                    if (state.account.loading) "正在读取账户…" else "登录后可查看账号权限。",
                    style = MaterialTheme.typography.bodySmall,
                )
                !permissions.hasManagedApi -> {
                    if (permissions.cloudSync) Text("已开通云同步。")
                    Text(if (user.inviteRedeemable != false && !permissions.cloudSync)
                        "可在聊天设置中配置个人 API 或兑换邀请码。"
                    else "可在聊天设置中配置个人 API。")
                }
                state.quotaLoading || state.account.loading -> {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text("正在获取你的剩余次数。", style = MaterialTheme.typography.bodySmall)
                }
                state.quotaError != null -> {
                    Text("未能获取剩余次数，请刷新重试。", color = MaterialTheme.colorScheme.error)
                }
                quota == null -> Text("尚未获取剩余次数。", style = MaterialTheme.typography.bodySmall)
                else -> {
                    QuotaLine("你本周还可用", quota.userWeeklyRemaining, quota.userWeeklyLimit)
                    if (!permissions.chatApi && permissions.imageApi)
                        Text("免费次数用于生图。聊天和记忆整理可使用个人 API。", style = MaterialTheme.typography.bodySmall)
                    if (permissions.chatApi && quota.fallbackAttemptLimit > 1)
                        Text(
                            automaticFallbackNotice(quota.fallbackAttemptLimit),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    if (permissions.chatApi && !quota.enabled)
                        Text(
                            "免费智能整理当前已暂停。",
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    if (quota.userWeeklyRemaining == 0)
                        Text("你本周的免费次数已用完。", style = MaterialTheme.typography.bodySmall)
                    val pending =
                        listOfNotNull(
                                quota.userWeeklyReserved?.takeIf { it > 0 }?.let { "你已预留 $it 次" },
                            )
                            .joinToString("，")
                    if (pending.isNotEmpty())
                        Text(
                            pending,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    Text(
                        "北京时间每周一零点刷新。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun QuotaLine(label: String, remaining: Int?, limit: Int?) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Text(
            if (remaining == null) "未提供" else "$remaining / ${limit?.toString() ?: "?"} 次",
            color = Blue,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

internal fun readableServerTime(value: String): String =
    runCatching {
            java.time.OffsetDateTime.parse(value)
                .format(java.time.format.DateTimeFormatter.ofPattern("yyyy.MM.dd HH:mm xxx"))
        }
        .getOrDefault(value)
