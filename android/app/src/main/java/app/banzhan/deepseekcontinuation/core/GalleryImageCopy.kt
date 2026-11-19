package app.banzhan.deepseekcontinuation.core

import java.io.File
import java.io.OutputStream

internal const val MAX_GALLERY_IMAGE_BYTES = 128L * 1024 * 1024

internal data class GalleryImageSpec(val name: String, val mime: String)

internal fun isGalleryImageMime(mime: String): Boolean = mime in setOf(
    "image/png", "image/jpeg", "image/webp", "image/gif",
)

internal fun galleryImageSpec(name: String, mime: String): GalleryImageSpec {
    val extension = when (mime) {
        "image/png" -> ".png"
        "image/jpeg" -> ".jpg"
        "image/webp" -> ".webp"
        "image/gif" -> ".gif"
        else -> error("不支持保存这种图片格式。")
    }
    val stem = name.substringAfterLast('/').substringAfterLast('\\')
        .substringBeforeLast('.')
        .replace(Regex("[\\p{Cntrl}<>:\"/\\\\|?*]"), "_")
        .trim().trim('.').take(100).ifBlank { "deepseek-image" }
    return GalleryImageSpec(stem + extension, mime)
}

/** A newly reserved album entry; an incomplete copy must never become visible. */
internal interface GalleryImageTarget {
    fun open(): OutputStream
    suspend fun publish()
    fun rollback()
}

/** Copies the original bytes. Encoding, resizing and model calls have no place in saving. */
internal suspend fun copyGalleryImage(source: File, target: GalleryImageTarget) {
    try {
        val size = source.length()
        require(source.isFile && size in 1..MAX_GALLERY_IMAGE_BYTES) { "图片为空或超过 128 MB，无法保存。" }
        target.open().use { output ->
            val copied = source.inputStream().use { it.copyTo(output) }
            check(copied == size && source.length() == size) { "图片没有完整保存，请重试。" }
        }
        target.publish()
    } catch (failure: Throwable) {
        runCatching { target.rollback() }
        throw failure
    }
}
