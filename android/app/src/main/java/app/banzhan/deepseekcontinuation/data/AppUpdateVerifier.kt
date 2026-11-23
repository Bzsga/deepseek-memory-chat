package app.banzhan.deepseekcontinuation.data

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import app.banzhan.deepseekcontinuation.core.AppUpdateManifest
import java.io.File
import java.security.MessageDigest

internal enum class AppUpdateVerificationFailure(
    val code: String,
    val stage: String,
    val rejectsDownload: Boolean = false,
) {
    FILE("storage_error", "read"),
    SIZE("integrity_error", "download", rejectsDownload = true),
    CHECKSUM("integrity_error", "verify", rejectsDownload = true),
    MANIFEST("invalid_response", "verify"),
    ARCHIVE("invalid_response", "parse", rejectsDownload = true),
    IDENTITY("integrity_error", "parse", rejectsDownload = true),
    SIGNER_UNAVAILABLE("invalid_response", "install"),
    SIGNER_MISMATCH("integrity_error", "install", rejectsDownload = true),
    PLATFORM("unexpected_error", "verify"),
}

internal class AppUpdateVerificationException(
    message: String,
    val failure: AppUpdateVerificationFailure? = null,
) : Exception(message)

internal data class AppUpdatePackageIdentity(
    val packageName: String,
    val versionCode: Long,
    val versionName: String,
    val minSdk: Int,
    val signerSha256: Set<String>,
)

/** A successful result is valid only for this verification attempt. Recheck before installation. */
internal class AppUpdateVerifier(context: Context) {
    private val application = context.applicationContext
    private val packageManager = application.packageManager

    fun installedVersionCode(): Long = safelyVerify {
        installedIdentity().versionCode
    }

    fun verify(file: File, manifest: AppUpdateManifest): File = safelyVerify {
        val verifiedFile = verifyAppUpdateFile(file, application.cacheDir, manifest)
        val archive = packageManager.getPackageArchiveInfo(verifiedFile.path, appUpdateSigningFlags(Build.VERSION.SDK_INT, archive = true))
            ?: throw AppUpdateVerificationException("更新包无法解析，请重新下载。", AppUpdateVerificationFailure.ARCHIVE)
        validateAppUpdateIdentity(manifest, appUpdatePackageIdentity(archive), installedIdentity(), Build.VERSION.SDK_INT)
        verifiedFile
    }

    private fun installedIdentity(): AppUpdatePackageIdentity {
        @Suppress("DEPRECATION")
        val installed = packageManager.getPackageInfo(application.packageName, appUpdateSigningFlags(Build.VERSION.SDK_INT))
        return appUpdatePackageIdentity(installed)
    }
}

/** Only the current signing certificates are accepted. A historical rotated signer is insufficient. */
internal fun appUpdatePackageIdentity(info: PackageInfo): AppUpdatePackageIdentity {
    val signatures = if (Build.VERSION.SDK_INT >= 28) {
        info.signingInfo?.apkContentsSigners.orEmpty()
    } else {
        @Suppress("DEPRECATION")
        info.signatures.orEmpty()
    }
    val signerSha256 = signatures.map { signature ->
        val bytes = signature.toByteArray()
        if (bytes.isEmpty()) throw AppUpdateVerificationException("无法确认更新包签名，请重新下载。", AppUpdateVerificationFailure.SIGNER_UNAVAILABLE)
        sha256Hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    }.toSet()
    if (signerSha256.isEmpty()) throw AppUpdateVerificationException("无法确认更新包签名，请重新下载。", AppUpdateVerificationFailure.SIGNER_UNAVAILABLE)
    val versionCode = if (Build.VERSION.SDK_INT >= 28) {
        info.longVersionCode
    } else {
        @Suppress("DEPRECATION")
        info.versionCode.toLong()
    }
    return AppUpdatePackageIdentity(
        packageName = info.packageName ?: throw AppUpdateVerificationException("更新包信息不完整，请重新下载。", AppUpdateVerificationFailure.PLATFORM),
        versionCode = versionCode,
        versionName = info.versionName ?: throw AppUpdateVerificationException("更新包信息不完整，请重新下载。", AppUpdateVerificationFailure.PLATFORM),
        minSdk = info.applicationInfo?.minSdkVersion
            ?: throw AppUpdateVerificationException("更新包信息不完整，请重新下载。", AppUpdateVerificationFailure.PLATFORM),
        signerSha256 = signerSha256,
    )
}

internal fun validateAppUpdateIdentity(
    manifest: AppUpdateManifest,
    candidate: AppUpdatePackageIdentity,
    installed: AppUpdatePackageIdentity,
    sdk: Int,
) {
    if (manifest.packageName != installed.packageName || candidate.packageName != installed.packageName) {
        throw AppUpdateVerificationException("更新包与当前应用不匹配，请重新检查更新。", AppUpdateVerificationFailure.IDENTITY)
    }
    if (candidate.versionCode != manifest.versionCode.toLong() || candidate.versionName != manifest.versionName ||
        candidate.minSdk != manifest.minSdk) {
        throw AppUpdateVerificationException("更新包版本与更新信息不一致，请重新检查更新。", AppUpdateVerificationFailure.IDENTITY)
    }
    if (candidate.versionCode <= installed.versionCode) {
        throw AppUpdateVerificationException("当前已安装相同或更高版本，无需安装此更新。")
    }
    if (candidate.minSdk < 26 || candidate.minSdk > sdk) {
        throw AppUpdateVerificationException("此更新不适用于当前 Android 版本。")
    }
    if (candidate.signerSha256.isEmpty() || installed.signerSha256.isEmpty()) {
        throw AppUpdateVerificationException("无法确认更新包签名，请重新下载。", AppUpdateVerificationFailure.SIGNER_UNAVAILABLE)
    }
    if (candidate.signerSha256 != installed.signerSha256) {
        throw AppUpdateVerificationException("更新包签名与当前应用不一致，无法安装。", AppUpdateVerificationFailure.SIGNER_MISMATCH)
    }
}

/** File names supplied by update metadata never control a destination outside this private directory. */
internal fun verifyAppUpdateFile(file: File, cacheDir: File, manifest: AppUpdateManifest): File = safelyVerify(AppUpdateVerificationFailure.FILE) {
    val cache = cacheDir.canonicalFile
    val directory = File(cache, "app-updates").canonicalFile
    val candidate = file.canonicalFile
    if (directory.parentFile != cache || directory.name != "app-updates" || candidate.parentFile != directory ||
        !file.name.endsWith(".apk") || candidate.extension != "apk" || !candidate.isFile) {
        throw AppUpdateVerificationException("更新包文件无效，请重新下载。", AppUpdateVerificationFailure.FILE)
    }
    if (manifest.apkSize !in 1L..MAX_UPDATE_BYTES || candidate.length() != manifest.apkSize) {
        throw AppUpdateVerificationException("更新包大小校验失败，请重新下载。", AppUpdateVerificationFailure.SIZE)
    }
    if (!manifest.sha256.matches(Regex("[0-9a-f]{64}"))) {
        throw AppUpdateVerificationException("更新包校验信息无效，请重新检查更新。", AppUpdateVerificationFailure.MANIFEST)
    }
    val digest = MessageDigest.getInstance("SHA-256")
    var bytesRead = 0L
    candidate.inputStream().use { input ->
        val buffer = ByteArray(32 * 1024)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (count == 0) throw AppUpdateVerificationException("更新包读取失败，请重新下载。", AppUpdateVerificationFailure.FILE)
            bytesRead += count
            if (bytesRead > manifest.apkSize || bytesRead > MAX_UPDATE_BYTES) {
                throw AppUpdateVerificationException("更新包大小校验失败，请重新下载。", AppUpdateVerificationFailure.SIZE)
            }
            digest.update(buffer, 0, count)
        }
    }
    if (bytesRead != manifest.apkSize || candidate.length() != manifest.apkSize) {
        throw AppUpdateVerificationException("更新包大小校验失败，请重新下载。", AppUpdateVerificationFailure.SIZE)
    }
    if (sha256Hex(digest.digest()) != manifest.sha256) {
        throw AppUpdateVerificationException("更新包完整性校验失败，请重新下载。", AppUpdateVerificationFailure.CHECKSUM)
    }
    candidate
}

@Suppress("DEPRECATION")
internal fun appUpdateSigningFlags(sdk: Int, archive: Boolean = false): Int = when {
    sdk < 28 -> PackageManager.GET_SIGNATURES
    // Android 9 and 10 only collect archive certificates when the legacy flag is set.
    // The actual comparison on these versions still reads SigningInfo.apkContentsSigners.
    archive -> PackageManager.GET_SIGNATURES or PackageManager.GET_SIGNING_CERTIFICATES
    else -> PackageManager.GET_SIGNING_CERTIFICATES
}

private fun sha256Hex(bytes: ByteArray): String = bytes.joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

private inline fun <T> safelyVerify(
    reason: AppUpdateVerificationFailure = AppUpdateVerificationFailure.PLATFORM,
    block: () -> T,
): T = try {
    block()
} catch (error: AppUpdateVerificationException) {
    throw error
} catch (_: Exception) {
    throw AppUpdateVerificationException("无法验证更新包，请重新检查更新后下载。", reason)
}

private const val MAX_UPDATE_BYTES = 64L * 1024 * 1024
