@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package app.banzhan.deepseekcontinuation.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.banzhan.deepseekcontinuation.data.AdminUserStatusFilter
import app.banzhan.deepseekcontinuation.data.AdminUsersPage
import app.banzhan.deepseekcontinuation.data.AppController
import app.banzhan.deepseekcontinuation.data.AppState
import app.banzhan.deepseekcontinuation.data.ServicePermissions
import app.banzhan.deepseekcontinuation.data.UserUsage
import kotlinx.coroutines.launch

private const val USERS_PER_PAGE = 25

private enum class UserManagementSection(val title: String) {
    USERS("用户"),
    INVITATIONS("邀请码"),
    RULES("注册与开放"),
}

@Composable
internal fun AdminUsersScreen(
    state: AppState,
    controller: AppController,
    run: (suspend () -> Unit) -> Unit,
) {
    var section by rememberSaveable { mutableStateOf(UserManagementSection.USERS) }
    val sectionState = rememberSaveableStateHolder()
    val keyboardOpen = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    var selectedId by remember { mutableStateOf<String?>(null) }
    val usersPage = state.adminUsers
    val selectedUser = usersPage?.users?.firstOrNull { it.id == selectedId }
    LaunchedEffect(section, state.developerPrefs.serviceUrl, state.developerPrefs.sessionToken) {
        when (section) {
            UserManagementSection.USERS -> if (state.adminConfig == null) run { controller.refreshAdminConfig() }
            UserManagementSection.INVITATIONS -> run { controller.refreshAdminRegistrationInvites() }
            UserManagementSection.RULES -> {
                run { controller.refreshAdminOpenPermissions() }
                run { controller.refreshAdminRegistrationPolicy() }
            }
        }
    }

    LaunchedEffect(selectedId, selectedUser, state.adminUsersLoading) {
        // A saved status change can move this user out of the active filter.
        if (selectedId != null && selectedUser == null && !state.adminUsersLoading) {
            selectedId = null
        }
    }
    if (selectedUser != null) {
        val userId = selectedUser.id
        AdminUserDetailsDialog(
            user = selectedUser,
            defaultLimit = state.adminConfig?.userWeeklyLimit,
            loading = state.adminUsersLoading,
            error = state.adminUsersError,
            onDismiss = { selectedId = null },
            onSetEnabled = { enabled -> run { controller.setAdminUserEnabled(userId, enabled) } },
            onCreateResetLink = { result -> run { result(controller.createAdminPasswordResetLink(userId)) } },
            onSavePermissions = { permissions -> run { controller.updateAdminUserPermissions(userId, permissions) } },
            onSaveQuota = { limit, remaining ->
                run { controller.updateAdminUserQuota(userId, limit, remaining, usersPage.week.takeIf { remaining != null }) }
            },
        )
    }

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 780.dp).fillMaxSize().imePadding()) {
            if (!keyboardOpen) {
                TabRow(
                    selectedTabIndex = section.ordinal,
                    containerColor = MaterialTheme.colorScheme.surface,
                ) {
                    UserManagementSection.entries.forEach { destination ->
                        Tab(
                            selected = section == destination,
                            onClick = { section = destination },
                            text = { Text(destination.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            selectedContentColor = MaterialTheme.colorScheme.primary,
                            unselectedContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.testTag("admin-users-section:${destination.name.lowercase()}"),
                        )
                    }
                }
            }
            sectionState.SaveableStateProvider(section.name) {
                when (section) {
                    UserManagementSection.USERS -> AdminUserDirectory(
                        page = usersPage,
                        loading = state.adminUsersLoading,
                        error = state.adminUsersError,
                        onPage = { offset, query, filter ->
                            run { controller.refreshAdminUsers(USERS_PER_PAGE, offset, query, filter) }
                        },
                        onUser = { selectedId = it.id },
                        openPermissions = state.adminOpenPermissions,
                    )
                    UserManagementSection.INVITATIONS -> AdminInvitationsPage(state, controller, run)
                    UserManagementSection.RULES -> AdminRegistrationRules(state, controller, run)
                }
            }
        }
    }
}

@Composable
internal fun AdminUserDirectory(
    page: AdminUsersPage?,
    loading: Boolean,
    error: String?,
    onPage: (Int, String, AdminUserStatusFilter) -> Unit,
    onUser: (UserUsage) -> Unit,
    openPermissions: ServicePermissions? = null,
) {
    var query by rememberSaveable { mutableStateOf(page?.query.orEmpty()) }
    var searchText by rememberSaveable { mutableStateOf(query) }
    var filter by rememberSaveable { mutableStateOf(page?.statusFilter ?: AdminUserStatusFilter.ALL) }
    val matchingPage = page?.takeIf { it.query == query && it.statusFilter == filter }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val keyboardOpen = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val currentOpenPermissions = openPermissions?.let { arrayListOf(it.chatApi, it.imageApi, it.cloudSync) }
    var requestedOpenPermissions by rememberSaveable { mutableStateOf(currentOpenPermissions) }

    fun loadPage(offset: Int) {
        requestedOpenPermissions = currentOpenPermissions
        onPage(offset, query, filter)
    }

    LaunchedEffect(Unit) {
        if (matchingPage == null && !loading) loadPage(0)
    }
    LaunchedEffect(currentOpenPermissions, loading) {
        if (!loading && matchingPage != null && currentOpenPermissions != null &&
            requestedOpenPermissions != currentOpenPermissions
        ) {
            loadPage(matchingPage.offset)
        }
    }

    fun search(text: String, status: AdminUserStatusFilter = filter) {
        if (loading) return
        query = text.trim()
        searchText = query
        filter = status
        focusManager.clearFocus()
        keyboard?.hide()
        scope.launch { listState.scrollToItem(0) }
        loadPage(0)
    }

    fun showPage(offset: Int) {
        scope.launch { listState.scrollToItem(0) }
        loadPage(offset)
    }

    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 6.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = searchText,
                    onValueChange = { searchText = it.take(100) },
                    modifier = Modifier.weight(1f).testTag("admin-user-search"),
                    label = { Text("搜索用户") },
                    placeholder = { Text("用户名或用户 ID") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { search(searchText) }),
                    trailingIcon = if (searchText.isNotEmpty()) {
                        {
                            IconButton(onClick = { search("") }, enabled = !loading) {
                                Icon(Icons.Outlined.Close, contentDescription = "清除搜索")
                            }
                        }
                    } else null,
                )
                TextButton(
                    onClick = { search(searchText) },
                    enabled = !loading,
                    modifier = Modifier.testTag("admin-user-search-submit"),
                ) { Text("搜索") }
            }
            ActionRow {
                AdminUserStatusFilter.entries.forEach { status ->
                    FilterChip(
                        selected = filter == status,
                        onClick = { if (status != filter) search(query, status) },
                        enabled = !loading,
                        label = {
                            Text(when (status) {
                                AdminUserStatusFilter.ALL -> "全部"
                                AdminUserStatusFilter.ENABLED -> "已启用"
                                AdminUserStatusFilter.DISABLED -> "已停用"
                            })
                        },
                        modifier = Modifier.testTag("admin-user-filter:${status.name.lowercase()}"),
                    )
                }
                TextButton(
                    onClick = { loadPage(matchingPage?.offset ?: 0) },
                    enabled = !loading,
                    modifier = Modifier.testTag("admin-user-refresh"),
                ) { Text("刷新") }
            }
        }
        if (loading) {
            LinearProgressIndicator(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.primary)
        }
        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f),
            state = listState,
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            error?.let { message ->
                item {
                    NoticeCard(if (matchingPage == null) message else "$message\n当前显示上次读取的列表。")
                }
            }
            if (matchingPage == null && !loading && error == null) {
                item { NoticeCard("正在读取用户列表。") }
            }
            if (matchingPage != null) {
                if (matchingPage.total <= matchingPage.limit) {
                    item {
                        Text(
                            "共 ${matchingPage.total} 位用户",
                            modifier = Modifier.padding(vertical = 3.dp),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (matchingPage.users.isEmpty() && !loading) {
                    item { NoticeCard(if (query.isEmpty() && filter == AdminUserStatusFilter.ALL) "暂无注册用户。" else "没有符合当前条件的用户。") }
                }
                items(matchingPage.users, key = { it.id }) { user ->
                    AdminUserSummary(user, enabled = !loading) { onUser(user) }
                }
            }
        }
        if (matchingPage != null && !keyboardOpen) {
            AdminUserPagination(matchingPage, loading, onPage = ::showPage)
        }
    }
}

@Composable
private fun AdminUserPagination(page: AdminUsersPage, loading: Boolean, onPage: (Int) -> Unit) {
    val lastVisible = page.offset.toLong() + page.users.size
    val hasPrevious = page.offset > 0
    val hasNext = lastVisible < page.total
    if (!hasPrevious && !hasNext) return

    HorizontalDivider()
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(
            onClick = { onPage((page.offset - page.limit).coerceAtLeast(0)) },
            enabled = !loading && hasPrevious,
            modifier = Modifier.testTag("admin-user-prev"),
        ) { Text("上一页") }
        Text(
            if (page.users.isEmpty()) "共 ${page.total} 位用户" else "${page.offset + 1}–$lastVisible / ${page.total}",
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        TextButton(
            onClick = { onPage(page.offset + page.limit) },
            enabled = !loading && hasNext,
            modifier = Modifier.testTag("admin-user-next"),
        ) { Text("下一页") }
    }
}

@Composable
private fun AdminUserSummary(user: UserUsage, enabled: Boolean, onClick: () -> Unit) {
    val permissions = user.effectivePermissions ?: user.servicePermissions
    val colors = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().testTag("admin-user-row:${user.id}"),
        shape = MaterialTheme.shapes.medium,
        color = colors.surfaceContainerLow,
    ) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        user.username ?: user.id,
                        modifier = Modifier.weight(1f, fill = false),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Surface(
                        shape = MaterialTheme.shapes.extraSmall,
                        color = if (user.enabled) colors.secondaryContainer else colors.errorContainer,
                    ) {
                        Text(
                            if (user.enabled) "启用" else "停用",
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            color = if (user.enabled) colors.onSecondaryContainer else colors.onErrorContainer,
                            style = MaterialTheme.typography.labelSmall,
                        )
                    }
                }
                val access = if (user.enabled) permissions.summary() else "服务已停用"
                Text(
                    if (user.role == "admin") "管理员 · $access" else access,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (user.enabled && permissions.hasManagedApi) {
                Column(horizontalAlignment = Alignment.End) {
                    Text("${user.weeklyRemaining} 次", style = MaterialTheme.typography.titleSmall)
                    Text("本周剩余", style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
                }
            }
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = colors.onSurfaceVariant)
        }
    }
}

@Composable
private fun AdminInvitationsPage(state: AppState, controller: AppController, run: (suspend () -> Unit) -> Unit) {
    var creating by rememberSaveable { mutableStateOf(false) }
    var invitationCount by rememberSaveable { mutableIntStateOf(10) }
    val invitations = state.adminRegistrationInvites?.filter { it.usedAt == null }
    val refresh = { run { controller.refreshAdminRegistrationInvites() } }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            RegistrationInvitationControls(
                expanded = creating,
                loading = state.adminRegistrationLoading,
                onToggle = { creating = !creating },
                onRefresh = refresh,
                onCreate = { count, days, permissions ->
                    run { controller.createAdminRegistrationInvites(count, days, permissions) }
                },
            )
        }
        state.adminRegistrationError?.let { item { NoticeCard(it) } }
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("未使用的邀请码", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                if (!creating) TextButton(onClick = refresh, enabled = !state.adminRegistrationLoading) { Text("刷新") }
            }
            if (state.adminRegistrationLoading && !creating) LinearProgressIndicator(Modifier.fillMaxWidth())
        }
        if (invitations?.isEmpty() == true) item { NoticeCard("还没有未使用的邀请码。") }
        items(invitations.orEmpty().take(invitationCount), key = { it.id }) { invitation ->
            RegistrationInvitationCard(invitation)
        }
        if ((invitations?.size ?: 0) > invitationCount) item {
            TextButton(onClick = { invitationCount += 10 }) { Text("显示更多邀请码") }
        }
    }
}

@Composable
private fun AdminRegistrationRules(state: AppState, controller: AppController, run: (suspend () -> Unit) -> Unit) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
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
    }
}
