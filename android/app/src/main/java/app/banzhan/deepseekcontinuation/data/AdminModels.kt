package app.banzhan.deepseekcontinuation.data

internal fun AccountSession?.adminCredentials(): DeveloperPrefs {
    if (this == null || user.role != "admin" || accountSessionExpired(this)) return DeveloperPrefs()
    return DeveloperPrefs(serviceUrl, token, expiresAt)
}

data class DeveloperPrefs(
    val serviceUrl: String = ServiceSettings().companionUrl,
    val sessionToken: String = "",
    val expiresAt: String = "",
) {
    override fun toString(): String = "DeveloperPrefs(serviceUrl=$serviceUrl, sessionToken=[hidden], expiresAt=$expiresAt)"
}

data class AdminConfig(
    val publicEnabled: Boolean,
    val weeklyLimit: Int,
    val userWeeklyLimit: Int,
    val model: String,
    val baseUrl: String,
    val apiKeyConfigured: Boolean,
    val contextTokens: Int,
    val maxOutputTokens: Int,
    val providerTimeoutSeconds: Double,
    val apiEnabled: Boolean,
    val mockMode: Boolean,
    val costKnown: Boolean,
    val configVersion: Int,
    val publicRegisteredCount: Int = 0,
)

data class AdminTotals(
    val users: Long, val newUsers: Long, val activeUsers: Long, val requests: Long,
    val inputTokens: Long, val outputTokens: Long,
    val completed: Long, val failed: Long, val uncertain: Long, val cancelled: Long,
    val queued: Long, val running: Long,
    val usageKnownRequests: Long? = null,
    val usageUnknownRequests: Long? = null,
)

data class AdminWeekQuota(
    val weeklyLimit: Int, val weeklyUsed: Int, val weeklyReserved: Int, val weeklyRemaining: Int,
    val resetAt: String,
)

data class AdminDailyUsage(
    val date: String, val newUsers: Long, val activeUsers: Long, val requests: Long,
    val inputTokens: Long, val outputTokens: Long,
    val completed: Long, val failed: Long, val uncertain: Long, val cancelled: Long,
    val usageKnownRequests: Long? = null,
    val usageUnknownRequests: Long? = null,
)

data class AdminStats(
    val timezone: String, val days: Int, val startDate: String, val endDate: String,
    val generatedAt: String, val totals: AdminTotals, val thisWeek: AdminWeekQuota,
    val daily: List<AdminDailyUsage>,
)

data class AdminStorage(
    val syncBytes: Long,
    val syncLimitBytes: Long,
    val shareBytes: Long,
    val shareLimitBytes: Long,
    val diskFreeBytes: Long,
    val diskReserveBytes: Long,
    val warning: Boolean,
)

enum class AdminDiagnosticsRange(val days: Int) {
    LAST_24_HOURS(1),
    LAST_7_DAYS(7),
    LAST_30_DAYS(30),
}

enum class AdminDiagnosticsStatus(val wireValue: String) {
    PENDING("pending"), RESOLVED("resolved"),
}

data class AdminDiagnosticsPage(
    val range: AdminDiagnosticsRange,
    val groups: List<AdminDiagnosticGroup>,
    val retentionDays: Int,
    val status: AdminDiagnosticsStatus = AdminDiagnosticsStatus.PENDING,
    val since: Long = 0,
    val supportsResolution: Boolean = false,
)

data class AdminDiagnosticResolution(
    val eventId: String,
    val resolved: Boolean,
    val groupSince: Long? = null,
)

data class AdminDiagnosticGroup(
    val source: String,
    val area: String,
    val code: String,
    val stage: String?,
    val count: Long,
    val firstAt: Long,
    val lastAt: Long,
    val lastReceivedAt: Long,
    val latestEventId: String,
    val releases: List<AdminDiagnosticRelease>,
    val models: List<AdminDiagnosticModel>,
)

data class AdminDiagnosticRelease(val release: String, val count: Long)
data class AdminDiagnosticModel(val manufacturer: String?, val model: String, val count: Long)

data class AdminDiagnosticDetail(
    val event: AdminDiagnosticEvent?,
    val relatedEvents: List<AdminDiagnosticEvent>,
    val retentionDays: Int,
    val supportsResolution: Boolean = false,
)

data class AdminDiagnosticEvent(
    val eventId: String,
    val occurredAt: Long,
    val receivedAt: Long,
    val source: String,
    val release: String,
    val area: String,
    val code: String,
    val stage: String?,
    val androidSdk: Int?,
    val manufacturer: String?,
    val model: String?,
    val webviewVersion: String?,
    val webviewProvider: String?,
    val httpStatus: Int?,
    val elapsedMs: Long?,
    val requestId: String?,
    val detail: String? = null,
    val inputFormat: String? = null,
    val inputSizeBand: String? = null,
    val serviceMode: String? = null,
    val resolvedAt: Long? = null,
)

data class UserUsage(
    val id: String, val accessMode: String, val createdAt: String, val lastSeenAt: String?,
    val weeklyLimit: Int, val weeklyUsed: Int, val weeklyReserved: Int, val weeklyRemaining: Int,
    val totalRequests: Long, val completed: Long, val failed: Long, val uncertain: Long,
    val cancelled: Long, val inputTokens: Long, val outputTokens: Long,
    val usageKnownRequests: Long? = null,
    val usageUnknownRequests: Long? = null,
    val username: String? = null,
    val registrationKind: String? = null,
    val weeklyLimitOverride: Int? = null,
    val enabled: Boolean = true,
    val managedEligible: Boolean = false,
    val permissions: ServicePermissions? = null,
    val inviteRedeemable: Boolean? = null,
    val role: String? = null,
    val effectivePermissions: ServicePermissions? = null,
) {
    val servicePermissions: ServicePermissions get() = permissions ?: ServicePermissions.fromLegacy(managedEligible)
}

enum class AdminUserStatusFilter { ALL, ENABLED, DISABLED }

data class AdminUsersPage(
    val limit: Int,
    val offset: Int,
    val total: Long,
    val users: List<UserUsage>,
    val week: String? = null,
    val resetAt: String? = null,
    val query: String = "",
    val statusFilter: AdminUserStatusFilter = AdminUserStatusFilter.ALL,
)

data class AdminRegistrationInvite(
    val id: String,
    val code: String? = null,
    val expiresAt: String,
    val createdAt: String = "",
    val usedAt: String? = null,
    val usedBy: String? = null,
    val permissions: ServicePermissions = ServicePermissions.All,
)

/** Returned once to the active administrator UI; never persisted in AppState or backups. */
data class AdminPasswordResetLink(val id: String, val username: String, val url: String, val expiresAt: String) {
    override fun toString(): String = "AdminPasswordResetLink(id=$id, username=$username, expiresAt=$expiresAt)"
}
