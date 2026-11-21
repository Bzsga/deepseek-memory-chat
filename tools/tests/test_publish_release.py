"""Publisher validation using synthetic ZIPs and local-only SSH substitutes."""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import types
import unittest
import uuid
import warnings
import zipfile
from pathlib import Path
from unittest import mock


WORK = Path(__file__).resolve().parent
SCRIPT = Path(__file__).resolve().parents[1] / "publish_release.py"
SPEC = importlib.util.spec_from_file_location("continuation_publisher_test_target", SCRIPT)
publisher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = publisher
with mock.patch.object(sys, "path", [str(SCRIPT.parent), *sys.path]):
    SPEC.loader.exec_module(publisher)


class ArtifactFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="publisher-unit-", dir=WORK)
        self.root = Path(self.temporary.name).resolve()
        self.assertTrue(self.root.is_relative_to(WORK))
        self.addCleanup(self.temporary.cleanup)
        for target in ("socket.create_connection", "socket.socket.connect"):
            patcher = mock.patch(target, side_effect=AssertionError("Unit tests cannot access the network"))
            patcher.start()
            self.addCleanup(patcher.stop)
        self.apk = self.root / "synthetic.apk"
        self.metadata_path = self.root / "verified-metadata.json"
        self.write_apk()
        # Fabricated verification metadata exercises publisher checks using local fixtures.
        self.metadata = {
            "packageName": publisher.PACKAGE_NAME,
            "versionCode": 7,
            "versionName": "1.0.7",
            "minSdk": 26,
            "apkSha256": publisher.file_sha256(self.apk),
            "signatureVerified": True,
            "signingCertificateSha256": hashlib.sha256(b"synthetic certificate fixture").hexdigest(),
        }
        self.write_metadata()

    def write_apk(self, entries=None):
        entries = entries if entries is not None else [
            ("AndroidManifest.xml", b"synthetic manifest fixture"),
            ("classes.dex", b"dex\n035\x00synthetic bytecode fixture"),
        ]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.apk, "w", compression=zipfile.ZIP_STORED) as archive:
                for name, content in entries:
                    archive.writestr(name, content)

    def write_metadata(self):
        self.metadata_path.write_text(json.dumps(self.metadata), encoding="utf-8")

    def prepare(self, **kwargs):
        kwargs.setdefault("released_at", "2026-11-04T01:02:03Z")
        return publisher.prepare_release(self.apk, self.metadata_path, **kwargs)

    def assert_rejected(self, expected, **kwargs):
        with self.assertRaises(publisher.PublishError) as caught:
            self.prepare(**kwargs)
        self.assertEqual(caught.exception.code, expected)

    def run_main(self, arguments):
        output, errors = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            result = publisher.main(arguments)
        return result, json.loads(output.getvalue())

    def arguments(self):
        return ["publish", "--apk", str(self.apk), "--verified-metadata", str(self.metadata_path)]


class PublisherTests(ArtifactFixture):
    def test_manifest_shape_hash_identity_and_output_bounds(self):
        notes = ["修复合成测试条目", "更新发布检查"]
        manifest, signer = self.prepare(changelog=notes)
        self.assertEqual(set(manifest), {"schemaVersion", "packageName", "versionCode", "versionName",
            "apkUrl", "apkSize", "sha256", "minSdk", "releasedAt", "changelog"})
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertEqual(manifest["packageName"], "app.banzhan.deepseekcontinuation")
        self.assertEqual(manifest["versionCode"], 7)
        self.assertEqual(manifest["versionName"], "1.0.7")
        self.assertEqual(manifest["minSdk"], 26)
        self.assertEqual(manifest["apkSize"], self.apk.stat().st_size)
        self.assertEqual(manifest["sha256"], hashlib.sha256(self.apk.read_bytes()).hexdigest())
        self.assertEqual(manifest["apkUrl"], "https://digimonlegend.com/continuation-updates/apks/7/deepseek-continuation-7.apk")
        self.assertEqual(manifest["changelog"], notes)
        self.assertEqual(manifest["releasedAt"], "2026-11-04T01:02:03Z")
        self.assertRegex(manifest["sha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(signer, r"^[0-9a-f]{64}$")
        self.assertEqual(json.loads(json.dumps(manifest)), manifest)
        self.assertLessEqual(len(json.dumps(manifest, ensure_ascii=False).encode()), publisher.MAX_MANIFEST_BYTES)

    def test_fingerprint_input_is_normalized_to_lowercase(self):
        self.metadata["signingCertificateSha256"] = self.metadata["signingCertificateSha256"].upper()
        self.metadata["apkSha256"] = self.metadata["apkSha256"].upper()
        self.write_metadata()
        manifest, signer = self.prepare()
        self.assertEqual(signer, self.metadata["signingCertificateSha256"].lower())
        self.assertEqual(manifest["sha256"], self.metadata["apkSha256"].lower())

    def test_signature_assertion_must_be_literal_true(self):
        for value in (False, None, 1, "true", {}, []):
            with self.subTest(value=value):
                self.metadata["signatureVerified"] = value
                self.write_metadata()
                self.assert_rejected("signature_verification_assertion_required")

    def test_unverified_metadata_shape_and_foreign_package_rejected(self):
        for value in ([], None, True, "metadata"):
            with self.subTest(value=value):
                self.metadata_path.write_text(json.dumps(value), encoding="utf-8")
                self.assert_rejected("signature_verification_assertion_required")
        self.metadata["packageName"] = "synthetic.unrelated.package"
        self.write_metadata()
        self.assert_rejected("package_mismatch")

    def test_digest_mismatch_and_invalid_signer_rejected(self):
        self.metadata["apkSha256"] = "0" * 64
        self.write_metadata()
        self.assert_rejected("verified_apk_hash_mismatch")
        self.metadata["apkSha256"] = publisher.file_sha256(self.apk)
        for value in (None, "", "a" * 63, "a" * 65, "g" * 64, True):
            with self.subTest(value=value):
                self.metadata["signingCertificateSha256"] = value
                self.write_metadata()
                self.assert_rejected("signer_fingerprint_required")

    def test_version_and_sdk_numbers_reject_booleans_and_invalid_bounds(self):
        original = dict(self.metadata)
        for field, values, code in (
            ("versionCode", [True, False, 0, -1, 2**31, 7.0, "7", None], "version_code_invalid"),
            ("minSdk", [True, False, 0, -1, 101, 26.0, "26", None], "min_sdk_invalid"),
        ):
            for value in values:
                with self.subTest(field=field, value=value):
                    self.metadata = {**original, field: value}
                    self.write_metadata()
                    self.assert_rejected(code)

    def test_version_name_and_changelog_bounds(self):
        for value in (None, True, 7, "", "  \n", "a" * 81):
            with self.subTest(version_name=value):
                self.metadata["versionName"] = value
                self.write_metadata()
                self.assert_rejected("version_name_invalid")
        self.metadata["versionName"] = "a" * 80
        self.write_metadata()
        self.prepare(changelog=["b" * 200] * 8)
        for notes in ("note", {}, [""], ["   "], [True], [1], [None], ["x" * 201], ["note"] * 9):
            with self.subTest(changelog=notes):
                self.assert_rejected("changelog_invalid", changelog=notes)

    def test_code_ten_requires_plain_numeric_version_but_preserves_legacy_preview(self):
        self.metadata.update(versionCode=9, versionName="1.0.0-preview.9")
        self.write_metadata()
        self.assertEqual(self.prepare()[0]["versionName"], "1.0.0-preview.9")
        self.metadata["versionCode"] = 10
        for name in ("1.0.0-preview.10", "1.0.1+build", "v1.0.1", "1.0", "1.0.1.2",
                     "01.0.1", "1.00.1", "1.0.01", "1.0.1 ", "１.0.1"):
            with self.subTest(name=name):
                self.metadata["versionName"] = name
                self.write_metadata()
                self.assert_rejected("numeric_version_name_required")
        for name in ("0.0.0", "1.0.1", "1.10.0", "10.2.31"):
            with self.subTest(name=name):
                self.metadata["versionName"] = name
                self.write_metadata()
                self.assertEqual(self.prepare()[0]["versionName"], name)

    def test_release_timestamp_requires_timezone(self):
        for value in ("invalid", "2026-11-04T12:00:00", True, ["date"]):
            with self.subTest(timestamp=value):
                self.assert_rejected("release_time_invalid", released_at=value)

    def test_apk_structure_requires_single_manifest_and_primary_dex(self):
        invalid = [
            [], [("AndroidManifest.xml", b"m")], [("classes.dex", b"d")],
            [("AndroidManifest.xml", b"m"), ("classes2.dex", b"d")],
            [("AndroidManifest.xml", b"m"), ("AndroidManifest.xml", b"m2"), ("classes.dex", b"d")],
            [("AndroidManifest.xml", b"m"), ("classes.dex", b"d"), ("classes.dex", b"d2")],
        ]
        for entries in invalid:
            with self.subTest(entries=entries):
                self.write_apk(entries)
                self.metadata["apkSha256"] = publisher.file_sha256(self.apk)
                self.write_metadata()
                self.assert_rejected("apk_structure_invalid")

    def test_bad_zip_size_path_and_metadata_limits(self):
        wrong_extension = self.root / "synthetic.bin"
        wrong_extension.write_bytes(self.apk.read_bytes())
        directory = self.root / "directory.apk"
        directory.mkdir()
        for path in (wrong_extension, directory):
            with self.subTest(path=path.name), self.assertRaises(publisher.PublishError) as caught:
                publisher.prepare_release(path, self.metadata_path)
            self.assertEqual(caught.exception.code, "apk_size_or_path_invalid")
        with mock.patch.object(publisher, "MAX_APK_BYTES", 1):
            self.assert_rejected("apk_size_or_path_invalid")
        self.apk.write_bytes(b"synthetic invalid zip")
        self.metadata["apkSha256"] = publisher.file_sha256(self.apk)
        self.write_metadata()
        self.assert_rejected("apk_structure_invalid")
        self.apk.write_bytes(b"")
        self.assert_rejected("apk_size_or_path_invalid")
        self.write_apk()
        self.metadata["apkSha256"] = publisher.file_sha256(self.apk)
        self.metadata_path.write_bytes(b"{" + b" " * publisher.MAX_MANIFEST_BYTES)
        self.assert_rejected("metadata_too_large")
        self.metadata_path.write_bytes(b"{broken-json")
        self.assert_rejected("metadata_invalid_json")

    def test_dry_run_does_not_import_ssh_helper_or_connect(self):
        helper = self.root / "synthetic_ssh_helper.py"
        helper.write_text("raise AssertionError('dry-run imported SSH helper')\n", encoding="utf-8")
        with mock.patch.object(publisher, "connect", side_effect=AssertionError("dry-run connected")), \
                mock.patch.object(publisher.importlib.util, "spec_from_file_location", side_effect=AssertionError("dry-run imported a helper")):
            result, value = self.run_main(self.arguments() + ["--ssh-helper", str(helper), "--dry-run"])
            no_helper_result, no_helper_value = self.run_main(self.arguments() + ["--dry-run"])
        self.assertEqual(result, 0)
        self.assertEqual(no_helper_result, 0)
        self.assertEqual(value["status"], "dry_run")
        self.assertFalse(value["remote_checked"])
        self.assertTrue(value["signature_assertion_bound_to_apk"])
        self.assertEqual(no_helper_value["manifest"]["sha256"], self.metadata["apkSha256"])

    def test_dry_run_validates_changelog_file_before_ssh(self):
        notes = self.root / "changelog.json"
        notes.write_text(json.dumps(["本地合成检查"]), encoding="utf-8")
        with mock.patch.object(publisher, "connect", side_effect=AssertionError("dry-run connected")):
            result, value = self.run_main(self.arguments() + ["--changelog-file", str(notes), "--dry-run"])
            self.assertEqual(result, 0)
            self.assertEqual(value["manifest"]["changelog"], ["本地合成检查"])
            notes.write_text('{"wrong":"shape"}', encoding="utf-8")
            result, value = self.run_main(self.arguments() + ["--changelog-file", str(notes), "--dry-run"])
        self.assertEqual(result, 2)
        self.assertEqual(value["error"], "changelog_invalid")

    def test_cos_stage_dry_run_reports_target_without_upload_or_ssh(self):
        target = {"url": "https://download.example.invalid/apks/7/file.apk"}
        with mock.patch.object(publisher, "cos_release_plan", return_value=target) as plan, \
                mock.patch.object(publisher, "stage_cos_release") as upload, \
                mock.patch.object(publisher, "connect") as connect:
            result, value = self.run_main(["stage-cos", *self.arguments()[1:], "--dry-run"])
        self.assertEqual((result, value["status"], value["cos"]), (0, "dry_run", target))
        self.assertEqual(plan.call_args.args[0]["sha256"], self.metadata["apkSha256"])
        upload.assert_not_called()
        connect.assert_not_called()

    def test_cos_stage_verifies_mirror_without_publishing_update(self):
        mirror = {"status": "uploaded", "url": "https://download.example.invalid/apks/7/file.apk"}
        with mock.patch.object(publisher, "cos_release_plan", return_value={}), \
                mock.patch.object(publisher, "stage_cos_release", return_value=mirror) as upload, \
                mock.patch.object(publisher, "connect") as connect:
            result, value = self.run_main(["stage-cos", *self.arguments()[1:]])
        self.assertEqual((result, value), (0, {"ok": True, **mirror}))
        upload.assert_called_once()
        connect.assert_not_called()

    def test_cos_publish_keeps_site_unchanged_if_mirror_fails(self):
        client = mock.Mock()
        with mock.patch.object(publisher, "connect", return_value=client), \
                mock.patch.object(publisher, "cos_release_plan", return_value={}), \
                mock.patch.object(publisher, "stage_cos_release", side_effect=publisher.CosReleaseError("cos_credentials_missing")), \
                mock.patch.object(publisher, "publish") as publish:
            result, value = self.run_main(self.arguments() + ["--cos", "--ssh-helper", "unused"])
        self.assertEqual((result, value["error"]), (2, "cos_credentials_missing"))
        publish.assert_not_called()
        client.close.assert_called_once()

    def test_cos_publish_reports_committed_release_when_route_fails(self):
        client, target = mock.Mock(), {"url": "https://download.example.invalid/apks/7/file.apk"}
        status = {"ok": True, "status": "published"}
        with mock.patch.object(publisher, "connect", return_value=client), \
                mock.patch.object(publisher, "cos_release_plan", return_value=target), \
                mock.patch.object(publisher, "stage_cos_release", return_value=target), \
                mock.patch.object(publisher, "publish", return_value=status), \
                mock.patch.object(publisher, "route_cos", side_effect=publisher.PublishError("nginx_reload_failed")) as route:
            result, value = self.run_main(self.arguments() + ["--cos", "--ssh-helper", "unused"])
        self.assertEqual((result, value["error"]), (2, "nginx_reload_failed"))
        self.assertTrue(value["release_published"])
        self.assertEqual(value["result"]["status"], "published")
        route.assert_called_once()
        client.close.assert_called_once()

    def test_route_cos_verifies_public_mirror_without_uploading(self):
        client = mock.Mock()
        target = {"url": "https://download.example.invalid/apks/7/file.apk"}
        with mock.patch.object(publisher, "cos_release_plan", return_value=target), \
                mock.patch.object(publisher, "connect", return_value=client), \
                mock.patch.object(publisher, "stage_cos_release") as stage, \
                mock.patch.object(publisher, "verify_cos_route") as verify, \
                mock.patch.object(publisher, "route_cos", return_value={"ok": True, "status": "routed"}) as route:
            command = ["route-cos", *self.arguments()[1:], "--ssh-helper", "unused"]
            result, value = self.run_main(command)
            self.assertEqual((result, value["status"]), (0, "routed"))
            verify.assert_called_once()
            route.assert_called_once_with(client, verify.call_args.args[1], target)
            client.close.assert_called_once()
            verify.side_effect = publisher.CosReleaseError("cos_public_apk_mismatch")
            route.reset_mock()
            result, value = self.run_main(command)
            self.assertEqual((result, value["error"]), (2, "cos_public_apk_mismatch"))
            route.assert_not_called()
            stage.assert_not_called()

    def test_route_cos_curl_checks_full_sha_and_partial_range(self):
        manifest, _ = self.prepare()
        contents = self.apk.read_bytes()
        target = {"url": "https://download.example.invalid/apks/7/file.apk"}

        def responses(command, **_):
            self.assertEqual(command[-1], target["url"])
            self.assertEqual(command[1], "-q")
            self.assertNotIn("--location", command)
            output = Path(command[command.index("--output") + 1])
            header = Path(command[command.index("--dump-header") + 1])
            if "--range" in command:
                output.write_bytes(contents[:4])
                header.write_bytes(f"Content-Range: bytes 0-3/{len(contents)}\r\n".encode())
                return mock.Mock(returncode=0, stdout=b"206")
            output.write_bytes(contents)
            return mock.Mock(returncode=0, stdout=b"200")

        with mock.patch.object(publisher.shutil, "which", return_value="synthetic-curl"), \
                mock.patch.object(publisher.subprocess, "run", side_effect=responses) as run:
            publisher.verify_cos_route(self.apk, manifest, target)
            self.assertEqual(run.call_count, 2)
            with self.assertRaises(publisher.CosReleaseError) as caught:
                publisher.verify_cos_route(self.apk, {**manifest, "sha256": "0" * 64}, target)
            self.assertEqual(caught.exception.code, "cos_public_apk_mismatch")
            self.assertEqual(run.call_count, 3)

    def test_real_publish_requires_explicit_trusted_helper(self):
        with mock.patch.object(publisher.importlib.util, "spec_from_file_location", side_effect=AssertionError("unexpected helper import")):
            result, value = self.run_main(self.arguments())
        self.assertEqual(result, 2)
        self.assertEqual(value["error"], "explicit_trusted_ssh_helper_required")
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            publisher.main(["prepare-hosting"])
        self.assertEqual(caught.exception.code, 2)

    def test_selected_helper_is_loaded_only_when_explicitly_requested(self):
        helper = self.root / "trusted_synthetic.py"
        helper.write_text("def connect():\n    return 'synthetic-client'\n", encoding="utf-8")
        self.assertEqual(publisher.connect(helper), "synthetic-client")
        with self.assertRaises(publisher.PublishError) as caught:
            publisher.connect(None)
        self.assertEqual(caught.exception.code, "explicit_trusted_ssh_helper_required")

    def test_hosting_plan_is_only_compiled_and_mocked(self):
        compile(publisher.PREPARE_HOSTING, "prepare-hosting-plan", "exec")
        compile(publisher.CREATE_STAGE, "create-stage-plan", "exec")
        compile(publisher.COMMIT_RELEASE, "commit-release-plan", "exec")
        compile(publisher.CLEAN_STAGE, "clean-stage-plan", "exec")
        client = object()
        with mock.patch.object(publisher, "remote_python", return_value={"ok": True, "status": "prepared"}) as remote:
            self.assertEqual(publisher.prepare_hosting(client)["status"], "prepared")
        remote.assert_called_once_with(client, publisher.PREPARE_HOSTING,
                                       {"snippet": publisher.NGINX_SNIPPET, "mirror_include": publisher.MIRROR_INCLUDE})

    def test_publish_sftp_lifecycle_and_failure_cleanup(self):
        manifest, signer = self.prepare()
        client = mock.Mock()
        sftp = client.open_sftp.return_value
        with mock.patch.object(publisher, "remote_python", side_effect=[{"ok": True}, {"ok": True, "status": "published"}]) as remote:
            result = publisher.publish(client, self.apk, manifest, signer)
        self.assertEqual(result["status"], "published")
        first_call, commit_call = remote.call_args_list
        stage = first_call.args[2]["stage"]
        self.assertRegex(stage, r"^[0-9a-f]{32}$")
        self.assertEqual(first_call.args[1], publisher.CREATE_STAGE)
        self.assertEqual(commit_call.args[1], publisher.COMMIT_RELEASE)
        self.assertEqual(commit_call.args[2], {"stage": stage, "manifest": manifest, "signer": signer})
        sftp.put.assert_called_once_with(str(self.apk.resolve()), publisher.REMOTE_ROOT + "/.staging/" + stage + "/package.apk")
        sftp.chmod.assert_called_once()
        sftp.close.assert_called_once()
        client.reset_mock()
        sftp.put.side_effect = OSError("synthetic upload failure")
        with mock.patch.object(publisher, "remote_python", side_effect=[{"ok": True}, {"ok": True}]) as remote:
            with self.assertRaises(OSError):
                publisher.publish(client, self.apk, manifest, signer)
        self.assertEqual(remote.call_args_list[-1].args[1], publisher.CLEAN_STAGE)
        sftp.close.assert_called_once()

    def test_remote_response_errors_are_bounded_and_sanitized(self):
        for raw, status, expected in (
            (b'{"ok":false,"error":"version_downgrade_refused"}', 1, "version_downgrade_refused"),
            (b'{"ok":false,"error":"SYNTHETIC PRIVATE DETAIL"}', 1, "remote_operation_failed"),
            (b"not json", 0, "remote_response_invalid"),
            (b"x" * 65537, 0, "remote_response_too_large"),
        ):
            with self.subTest(expected=expected):
                client = mock.Mock()
                stdin, stdout, stderr = mock.Mock(), mock.Mock(), mock.Mock()
                stdout.read.return_value = raw
                stdout.channel.recv_exit_status.return_value = status
                client.exec_command.return_value = (stdin, stdout, stderr)
                with self.assertRaises(publisher.PublishError) as caught:
                    publisher.remote_python(client, "print('synthetic')", {"key": "value"})
                self.assertEqual(caught.exception.code, expected)
                client.exec_command.assert_called_once_with("python3 -", timeout=120)
                stdin.channel.shutdown_write.assert_called_once()


class RemoteCommitTests(ArtifactFixture):
    def setUp(self):
        super().setUp()
        self.hosting_root = self.root / "synthetic-static-host"
        self.hosting_root.mkdir()
        (self.hosting_root / "apks").mkdir()
        (self.hosting_root / ".staging").mkdir()
        self.fcntl = types.ModuleType("fcntl")
        self.fcntl.LOCK_EX = 2
        self.fcntl.flock = mock.Mock()

    def stage_and_commit(self, manifest, signer, package_bytes=None):
        token = uuid.uuid4().hex
        stage = self.hosting_root / ".staging" / token
        stage.mkdir()
        self.assertTrue(stage.resolve().is_relative_to(self.root))
        (stage / "package.apk").write_bytes(self.apk.read_bytes() if package_bytes is None else package_bytes)
        marker = "Path('/var/www/deepseek-continuation-updates')"
        self.assertEqual(publisher.COMMIT_RELEASE.count(marker), 1)
        source = publisher.COMMIT_RELEASE.replace(marker, f"Path({str(self.hosting_root)!r})")
        namespace = {"json": json, "PAYLOAD": {"stage": token, "manifest": manifest, "signer": signer}}
        output, exit_code = io.StringIO(), 0
        with mock.patch.dict(sys.modules, {"fcntl": self.fcntl}), contextlib.redirect_stdout(output):
            try:
                exec(compile(source, "sandboxed-commit-release", "exec"), namespace)
            except SystemExit as error:
                exit_code = error.code
        self.assertFalse(stage.exists())
        return exit_code, json.loads(output.getvalue())

    def release(self, code, name):
        self.metadata.update(versionCode=code, versionName=name)
        self.write_metadata()
        return self.prepare()

    def test_cos_route_matches_live_release_and_recovers_failed_reload(self):
        manifest, signer = self.release(47, "2.6.9")
        self.assertEqual(self.stage_and_commit(manifest, signer)[0], 0)
        server = self.root / "nginx"
        server.mkdir()
        snippet = server / "updates.conf"
        snippet.write_bytes(publisher.NGINX_SNIPPET.encode())
        directory = server / "mirrors"
        site = server / "site"
        site.write_text("    include /etc/nginx/snippets/deepseek-continuation-updates.conf;\n")
        replacements = {
            "Path('/var/www/deepseek-continuation-updates')": self.hosting_root,
            "Path('/etc/nginx/snippets/deepseek-continuation-updates.conf')": snippet,
            "Path('/etc/nginx/deepseek-continuation-mirrors')": directory,
            "Path('/etc/nginx/sites-enabled/digimon_website')": site,
            "Path('/etc/nginx/sites-available/digimon_website')": site,
        }
        source = publisher.ROUTE_COS
        for marker, path in replacements.items():
            self.assertIn(marker, source)
            source = source.replace(marker, f"Path({str(path)!r})")
        origin = "https://download.example.invalid"
        settings = {"DEEPSEEK_COS_BUCKET": "example-123", "DEEPSEEK_COS_REGION": "ap-guangzhou",
                    "DEEPSEEK_COS_ORIGIN": origin}
        with mock.patch.dict(os.environ, settings), \
                mock.patch.object(publisher, "remote_python") as remote:
            target = publisher.cos_release_plan(manifest)
            publisher.route_cos(object(), manifest, target)
        payload = remote.call_args.args[2]
        latest_path = self.hosting_root / "latest.json"
        latest_original = latest_path.read_bytes()

        def run(payload, returncodes):
            results = [mock.Mock(returncode=code) for code in returncodes]
            namespace = {"json": json, "PAYLOAD": payload}
            output = io.StringIO()
            with mock.patch.dict(sys.modules, {"fcntl": self.fcntl}), \
                    mock.patch.object(publisher.subprocess, "run", side_effect=results), \
                    contextlib.redirect_stdout(output):
                try:
                    exec(compile(source, "sandboxed-cos-route", "exec"), namespace)
                except SystemExit:
                    pass
            self.assertEqual(latest_path.read_bytes(), latest_original)
            return json.loads(output.getvalue())

        mismatch = {**payload, "manifest": {**manifest, "sha256": "f" * 64}}
        self.assertEqual(run(mismatch, [])["error"], "cos_route_latest_mismatch")
        self.assertFalse(directory.exists())
        self.assertEqual(run(payload, [0, 1, 0, 0])["error"], "nginx_reload_failed")
        self.assertFalse(directory.exists())
        self.assertEqual(snippet.read_bytes(), publisher.NGINX_SNIPPET.encode())
        self.assertEqual(run(payload, [0, 0])["status"], "routed")
        self.assertEqual(snippet.read_bytes(), (publisher.NGINX_SNIPPET + publisher.MIRROR_INCLUDE).encode())
        self.assertEqual((directory / "apk-47.conf").read_bytes(), payload["route"].encode())
        self.assertEqual(run(payload, [0, 0])["status"], "already_routed")

    def test_preview_to_numeric_upgrade_preserves_legacy_retry(self):
        preview, signer = self.release(9, "1.0.0-preview.9")
        self.assertEqual(self.stage_and_commit(preview, signer)[1]["status"], "published")
        self.assertEqual(self.stage_and_commit(preview, signer)[1]["status"], "already_published")
        numeric, _ = self.release(10, "1.0.1")
        code, result = self.stage_and_commit(numeric, signer)
        self.assertEqual(code, 0)
        self.assertEqual(result["status"], "published")
        self.assertEqual(result["manifest"]["versionName"], "1.0.1")

    def test_higher_code_must_increase_numeric_name_and_preserve_latest_on_failure(self):
        initial, signer = self.release(10, "1.2.3")
        self.stage_and_commit(initial, signer)
        latest = self.hosting_root / "latest.json"
        original = latest.read_bytes()
        for name in ("1.2.3", "1.2.2", "1.1.99", "0.99.99"):
            with self.subTest(name=name):
                candidate, _ = self.release(11, name)
                code, result = self.stage_and_commit(candidate, signer)
                self.assertEqual(code, 1)
                self.assertEqual(result["error"], "version_name_not_increasing")
                self.assertEqual(latest.read_bytes(), original)
                self.assertFalse((self.hosting_root / "apks" / "11").exists())

    def test_numeric_upgrade_compares_components_and_same_code_still_requires_exact_identity(self):
        initial, signer = self.release(10, "1.9.9")
        self.stage_and_commit(initial, signer)
        changed_name, _ = self.release(10, "1.9.10")
        code, result = self.stage_and_commit(changed_name, signer)
        self.assertEqual(code, 1)
        self.assertEqual(result["error"], "same_version_metadata_or_hash_conflict")
        newer, _ = self.release(11, "1.10.0")
        code, result = self.stage_and_commit(newer, signer)
        self.assertEqual(code, 0)
        self.assertEqual(result["status"], "published")
        latest = self.hosting_root / "latest.json"
        original = latest.read_bytes()
        code, result = self.stage_and_commit(newer, signer)
        self.assertEqual(code, 0)
        self.assertEqual(result["status"], "already_published")
        self.assertEqual(latest.read_bytes(), original)

    def test_remote_numeric_name_guard_cannot_be_bypassed_with_forged_payload(self):
        initial, signer = self.release(10, "1.0.1")
        self.stage_and_commit(initial, signer)
        latest = self.hosting_root / "latest.json"
        original = latest.read_bytes()
        candidate, _ = self.release(11, "1.0.2")
        for name in ("1.0.2-preview.11", "v1.0.2", "01.0.2"):
            with self.subTest(name=name):
                code, result = self.stage_and_commit({**candidate, "versionName": name}, signer)
                self.assertEqual(code, 1)
                self.assertEqual(result["error"], "numeric_version_name_required")
                self.assertEqual(latest.read_bytes(), original)
                self.assertFalse((self.hosting_root / "apks" / "11").exists())

    def test_initial_commit_and_same_version_are_idempotent(self):
        manifest, signer = self.prepare(changelog=["initial synthetic release"])
        exit_code, result = self.stage_and_commit(manifest, signer)
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["status"], "published")
        latest = self.hosting_root / "latest.json"
        saved_bytes = latest.read_bytes()
        target = self.hosting_root / "apks" / "7" / "deepseek-continuation-7.apk"
        self.assertEqual(target.read_bytes(), self.apk.read_bytes())
        changed_notes = {**manifest, "changelog": ["different synthetic notes"], "releasedAt": "2026-11-05T01:02:03Z"}
        exit_code, result = self.stage_and_commit(changed_notes, signer)
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["status"], "already_published")
        self.assertEqual(latest.read_bytes(), saved_bytes)
        self.assertEqual(result["manifest"], manifest)
        self.assertEqual(self.fcntl.flock.call_count, 2)

    def test_same_version_new_hash_is_rejected_without_replacing_latest(self):
        manifest, signer = self.prepare()
        self.stage_and_commit(manifest, signer)
        latest = self.hosting_root / "latest.json"
        original = latest.read_bytes()
        self.write_apk([("AndroidManifest.xml", b"synthetic different manifest"), ("classes.dex", b"synthetic different dex")])
        self.metadata["apkSha256"] = publisher.file_sha256(self.apk)
        self.write_metadata()
        changed, _ = self.prepare()
        exit_code, result = self.stage_and_commit(changed, signer)
        self.assertEqual(exit_code, 1)
        self.assertEqual(result["error"], "same_version_metadata_or_hash_conflict")
        self.assertEqual(latest.read_bytes(), original)

    def test_downgrade_and_signer_change_preserve_latest(self):
        manifest, signer = self.prepare()
        self.stage_and_commit(manifest, signer)
        latest = self.hosting_root / "latest.json"
        original = latest.read_bytes()
        self.metadata.update(versionCode=6, versionName="1.0.6")
        self.write_metadata()
        older, _ = self.prepare()
        exit_code, result = self.stage_and_commit(older, signer)
        self.assertEqual(exit_code, 1)
        self.assertEqual(result["error"], "version_downgrade_refused")
        self.assertEqual(latest.read_bytes(), original)
        self.metadata.update(versionCode=8, versionName="1.0.8")
        self.write_metadata()
        newer, _ = self.prepare()
        exit_code, result = self.stage_and_commit(newer, hashlib.sha256(b"different synthetic signer").hexdigest())
        self.assertEqual(exit_code, 1)
        self.assertEqual(result["error"], "signer_changed")
        self.assertEqual(latest.read_bytes(), original)
        self.assertFalse((self.hosting_root / "apks" / "8").exists())

    def test_remote_sha_mismatch_preserves_latest(self):
        manifest, signer = self.prepare()
        self.stage_and_commit(manifest, signer)
        latest = self.hosting_root / "latest.json"
        original = latest.read_bytes()
        mutated = bytearray(self.apk.read_bytes())
        mutated[0] ^= 1
        exit_code, result = self.stage_and_commit(manifest, signer, bytes(mutated))
        self.assertEqual(exit_code, 1)
        self.assertEqual(result["error"], "remote_sha256_mismatch")
        self.assertEqual(latest.read_bytes(), original)


if __name__ == "__main__":
    unittest.main(verbosity=2)
