"""Stable public download entry backed by the existing atomic update manifest."""
import json
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter
from fastapi.responses import JSONResponse, RedirectResponse


UPDATE_ROOT = Path("/var/www/deepseek-continuation-updates")
PACKAGE_NAME = "app.banzhan.deepseekcontinuation"


def verified_mirror(path, manifest):
    try:
        with path.open("rb") as stream:
            record = json.loads(stream.read(4097))
        url = record["url"]
        parts = urlsplit(url)
        if (record["versionCode"] == manifest["versionCode"] and record["sha256"] == manifest["sha256"]
                and len(record["sha256"]) == 64 and parts.scheme == "https" and parts.hostname
                and not parts.username and not parts.password and not parts.fragment and not parts.query
                and not any(char.isspace() or char == chr(92) for char in url)):
            return url
    except (OSError, TypeError, ValueError, KeyError, UnicodeError, RecursionError):
        pass
    return None


def build_release_router(update_root=UPDATE_ROOT, mirror_path=Path("/etc/deepseek/download-mirror.json")):
    router = APIRouter()

    @router.api_route("/download", methods=["GET", "HEAD"])
    def download():
        try:
            with (update_root / "latest.json").open("rb") as stream:
                raw = stream.read(32 * 1024 + 1)
            if len(raw) > 32 * 1024:
                raise ValueError("manifest too large")
            manifest = json.loads(raw.decode("utf-8"))
            version = manifest.get("versionCode")
            if (manifest.get("schemaVersion") != 1 or manifest.get("packageName") != PACKAGE_NAME
                    or type(version) is not int or not 1 <= version <= 2_147_483_647):
                raise ValueError("invalid release identity")
            filename = f"deepseek-continuation-{version}.apk"
            url = f"https://digimonlegend.com/continuation-updates/apks/{version}/{filename}"
            if manifest.get("apkUrl") != url or not (update_root / "apks" / str(version) / filename).is_file():
                raise ValueError("published package missing or invalid")
            return RedirectResponse(verified_mirror(mirror_path, manifest) or url, status_code=302, headers={"Cache-Control": "no-store"})
        except (OSError, ValueError, AttributeError, UnicodeError, RecursionError):
            return JSONResponse({"detail": "安装包暂不可用，请稍后再试"}, status_code=503,
                                headers={"Cache-Control": "no-store"})

    return router
