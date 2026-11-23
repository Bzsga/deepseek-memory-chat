package app.banzhan.deepseekcontinuation.data

import android.content.Context
import android.os.Build
import android.webkit.WebView

internal data class ChatWebViewProvider(
    val packageName: String?,
    val versionName: String?,
    val label: String? = null,
) {
    val playUpdatePackage = packageName?.takeIf { it in playProviders }
    // Manufacturer package versions can describe the product, independently of Chromium.
    val majorVersion = versionName
        ?.takeIf { packageName == "com.android.webview" || playUpdatePackage != null }
        ?.let { chromiumVersion.matchEntire(it)?.groupValues?.get(1)?.toIntOrNull() }
    // Unknown versions can try the normal startup and readiness checks.
    val isCompatible = packageName != null && (majorVersion == null || majorVersion >= MIN_VERSION)

    fun handlesIme(androidSdk: Int): Boolean =
        androidSdk >= Build.VERSION_CODES.R && (majorVersion ?: 0) >= 140

    companion object {
        const val MIN_VERSION = 83
        private val legacyLoadFailedReleases = setOf("2.6.13", "2.6.14", "2.6.15", "2.6.16")
        private val minimum103Releases = setOf("2.6.18", "2.6.19", "2.6.20", "2.6.21")
        private val chromiumVersion = Regex("([1-9][0-9]*)\\.0\\.[1-9][0-9]{3,}\\.[0-9]+")
        private val playProviders = setOf(
            "com.google.android.webview",
            "com.google.android.webview.beta",
            "com.google.android.webview.dev",
            "com.google.android.webview.canary",
            "com.android.chrome",
            "com.chrome.beta",
            "com.chrome.dev",
            "com.chrome.canary",
        )

        fun minimumVersionForDiagnostic(release: String, code: String): Int? {
            val version = release.substringBefore('+')
            return when (code) {
                "load_failed" -> 105.takeIf { version in legacyLoadFailedReleases }
                "update_required" -> when {
                    version in legacyLoadFailedReleases || version == "2.6.17" -> 105
                    version.substringBefore('-') in minimum103Releases -> 103
                    else -> MIN_VERSION
                }
                else -> null
            }
        }

        fun read(context: Context): ChatWebViewProvider {
            val provider = runCatching { WebView.getCurrentWebViewPackage() }.getOrNull()
                ?: return ChatWebViewProvider(null, null)
            val label = runCatching {
                provider.applicationInfo?.loadLabel(context.packageManager)?.toString()?.trim()
            }.getOrNull()?.takeIf(String::isNotEmpty)
            return ChatWebViewProvider(provider.packageName, provider.versionName, label)
        }
    }
}
