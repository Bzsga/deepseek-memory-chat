"""Server-only activation helper. Uploaded by tools/deploy_unified.py.

Provider credentials are copied locally on the server and never printed.
This script never stops either original development service.
"""
from __future__ import annotations

import hashlib
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request


BASE = Path('/opt/deepseek')
STATE = Path('/var/lib/deepseek')
ETC = Path('/etc/deepseek')
SITE = Path('/etc/nginx/sites-available/digimon_website')
UNIT = Path('/etc/systemd/system/deepseek.service')
SNIPPET = Path('/etc/nginx/snippets/deepseek-location.conf')
OLD_ENV = Path('/etc/deepseek-continuation/companion.env')
OLD_FALLBACK = Path('/var/lib/deepseek-continuation/provider-fallbacks.json')
IMAGE_SOURCE = Path('/opt/dafeiyu/data/config/astrbot_plugin_dafeiyu_draw_config.json')
SERVICE = 'deepseek.service'


def run(args, label, *, check=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=60)
    if check and result.returncode:
        raise RuntimeError(label)
    return result


def atomic_write(path, content, mode=0o600, owner=None):
    temporary = path.with_name(path.name + '.next')
    with temporary.open('wb') as stream:
        stream.write(content)
    temporary.chmod(mode)
    if owner is not None:
        os.chown(temporary, owner.pw_uid, owner.pw_gid)
    temporary.replace(path)


def request(url, timeout=4):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=timeout) as response:
        return response.status, response.read(512_000)


def wait_for_public_routing(expected_health, expected_index):
    deadline = time.monotonic() + 10
    expected = {
        'health': ('https://digimonlegend.com/deepseek-api/health', hashlib.sha256(expected_health).digest()),
        'index': ('https://digimonlegend.com/deepseek/', hashlib.sha256(expected_index).digest()),
    }
    last_probe = {}
    while time.monotonic() < deadline:
        attempt_matches = True
        for name, (url, expected_hash) in expected.items():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                attempt_matches = False
                break
            probe = dict(status=None, expected_match=False, error_type=None)
            try:
                status, content = request(url, timeout=min(1, remaining))
                probe['status'] = status
                probe['expected_match'] = status == 200 and hashlib.sha256(content).digest() == expected_hash
            except urllib.error.HTTPError as error:
                probe['status'] = error.code
                probe['error_type'] = type(error).__name__
                error.close()
            except (OSError, ValueError) as error:
                probe['error_type'] = type(error).__name__
            last_probe[name] = probe
            attempt_matches = attempt_matches and probe['expected_match']
        if attempt_matches:
            return True, last_probe
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(0.25, remaining))
    return False, last_probe


def activate(archive, release, expected_hash):
    if os.geteuid() != 0 or not re.fullmatch(r'\d{8}T\d{6}Z(?:-[a-z0-9]{4,12})?', release):
        raise RuntimeError('Activation arguments invalid')
    if not re.fullmatch(r'[a-f0-9]{64}', expected_hash):
        raise RuntimeError('Archive digest invalid')
    if archive.parent != Path('/tmp') or not archive.name.startswith('deepseek-release-'):
        raise RuntimeError('Archive path invalid')
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected_hash:
        raise RuntimeError('Archive integrity check failed')
    owner = pwd.getpwnam('deepseek-continuation')
    environment = ETC / 'companion.env'
    fallback = STATE / 'provider-fallbacks.json'
    environment_source = environment if environment.exists() or environment.is_symlink() else OLD_ENV
    fallback_source = fallback if fallback.exists() or fallback.is_symlink() else OLD_FALLBACK
    for source in (environment_source, fallback_source, IMAGE_SOURCE, Path('/etc/relationship-coach/config.json')):
        if not source.is_file() or source.is_symlink():
            raise RuntimeError('Existing server configuration missing or unexpected')
    target = BASE / 'releases' / release
    if target.exists():
        raise RuntimeError('Release directory already exists; inspect current state before retrying')
    rollback = BASE / 'rollback' / release
    rollback.mkdir(parents=True, mode=0o700)
    rollback.chmod(0o700)
    records = []

    def snapshot(path):
        if path.exists():
            if path.is_symlink() or not path.is_file():
                raise RuntimeError('Configuration target has unexpected type')
            info = path.stat()
            backup = rollback / f'file-{len(records)}'
            backup.write_bytes(path.read_bytes())
            backup.chmod(0o600)
            records.append(dict(path=str(path), backup=str(backup), mode=info.st_mode & 0o777,
                                uid=info.st_uid, gid=info.st_gid))
        else:
            records.append(dict(path=str(path), backup=None))

    current = BASE / 'current'
    if current.exists() and not current.is_symlink():
        raise RuntimeError('Current release must be a symlink')
    previous = os.readlink(current) if current.is_symlink() else None
    was_active = run(['systemctl', 'is-active', SERVICE], 'Read service state', check=False).returncode == 0
    was_enabled = run(['systemctl', 'is-enabled', SERVICE], 'Read service enablement', check=False).returncode == 0
    for path in (SITE, UNIT, SNIPPET, ETC / 'companion.env', STATE / 'provider-fallbacks.json', STATE / 'image-provider.json'):
        snapshot(path)
    recovery = dict(previous_release=previous, was_active=was_active, was_enabled=was_enabled, files=records)
    atomic_write(rollback / 'recovery.json', json.dumps(recovery, indent=2).encode())
    switched = False
    nginx_reloaded = False
    public_readiness = None
    stage = 'prepare_release'
    try:
        target.mkdir(parents=True, mode=0o755)
        with tarfile.open(archive, 'r:gz') as package:
            for item in package.getmembers():
                relative = Path(item.name)
                if relative.is_absolute() or '..' in relative.parts or not (item.isdir() or item.isfile()):
                    raise RuntimeError('Archive contains an unsupported entry')
            package.extractall(target)
        for path in (target, *target.rglob('*')):
            if path.is_dir():
                path.chmod(0o755)
            elif path.is_file():
                path.chmod(0o644)
        stage = 'prepare_runtime'
        virtualenv = BASE / 'venv'
        if not virtualenv.exists():
            original_virtualenv = Path('/opt/deepseek-continuation/venv')
            if not original_virtualenv.is_dir():
                raise RuntimeError('Independent runtime missing and original runtime unavailable')
            shutil.copytree(original_virtualenv, virtualenv, symlinks=True)
        runtime_check = (
            'import sys, fastapi, httpx, uvicorn\n'
            'if sys.prefix != "/opt/deepseek/venv":\n'
            '    raise RuntimeError("Independent runtime prefix mismatch")\n'
            'if any(module.__file__.startswith("/opt/deepseek-continuation/") '
            'for module in (fastapi, httpx, uvicorn)):\n'
            '    raise RuntimeError("Runtime imports depend on original project")\n'
        )
        run([str(virtualenv / 'bin/python'), '-c', runtime_check], 'Runtime import check failed')
        stage = 'prepare_configuration'
        ETC.mkdir(parents=True, exist_ok=True, mode=0o700)
        ETC.chmod(0o700)
        STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
        STATE.chmod(0o700)
        os.chown(STATE, owner.pw_uid, owner.pw_gid)
        if not environment.exists():
            removed_keys = {'DB_PATH', 'DAILY_LIMIT', 'USER_DAILY_LIMIT', 'WEEKLY_LIMIT', 'USER_WEEKLY_LIMIT',
                            'FALLBACK_PROVIDERS_FILE', 'IMAGE_PROVIDER_CONFIG', 'CHAT_PROVIDER_CONFIG'}
            lines = [line for line in OLD_ENV.read_text().splitlines()
                     if line.split('=', 1)[0].strip() not in removed_keys]
            lines.extend(['DB_PATH=/var/lib/deepseek/companion.sqlite3', 'WEEKLY_LIMIT=350', 'USER_WEEKLY_LIMIT=35',
                          'FALLBACK_PROVIDERS_FILE=/var/lib/deepseek/provider-fallbacks.json'])
            atomic_write(environment, ('\n'.join(lines) + '\n').encode())
        if not fallback.exists():
            atomic_write(fallback, OLD_FALLBACK.read_bytes(), owner=owner)
        source = json.loads(IMAGE_SOURCE.read_text(encoding='utf-8-sig'))
        image_config = {key: source[key] for key in ('base_url', 'api_key', 'default_model', 'default_size', 'request_timeout')}
        if 'enabled' in source:
            image_config['enabled'] = source['enabled']
        if not isinstance(image_config['api_key'], str) or not image_config['api_key']:
            raise RuntimeError('Image provider configuration incomplete')
        atomic_write(STATE / 'image-provider.json', json.dumps(image_config).encode(), owner=owner)
        atomic_write(UNIT, (target / 'deploy/deepseek.service').read_bytes(), 0o644)
        atomic_write(SNIPPET, (target / 'deploy/nginx-location.conf').read_bytes(), 0o644)
        original_site = SITE.read_bytes()
        include = b'    include /etc/nginx/snippets/deepseek-location.conf;\n'
        if include.strip() not in original_site:
            anchor = b'    include /etc/nginx/snippets/site-stats.conf;'
            if original_site.count(anchor) != 1:
                raise RuntimeError('Nginx insertion anchor changed')
            atomic_write(SITE, original_site.replace(anchor, include + anchor, 1), SITE.stat().st_mode & 0o777)
        stage = 'validate_configuration'
        run(['nginx', '-t'], 'Nginx configuration validation failed')
        run(['systemd-analyze', 'verify', str(UNIT)], 'Systemd unit validation failed')
        stage = 'activate_service'
        temporary_link = BASE / 'current.next'
        if temporary_link.is_symlink():
            temporary_link.unlink()
        elif temporary_link.exists():
            raise RuntimeError('Staging current path has unexpected type')
        temporary_link.symlink_to(target)
        temporary_link.replace(current)
        switched = True
        run(['systemctl', 'daemon-reload'], 'Systemd reload failed')
        run(['systemctl', 'enable', SERVICE], 'Service enablement failed')
        run(['systemctl', 'restart', SERVICE], 'Service startup failed')
        stage = 'verify_service'
        ready = False
        for _ in range(40):
            try:
                status, body = request('http://127.0.0.1:3144/health')
                health = json.loads(body)
                login_status, _ = request('http://127.0.0.1:3144/chat/login')
                admin_status, _ = request('http://127.0.0.1:3144/admin')
                if status == login_status == admin_status == 200 and health.get('status') == 'ok':
                    ready = True
                    break
            except (OSError, ValueError):
                pass
            time.sleep(0.25)
        if not ready:
            raise RuntimeError('Unified service readiness failed')
        stage = 'verify_public_routing'
        run(['systemctl', 'reload', 'nginx'], 'Nginx reload failed')
        nginx_reloaded = True
        expected_index = (target / 'web/dist/index.html').read_bytes()
        # The existing website injects its statistics script into HTML. Apply
        # the same literal replacements to the expected bytes on the server.
        statistics_config = Path('/etc/nginx/snippets/site-stats.conf').read_text()
        for line in statistics_config.splitlines():
            directive = shlex.split(line.strip().rstrip(';'), comments=True)
            if len(directive) == 3 and directive[0] == 'sub_filter':
                expected_index = expected_index.replace(directive[1].encode(), directive[2].encode(), 1)
        public_ready, public_readiness = wait_for_public_routing(body, expected_index)
        if not public_ready:
            atomic_write(rollback / 'public-readiness.json', json.dumps(public_readiness, indent=2).encode())
            raise RuntimeError('Public routing verification failed')
        record = dict(ok=True, release=release, service=SERVICE, service_status='active', port=3144,
                      web_url='https://digimonlegend.com/deepseek/', api_url='https://digimonlegend.com/deepseek-api',
                      admin_url='https://digimonlegend.com/deepseek/admin', previous_release=previous,
                      rollback=str(rollback), archive_sha256=expected_hash, public_routing_verified=True,
                      legacy_services_stopped=False, raw_chat_storage='local_with_opt_in_account_sync', server_credentials_downloaded=False,
                      download_manifest_present=Path('/var/www/deepseek-continuation-updates/latest.json').is_file())
        atomic_write(BASE / 'deployment.json', json.dumps(record, indent=2).encode())
        return record
    except Exception:
        restored = True
        if switched:
            if run(['systemctl', 'stop', SERVICE], 'Stop failed deployment', check=False).returncode:
                restored = False
        if not was_enabled:
            run(['systemctl', 'disable', SERVICE], 'Restore service enablement', check=False)
        for item in reversed(records):
            path = Path(item['path'])
            try:
                if item['backup']:
                    atomic_write(path, Path(item['backup']).read_bytes(), item['mode'])
                    os.chown(path, item['uid'], item['gid'])
                elif path.is_file():
                    path.unlink()
            except OSError:
                restored = False
        if switched:
            try:
                if previous:
                    temporary_link = BASE / 'current.next'
                    temporary_link.symlink_to(previous)
                    temporary_link.replace(current)
                elif current.is_symlink():
                    current.unlink()
            except OSError:
                restored = False
        try:
            run(['systemctl', 'daemon-reload'], 'Rollback systemd reload failed')
            if was_active:
                run(['systemctl', 'restart', SERVICE], 'Rollback service state failed')
            if was_enabled:
                run(['systemctl', 'enable', SERVICE], 'Rollback enablement failed')
            if nginx_reloaded:
                run(['nginx', '-t'], 'Rollback nginx validation failed')
                run(['systemctl', 'reload', 'nginx'], 'Rollback nginx reload failed')
        except Exception:
            restored = False
        print(json.dumps(dict(ok=False, release=release, error='activation_failed', stage=stage, rollback_completed=restored,
                              rollback=str(rollback), legacy_services_stopped=False, public_readiness=public_readiness)))
        raise RuntimeError('Activation failed; inspect the server-only recovery record') from None


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Expected archive, release and SHA256')
    try:
        with open('/run/deepseek-deploy.lock', 'a') as deploy_lock:
            fcntl.flock(deploy_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = activate(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
    except Exception as error:
        print(json.dumps(dict(ok=False, error=str(error))), file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(result))
