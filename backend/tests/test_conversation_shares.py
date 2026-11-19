"""Own-share tests use only synthetic text/images and never call providers."""
import asyncio
import base64
from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor
import copy
import json
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from starlette.requests import Request

from app import conversation_shares as module
from app.config import Settings
from app.conversation_shares import ConversationShares, build_conversation_share_router
from app.store import Store


ORIGIN = "https://digimonlegend.com"
API = "/chat/api/conversation-shares"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=")


def payload(*, image=True, request_id="synthetic-request-id", conversation_id="synthetic-local-session"):
    result = {"client_request_id": request_id, "conversation_id": conversation_id,
        "title": "合成分享 <script>private()</script>", "messages": [
            {"id": "original-user", "role": "user", "content": "原始正文\n  spacing\t<script>alert(1)</script>&\n",
             "created_at": 1794931200000, "image_ids": ["image-transfer-id"] if image else [],
             "files": [{"name": '<img src=x onerror="run()">.txt', "size": 17, "mime_type": "text/plain"}]},
            {"id": "original-assistant", "role": "assistant", "content": "synthetic response",
             "created_at": 1794931201000, "image_ids": ["image-transfer-id"] if image else [], "files": []}],
        "images": [{"id": "image-transfer-id", "name": "synthetic.png", "mime_type": "image/png",
                    "b64_json": base64.b64encode(PNG).decode()}] if image else []}
    return result


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def headers(account):
    return {"Authorization": "Bearer " + account["token"], "Origin": ORIGIN,
            "X-Chat-User-Id": account["user"]["id"]}


@pytest.fixture
def setup(tmp_path):
    store = Store(Settings(db_path=str(tmp_path / "test.sqlite3"), worker_enabled=False,
        api_enabled=True, api_key="synthetic-key", weekly_limit=100, user_weekly_limit=20))
    store.initialize()
    account = store.accounts.register("synthetic_share", "synthetic-password-123")
    shares = ConversationShares(store, tmp_path / "private-shares")
    shares.initialize()
    app = FastAPI()
    app.include_router(build_conversation_share_router(store, shares))
    with TestClient(app, base_url=ORIGIN) as client:
        yield store, account, shares, client


def create(client, account, value=None):
    response = client.post(API, json=value or payload(), headers=headers(account))
    assert response.status_code == 201, response.text
    return response.json()


def assert_no_usage(store, account):
    assert store.quota(account["user"]["id"])["user_weekly_remaining"] == account["quota"]["user_weekly_remaining"]
    with store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM chat_calls").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM provider_attempts").fetchone()[0] == 0


def test_public_head_and_revoked_browser_page(setup):
    store, account, _shares, client = setup
    metadata = create(client, account)
    path = API + "/" + metadata["id"]
    page_path = "/chat/public-shares/" + metadata["id"]
    for target in (path, path + "/images/image-transfer-id", page_path):
        response = client.head(target)
        assert response.status_code == 200 and response.content == b""
        assert response.headers["cache-control"] == "no-store"
    assert client.delete(path, headers=headers(account)).status_code == 200
    unavailable = client.get(page_path)
    assert unavailable.status_code == 404
    assert unavailable.headers["content-type"].startswith("text/html")
    assert "分享暂不可用" in unavailable.text and 'href="/deepseek/"' in unavailable.text
    assert client.head(page_path).status_code == 404
    assert_no_usage(store, account)


def test_exact_snapshot_anonymous_image_mobile_html_and_no_usage(setup):
    store, account, shares, client = setup
    source = payload()
    metadata = create(client, account, source)
    share_id = metadata["id"]
    assert module.SHARE_ID.fullmatch(share_id) and len(share_id) == 32
    assert set(metadata) == {"id", "url", "title", "conversation_id", "message_count", "image_count", "created_at", "revoked"}
    assert metadata["url"] == ORIGIN + "/deepseek/share/" + share_id
    assert metadata["message_count"] == 2 and metadata["image_count"] == 1 and metadata["revoked"] is False
    response = client.get(API + "/" + share_id)
    snapshot = response.json()
    assert snapshot["messages"] == source["messages"]
    assert snapshot["title"] == source["title"] and snapshot["schema_version"] == 1
    assert set(snapshot) == {"schema_version", "id", "title", "created_at", "messages", "images"}
    assert "synthetic-local-session" not in response.text and "synthetic-request-id" not in response.text
    assert account["user"]["id"] not in response.text and "storage_id" not in response.text
    assert snapshot["images"] == [{"id": "image-transfer-id", "name": "synthetic.png", "size": len(PNG),
        "mime_type": "image/png", "url": module.PUBLIC_API_PATH + "/" + share_id + "/images/image-transfer-id"}]
    image = client.get(API + "/" + share_id + "/images/image-transfer-id")
    assert image.status_code == 200 and image.content == PNG and image.headers["content-type"] == "image/png"
    page = client.get("/chat/public-shares/" + share_id)
    assert page.status_code == 200 and '<meta name="viewport"' in page.text
    assert "<script>" not in page.text and "<img src=x" not in page.text
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in page.text
    assert 'href="/deepseek/?share=' + share_id + '"' in page.text
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    for public in (response, image, page):
        assert public.headers["cache-control"] == "no-store"
        assert public.headers["referrer-policy"] == "no-referrer"
        assert public.headers["x-content-type-options"] == "nosniff"
    if os.name != "nt":
        assert shares.directory.stat().st_mode & 0o777 == 0o700
        assert (shares.directory / share_id).stat().st_mode & 0o777 == 0o700
        assert all(path.stat().st_mode & 0o777 == 0o600 for path in (shares.directory / share_id).iterdir())
    assert_no_usage(store, account)


def test_authenticated_management_origin_owner_and_cookie_identity(setup):
    store, account, _shares, client = setup
    assert client.post(API, json=payload()).status_code == 401
    assert client.get(API).status_code == 401
    assert client.post(API, json=payload(), headers={**headers(account), "Origin": "https://other.invalid"}).status_code == 403
    switched = {**headers(account), "X-Chat-User-Id": "different-account"}
    assert client.post(API, json=payload(), headers=switched).status_code == 409
    assert client.get(API, headers=switched).status_code == 409
    cookie_headers = {"Cookie": "deepseek_session=" + account["token"], "Origin": ORIGIN,
                      "X-Chat-User-Id": account["user"]["id"]}
    response = client.post(API, json=payload(), headers=cookie_headers)
    assert response.status_code == 201
    other = store.accounts.register("synthetic_other", "synthetic-password-123")
    share_id = response.json()["id"]
    assert client.get(API, headers=headers(other)).json() == {"shares": []}
    assert client.delete(API + "/" + share_id, headers=headers(other)).status_code == 404
    assert client.get(API + "/" + share_id).status_code == 200
    assert_no_usage(store, account)


def test_idempotency_payload_conflict_lists_and_revoke_tombstone(setup):
    store, account, shares, client = setup
    source = payload()
    first = create(client, account, source)
    again = client.post(API, json=source, headers=headers(account))
    assert again.status_code == 200 and again.json() == first
    changed = copy.deepcopy(source)
    changed["messages"][0]["content"] += " different"
    assert client.post(API, json=changed, headers=headers(account)).status_code == 409
    second = create(client, account, payload(image=False, request_id="second", conversation_id="different-local"))
    assert len(client.get(API, headers=headers(account)).json()["shares"]) == 2
    scoped = client.get(API + "?conversation_id=synthetic-local-session", headers=headers(account)).json()
    assert scoped == {"shares": [first]}
    path = API + "/" + first["id"]
    assert client.delete(path, headers=headers(account)).json() == {"revoked": True}
    assert client.delete(path, headers=headers(account)).status_code == 200
    assert not (shares.directory / first["id"]).exists()
    for suffix in ("", "/images/image-transfer-id"):
        assert client.get(path + suffix).status_code == 404
    assert client.get("/chat/public-shares/" + first["id"]).status_code == 404
    assert client.get(API, headers=headers(account)).json() == {"shares": [second]}
    retry = client.post(API, json=source, headers=headers(account))
    assert retry.status_code == 200 and retry.json()["revoked"] is True and retry.json()["id"] == first["id"]
    assert client.get(path).status_code == 404 and not (shares.directory / first["id"]).exists()
    assert client.post(API, json=changed, headers=headers(account)).status_code == 409
    with store.connection() as db:
        row = dict(db.execute("SELECT * FROM conversation_shares WHERE id=?", (first["id"],)).fetchone())
    assert row["revoked"] == 1 and row["title"] is None and row["conversation_id"] is None
    assert row["message_count"] == row["image_count"] == 0
    assert_no_usage(store, account)


def test_concurrent_identical_create_is_one_copy_and_restart_persists(setup):
    store, account, shares, client = setup
    raw = encode(payload())
    def attempt(_index):
        # Exercise independent manager instances as separate workers would use.
        return ConversationShares(store, shares.directory).create(account["user"]["id"], raw, ORIGIN)
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(attempt, range(6)))
    assert sum(int(created) for _metadata, created in results) == 1
    assert len({metadata["id"] for metadata, _created in results}) == 1
    share_id = results[0][0]["id"]
    orphan = shares.directory / ("z" * 32)
    orphan.mkdir()
    (orphan / "snapshot.json").write_text("synthetic orphan")
    restarted = ConversationShares(store, shares.directory)
    restarted.initialize()
    assert not orphan.exists() and restarted.public(share_id)["messages"] == payload()["messages"]
    assert len(list(shares.directory.iterdir())) == 1
    assert_no_usage(store, account)


def test_failed_creation_rolls_back_database_and_files(setup, monkeypatch):
    store, account, shares, client = setup
    original = shares._write
    def fail_snapshot(path, raw):
        if path.name == "snapshot.json":
            raise OSError("synthetic disk failure")
        return original(path, raw)
    monkeypatch.setattr(shares, "_write", fail_snapshot)
    response = client.post(API, json=payload(), headers=headers(account))
    assert response.status_code == 503 and "synthetic disk failure" not in response.text
    assert list(shares.directory.iterdir()) == []
    with store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM conversation_shares").fetchone()[0] == 0
    monkeypatch.setattr(shares, "_write", original)
    assert client.post(API, json=payload(), headers=headers(account)).status_code == 201


def test_interrupted_revoke_denies_access_and_retry_finishes_cleanup(setup, monkeypatch):
    store, account, shares, client = setup
    first = create(client, account)
    original = shares._remove
    monkeypatch.setattr(shares, "_remove", lambda _id: (_ for _ in ()).throw(OSError("synthetic deletion failure")))
    path = API + "/" + first["id"]
    assert client.delete(path, headers=headers(account)).status_code == 503
    assert client.get(path).status_code == 404
    assert client.get(path + "/images/image-transfer-id").status_code == 404
    assert client.get(API, headers=headers(account)).json() == {"shares": []}
    monkeypatch.setattr(shares, "_remove", original)
    assert client.delete(path, headers=headers(account)).json() == {"revoked": True}
    assert not (shares.directory / first["id"]).exists()


@pytest.mark.parametrize("mutation,expected", [
    (lambda p: p.update(context="hidden memory"), 422),
    (lambda p: p["messages"][0].update(reasoning="hidden thoughts"), 422),
    (lambda p: p["messages"][0].update(role="system"), 422),
    (lambda p: p["messages"][0].update(content=123), 422),
    (lambda p: p["messages"][0].update(created_at=True), 422),
    (lambda p: p["messages"].append(copy.deepcopy(p["messages"][0])), 422),
    (lambda p: p["images"].append(copy.deepcopy(p["images"][0])), 422),
    (lambda p: p["messages"][0].update(image_ids=["image-transfer-id", "image-transfer-id"]), 422),
    (lambda p: p.update(images=[]), 422),
    (lambda p: [m.update(image_ids=[]) for m in p["messages"]], 422),
    (lambda p: p["images"][0].update(url="https://private.invalid/image.png"), 422),
    (lambda p: p["images"][0].update(id="../../private"), 422),
    (lambda p: p["images"][0].update(b64_json="broken%%"), 422),
    (lambda p: p["images"][0].update(b64_json=base64.b64encode(b"not an image").decode()), 415),
    (lambda p: p["images"][0].update(mime_type="image/jpeg"), 415),
    (lambda p: p["messages"][0]["files"][0].update(url="https://private.invalid/file"), 422),
], ids=["hidden-context", "hidden-thoughts", "system", "non-text", "bool-timestamp", "duplicate-message",
        "duplicate-image", "duplicate-reference", "missing-image", "unselected-image", "remote-image", "path-image-id",
        "bad-base64", "non-image", "mime-mismatch", "remote-file"])
def test_strict_selected_payload_and_image_validation(setup, mutation, expected):
    store, account, shares, client = setup
    source = payload()
    mutation(source)
    response = client.post(API, json=source, headers=headers(account))
    assert response.status_code == expected, response.text
    assert list(shares.directory.iterdir()) == []
    assert_no_usage(store, account)


@pytest.mark.parametrize("raw", [b'{"messages":[],"messages":[]}', b'{"number":NaN}', b'\xff', b'[' * 1500 + b']' * 1500,
                                  b'{"client_request_id":"\\ud800"}'])
def test_invalid_json_is_private_and_does_not_persist(setup, raw):
    _store, account, shares, client = setup
    response = client.post(API, content=raw, headers=headers(account))
    assert response.status_code == 422 and list(shares.directory.iterdir()) == []


def test_limits_request_text_image_and_public_snapshot(setup, monkeypatch):
    _store, account, shares, client = setup
    assert module.MAX_REQUEST_BYTES == 64 * 1024 * 1024
    assert module.MAX_TEXT_BYTES == 8 * 1024 * 1024
    assert module.MAX_IMAGE_BYTES == 12 * 1024 * 1024
    assert module.MAX_SNAPSHOT_BYTES == 16 * 1024 * 1024
    with monkeypatch.context() as patch:
        patch.setattr(module, "MAX_REQUEST_BYTES", 100)
        assert client.post(API, json=payload(), headers=headers(account)).status_code == 413
    with monkeypatch.context() as patch:
        patch.setattr(module, "MAX_TEXT_BYTES", 100)
        assert client.post(API, json=payload(), headers=headers(account)).status_code == 413
    with monkeypatch.context() as patch:
        patch.setattr(module, "MAX_IMAGE_BYTES", len(PNG) - 1)
        assert client.post(API, json=payload(), headers=headers(account)).status_code == 413
    with monkeypatch.context() as patch:
        patch.setattr(module, "MAX_SNAPSHOT_BYTES", 100)
        assert client.post(API, json=payload(), headers=headers(account)).status_code == 413
    assert list(shares.directory.iterdir()) == []
    # Real byte-based limit, including multibyte text and JSON metadata.
    large = payload(image=False)
    large["messages"][0]["content"] = "测" * (module.MAX_TEXT_BYTES // 3)
    response = client.post(API, content=encode(large), headers=headers(account))
    assert response.status_code == 413 and "8 MiB" in response.json()["error"]["message"]


def test_unknown_share_image_and_cross_share_image_scope(setup):
    _store, account, _shares, client = setup
    first = create(client, account)
    second_source = payload(image=False, request_id="second")
    second = create(client, account, second_source)
    assert client.get(API + "/" + first["id"] + "/images/other-image").status_code == 404
    assert client.get(API + "/" + second["id"] + "/images/image-transfer-id").status_code == 404
    assert client.get(API + "/" + "a" * 32).status_code == 404
    assert client.get(API + "/invalid-id").status_code == 404
    assert client.get("/chat/public-shares/invalid-id").status_code == 404


def test_expired_during_upload_does_not_create_share(setup):
    store, account, shares, _client = setup
    raw = encode(payload())
    sent = False
    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            store.accounts.logout(account["token"])
            return {"type": "http.request", "body": raw, "more_body": False}
        return {"type": "http.disconnect"}
    request = Request({"type": "http", "method": "POST", "path": API, "query_string": b"",
        "headers": [(key.lower().encode(), value.encode()) for key, value in headers(account).items()]}, receive=receive)
    router = build_conversation_share_router(store, shares)
    response = asyncio.run(router.routes[0].endpoint(request))
    assert response.status_code == 401 and list(shares.directory.iterdir()) == []


def test_real_create_app_routes_shares_before_chat_fallback(tmp_path):
    from app.main import create_app
    settings = Settings(db_path=str(tmp_path / "unified.sqlite3"), worker_enabled=False,
        api_enabled=True, api_key="synthetic-key", weekly_limit=100, user_weekly_limit=20)
    app = create_app(settings)
    with TestClient(app, base_url=ORIGIN) as client:
        store = app.state.store
        account = store.accounts.register("synthetic_unified", "synthetic-password-123")
        assert client.post(API, json=payload()).status_code == 401
        created = create(client, account)
        path = API + "/" + created["id"]
        assert client.get(path).json()["messages"] == payload()["messages"]
        assert client.get(path + "/images/image-transfer-id").content == PNG
        assert client.get("/chat/public-shares/" + created["id"]).status_code == 200
        assert client.get(API, headers=headers(account)).json() == {"shares": [created]}
        assert client.delete(path, headers=headers(account)).status_code == 200
        assert client.get(path).status_code == 404
        assert client.get("/chat/api/not-a-route", headers=headers(account)).status_code == 404
        assert_no_usage(store, account)


def test_site_share_limit_allows_retry_read_and_revoke(setup, monkeypatch):
    store, account, shares, client = setup
    share = create(client, account)
    monkeypatch.setattr(store, "settings", replace(store.settings, share_pool_bytes=0))
    assert client.post(API, json=payload(), headers=headers(account)).status_code == 200
    assert client.post(API, json=payload(request_id="different-request"), headers=headers(account)).status_code == 507
    assert client.get(API + "/" + share["id"]).status_code == 200
    assert client.delete(API + "/" + share["id"], headers=headers(account)).status_code == 200
