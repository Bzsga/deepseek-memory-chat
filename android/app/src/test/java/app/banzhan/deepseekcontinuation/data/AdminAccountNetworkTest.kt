package app.banzhan.deepseekcontinuation.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class AdminAccountNetworkTest {
    private val config = """{"public_enabled":true,"weekly_limit":50,"user_weekly_limit":5,"model":"test-model","base_url":"https://provider.example/v1","api_key_configured":true,"context_tokens":8192,"max_output_tokens":1024,"provider_timeout_seconds":120,"api_enabled":true,"mock_mode":false,"cost_known":false,"config_version":7}"""
    private val user = """{"id":"registered-user","username":"小明_123","registration_kind":"invitation","weekly_limit_override":null,"access_mode":"public","created_at":"2026-11-09T12:00:00+08:00","last_seen_at":null,"weekly_limit":5,"weekly_used":1,"weekly_reserved":1,"weekly_remaining":3,"total_requests":2,"completed":1,"failed":0,"uncertain":0,"cancelled":0,"input_tokens":200,"output_tokens":30}"""
    private fun users(value: String = user) = """{"limit":50,"offset":0,"total":1,"week":"2026-11-09","reset_at":"2026-11-16T00:00:00+08:00","users":[$value]}"""

    @Test fun registrationIsUncappedAndAdminSavesOnlyQuota() {
        val parsed = AdminNetwork.parseAdminConfig(config.dropLast(1) + ",\"public_registration_limit\":10,\"public_registered_count\":20}")
        assertEquals(20, parsed.publicRegisteredCount)
        val patch = json(AdminNetwork.adminPatchPayload(parsed, null))
        assertEquals(5, patch["user_weekly_limit"]!!.jsonPrimitive.int)
        assertFalse(patch.containsKey("public_registration_limit"))
        assertFalse(patch.containsKey("public_registered_count"))
    }

    @Test fun registeredUsersPreserveSourceNullableOverrideAndServerWeek() {
        val page = AdminNetwork.parseAdminUsers(users())
        assertEquals("2026-11-09", page.week)
        assertEquals("2026-11-16T00:00:00+08:00", page.resetAt)
        val parsed = page.users.single()
        assertEquals("小明_123", parsed.username)
        assertEquals("invitation", parsed.registrationKind)
        assertNull(parsed.weeklyLimitOverride)
        assertFalse(parsed.managedEligible)
        assertTrue(AdminNetwork.parseAdminUsers(users(user.dropLast(1) + ",\"managed_eligible\":true}")).users.single().managedEligible)
        assertEquals(3, parsed.weeklyRemaining)
        val override = AdminNetwork.parseAdminUsers(users(user.replace("\"weekly_limit_override\":null", "\"weekly_limit_override\":12"))).users.single()
        assertEquals(12, override.weeklyLimitOverride)
        val oldUser = user.replace("\"username\":\"小明_123\",\"registration_kind\":\"invitation\",\"weekly_limit_override\":null,", "")
        val old = AdminNetwork.parseAdminUsers(users(oldUser)).users.single()
        assertNull(old.username)
        assertNull(old.registrationKind)
        assertNull(old.weeklyLimitOverride)
    }

    @Test fun invalidUserQuotaMetadataAndDatesAreRejected() {
        listOf(
            users(user.replace("\"invitation\"", "\"unknown\"")),
            users(user.replace("\"weekly_limit_override\":null", "\"weekly_limit_override\":-1")),
            users(user.replace("\"weekly_limit_override\":null", "\"weekly_limit_override\":\"5\"")),
            users().replace("\"week\":\"2026-11-09\"", "\"week\":\"2026-02-30\""),
            users().replace("2026-11-16T00:00:00+08:00", "2026-11-15T00:00:00"),
        ).forEach { assertThrows(Exception::class.java) { AdminNetwork.parseAdminUsers(it) } }
    }

    @Test fun quotaPatchDistinguishesFollowingDefaultFromSpecificWeeklyAndCurrentWeekAmounts() {
        val defaults = json(AdminNetwork.userQuotaPayload(null, null, null))
        assertEquals(JsonNull, defaults["weekly_limit"])
        assertFalse(defaults.containsKey("this_week_remaining"))
        assertFalse(defaults.containsKey("week"))
        val patch = json(AdminNetwork.userQuotaPayload(12, 0, "2026-11-09"))
        assertEquals(12, patch["weekly_limit"]!!.jsonPrimitive.int)
        assertEquals(0, patch["this_week_remaining"]!!.jsonPrimitive.int)
        assertEquals("2026-11-09", patch["week"]!!.jsonPrimitive.content)
        assertFalse(patch.containsKey("weekly_used"))
        assertFalse(patch.containsKey("weekly_reserved"))
        // A week is a concurrency guard for this week's adjustment, not a historical quota mutation.
        assertFalse(json(AdminNetwork.userQuotaPayload(5, null, "2026-11-09")).containsKey("week"))
        assertThrows(Exception::class.java) { AdminNetwork.userQuotaPayload(-1, null, null) }
        assertThrows(Exception::class.java) { AdminNetwork.userQuotaPayload(null, 1_000_001, "2026-11-09") }
        assertThrows(Exception::class.java) { AdminNetwork.userQuotaPayload(5, 1, "2026-02-30") }
        assertThrows(Exception::class.java) { AdminNetwork.userQuotaPayload(5, 1, "2026-11-10") }
    }

    @Test fun registeredStatusAndMutationUseAnExplicitBoolean() {
        assertTrue(AdminNetwork.parseAdminUsers(users(user.dropLast(1) + ",\"enabled\":true}")).users.single().enabled)
        assertFalse(AdminNetwork.parseAdminUsers(users(user.dropLast(1) + ",\"enabled\":false}")).users.single().enabled)
        assertThrows(Exception::class.java) {
            AdminNetwork.parseAdminUsers(users(user.dropLast(1) + ",\"enabled\":\"false\"}"))
        }
        val disabled = json(AdminNetwork.userStatusPayload(false))
        assertEquals(setOf("enabled"), disabled.keys)
        assertEquals("false", disabled["enabled"]!!.jsonPrimitive.content)
    }

    @Test fun roleAndEffectivePermissionsAreOptionalButStrictWhenPresent() {
        val old = AdminNetwork.parseAdminUsers(users()).users.single()
        assertNull(old.role)
        assertNull(old.effectivePermissions)

        val effective = """"effective_permissions":{"chat_api":true,"image_api":false,"cloud_sync":true}"""
        val fields = """"role":"admin","permissions":{"chat_api":false,"image_api":false,"cloud_sync":false},$effective"""
        val parsed = AdminNetwork.parseAdminUsers(users(user.dropLast(1) + ",$fields}")).users.single()
        assertEquals("admin", parsed.role)
        assertEquals(ServicePermissions(false, false, false), parsed.servicePermissions)
        assertEquals(ServicePermissions(true, false, true), parsed.effectivePermissions)

        listOf(
            """"role":"owner"""",
            """"role":null""",
            """"effective_permissions":null""",
            """"effective_permissions":{"chat_api":"true","image_api":false,"cloud_sync":true}""",
            """"effective_permissions":{"chat_api":true,"image_api":false}""",
        ).forEach { field ->
            assertThrows(Exception::class.java) { AdminNetwork.parseAdminUsers(users(user.dropLast(1) + ",$field}")) }
        }
    }

    @Test fun searchMatchesNameOrIdAcrossServerPagesAndKeepsTheRequestedFilter() = runBlocking {
        val fixture = AdminNetwork.parseAdminUsers(users())
        val sample = fixture.users.single()
        val requests = mutableListOf<Pair<Int, Int>>()
        val page = AdminNetwork.getUsersPage(1, 10, " MATCH ", AdminUserStatusFilter.DISABLED) { limit, offset ->
            requests += limit to offset
            val entries = when (offset) {
                0 -> List(199) { sample.copy(id = "account-$it") } + sample.copy(id = "duplicate", username = "match")
                200 -> listOf(
                    sample.copy(id = "duplicate", username = "match", enabled = false),
                    sample.copy(id = "user-match", enabled = false),
                    sample.copy(id = "found-by-name", username = "match name", enabled = false),
                )
                else -> error("Unexpected user page")
            }
            fixture.copy(limit = limit, offset = offset, total = 203L, users = entries)
        }
        assertEquals(listOf(200 to 0, 200 to 200), requests)
        assertEquals(2L, page.total)
        assertEquals(1, page.offset)
        assertEquals("found-by-name", page.users.single().id)
        assertEquals(fixture.week, page.week)
        assertEquals(fixture.resetAt, page.resetAt)
        assertEquals("MATCH", page.query)
        assertEquals(AdminUserStatusFilter.DISABLED, page.statusFilter)
    }

    @Test fun plainBrowsingFetchesOnePageExceptWhenItsOffsetNeedsCorrection() = runBlocking {
        val fixture = AdminNetwork.parseAdminUsers(users())
        val requests = mutableListOf<Pair<Int, Int>>()
        suspend fun get(offset: Int) = AdminNetwork.getUsersPage(50, offset, " ", AdminUserStatusFilter.ALL) { limit, start ->
            requests += limit to start
            fixture.copy(limit = limit, offset = start, users = if (start == 0) fixture.users else emptyList())
        }
        assertEquals(fixture, get(0))
        assertEquals(listOf(50 to 0), requests)
        requests.clear()
        assertEquals(fixture, get(50))
        assertEquals(listOf(50 to 50, 50 to 0), requests)
    }

    @Test fun filteredPagingRejectsWeekRollover() = runBlocking {
        val fixture = AdminNetwork.parseAdminUsers(users())
        val problem = runCatching {
            AdminNetwork.getUsersPage(25, 0, "", AdminUserStatusFilter.ENABLED) { limit, offset ->
                fixture.copy(limit = limit, offset = offset, total = 201L,
                    week = if (offset == 0) fixture.week else "2026-11-16")
            }
        }.exceptionOrNull()
        assertTrue(problem is SummaryFailure)
    }

    @Test fun resetLinkMatchesTheRequestedIdentityAndTrustedAccountPage() {
        val service = "https://example.com/deepseek-api"
        val page = "$service/v1/accounts/reset-password"
        val token = "a".repeat(43)
        val link = "$page#token=$token"
        val payload = """{"id":"registered-user","username":"test_user","url":"$link","expires_at":"2026-11-21T12:00:00+08:00"}"""
        val result = AdminNetwork.parsePasswordResetLink(payload, "registered-user", service)
        assertEquals(link, result.url)
        assertEquals("2026-11-21T12:00:00+08:00", result.expiresAt)
        assertFalse(result.toString().contains(token))
        assertThrows(Exception::class.java) {
            AdminNetwork.parsePasswordResetLink(payload, "another-user", service)
        }
        listOf(
            link.replace("https", "http"),
            link.replace("example.com", "example.net"),
            link.replace("accounts", "admin"),
            "$page?token=$token",
            "$page#token=invalid",
        ).forEach { invalid ->
            assertThrows(Exception::class.java) {
                AdminNetwork.parsePasswordResetLink(payload.replace(link, invalid), "registered-user", service)
            }
        }
    }

    @Test fun invitationGetPreservesUnusedCodeAndUsedMetadataWhilePostCanBeMinimal() {
        val payload = """{"invitations":[{"id":"unused","code":"invite_one","expires_at":"2026-12-14T12:00:00+08:00","created_at":"2026-11-09T12:00:00+08:00","redeemed_at":null,"redeemed_by":null},{"id":"used","code":null,"expires_at":"2026-12-14T12:00:00+08:00","created_at":"2026-11-09T12:00:00+08:00","redeemed_at":"2026-11-09T12:05:00+08:00","redeemed_by":"registered-user"}]}"""
        val invites = AdminNetwork.parseRegistrationInvites(payload)
        assertEquals("invite_one", invites[0].code)
        assertNull(invites[0].usedAt)
        assertNull(invites[0].usedBy)
        assertNull(invites[1].code)
        assertEquals("2026-11-09T12:05:00+08:00", invites[1].usedAt)
        assertEquals("registered-user", invites[1].usedBy)
        val created = AdminNetwork.parseRegistrationInvites("""{"invitations":[{"id":"new","code":"invite_new","expires_at":"2026-12-14T12:00:00+08:00"}]}""").single()
        assertEquals("invite_new", created.code)
        assertEquals("", created.createdAt)
        assertNull(created.usedAt)
        assertThrows(Exception::class.java) { AdminNetwork.parseRegistrationInvites(payload.replace("\"invite_one\"", "\"\"")) }
        assertThrows(Exception::class.java) { AdminNetwork.parseRegistrationInvites(payload.replace("2026-11-09T12:05:00+08:00", "bad timestamp")) }
    }

    @Test fun invitationListFetchesAllPagesWithinTheBackendLimit() = runBlocking {
        val requests = mutableListOf<Pair<Int, Int>>()
        val invitations = AdminNetwork.collectRegistrationInvites { limit, offset ->
            requests += limit to offset
            check(requests.size <= 3) { "Unexpected extra page" }
            invitationPage(total = 205, offset = offset, count = minOf(limit, 205 - offset))
        }
        assertEquals(listOf(100 to 0, 100 to 100, 100 to 200), requests)
        assertEquals(205, invitations.size)
        assertEquals(205, invitations.map { it.id }.toSet().size)
        assertEquals("invite-204", invitations.last().id)
        assertEquals("code-204", invitations.last().code)
        val empty = AdminNetwork.collectRegistrationInvites { limit, offset ->
            assertEquals(100, limit)
            assertEquals(0, offset)
            invitationPage(total = 0, offset = 0, count = 0)
        }
        assertTrue(empty.isEmpty())
    }

    @Test fun invitationListRejectsShortChangedDuplicateOrUnsupportedPages() = runBlocking {
        val invalidSecondPages = listOf(
            invitationPage(total = 101, offset = 100, count = 0),
            invitationPage(total = 102, offset = 100, count = 2),
            invitationPage(total = 101, offset = 0, count = 1),
            invitationPage(total = 101, offset = 100, count = 1, firstId = 0),
            invitationPage(total = 101, offset = 100, count = 1).replace("\"code-100\"", "null"),
            invitationPage(total = 101, offset = 100, count = 1).replace("\"limit\":100", "\"limit\":200"),
        )
        invalidSecondPages.forEach { invalid ->
            var requests = 0
            val failure = runCatching {
                AdminNetwork.collectRegistrationInvites { _, offset ->
                    check(++requests <= 2) { "Pagination must stop on an invalid page" }
                    if (offset == 0) invitationPage(total = 101, offset = 0, count = 100) else invalid
                }
            }.exceptionOrNull()
            assertTrue(failure is SummaryFailure)
            assertTrue(failure!!.message.orEmpty().contains("邀请码"))
            assertEquals(2, requests)
        }
    }

    private fun invitationPage(total: Int, offset: Int, count: Int, firstId: Int = offset): String {
        val values = (firstId until firstId + count).joinToString(",") { id ->
            """{"id":"invite-$id","code":"code-$id","expires_at":"2026-12-14T12:00:00+08:00"}"""
        }
        return """{"limit":100,"offset":$offset,"total":$total,"invitations":[$values]}"""
    }

    private fun json(payload: String) = appJson.parseToJsonElement(payload) as JsonObject
}
