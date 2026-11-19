package app.banzhan.deepseekcontinuation.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatCaptureGeometryTest {
    @Test fun requestAboveTheInitialViewportClipsToTheContentStart() {
        val geometry = ChatCaptureGeometry(100.0, 1000.0, 200.0, 1.0, 300, 200)
        val request = CaptureRect(0, -180, 300, -30)

        assertEquals(0.0, geometry.requestTarget(request), 0.0)
        assertEquals(
            ChatCaptureTile(CaptureRect(0, -100, 300, -30), CaptureRect(0, 0, 300, 70)),
            geometry.tile(request, currentCssScrollTop = 0.0),
        )
    }

    @Test fun bottomRequestUsesTheActualClampedScrollAndClipsToContentEnd() {
        val geometry = ChatCaptureGeometry(100.0, 650.0, 200.0, 1.0, 300, 200)
        val request = CaptureRect(0, 500, 300, 700)

        assertEquals(450.0, geometry.requestTarget(request), 0.0)
        assertEquals(
            ChatCaptureTile(CaptureRect(0, 500, 300, 550), CaptureRect(0, 150, 300, 200)),
            geometry.tile(request, currentCssScrollTop = 450.0),
        )
    }

    @Test fun fractionalScaleRoundsTheActualDeltaAndKeepsSourceCoordinatesLocal() {
        val geometry = ChatCaptureGeometry(10.2, 500.3, 80.0, 1.25, 200, 100)
        val request = CaptureRect(0, 10, 200, 40)

        assertEquals(18.2, geometry.requestTarget(request), 0.000000001)
        assertEquals(
            ChatCaptureTile(CaptureRect(0, 14, 200, 40), CaptureRect(0, 0, 200, 26)),
            geometry.tile(request, currentCssScrollTop = 21.1),
        )
        assertEquals(
            ChatCaptureTile(CaptureRect(0, -13, 200, 0), CaptureRect(0, 0, 200, 13)),
            geometry.tile(CaptureRect(0, -20, 200, 0), currentCssScrollTop = 0.0),
        )
    }

    @Test fun requestsOutsideTheContentOrCurrentViewportHaveNoTile() {
        val geometry = ChatCaptureGeometry(100.0, 650.0, 200.0, 1.0, 300, 200)

        assertNull(geometry.tile(CaptureRect(0, -200, 300, -100), 0.0))
        assertNull(geometry.tile(CaptureRect(0, 550, 300, 700), 450.0))
        assertNull(geometry.tile(CaptureRect(0, 250, 300, 300), 100.0))
        assertNull(geometry.tile(CaptureRect(0, 20, 300, 20), 100.0))
    }

    @Test fun horizontalBoundsClipWithoutChangingTheCaptureFrame() {
        val geometry = ChatCaptureGeometry(100.0, 1000.0, 200.0, 1.0, 300, 200)

        assertEquals(
            ChatCaptureTile(CaptureRect(0, 0, 300, 100), CaptureRect(0, 0, 300, 100)),
            geometry.tile(CaptureRect(-20, 0, 350, 100), currentCssScrollTop = 100.0),
        )
        assertNull(geometry.tile(CaptureRect(300, 0, 350, 100), 100.0))
        assertNull(geometry.tile(CaptureRect(-20, 0, 0, 100), 100.0))
    }

    @Test fun contentShorterThanTheViewportHasNoPositiveScrollTarget() {
        val geometry = ChatCaptureGeometry(0.0, 100.0, 200.0, 1.0, 300, 200)

        assertEquals(0.0, geometry.requestTarget(CaptureRect(0, 80, 300, 180)), 0.0)
    }
}
