"""Exercise COS staging with only synthetic APK bytes and mocked transports."""

import hashlib
import importlib.util
import io
import logging
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError


SPEC = importlib.util.spec_from_file_location("cos_release_test_target", Path(__file__).resolve().parents[1] / "cos_release.py")
cos = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cos)
CONFIG = {
    "DEEPSEEK_COS_BUCKET": "synthetic-releases-1250000000",
    "DEEPSEEK_COS_REGION": "ap-guangzhou",
    "DEEPSEEK_COS_ORIGIN": "https://download.example.invalid/",
}
CREDENTIALS = {
    "DEEPSEEK_COS_SECRET_ID": "synthetic-id",
    "DEEPSEEK_COS_SECRET_KEY": "synthetic-key",
    "DEEPSEEK_COS_SESSION_TOKEN": "synthetic-token",
}
APK = b"PK\x03\x04synthetic APK payload"


class Response(io.BytesIO):
    def __init__(self, url, payload, status=200, headers=None):
        super().__init__(payload)
        self.url, self.status, self.headers = url, status, headers or {}

    def geturl(self):
        return self.url


class SDKError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status

    def get_status_code(self):
        return self.status


class CosReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="cos-release-unit-")
        self.addCleanup(temporary.cleanup)
        self.apk = Path(temporary.name) / "synthetic.apk"
        self.apk.write_bytes(APK)
        self.manifest = {"versionCode": 45, "apkSize": len(APK), "sha256": hashlib.sha256(APK).hexdigest()}
        env = mock.patch.dict(os.environ, CONFIG, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.target = cos.cos_release_plan(self.manifest)
        self.urlopen = mock.Mock()
        opener = mock.patch.object(cos, "build_opener", return_value=types.SimpleNamespace(open=self.urlopen))
        opener.start()
        self.addCleanup(opener.stop)
        socket = mock.patch("socket.socket.connect", side_effect=AssertionError("No live network in unit tests"))
        socket.start()
        self.addCleanup(socket.stop)
        self.put = mock.Mock()
        self.sdk = types.SimpleNamespace(CosConfig=mock.Mock(), CosS3Client=mock.Mock(return_value=types.SimpleNamespace(put_object=self.put)),
                                         CosServiceError=SDKError)
        sdk = mock.patch.dict(sys.modules, {"qcloud_cos": self.sdk})
        sdk.start()
        self.addCleanup(sdk.stop)

    def stage(self, target=None):
        return cos.stage_cos_release(self.apk, self.manifest, self.target if target is None else target)

    def full(self, payload=APK):
        return Response(self.target["url"], payload)

    def ranged(self, payload=APK[:4], *, status=206, size=len(APK)):
        return Response(self.target["url"], payload, status=status, headers={"Content-Range": f"bytes 0-3/{size}"})

    def missing(self, code=404):
        return HTTPError(self.target["url"], code, "synthetic status", {}, io.BytesIO())

    def rejected(self, code, action=None):
        with self.assertRaises(cos.CosReleaseError) as caught:
            (action or self.stage)()
        self.assertEqual(caught.exception.code, code)

    def test_plan_is_content_addressed_and_does_not_require_credentials(self):
        key = f"apks/45/{self.manifest['sha256']}/deepseek-continuation-45.apk"
        self.assertEqual(self.target, {"key": key, "url": f"https://download.example.invalid/{key}",
                                       "bucket": CONFIG["DEEPSEEK_COS_BUCKET"], "region": "ap-guangzhou"})
        self.urlopen.assert_not_called()
        self.sdk.CosConfig.assert_not_called()

    def test_invalid_configuration_and_manifest_rejected_before_network(self):
        for field, invalid, error in (
            ("BUCKET", "no-app-id", "cos_bucket_invalid"), ("REGION", "ap-foo.example.invalid", "cos_region_invalid"),
            ("ORIGIN", "http://example.invalid", "cos_origin_invalid"),
            ("ORIGIN", "https://alice:password@example.invalid", "cos_origin_invalid"),
            ("ORIGIN", "https://example.invalid/downloads", "cos_origin_invalid"),
            ("ORIGIN", "https://example.invalid?", "cos_origin_invalid"),
            ("ORIGIN", "https://example.invalid#", "cos_origin_invalid"),
        ):
            with self.subTest(field=field, invalid=invalid), mock.patch.dict(os.environ, {"DEEPSEEK_COS_" + field: invalid}):
                self.rejected(error, lambda: cos.cos_release_plan(self.manifest))
        self.rejected("cos_manifest_invalid", lambda: cos.cos_release_plan({**self.manifest, "versionCode": True}))
        self.rejected("cos_manifest_invalid", lambda: cos.cos_release_plan({**self.manifest, "sha256": "../outside"}))
        self.rejected("cos_target_mismatch", lambda: self.stage({**self.target, "key": "some-other.apk"}))
        self.urlopen.assert_not_called()

    def test_upload_uses_single_nonoverwriting_put_and_verifies_public_download_and_range(self):
        self.urlopen.side_effect = [self.missing(), self.full(), self.ranged()]
        with mock.patch.dict(os.environ, CREDENTIALS):
            self.assertEqual(self.stage(), {"status": "uploaded", "versionCode": 45,
                                           "sha256": self.manifest["sha256"], "url": self.target["url"]})
        self.sdk.CosConfig.assert_called_once_with(
            Region="ap-guangzhou", SecretId="synthetic-id", SecretKey="synthetic-key", Token="synthetic-token",
            Scheme="https", AllowRedirects=False, Timeout=60,
        )
        self.sdk.CosS3Client.assert_called_once_with(self.sdk.CosConfig.return_value, retry=0)
        self.put.assert_called_once_with(
            Bucket=self.target["bucket"], Body=APK, Key=self.target["key"], EnableMD5=True, ForbidOverwrite="true",
            ContentType="application/vnd.android.package-archive", CacheControl="public, max-age=31536000, immutable",
        )
        requests = [call.args[0] for call in self.urlopen.call_args_list]
        self.assertEqual([request.get_header("Range") for request in requests], [None, None, "bytes=0-3"])
        self.assertTrue(all(request.full_url == self.target["url"] and not request.has_header("Authorization") for request in requests))

    def test_matching_existing_download_skips_sdk_even_without_credentials(self):
        self.urlopen.side_effect = [self.full(), self.ranged()]
        self.assertEqual(self.stage()["status"], "already_verified")
        self.sdk.CosConfig.assert_not_called()

    def test_bad_existing_download_is_never_replaced(self):
        for payload in (b"x" * len(APK), APK[:-1], APK + b"x"):
            with self.subTest(size=len(payload)):
                self.urlopen.side_effect = [self.full(payload)]
                self.rejected("cos_public_apk_mismatch")
        self.put.assert_not_called()

    def test_apk_changed_after_release_verification_rejected_before_network(self):
        self.apk.write_bytes(b"x" * len(APK))
        self.rejected("cos_apk_mismatch")
        self.urlopen.assert_not_called()

    def test_conflicting_put_reuse_requires_matching_download(self):
        self.put.side_effect = SDKError(409, "synthetic private COS diagnostics")
        with mock.patch.dict(os.environ, CREDENTIALS):
            self.urlopen.side_effect = [self.missing(), self.full(), self.ranged()]
            self.assertEqual(self.stage()["status"], "already_verified")
            self.put.assert_called_once()
            self.put.reset_mock()
            self.urlopen.side_effect = [self.missing(), self.full(b"x" * len(APK))]
            self.rejected("cos_public_apk_mismatch")
            self.put.assert_called_once()

    def test_bad_range_rejects_the_mirror(self):
        for range_response in (self.ranged(status=200), self.ranged(payload=b"xxxx"),
                               self.ranged(size=len(APK) + 1), self.missing()):
            with self.subTest(response=range_response):
                self.urlopen.side_effect = [self.full(), range_response]
                self.rejected("cos_public_range_invalid")
        self.put.assert_not_called()

    def test_nonmissing_http_failure_refuses_upload_and_missing_requires_credentials(self):
        self.urlopen.side_effect = [self.missing(302), self.missing(403), self.missing()]
        self.rejected("cos_public_download_failed")
        self.rejected("cos_public_download_failed")
        self.rejected("cos_credentials_required")
        self.sdk.CosConfig.assert_not_called()
        self.put.assert_not_called()

    def test_sdk_failure_is_sanitized_and_logging_is_restored(self):
        def sdk_failure(**_kwargs):
            logging.getLogger("qcloud_cos.cos_client").critical("synthetic-key")
            raise SDKError(403, "synthetic-key")

        self.urlopen.side_effect = [self.missing()]
        self.put.side_effect = sdk_failure
        previous_level = logging.root.manager.disable
        with mock.patch.dict(os.environ, CREDENTIALS), self.assertNoLogs("qcloud_cos.cos_client"):
            with self.assertRaises(cos.CosReleaseError) as caught:
                self.stage()
        self.assertEqual(str(caught.exception), "cos_upload_failed")
        self.assertTrue(caught.exception.__suppress_context__)
        self.assertEqual(logging.root.manager.disable, previous_level)
        self.put.assert_called_once()
