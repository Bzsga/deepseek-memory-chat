"""Public download routing uses only synthetic local release metadata."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.releases import PACKAGE_NAME, build_release_router


@pytest.fixture
def release(tmp_path):
    app = FastAPI()
    app.include_router(build_release_router(tmp_path))
    with TestClient(app) as client:
        yield tmp_path, client


def publish(root, version):
    filename = f"deepseek-continuation-{version}.apk"
    directory = root / "apks" / str(version)
    directory.mkdir(parents=True)
    (directory / filename).write_bytes(b"synthetic APK, not installable")
    manifest = {"schemaVersion": 1, "packageName": PACKAGE_NAME, "versionCode": version,
                "apkUrl": f"https://digimonlegend.com/continuation-updates/apks/{version}/{filename}"}
    (root / "latest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return manifest


def test_download_follows_newly_published_manifest_without_redeploy(release):
    root, client = release
    for version in (28, 29):
        manifest = publish(root, version)
        for method in (client.get, client.head):
            response = method("/download", follow_redirects=False)
            assert response.status_code == 302
            assert response.headers["location"] == manifest["apkUrl"]
            assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("invalid", [None, [], {}, {"versionCode": True},
    {"packageName": "unrelated.app"}, {"apkUrl": "https://example.com/untrusted.apk"}])
def test_download_rejects_missing_or_unsafe_manifest(release, invalid):
    root, client = release
    if invalid is not None:
        manifest = publish(root, 29)
        if isinstance(invalid, dict):
            manifest.update(invalid)
        else:
            manifest = invalid
        if invalid == {}:
            manifest = {}
        (root / "latest.json").write_text(json.dumps(manifest), encoding="utf-8")
    response = client.get("/download", follow_redirects=False)
    assert response.status_code == 503
    assert "location" not in response.headers
    assert response.headers["cache-control"] == "no-store"


def test_download_rejects_oversize_manifest_and_missing_apk(release):
    root, client = release
    manifest = publish(root, 29)
    (root / "apks" / "29" / "deepseek-continuation-29.apk").unlink()
    assert client.get("/download", follow_redirects=False).status_code == 503
    (root / "latest.json").write_text(json.dumps(manifest) + " " * 32769, encoding="utf-8")
    assert client.get("/download", follow_redirects=False).status_code == 503

def test_verified_mirror_is_bound_to_exact_release(tmp_path):
    from app.releases import verified_mirror
    signed = {"versionCode":39,"sha256":"b" * 64}
    path = tmp_path / "mirror.json"
    good = "https://downloads.example.org/releases/39.apk"
    for url, version, digest, expected in [(good,39,"b"*64,good),(good,38,"b"*64,None),(good,39,"a"*64,None),
                                            ("http://downloads.example.org/app.apk",39,"b"*64,None)]:
        path.write_text(json.dumps({"url":url,"versionCode":version,"sha256":digest}))
        assert verified_mirror(path, signed) == expected
