package app.banzhan.deepseekcontinuation.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import app.banzhan.deepseekcontinuation.core.isGalleryImageMime
import app.banzhan.deepseekcontinuation.data.saveChatImageToGallery
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Returns true for supported images and leaves ordinary files on the existing SAF path. */
@Composable
internal fun rememberChatGallerySaver(onError: (String) -> Unit): (File, String, String) -> Boolean {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val currentError by rememberUpdatedState(onError)
    var pending by rememberSaveable { mutableStateOf<ArrayList<String>?>(null) }
    var saving by remember { mutableStateOf(false) }

    fun save(file: File, name: String, mime: String) {
        saving = true
        scope.launch {
            try {
                saveChatImageToGallery(context.applicationContext, file, name, mime)
                Toast.makeText(context.applicationContext, "已保存到相册", Toast.LENGTH_SHORT).show()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                currentError(if (failure is SecurityException) "无法保存图片，请允许存储权限后重试。"
                    else failure.message ?: "图片未保存到相册，请检查存储空间后重试。")
            } finally {
                file.delete()
                saving = false
            }
        }
    }

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val item = pending
        pending = null
        if (item != null) {
            val file = File(item[0])
            if (granted) save(file, item[1], item[2])
            else {
                file.delete()
                currentError("未获存储权限，图片未保存到相册。请允许权限后重试。")
            }
        }
    }

    return { file, name, mime ->
        if (!isGalleryImageMime(mime)) false else {
            if (pending != null || saving) {
                file.delete()
                currentError("请先完成当前图片保存。")
            } else if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                pending = arrayListOf(file.absolutePath, name, mime)
                try {
                    permission.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                } catch (_: Exception) {
                    pending = null
                    file.delete()
                    currentError("无法申请存储权限，图片未保存到相册。")
                }
            } else {
                save(file, name, mime)
            }
            true
        }
    }
}
