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
)

data class AdminUsersPage(val limit: Int, val offset: Int, val total: Long, val users: List<UserUsage>,
    val week: String? = null, val resetAt: String? = null)

data class AdminRegistrationInvite(
    val id: String,
    val code: String? = null,
    val expiresAt: String,
    val createdAt: String = "",
    val usedAt: String? = null,
    val usedBy: String? = null,
)

/** Returned once to the active administrator UI; never persisted in AppState or backups. */
data class AdminPasswordReset(val id: String, val username: String, val password: String) {
    override fun toString(): String = "AdminPasswordReset(id=$id, username=$username, password=[hidden])"
}
