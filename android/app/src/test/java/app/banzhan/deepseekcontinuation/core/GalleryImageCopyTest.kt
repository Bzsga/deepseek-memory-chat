package app.banzhan.deepseekcontinuation.core

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.OutputStream
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class GalleryImageCopyTest {
    private class Target(private val failWrite: Boolean = false, private val failPublish: Boolean = false) : GalleryImageTarget {
        val bytes = ByteArrayOutputStream()
        var published = false
        var rolledBack = false
        override fun open(): OutputStream = if (failWrite) object : OutputStream() {
            override fun write(value: Int) { throw IOException("disk full") }
        } else bytes
        override suspend fun publish() {
            if (failPublish) throw IOException("publish failed")
            published = true
        }
        override fun rollback() { rolledBack = true }
    }

    @Test fun savesOriginalBytesWithoutEncoding() = runTest {
        val original = ByteArray(100_003) { ((it * 37) % 256).toByte() }
        val source = File.createTempFile("gallery-original-", ".png")
        try {
            source.writeBytes(original)
            val target = Target()
            copyGalleryImage(source, target)
            assertArrayEquals(original, target.bytes.toByteArray())
            assertTrue(target.published)
            assertFalse(target.rolledBack)
            assertArrayEquals(original, source.readBytes())
        } finally { source.delete() }
    }

    @Test fun failedCopyOrPublishRemovesIncompleteAlbumEntry() = runTest {
        val source = File.createTempFile("gallery-failure-", ".png")
        try {
            source.writeBytes(ByteArray(4096) { 1 })
            for (target in listOf(Target(failWrite = true), Target(failPublish = true))) {
                try { copyGalleryImage(source, target); fail("Expected copy failure") } catch (_: IOException) { }
                assertTrue(target.rolledBack)
                assertFalse(target.published)
            }
        } finally { source.delete() }
    }

    @Test fun rejectsEmptyImageAndDoesNotPublish() = runTest {
        val source = File.createTempFile("gallery-empty-", ".png")
        try {
            val target = Target()
            try { copyGalleryImage(source, target); fail("Expected validation failure") } catch (_: IllegalArgumentException) { }
            assertTrue(target.rolledBack)
            assertFalse(target.published)
        } finally { source.delete() }
    }

    @Test fun namesStayInsideAlbumAndMatchOriginalMime() {
        assertEquals("photo.png", galleryImageSpec("../folder/photo.jpg", "image/png").name)
        assertEquals("deepseek-image.gif", galleryImageSpec("...", "image/gif").name)
        assertFalse(isGalleryImageMime("application/zip"))
        assertTrue(isGalleryImageMime("image/webp"))
        try { galleryImageSpec("archive.zip", "application/zip"); fail("Expected image MIME validation") } catch (_: IllegalStateException) { }
    }
}
