"""Account roles, protected console HTML and scoped web administration sessions."""
import io
import re
import secrets
import sys
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from account_fixtures import managed_account
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
        ordinary = managed_account(app.state.store, "ordinary_user", PASSWORD)
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
        assert 'id="permissionsDialog"' in page.text and 'id="permissionsForm"' in page.text
        assert 'id="userPermissions"' in page.text and 'id="invitePermissions"' in page.text
        assert 'id="featureAccessForm"' in page.text and 'id="featureAccessPermissions"' in page.text
        assert 'id="registrationPolicyForm"' in page.text and "允许免邀请码注册" in page.text
        for label in ("聊天 API", "生图 API", "云同步", "编辑权限", "保存额度", "全局功能开放"):
            assert label in page.text
        assert "/revoke-managed" not in page.text
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


def test_global_feature_access_requires_admin_origin_and_complete_booleans(tmp_path, monkeypatch):
    monkeypatch.setenv("PUBLIC_ORIGIN", ORIGIN)
    settings = Settings(db_path=str(tmp_path / "admin-feature-access.sqlite3"), worker_enabled=False,
                        user_weekly_limit=5)
    app = create_app(settings)
    with TestClient(app, base_url=ORIGIN) as client:
        accounts = app.state.store.accounts
        accounts.bootstrap_admin(PASSWORD)
        ordinary = managed_account(app.state.store, "ordinary_user", PASSWORD)
        owner = ordinary["user"]["id"]
        closed = {"chat_api": False, "image_api": False, "cloud_sync": False}
        individual = {**closed, "cloud_sync": True}
        opening = {**closed, "image_api": True}
        accounts.set_permissions(owner, individual)
        endpoint = "/v1/admin/account-feature-access"
        user_header = {"Authorization": "Bearer " + ordinary["token"], "Origin": ORIGIN}
        assert client.get(endpoint).status_code == 401
        assert client.patch(endpoint, headers={"Origin": ORIGIN}, json=opening).status_code == 401
        assert client.get(endpoint, headers=user_header).status_code == 403
        assert client.patch(endpoint, headers=user_header, json=opening).status_code == 403
        login = client.post("/v1/admin/login", json={"username": "admin", "password": PASSWORD})
        assert login.status_code == 200
        admin_header = {"Authorization": "Bearer " + login.json()["token"]}
        admin_origin = {**admin_header, "Origin": ORIGIN}
        initial = client.get(endpoint, headers=admin_header)
        assert initial.status_code == 200 and initial.json() == closed
        assert initial.headers["cache-control"] == "no-store"
        for headers in (admin_header, {**admin_header, "Origin": "https://example.invalid"}):
            assert client.patch(endpoint, headers=headers, json=opening).status_code == 403
        for payload in ({"image_api": True}, {**opening, "extra": True},
                        {**opening, "image_api": 1}, {**opening, "chat_api": "false"},
                        {**opening, "cloud_sync": None}):
            assert client.patch(endpoint, headers=admin_origin, json=payload).status_code == 422
        assert client.get(endpoint, headers=admin_header).json() == closed

        changed = client.patch(endpoint, headers=admin_origin, json=opening)
        assert changed.status_code == 200 and changed.json() == opening
        assert changed.headers["cache-control"] == "no-store"
        assert client.get(endpoint, headers=admin_header).json() == opening
        users = client.get("/v1/admin/users", headers=admin_header).json()["users"]
        listed = next(user for user in users if user["id"] == owner)
        assert listed["permissions"] == individual
        assert listed["effective_permissions"] == {**individual, "image_api": True}
        assert listed["weekly_limit"] == 5

        assert client.patch(endpoint, headers=admin_origin, json=closed).json() == closed
        users = client.get("/v1/admin/users", headers=admin_header).json()["users"]
        listed = next(user for user in users if user["id"] == owner)
        assert listed["permissions"] == listed["effective_permissions"] == individual
        assert listed["weekly_limit"] == 0


def test_registration_policy_can_close_signup_without_disabling_assigned_accounts(tmp_path, monkeypatch):
    monkeypatch.setenv("PUBLIC_ORIGIN", ORIGIN)
    settings = Settings(db_path=str(tmp_path / "registration-policy.sqlite3"), worker_enabled=False)
    app = create_app(settings)
    with TestClient(app, base_url=ORIGIN) as client:
        accounts = app.state.store.accounts
        accounts.bootstrap_admin(PASSWORD)
        endpoint = "/v1/admin/registration-policy"
        public_endpoint = "/v1/accounts/registration"
        register = "/v1/accounts/register"
        account = client.post(register, json={"username": "self_service", "password": PASSWORD}).json()
        user_headers = {"Authorization": "Bearer " + account["token"], "Origin": ORIGIN}
        assert client.get(endpoint).status_code == 401
        assert client.patch(endpoint, headers=user_headers, json={"self_service": False}).status_code == 403
        admin_login = client.post("/v1/admin/login", json={"username": "admin", "password": PASSWORD}).json()
        admin_headers = {"Authorization": "Bearer " + admin_login["token"]}
        closed = {"self_service": False}
        assert client.patch(endpoint, headers=admin_headers, json=closed).status_code == 403
        admin_headers["Origin"] = ORIGIN
        assert client.patch(endpoint, headers=admin_headers, json={"self_service": 0}).status_code == 422
        assert client.patch(endpoint, headers=admin_headers, json=closed).json() == closed
        assert client.get(public_endpoint).json() == client.get(endpoint, headers=admin_headers).json() == closed
        accounts.initialize()
        assert accounts.registration_policy() == closed
        profile = client.get("/v1/accounts/me", headers=user_headers).json()["user"]
        assert profile["permissions"] == {"chat_api": False, "image_api": False, "cloud_sync": True}
        fields = {"username": "invited_signup", "password": PASSWORD}
        assert client.post(register, json=fields).status_code == 422
        code = accounts.create_invites(1, 7)["invitations"][0]["code"]
        assert client.post(register, json={**fields, "invitation_code": code}).json()["user"]["registration_kind"] == "invitation"


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
        code = accounts.create_invites(1, 1)["invitations"][0]["code"]
        for name in ("admin"," ADMIN ","ＡｄＭｉＮ"):
            response = client.post("/v1/accounts/register", json={
                "username": name, "password": PASSWORD, "invitation_code": code,
            })
            assert response.status_code == 409
        response = client.post("/v1/accounts/register", json={
            "username": "another", "password": PASSWORD, "invitation_code": code, "role": "admin",
        })
        assert response.status_code == 422
        assert accounts.list_invites()["total"] == 1
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
