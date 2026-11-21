"""Stage and verify a signed-release APK on Tencent Cloud COS."""

import hashlib
import logging
import os
import re
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


MAX_APK_BYTES = 64 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024


class CosReleaseError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def cos_release_plan(manifest):
    bucket = os.environ.get("DEEPSEEK_COS_BUCKET", "")
    region = os.environ.get("DEEPSEEK_COS_REGION", "")
    origin = os.environ.get("DEEPSEEK_COS_ORIGIN", "")
    if len(bucket) > 63 or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[0-9]+", bucket):
        raise CosReleaseError("cos_bucket_invalid")
    if len(region) > 63 or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", region):
        raise CosReleaseError("cos_region_invalid")
    try:
        parts = urlsplit(origin)
        valid_origin = (re.fullmatch(r"https://[A-Za-z0-9.\-:\[\]]+/?", origin, re.IGNORECASE)
                        and parts.hostname
                        and not parts.netloc.endswith(":") and parts.port != 0)
    except ValueError:
        valid_origin = False
    if not valid_origin:
        raise CosReleaseError("cos_origin_invalid")
    if not isinstance(manifest, dict):
        raise CosReleaseError("cos_manifest_invalid")
    version, checksum = manifest.get("versionCode"), manifest.get("sha256")
    if (type(version) is not int or not 1 <= version <= 2_147_483_647
            or not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum)):
        raise CosReleaseError("cos_manifest_invalid")
    key = f"apks/{version}/{checksum}/deepseek-continuation-{version}.apk"
    return {"bucket": bucket, "region": region, "key": key, "url": f"https://{parts.netloc}/{key}"}


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _verify_public(url, size, checksum, prefix, *, allow_missing=False):
    opener = build_opener(_NoRedirects())
    headers = {"Accept-Encoding": "identity", "Cache-Control": "no-cache"}
    checking_range = False
    try:
        with opener.open(Request(url, headers=headers), timeout=30) as response:
            if response.status != 200 or response.geturl() != url:
                raise CosReleaseError("cos_public_download_failed")
            digest, received = hashlib.sha256(), 0
            while chunk := response.read(CHUNK_BYTES):
                received += len(chunk)
                if received > size:
                    raise CosReleaseError("cos_public_apk_mismatch")
                digest.update(chunk)
            if received != size or digest.hexdigest() != checksum:
                raise CosReleaseError("cos_public_apk_mismatch")
        checking_range = True
        with opener.open(Request(url, headers={**headers, "Range": "bytes=0-3"}), timeout=30) as response:
            if (response.status != 206 or response.geturl() != url
                    or response.headers.get("Content-Range") != f"bytes 0-3/{size}"
                    or response.read(5) != prefix):
                raise CosReleaseError("cos_public_range_invalid")
    except HTTPError as error:
        if error.fp is not None:
            error.close()
        if allow_missing and not checking_range and error.code == 404:
            return False
        raise CosReleaseError("cos_public_range_invalid" if checking_range else "cos_public_download_failed") from None
    except (OSError, ValueError, HTTPException):
        raise CosReleaseError("cos_public_range_invalid" if checking_range else "cos_public_download_failed") from None
    return True


def _put_object(target, data):
    secret_id = os.environ.get("DEEPSEEK_COS_SECRET_ID")
    secret_key = os.environ.get("DEEPSEEK_COS_SECRET_KEY")
    if not secret_id or not secret_id.strip() or not secret_key or not secret_key.strip():
        raise CosReleaseError("cos_credentials_required")
    # The SDK can log request signatures and raw error responses at some levels.
    previous_level = logging.root.manager.disable
    logging.disable(max(previous_level, logging.CRITICAL))
    try:
        try:
            from qcloud_cos import CosConfig, CosS3Client, CosServiceError
        except Exception:
            raise CosReleaseError("cos_sdk_required") from None
        try:
            config = CosConfig(Region=target["region"], SecretId=secret_id, SecretKey=secret_key,
                               Token=os.environ.get("DEEPSEEK_COS_SESSION_TOKEN") or None,
                               Scheme="https", AllowRedirects=False, Timeout=60)
            CosS3Client(config, retry=0).put_object(
                Bucket=target["bucket"], Body=data, Key=target["key"], EnableMD5=True,
                ForbidOverwrite="true", ContentType="application/vnd.android.package-archive",
                CacheControl="public, max-age=31536000, immutable",
            )
        except CosServiceError as error:
            if error.get_status_code() == 409:
                return False
            raise CosReleaseError("cos_upload_failed") from None
        except Exception:
            raise CosReleaseError("cos_upload_failed") from None
    finally:
        logging.disable(previous_level)
    return True


def stage_cos_release(apk_path, manifest, target):
    if target != cos_release_plan(manifest):
        raise CosReleaseError("cos_target_mismatch")
    size, checksum = manifest.get("apkSize"), manifest["sha256"]
    if type(size) is not int or not 4 <= size <= MAX_APK_BYTES:
        raise CosReleaseError("cos_manifest_invalid")
    try:
        apk = Path(apk_path)
        if not apk.is_file():
            raise CosReleaseError("cos_apk_mismatch")
        with apk.open("rb") as source:
            data = source.read(size + 1)
    except (OSError, TypeError):
        raise CosReleaseError("cos_apk_mismatch") from None
    if len(data) != size or hashlib.sha256(data).hexdigest() != checksum:
        raise CosReleaseError("cos_apk_mismatch")

    url, prefix = target["url"], data[:4]
    status = "already_verified"
    if not _verify_public(url, size, checksum, prefix, allow_missing=True):
        uploaded = _put_object(target, data)
        _verify_public(url, size, checksum, prefix)
        if uploaded:
            status = "uploaded"
    return {"status": status, "versionCode": manifest["versionCode"], "sha256": checksum, "url": url}
