package app.banzhan.deepseekcontinuation.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.banzhan.deepseekcontinuation.data.ServicePermissions
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AdminOpenPermissionsUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun threeGlobalPermissionsSaveOnlyWhenChangedAndRetryIndependently() {
        val current = mutableStateOf<ServicePermissions?>(null)
        val loading = mutableStateOf(true)
        val error = mutableStateOf<String?>(null)
        val submitted = AtomicReference<ServicePermissions?>()
        val reads = AtomicInteger()
        compose.setContent {
            ContinuationTheme {
                Column(
                    Modifier.widthIn(max = 320.dp).verticalScroll(rememberScrollState()).padding(20.dp),
                ) {
                    AdminOpenPermissionsControls(current.value, loading.value, error.value,
                        onRefresh = { reads.incrementAndGet() }, onSave = { submitted.set(it) })
                }
            }
        }
        val save = compose.onNodeWithTag("admin-open-permissions-save")
        val refresh = compose.onNodeWithTag("admin-open-permissions-refresh")
        save.assertDoesNotExist()
        refresh.assertIsNotEnabled()
        compose.runOnIdle {
            loading.value = false
            error.value = "合成：无法读取开放设置"
        }
        compose.onNodeWithText("合成：无法读取开放设置").performScrollTo().assertIsDisplayed()
        refresh.performScrollTo().performClick()
        assertEquals(1, reads.get())
        compose.runOnIdle {
            current.value = ServicePermissions.None
            error.value = null
        }

        val chat = compose.onNodeWithTag("admin-open-permissions:chat")
        val image = compose.onNodeWithTag("admin-open-permissions:image")
        val sync = compose.onNodeWithTag("admin-open-permissions:sync")
        save.performScrollTo().assertIsNotEnabled()
        assertNull(submitted.get())
        chat.performScrollTo().assertIsOff()
        image.performScrollTo().assertIsOff().performClick()
        sync.performScrollTo().assertIsOff().performClick()
        save.performScrollTo().performClick()
        assertEquals(ServicePermissions.None.copy(imageApi = true, cloudSync = true), submitted.get())

        compose.runOnIdle { loading.value = true }
        image.assertIsNotEnabled()
        save.assertIsNotEnabled()
        compose.runOnIdle {
            current.value = submitted.get()
            loading.value = false
        }
        image.performScrollTo().assertIsOn()
        sync.performScrollTo().assertIsOn()
        save.performScrollTo().assertIsNotEnabled()
    }
}
