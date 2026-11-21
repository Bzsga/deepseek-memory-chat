"""Exercise the static and COS download contracts without network access."""
import hashlib
import io
import unittest
from email.message import Message
from unittest import mock

from tools import verify_public_release as verifier


class PublicReleaseTests(unittest.TestCase):
    def setUp(self):
        self.package = b"synthetic APK bytes"
        self.digest = hashlib.sha256(self.package).hexdigest()
        self.source = verifier.PUBLIC_ORIGIN + verifier.CHANNEL + "/apks/47/deepseek-continuation-47.apk"
        self.mirror = verifier.MIRROR_ORIGIN + f"/apks/47/{self.digest}/deepseek-continuation-47.apk"
        self.manifest = {"versionCode": 47, "apkSize": len(self.package), "sha256": self.digest, "apkUrl": self.source}

    def response(self, code, headers, body=b""):
        response = io.BytesIO(body)
        response.code = code
        response.geturl = lambda: self.source
        response.headers = Message()
        for name, value in headers:
            response.headers[name] = value
        return response

    def test_static_response_checks_length_and_hash(self):
        headers = [("Content-Type", "application/vnd.android.package-archive"),
                   ("Cache-Control", "public, max-age=31536000, immutable"),
                   ("Content-Length", str(len(self.package)))]
        with mock.patch.object(verifier, "public_response", return_value=self.response(200, headers, self.package)):
            self.assertEqual(verifier.verify_apk(mock.Mock(), self.manifest),
                             (len(self.package), self.digest, self.source))
        changed = self.package[:-1] + b"x"
        with mock.patch.object(verifier, "public_response", return_value=self.response(200, headers, changed)):
            with self.assertRaisesRegex(RuntimeError, "Downloaded APK mismatch"):
                verifier.verify_apk(mock.Mock(), self.manifest)

    def test_only_one_exact_no_store_cos_redirect_is_allowed(self):
        for status, location, cache, valid in (
            (302, self.mirror, "no-store", True),
            (302, self.mirror.replace(verifier.MIRROR_ORIGIN, "https://example.invalid"), "no-store", False),
            (302, self.mirror.replace(self.digest, "a" * 64), "no-store", False),
            (302, self.mirror, "public", False),
            (301, self.mirror, "no-store", False),
        ):
            with self.subTest(status=status, location=location, cache=cache):
                opener = mock.Mock()
                redirect = self.response(status, [("Location", location), ("Cache-Control", cache)])
                with mock.patch.object(verifier, "public_response", return_value=redirect), \
                        mock.patch.object(verifier, "verify_mirror", return_value=(len(self.package), self.digest)) as fetch:
                    if valid:
                        self.assertEqual(verifier.verify_apk(opener, self.manifest),
                                         (len(self.package), self.digest, self.mirror))
                        fetch.assert_called_once_with(opener, self.mirror, len(self.package), self.digest)
                    else:
                        with self.assertRaises(RuntimeError):
                            verifier.verify_apk(opener, self.manifest)
                        fetch.assert_not_called()

    def test_cos_response_cannot_redirect_again(self):
        redirect = self.response(302, [("Location", "https://example.invalid/")])
        with mock.patch.object(verifier.shutil, "which", return_value=None), \
                mock.patch.object(verifier, "public_response", return_value=redirect) as fetch:
            with self.assertRaisesRegex(RuntimeError, "Invalid COS APK response"):
                verifier.verify_mirror(mock.Mock(), self.mirror, len(self.package), self.digest)
            fetch.assert_called_once()
