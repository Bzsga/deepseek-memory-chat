"""Synthetic unified chat routes; no real chat, credential or network access."""
import asyncio
import base64
import json
import struct
from dataclasses import replace

import httpx
import pytest
from fastapi import FastAPI, Response
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect

from account_fixtures import managed_account
from app.chat import ChatProvider, ImageProvider, MAX_BODY, build_chat_router, load_image_provider
from app.config import Settings
from app.store import Store


ORIGIN = "https://digimonlegend.com"
PASSWORD = "synthetic-password-123"


class Chunks(httpx.AsyncByteStream):
    def __init__(self, *chunks, after=None):
        self.chunks, self.after = chunks, after

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk
        if self.after:
            self.after()


@pytest.fixture
def environment(tmp_path):
    store = Store(Settings(db_path=str(tmp_path / "chat.sqlite3"), worker_enabled=False,
        api_enabled=True, api_key="synthetic-private-key", model="deepseek-flash",
        weekly_limit=100, user_weekly_limit=20))
    store.initialize()
    first = managed_account(store, "synthetic_one", PASSWORD)
    second = managed_account(store, "synthetic_two", PASSWORD)
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path == "/anthropic/v1/files":
            return httpx.Response(200, json={"id": "file_synthetic", "filename": "test.txt"})
        if request.method == "DELETE":
            return httpx.Response(200, stream=Chunks(b'{"deleted":true}'), headers={"Content-Type": "application/json"})
        return httpx.Response(200, stream=Chunks(b'event: message_start\ndata: {}\n\n',
            b'event: message_stop\ndata: {"type":"message_stop"}\n\n'),
            headers={"Content-Type": "text/event-stream"})

    app = FastAPI()
    app.include_router(build_chat_router(store,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(lambda request: handler(request))),
        provider_loader=lambda: ChatProvider("https://api.deepseek.com", "deepseek-flash", "synthetic-private-key")))
    with TestClient(app, base_url=ORIGIN) as client:
        yield store, first, second, calls, client


def identity(account):
    return {"Cookie": "deepseek_session=" + account["token"],
            "X-Chat-User-Id": account["user"]["id"], "Origin": ORIGIN}


def message(**extra):
    return {"model": "untrusted-model", "messages": [{"role": "user", "content": "Synthetic message."}],
            "stream": True, **extra}


def records(store):
    with store.connection() as database:
        return [dict(row) for row in database.execute("SELECT * FROM chat_calls ORDER BY started_at,id")]


def test_runtime_uses_registered_identity_and_only_personal_weekly_quota(environment):
    store, first, second, calls, client = environment
    response = client.get("/chat/api/runtime")
    assert response.status_code == 401 and response.headers["X-Session-Expired"] == "1"
    response = client.get("/chat/api/runtime", headers=identity(first))
    assert response.status_code == 200
    assert response.json()["user"]["id"] == first["user"]["id"]
    assert response.json()["weekly_quota"]["user_weekly_remaining"] == 20
    assert "weekly_limit" not in response.json()["weekly_quota"]
    assert "synthetic-private-key" not in response.text
    assert not calls


def test_personal_account_uses_cookie_redemption_and_revocation_blocks_all_managed_calls(environment):
    store, _first, _second, calls, client = environment
    personal = store.accounts.register("personal_only", PASSWORD)
    headers = identity(personal)
    invite = {"invitation_code": store.accounts.create_invites(1, 1)["invitations"][0]["code"]}
    url = "/chat/api/redeem-invite"
    assert client.post(url, headers={**headers, "Origin": "https://example.invalid"}, json=invite).status_code == 403
    assert client.post(url, headers={**headers, "X-Chat-User-Id": "old-user"}, json=invite).status_code == 409
    assert client.get("/chat/api/runtime", headers=headers).json()["user"]["managed_eligible"] is False
    redeemed = client.post(url, headers=headers, json=invite)
    assert redeemed.status_code == 200 and redeemed.json()["user"]["managed_eligible"]
    assert client.post("/chat/anthropic/v1/messages", headers=headers, json=message()).status_code == 200
    store.accounts.revoke_managed(personal["user"]["id"])
    assert client.get("/chat/api/runtime", headers=headers).json()["user"]["managed_eligible"] is False
    assert client.post(url, headers=headers, json=invite).status_code == 400
    for route in ("anthropic/v1/messages", "anthropic/v1/files", "v1/tools/tts", "v1/tools/asr", "api/images", "api/image-jobs"):
        denied = client.post("/chat/" + route, headers=headers, json=message())
        assert denied.status_code == 403 and denied.json()["error"]["code"] == "managed_ineligible"
    assert len(calls) == 1 and len(records(store)) == 1


def test_browser_registers_before_redeeming_invitation(environment):
    store, _first, _second, calls, client = environment
    form = client.get("/chat/register").text
    assert 'name="username"' in form and 'name="password"' in form
    assert 'invitation_code' not in form and 'API Key' not in form
    code = store.accounts.create_invites(1, 7)["invitations"][0]["code"]
    fields = {"username": "browser_signup", "password": PASSWORD}
    legacy = client.post("/chat/register", data={**fields, "invitation_code": code}, headers={"Origin": ORIGIN})
    assert legacy.status_code == 422 and "注册后" in legacy.text and code not in legacy.text
    registered = client.post("/chat/register", data=fields, headers={"Origin": ORIGIN}, follow_redirects=False)
    assert registered.status_code == 303
    token = registered.cookies["deepseek_session"]
    owner = store.accounts.authenticate(token)
    assert not store.accounts.me(owner)["user"]["managed_eligible"]
    redeemed = client.post("/chat/api/redeem-invite", json={"invitation_code": code},
                           headers=identity({"token": token, "user": {"id": owner}}))
    assert redeemed.status_code == 200 and redeemed.json()["user"]["managed_eligible"]
    assert not calls


def test_browser_login_cookie_authenticates_the_same_native_account(environment):
    store, first, second, calls, client = environment
    response = client.post("/chat/login", data={"username": "synthetic_one", "password": PASSWORD},
                           headers={"Origin": ORIGIN}, follow_redirects=False)
    assert response.status_code == 303 and response.headers["Location"] == "/deepseek/"
    cookie = response.headers["Set-Cookie"]
    assert "Path=/deepseek-api" in cookie and "HttpOnly" in cookie and "Secure" in cookie
    assert "SameSite=strict" in cookie
    token = cookie.split(";", 1)[0].split("=", 1)[1]
    assert store.accounts.authenticate(token) == first["user"]["id"]
    assert not calls


def test_streaming_overrides_model_and_debits_shared_allowance_once(environment):
    store, first, second, calls, client = environment
    response = client.post("/chat/anthropic/v1/messages",
        json=message(thinking={"type": "disabled"}, temperature=0.0), headers=identity(first))
    assert response.status_code == 200 and "message_stop" in response.text
    assert response.headers["X-Accel-Buffering"] == "no"
    assert len(calls) == 1
    forwarded = json.loads(calls[0].content)
    assert forwarded["model"] == "deepseek-flash"
    assert forwarded["temperature"] == 0.0
    assert forwarded["thinking"] == {"type": "disabled"}
    assert calls[0].headers["Authorization"] == "Bearer synthetic-private-key"
    assert "Cookie" not in calls[0].headers and "X-Chat-User-Id" not in calls[0].headers
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19
    assert records(store)[0]["status"] == "success"


def test_chat_image_instructions_keep_existing_application_extensions(environment):
    store, first, _second, calls, client = environment
    tools = [
        {"type": "deepseek_read_url", "name": "deepseek_read_url"},
        {"type": "deepseek_web_search", "name": "deepseek_web_search"},
    ]
    system = "Synthetic application image instructions with a request-specific marker."
    response = client.post("/chat/anthropic/v1/messages",
        json=message(system=system, tools=tools, thinking={"type": "enabled"}, output_config={"effort": "max"},
                     safety_check={"level": "high"}, title={"enabled": True}),
        headers=identity(first))
    assert response.status_code == 200 and "message_stop" in response.text
    assert len(calls) == 1
    forwarded = json.loads(calls[0].content)
    assert forwarded["tools"] == tools and "tool_choice" not in forwarded
    assert forwarded["system"] == system
    assert forwarded["thinking"] == {"type": "enabled"}
    assert forwarded["output_config"] == {"effort": "max"}
    assert forwarded["safety_check"] == {"level": "high"}
    assert forwarded["title"] == {"enabled": True}
    assert [row["kind"] for row in records(store)] == ["chat"]
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19


def test_retired_client_image_tool_rejected_before_dispatch_or_usage(environment):
    store, first, _second, calls, client = environment
    response = client.post("/chat/anthropic/v1/messages", json=message(tools=[
        {"type": "deepseek_read_url", "name": "deepseek_read_url"},
        {"name": "generate_image", "input_schema": {"type": "object"}},
    ]), headers=identity(first))
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "image_protocol_updated"
    assert not calls and not records(store)
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 20


def test_mismatched_identity_cross_origin_and_invalid_payload_never_dispatch(environment):
    store, first, second, calls, client = environment
    headers = identity(first)
    headers["X-Chat-User-Id"] = second["user"]["id"]
    response = client.post("/chat/anthropic/v1/messages", json=message(), headers=headers)
    assert response.status_code == 409 and response.headers["X-Session-Changed"] == "1"
    headers = {**identity(first), "Origin": "https://example.invalid"}
    assert client.post("/chat/anthropic/v1/messages", json=message(), headers=headers).status_code == 403
    assert client.post("/chat/anthropic/v1/messages", json=[], headers=identity(first)).status_code == 400
    assert client.post("/chat/anthropic/v1/messages", json=message(), headers={**identity(first),
        "Content-Length": str(MAX_BODY + 1)}).status_code == 413
    assert not calls and not records(store)


def test_uploaded_files_are_owner_bound_and_delete_does_not_spend_quota(environment):
    store, first, second, calls, client = environment
    upload = client.post("/chat/anthropic/v1/files", files={"file": ("test.txt", b"synthetic")}, headers=identity(first))
    assert upload.status_code == 200
    body = message(messages=[{"role": "user", "content": [{"type": "document", "source": {
        "type": "file", "file_id": upload.json()["id"]}}]}])
    assert client.post("/chat/anthropic/v1/messages", json=body, headers=identity(second)).status_code == 403
    assert client.delete("/chat/anthropic/v1/files/file_synthetic", headers=identity(second)).status_code == 403
    assert len(calls) == 1
    assert client.post("/chat/anthropic/v1/messages", json=body, headers=identity(first)).status_code == 200
    assert client.delete("/chat/anthropic/v1/files/file_synthetic", headers=identity(first)).status_code == 200
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 18
    assert client.post("/chat/anthropic/v1/messages", json=body, headers=identity(first)).status_code == 403
    assert len(calls) == 3


def test_native_bearer_and_revocation_share_one_identity(environment):
    store, first, second, calls, client = environment
    headers = {"Authorization": "Bearer " + first["token"], "X-Chat-User-Id": first["user"]["id"]}
    assert client.get("/chat/api/runtime", headers=headers).status_code == 200
    store.accounts.logout(first["token"])
    response = client.post("/chat/anthropic/v1/messages", json=message(), headers=headers)
    assert response.status_code == 401
    assert not calls and not records(store)


def test_common_quota_blocks_new_chat_before_upstream_dispatch(environment):
    store, first, second, calls, client = environment
    owner = first["user"]["id"]
    store.update_user_quota(owner, {"this_week_remaining": 0})
    response = client.post("/chat/anthropic/v1/messages", json=message(), headers=identity(first))
    assert response.status_code in (429, 503)
    assert "error" in response.json()
    assert not calls and not records(store)


def custom_client(store, handler, image_provider=None):
    app = FastAPI()
    app.include_router(build_chat_router(store,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        provider_loader=lambda: ChatProvider("https://api.deepseek.com", "deepseek-flash", "synthetic-private-key"),
        image_provider_loader=lambda: image_provider))
    return TestClient(app, base_url=ORIGIN)


def test_upstream_redirect_is_not_followed_and_sent_call_stays_counted(environment):
    store, first, second, calls, client = environment
    dispatched = []

    def handler(request):
        dispatched.append(request)
        return httpx.Response(307, headers={"Location": "https://example.invalid/credential-trap"})

    with custom_client(store, handler) as isolated:
        response = isolated.post("/chat/anthropic/v1/messages", json=message(), headers=identity(first))
    assert response.status_code == 502
    assert len(dispatched) == 1 and dispatched[0].url.host == "api.deepseek.com"
    assert records(store)[0]["status"] == "failed"
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19


def test_revocation_interrupts_a_stream_and_keeps_its_dispatch_count(environment):
    store, first, second, calls, client = environment

    class RevokedStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'event: message_start\ndata: {}\n\n'
            store.accounts.set_enabled(first["user"]["id"], False)
            yield b'event: message_stop\ndata: {"type":"message_stop"}\n\n'

    def handler(request):
        return httpx.Response(200, stream=RevokedStream(), headers={"Content-Type": "text/event-stream"})

    with custom_client(store, handler) as isolated:
        response = isolated.post("/chat/anthropic/v1/messages", json=message(), headers=identity(first))
    assert response.status_code == 200
    assert 'message_stop' not in response.text
    assert records(store)[0]["status"] == "aborted"


def test_model_listing_does_not_spend_allowance_and_native_bearer_works(environment):
    store, first, second, calls, client = environment
    headers = {"Authorization": "Bearer " + first["token"], "X-Chat-User-Id": first["user"]["id"]}
    response = client.get("/chat/models", headers=headers)
    assert response.status_code == 200
    assert len(calls) == 1
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 20
    assert not records(store)


IMAGE_PROVIDER = ImageProvider("https://image.synthetic.invalid", "synthetic-image-model", "synthetic-image-key")
PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"synthetic image fixture").decode("ascii")


@pytest.mark.parametrize("field", ["b64_json", "b64"])
def test_generated_image_uses_fixed_configuration_and_one_shared_dispatch(environment, field):
    store, first, second, calls, client = environment
    dispatched = []

    def handler(request):
        dispatched.append(request)
        return httpx.Response(200, json={"data": [{field: PNG}]})

    with custom_client(store, handler, IMAGE_PROVIDER) as isolated:
        runtime = isolated.get("/chat/api/runtime", headers=identity(first)).json()
        assert runtime["features"]["image_generation"] is True
        assert runtime["image_model"] == "synthetic-image-model"
        response = isolated.post("/chat/api/images", json={"prompt": "合成的测试图片"}, headers=identity(first))
    assert response.status_code == 200
    assert response.json() == {"images": [{"b64_json": PNG, "mime_type": "image/png"}], "model": "synthetic-image-model"}
    assert len(dispatched) == 1
    assert str(dispatched[0].url) == "https://image.synthetic.invalid/v1/images/generations"
    assert json.loads(dispatched[0].content) == {"model": "synthetic-image-model", "prompt": "合成的测试图片", "n": 1, "size": "1024x1024"}
    assert dispatched[0].headers["Authorization"] == "Bearer synthetic-image-key"
    assert "Cookie" not in dispatched[0].headers
    assert records(store)[0]["kind"] == "image" and records(store)[0]["status"] == "success"
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19
    assert "synthetic-image-key" not in response.text


def test_image_validation_auth_and_disabled_configuration_do_not_dispatch(environment):
    store, first, second, calls, client = environment
    dispatched = []

    def handler(request):
        dispatched.append(request)
        return httpx.Response(200, json={"data": [{"b64_json": PNG}]})

    with custom_client(store, handler, IMAGE_PROVIDER) as isolated:
        assert isolated.post("/chat/api/images", json={"prompt": "test"}).status_code == 401
        assert isolated.post("/chat/api/images", json={"prompt": " "}, headers=identity(first)).status_code == 400
        assert isolated.post("/chat/api/images", json={"prompt": "a" * 8001}, headers=identity(first)).status_code == 400
        assert isolated.post("/chat/api/images", json={"prompt": "test", "base_url": "https://example.invalid"}, headers=identity(first)).status_code == 400
        assert isolated.post("/chat/api/images", json={"prompt": "test"}, headers={**identity(first), "Origin": "https://example.invalid"}).status_code == 403
    with custom_client(store, handler, None) as isolated:
        runtime = isolated.get("/chat/api/runtime", headers=identity(first)).json()
        assert runtime["features"]["image_generation"] is False
        assert isolated.post("/chat/api/images", json={"prompt": "test"}, headers=identity(first)).status_code == 503
    assert not dispatched and not records(store)


@pytest.mark.parametrize("document", [
    {"data": [{"url": "https://example.invalid/private-image"}]},
    {"data": [{"b64_json": base64.b64encode(b"<html>untrusted</html>").decode()}]},
])
def test_image_urls_and_non_image_payloads_are_not_returned_or_fetched(environment, document):
    store, first, second, calls, client = environment
    dispatched = []

    def handler(request):
        dispatched.append(request)
        return httpx.Response(200, json=document)

    with custom_client(store, handler, IMAGE_PROVIDER) as isolated:
        response = isolated.post("/chat/api/images", json={"prompt": "test"}, headers=identity(first))
    assert response.status_code == 502 and len(dispatched) == 1
    assert "example.invalid" not in response.text and "<html>" not in response.text
    assert records(store)[0]["status"] == "failed"
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19


def test_image_redirect_does_not_replay_or_forward_credentials(environment):
    store, first, second, calls, client = environment
    dispatched = []

    def handler(request):
        dispatched.append(request)
        return httpx.Response(307, headers={"Location": "https://example.invalid/trap"})

    with custom_client(store, handler, IMAGE_PROVIDER) as isolated:
        response = isolated.post("/chat/api/images", json={"prompt": "test"}, headers=identity(first))
    assert response.status_code == 502 and len(dispatched) == 1
    assert records(store)[0]["status"] == "failed"


def test_astrbot_image_config_format_is_read_locally_without_exposing_key(tmp_path, monkeypatch):
    config = tmp_path / "image-provider.json"
    config.write_text(json.dumps({"base_url": "https://image.synthetic.invalid", "api_key": "synthetic-image-key",
        "default_model": "synthetic-image-model", "default_size": "1024x1024", "request_timeout": 100, "enabled": True}), encoding="utf-8")
    monkeypatch.setenv("IMAGE_PROVIDER_CONFIG", str(config))
    provider = load_image_provider()
    assert provider == IMAGE_PROVIDER and "synthetic-image-key" not in repr(provider)
    config.write_text(json.dumps({"enabled": False}), encoding="utf-8")
    assert load_image_provider() is None


@pytest.mark.parametrize("status, expected, code", [
    (400, 422, "image_request_rejected"),
    (401, 503, "image_provider_auth"),
    (403, 503, "image_provider_auth"),
    (402, 503, "image_provider_quota"),
    (404, 503, "image_model_unavailable"),
    (429, 429, "image_rate_limited"),
    (504, 504, "image_timeout"),
    (500, 502, "image_provider_unavailable"),
])
def test_image_failures_expose_safe_category_and_count_one_dispatch(environment, status, expected, code):
    store, first, _second, _calls, _client = environment
    dispatched = []

    def handler(request):
        dispatched.append(request)
        return httpx.Response(status, json={"error": {"message": "synthetic-image-key secret upstream detail"}},
                              headers={"Retry-After": "15"})

    with custom_client(store, handler, IMAGE_PROVIDER) as isolated:
        response = isolated.post("/chat/api/images", json={"prompt": "synthetic image"}, headers=identity(first))
    assert response.status_code == expected
    assert response.json()["error"]["code"] == code
    assert "synthetic-image-key" not in response.text and "upstream detail" not in response.text
    if status == 429:
        assert response.headers["Retry-After"] == "15"
    assert len(dispatched) == 1 and records(store)[0]["status"] == "failed"
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19


def test_image_timeout_keeps_sent_request_count_without_replaying(environment):
    store, first, _second, _calls, _client = environment
    dispatched = []

    def handler(request):
        dispatched.append(request)
        raise httpx.ReadTimeout("synthetic-image-key", request=request)

    with custom_client(store, handler, IMAGE_PROVIDER) as isolated:
        response = isolated.post("/chat/api/images", json={"prompt": "synthetic image"}, headers=identity(first))
    assert response.status_code == 504
    assert response.json()["error"]["code"] == "image_timeout"
    assert "synthetic-image-key" not in response.text
    assert len(dispatched) == 1 and records(store)[0]["status"] == "failed"
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19


def test_camera_image_without_extension_is_uploaded_with_required_beta(environment):
    store, first, _second, calls, client = environment
    raw = base64.b64decode(PNG)
    response = client.post("/chat/anthropic/v1/files", files={"file": ("camera", raw, "application/octet-stream")},
                           headers=identity(first))
    assert response.status_code == 200 and len(calls) == 1
    assert calls[0].headers["anthropic-beta"] == "files-api-2025-04-14"
    assert raw in calls[0].content
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19


@pytest.mark.parametrize("name, raw, mime", [
    ("bad.png", b"not an image", "image/png"),
    ("vector.svg", b'<svg xmlns="http://www.w3.org/2000/svg"></svg>', "image/svg+xml"),
    ("wrong.jpg", base64.b64decode(PNG), "image/jpeg"),
])
def test_unsupported_or_mislabeled_visual_image_is_rejected_before_dispatch(environment, name, raw, mime):
    store, first, _second, calls, client = environment
    response = client.post("/chat/anthropic/v1/files", files={"file": (name, raw, mime)}, headers=identity(first))
    assert response.status_code == 415 and response.json()["error"]["code"] == "upload_image_format"
    assert not calls and not records(store)
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 20


def test_multipart_without_file_and_oversize_plain_text_do_not_dispatch(environment, monkeypatch):
    store, first, _second, calls, client = environment
    response = client.post("/chat/anthropic/v1/files", data={"purpose": "user_data"}, headers=identity(first))
    assert response.status_code == 400
    monkeypatch.setattr("app.chat.MAX_USER_DATA_BYTES", 8)
    response = client.post("/chat/anthropic/v1/files", files={"file": ("test.txt", b"synthetic text")},
                           headers=identity(first))
    assert response.status_code == 413 and response.json()["error"]["code"] == "upload_too_large"
    assert not calls and not records(store)
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 20


async def image_asgi(store, account, handler, *, provider=IMAGE_PROVIDER, spec="2.0", on_send=None, disconnect=None):
    """Observe each ASGI frame before TestClient could buffer the entire SSE body."""
    app = FastAPI()
    app.include_router(build_chat_router(store,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        provider_loader=lambda: ChatProvider("https://api.deepseek.com", "deepseek-flash", "synthetic-private-key"),
        image_provider_loader=lambda: provider))
    payload = json.dumps({"prompt": "synthetic image"}).encode()
    headers = {**identity(account), "Accept": "text/event-stream", "Content-Type": "application/json"}
    scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": spec},
        "http_version": "1.1", "method": "POST", "scheme": "https", "root_path": "",
        "path": "/chat/api/images", "raw_path": b"/chat/api/images", "query_string": b"",
        "headers": [(key.lower().encode(), str(value).encode()) for key, value in headers.items()],
        "client": ("127.0.0.1", 12345), "server": ("digimonlegend.com", 443)}
    delivered = False
    stats = {"active_receivers": 0, "max_receivers": 0, "messages": []}

    async def receive():
        nonlocal delivered
        stats["active_receivers"] += 1
        stats["max_receivers"] = max(stats["max_receivers"], stats["active_receivers"])
        try:
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": payload, "more_body": False}
            if disconnect:
                await disconnect()
                return {"type": "http.disconnect"}
            await asyncio.Future()
        finally:
            stats["active_receivers"] -= 1

    async def send(message):
        stats["messages"].append(message)
        if on_send:
            await on_send(message)

    await asyncio.wait_for(app(scope, receive, send), timeout=3)
    return stats


def test_image_sse_sends_headers_and_heartbeat_before_delayed_result(environment, monkeypatch):
    store, first, _second, _calls, _client = environment
    monkeypatch.setattr("app.chat.IMAGE_HEARTBEAT_SECONDS", 0.02)
    dispatched = []

    async def probe():
        release = asyncio.Event()
        completed = False

        async def handler(request):
            nonlocal completed
            dispatched.append(request)
            await release.wait()
            completed = True
            return httpx.Response(200, json={"data": [{"b64_json": PNG}]})

        async def sent(message):
            if message["type"] == "http.response.start":
                assert message["status"] == 200 and not completed
                headers = dict(message["headers"])
                assert headers[b"content-type"].startswith(b"text/event-stream")
                assert headers[b"x-accel-buffering"] == b"no"
            if message.get("body", b"").startswith(b":"):
                if not release.is_set():
                    assert not completed
                if b"keepalive" in message["body"] and not release.is_set():
                    release.set()

        return await image_asgi(store, first, handler, on_send=sent)

    stats = asyncio.run(probe())
    bodies = [item["body"] for item in stats["messages"] if item["type"] == "http.response.body"]
    assert bodies[0].startswith(b": image generation started")
    assert any(b": keepalive" in body for body in bodies)
    result = next(body for body in bodies if body.startswith(b"event: result"))
    assert json.loads(result.split(b"data: ", 1)[1])["images"][0]["b64_json"] == PNG
    assert stats["max_receivers"] == 1 and len(dispatched) == 1
    assert records(store)[0]["status"] == "success"
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19


def test_image_sse_upstream_failure_is_an_error_event_and_preflight_stays_http(environment):
    store, first, _second, _calls, _client = environment
    dispatched = []

    def handler(request):
        dispatched.append(request)
        return httpx.Response(429, json={"error": {"message": "synthetic-image-key private detail"}})

    with custom_client(store, handler, IMAGE_PROVIDER) as isolated:
        headers = {**identity(first), "Accept": "text/event-stream"}
        assert isolated.post("/chat/api/images", json={"prompt": "test"}, headers={"Accept": "text/event-stream"}).status_code == 401
        assert isolated.post("/chat/api/images", json={"prompt": " "}, headers=headers).status_code == 400
        response = isolated.post("/chat/api/images", json={"prompt": "test"}, headers=headers)
    assert response.status_code == 200 and "event: error\n" in response.text
    error = json.loads(response.text.split("data: ", 1)[1])["error"]
    assert error["status"] == 429 and error["code"] == "image_rate_limited"
    assert "synthetic-image-key" not in response.text and len(dispatched) == 1
    assert records(store)[0]["status"] == "failed"
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19


def test_image_sse_disconnect_cancels_pending_upstream_without_receive_competition(environment):
    store, first, _second, _calls, _client = environment
    dispatched, cancelled = [], []

    async def probe():
        entered = asyncio.Event()

        async def handler(request):
            dispatched.append(request)
            entered.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                cancelled.append(True)
                raise

        async def disconnect():
            await entered.wait()

        return await image_asgi(store, first, handler, disconnect=disconnect)

    stats = asyncio.run(probe())
    assert stats["max_receivers"] == 1
    assert len(dispatched) == 1 and cancelled == [True]
    assert records(store)[0]["status"] == "aborted"
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19


def test_image_sse_asgi24_send_disconnect_closes_generation(environment, monkeypatch):
    store, first, _second, _calls, _client = environment
    monkeypatch.setattr("app.chat.IMAGE_HEARTBEAT_SECONDS", 0.02)
    dispatched, cancelled = [], []

    async def probe():
        entered = asyncio.Event()

        async def handler(request):
            dispatched.append(request)
            entered.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                cancelled.append(True)
                raise

        async def sent(message):
            if b"keepalive" in message.get("body", b""):
                await entered.wait()
                raise OSError("synthetic disconnected socket")

        with pytest.raises(ClientDisconnect):
            await image_asgi(store, first, handler, spec="2.4", on_send=sent)

    asyncio.run(probe())
    assert len(dispatched) == 1 and cancelled == [True]
    assert records(store)[0]["status"] == "aborted"


def test_image_sse_account_revocation_stops_generation(environment):
    store, first, _second, _calls, _client = environment
    dispatched, cancelled = [], []

    async def probe():
        async def handler(request):
            dispatched.append(request)
            store.accounts.set_enabled(first["user"]["id"], False)
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                cancelled.append(True)
                raise

        return await image_asgi(store, first, handler)

    stats = asyncio.run(probe())
    body = b"".join(item.get("body", b"") for item in stats["messages"])
    assert b"event: error\n" in body
    assert json.loads(body.split(b"data: ", 1)[1])["error"]["status"] == 401
    assert len(dispatched) == 1 and cancelled == [True]
    assert records(store)[0]["status"] == "aborted"


def test_image_sse_has_an_overall_deadline_and_keeps_one_dispatch(environment, monkeypatch):
    store, first, _second, _calls, _client = environment
    monkeypatch.setattr("app.chat.IMAGE_HEARTBEAT_SECONDS", 0.01)
    dispatched, cancelled = [], []

    async def probe():
        async def handler(request):
            dispatched.append(request)
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                cancelled.append(True)
                raise

        provider = ImageProvider(IMAGE_PROVIDER.origin, IMAGE_PROVIDER.model, IMAGE_PROVIDER.api_key, timeout=0.08)
        return await image_asgi(store, first, handler, provider=provider)

    stats = asyncio.run(probe())
    body = b"".join(item.get("body", b"") for item in stats["messages"])
    error = json.loads(body.split(b"data: ", 1)[1])["error"]
    assert error["status"] == 504 and error["code"] == "image_timeout"
    assert len(dispatched) == 1 and cancelled == [True]
    assert records(store)[0]["status"] == "failed"
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19


# Generated from a short synthetic PCM signal; embedded to avoid an ffmpeg dependency.
ASR_OPUS = base64.b64decode(
    "T2dnUwACAAAAAAAAAADLK81eAAAAAOZ+a1MBE09wdXNIZWFkAQE4AYA+AAAAAABPZ2dTAAAAAAAAAAAAAMsrzV4B"
    "AAAAbe4JBwE9T3B1c1RhZ3MMAAAATGF2ZjYxLjcuMTAwAQAAAB0AAABlbmNvZGVyPUxhdmM2MS4xOS4xMDAg"
    "bGlib3B1c09nZ1MABDgQAAAAAAAAyyvNXgIAAAD/axRNBRUUFBUUCILijkVFWJq3MxI9G8PVTl8X9UIhCKSJ"
    "LV9gjkrYHKOwGfmpCzml7UAInp5Q5KP4NE64wC9nTYSAP5jqEAiet0NG2r6/I+yzu6MjeTjxv77EQAiEerT"
    "EsrtccByed9yHkcqCH5GA"
)


def asr_wav(rate=16000, frames=160, sample=b"\x01\x00", format_code=1):
    """A synthetic mono WAV; format_code=3 builds IEEE float for rejection coverage."""
    data = sample * frames
    width = len(sample)
    return (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, format_code, 1, rate, rate * width, width, width * 8)
            + b"data" + struct.pack("<I", len(data)) + data)


@pytest.mark.parametrize("audio,mime", [
    pytest.param(asr_wav(16000), "audio/wav", id="wav-16k"),
    pytest.param(asr_wav(48000), "audio/wav", id="wav-48k"),
    pytest.param(ASR_OPUS, "application/octet-stream", id="ogg-opus-generic-filename"),
])
def test_asr_valid_audio_is_forwarded_unchanged_and_counted_once(environment, audio, mime):
    store, first, _second, _calls, _client = environment
    dispatched = []

    def handler(request):
        dispatched.append(request)
        return httpx.Response(200, json={"text": "合成语音识别测试", "duration_ms": 10})

    with custom_client(store, handler) as isolated:
        upload = isolated.build_request("POST", "/chat/v1/tools/asr", headers=identity(first),
                                        files={"file": ("recording.wav", audio, mime)})
        multipart = upload.read()
        response = isolated.send(upload)
    assert response.status_code == 200
    assert response.json() == {"text": "合成语音识别测试", "duration_ms": 10}
    assert len(dispatched) == 1
    assert dispatched[0].url.path == "/v1/tools/asr"
    assert dispatched[0].content == multipart
    assert dispatched[0].headers["Content-Type"] == upload.headers["Content-Type"]
    assert dispatched[0].headers["Authorization"] == "Bearer synthetic-private-key"
    assert "Cookie" not in dispatched[0].headers and "X-Chat-User-Id" not in dispatched[0].headers
    assert [(row["kind"], row["status"]) for row in records(store)] == [("asr", "success")]
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19


@pytest.mark.parametrize("case,status,code", [
    ("empty", 400, "asr_audio_empty"),
    ("float32", 400, "asr_audio_invalid"),
    ("unknown-rate", 400, "asr_audio_invalid"),
    ("too-long", 400, "asr_audio_too_long"),
    ("too-large", 413, "asr_audio_too_large"),
    ("duplicate-file", 400, "asr_audio_invalid"),
    ("missing-file", 400, "asr_audio_invalid"),
])
def test_asr_invalid_audio_never_dispatches_or_spends_allowance(environment, case, status, code):
    store, first, _second, calls, client = environment
    audio = {
        "float32": lambda: asr_wav(sample=b"\x00\x00\x80\x3f", format_code=3),
        "unknown-rate": lambda: asr_wav(12345),
        "too-long": lambda: asr_wav(frames=16000 * 120 + 1),
        "too-large": lambda: asr_wav(48000, frames=8 * 1024 * 1024 // 2 + 1),
    }.get(case, asr_wav)()
    uploads = [[("file", ("recording.wav", audio, "audio/wav"))]]
    if case == "empty":
        uploads = [[("file", ("recording.wav", content, "audio/wav"))]
                   for content in (b"", asr_wav(frames=0), asr_wav(sample=b"\x00\x00"))]
    elif case == "duplicate-file":
        uploads[0] *= 2
    elif case == "missing-file":
        uploads = [[("audio", ("recording.wav", audio, "audio/wav"))]]
    for files in uploads:
        response = client.post("/chat/v1/tools/asr", files=files, headers=identity(first))
        assert response.status_code == status
        assert response.json()["error"]["code"] == code
    assert not calls and not records(store)
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 20


@pytest.mark.parametrize("upstream_status,status,code", [
    (400, 400, "asr_audio_rejected"),
    (401, 503, "asr_provider_auth"),
    (429, 429, "asr_rate_limited"),
    (503, 503, "asr_provider_busy"),
    (504, 504, "asr_timeout"),
])
def test_asr_provider_errors_are_safe_and_keep_one_dispatch(environment, upstream_status, status, code):
    store, first, _second, _calls, _client = environment
    dispatched = []

    def handler(request):
        dispatched.append(request)
        return httpx.Response(upstream_status, content=b"synthetic-private-key raw provider detail",
                              headers={"Retry-After": "17", "Content-Type": "text/plain"})

    with custom_client(store, handler) as isolated:
        response = isolated.post("/chat/v1/tools/asr", headers=identity(first),
                                 files={"file": ("recording.wav", asr_wav(), "audio/wav")})
    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    assert "synthetic-private-key" not in response.text and "raw provider detail" not in response.text
    if upstream_status == 429:
        assert response.headers["Retry-After"] == "17"
    assert len(dispatched) == 1
    assert [(row["kind"], row["status"]) for row in records(store)] == [("asr", "failed")]
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19


def test_asr_invalid_200_document_is_failed_and_keeps_its_dispatch(environment):
    store, first, _second, _calls, _client = environment
    dispatched = []

    def handler(request):
        dispatched.append(request)
        return httpx.Response(200, json={"text": None, "private": "synthetic-private-key"})

    with custom_client(store, handler) as isolated:
        response = isolated.post("/chat/v1/tools/asr", headers=identity(first),
                                 files={"file": ("recording.wav", asr_wav(), "audio/wav")})
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "asr_response_invalid"
    assert "synthetic-private-key" not in response.text
    assert len(dispatched) == 1
    assert [(row["kind"], row["status"]) for row in records(store)] == [("asr", "failed")]
    assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19


@pytest.mark.parametrize("scope", ["personal", "global"])
def test_asr_allowance_and_separate_admin_identity_cannot_be_bypassed(environment, monkeypatch, scope):
    store, first, _second, calls, client = environment
    owner = first["user"]["id"]
    if scope == "personal":
        store.update_user_quota(owner, {"this_week_remaining": 0})
    else:
        store.update_config({"weekly_limit": 0})
    files = {"file": ("recording.wav", asr_wav(), "audio/wav")}
    response = client.post("/chat/v1/tools/asr", files=files, headers=identity(first))
    assert response.status_code in (429, 503)
    assert not calls and not records(store)
    if scope == "global":
        from app.admin_access import admin_authorizer

        # Administration is a separate bearer principal, not an Accounts role.
        token = "synthetic-asr-admin-token"
        monkeypatch.setattr(store, "settings", replace(store.settings, admin_token=token))
        assert admin_authorizer(store)(Response(), "Bearer " + token) is None
        headers = {**identity(first), "Authorization": "Bearer " + token}
        assert client.post("/chat/v1/tools/asr", files=files, headers=headers).status_code == 401
        headers.pop("Cookie")
        assert client.post("/chat/v1/tools/asr", files=files, headers=headers).status_code == 401
        assert store.quota(owner)["weekly_remaining"] == 0
        assert not calls and not records(store)

