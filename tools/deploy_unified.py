"""Package the unified service, then optionally activate it through trusted SSH.

The default action is a local plan. Provider credentials never leave the server.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shlex
import sys
import tarfile
import uuid


ROOT = Path(__file__).resolve().parents[1]
MAX_PACKAGE_BYTES = 120 * 1024 * 1024
RELEASE_PATTERN = r"\d{8}T\d{6}Z(?:-[a-z0-9]{4,12})?"


class DeploymentError(Exception):
    pass


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def package_files(root):
    required = ["backend/app/main.py", "backend/requirements.txt", "web/dist/index.html",
                "deploy/deepseek.service", "deploy/nginx-location.conf", "deploy/activate_unified.py"]
    if any(not (root / relative).is_file() for relative in required):
        raise DeploymentError("build_web_and_prepare_backend_first")
    files = {root / relative for relative in required}
    for relative in ("backend/app", "web/dist"):
        for path in (root / relative).rglob("*"):
            if path.is_symlink():
                raise DeploymentError("package_symlink_not_allowed")
            if not path.is_file() or "__pycache__" in path.parts or path.suffix in (".pyc", ".pyo"):
                continue
            if path.name.startswith(".env") or path.suffix.lower() in (".db", ".sqlite", ".sqlite3", ".key", ".pem"):
                raise DeploymentError("private_file_in_public_package")
            files.add(path)
    return sorted(files, key=lambda path: path.relative_to(root).as_posix())


def prepare(root, release):
    if not re.fullmatch(RELEASE_PATTERN, release):
        raise DeploymentError("invalid_release_id")
    files = package_files(root)
    build = root / "build"
    build.mkdir(exist_ok=True)
    archive = build / f"deepseek-release-{release}.tar.gz"
    if archive.exists():
        raise DeploymentError("release_archive_exists_choose_new_release_id")
    with tarfile.open(archive, "w:gz") as package:
        for path in files:
            package.add(path, arcname=path.relative_to(root).as_posix(), recursive=False)
    if archive.stat().st_size > MAX_PACKAGE_BYTES:
        raise DeploymentError("release_package_too_large")
    return dict(ok=True, action="plan", release=release, archive=str(archive),
                archive_sha256=digest(archive), archive_bytes=archive.stat().st_size, files=len(files),
                service="deepseek.service", port=3144,
                web_url="https://digimonlegend.com/deepseek/",
                api_url="https://digimonlegend.com/deepseek-api",
                admin_url="https://digimonlegend.com/deepseek/admin",
                remote_credentials_only=True, legacy_services_stopped=False)


def connect(helper_path):
    if not helper_path:
        raise DeploymentError("explicit_trusted_ssh_helper_required")
    path = Path(helper_path).resolve(strict=True)
    if not path.is_file() or path.suffix != ".py":
        raise DeploymentError("invalid_ssh_helper")
    sys.path.insert(0, str(path.parent))
    try:
        spec = importlib.util.spec_from_file_location("deepseek_deploy_ssh_" + uuid.uuid4().hex, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if not callable(getattr(module, "connect", None)):
            raise DeploymentError("ssh_helper_connect_missing")
        return module.connect()
    finally:
        sys.path.pop(0)


def upload_private(sftp, local, remote):
    with sftp.open(remote, "wx") as destination:
        sftp.chmod(remote, 0o600)
        with local.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                destination.write(block)


def deploy(plan, helper_path):
    archive = Path(plan["archive"])
    remote_archive = "/tmp/" + archive.name
    remote_script = f"/tmp/deepseek-activate-{plan['release']}.py"
    with connect(helper_path) as client:
        with client.open_sftp() as sftp:
            upload_private(sftp, archive, remote_archive)
            upload_private(sftp, ROOT / "deploy/activate_unified.py", remote_script)
        try:
            command = "python3 " + " ".join(shlex.quote(value) for value in
                (remote_script, remote_archive, plan["release"], plan["archive_sha256"]))
            _, stdout, stderr = client.exec_command(command, timeout=240)
            raw_output = stdout.read(64 * 1024).decode("utf-8", errors="replace")
            # Server stderr can contain library/configuration details. Keep it off
            # the workstation receipt and user-facing logs.
            stderr.read(64 * 1024)
            code = stdout.channel.recv_exit_status()
            records = []
            for line in raw_output.splitlines():
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                if isinstance(item, dict) and type(item.get("ok")) is bool:
                    records.append(item)
            if code or not records or records[-1].get("ok") is not True:
                failure = next((item for item in reversed(records) if item.get("ok") is False), {})
                stage = failure.get("stage", "server_activation")
                if not isinstance(stage, str) or not re.fullmatch(r"[a-z_]{1,50}", stage):
                    stage = "server_activation"
                rolled_back = failure.get("rollback_completed")
                raise DeploymentError(f"activation_failed:{stage}:rollback_completed={rolled_back}")
            receipt = records[-1]
            if receipt.get("release") != plan["release"] or receipt.get("archive_sha256") != plan["archive_sha256"]:
                raise DeploymentError("deployment_receipt_mismatch_check_server_state")
            destination = ROOT / "build/deployment.json"
            destination.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            return receipt
        finally:
            with client.open_sftp() as sftp:
                for remote in (remote_archive, remote_script):
                    try:
                        sftp.remove(remote)
                    except OSError:
                        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", choices=("plan", "deploy"), default="plan")
    parser.add_argument("--ssh-helper", help="Explicit trusted Python helper exposing connect()")
    parser.add_argument("--release", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6])
    args = parser.parse_args()
    if args.action == "deploy" and not args.ssh_helper:
        parser.error("deploy requires --ssh-helper")
    try:
        plan = prepare(ROOT, args.release)
        result = deploy(plan, args.ssh_helper) if args.action == "deploy" else plan
    except DeploymentError as error:
        print(json.dumps(dict(ok=False, error=str(error))))
        return 1
    except Exception:
        print(json.dumps(dict(ok=False, error="deployment_tool_failed_check_server_state")))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
