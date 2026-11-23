package app.banzhan.deepseekcontinuation.data

import android.content.Context
import android.os.Build
import app.banzhan.deepseekcontinuation.BuildConfig
import java.io.File

/** Local breadcrumbs retained for inspecting interrupted imports and organization. */
object DiagnosticLog {
    @Volatile private var queue: DiagnosticQueue? = null
    private var crashReserve: ByteArray? = null

    @Synchronized fun initialize(context: Context) {
        if (queue != null) return
        try {
            queue = DiagnosticQueue(File(context.noBackupFilesDir, "diagnostics"))
            crashReserve = ByteArray(128 * 1024)
            val previous = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler(DiagnosticExceptionHandler(previous) { error ->
                crashReserve = null
                runCatching { TechnicalDiagnostics.crash() }
                record("crash", "uncaught", error = error)
            })
            record("lifecycle", "start")
        } catch (_: Throwable) { /* Diagnostics must not prevent application startup. */ }
    }

    fun record(kind: String, stage: String, metrics: Map<String, Long> = emptyMap(), error: Throwable? = null): String? {
        val destination = queue ?: return null
        return try {
            if (kind !in DiagnosticPrivacy.kinds || stage !in DiagnosticPrivacy.stages) return null
            val runtime = Runtime.getRuntime()
            val safeMetrics = DiagnosticPrivacy.metrics(metrics) + mapOf(
                "heap_free_bytes" to runtime.freeMemory(), "heap_max_bytes" to runtime.maxMemory(),
                "heap_used_bytes" to (runtime.totalMemory() - runtime.freeMemory()).coerceAtLeast(0))
            val event = DiagnosticEvent(
                occurredAt = System.currentTimeMillis() / 1000.0,
                appVersionCode = BuildConfig.VERSION_CODE,
                appVersionName = DiagnosticPrivacy.version(BuildConfig.VERSION_NAME),
                androidSdk = Build.VERSION.SDK_INT,
                manufacturer = DiagnosticPrivacy.device(Build.MANUFACTURER.orEmpty()),
                model = DiagnosticPrivacy.device(Build.MODEL.orEmpty()),
                kind = kind, stage = stage, metrics = safeMetrics,
                exceptionClass = DiagnosticPrivacy.exception(error), stackFrames = DiagnosticPrivacy.frames(error),
            )
            destination.append(event)
            event.eventId
        } catch (_: Throwable) { null /* Includes OOM/disk-full: preserve the original operation. */ }
    }
}
