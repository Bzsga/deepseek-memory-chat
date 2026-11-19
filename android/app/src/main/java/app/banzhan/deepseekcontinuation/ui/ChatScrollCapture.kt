package app.banzhan.deepseekcontinuation.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.HardwareRenderer
import android.graphics.Rect
import android.graphics.RenderNode
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.ScrollCaptureCallback
import android.view.ScrollCaptureSession
import android.view.View
import android.view.Window
import android.webkit.WebView
import androidx.annotation.RequiresApi
import java.util.function.Consumer
import kotlin.math.ceil
import kotlin.math.floor
import kotlinx.serialization.json.*

internal interface ChatScrollCapture {
    fun reset()
    fun close()
}

internal fun installChatScrollCapture(web: WebView, trusted: () -> Boolean): ChatScrollCapture? =
    if (Build.VERSION.SDK_INT >= 31) WebChatScrollCapture(web, trusted) else null

/** Public API 31 adapter for the chat's DOM overflow node, not WebView's document. */
@RequiresApi(31)
private class WebChatScrollCapture(
    private val web: WebView,
    private val trusted: () -> Boolean,
) : ChatScrollCapture, ScrollCaptureCallback {
    private val handler = Handler(Looper.getMainLooper())
    private var serial = 0L
    private var requestSerial = 0L
    private var closed = false
    private var capture: Capture? = null
    private val window = activityWindow(web.context)

    private class Capture(val id: Long, val session: ScrollCaptureSession) {
        var metrics: Metrics? = null
        var geometry: ChatCaptureGeometry? = null
        var renderer: HardwareRenderer? = null
        var node: RenderNode? = null
    }

    private data class Metrics(
        val bounds: Rect,
        val scrollTop: Double,
        val scrollHeight: Double,
        val clientHeight: Double,
        val scale: Double,
    )

    init {
        web.setScrollCaptureCallback(this)
        web.scrollCaptureHint = View.SCROLL_CAPTURE_HINT_INCLUDE
    }

    private fun available() = !closed && trusted() && web.isAttachedToWindow &&
        web.isShown && web.isHardwareAccelerated && window != null

    override fun onScrollCaptureSearch(signal: CancellationSignal, onReady: Consumer<Rect>) {
        if (!available() || signal.isCanceled || capture != null) {
            onReady.accept(Rect())
            return
        }
        val generation = serial
        javascript("metrics()") { value ->
            val metrics = if (generation == serial && available() && !signal.isCanceled)
                parseMetrics(value) else null
            onReady.accept(metrics?.takeIf { it.scrollHeight > it.clientHeight + 1 }?.bounds ?: Rect())
        }
    }

    override fun onScrollCaptureStart(session: ScrollCaptureSession, signal: CancellationSignal, onReady: Runnable) {
        reset()
        if (!available() || signal.isCanceled) { onReady.run(); return }
        val current = Capture(++serial, session)
        capture = current
        signal.setOnCancelListener { handler.post { if (capture === current) reset() } }
        javascript("start(${current.id})") { value ->
            if (!valid(current) || signal.isCanceled) return@javascript
            signal.setOnCancelListener(null)
            val metrics = parseMetrics(value)
            if (metrics == null || metrics.bounds != session.scrollBounds) {
                reset()
                onReady.run()
                return@javascript
            }
            current.metrics = metrics
            current.geometry = ChatCaptureGeometry(
                metrics.scrollTop, metrics.scrollHeight, metrics.clientHeight,
                metrics.scale, metrics.bounds.width(), metrics.bounds.height(),
            )
            val prepared = runCatching {
                current.node = RenderNode("ChatScrollCapture")
                val renderer = HardwareRenderer()
                current.renderer = renderer
                renderer.setSurface(session.surface)
                renderer.setContentRoot(current.node)
                renderer.setOpaque(false)
            }.isSuccess
            if (!prepared) {
                reset()
            }
            onReady.run()
        }
    }

    override fun onScrollCaptureImageRequest(
        session: ScrollCaptureSession,
        signal: CancellationSignal,
        captureArea: Rect,
        onComplete: Consumer<Rect>,
    ) {
        val current = capture
        val geometry = current?.geometry
        if (current == null || current.session !== session || geometry == null || !valid(current)) {
            onComplete.accept(Rect())
            return
        }
        val request = ++requestSerial
        fun validRequest() = valid(current) && request == requestSerial && !signal.isCanceled
        fun finish(result: Rect = Rect()) {
            if (validRequest()) {
                signal.setOnCancelListener(null)
                onComplete.accept(result)
            }
        }
        signal.setOnCancelListener { handler.post {
            if (capture === current && request == requestSerial) reset()
        } }
        val requested = CaptureRect(captureArea.left, captureArea.top, captureArea.right, captureArea.bottom)
        javascript("scroll(${current.id},${geometry.requestTarget(requested)})") { value ->
            if (!validRequest()) return@javascript
            val metrics = parseMetrics(value)
            val tile = metrics?.let { geometry.tile(requested, it.scrollTop) }
            if (metrics == null || metrics.bounds != current.metrics?.bounds || tile == null) {
                finish()
                return@javascript
            }
            afterWebFrame(::validRequest) { ready ->
                if (!validRequest()) return@afterWebFrame
                if (!ready) { finish(); return@afterWebFrame }
                val bounds = metrics.bounds
                val source = tile.source
                val crop = Rect(bounds.left + source.left, bounds.top + source.top,
                    bounds.left + source.right, bounds.top + source.bottom)
                val location = IntArray(2)
                web.getLocationInWindow(location)
                crop.offset(location[0], location[1])
                val bitmap = Bitmap.createBitmap(crop.width(), crop.height(), Bitmap.Config.ARGB_8888)
                try {
                    PixelCopy.request(window!!, crop, bitmap, { result ->
                        if (!validRequest()) { bitmap.recycle(); return@request }
                        if (result != PixelCopy.SUCCESS) { bitmap.recycle(); finish(); return@request }
                        // Layout/content may have changed while the GPU copy was pending.
                        javascript("metrics(${current.id})") { checked ->
                            if (!validRequest()) { bitmap.recycle(); return@javascript }
                            val latest = parseMetrics(checked)
                            if (latest == null || latest != metrics) {
                                bitmap.recycle(); finish(); return@javascript
                            }
                            val rendered = runCatching { render(current, bitmap) }.getOrDefault(false)
                            bitmap.recycle()
                            finish(if (rendered) tile.available.toAndroidRect() else Rect())
                        }
                    }, handler)
                } catch (_: Exception) {
                    bitmap.recycle()
                    finish()
                }
            }
        }
    }

    private fun render(current: Capture, bitmap: Bitmap): Boolean {
        val node = current.node ?: return false
        val renderer = current.renderer ?: return false
        node.setPosition(0, 0, bitmap.width, bitmap.height)
        val canvas = node.beginRecording(bitmap.width, bitmap.height)
        canvas.drawBitmap(bitmap, 0f, 0f, null)
        node.endRecording()
        // SystemUI reads a tile from buffer (0,0), then places it at the returned available rect.
        val result = renderer.createRenderRequest().setWaitForPresent(true).syncAndDraw()
        return result and (HardwareRenderer.SYNC_LOST_SURFACE_REWARD_IF_FOUND or
            HardwareRenderer.SYNC_CONTEXT_IS_STOPPED or HardwareRenderer.SYNC_FRAME_DROPPED) == 0
    }

    override fun onScrollCaptureEnd(onReady: Runnable) {
        val id = release()
        if (id == null || !available()) { onReady.run(); return }
        javascript("end($id)") {
            afterWebFrame({ available() }) { onReady.run() }
        }
    }

    private fun valid(current: Capture) = capture === current && serial == current.id && available()

    private fun release(): Long? {
        val current = capture
        capture = null
        serial++
        requestSerial++
        current?.renderer?.destroy()
        current?.node?.discardDisplayList()
        return current?.id
    }

    override fun reset() {
        val id = release()
        if (id != null && trusted() && !closed) javascript("end($id)") { }
    }

    override fun close() {
        reset()
        closed = true
        web.setScrollCaptureCallback(null)
        web.scrollCaptureHint = View.SCROLL_CAPTURE_HINT_AUTO
    }

    private fun javascript(operation: String, ready: (String?) -> Unit) {
        if (closed || !trusted()) { ready(null); return }
        var done = false
        val timeout = Runnable { if (!done) { done = true; ready(null) } }
        handler.postDelayed(timeout, 1000)
        try {
            web.evaluateJavascript("window.__deepseekScrollCapture?.$operation ?? null") { value ->
                if (!done) { done = true; handler.removeCallbacks(timeout); ready(value) }
            }
        } catch (_: Exception) {
            if (!done) { done = true; handler.removeCallbacks(timeout); ready(null) }
        }
    }

    /** VisualState promises the next draw; frame-commit promises PixelCopy can read that draw. */
    private fun afterWebFrame(valid: () -> Boolean, ready: (Boolean) -> Unit) {
        if (!valid()) { ready(false); return }
        var done = false
        var commit: Runnable? = null
        val observer = web.viewTreeObserver
        val timeout = Runnable {
            if (!done) {
                done = true
                commit?.let { if (observer.isAlive) observer.unregisterFrameCommitCallback(it) }
                ready(false)
            }
        }
        handler.postDelayed(timeout, 1000)
        web.postVisualStateCallback(serial, object : WebView.VisualStateCallback() {
            override fun onComplete(requestId: Long) {
                if (done) return
                if (!valid() || !observer.isAlive) {
                    done = true; handler.removeCallbacks(timeout); ready(false); return
                }
                val callback = Runnable {
                    if (!done) {
                        done = true; handler.removeCallbacks(timeout); ready(valid())
                    }
                }
                commit = callback
                observer.registerFrameCommitCallback(callback)
                web.invalidate()
            }
        })
    }

    private fun parseMetrics(value: String?): Metrics? = runCatching {
        val item = Json.parseToJsonElement(value ?: return null).jsonObject
        fun number(name: String) = item[name]!!.jsonPrimitive.double.also { require(it.isFinite()) }
        val viewportWidth = number("viewportWidth")
        val viewportHeight = number("viewportHeight")
        require(viewportWidth > 0 && viewportHeight > 0)
        val scaleX = web.width / viewportWidth
        val scaleY = web.height / viewportHeight
        require(scaleX in 0.1..16.0 && scaleY in 0.1..16.0)
        val left = number("left")
        val top = number("top")
        val width = number("width")
        val height = number("height")
        require(width > 0 && height > 0)
        val bounds = Rect(ceil(left * scaleX).toInt(), ceil(top * scaleY).toInt(),
            floor((left + width) * scaleX).toInt(), floor((top + height) * scaleY).toInt())
        val visible = Rect()
        require(!bounds.isEmpty && web.getLocalVisibleRect(visible) && visible.contains(bounds))
        val scrollTop = number("scrollTop")
        val scrollHeight = number("scrollHeight")
        require(scrollTop >= 0 && scrollHeight in height..100_000_000.0)
        Metrics(bounds, scrollTop, scrollHeight, height, scaleY)
    }.getOrNull()
}

private fun CaptureRect.toAndroidRect() = Rect(left, top, right, bottom)

private fun activityWindow(context: Context): Window? {
    var current = context
    while (current is ContextWrapper) {
        if (current is Activity) return current.window
        val base = current.baseContext
        if (base === current) return null
        current = base
    }
    return null
}
