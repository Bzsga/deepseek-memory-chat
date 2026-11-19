package app.banzhan.deepseekcontinuation.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdatePromptTest {
    @Test
    fun deferredVersionSuppressesOnlyAutomaticPromptsForThatVersion() {
        assertTrue(showUpdatePrompt(37, 0))
        assertFalse(showUpdatePrompt(37, 37))
        assertTrue(showUpdatePrompt(37, 37, manual = true))
        assertTrue(showUpdatePrompt(38, 37))
    }
}
