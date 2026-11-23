@file:Suppress("DEPRECATION")

package app.banzhan.deepseekcontinuation.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.os.PersistableBundle
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.banzhan.deepseekcontinuation.data.AdminPasswordResetLink
import app.banzhan.deepseekcontinuation.data.ServicePermissions
import app.banzhan.deepseekcontinuation.data.UserUsage

private enum class AccountDetailPage(val title: String) {
    Overview("账号详情"), Permissions("服务权限"), Quota("个人额度"), Access("账号操作"),
}

private enum class AccountConfirmation { Enable, Disable, CreateResetLink }

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun AdminUserDetailsDialog(
    user: UserUsage,
    defaultLimit: Int?,
    loading: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSetEnabled: (Boolean) -> Unit,
    onCreateResetLink: ((AdminPasswordResetLink) -> Unit) -> Unit,
    onSavePermissions: (ServicePermissions) -> Unit,
    onSaveQuota: (Int?, Int?) -> Unit,
) {
    val accountName = user.username?.takeIf { it.isNotBlank() } ?: user.id
    val assigned = user.servicePermissions
    val effective = if (user.enabled) user.effectivePermissions ?: assigned else ServicePermissions.None
    val showQuota = assigned.hasManagedApi || effective.hasManagedApi
    val canLockPermissions = assigned == ServicePermissions.None && user.inviteRedeemable == true
    var page by rememberSaveable(user.id) { mutableStateOf(AccountDetailPage.Overview) }
    var permissionDraft by rememberSaveable(user.id, assigned, stateSaver = permissionSelectionSaver) {
        mutableStateOf(assigned)
    }
    var followDefault by rememberSaveable(user.id, user.weeklyLimitOverride) {
        mutableStateOf(user.weeklyLimitOverride == null)
    }
    var limit by rememberSaveable(user.id, user.weeklyLimitOverride) {
        mutableStateOf((user.weeklyLimitOverride ?: defaultLimit ?: user.weeklyLimit).toString())
    }
    var remaining by rememberSaveable(user.id, user.weeklyRemaining) { mutableStateOf("") }
    val proposedLimit = if (followDefault) null else limit.toAccountQuota()
    val proposedRemaining = remaining.toAccountQuota()
    val invalidLimit = !followDefault && proposedLimit == null
    val invalidRemaining = remaining.isNotBlank() && proposedRemaining == null
    var confirmation by remember(user.id) { mutableStateOf<AccountConfirmation?>(null) }
    var resetResult by remember(user.id) { mutableStateOf<AdminPasswordResetLink?>(null) }
    val goBack = {
        if (!loading) {
            if (page == AccountDetailPage.Overview) onDismiss() else page = AccountDetailPage.Overview
        }
    }

    Dialog(
        onDismissRequest = goBack,
        properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnClickOutside = false),
    ) {
        Box(
            Modifier.fillMaxSize().safeDrawingPadding().imePadding().padding(12.dp),
            contentAlignment = Alignment.Center,
        ) {
            Surface(
                modifier = Modifier.widthIn(max = 540.dp).fillMaxWidth().testTag("admin-user-details:${user.id}"),
                shape = MaterialTheme.shapes.large,
                color = MaterialTheme.colorScheme.surface,
            ) {
                Column {
                    Row(
                        Modifier.fillMaxWidth().padding(start = 8.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (page != AccountDetailPage.Overview) {
                            IconButton(onClick = goBack, enabled = !loading) {
                                Icon(Icons.AutoMirrored.Outlined.ArrowBack, "返回账号详情")
                            }
                        }
                        Text(
                            page.title,
                            Modifier.weight(1f).padding(start = if (page == AccountDetailPage.Overview) 10.dp else 0.dp),
                            style = MaterialTheme.typography.titleLarge,
                        )
                        IconButton(onClick = onDismiss, enabled = !loading) {
                            Icon(Icons.Outlined.Close, "关闭账号详情")
                        }
                    }
                    if (loading) LinearProgressIndicator(Modifier.fillMaxWidth()) else HorizontalDivider()

                    key(page) {
                        Column(
                            Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 14.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            if (page != AccountDetailPage.Overview) {
                                Text(accountName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                            }
                            error?.let {
                                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                            }
                            when (page) {
                                AccountDetailPage.Overview -> AccountOverview(
                                    user, accountName, assigned, effective, showQuota,
                                ) { page = it }
                                AccountDetailPage.Permissions -> {
                                    PermissionFact("当前生效", effective)
                                    Text("编辑账号权限", style = MaterialTheme.typography.labelLarge)
                                    PermissionChecks(permissionDraft, !loading, "admin-user-permissions:${user.id}") {
                                        permissionDraft = it
                                    }
                                    if (canLockPermissions) {
                                        Text("保存后，此账号的权限由管理员调整。", style = MaterialTheme.typography.bodySmall)
                                    }
                                    if (effective != assigned) {
                                        Text("实际可用权限还取决于全局开放设置和账号状态。", style = MaterialTheme.typography.bodySmall)
                                    }
                                }
                                AccountDetailPage.Quota -> {
                                    AccountFact("本周剩余 / 每周上限", "${user.weeklyRemaining} / ${user.weeklyLimit} 次")
                                    AccountFact("本周已用 / 预留", "${user.weeklyUsed} / ${user.weeklyReserved} 次")
                                    Row(
                                        Modifier.fillMaxWidth().toggleable(followDefault, enabled = !loading, role = Role.Checkbox) {
                                            followDefault = it
                                        }.testTag("admin-user-follow-default:${user.id}"),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Checkbox(followDefault, onCheckedChange = null, enabled = !loading)
                                        Text("跟随默认每周次数" + (defaultLimit?.let { "（$it 次）" } ?: ""),
                                            Modifier.weight(1f).padding(horizontal = 4.dp, vertical = 6.dp))
                                    }
                                    if (!followDefault) NumberField("个人每周免费次数", limit, !loading) { limit = it }
                                    if (invalidLimit) QuotaInputError("个人次数须为 0 至 1000000 的整数。")
                                    NumberField("仅本周的剩余次数（选填）", remaining, !loading) { remaining = it }
                                    if (invalidRemaining) QuotaInputError("本周剩余须为 0 至 1000000 的整数。")
                                    Text("留空则只保存每周额度设置。本周调整会保留已使用和预留的次数。",
                                        style = MaterialTheme.typography.bodySmall)
                                }
                                AccountDetailPage.Access -> {
                                    AccountFact("当前状态", if (user.enabled) "使用中" else "已停用")
                                    ActionRow {
                                        TextButton(
                                            enabled = !loading,
                                            onClick = { confirmation = if (user.enabled) AccountConfirmation.Disable else AccountConfirmation.Enable },
                                            modifier = Modifier.testTag("admin-user-status:${user.id}"),
                                        ) { Text(if (user.enabled) "停用账号" else "启用账号") }
                                        TextButton(
                                            enabled = !loading && user.enabled,
                                            onClick = { confirmation = AccountConfirmation.CreateResetLink },
                                            modifier = Modifier.testTag("admin-user-reset:${user.id}"),
                                        ) { Text("生成密码重置链接") }
                                    }
                                }
                            }
                        }
                    }

                    if (page == AccountDetailPage.Permissions || page == AccountDetailPage.Quota) {
                        HorizontalDivider()
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                            horizontalArrangement = Arrangement.End) {
                            if (page == AccountDetailPage.Permissions) {
                                Button(
                                    onClick = { onSavePermissions(permissionDraft) },
                                    enabled = !loading && (permissionDraft != assigned || canLockPermissions),
                                    modifier = Modifier.testTag("admin-user-save-permissions:${user.id}"),
                                ) { Text("保存权限") }
                            } else {
                                Button(
                                    onClick = { onSaveQuota(proposedLimit, proposedRemaining) },
                                    enabled = !loading && !invalidLimit && !invalidRemaining &&
                                        (proposedLimit != user.weeklyLimitOverride || proposedRemaining != null),
                                    modifier = Modifier.testTag("admin-user-save:${user.id}"),
                                ) { Text("保存个人次数") }
                            }
                        }
                    }
                }
            }
        }
    }

    confirmation?.let { action ->
        val title = when (action) {
            AccountConfirmation.Enable -> "启用账号"
            AccountConfirmation.Disable -> "停用账号"
            AccountConfirmation.CreateResetLink -> "生成密码重置链接"
        }
        val description = when (action) {
            AccountConfirmation.Enable -> "$accountName 可以重新登录和使用已开通的服务。"
            AccountConfirmation.Disable -> "$accountName 的登录会话会立即退出。再次启用后可以重新登录。"
            AccountConfirmation.CreateResetLink -> "为 $accountName 生成一次性链接。请先核实账号归属。用户设置新密码后，已有登录会话会失效。"
        }
        AlertDialog(
            onDismissRequest = { confirmation = null },
            title = { Text("$title？") },
            text = { Text(description) },
            confirmButton = {
                TextButton(enabled = !loading, modifier = Modifier.testTag("admin-user-confirm:${user.id}"), onClick = {
                    confirmation = null
                    when (action) {
                        AccountConfirmation.Enable -> onSetEnabled(true)
                        AccountConfirmation.Disable -> onSetEnabled(false)
                        AccountConfirmation.CreateResetLink -> onCreateResetLink { resetResult = it }
                    }
                }) { Text(title) }
            },
            dismissButton = { TextButton(onClick = { confirmation = null }) { Text("取消") } },
        )
    }
    resetResult?.let { result ->
        val clipboard = LocalContext.current.getSystemService(ClipboardManager::class.java)
        AlertDialog(
            onDismissRequest = { resetResult = null },
            title = { Text("密码重置链接已生成") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(result.username)
                    Text("有效至 ${readableServerTime(result.expiresAt)}", style = MaterialTheme.typography.bodySmall)
                    Text(result.url, style = MaterialTheme.typography.bodySmall)
                    Text("请私下发给该用户。链接只能使用一次。", style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = {
                TextButton(
                    enabled = clipboard != null,
                    onClick = {
                        val clip = ClipData.newPlainText("一次性重置链接", result.url)
                        clip.description.extras = PersistableBundle().apply {
                            putBoolean("android.content.extra.IS_SENSITIVE", true)
                        }
                        clipboard?.setPrimaryClip(clip)
                        resetResult = null
                    },
                ) { Text("复制链接") }
            },
            dismissButton = { TextButton(onClick = { resetResult = null }) { Text("关闭") } },
        )
    }
}

@Composable
private fun AccountOverview(
    user: UserUsage,
    name: String,
    assigned: ServicePermissions,
    effective: ServicePermissions,
    showQuota: Boolean,
    onOpen: (AccountDetailPage) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(name, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        val role = if (user.role == "admin") "管理员" else "注册用户"
        Text("$role · ${if (user.enabled) "已启用" else "账号已停用"}", style = MaterialTheme.typography.bodyMedium,
            color = if (user.enabled) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error)
    }
    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(7.dp)) {
            PermissionFact("当前生效", effective)
            if (effective != assigned) PermissionFact("账号权限", assigned)
            if (showQuota) AccountFact("本周剩余 / 上限", "${user.weeklyRemaining} / ${user.weeklyLimit} 次")
        }
    }
    Column {
        AccountDetailEntry("管理权限", "调整聊天、生图和云同步", "admin-user-open-permissions:${user.id}") {
            onOpen(AccountDetailPage.Permissions)
        }
        if (showQuota) AccountDetailEntry("调整额度", "设置每周上限或本周剩余次数", "admin-user-open-quota:${user.id}") {
            onOpen(AccountDetailPage.Quota)
        }
        AccountDetailEntry("账号操作", "管理账号状态及密码", "admin-user-open-account:${user.id}") {
            onOpen(AccountDetailPage.Access)
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        AccountFact("注册方式", if (user.registrationKind == "invitation") "邀请码注册" else "公开注册")
        AccountFact("注册时间", readableServerTime(user.createdAt))
        user.lastSeenAt?.let { AccountFact("最近活动", readableServerTime(it)) }
        SelectionContainer {
            Text("用户 ID · ${user.id}", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun AccountDetailEntry(title: String, summary: String, tag: String, onClick: () -> Unit) {
    ListItem(
        modifier = Modifier.clickable(role = Role.Button, onClick = onClick).testTag(tag),
        headlineContent = { Text(title) },
        supportingContent = { Text(summary) },
        trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null) },
    )
    HorizontalDivider()
}

@Composable
private fun PermissionFact(label: String, permissions: ServicePermissions) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(permissions.summary(), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun AccountFact(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(label, Modifier.weight(0.4f), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, Modifier.weight(0.6f), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun QuotaInputError(message: String) {
    Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
}

private fun String.toAccountQuota() = trim().toIntOrNull()?.takeIf { it in 0..1_000_000 }
