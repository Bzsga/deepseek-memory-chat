package app.banzhan.deepseekcontinuation.data

import java.time.OffsetDateTime
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Serializable
data class ServicePermissions(val chatApi: Boolean, val imageApi: Boolean, val cloudSync: Boolean) {
    val hasManagedApi: Boolean get() = chatApi || imageApi

    companion object {
        val All = ServicePermissions(chatApi = true, imageApi = true, cloudSync = true)
        val None = ServicePermissions(chatApi = false, imageApi = false, cloudSync = false)
        fun fromLegacy(eligible: Boolean) = if (eligible) All else None
    }
}

internal fun JsonObject.readServicePermissions(): ServicePermissions? {
    val value = this["permissions"] ?: return null
    val fields = value as? JsonObject ?: error("服务权限格式无效")
    return ServicePermissions(
        chatApi = fields.readAccountFlag("chat_api") ?: error("服务权限缺少聊天 API"),
        imageApi = fields.readAccountFlag("image_api") ?: error("服务权限缺少生图 API"),
        cloudSync = fields.readAccountFlag("cloud_sync") ?: error("服务权限缺少云同步"),
    )
}

internal fun JsonObject.readAccountFlag(key: String): Boolean? {
    val value = this[key] ?: return null
    return (value as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull
        ?: error("账户权限中的 $key 无效")
}

internal fun ServicePermissions.toWireJson(): JsonObject = buildJsonObject {
    put("chat_api", chatApi)
    put("image_api", imageApi)
    put("cloud_sync", cloudSync)
}

@Serializable
data class AccountUser(
    val id: String,
    val username: String,
    val registrationKind: String,
    val createdAt: String,
    val role: String = "user",
    val managedEligible: Boolean = true, // Serialized sessions predating eligibility were already sponsored.
    val permissions: ServicePermissions? = null,
    val inviteRedeemable: Boolean? = null,
) {
    val servicePermissions: ServicePermissions get() = permissions ?: ServicePermissions.fromLegacy(managedEligible)
}

/** Stored only in the device's encrypted credentials, never in service settings or backups. */
@Serializable
data class AccountSession(
    val serviceUrl: String,
    val token: String,
    val expiresAt: String,
    val user: AccountUser,
) {
    override fun toString(): String =
        "AccountSession(serviceUrl=$serviceUrl, token=[hidden], expiresAt=$expiresAt, user=$user)"
}

data class AccountState(
    val currentUser: AccountUser? = null,
    val loading: Boolean = false,
    val error: String? = null,
)

data class AccountAuthentication(val session: AccountSession, val quota: CompanionQuota)

data class AccountProfile(val user: AccountUser, val quota: CompanionQuota)

internal fun accountSessionExpired(session: AccountSession, nowMillis: Long = System.currentTimeMillis()): Boolean =
    session.token.isBlank() || runCatching {
        OffsetDateTime.parse(session.expiresAt).toInstant().toEpochMilli() <= nowMillis
    }.getOrDefault(true)
