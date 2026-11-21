"""Synthetic background image jobs, durable identity and owner-scoped recovery."""
import asyncio
import base64
from contextlib import asynccontextmanager
from email import policy
from email.parser import BytesParser
import hashlib
import json
import threading
import time

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from account_fixtures import managed_account
from app.chat import ChatProvider, ImageProvider, MAX_IMAGE_EDIT_BODY, build_chat_router
from app.config import Settings
from app.image_jobs import ImageJobError, ImageJobs
from app.main import BoundedBodyMiddleware
from app.store import Store


ORIGIN = "https://digimonlegend.com"
PROVIDER = ImageProvider("https://image.synthetic.invalid", "synthetic-image-model", "synthetic-key")
PNG = base64.b64encode(b"\x89PNG\r\n\x1a\nsynthetic test image").decode()
RESULT = {"images": [{"b64_json": PNG, "mime_type": "image/png"}], "model": PROVIDER.model}


@pytest.fixture
def owners(tmp_path):
    store = Store(Settings(db_path=str(tmp_path / "jobs.sqlite3"), worker_enabled=False,
        api_enabled=True, api_key="synthetic-key", model="deepseek-flash", weekly_limit=100, user_weekly_limit=20))
    store.initialize()
    first = managed_account(store, "synthetic_first", "synthetic-password-123")
    second = managed_account(store, "synthetic_second", "synthetic-password-123")
    return store, first, second, tmp_path / "private-results"


def headers(account):
    return {"Authorization": "Bearer " + account["token"], "X-Chat-User-Id": account["user"]["id"], "Origin": ORIGIN}


def wait_until(condition):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError("Synthetic background job did not reach the expected state")


def calls(store):
    with store.connection() as db:
        return [dict(row) for row in db.execute("SELECT kind,status FROM chat_calls ORDER BY started_at,id")]


def test_job_survives_creation_response_and_recovers_with_one_dispatch_owner_and_ttl(owners):
    store, first, second, directory = owners
    now = [time.time()]
    release = threading.Event()
    dispatched = []
    jobs = ImageJobs(store, directory, clock=lambda: now[0])

    async def handler(request):
        dispatched.append(request)
        while not release.is_set():
            await asyncio.sleep(0.01)
        return httpx.Response(200, json={"data": [{"b64_json": PNG}]})

    @asynccontextmanager
    async def lifespan(_app):
        await jobs.start()
        try:
            yield
        finally:
            release.set()
            await jobs.stop()

    app = FastAPI(lifespan=lifespan)
    app.include_router(build_chat_router(store, image_jobs=jobs,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        provider_loader=lambda: ChatProvider("https://api.deepseek.com", "deepseek-flash", "synthetic-key"),
        image_provider_loader=lambda: PROVIDER))
    key = "synthetic-stable-image-id"
    path = "/chat/api/image-jobs/" + key
    body = {"client_request_id": key, "prompt": "Synthetic prompt kept only in task memory"}
    with TestClient(app, base_url=ORIGIN) as client:
        assert client.post("/chat/api/image-jobs", json=body).status_code == 401
        accepted = client.post("/chat/api/image-jobs", json=body, headers=headers(first))
        assert accepted.status_code == 202
        assert accepted.json()["status"] == "queued"
        # The creation request has fully ended while generation remains blocked.
        wait_until(lambda: len(dispatched) == 1)
        duplicate = client.post("/chat/api/image-jobs", json=body, headers=headers(first))
        assert duplicate.status_code == 200 and duplicate.json()["id"] == accepted.json()["id"]
        assert client.post("/chat/api/image-jobs", json={**body, "prompt": "different"}, headers=headers(first)).status_code == 409
        assert client.get(path, headers=headers(second)).status_code == 404
        assert client.get(path + "/result", headers=headers(second)).status_code == 404
        assert client.get(path + "/result", headers=headers(first)).status_code == 409
        assert client.get(path, headers=headers(first)).json()["has_result"] is False
        release.set()
        wait_until(lambda: client.get(path, headers=headers(first)).json()["status"] == "completed")
        assert client.get(path + "/result", headers=headers(first)).json() == RESULT
        owner = first["user"]["id"]
        store.accounts.set_permissions(owner, {"chat_api": True, "image_api": False, "cloud_sync": True})
        rejected = client.post("/chat/api/image-jobs", json=body, headers=headers(first))
        assert rejected.status_code == 403 and rejected.json()["error"]["code"] == "image_ineligible"
        assert client.get(path, headers=headers(first)).json()["status"] == "completed"
        assert client.get(path + "/result", headers=headers(first)).json() == RESULT
        assert client.post(path + "/cancel", headers=headers(first)).json()["status"] == "completed"
        assert client.get(path + "/result", headers=headers(first)).status_code == 200
        assert len(dispatched) == 1 and calls(store) == [{"kind": "image", "status": "success"}]
        assert store.quota(owner)["user_weekly_remaining"] == 19
        store.accounts.set_permissions(owner, {"chat_api": True, "image_api": True, "cloud_sync": True})
        with store.connection() as db:
            row = dict(db.execute("SELECT * FROM image_jobs").fetchone())
        assert body["prompt"] not in json.dumps(row) and "prompt" not in row
        assert len(row["prompt_hash"]) == 64
        result_path = directory / (row["id"] + ".json")
        assert result_path.is_file()
        now[0] += 86401
        assert client.get(path, headers=headers(first)).json()["status"] == "expired"
        assert client.get(path + "/result", headers=headers(first)).status_code == 410
        assert not result_path.exists()
        assert client.post("/chat/api/image-jobs", json=body, headers=headers(first)).json()["status"] == "expired"
        assert len(dispatched) == 1


@pytest.mark.parametrize("source_count", [1, 4])
def test_edit_upload_reuses_managed_job_recovery_and_dispatches_originals_once(owners, source_count, monkeypatch):
    store, first, second, directory = owners
    jobs = ImageJobs(store, directory)
    dispatched = []
    sources = [
        (b"\x89PNG\r\n\x1a\nfirst image\x80\r\n", "image/png", "png"),
        (b"\xff\xd8\xffsecond image", "image/jpeg", "jpg"),
        (b"RIFF\xff\xff\xff\xffWEBPthird image", "image/webp", "webp"),
        (b"\x89PNG\r\n\x1a\nfourth image", "image/png", "png"),
    ][:source_count]
    prompt = "把背景换成白色"
    key = "synthetic-stable-edit-id"
    job_path = "/chat/api/image-jobs"
    path = f"{job_path}/{key}"

    async def handler(request):
        envelope = f"Content-Type: {request.headers['Content-Type']}\r\n\r\n".encode("ascii")
        message = BytesParser(policy=policy.default).parsebytes(envelope + request.content)
        fields, images = {}, []
        for part in message.iter_parts():
            field_name = part.get_param("name", header="content-disposition")
            if part.get_filename():
                images.append((field_name, part))
            else:
                fields[field_name] = part
        dispatched.append((request, fields, images))
        if fields["prompt"].get_payload(decode=True) == b"unsupported":
            return httpx.Response(405, json={"error": "private upstream diagnostics"})
        return httpx.Response(200, json={"data": [{"b64_json": PNG}]})

    @asynccontextmanager
    async def lifespan(_app):
        await jobs.start()
        try:
            yield
        finally:
            await jobs.stop()

    app = FastAPI(lifespan=lifespan)
    app.include_router(build_chat_router(store, image_jobs=jobs,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        provider_loader=lambda: ChatProvider("https://api.deepseek.com", "deepseek-flash", "synthetic-key"),
        image_provider_loader=lambda: PROVIDER))
    data = {"client_request_id": key, "prompt": prompt}
    app.add_middleware(BoundedBodyMiddleware, max_bytes=65536)
    files = [("image", (f"local-name.{extension}", content, mime_type))
        for content, mime_type, extension in sources]
    account_headers = headers(first)

    with TestClient(app, base_url=ORIGIN) as client:
        def unreadable_body():
            yield b""
            raise AssertionError("Unauthenticated image upload body was read")

        assert client.post(job_path, content=unreadable_body(),
            headers={"Content-Type": "multipart/form-data; boundary=synthetic"}).status_code == 401
        assert client.post(job_path, data=data, files=files).status_code == 401
        assert client.post(job_path, data=data, files=files,
            headers={**account_headers, "Origin": "https://other.invalid"}).status_code == 403
        assert client.post(job_path, data=data, files=files[:1] * 5,
            headers=account_headers).json()["error"]["code"] == "image_edit_invalid"
        assert client.post(job_path, data=data, files={"image": ("invalid.gif", b"GIF89a!", "image/gif")},
            headers=account_headers).status_code == 415
        assert client.post(job_path, data=data, files=files,
            headers={**account_headers, "Content-Length": str(MAX_IMAGE_EDIT_BODY + 1)}).status_code == 413
        with monkeypatch.context() as limits:
            limits.setattr("app.chat.MAX_IMAGE_BYTES", len(sources[0][0]) - 1)
            oversized = client.post(job_path, data=data, files=files[:1], headers=account_headers)
            assert oversized.status_code == 413 and "12 MiB" in oversized.json()["error"]["message"]
        with monkeypatch.context() as limits:
            limits.setattr("app.chat.MAX_IMAGE_EDIT_TOTAL", len(sources[0][0]) * 2 - 1)
            oversized = client.post(job_path, data=data, files=files[:1] * 2, headers=account_headers)
            assert oversized.status_code == 413 and "24 MiB" in oversized.json()["error"]["message"]
        assert not dispatched and not calls(store)

        accepted = client.post(job_path, data=data, files=files, headers=account_headers)
        assert accepted.status_code == 202
        duplicate = client.post(job_path, data=data, files=files, headers=account_headers)
        assert duplicate.status_code == 200 and duplicate.json()["id"] == accepted.json()["id"]
        assert client.post(job_path, json=data, headers=account_headers).status_code == 409
        if source_count > 1:
            assert client.post(job_path, data=data, files=list(reversed(files)), headers=account_headers).status_code == 409
            assert client.post(job_path, data=data, files=files[:1], headers=account_headers).status_code == 409
        assert client.post(job_path, data=data,
            files=[("image", ("different.png", sources[0][0] + b"diff", "image/png")), *files[1:]],
            headers=account_headers).status_code == 409
        wait_until(lambda: client.get(path, headers=account_headers).json()["status"] == "completed")
        assert client.get(path + "/result", headers=account_headers).json() == RESULT
        assert client.get(path + "/result", headers=headers(second)).status_code == 404
        assert len(dispatched) == 1 and calls(store) == [{"kind": "image", "status": "success"}]
        request, fields, images = dispatched[0]
        assert request.url.path == "/v1/images/edits" and set(fields) == {"prompt", "model", "n"}
        assert len(images) == source_count
        for index, ((field_name, part), (content, mime_type, extension)) in enumerate(zip(images, sources), 1):
            assert field_name == ("image" if source_count == 1 else "image[]")
            assert part.get_filename() == (f"source.{extension}" if source_count == 1 else f"source-{index}.{extension}")
            assert part.get_content_type() == mime_type and part.get_payload(decode=True) == content
        assert fields["prompt"].get_payload(decode=True).decode("utf-8") == prompt
        assert fields["model"].get_payload(decode=True).decode("utf-8") == PROVIDER.model
        assert fields["n"].get_payload(decode=True) == b"1"
        with store.connection() as db:
            row = dict(db.execute("SELECT * FROM image_jobs").fetchone())
        if source_count == 1:
            old_digest = hashlib.sha256(hashlib.sha256(prompt.encode("utf-8")).digest() + sources[0][0])
            assert row["prompt_hash"] == "edit:" + old_digest.hexdigest()
        else:
            assert row["prompt_hash"].startswith("edit-multi:")
        assert prompt not in json.dumps(row, ensure_ascii=False)
        artifact = directory / (row["id"] + ".json")
        assert json.loads(artifact.read_bytes()) == RESULT
        assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 19

        rejected_key = "synthetic-edit-unsupported"
        rejected = client.post(job_path, data={"client_request_id": rejected_key, "prompt": "unsupported"},
            files=files, headers=account_headers)
        assert rejected.status_code == 202
        rejected_path = f"{job_path}/{rejected_key}"
        wait_until(lambda: client.get(rejected_path, headers=account_headers).json()["status"] == "failed")
        failure = client.get(rejected_path, headers=account_headers).json()["error"]
        assert failure["code"] == "image_edit_unsupported" and "private upstream diagnostics" not in failure["message"]
        assert len(dispatched) == 2 and all(request.url.path == "/v1/images/edits" for request, *_parts in dispatched)
        assert store.quota(first["user"]["id"])["user_weekly_remaining"] == 18


def test_cancel_before_create_and_completion_commit_race_keep_result(owners):
    store, first, _second, directory = owners
    generated = []
    committed, release = threading.Event(), threading.Event()

    async def probe():
        async def generator(_token, _owner, _provider, prompt):
            generated.append(prompt)
            return RESULT

        jobs = ImageJobs(store, directory, generator=generator)
        await jobs.start()
        try:
            cancelled = await jobs.cancel(first["user"]["id"], "synthetic-cancel-before-create")
            assert cancelled["status"] == "cancelled"
            previous, created = await jobs.create(first["user"]["id"], "synthetic-cancel-before-create",
                "arrived later", first["token"], PROVIDER)
            assert not created and previous["status"] == "cancelled" and not generated
            original = jobs._complete

            def complete_then_hold(*args):
                changed = original(*args)
                committed.set()
                assert release.wait(3)
                return changed

            jobs._complete = complete_then_hold
            accepted, _created = await jobs.create(first["user"]["id"], "synthetic-complete-race", "finish", first["token"], PROVIDER)
            assert await asyncio.to_thread(committed.wait, 3)
            # Completion is committed, while _run still awaits that DB thread.
            cancelled = await jobs.cancel(first["user"]["id"], "synthetic-complete-race")
            assert cancelled["status"] == "completed"
            release.set()
            await asyncio.gather(*list(jobs._tasks.values()))
            assert await jobs.result(first["user"]["id"], "synthetic-complete-race") == RESULT
            assert (directory / (accepted["id"] + ".json")).is_file()
            assert generated == ["finish"]
        finally:
            release.set()
            await jobs.stop()

    asyncio.run(probe())


def test_service_restart_retains_completed_result_and_never_replays_pending_identity(owners):
    store, first, _second, directory = owners
    generated = []

    async def probe():
        entered = asyncio.Event()

        async def generator(_token, _owner, _provider, prompt):
            generated.append(prompt)
            if prompt == "pending":
                entered.set()
                await asyncio.Future()
            return RESULT

        jobs = ImageJobs(store, directory, generator=generator)
        await jobs.start()
        await jobs.create(first["user"]["id"], "synthetic-completed", "completed", first["token"], PROVIDER)
        await asyncio.gather(*list(jobs._tasks.values()))
        await jobs.create(first["user"]["id"], "synthetic-pending", "pending", first["token"], PROVIDER)
        await entered.wait()
        await jobs.stop()
        # Represent an abrupt shutdown that left active durable state behind.
        with store.connection(write=True) as db:
            db.execute("UPDATE image_jobs SET status='running' WHERE client_request_id='synthetic-pending'")
        restored = ImageJobs(store, directory, generator=generator)
        await restored.start()
        try:
            assert await restored.result(first["user"]["id"], "synthetic-completed") == RESULT
            recovered = await restored.get(first["user"]["id"], "synthetic-pending")
            assert recovered["status"] == "unknown" and recovered["error"]["code"] == "image_job_interrupted"
            existing, created = await restored.create(first["user"]["id"], "synthetic-pending", "pending", first["token"], PROVIDER)
            assert not created and existing["status"] == "unknown"
            assert generated == ["completed", "pending"] and not restored._tasks
            with pytest.raises(ImageJobError) as error:
                await restored.result(first["user"]["id"], "synthetic-pending")
            assert error.value.status == 409
        finally:
            await restored.stop()

    asyncio.run(probe())


def test_lost_creation_confirmation_schedules_once_and_running_cancel_is_durable(owners):
    store, first, _second, directory = owners
    committed, release = threading.Event(), threading.Event()
    generated = []

    async def probe():
        entered = asyncio.Event()

        async def generator(_token, _owner, _provider, prompt):
            generated.append(prompt)
            entered.set()
            await asyncio.Future()

        jobs = ImageJobs(store, directory, generator=generator)
        await jobs.start()
        try:
            original = jobs._create

            def accepted_then_hold(*args):
                result = original(*args)
                committed.set()
                assert release.wait(3)
                return result

            jobs._create = accepted_then_hold
            creation = asyncio.create_task(jobs.create(first["user"]["id"], "synthetic-lost-confirmation",
                "one dispatch", first["token"], PROVIDER))
            assert await asyncio.to_thread(committed.wait, 3)
            creation.cancel()
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await creation
            await entered.wait()
            duplicate, created = await jobs.create(first["user"]["id"], "synthetic-lost-confirmation",
                "one dispatch", first["token"], PROVIDER)
            assert not created and duplicate["status"] == "running" and generated == ["one dispatch"]
            cancelled = await jobs.cancel(first["user"]["id"], "synthetic-lost-confirmation")
            assert cancelled["status"] == "cancelled"
            await asyncio.gather(*list(jobs._tasks.values()), return_exceptions=True)
            assert (await jobs.get(first["user"]["id"], "synthetic-lost-confirmation"))["status"] == "cancelled"
            assert not list(directory.glob("*.json"))
            assert not generated[1:]
        finally:
            release.set()
            await jobs.stop()

    asyncio.run(probe())
