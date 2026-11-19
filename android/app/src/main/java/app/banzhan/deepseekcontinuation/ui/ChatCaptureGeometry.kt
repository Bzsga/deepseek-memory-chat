package app.banzhan.deepseekcontinuation.ui

import kotlin.math.roundToInt

internal data class CaptureRect(val left: Int, val top: Int, val right: Int, val bottom: Int)

internal data class ChatCaptureTile(val available: CaptureRect, val source: CaptureRect)

/** Maps capture requests in the starting scroll frame to the currently visible DOM viewport. */
internal class ChatCaptureGeometry(
    private val originScrollTop: Double,
    private val cssScrollHeight: Double,
    private val cssClientHeight: Double,
    private val scaleY: Double,
    private val viewportWidthPx: Int,
    private val viewportHeightPx: Int,
) {
    init {
        require(originScrollTop.isFinite())
        require(cssScrollHeight.isFinite() && cssScrollHeight >= 0.0)
        require(cssClientHeight.isFinite() && cssClientHeight >= 0.0)
        require(scaleY.isFinite() && scaleY > 0.0)
        require(viewportWidthPx > 0 && viewportHeightPx > 0)
    }

    /** CSS scroll position to request; the caller must use the actual resulting scroll position. */
    fun requestTarget(request: CaptureRect): Double =
        (originScrollTop + request.top.toDouble() / scaleY)
            .coerceIn(0.0, (cssScrollHeight - cssClientHeight).coerceAtLeast(0.0))

    /**
     * [ChatCaptureTile.available] stays in the original capture frame. [ChatCaptureTile.source]
     * is relative to the scrolling bounds, ready to offset by those bounds for a window crop.
     * Pixel positions use roundToInt consistently, including the actual scroll delta.
     */
    fun tile(request: CaptureRect, currentCssScrollTop: Double): ChatCaptureTile? {
        require(currentCssScrollTop.isFinite())
        val delta = ((currentCssScrollTop - originScrollTop) * scaleY).roundToInt().toLong()
        val contentTop = -(originScrollTop * scaleY).roundToInt().toLong()
        val contentBottom = ((cssScrollHeight - originScrollTop) * scaleY).roundToInt().toLong()
        val left = maxOf(request.left, 0)
        val right = minOf(request.right, viewportWidthPx)
        val top = maxOf(request.top.toLong(), contentTop, delta)
        val bottom = minOf(request.bottom.toLong(), contentBottom, delta + viewportHeightPx)
        if (left >= right || top >= bottom) return null

        return ChatCaptureTile(
            available = CaptureRect(left, top.toInt(), right, bottom.toInt()),
            source = CaptureRect(left, (top - delta).toInt(), right, (bottom - delta).toInt()),
        )
    }
}
