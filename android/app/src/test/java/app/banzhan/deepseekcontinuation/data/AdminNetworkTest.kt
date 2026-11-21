package app.banzhan.deepseekcontinuation.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AdminNetworkTest {
    @Test
    fun adminConfigPreservesCountersAndReadOnlyFlags() {
        val config = AdminNetwork.parseAdminConfig(configPayload())
        assertTrue(config.publicEnabled)
        assertEquals(50, config.weeklyLimit)
        assertEquals(3, config.userWeeklyLimit)
        assertTrue(config.apiKeyConfigured)
        assertEquals(120.0, config.providerTimeoutSeconds, 0.0)
        assertEquals(7, config.configVersion)
    }

    @Test
    fun secretPatchDistinguishesPreserveClearAndReplace() {
        val config = AdminNetwork.parseAdminConfig(configPayload())
        val preserve = json(AdminNetwork.adminPatchPayload(config, null))
        assertFalse(preserve.containsKey("api_key"))
        assertFalse(preserve.containsKey("api_key_configured"))
        assertFalse(preserve.containsKey("config_version"))
        assertFalse(preserve.containsKey("api_enabled"))
        assertEquals("", json(AdminNetwork.adminPatchPayload(config, ""))["api_key"]!!.jsonPrimitive.content)
        assertEquals("test-upstream-key", json(AdminNetwork.adminPatchPayload(config, "test-upstream-key"))["api_key"]!!.jsonPrimitive.content)
    }

    @Test
    fun malformedAdminValuesAndUnsafeProviderSettingsAreRejected() {
        listOf(
            configPayload().replace("\"weekly_limit\":50", "\"weekly_limit\":-1"),
            configPayload().replace("\"weekly_limit\":50", "\"weekly_limit\":1.5"),
            configPayload().replace("\"public_enabled\":true", "\"public_enabled\":\"true\""),
            configPayload().replace("\"context_tokens\":8192", "\"context_tokens\":512"),
            configPayload().replace("\"provider_timeout_seconds\":120", "\"provider_timeout_seconds\":1e999"),
            configPayload().replace("https://provider.example/v1", "http://provider.example/v1")
        ).forEach { payload -> assertThrows(Exception::class.java) { AdminNetwork.parseAdminConfig(payload) } }
        val config = AdminNetwork.parseAdminConfig(configPayload())
        assertThrows(IllegalArgumentException::class.java) { AdminNetwork.adminPatchPayload(config, "x".repeat(4097)) }
    }

    @Test
    fun serverErrorsRedactLongSecretsBeforeDisplayTruncation() {
        val upstream = "test-upstream-" + "x".repeat(700)
        val token = "test-admin-session"
        val detail = "upstream=$upstream token=$token"
        val safe = SummaryNetwork.redactSecrets(detail, listOf(token, upstream)).take(500)
        assertFalse(safe.contains("test-upstream"))
        assertFalse(safe.contains(token))
        assertTrue(safe.contains("[已隐藏]"))
        assertEquals("[已隐藏] [已隐藏]", SummaryNetwork.redactSecrets("test-key-long test-key", listOf("test-key", "test-key-long")))
    }

    @Test
    fun statisticsKeepDailyTrendsAndWeeklyReservations() {
        val stats = AdminNetwork.parseAdminStats(statsPayload())
        assertEquals(3_000_000_000L, stats.totals.inputTokens)
        assertEquals(1, stats.thisWeek.weeklyReserved)
        assertEquals(7, stats.thisWeek.weeklyRemaining)
        assertEquals("2026-11-03", stats.daily.single().date)
        assertNull(stats.totals.usageKnownRequests)
        assertNull(stats.totals.usageUnknownRequests)
        assertNull(stats.daily.single().usageKnownRequests)
        assertNull(stats.daily.single().usageUnknownRequests)
        assertThrows(Exception::class.java) {
            AdminNetwork.parseAdminStats(statsPayload().replace("\"input_tokens\":3000000000", "\"input_tokens\":-1"))
        }
    }

    @Test
    fun paginatedUsersParseNullableLastSeenAndRejectInvalidCounts() {
        val page = AdminNetwork.parseAdminUsers(usersPayload())
        assertEquals(1L, page.total)
        val user = page.users.single()
        assertEquals("public", user.accessMode)
        assertNull(user.lastSeenAt)
        assertEquals(3_000_000_000L, user.inputTokens)
        assertNull(user.usageKnownRequests)
        assertNull(user.usageUnknownRequests)
        assertThrows(Exception::class.java) {
            AdminNetwork.parseAdminUsers(usersPayload().replace("\"weekly_used\":1", "\"weekly_used\":-1"))
        }
        assertThrows(Exception::class.java) {
            AdminNetwork.parseAdminUsers(usersPayload().replace("\"limit\":50", "\"limit\":0"))
        }
    }

    @Test
    fun administratorPermissionsAreExplicitAndLegacyEligibilityStillParses() {
        val permissions = ServicePermissions(chatApi = false, imageApi = true, cloudSync = false)
        val encoded = permissions.toWireJson()
        assertEquals(mapOf("chat_api" to JsonPrimitive(false), "image_api" to JsonPrimitive(true),
            "cloud_sync" to JsonPrimitive(false)), encoded.toMap())
        assertEquals(encoded, json(AdminNetwork.registrationInvitePayload(1, 7, permissions))["permissions"])
        val payload = usersPayload().replace("\"last_seen_at\":null", "\"last_seen_at\":null,\"permissions\":$encoded")
        assertEquals(permissions, AdminNetwork.parseAdminUsers(payload).users.single().servicePermissions)
        assertEquals(ServicePermissions.All, AdminNetwork.parseAdminUsers(usersPayload().replace(
            "\"last_seen_at\":null", "\"last_seen_at\":null,\"managed_eligible\":true"
        )).users.single().servicePermissions)
        val invite = """{"id":"invite-id","expires_at":"2026-11-21T00:00:00+08:00"}"""
        assertEquals(ServicePermissions.All, AdminNetwork.parseRegistrationInvites("""{"invitations":[$invite]}""").single().permissions)
        assertEquals(permissions, AdminNetwork.parseRegistrationInvites(
            """{"invitations":[${invite.dropLast(1)},"permissions":$encoded}]}"""
        ).single().permissions)
    }

    @Test
    fun globalPermissionsUseFlatStrictBooleanFields() {
        val permissions = ServicePermissions(chatApi = false, imageApi = true, cloudSync = false)
        val valid = permissions.toWireJson().toString()
        assertEquals(permissions, AdminNetwork.parseOpenPermissions(valid))
        val invalid = listOf(
            """{"chat_api":false,"image_api":"true","cloud_sync":false}""",
            """{"chat_api":false,"image_api":1,"cloud_sync":false}""",
            """{"chat_api":false,"image_api":true,"cloud_sync":null}""",
            """{"chat_api":false,"image_api":true}""",
            """{"chat_api":false,"image_api":true,"cloud_sync":false,"extra":true}""",
            """{"permissions":$valid}""",
        )
        invalid.forEach { payload ->
            assertThrows(IllegalArgumentException::class.java) { AdminNetwork.parseOpenPermissions(payload) }
        }
    }

    @Test
    fun globalPermissionsPatchUsesTheHttpsOriginWithoutEndpointPath() {
        val permissions = ServicePermissions(chatApi = true, imageApi = false, cloudSync = true)
        val token = "synthetic-admin-token"
        val prefs = DeveloperPrefs(serviceUrl = "https://admin.example:8443/deepseek-api/v1/", sessionToken = token)
        val request = AdminNetwork.openPermissionsPatchRequest(prefs, permissions)
        assertEquals("PATCH", request.method)
        assertEquals("https://admin.example:8443/deepseek-api/v1/admin/account-feature-access", request.url.toString())
        assertEquals("https://admin.example:8443", request.header("Origin"))
        assertEquals("Bearer $token", request.header("Authorization"))
        val body = Buffer()
        assertTrue(request.body!!.isOneShot())
        request.body!!.writeTo(body)
        assertEquals(permissions.toWireJson(), json(body.readUtf8()))

        val official = AdminNetwork.openPermissionsPatchRequest(
            prefs.copy(serviceUrl = "https://digimonlegend.com:443/deepseek-api"), permissions,
        )
        assertEquals("https://digimonlegend.com", official.header("Origin"))
        assertEquals("/deepseek-api/v1/admin/account-feature-access", official.url.encodedPath)
        assertThrows(IllegalArgumentException::class.java) {
            AdminNetwork.openPermissionsPatchRequest(prefs.copy(serviceUrl = "http://admin.example"), permissions)
        }
    }

    @Test
    fun registrationPolicyPatchKeepsTheAdminOriginAndWritesOnlyItsFlag() {
        val prefs = DeveloperPrefs(serviceUrl = "https://admin.example:8443/deepseek-api", sessionToken = "synthetic-admin-token")
        val request = AdminNetwork.registrationPolicyPatchRequest(prefs, false)
        assertEquals("PATCH", request.method)
        assertEquals("/deepseek-api/v1/admin/registration-policy", request.url.encodedPath)
        assertEquals("https://admin.example:8443", request.header("Origin"))
        assertEquals("Bearer synthetic-admin-token", request.header("Authorization"))
        val body = Buffer()
        assertTrue(request.body!!.isOneShot())
        request.body!!.writeTo(body)
        assertEquals("""{"self_service":false}""", body.readUtf8())
    }

    @Test
    fun reportedAndUnknownUsageCountsRemainDistinctIncludingExplicitZero() {
        val statsJson = statsPayload().replace("\"requests\":3,", "\"requests\":3,\"usage_known_requests\":2,\"usage_unknown_requests\":1,")
        val stats = AdminNetwork.parseAdminStats(statsJson)
        assertEquals(2L, stats.totals.usageKnownRequests)
        assertEquals(1L, stats.totals.usageUnknownRequests)
        assertEquals(2L, stats.daily.single().usageKnownRequests)
        assertEquals(1L, stats.daily.single().usageUnknownRequests)
        val usersJson = usersPayload().replace("\"total_requests\":1,", "\"total_requests\":1,\"usage_known_requests\":1,\"usage_unknown_requests\":0,")
        val user = AdminNetwork.parseAdminUsers(usersJson).users.single()
        assertEquals(1L, user.usageKnownRequests)
        assertEquals(0L, user.usageUnknownRequests)
        assertThrows(Exception::class.java) {
            AdminNetwork.parseAdminStats(statsJson.replace("\"usage_unknown_requests\":1", "\"usage_unknown_requests\":-1"))
        }
        assertThrows(Exception::class.java) {
            AdminNetwork.parseAdminUsers(usersJson.replace("\"usage_known_requests\":1", "\"usage_known_requests\":\"1\""))
        }
    }

    private fun json(value: String): JsonObject = SummaryProtocol.json.parseToJsonElement(value) as JsonObject

    private fun statsPayload(): String = """
        {"timezone":"Asia/Shanghai","days":1,"start_date":"2026-11-03","end_date":"2026-11-03","generated_at":"2026-11-03T12:00:00+08:00",
        "totals":{"users":2,"new_users":1,"active_users":1,"requests":3,"input_tokens":3000000000,"output_tokens":10,"completed":1,"failed":1,"uncertain":0,"cancelled":0,"queued":1,"running":0},
        "this_week":{"weekly_limit":10,"weekly_used":2,"weekly_reserved":1,"weekly_remaining":7,"reset_at":"2026-11-09T00:00:00+08:00"},
        "daily":[{"date":"2026-11-03","new_users":1,"active_users":1,"requests":3,"input_tokens":3000000000,"output_tokens":10,"completed":1,"failed":1,"uncertain":0,"cancelled":0}]}
    """.trimIndent()

    private fun usersPayload(): String = """
        {"limit":50,"offset":0,"total":1,"users":[{"id":"user-id","access_mode":"public","created_at":"2026-11-03T12:00:00+08:00","last_seen_at":null,
        "weekly_limit":3,"weekly_used":1,"weekly_reserved":0,"weekly_remaining":2,"total_requests":1,"completed":1,"failed":0,"uncertain":0,"cancelled":0,"input_tokens":3000000000,"output_tokens":10}]}
    """.trimIndent()

    private fun configPayload(): String =
        """{"public_enabled":true,"weekly_limit":50,"user_weekly_limit":3,"model":"test-model","base_url":"https://provider.example/v1","api_key_configured":true,"context_tokens":8192,"max_output_tokens":1024,"provider_timeout_seconds":120,"api_enabled":true,"mock_mode":false,"cost_known":false,"config_version":7}"""
}
