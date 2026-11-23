package app.banzhan.deepseekcontinuation.data

import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TechnicalDiagnosticsAcceptanceTest {
    @Test fun onlyTypedWebFailureFieldsCanEnterLocalQueue() = runBlocking<Unit> {
        val before = TechnicalDiagnostics.latest.value?.id
        val valid = buildJsonObject {
            put("release", "2.6.0+0123abcd")
            put("area", "runtime")
            put("code", "unexpected_error")
            put("stage", "render")
        }
        assertFalse(TechnicalDiagnostics.recordFromWeb(buildJsonObject {
            valid.forEach { (key, value) -> put(key, value) }
            put("message", "private synthetic test text")
        }))
        assertFalse(TechnicalDiagnostics.recordFromWeb(buildJsonObject {
            valid.forEach { (key, value) -> put(key, value) }
            put("stage", "synthetic free text")
        }))
        assertFalse(TechnicalDiagnostics.recordFromWeb(buildJsonObject {
            put("release", "2.6.0+0123abcd")
            put("area", "webview")
            put("code", "update_required")
            put("stage", "initialize")
        }))
        if (TechnicalDiagnostics.choice.value != DiagnosticChoice.ENABLED) {
            assertTrue(TechnicalDiagnostics.recordFromWeb(valid))
            val saved = withTimeout(5_000) {
                TechnicalDiagnostics.latest.first { it != null && it.id != before && it.release == "2.6.0+0123abcd" }
            }
            assertEquals("web", saved?.source)
            assertEquals("render", saved?.stage)
        }
    }

    @Test fun obsoleteWebViewIsReportedOnlyOncePerProviderVersion() = runBlocking<Unit> {
        assumeTrue(TechnicalDiagnostics.choice.value != DiagnosticChoice.ENABLED)
        val provider = ChatWebViewProvider("com.google.android.webview.beta", "62.0.3202.84", "Synthetic WebView")
        assertTrue(TechnicalDiagnostics.recordWebViewInitialization(provider))
        assertFalse(TechnicalDiagnostics.recordWebViewInitialization(provider.copy(label = "Other label")))
        val saved = withTimeout(5_000) {
            TechnicalDiagnostics.latest.first { it?.webViewProvider == provider.packageName }
        }
        assertEquals("android", saved?.source)
        assertEquals("webview", saved?.area)
        assertEquals("update_required", saved?.code)
        assertEquals("initialize", saved?.stage)
        assertEquals(provider.versionName, saved?.webViewVersion)
        assertTrue(TechnicalDiagnostics.recordWebViewInitialization(provider.copy(versionName = "82.0.4085.4")))
        assertFalse(TechnicalDiagnostics.recordWebViewInitialization(provider.copy(versionName = "83.0.4103.106")))
        assertFalse(TechnicalDiagnostics.recordWebViewInitialization(provider.copy(versionName = "85.0.4183.127")))
        assertFalse(TechnicalDiagnostics.recordWebViewInitialization(
            ChatWebViewProvider("com.huawei.webview", "12.0.0.325"),
        ))
    }

    /** Explicitly opted-in instructor run. Sends one synthetic event and no account credentials. */
    @Test fun manualEventIsAcknowledgedWithoutEnablingAutomaticUpload() = runBlocking<Unit> {
        assumeTrue(InstrumentationRegistry.getArguments().getString("diagnosticNetworkAcceptance") == "true")
        val initialChoice = TechnicalDiagnostics.choice.value
        assumeTrue(initialChoice != DiagnosticChoice.ENABLED)
        val before = TechnicalDiagnostics.latest.value?.id
        TechnicalDiagnostics.record("runtime", "unexpected_error", "initialize")
        val event = withTimeout(5_000) {
            TechnicalDiagnostics.latest.first { it != null && it.id != before &&
                it.area == "runtime" && it.stage == "initialize" }
        } ?: error("Synthetic diagnostic was not recorded")
        assertTrue(TechnicalDiagnostics.sendOnce(event))
        assertEquals(initialChoice, TechnicalDiagnostics.choice.value)
        InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
            putString("diagnostic_event_id", event.id)
        })
    }
}
