# Unified service deployment

Build the web bundle first, then inspect a local package without changing the server:

```powershell
python tools/deploy_unified.py plan
```

Activate an explicitly prepared release through the existing trusted SSH helper:

```powershell
python tools/deploy_unified.py deploy --ssh-helper 'path/to/your_ssh_helper.py'
```

The helper uploads only `backend/app`, its requirements file, built `web/dist`, and deployment templates. The server verifies SHA256, checks Nginx/systemd configuration, atomically switches `/opt/deepseek/current`, starts `deepseek.service` on loopback port 3144, and verifies the public web/API routes. A safe receipt is written to local `build/deployment.json` and server `/opt/deepseek/deployment.json`.

Credentials stay on the server. Activation preserves the existing unified environment and fallback providers in `/etc/deepseek` and `/var/lib/deepseek`; the initial bootstrap can copy the original configuration if those new files are absent. The administrator password hash is preserved. Default weekly caps are 350 globally and 35 per registered user. Chat and organize share the same calendar week starting Monday 00:00 Asia/Shanghai. The database is `/var/lib/deepseek/companion.sqlite3`; no legacy user data is imported.

The chat configuration is passed through systemd `LoadCredential` from `/etc/relationship-coach/config.json`. Image configuration is mapped server-side from the AstrBot draw plugin into `/var/lib/deepseek/image-provider.json` (0600, service owner); no provider keys are returned to the workstation. The independent `/opt/deepseek/venv` is reused for later deployments; the initial bootstrap copied already installed packages, without network installation. Runtime code no longer depends on either old project directory.

The stable entry points are `/deepseek/`, `/deepseek-api/`, `/deepseek/admin`, and `/deepseek/download`. The download route proxies to the backend `/download` handler, which validates the existing published `latest.json` and redirects to that manifest's versioned APK. It does not assume the source version has been published or pin APK 28. Invalid/missing manifest identity, download target or package file returns HTTP 503. APK upload and atomic manifest publication remain a separate release step.

Activation itself does not stop old development services. In the completed 2.0.0 deployment, both were disabled, their source roots moved into private `/opt/deepseek/rollback/legacy-2.0.0`, and old routes retired using `legacy-retired.conf`. The existing APK update channel remains active. Version 2.0.1 is now deployed and published through that channel; current release state, verification and device limitations are in [the release record](../docs/release-2.0.1.md). The [2.0.0 record](../docs/release-2.0.0.md) remains historical evidence.

A failed activation restores the previous symlink and touched configuration. Server-only backups and metadata live in `/opt/deepseek/rollback/<release>/`; inspect `recovery.json` there if rollback reports incomplete. Never copy these backups to the workstation because they contain server configuration secrets.
