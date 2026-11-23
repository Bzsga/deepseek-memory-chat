package app.banzhan.deepseekcontinuation

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import app.banzhan.deepseekcontinuation.data.AppController
import app.banzhan.deepseekcontinuation.data.ChatWebViewProvider
import app.banzhan.deepseekcontinuation.data.TechnicalDiagnostics
import app.banzhan.deepseekcontinuation.data.IncomingImportViewModel
import app.banzhan.deepseekcontinuation.ui.ContinuationApp
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val controller by lazy { ViewModelProvider(this)[AppController::class.java] }
    private val incomingImports by lazy { ViewModelProvider(this)[IncomingImportViewModel::class.java] }
    private var webViewProvider by mutableStateOf(ChatWebViewProvider(null, null))
    private var composeRoot: ComposeView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val receivedIntent = intent
        // SavedStateHandle default arguments must never come from an external sender's extras.
        clearReceivedIntent()
        showReceiveError(incomingImports.receiveInitial(receivedIntent, restored = savedInstanceState != null))
        enableEdgeToEdge()
        refreshWebViewProvider()
        val root = ComposeView(this).apply {
            consumeWindowInsets = !webViewProvider.handlesIme(Build.VERSION.SDK_INT)
            setContent {
                ContinuationApp(
                    controller = controller,
                    incomingImport = incomingImports.pending,
                    onIncomingImportConfirmed = { incomingImports.confirm(it, controller) },
                    onIncomingImportConsumed = incomingImports::consume,
                    onShareLinkReceived = { text ->
                        val previousId = incomingImports.pending?.id
                        val error = incomingImports.receiveShare(text)
                        showReceiveError(error)
                        val pending = incomingImports.pending
                        if (error == null && previousId == null && pending != null) {
                            incomingImports.confirm(pending.id, controller)
                        }
                    },
                    webViewProvider = webViewProvider,
                    webViewHandlesIme = webViewProvider.handlesIme(Build.VERSION.SDK_INT),
                    onRecheckWebView = ::refreshWebViewProvider,
                )
            }
        }
        composeRoot = root
        setContentView(root)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (isActive) {
                    TechnicalDiagnostics.requestUpload()
                    delay(60_000)
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Check again after returning from Settings or the store, before any WebView has been opened.
        if (!webViewProvider.isCompatible) refreshWebViewProvider()
    }

    private fun refreshWebViewProvider() {
        val provider = ChatWebViewProvider.read(this)
        TechnicalDiagnostics.setWebViewProvider(provider.packageName, provider.versionName)
        webViewProvider = provider
        composeRoot?.let { root ->
            // Let insets reach WebView when it can handle IME overlap through its visual viewport.
            val consumeInsets = !provider.handlesIme(Build.VERSION.SDK_INT)
            if (root.consumeWindowInsets != consumeInsets) {
                root.consumeWindowInsets = consumeInsets
                root.requestApplyInsets()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        showReceiveError(incomingImports.receive(intent))
        clearReceivedIntent()
    }

    private fun clearReceivedIntent() {
        // Retain no sender-controlled action/extras that could be replayed on recreation.
        setIntent(Intent(this, MainActivity::class.java).setAction(Intent.ACTION_MAIN))
    }

    private fun showReceiveError(message: String?) {
        if (message != null) {
            TechnicalDiagnostics.record("import", "operation_failed", "read")
            Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        }
    }
}
