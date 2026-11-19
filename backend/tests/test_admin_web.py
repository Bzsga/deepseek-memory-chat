"""Account roles, protected console HTML and scoped web administration sessions."""
import io
import re
import secrets
import sys
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import admin
from app.config import Settings
from app.main import create_app
from app.store import ServiceError


ORIGIN = "https://digimonlegend.com"
PASSWORD = "synthetic account password"


def test_admin_page_requires_admin_account_and_checks_each_session(tmp_path):
    settings = Settings(db_path=str(tmp_path / "admin.sqlite3"), worker_enabled=False)
    app = create_app(settings)
    with TestClient(app, base_url=ORIGIN) as client:
        accounts = app.state.store.accounts
        accounts.bootstrap_admin(PASSWORD)
        guest = client.get("/admin")
        assert guest.status_code == 200 and "管理员账号" in guest.text and 'id="dashboard"' not in guest.text
        assert guest.headers["cache-control"] == "no-store"
        ordinary = accounts.register("ordinary_user", PASSWORD)
        assert ordinary["user"]["role"] == "user"
        token = ordinary["token"]
        cookie = {"Cookie": "deepseek_session="+token}
        assert 'id="dashboard"' not in client.get("/admin", headers=cookie).text
        assert client.post("/v1/admin/session", headers={**cookie,"Origin":ORIGIN}).status_code == 403
        assert client.get("/v1/admin/config", headers={"Authorization":"Bearer "+token}).status_code == 403
        assert client.post("/v1/admin/login", json={"username":"ordinary_user","password":PASSWORD}).status_code == 403
        assert client.post("/admin", headers={"Origin":ORIGIN}, data={"username":"ordinary_user","password":PASSWORD}).status_code == 403
        login = client.post("/admin", headers={"Origin":ORIGIN}, data={"username":"admin","password":PASSWORD}, follow_redirects=False)
        assert login.status_code == 303 and "HttpOnly" in login.headers["set-cookie"]
        admin_token = login.cookies["deepseek_session"]
        admin_cookie = {"Cookie":"deepseek_session="+admin_token}
        page = client.get("/admin",headers=admin_cookie)
        assert 'id="dashboard"' in page.text and admin_token not in page.text
        nonce = re.search(r'<script nonce="([A-Za-z0-9_-]+)">', page.text).group(1)
        assert nonce not in client.get("/admin",headers=admin_cookie).text
        assert "script-src 'nonce-"+nonce+"'" in page.headers["content-security-policy"]
        assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
        runtime = client.get("/chat/api/runtime",headers=admin_cookie)
        assert runtime.json()["user"]["role"] == "admin"
        direct = {"Authorization":"Bearer "+admin_token}
        assert client.get("/v1/accounts/me",headers=direct).json()["user"]["role"] == "admin"
        assert client.get("/v1/admin/config",headers=direct).status_code == 200
        assert client.post("/v1/admin/session",headers={**admin_cookie,"Origin":"https://example.invalid"}).status_code == 403
        assert client.post("/v1/admin/session",headers=admin_cookie).status_code == 403
        scoped = client.post("/v1/admin/session",headers={**admin_cookie,"Origin":ORIGIN}).json()["token"]
        scoped_header = {"Authorization":"Bearer "+scoped}
        assert client.get("/v1/accounts/me",headers=scoped_header).status_code == 401
        assert client.get("/v1/admin/users",headers=scoped_header).status_code == 200
        assert client.post("/v1/admin/logout",headers={**scoped_header,**admin_cookie,"Origin":ORIGIN}).status_code == 200
        for headers in (scoped_header,direct):
            assert client.get("/v1/admin/config",headers=headers).status_code == 401


def test_bootstrap_password_is_stdin_only_idempotent_and_reserved(tmp_path, monkeypatch, capsys):
    config = Settings(db_path=str(tmp_path / "bootstrap.sqlite3"), worker_enabled=False)
    monkeypatch.setattr(Settings,"from_env",classmethod(lambda cls:config))
    monkeypatch.setattr(sys,"argv",["admin","bootstrap-admin"])
    password = secrets.token_urlsafe(24)

    def bootstrap(value):
        monkeypatch.setattr(sys,"stdin",SimpleNamespace(buffer=io.BytesIO((value+"\n").encode())))
        admin.main()

    bootstrap(password)
    app = create_app(config)
    with TestClient(app) as client:
        accounts = app.state.store.accounts
        for name in ("admin"," ADMIN ","ＡｄＭｉＮ"):
            assert client.post("/v1/accounts/register",json={"username":name,"password":PASSWORD}).status_code == 409
        assert client.post("/v1/accounts/register",json={"username":"another","password":PASSWORD,"role":"admin"}).status_code == 422
        account = accounts.login("Admin",password)
        assert account["user"]["role"] == "admin" and account["user"]["managed_eligible"]
        owner = account["user"]["id"]
        accounts.revoke_managed(owner)
        bootstrap(password)
        assert not accounts.me(owner)["user"]["managed_eligible"]
        with pytest.raises(SystemExit):
            bootstrap("another-synthetic-password")
        accounts.login("admin",password)
        with app.state.store.connection(write=True) as db:
            db.execute("ALTER TABLE registered_accounts DROP COLUMN role")
        accounts.initialize()  # Existing rows, including a preexisting reserved name, migrate as ordinary users.
        with pytest.raises(ServiceError, match="同名普通账号"):
            accounts.bootstrap_admin(password)
        assert accounts.me(owner)["user"]["role"] == "user"
    capture = capsys.readouterr()
    assert password not in capture.out + capture.err and password.encode() not in open(config.db_path, "rb").read()
