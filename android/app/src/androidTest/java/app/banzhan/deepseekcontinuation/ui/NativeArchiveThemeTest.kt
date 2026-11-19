package app.banzhan.deepseekcontinuation.ui

import android.content.res.Configuration
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.platform.app.InstrumentationRegistry
import app.banzhan.deepseekcontinuation.data.NativeThemePreference
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

class NativeArchiveThemeTest {
    @get:Rule val compose = createComposeRule()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val owner = "archive-theme-qa"
    private val system = mutableIntStateOf(Configuration.UI_MODE_NIGHT_NO)

    private fun openArchives() {
        compose.setContent {
            val config = Configuration(LocalConfiguration.current)
            config.uiMode = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or system.intValue
            CompositionLocalProvider(LocalConfiguration provides config) {
                NativeChatTheme(owner) {
                    Scaffold { padding -> Box(Modifier.padding(padding)) { ArchivesScreen(emptyList(), {}, {}, onDelete = {}) } }
                }
            }
        }
    }

    private fun assertTitle(dark: Boolean) {
        val background = if (dark) 0x171719 else 0xFFFFFF
        val foreground = if (dark) 0xE8E8EA else 0x262626
        compose.waitUntil(5000) {
            val title = compose.onNodeWithText("续聊记录").captureToImage().toPixelMap()
            var ink = 0
            var paper = 0
            for (y in 0 until title.height) for (x in 0 until title.width) {
                when (title[x, y].toArgb() and 0xffffff) {
                    foreground -> ink++
                    background -> paper++
                }
            }
            ink > 10 && paper > 100
        }
    }

    @Test fun honorsOverridesAndSystemChanges() {
        NativeThemePreference.save(context, owner, "dark")
        openArchives()
        assertTitle(true)
        NativeThemePreference.save(context, owner, "light")
        compose.runOnIdle { system.intValue = Configuration.UI_MODE_NIGHT_YES }
        assertTitle(false)
        NativeThemePreference.save(context, owner, "system")
        assertTitle(true)
        compose.runOnIdle { system.intValue = Configuration.UI_MODE_NIGHT_NO }
        assertTitle(false)
        NativeThemePreference.save(context, owner, "dark")
        assertTitle(true)
    }

    @Test fun restoresDarkInNewProcess() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("checkThemeRestart") == "true")
        assertTrue(NativeThemePreference.read(context, owner) == "dark")
        openArchives()
        assertTitle(true)
    }
}
