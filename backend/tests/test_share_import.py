"""Public-share gateway tests use synthetic data and no external connection."""
import asyncio
import threading

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from account_fixtures import managed_account
from app.config import Settings
from app.share_import import MAX_SHARE_BYTES, build_share_import_router
from app.store import Store


ORIGIN = "https://digimonlegend.com"
SNAPSHOT = b'{"code":0,"data":{"biz_code":0,"biz_data":{"messages":[{"role":"user","content":"synthetic"}]}}}'


@pytest.fixture
def owner(tmp_path):
    store = Store(Settings(db_path=str(tmp_path / "shares.sqlite3"), worker_enabled=False,
        api_enabled=True, api_key="synthetic-key", weekly_limit=100, user_weekly_limit=20))
    store.initialize()
    account = managed_account(store, "synthetic_share")
    return store, account


def headers(account):
    return {"Authorization": "Bearer " + account["token"],
        "X-Chat-User-Id": account["user"]["id"], "Origin": ORIGIN}


def make_app(store, handler):
    app = FastAPI()
    app.include_router(build_share_import_router(store,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))))
    return app


def upstream_response(status, payload, headers=None):
    return httpx.Response(status, stream=httpx.ByteStream(payload), headers=headers)


def test_fixed_destination_exact_snapshot_owner_and_no_usage(owner):
    store, account = owner
    seen = []

    def handler(request):
        seen.append(request)
        assert request.method == "GET"
        assert str(request.url) == "https://chat.deepseek.com/api/v0/share/content?share_id=abc123"
        assert "authorization" not in request.headers and "cookie" not in request.headers
        assert "x-chat-user-id" not in request.headers and "x-api-key" not in request.headers
        assert request.headers["accept-encoding"] == "identity"
        return upstream_response(200, SNAPSHOT)

    with TestClient(make_app(store, handler), base_url=ORIGIN) as client:
        path = "/chat/api/shared-conversation?share_id=abc123"
        assert client.get(path).status_code == 401
        switched = {**headers(account), "X-Chat-User-Id": "another-owner"}
        assert client.get(path, headers=switched).status_code == 409
        assert client.get(path, headers={**headers(account), "Origin": "https://synthetic.invalid"}).status_code == 403
        assert client.get("/chat/api/shared-conversation?share_id=https://private.invalid", headers=headers(account)).status_code == 400
        response = client.get(path, headers=headers(account))
        assert response.status_code == 200 and response.content == SNAPSHOT
        assert response.headers["cache-control"] == "no-store"
        assert len(seen) == 1
        assert store.quota(account["user"]["id"])["user_weekly_remaining"] == 20
        with store.connection() as db:
            assert db.execute("SELECT COUNT(*) FROM chat_calls").fetchone()[0] == 0


def test_unified_app_routes_share_before_chat_fallback(owner, monkeypatch):
    from app import main

    store, account = owner
    seen = []

    def handler(request):
        seen.append(request)
        return upstream_response(200, SNAPSHOT)

    monkeypatch.setattr(main, "build_share_import_router", lambda app_store:
        build_share_import_router(app_store, client_factory=lambda:
            httpx.AsyncClient(transport=httpx.MockTransport(handler))))
    app = main.create_app(store.settings)
    with TestClient(app, base_url=ORIGIN) as client:
        path = "/chat/api/shared-conversation?share_id=abc123"
        assert client.get(path).status_code == 401
        response = client.get(path, headers=headers(account))
        assert response.status_code == 200 and response.content == SNAPSHOT
        assert len(seen) == 1
        assert client.get("/chat/api/unknown", headers=headers(account)).status_code == 404
        assert store.quota(account["user"]["id"])["user_weekly_remaining"] == 20
        with store.connection() as db:
            assert db.execute("SELECT COUNT(*) FROM chat_calls").fetchone()[0] == 0


@pytest.mark.parametrize("status,expected", [(302, 502), (403, 403), (404, 404), (410, 404), (429, 429), (500, 502)])
def test_provider_status_never_follows_redirect_or_exposes_body(owner, status, expected):
    store, account = owner
    seen = []

    def handler(request):
        seen.append(request)
        return upstream_response(status, b"synthetic-private-error", {"Location": "https://private.invalid/"})

    with TestClient(make_app(store, handler), base_url=ORIGIN) as client:
        response = client.get("/chat/api/shared-conversation?share_id=abc123", headers=headers(account))
        assert response.status_code == expected
        assert "synthetic-private-error" not in response.text and len(seen) == 1


@pytest.mark.parametrize("payload,expected", [
    (b'{"code":404,"messages":[]}', 404),
    (b'{"has_more":true,"messages":[{}]}', 422),
    (b'{"messages":[],"messages":[{}]}', 502),
    (b'{"messages":[null]}', 502),
    (b'{"messages":[{}],"number":NaN}', 502),
    (b'[' * 65 + b']' * 65, 502),
    (b'\xc3\x28', 502),
    (b'x' * (MAX_SHARE_BYTES + 1), 413),
], ids=["revoked", "partial", "duplicate-key", "invalid-message", "nonfinite", "deep-json", "invalid-utf8", "oversized"])
def test_rejects_partial_invalid_duplicate_or_oversized_snapshot(owner, payload, expected):
    store, account = owner
    with TestClient(make_app(store, lambda _request: upstream_response(200, payload)), base_url=ORIGIN) as client:
        response = client.get("/chat/api/shared-conversation?share_id=abc123", headers=headers(account))
        assert response.status_code == expected


def test_timeout_and_account_revocation_cancel_external_read(owner, monkeypatch):
    store, account = owner
    entered, cancelled = threading.Event(), threading.Event()

    async def handler(_request):
        entered.set()
        try:
            await asyncio.Future()
        finally:
            cancelled.set()

    monkeypatch.setattr("app.share_import.SHARE_TIMEOUT", 0.02)
    with TestClient(make_app(store, handler), base_url=ORIGIN) as client:
        response = client.get("/chat/api/shared-conversation?share_id=abc123", headers=headers(account))
        assert response.status_code == 504 and cancelled.wait(1)

    entered.clear()
    cancelled.clear()
    monkeypatch.setattr("app.share_import.SHARE_TIMEOUT", 3)
    with TestClient(make_app(store, handler), base_url=ORIGIN) as client:
        response = []
        thread = threading.Thread(target=lambda: response.append(client.get(
            "/chat/api/shared-conversation?share_id=abc123", headers=headers(account))))
        thread.start()
        assert entered.wait(1)
        store.accounts.logout(account["token"])
        thread.join(2)
        assert not thread.is_alive() and response[0].status_code == 401 and cancelled.wait(1)


def test_browser_disconnect_cancels_external_read(owner):
    store, account = owner
    cancelled = []

    async def probe():
        entered = asyncio.Event()

        async def handler(_request):
            entered.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.append(True)

        async def receive():
            await entered.wait()
            return {"type": "http.disconnect"}

        request = Request({"type": "http", "method": "GET", "path": "/chat/api/shared-conversation",
            "query_string": b"", "headers": [(key.lower().encode(), value.encode())
                for key, value in headers(account).items()]}, receive=receive)
        router = build_share_import_router(store,
            client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        response = await router.routes[0].endpoint(request, share_id="abc123")
        assert response.status_code == 499 and cancelled == [True]

    asyncio.run(probe())
