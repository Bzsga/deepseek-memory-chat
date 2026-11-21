package app.banzhan.deepseekcontinuation.ui

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ChatFilePickerResultTest {
    private val packageName = "app.banzhan.deepseekcontinuation"
    private val first = Uri.parse("content://com.android.providers.media.documents/document/image%3A11")
    private val second = Uri.parse("content://com.android.providers.media.documents/document/image%3A12")

    @Test
    fun acceptsSingleImageReturnedInClipDataOnly() {
        val result = Intent().apply { clipData = ClipData.newRawUri("photos", first) }
        assertArrayEquals(arrayOf(first), parseChatFilePickerResult(Activity.RESULT_OK, result, packageName))
    }

    @Test
    fun acceptsSingleFileReturnedAsData() {
        val result = Intent().setData(first)
        assertArrayEquals(arrayOf(first), parseChatFilePickerResult(Activity.RESULT_OK, result, packageName))
    }

    @Test
    fun acceptsMultipleImagesReturnedInClipDataOnly() {
        val result = Intent().apply {
            clipData = ClipData.newRawUri("photos", first).apply { addItem(ClipData.Item(second)) }
        }
        assertArrayEquals(arrayOf(first, second), parseChatFilePickerResult(Activity.RESULT_OK, result, packageName))
    }

    @Test
    fun preservesMultipleFilesWithoutDuplicatingTheDataUri() {
        val result = Intent().setData(first).apply {
            clipData = ClipData.newRawUri("photos", first).apply { addItem(ClipData.Item(second)) }
        }
        assertArrayEquals(arrayOf(first, second), parseChatFilePickerResult(Activity.RESULT_OK, result, packageName))
    }

    @Test
    fun ignoresCanceledResultsAndRejectsUnsupportedUriSources() {
        assertNull(parseChatFilePickerResult(Activity.RESULT_CANCELED, Intent().setData(first), packageName))
        assertNull(parseChatFilePickerResult(Activity.RESULT_OK, Intent().setData(Uri.parse("file:///data/private.jpg")), packageName))
        val privateFile = Uri.parse("content://$packageName.files/chat-captures/photo.jpg")
        assertNull(parseChatFilePickerResult(Activity.RESULT_OK, Intent().setData(privateFile), packageName))
    }
}
