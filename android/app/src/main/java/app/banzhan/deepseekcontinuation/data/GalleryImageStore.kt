@file:Suppress("DEPRECATION")

package app.banzhan.deepseekcontinuation.data

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import app.banzhan.deepseekcontinuation.core.GalleryImageSpec
import app.banzhan.deepseekcontinuation.core.GalleryImageTarget
import app.banzhan.deepseekcontinuation.core.copyGalleryImage
import app.banzhan.deepseekcontinuation.core.galleryImageSpec
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

internal const val CHAT_GALLERY_ALBUM = "DeepSeek"

/** Save already validated native-transfer bytes; never fetch or re-encode an image. */
internal suspend fun saveChatImageToGallery(context: Context, source: File, name: String, mime: String) =
    withContext(Dispatchers.IO) {
        val spec = galleryImageSpec(name, mime)
        check(Environment.getExternalStorageState() == Environment.MEDIA_MOUNTED) {
            "相册存储暂时不可用，请稍后重试。"
        }
        val target = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStoreImageTarget(context.applicationContext, spec)
        } else {
            LegacyGalleryImageTarget(context.applicationContext, spec)
        }
        copyGalleryImage(source, target)
    }

private class MediaStoreImageTarget(context: Context, spec: GalleryImageSpec) : GalleryImageTarget {
    private val resolver = context.contentResolver
    private val uri: Uri = resolver.insert(
        MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
        ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, spec.name)
            put(MediaStore.Images.Media.MIME_TYPE, spec.mime)
            put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/$CHAT_GALLERY_ALBUM/")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        },
    ) ?: throw IOException("无法创建相册图片，请检查剩余存储空间。")

    override fun open(): OutputStream = resolver.openOutputStream(uri, "w")
        ?: throw IOException("无法写入相册，请检查剩余存储空间。")

    override suspend fun publish() {
        check(resolver.update(uri, ContentValues().apply {
            put(MediaStore.Images.Media.IS_PENDING, 0)
        }, null, null) == 1) { "图片未能加入相册，请重试。" }
    }

    override fun rollback() { resolver.delete(uri, null, null) }
}

private class LegacyGalleryImageTarget(private val context: Context, private val spec: GalleryImageSpec) : GalleryImageTarget {
    private val directory = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), CHAT_GALLERY_ALBUM)
    private val staging: File
    private var destination: File? = null
    private var mediaUri: Uri? = null

    init {
        check(directory.isDirectory || directory.mkdirs()) { "无法创建相册目录，请检查存储权限与剩余空间。" }
        staging = File.createTempFile(".deepseek-", ".pending", directory)
    }

    override fun open(): OutputStream = staging.outputStream()

    override suspend fun publish() {
        // Only expose the filename after all original bytes have been written and closed.
        // Reserve with createNewFile so a collision cannot replace a user's picture.
        val desired = File(directory, spec.name)
        val published = if (desired.createNewFile()) desired else {
            val stem = spec.name.substringBeforeLast('.')
            val extension = spec.name.substringAfterLast('.')
            File(directory, "$stem-${UUID.randomUUID()}.$extension").also {
                check(it.createNewFile()) { "无法创建相册图片，请重试。" }
            }
        }
        destination = published
        check(staging.renameTo(published)) { "图片未能保存到相册，请检查存储空间。" }
        withTimeout(15_000) {
            suspendCancellableCoroutine<Unit> { continuation ->
                MediaScannerConnection.scanFile(context, arrayOf(published.absolutePath), arrayOf(spec.mime)) { _, uri ->
                    mediaUri = uri
                    if (continuation.isActive) {
                        if (uri != null) continuation.resume(Unit)
                        else continuation.resumeWithException(IOException("图片未能加入相册，请重试。"))
                    } else {
                        // A late scanner callback must not resurrect a failed/cancelled copy.
                        uri?.let { runCatching { context.contentResolver.delete(it, null, null) } }
                    }
                }
            }
        }
    }

    override fun rollback() {
        mediaUri?.let { runCatching { context.contentResolver.delete(it, null, null) } }
        staging.delete()
        destination?.delete()
    }
}
