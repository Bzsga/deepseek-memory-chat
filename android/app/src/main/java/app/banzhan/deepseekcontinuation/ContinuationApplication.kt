package app.banzhan.deepseekcontinuation

import android.app.Application
import app.banzhan.deepseekcontinuation.data.DiagnosticLog
import app.banzhan.deepseekcontinuation.data.TechnicalDiagnostics

class ContinuationApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        runCatching { TechnicalDiagnostics.initialize(this) }
        DiagnosticLog.initialize(this)
    }
}
