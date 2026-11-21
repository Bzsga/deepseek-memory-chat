"""Global feature access uses synthetic accounts and no upstream calls."""

import hashlib

import pytest
from fastapi.testclient import TestClient

from account_fixtures import legacy_personal_account, managed_account
from app.chat import ChatError
from app.config import Settings
from app.conversation_sync import ConversationSync
from app.main import create_app
from app.store import ServiceError, Store, digest


CLOSED = {"chat_api": False, "image_api": False, "cloud_sync": False}


@pytest.fixture
def setup(tmp_path):
    settings = Settings(db_path=str(tmp_path / "open-permissions.sqlite3"), worker_enabled=False,
                        api_enabled=True, api_key="synthetic-key", weekly_limit=30, user_weekly_limit=10)
    app = create_app(settings)
    with TestClient(app) as client:
        yield app.state.store, client


def test_grants_apply_to_existing_sessions_and_dispatch_without_changing_account_flags(setup):
    store, client = setup
    personal = legacy_personal_account(store)
    granted = managed_account(store)
    owner, token = personal["user"]["id"], personal["token"]
    headers = {"Authorization": "Bearer " + token}
    assert store.get_open_permissions() == CLOSED
    assert client.get("/v1/accounts/me", headers=headers).json()["user"]["permissions"] == CLOSED

    image_only = {**CLOSED, "image_api": True}
    assert store.set_open_permissions(image_only) == image_only
    current = client.get("/v1/accounts/me", headers=headers).json()
    assert current["user"]["permissions"] == current["quota"]["permissions"] == image_only
    assert current["user"]["invite_redeemable"] is True
    assert current["quota"]["user_weekly_limit"] == 10
    with pytest.raises(ServiceError) as blocked:
        store.begin_chat_call(owner, "chat", digest(token))
    assert blocked.value.code == "managed_ineligible"
    assert store.begin_chat_call(owner, "image", digest(token))

    chat_only = {**CLOSED, "chat_api": True}
    store.set_open_permissions(chat_only)
    assert store.begin_chat_call(owner, "chat", digest(token))
    with pytest.raises(ServiceError) as blocked:
        store.begin_chat_call(owner, "image", digest(token))
    assert blocked.value.code == "image_ineligible"
    payload = {"idempotency_key": "synthetic-open-organize", "messages": [
        {"id": "source", "role": "user", "content": "Synthetic original text"},
    ]}
    queued = client.post("/v1/jobs", headers=headers, json=payload)
    assert queued.status_code == 200, queued.text
    assert Store(store.settings).get_open_permissions() == chat_only

    store.set_open_permissions(CLOSED)
    assert store.claim_next() is None
    assert store.get_job(owner, queued.json()["id"])["status"] == "failed"
    current = client.get("/v1/accounts/me", headers=headers).json()
    assert current["user"]["permissions"] == current["quota"]["permissions"] == CLOSED
    assert current["quota"]["user_weekly_used"] == 2
    assert store.accounts.me(granted["user"]["id"])["user"]["permissions"] == dict.fromkeys(CLOSED, True)
    with store.connection() as db:
        raw = db.execute(
            "SELECT managed_eligible,chat_api,image_api,cloud_sync FROM registered_accounts WHERE user_id=?",
            (owner,),
        ).fetchone()
    assert tuple(raw) == (0, None, None, None)


def test_global_cloud_revocation_pauses_only_global_users_and_retains_data(setup):
    store, _client = setup
    sync = ConversationSync(store)
    kept = managed_account(store)["user"]["id"]
    revoked = managed_account(store)["user"]["id"]
    paused = legacy_personal_account(store)["user"]["id"]
    disabled = legacy_personal_account(store)["user"]["id"]
    cloud_only = {**CLOSED, "cloud_sync": True}
    assert store.set_open_permissions(cloud_only) == cloud_only
    assert sync.status(paused)["enabled"] is False

    for owner in (kept, revoked, disabled):
        assert sync.configure(owner, {"enabled": True, "expected_generation": 0})["generation"] == 1
    data = b"synthetic preserved attachment"
    checksum = hashlib.sha256(data).hexdigest()
    sync.upload(revoked, checksum, 1, data)
    store.accounts.set_permissions(revoked, CLOSED)
    sync.initialize()
    assert sync.blob(revoked, checksum, 1) == data
    store.accounts.set_enabled(disabled, False)

    store.set_open_permissions(CLOSED)
    assert sync.status(kept)["enabled"] is True
    assert sync.status(kept)["generation"] == 1
    assert sync.status(paused)["generation"] == 0
    revoked_status = sync.status(revoked)
    assert (revoked_status["eligible"], revoked_status["enabled"], revoked_status["generation"]) == (False, False, 2)
    with pytest.raises(ChatError) as denied:
        sync.blob(revoked, checksum, 1)
    assert denied.value.code == "sync_invitation_required"
    with store.connection() as db:
        disabled_sync_generation = db.execute(
            "SELECT generation FROM conversation_sync_settings WHERE owner_id=?", (disabled,),
        ).fetchone()[0]
    assert disabled_sync_generation == 1
    store.accounts.set_enabled(disabled, True)
    assert sync.status(disabled)["enabled"] is False
    assert sync.status(disabled)["generation"] == 2

    assert store.set_open_permissions(CLOSED) == CLOSED
    assert sync.status(revoked)["generation"] == 2
    store.set_open_permissions(cloud_only)
    assert sync.status(revoked)["enabled"] is False
    assert sync.configure(revoked, {"enabled": True, "expected_generation": 2})["generation"] == 3
    assert sync.blob(revoked, checksum, 3) == data


def test_basic_signup_retains_sync_eligibility_through_invitation_and_restart(setup):
    store, client = setup
    sync = ConversationSync(store)
    cloud_only = {**CLOSED, "cloud_sync": True}
    previous = legacy_personal_account(store)["user"]["id"]
    assert sync.status(previous)["eligible"] is False
    policy = client.get("/v1/accounts/registration")
    assert policy.json() == {"self_service": True}
    assert policy.headers["cache-control"] == "no-store"
    registration = "/v1/accounts/register"
    fields = {"username": "basic_sync", "password": "synthetic password"}
    bad_code = {**fields, "invitation_code": "synthetic-invalid-code"}
    assert client.post(registration, json=bad_code).status_code == 400
    created = client.post(registration, json=fields)
    assert created.status_code == 200
    account = created.json()
    owner = account["user"]["id"]
    assert account["user"]["registration_kind"] == "public"
    assert account["user"]["permissions"] == account["quota"]["permissions"] == cloud_only
    assert account["user"]["invite_redeemable"]
    assert account["quota"]["user_weekly_remaining"] == 0
    assert sync.status(owner)["eligible"] and not sync.status(owner)["enabled"]
    assert sync.configure(owner, {"enabled": True, "expected_generation": 0})["generation"] == 1
    store.set_open_permissions(cloud_only)
    store.set_open_permissions(CLOSED)
    sync.initialize()
    assert sync.status(owner)["enabled"]
    code = store.accounts.create_invites(1, 7, permissions={**CLOSED, "chat_api": True})["invitations"][0]["code"]
    invited = store.accounts.redeem_invite(owner, code)
    assert invited["user"]["permissions"] == {**cloud_only, "chat_api": True}
    assert sync.status(owner)["enabled"]
    store.accounts.set_permissions(owner, CLOSED)
    state = sync.status(owner)
    assert (state["eligible"], state["enabled"], state["generation"]) == (False, False, 2)
