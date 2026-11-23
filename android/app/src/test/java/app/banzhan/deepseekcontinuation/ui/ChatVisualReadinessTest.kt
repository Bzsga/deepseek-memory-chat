package app.banzhan.deepseekcontinuation.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatVisualReadinessTest {
    @Test
    fun duplicateBridgeMessagesOnlyRequestAndConfirmOneDraw() {
        val readiness = ChatVisualReadiness()
        assertNull(readiness.requestDraw())

        readiness.beginNavigation()
        val request = requireNotNull(readiness.requestDraw())
        assertNull(readiness.requestDraw())
        assertTrue(readiness.confirmDraw(request))
        assertFalse(readiness.confirmDraw(request))
        assertNull(readiness.requestDraw())
    }

    @Test
    fun staleVisualCallbackCannotFinishAReplacementNavigation() {
        val readiness = ChatVisualReadiness()
        readiness.beginNavigation()
        val stale = requireNotNull(readiness.requestDraw())

        readiness.beginNavigation()
        val replacement = requireNotNull(readiness.requestDraw())
        assertFalse(readiness.confirmDraw(stale))
        assertTrue(readiness.confirmDraw(replacement))
    }

    @Test
    fun hardStartupFailureInvalidatesAnyPendingVisualCallback() {
        val readiness = ChatVisualReadiness()
        readiness.beginNavigation()
        val request = requireNotNull(readiness.requestDraw())

        readiness.invalidate()
        assertFalse(readiness.confirmDraw(request))
        assertNull(readiness.requestDraw())
    }
}
