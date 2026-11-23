"""Managed chat delivery and recovery with synthetic Anthropic event streams."""
import asyncio
from contextlib import asynccontextmanager
import time
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI

from account_fixtures import managed_account
from app.chat import ChatProvider, build_chat_router
from app.chat_jobs import ChatJobs
from app.config import Settings
from app.store import Store
from test_chat import ORIGIN, identity, message, records


START = b'event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic"}}\n\n'
DELTA = b'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Synthetic reply"}}\n\n'
STOP = b'event: message_stop\ndata: {"type":"message_stop"}\n\n'
PROVIDER = ChatProvider("https://chat.synthetic.invalid", "deepseek-flash", "synthetic-private-key")


@pytest.fixture
def store(tmp_path):
    store = Store(Settings(db_path=str(tmp_path / "chat-jobs.sqlite3"), worker_enabled=False,
        api_enabled=True, api_key=PROVIDER.api_key, model=PROVIDER.model,
        weekly_limit=100, user_weekly_limit=20))
    store.initialize()
    return store


class GatedStream(httpx.AsyncByteStream):
    def __init__(self, release, terminal, *, keepalives=False):
        self.keepalives = keepalives
        self.release = release
        self.terminal = terminal

    async def __aiter__(self):
        yield START
        if self.keepalives:
            yield DELTA
            for _ in range(60):
                await asyncio.sleep(0.02)
                yield b": keep-alive\n\n"
            return
        await self.release.wait()
        yield DELTA
        if self.terminal:
            # The terminal event may straddle upstream chunks.
            yield self.terminal[:20]
            yield self.terminal[20:]


@asynccontextmanager
async def chat_service(store, release, *, terminal=STOP, keepalives=False, **job_options):
    dispatched = []
    jobs = ChatJobs(store, **job_options)

    def handler(request):
        dispatched.append(request)
        return httpx.Response(200, stream=GatedStream(release, terminal, keepalives=keepalives),
                              headers={"Content-Type": "text/event-stream"})

    @asynccontextmanager
    async def lifespan(_app):
        await jobs.start()
        try:
            yield
        finally:
            release.set()
            await jobs.stop()

    app = FastAPI(lifespan=lifespan)
    app.include_router(build_chat_router(store, chat_jobs=jobs,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        provider_loader=lambda: PROVIDER))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url=ORIGIN) as client:
            yield app, client, dispatched


def job_path():
    return f"/chat/api/chat-jobs/{uuid4()}"


def assert_error(response, status, code):
    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code


async def watch(app, path, owner, got_start, disconnect, messages):
    """Observe an incremental SSE response and simulate HTTP disconnect without buffering it."""
    scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.0"},
        "http_version": "1.1", "method": "GET", "scheme": "https", "root_path": "",
        "path": path, "raw_path": path.encode(), "query_string": b"",
        "headers": [(key.lower().encode(), value.encode()) for key, value in identity(owner).items()],
        "client": ("127.0.0.1", 12345), "server": ("digimonlegend.com", 443)}
    delivered = False
    body = bytearray()

    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await disconnect.wait()
        return {"type": "http.disconnect"}

    async def send(frame):
        messages.append(frame)
        if frame["type"] == "http.response.body":
            body.extend(frame.get("body", b""))
            if START in body:
                got_start.set()

    await app(scope, receive, send)
    return bytes(body)


async def post_job(client, path, headers, document):
    response = await client.post(path, headers=headers, json=document)
    assert response.status_code == 202, response.text
    assert response.json() == {"id": path.rsplit("/", 1)[-1]}


def test_disconnect_and_replay_follow_original_job_with_one_dispatch_and_debit(store):
    owner, other = managed_account(store), managed_account(store)
    headers, other_headers = identity(owner), identity(other)
    path, payload = job_path(), message()

    async def probe():
        release = asyncio.Event()
        async with chat_service(store, release) as (app, client, dispatched):
            runtime = await client.get("/chat/api/runtime", headers=headers)
            assert runtime.json()["features"]["background_chat"] is True
            await asyncio.gather(post_job(client, path, headers, payload), post_job(client, path, headers, payload))
            assert_error(await client.post(path, headers=headers, json=message(max_tokens=100)),
                         409, "chat_job_conflict")
            assert_error(await client.get(path + "/events", headers=other_headers), 404, "chat_job_not_found")
            assert_error(await client.post(path + "/cancel", headers=other_headers), 404, "chat_job_not_found")

            observed, disconnect, frames = asyncio.Event(), asyncio.Event(), []
            first = asyncio.create_task(watch(app, path + "/events", owner, observed, disconnect, frames))
            try:
                await asyncio.wait_for(observed.wait(), 3)
                disconnect.set()
                partial = await asyncio.wait_for(first, 3)
                assert START in partial and DELTA not in partial
                assert frames[0]["status"] == 200
            finally:
                first.cancel()
                await asyncio.gather(first, return_exceptions=True)

            observed, frames = asyncio.Event(), []
            second = asyncio.create_task(watch(app, path + "/events", owner, observed, asyncio.Event(), frames))
            try:
                await asyncio.wait_for(observed.wait(), 3)
                release.set()
                completed = await asyncio.wait_for(second, 3)
                assert b"".join((START, DELTA, STOP)) in completed
                assert frames[-1]["more_body"] is False
            finally:
                second.cancel()
                await asyncio.gather(second, return_exceptions=True)

            await post_job(client, path, headers, payload)
            replay = await client.get(path + "/events", headers=headers)
            assert replay.status_code == 200
            assert replay.headers["content-type"].startswith("text/event-stream")
            assert b"".join((START, DELTA, STOP)) in replay.content
            assert len(dispatched) == 1
            assert [(row["kind"], row["status"]) for row in records(store)] == [("chat", "success")]
            assert store.quota(owner["user"]["id"])["user_weekly_remaining"] == 19

    asyncio.run(probe())


def test_keepalives_without_progress_end_job_without_replaying_or_losing_partial_reply(store, monkeypatch):
    monkeypatch.setattr("app.chat_jobs.NO_CHAT_PROGRESS_SECONDS", 0.24)
    owner = managed_account(store)
    headers, path, payload = identity(owner), job_path(), message()

    async def probe():
        async with chat_service(store, asyncio.Event(), keepalives=True) as (_app, client, dispatched):
            await post_job(client, path, headers, payload)
            stream = await asyncio.wait_for(client.get(path + "/events", headers=headers), 3)
            assert stream.status_code == 200
            assert START + DELTA in stream.content
            assert stream.content.count(b": keep-alive") >= 2
            assert b"chat_job_no_progress" in stream.content
            assert STOP not in stream.content
            await post_job(client, path, headers, payload)
            assert (await client.get(path + "/events", headers=headers)).content == stream.content
            assert len(dispatched) == 1
            assert [(row["kind"], row["status"]) for row in records(store)] == [("chat", "uncertain")]

    asyncio.run(probe())


def test_active_limits_and_explicit_cancel_release_capacity(store):
    owners = [managed_account(store) for _ in range(4)]
    headers = [identity(owner) for owner in owners]
    paths = [job_path() for _ in owners]
    payload = message()

    async def probe():
        release = asyncio.Event()
        async with chat_service(store, release) as (app, client, dispatched):
            await post_job(client, paths[0], headers[0], payload)
            assert_error(await client.post(job_path(), headers=headers[0], json=payload), 429, "chat_job_capacity")
            await post_job(client, paths[1], headers[1], payload)
            await post_job(client, paths[2], headers[2], payload)
            assert_error(await client.post(paths[3], headers=headers[3], json=payload), 429, "chat_job_capacity")

            event_path = paths[0] + "/events"
            observed = asyncio.Event()
            watcher = asyncio.create_task(watch(app, event_path, owners[0], observed, asyncio.Event(), []))
            try:
                await asyncio.wait_for(observed.wait(), 3)
                cancelled = await client.post(paths[0] + "/cancel", headers=headers[0])
                assert cancelled.status_code == 200
                assert cancelled.json() == {"id": paths[0].rsplit("/", 1)[-1]}
                cancelled_stream = await asyncio.wait_for(watcher, 3)
                assert b"event: error" in cancelled_stream and b"chat_job_cancelled" in cancelled_stream
                assert DELTA not in cancelled_stream and STOP not in cancelled_stream
                assert (await client.get(event_path, headers=headers[0])).content == cancelled_stream
            finally:
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)

            await post_job(client, paths[3], headers[3], payload)
            release.set()
            for path, owner_headers in zip(paths[1:], headers[1:]):
                replay = await asyncio.wait_for(client.get(path + "/events", headers=owner_headers), 3)
                assert replay.status_code == 200 and STOP in replay.content
            assert len(dispatched) == 4
            assert sorted(row["status"] for row in records(store)) == ["aborted"] + ["success"] * 3

    asyncio.run(probe())


def test_restart_and_expiry_reject_redispatch_without_persisting_transcript(store):
    headers, path, payload = identity(managed_account(store)), job_path(), message()

    async def probe():
        now = time.time()
        release = asyncio.Event()
        release.set()
        async with chat_service(store, release, ttl_seconds=30, clock=lambda: now) as (_app, client, dispatched):
            await post_job(client, path, headers, payload)
            result = await asyncio.wait_for(client.get(path + "/events", headers=headers), 3)
            assert STOP in result.content and len(dispatched) == 1
        with store.connection() as db:
            metadata = dict(db.execute("SELECT * FROM managed_chat_jobs").fetchone())
        assert set(metadata) == {"owner_id", "client_id", "request_hash", "status", "expires_at"}
        assert len(metadata["request_hash"]) == 64

        async with chat_service(store, release, ttl_seconds=30, clock=lambda: now) as (_app, client, dispatched):
            await post_job(client, path, headers, payload)
            result = await asyncio.wait_for(client.get(path + "/events", headers=headers), 3)
            assert result.status_code == 200
            assert b"chat_job_interrupted" in result.content and DELTA not in result.content
            now += 31
            assert_error(await client.get(path + "/events", headers=headers), 410, "chat_job_expired")
            assert_error(await client.post(path, headers=headers, json=payload), 410, "chat_job_expired")
            assert not dispatched and len(records(store)) == 1

    asyncio.run(probe())


def test_truncated_provider_stream_ends_with_interrupted_error_and_replays(store):
    headers, path, payload = identity(managed_account(store)), job_path(), message()

    async def probe():
        release = asyncio.Event()
        release.set()
        async with chat_service(store, release, terminal=None) as (_app, client, dispatched):
            await post_job(client, path, headers, payload)
            result = await asyncio.wait_for(client.get(path + "/events", headers=headers), 3)
            assert result.status_code == 200
            assert START + DELTA in result.content
            assert b"event: error" in result.content and b"chat_job_interrupted" in result.content
            await post_job(client, path, headers, payload)
            replay = await client.get(path + "/events", headers=headers)
            assert result.content == replay.content
            assert len(dispatched) == 1
            assert [row["status"] for row in records(store)] == ["failed"]

    asyncio.run(probe())
