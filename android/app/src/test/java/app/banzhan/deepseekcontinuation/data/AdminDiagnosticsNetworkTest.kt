package app.banzhan.deepseekcontinuation.data

import java.util.Locale
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class AdminDiagnosticsNetworkTest {
    private val prefs = DeveloperPrefs("https://example.com/deepseek-api", "test-admin-session")
    private val eventId = "cd2de825-a583-4505-a1e7-1348848a7d90"
    private val relatedId = "2cc7afaa-9fef-42c9-b882-0e0e3ec36265"
    private val requestId = "cabd9415-ddfc-416d-b393-a303a6e70530"

    @Test fun diagnosticRequestsUseAdminSessionAndSelectedTimeWindow() {
        val now = 1_800_000_000L
        for (range in AdminDiagnosticsRange.entries) {
            val request = AdminNetwork.diagnosticsGroupsRequest(prefs, range, now)
            assertEquals("/deepseek-api/v1/admin/technical-diagnostics", request.url.encodedPath)
            assertEquals("GET", request.method)
            assertEquals("Bearer test-admin-session", request.header("Authorization"))
            assertEquals("50", request.url.queryParameter("limit"))
            assertEquals((now - range.days * 86_400L).toString(), request.url.queryParameter("since"))
            assertEquals("pending", request.url.queryParameter("status"))
        }
        val lookup = AdminNetwork.diagnosticDetailRequest(prefs, "  ${eventId.uppercase(Locale.ROOT)}  ")
        assertEquals(eventId, lookup.url.queryParameter("event_id"))
        assertNull(lookup.url.queryParameter("since"))
        assertThrows(IllegalArgumentException::class.java) {
            AdminNetwork.diagnosticDetailRequest(prefs, "not-a-diagnostic-id")
        }
        val resolved = AdminNetwork.diagnosticsGroupsRequest(
            prefs, AdminDiagnosticsRange.LAST_24_HOURS, now, AdminDiagnosticsStatus.RESOLVED,
        )
        assertEquals("resolved", resolved.url.queryParameter("status"))
    }

    @Test fun resolutionTargetsTheExactRecordOrGroupSnapshot() {
        val markGroup = AdminNetwork.diagnosticResolutionRequest(prefs, AdminDiagnosticResolution(eventId, true, 1_795_208_400L))
        assertEquals("PUT", markGroup.method)
        assertEquals("/deepseek-api/v1/admin/technical-diagnostics/$eventId/resolution", markGroup.url.encodedPath)
        assertEquals("https://example.com", markGroup.header("Origin"))
        assertEquals("Bearer test-admin-session", markGroup.header("Authorization"))
        assertEquals("""{"resolved":true,"group":true,"since":1795208400}""",
            Buffer().also { markGroup.body!!.writeTo(it) }.readUtf8())
        val reopenSingle = AdminNetwork.diagnosticResolutionRequest(prefs,
            AdminDiagnosticResolution(eventId.uppercase(Locale.ROOT), false))
        assertEquals(markGroup.url, reopenSingle.url)
        assertEquals("""{"resolved":false}""", Buffer().also { reopenSingle.body!!.writeTo(it) }.readUtf8())
        assertThrows(IllegalArgumentException::class.java) {
            AdminNetwork.diagnosticResolutionRequest(prefs, AdminDiagnosticResolution("invalid", true))
        }
    }

    @Test fun parsesGroupsWithReleaseAndDeviceBreakdowns() {
        val payload = """{"retention_days":30,"groups":[{"source":"android","area":"webview","code":"update_required",
            "stage":"initialize","count":2,"first_at":1795228000,"last_at":1795228100,"last_received_at":1795228300,
            "latest_event_id":"$eventId","releases":[{"release":"2.6.16","count":2}],
            "models":[{"manufacturer":null,"model":"Test Device","count":2}]}]}"""
        val page = AdminNetwork.parseAdminDiagnostics(payload, AdminDiagnosticsRange.LAST_7_DAYS)
        val group = page.groups.single()
        assertEquals(AdminDiagnosticsRange.LAST_7_DAYS, page.range)
        assertFalse(page.supportsResolution)
        assertEquals(30, page.retentionDays)
        assertEquals("update_required", group.code)
        assertEquals(2L, group.count)
        assertEquals(1795228300L, group.lastReceivedAt)
        assertEquals(eventId, group.latestEventId)
        assertEquals(AdminDiagnosticRelease("2.6.16", 2), group.releases.single())
        assertEquals(AdminDiagnosticModel(null, "Test Device", 2), group.models.single())
        val resolved = AdminNetwork.parseAdminDiagnostics(payload.replaceFirst("{", "{\"supports_resolution\":true,"),
            AdminDiagnosticsRange.LAST_7_DAYS, AdminDiagnosticsStatus.RESOLVED, 1_795_000_000L)
        assertTrue(resolved.supportsResolution)
        assertEquals(AdminDiagnosticsStatus.RESOLVED, resolved.status)
        assertEquals(1_795_000_000L, resolved.since)
    }

    @Test fun distinguishesMissingDetailAndRejectsUnrelatedEvents() {
        val event = """{"event_id":"$eventId","occurred_at":1795228000,"received_at":1795228300,"source":"android",
            "release":"2.6.16","area":"webview","code":"load_failed","stage":"initialize","webview_version":"103.0.5060.129",
            "android_sdk":29,"model":"Test Device","webview_provider":"com.android.webview","request_id":"$requestId"}"""
        val related = event.replace(eventId, relatedId)
        val payload = """{"event":$event,"related_events":[$related],"retention_days":30}"""
        val detail = AdminNetwork.parseAdminDiagnostic(payload, eventId)
        assertEquals(eventId, detail.event?.eventId)
        assertEquals("103.0.5060.129", detail.event?.webviewVersion)
        assertEquals(29, detail.event?.androidSdk)
        assertNull(detail.event?.elapsedMs)
        assertNull(detail.event?.resolvedAt)
        assertFalse(detail.supportsResolution)
        assertEquals(relatedId, detail.relatedEvents.single().eventId)
        val missing = AdminNetwork.parseAdminDiagnostic("""{"event":null,"related_events":[],"retention_days":30}""", eventId)
        assertNull(missing.event)
        assertTrue(missing.relatedEvents.isEmpty())
        val resolved = AdminNetwork.parseAdminDiagnostic(
            payload.replaceFirst("{", "{\"supports_resolution\":true,")
                .replace(event, event.replaceFirst("{", "{\"resolved_at\":1795228400,")), eventId,
        )
        assertTrue(resolved.supportsResolution)
        assertEquals(1_795_228_400L, resolved.event?.resolvedAt)
        assertThrows(IllegalArgumentException::class.java) { AdminNetwork.parseAdminDiagnostic(payload, relatedId) }
        assertThrows(IllegalArgumentException::class.java) {
            AdminNetwork.parseAdminDiagnostic(
                payload.replace(related, related.replace(requestId, relatedId)),
                eventId,
            )
        }
    }

    @Test fun storageKeepsByteCountsAboveIntRangeAndWarning() {
        val payload = """{"sync":5368709120,"sync_limit":8589934592,"shares":10,"shares_limit":4294967296,
            "disk_free":5000000000,"disk_reserve":2147483648,"warning":true}"""
        val capacity = AdminNetwork.parseAdminStorage(payload)
        assertEquals(5_368_709_120L, capacity.syncBytes)
        assertEquals(4_294_967_296L, capacity.shareLimitBytes)
        assertEquals(5_000_000_000L, capacity.diskFreeBytes)
        assertTrue(capacity.warning)
        assertThrows(IllegalArgumentException::class.java) {
            AdminNetwork.parseAdminStorage(payload.replace("2147483648", "-1"))
        }
    }
}
