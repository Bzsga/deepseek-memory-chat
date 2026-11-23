package app.banzhan.deepseekcontinuation.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatWebViewProviderTest {
    @Test fun missingAndKnownOldProvidersShowRecovery() {
        assertFalse(ChatWebViewProvider(null, null).isCompatible)
        val old = ChatWebViewProvider("com.android.webview", "82.0.4085.4")
        assertEquals(82, old.majorVersion)
        assertFalse(old.isCompatible)
        assertTrue(ChatWebViewProvider("com.android.webview", "83.0.4103.120").isCompatible)
        assertTrue(ChatWebViewProvider("com.google.android.webview", "85.0.4183.127").isCompatible)
        assertTrue(ChatWebViewProvider("com.google.android.webview", "103.0.5060.129").isCompatible)
        assertTrue(ChatWebViewProvider("com.android.webview", "105.0.5195.124").isCompatible)
    }

    @Test fun nonstandardVersionUsesNormalStartupChecks() {
        for (versionName in listOf("vendor-build", "12.0", "12.0.0.325", "103.0.5060.129-custom")) {
            val provider = ChatWebViewProvider("com.android.webview", versionName)
            assertNull(provider.majorVersion)
            assertTrue(provider.isCompatible)
            assertFalse(provider.handlesIme(35))
        }
    }

    @Test fun vendorProductVersionsAreNeverInterpretedAsChromiumVersions() {
        val honor = ChatWebViewProvider("com.huawei.webview", "12.0.0.325", "Android System WebView")
        assertEquals("12.0.0.325", honor.versionName)
        assertEquals("com.huawei.webview", honor.packageName)
        assertNull(honor.majorVersion)
        assertNull(honor.playUpdatePackage)
        assertTrue(honor.isCompatible)
        assertFalse(honor.copy(versionName = "140.0.7339.207").handlesIme(35))
        val customChromiumFormat = honor.copy(versionName = "82.0.4085.4")
        assertNull(customChromiumFormat.majorVersion)
        assertTrue(customChromiumFormat.isCompatible)
        val chrome = ChatWebViewProvider("com.chrome.beta", "81.0.4044.138")
        assertFalse(chrome.isCompatible)
        assertEquals("com.chrome.beta", chrome.playUpdatePackage)
    }

    @Test fun automaticKeyboardInsetsRequireAndroid11AndWebView140() {
        val provider = ChatWebViewProvider("com.android.webview", "140.0.7339.207")
        assertFalse(provider.handlesIme(29))
        assertTrue(provider.handlesIme(30))
        assertFalse(provider.copy(versionName = "139.0.7258.143").handlesIme(30))
    }

    @Test fun diagnosticExplanationsUseTheReportingReleaseMinimum() {
        assertEquals(105, ChatWebViewProvider.minimumVersionForDiagnostic("2.6.16+54", "load_failed"))
        assertEquals(105, ChatWebViewProvider.minimumVersionForDiagnostic("2.6.17+55", "update_required"))
        assertEquals(103, ChatWebViewProvider.minimumVersionForDiagnostic("2.6.18-preview.1+55", "update_required"))
        assertEquals(103, ChatWebViewProvider.minimumVersionForDiagnostic("2.6.21+59", "update_required"))
        assertEquals(83, ChatWebViewProvider.minimumVersionForDiagnostic("2.6.22+60", "update_required"))
        assertNull(ChatWebViewProvider.minimumVersionForDiagnostic("2.6.18+56", "load_failed"))
        assertNull(ChatWebViewProvider.minimumVersionForDiagnostic("2.6.22+60", "load_failed"))
    }
}
