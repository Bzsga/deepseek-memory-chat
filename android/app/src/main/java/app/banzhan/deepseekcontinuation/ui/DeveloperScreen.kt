@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package app.banzhan.deepseekcontinuation.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.banzhan.deepseekcontinuation.data.*

@Composable
internal fun DeveloperScreen(
    state: AppState,
    controller: AppController,
    run: (suspend () -> Unit) -> Unit,
) {
    val prefs = state.developerPrefs
    if (prefs.sessionToken.isBlank() || state.account.currentUser?.role != "admin") return
    var page by rememberSaveable { mutableStateOf("overview") }
    var days by rememberSaveable { mutableIntStateOf(7) }
    val signedIn = prefs.sessionToken.isNotBlank()
    val hideManagementHeader =
        WindowInsets.isImeVisible && page in setOf("users", "server", "feedback")
    LaunchedEffect(signedIn, prefs.serviceUrl, prefs.sessionToken, page, days) {
        if (page == "local") page = "overview"
        if (signedIn) {
            when (page) {
                "overview" -> run { controller.refreshAdminStats(days) }
                "users" -> {
                    run { controller.refreshAdminOpenPermissions() }
                    run { controller.refreshAdminRegistrationPolicy() }
                    run {
                        controller.refreshAdminConfig()
                        controller.refreshAdminUsers(limit = 25, offset = 0)
                    }
                }
                "server" -> run { controller.refreshAdminConfig() }
            }
        }
    }
    Column(Modifier.fillMaxSize()) {
        if (!hideManagementHeader)
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp),
                verticalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                ActionRow {
                    listOf(
                            "overview" to "统计概览",
                            "users" to "用户与邀请码",
                            "feedback" to "意见审批",
                            "server" to "服务器",
                        )
                        .forEach { (id, title) ->
                            FilterChip(page == id, { page = id }, label = { Text(title) })
                        }
                }
            }
        Box(Modifier.weight(1f)) {
            when (page) {
                "overview" ->
                    AdminOverview(
                        state,
                        days,
                        { days = it },
                        { run { controller.refreshAdminStats(days) } },
                    )
                "users" ->
                    AdminUsers(
                        state,
                        controller,
                        run,
                        onPage = { offset ->
                            run { controller.refreshAdminUsers(limit = 25, offset = offset) }
                        },
                    )
                "server" -> AdminServerSettings(state, controller, run)
                "feedback" -> AdminFeedbackScreen(state, controller, run)
            }
        }
    }
}

@Composable
private fun AdminOverview(
    state: AppState,
    days: Int,
    onDays: (Int) -> Unit,
    onRefresh: () -> Unit,
) {
    val stats = state.adminStats
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            ActionRow {
                listOf(7, 30).forEach { count ->
                    FilterChip(days == count, { onDays(count) }, label = { Text("最近 $count 天") })
                }
                TextButton(onClick = onRefresh, enabled = !state.adminStatsLoading) { Text("刷新统计") }
            }
        }
        if (state.adminStatsLoading)
            item {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text("正在读取服务器统计。", style = MaterialTheme.typography.bodySmall)
            }
        state.adminStatsError?.let {
            item { NoticeCard("未能获取统计。$it" + if (stats != null) "\n下面显示上次成功读取的数据。" else "") }
        }
        if (stats == null) {
            if (!state.adminStatsLoading && state.adminStatsError == null)
                item { NoticeCard("尚未加载统计数据。") }
        } else {
            item {
                Text(
                    "${stats.startDate} — ${stats.endDate} · ${stats.timezone}\n更新于 ${readableServerTime(stats.generatedAt)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item {
                AdminSection("本周全站请求") {
                    MetricRow("已用", stats.thisWeek.weeklyUsed.toString())
                    MetricRow("排队预留", stats.thisWeek.weeklyReserved.toString())
                    MetricRow(
                        "剩余 / 上限",
                        "${stats.thisWeek.weeklyRemaining} / ${stats.thisWeek.weeklyLimit}",
                    )
                    Text(
                        "重置时间 · ${readableServerTime(stats.thisWeek.resetAt)}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            item {
                AdminSection("用户与请求") {
                    MetricRow("用户总数", stats.totals.users.toString())
                    MetricRow("期间新增用户", stats.totals.newUsers.toString())
                    MetricRow("期间活跃用户", stats.totals.activeUsers.toString())
                    MetricRow("期间模型请求", stats.totals.requests.toString())
                }
            }
            item {
                AdminSection("任务与用量") {
                    MetricRow("完成 / 失败", "${stats.totals.completed} / ${stats.totals.failed}")
                    MetricRow(
                        "结果不确定 / 已取消",
                        "${stats.totals.uncertain} / ${stats.totals.cancelled}",
                    )
                    MetricRow("排队 / 处理中", "${stats.totals.queued} / ${stats.totals.running}")
                    Text("Token 用量仅统计服务方已报告的部分。", style = MaterialTheme.typography.bodySmall)
                    MetricRow("已报告输入 tokens", stats.totals.inputTokens.toString())
                    MetricRow("已报告输出 tokens", stats.totals.outputTokens.toString())
                    MetricRow("用量未知的请求", stats.totals.usageUnknownRequests?.toString() ?: "未提供")
                }
            }
            item { SectionTitle("按日查看") }
            items(stats.daily, key = { it.date }) { day ->
                AdminSection(day.date) {
                    MetricRow("新增 / 活跃用户", "${day.newUsers} / ${day.activeUsers}")
                    MetricRow("模型请求", day.requests.toString())
                    MetricRow(
                        "完成 / 失败 / 不确定",
                        "${day.completed} / ${day.failed} / ${day.uncertain}",
                    )
                    MetricRow("取消", day.cancelled.toString())
                    MetricRow("已报告输入 / 输出", "${day.inputTokens} / ${day.outputTokens}")
                    MetricRow("用量未知的请求", day.usageUnknownRequests?.toString() ?: "未提供")
                }
            }
        }
    }
}

@Composable
private fun AdminUsers(
    state: AppState,
    controller: AppController,
    run: (suspend () -> Unit) -> Unit,
    onPage: (Int) -> Unit,
) {
    val page = state.adminUsers
    var resetTarget by remember { mutableStateOf<UserUsage?>(null) }
    var resetResult by remember { mutableStateOf<AdminPasswordReset?>(null) }
    val clipboard = LocalClipboardManager.current
    resetTarget?.let { user ->
        AlertDialog(
            onDismissRequest = { resetTarget = null },
            title = { Text("重置密码？") },
            text = { Text("为 ${user.username ?: user.id} 生成新密码，并退出该账号已有的登录会话。") },
            confirmButton = { TextButton(onClick = {
                resetTarget = null
                run { resetResult = controller.resetAdminUserPassword(user.id) }
            }, enabled = !state.adminUsersLoading) { Text("重置密码") } },
            dismissButton = { TextButton(onClick = { resetTarget = null }) { Text("取消") } },
        )
    }
    resetResult?.let { result ->
        AlertDialog(
            onDismissRequest = { resetResult = null },
            title = { Text("新密码已生成") },
            text = { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(result.username)
                SelectionContainer { Text(result.password, style = MaterialTheme.typography.titleMedium) }
                Text("请把新密码发给对应用户。关闭后这里不再显示。", style = MaterialTheme.typography.bodySmall)
            } },
            confirmButton = { TextButton(onClick = {
                clipboard.setText(AnnotatedString(result.password))
                resetResult = null
            }) { Text("复制并关闭") } },
            dismissButton = { TextButton(onClick = { resetResult = null }) { Text("关闭") } },
        )
    }
    var invitationsExpanded by rememberSaveable { mutableStateOf(false) }
    var invitationCount by rememberSaveable { mutableIntStateOf(10) }
    LaunchedEffect(invitationsExpanded) {
        if (invitationsExpanded) run { controller.refreshAdminRegistrationInvites() }
    }
    LazyColumn(
        Modifier.fillMaxSize().imePadding(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            AdminRegistrationPolicyControls(
                current = state.adminSelfServiceRegistration,
                loading = state.adminSelfServiceRegistrationLoading,
                error = state.adminSelfServiceRegistrationError,
                onRefresh = { run { controller.refreshAdminRegistrationPolicy() } },
                onSave = { enabled -> run { controller.updateAdminRegistrationPolicy(enabled) } },
            )
        }
        item {
            AdminOpenPermissionsControls(
                current = state.adminOpenPermissions,
                loading = state.adminOpenPermissionsLoading,
                error = state.adminOpenPermissionsError,
                onRefresh = { run { controller.refreshAdminOpenPermissions() } },
                onSave = { permissions -> run { controller.updateAdminOpenPermissions(permissions) } },
            )
        }
        state.adminError?.let { item { NoticeCard(it) } }
        item {
            RegistrationInvitationControls(
                expanded = invitationsExpanded,
                loading = state.adminRegistrationLoading,
                onToggle = { invitationsExpanded = !invitationsExpanded; invitationCount = 10 },
                onRefresh = { run { controller.refreshAdminRegistrationInvites() } },
                onCreate = { count, days, permissions -> run { controller.createAdminRegistrationInvites(count, days, permissions) } },
            )
        }
        if (invitationsExpanded) {
            state.adminRegistrationError?.let { item { NoticeCard(it) } }
            val invitations = state.adminRegistrationInvites?.filter { it.usedAt == null }.orEmpty()
            if (state.adminRegistrationInvites != null && invitations.isEmpty())
                item { Text("还没有未使用的邀请码。", style = MaterialTheme.typography.bodySmall) }
            items(invitations.take(invitationCount), key = { "invite:${it.id}" }) { invitation ->
                RegistrationInvitationCard(invitation)
            }
            if (invitations.size > invitationCount) item {
                TextButton(onClick = { invitationCount += 10 }) { Text("显示更多邀请码") }
            }
        }
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("注册用户", Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                TextButton(
                    onClick = { run {
                        controller.refreshAdminConfig()
                        controller.refreshAdminUsers(limit = page?.limit ?: 25, offset = page?.offset ?: 0)
                    } },
                    enabled = !state.adminUsersLoading,
                ) {
                    Text("刷新")
                }
            }
        }
        if (state.adminUsersLoading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        state.adminUsersError?.let {
            item { NoticeCard("未能获取用户列表。$it" + if (page != null) "\n下面显示上次成功读取的列表。" else "") }
        }
        if (page == null) {
            if (!state.adminUsersLoading && state.adminUsersError == null)
                item { NoticeCard("尚未加载用户列表。") }
        } else {
            if (page.users.isEmpty()) item { NoticeCard("这一页没有用户记录。") }
            items(page.users.filter { !it.username.isNullOrBlank() }, key = { it.id }) { user ->
                RegisteredUserQuotaCard(
                    user, state.adminConfig?.userWeeklyLimit, state.adminUsersLoading,
                    onSetEnabled = { enabled -> run { controller.setAdminUserEnabled(user.id, enabled) } },
                    onResetPassword = { resetTarget = user },
                    onSavePermissions = { permissions -> run { controller.updateAdminUserPermissions(user.id, permissions) } },
                ) { limit, remaining ->
                    run { controller.updateAdminUserQuota(user.id, limit, remaining, page.week.takeIf { remaining != null }) }
                }
            }
            item {
                val first = if (page.users.isEmpty()) 0 else page.offset + 1
                Text(
                    "显示 $first–${page.offset + page.users.size} / ${page.total}",
                    style = MaterialTheme.typography.bodySmall,
                )
                ActionRow {
                    OutlinedButton(
                        onClick = { onPage((page.offset - page.limit).coerceAtLeast(0)) },
                        enabled = !state.adminUsersLoading && page.offset > 0,
                    ) {
                        Text("上一页")
                    }
                    OutlinedButton(
                        onClick = { onPage(page.offset + page.limit) },
                        enabled =
                            !state.adminUsersLoading && page.offset + page.users.size < page.total,
                    ) {
                        Text("下一页")
                    }
                }
            }
        }
    }
}

@Composable
internal fun AdminOpenPermissionsControls(
    current: ServicePermissions?,
    loading: Boolean,
    error: String?,
    onRefresh: () -> Unit,
    onSave: (ServicePermissions) -> Unit,
) {
    var draft by rememberSaveable(current, stateSaver = permissionSelectionSaver) {
        mutableStateOf(current ?: ServicePermissions.None)
    }
    AdminSection("全局功能开放") {
        Text(
            "开启后对所有已登录账号开放。关闭后按账号权限判断。",
            style = MaterialTheme.typography.bodySmall,
        )
        Text(
            "配套 API 仍受每周额度限制。用户可以自行选择是否开启云同步。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (current != null) {
            PermissionChecks(draft, !loading, "admin-open-permissions") { draft = it }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        ActionRow {
            if (current != null) {
                Button(
                    onClick = { onSave(draft) },
                    enabled = !loading && draft != current,
                    modifier = Modifier.testTag("admin-open-permissions-save"),
                ) { Text("保存开放设置") }
            }
            TextButton(
                onClick = onRefresh,
                enabled = !loading,
                modifier = Modifier.testTag("admin-open-permissions-refresh"),
            ) { Text("重新读取") }
        }
    }
}

@Composable
private fun AdminRegistrationPolicyControls(
    current: Boolean?,
    loading: Boolean,
    error: String?,
    onRefresh: () -> Unit,
    onSave: (Boolean) -> Unit,
) {
    var draft by rememberSaveable(current) { mutableStateOf(current == true) }
    AdminSection("注册设置") {
        if (current != null) {
            Row(
                Modifier.fillMaxWidth().toggleable(
                    value = draft, enabled = !loading, role = Role.Switch, onValueChange = { draft = it },
                ).padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("开放自助注册", Modifier.weight(1f))
                Switch(checked = draft, onCheckedChange = null, enabled = !loading)
            }
            Text(
                "开启后，用户可以免邀请码注册并使用基础同步。关闭后，新用户凭邀请码注册。",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        ActionRow {
            if (current != null) {
                Button(onClick = { onSave(draft) }, enabled = !loading && draft != current) { Text("保存注册设置") }
            }
            TextButton(onClick = onRefresh, enabled = !loading) { Text("重新读取注册设置") }
        }
    }
}

@Composable
internal fun RegisteredUserQuotaCard(
    user: UserUsage,
    defaultLimit: Int?,
    loading: Boolean,
    onSetEnabled: ((Boolean) -> Unit)? = null,
    onResetPassword: (() -> Unit)? = null,
    onSavePermissions: ((ServicePermissions) -> Unit)? = null,
    onSave: (Int?, Int?) -> Unit,
) {
    val currentPermissions = user.servicePermissions
    val canLockCurrentPermissions = currentPermissions == ServicePermissions.None && user.inviteRedeemable == true
    var permissions by rememberSaveable(user.id, currentPermissions, stateSaver = permissionSelectionSaver) {
        mutableStateOf(currentPermissions)
    }
    var expanded by rememberSaveable(user.id) { mutableStateOf(false) }
    var followDefault by remember(user) { mutableStateOf(user.weeklyLimitOverride == null) }
    var limit by remember(user) { mutableStateOf((user.weeklyLimitOverride ?: user.weeklyLimit).toString()) }
    var weekRemaining by remember(user) { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    AdminSection(user.username ?: user.id.take(12)) {
        if (!user.enabled) Text("账号已停用", color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.labelMedium)
        MetricRow("服务权限", currentPermissions.summary())
        if (currentPermissions.hasManagedApi) MetricRow("本周剩余 / 每周上限", "${user.weeklyRemaining} / ${user.weeklyLimit}")
        val registration = if (user.registrationKind == "invitation") "邀请码注册" else "公开注册"
        val quotaPolicy = if (user.weeklyLimitOverride == null) "跟随默认次数" else "个人单独设置"
        Text(
            if (currentPermissions.hasManagedApi) "$registration · $quotaPolicy" else registration,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        TextButton(onClick = { expanded = !expanded }, modifier = Modifier.testTag("admin-user-toggle:${user.id}")) {
            Text(if (expanded) "收起调整" else "管理账号")
        }
        if (expanded) {
            if (onSetEnabled != null || onResetPassword != null) ActionRow {
                onSetEnabled?.let { action ->
                    OutlinedButton(onClick = { action(!user.enabled) }, enabled = !loading,
                        modifier = Modifier.testTag("admin-user-status:${user.id}")) {
                        Text(if (user.enabled) "停用账号" else "启用账号")
                    }
                }
                onResetPassword?.let { action ->
                    TextButton(onClick = action, enabled = !loading,
                        modifier = Modifier.testTag("admin-user-reset:${user.id}")) { Text("重置密码") }
                }
            }
            onSavePermissions?.let { save ->
                PermissionChecks(permissions, !loading, "admin-user-permissions:${user.id}") { permissions = it }
                if (canLockCurrentPermissions) {
                    Text("保存后，此账号的权限由管理员调整。", style = MaterialTheme.typography.bodySmall)
                }
                OutlinedButton(
                    onClick = { save(permissions) },
                    enabled = !loading && (permissions != currentPermissions || canLockCurrentPermissions),
                    modifier = Modifier.testTag("admin-user-save-permissions:${user.id}"),
                ) { Text("保存权限") }
            }
            if (currentPermissions.hasManagedApi) Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(followDefault, { followDefault = it }, enabled = !loading,
                        modifier = Modifier.testTag("admin-user-follow-default:${user.id}"))
                    Text("跟随默认每周次数" + (defaultLimit?.let { "（$it 次）" } ?: ""),
                        Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                }
                if (!followDefault) NumberField("个人每周免费次数", limit, !loading) { limit = it }
                NumberField("仅本周的剩余次数（选填）", weekRemaining, !loading) { weekRemaining = it }
                Text("留空保留本周已用情况。已开始的请求与预留次数不会被取消。", style = MaterialTheme.typography.bodySmall)
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Button(
                    onClick = {
                        try {
                            val personal = if (followDefault) null else requireNotNull(limit.toIntOrNull()?.takeIf { it in 0..1_000_000 }) { "个人次数应为0到1000000之间的整数。" }
                            val remaining = if (weekRemaining.isBlank()) null else requireNotNull(weekRemaining.toIntOrNull()?.takeIf { it in 0..1_000_000 }) { "本周剩余应为0到1000000之间的整数。" }
                            problem = null
                            onSave(personal, remaining)
                        } catch (error: IllegalArgumentException) { problem = error.message }
                    },
                    enabled = !loading,
                    modifier = Modifier.testTag("admin-user-save:${user.id}"),
                ) { Text("保存个人次数") }
                Text("本周已用 ${user.weeklyUsed} 次 · 排队预留 ${user.weeklyReserved} 次", style = MaterialTheme.typography.bodySmall)
            }
            SelectionContainer { Text("用户 ID · ${user.id}", style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable
internal fun RegistrationInvitationControls(
    expanded: Boolean,
    loading: Boolean,
    onToggle: () -> Unit,
    onRefresh: () -> Unit,
    onCreate: (Int, Int, ServicePermissions) -> Unit,
) {
    var count by rememberSaveable { mutableStateOf("1") }
    var days by rememberSaveable { mutableStateOf("7") }
    var permissions by rememberSaveable(stateSaver = permissionSelectionSaver) { mutableStateOf(ServicePermissions.All) }
    var problem by remember { mutableStateOf<String?>(null) }
    AdminSection("注册邀请码") {
        TextButton(onClick = onToggle, modifier = Modifier.testTag("admin-invitations-toggle")) {
            Text(if (expanded) "收起邀请码" else "生成与查看未使用邀请码")
        }
        if (expanded) {
            Text("每个邀请码仅限使用一次，勾选的权限会授予使用该邀请码的账号。", style = MaterialTheme.typography.bodySmall)
            NumberField("生成数量", count, !loading) { count = it }
            NumberField("有效天数", days, !loading) { days = it }
            Text("开通权限", style = MaterialTheme.typography.labelLarge)
            PermissionChecks(permissions, !loading, "admin-invite-permissions") { permissions = it }
            problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            ActionRow {
                Button(onClick = {
                    try {
                        val amount = requireNotNull(count.toIntOrNull()?.takeIf { it in 1..100 }) { "每次可生成1到100个邀请码。" }
                        val duration = requireNotNull(days.toIntOrNull()?.takeIf { it in 1..365 }) { "有效天数应为1到365天。" }
                        problem = null
                        onCreate(amount, duration, permissions)
                    } catch (error: IllegalArgumentException) { problem = error.message }
                }, enabled = !loading, modifier = Modifier.testTag("admin-invitations-create")) { Text("生成邀请码") }
                TextButton(onClick = onRefresh, enabled = !loading) { Text("刷新列表") }
            }
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        }
    }
}

private val permissionSelectionSaver = listSaver<ServicePermissions, Boolean>(
    save = { listOf(it.chatApi, it.imageApi, it.cloudSync) },
    restore = { ServicePermissions(it[0], it[1], it[2]) },
)

private fun ServicePermissions.summary() = buildList {
    if (chatApi) add("聊天 API")
    if (imageApi) add("生图 API")
    if (cloudSync) add("云同步")
}.joinToString("、").ifEmpty { "未开通" }

@Composable
private fun PermissionChecks(
    permissions: ServicePermissions,
    enabled: Boolean,
    tag: String,
    onChange: (ServicePermissions) -> Unit,
) {
    ActionRow {
        PermissionCheck("聊天 API", permissions.chatApi, enabled, "$tag:chat") { onChange(permissions.copy(chatApi = it)) }
        PermissionCheck("生图 API", permissions.imageApi, enabled, "$tag:image") { onChange(permissions.copy(imageApi = it)) }
        PermissionCheck("云同步", permissions.cloudSync, enabled, "$tag:sync") { onChange(permissions.copy(cloudSync = it)) }
    }
}

@Composable
private fun PermissionCheck(label: String, checked: Boolean, enabled: Boolean, tag: String, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.heightIn(min = 48.dp).toggleable(checked, enabled = enabled, role = Role.Checkbox, onValueChange = onChange)
            .testTag(tag).padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked, onCheckedChange = null, enabled = enabled)
        Text(label, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
internal fun RegistrationInvitationCard(invitation: AdminRegistrationInvite) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(invitation.code) { mutableStateOf(false) }
    Surface(shape = MaterialTheme.shapes.medium) {
        Column(Modifier.fillMaxWidth().padding(18.dp).testTag("admin-invitation:${invitation.id}"),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!invitation.code.isNullOrBlank()) {
                SelectionContainer { Text(invitation.code, style = MaterialTheme.typography.bodyMedium) }
                TextButton(onClick = {
                    clipboard.setText(AnnotatedString(invitation.code))
                    copied = true
                }, modifier = Modifier.testTag("admin-invitation-copy:${invitation.id}")) { Text(if (copied) "已复制" else "复制邀请码") }
            } else Text("这条邀请码未提供完整内容，请刷新列表。", style = MaterialTheme.typography.bodySmall)
            Text("权限 · ${invitation.permissions.summary()}", style = MaterialTheme.typography.bodySmall)
            Text("到期时间 · ${readableServerTime(invitation.expiresAt)}", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun AdminServerSettings(
    state: AppState,
    controller: AppController,
    run: (suspend () -> Unit) -> Unit,
) {
    LazyColumn(
        Modifier.fillMaxSize().imePadding(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("服务器配置", Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                TextButton(
                    onClick = { run { controller.refreshAdminConfig() } },
                    enabled = !state.adminLoading,
                ) {
                    Text("重新读取")
                }
            }
        }
        if (state.adminLoading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        state.adminError?.let { item { NoticeCard(it) } }
        val config = state.adminConfig
        if (config == null) {
            if (!state.adminLoading && state.adminError == null) item { NoticeCard("请先读取服务器配置。") }
        } else
            item {
                RemoteConfigEditor(
                    config,
                    canSave = !state.adminLoading && state.adminError == null,
                    onSave = { updated, upstreamKey ->
                        run { controller.updateAdminConfig(updated, upstreamKey) }
                    },
                )
            }
    }
}

@Composable
private fun RemoteConfigEditor(
    config: AdminConfig,
    canSave: Boolean,
    onSave: (AdminConfig, String?) -> Unit,
) {
    var publicEnabled by remember(config) { mutableStateOf(config.publicEnabled) }
    var apiEnabled by remember(config) { mutableStateOf(config.apiEnabled) }
    var mockMode by remember(config) { mutableStateOf(config.mockMode) }
    var weeklyLimit by remember(config) { mutableStateOf(config.weeklyLimit.toString()) }
    var userLimit by remember(config) { mutableStateOf(config.userWeeklyLimit.toString()) }
    var model by remember(config) { mutableStateOf(config.model) }
    var baseUrl by remember(config) { mutableStateOf(config.baseUrl) }
    var contextTokens by remember(config) { mutableStateOf(config.contextTokens.toString()) }
    var outputTokens by remember(config) { mutableStateOf(config.maxOutputTokens.toString()) }
    var timeout by remember(config) { mutableStateOf(config.providerTimeoutSeconds.toString()) }
    var upstreamKey by remember { mutableStateOf("") }
    var clearKey by remember(config) { mutableStateOf(false) }
    var fieldError by remember { mutableStateOf<String?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(
            "当前配置版本 · ${config.configVersion}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        SettingToggle("免费服务总开关", publicEnabled, canSave) { publicEnabled = it }
        NumberField("全站每周请求上限", weeklyLimit, canSave) { weeklyLimit = it }
        NumberField("默认每人每周免费次数", userLimit, canSave) { userLimit = it }
        Text("适用于有免费资格的账号，个人单独设置优先。", style = MaterialTheme.typography.bodySmall)
        HorizontalDivider()
        SectionTitle("上游模型")
        SettingToggle("启用上游 API", apiEnabled, canSave) { apiEnabled = it }
        SettingToggle("模拟模式", mockMode, canSave) { mockMode = it }
        OutlinedTextField(
            model,
            { model = it },
            Modifier.fillMaxWidth(),
            label = { Text("模型名称") },
            singleLine = true,
        )
        OutlinedTextField(
            baseUrl,
            { baseUrl = it },
            Modifier.fillMaxWidth(),
            label = { Text("上游服务地址（HTTPS）") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        Text(
            "上游 API Key · ${if (config.apiKeyConfigured) "已配置" else "未配置"}",
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedTextField(
            upstreamKey,
            { upstreamKey = it },
            Modifier.fillMaxWidth(),
            label = { Text("更换上游 API Key（留空保留）") },
            singleLine = true,
            enabled = canSave && !clearKey,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(clearKey, { clearKey = it }, enabled = canSave)
            Text("清除服务器已保存的上游 Key", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
        }
        NumberField("上下文预算（tokens）", contextTokens, canSave) { contextTokens = it }
        NumberField("每次最大输出（tokens）", outputTokens, canSave) { outputTokens = it }
        OutlinedTextField(
            timeout,
            { timeout = it },
            Modifier.fillMaxWidth(),
            label = { Text("上游请求超时（秒）") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        )
        Text(
            "上游费用配置 · ${if (config.costKnown) "已提供" else "未提供"}",
            style = MaterialTheme.typography.bodySmall,
        )
        fieldError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            onClick = {
                try {
                    val total =
                        requireNotNull(weeklyLimit.toIntOrNull()?.takeIf { it >= 0 }) {
                            "全站每周上限应为非负整数"
                        }
                    val personal =
                        requireNotNull(userLimit.toIntOrNull()?.takeIf { it >= 0 }) {
                            "每人每周上限应为非负整数"
                        }
                    val context =
                        requireNotNull(contextTokens.toIntOrNull()?.takeIf { it > 0 }) {
                            "上下文预算应为正整数"
                        }
                    val output =
                        requireNotNull(outputTokens.toIntOrNull()?.takeIf { it > 0 }) {
                            "输出预算应为正整数"
                        }
                    val seconds =
                        requireNotNull(
                            timeout.toDoubleOrNull()?.takeIf { it.isFinite() && it > 0 }
                        ) {
                            "超时应为正数"
                        }
                    val updated =
                        config.copy(
                            publicEnabled = publicEnabled,
                            weeklyLimit = total,
                            userWeeklyLimit = personal,
                            model = model.trim(),
                            baseUrl = baseUrl.trim(),
                            contextTokens = context,
                            maxOutputTokens = output,
                            providerTimeoutSeconds = seconds,
                            apiEnabled = apiEnabled,
                            mockMode = mockMode,
                        )
                    val suppliedKey =
                        if (clearKey) "" else upstreamKey.trim().takeIf { it.isNotEmpty() }
                    upstreamKey = ""
                    fieldError = null
                    onSave(updated, suppliedKey)
                } catch (error: IllegalArgumentException) {
                    fieldError = error.message
                }
            },
            enabled = canSave,
        ) {
            Text("保存服务器配置")
        }
        Text(
            "保存后会重新读取服务器状态，确认实际生效的配置。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun NumberField(
    label: String,
    value: String,
    enabled: Boolean = true,
    onChange: (String) -> Unit,
) {
    OutlinedTextField(
        value,
        onChange,
        Modifier.fillMaxWidth(),
        label = { Text(label) },
        singleLine = true,
        enabled = enabled,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
    )
}

@Composable
private fun SettingToggle(
    label: String,
    checked: Boolean,
    enabled: Boolean = true,
    onChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(label, Modifier.weight(1f))
        Switch(checked, onChange, enabled = enabled)
    }
}

@Composable
private fun AdminSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(shape = MaterialTheme.shapes.medium) {
        Column(
            Modifier.fillMaxWidth().padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(title, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

@Composable
private fun MetricRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Text(value, fontWeight = FontWeight.SemiBold, color = Blue)
    }
}
