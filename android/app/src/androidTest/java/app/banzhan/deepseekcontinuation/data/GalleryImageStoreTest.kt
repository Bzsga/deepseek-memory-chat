package app.banzhan.deepseekcontinuation.data

import android.content.ContentUris
import android.content.Context
import android.provider.MediaStore
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Storage-only synthetic smoke: no Activity, WebView, account, network or model. */
@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 29)
class GalleryImageStoreTest {
    private val context: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val collection get() = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)

    @Test fun savesOriginalImageToPublishedAlbumEntry() = runBlocking {
        val name = "gallery-smoke-${UUID.randomUUID()}.png"
        val original = Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5ZkAAAAASUVORK5CYII=", Base64.DEFAULT)
        val source = File.createTempFile("gallery-smoke-", ".png", context.cacheDir)
        try {
            source.writeBytes(original)
            saveChatImageToGallery(context, source, name, "image/png")
            context.contentResolver.query(collection, arrayOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.IS_PENDING,
                MediaStore.Images.Media.RELATIVE_PATH,
                MediaStore.Images.Media.MIME_TYPE,
            ), "${MediaStore.Images.Media.DISPLAY_NAME} = ?", arrayOf(name), null)!!.use { cursor ->
                assertEquals(1, cursor.count)
                assertTrue(cursor.moveToFirst())
                assertEquals(0, cursor.getInt(1))
                assertEquals("Pictures/$CHAT_GALLERY_ALBUM/", cursor.getString(2))
                assertEquals("image/png", cursor.getString(3))
                val uri = ContentUris.withAppendedId(collection, cursor.getLong(0))
                assertArrayEquals(original, context.contentResolver.openInputStream(uri)!!.use { it.readBytes() })
                assertArrayEquals(original, source.readBytes())
            }
        } finally {
            context.contentResolver.delete(collection, "${MediaStore.Images.Media.DISPLAY_NAME} = ?", arrayOf(name))
            source.delete()
        }
    }

    @Test fun invalidInputLeavesNoAlbumEntry() = runBlocking {
        val name = "gallery-empty-smoke-${UUID.randomUUID()}.png"
        val source = File.createTempFile("gallery-empty-smoke-", ".png", context.cacheDir)
        try {
            try {
                saveChatImageToGallery(context, source, name, "image/png")
                fail("Expected empty image rejection")
            } catch (_: IllegalArgumentException) { }
            context.contentResolver.query(collection, arrayOf(MediaStore.Images.Media._ID),
                "${MediaStore.Images.Media.DISPLAY_NAME} = ?", arrayOf(name), null)!!.use { cursor ->
                assertEquals(0, cursor.count)
            }
        } finally {
            context.contentResolver.delete(collection, "${MediaStore.Images.Media.DISPLAY_NAME} = ?", arrayOf(name))
            source.delete()
        }
    }
}
