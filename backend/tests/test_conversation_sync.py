"""Private-sync tests use synthetic account data and no upstream requests."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import copy
import hashlib
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from starlette.requests import Request

from account_fixtures import legacy_personal_account, managed_account
from app import conversation_sync as module
from app.chat import ChatError
from app.config import Settings
from app.conversation_sync import ConversationSync, build_conversation_sync_router
from app.store import Store, digest


ORIGIN = "https://digimonlegend.com"
API = "/chat/api/conversation-sync"
RAW = b"synthetic attachment\x00\xff"
CHECKSUM = hashlib.sha256(RAW).hexdigest()
ALL_SCOPES = {"conversations": True, "preferences": True, "attachments": True}


def headers(account):
    return {"Authorization": "Bearer " + account["token"], "Origin": ORIGIN,
            "X-Chat-User-Id": account["user"]["id"]}


def invite(store, account):
    code = store.accounts.create_invites(1, 7)["invitations"][0]["code"]
    return {**account, **store.accounts.redeem_invite(account["user"]["id"], code)}


def payload(*, revision=0, mutation="synthetic-mutation", generation=1, files=False, text="original text"):
    return {"generation": generation, "expected_revision": revision, "mutation_id": mutation,
            "snapshot": {"version": 1, "title": "合成私有会话", "messages": [{"id": "stable-user", "text": text}],
                         "branches": ["stable-user", "other-branch"], "memory": {"source": "stable-user"}},
            "files": [{"id": "local-file", "sha256": CHECKSUM, "size": len(RAW), "mime_type": "text/plain"}] if files else []}


@pytest.fixture
def setup(tmp_path):
    store = Store(Settings(db_path=str(tmp_path / "private-sync.sqlite3"), worker_enabled=False,
                           api_enabled=True, api_key="synthetic-key", weekly_limit=100, user_weekly_limit=20))
    store.initialize()
    account = managed_account(store, "synthetic_sync")
    sync = ConversationSync(store)
    sync.initialize()
    app = FastAPI()
    app.include_router(build_conversation_sync_router(store, sync))
    with TestClient(app, base_url=ORIGIN) as client:
        yield store, account, sync, client


def enable(client, account, *, generation=0):
    response = client.patch(API, json={"enabled": True, "expected_generation": generation}, headers=headers(account))
    assert response.status_code == 200, response.text
    return response.json()


def write(client, account, value=None, session="synthetic-session"):
    response = client.put(API + "/sessions/" + session, json=value or payload(), headers=headers(account))
    assert response.status_code == 200, response.text
    return response.json()


def upload(client, account, generation=1):
    response = client.put(API + "/blobs/" + CHECKSUM + f"?generation={generation}", content=RAW, headers=headers(account))
    assert response.status_code == 200, response.text
    return response.json()


def assert_no_usage(store, account):
    assert store.quota(account["user"]["id"])["user_weekly_remaining"] == account["quota"]["user_weekly_remaining"]
    with store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM chat_calls").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM provider_attempts").fetchone()[0] == 0


def test_default_closed_and_account_metadata_only(setup):
    store, account, _sync, client = setup
    response = client.get(API, headers=headers(account))
    assert response.json() == {"enabled": False, "generation": 0, "sequence": 0, "eligible": True,
                               "scopes": ALL_SCOPES}
    assert response.headers["cache-control"] == "no-store"
    targets = [("get", "/index?generation=0", None),
               ("get", "/sessions/synthetic-session?generation=0", None),
               ("get", "/blobs/" + CHECKSUM + "?generation=0", None),
               ("put", "/sessions/synthetic-session", payload(generation=0))]
    for method, path, value in targets:
        response = client.request(method, API + path, json=value, headers=headers(account))
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "sync_disabled"
    blocked_blob = client.put(API + "/blobs/" + CHECKSUM + "?generation=0", content=RAW, headers=headers(account))
    assert blocked_blob.status_code == 409
    with store.connection() as db:
        for table in ("settings", "sessions", "blobs", "files", "mutations"):
            assert db.execute("SELECT COUNT(*) FROM conversation_sync_" + table).fetchone()[0] == 0
    assert_no_usage(store, account)


def test_private_access_origin_identity_and_session(setup):
    store, account, _sync, client = setup
    for method in ("GET", "PATCH", "DELETE"):
        assert client.request(method, API).status_code == 401
    assert client.get(API, headers={**headers(account), "Origin": "https://other.invalid"}).status_code == 403
    assert client.get(API, headers={**headers(account), "X-Chat-User-Id": "other"}).status_code == 409
    cookie = {"Cookie": "deepseek_session=" + account["token"], "X-Chat-User-Id": account["user"]["id"]}
    assert client.get(API, headers=cookie).json()["enabled"] is False
    assert client.get(API, headers={**cookie, "Sec-Fetch-Site": "cross-site"}).status_code == 403
    enable(client, account)
    upload(client, account)
    own = write(client, account, payload(files=True))
    other = managed_account(store, "synthetic_second")
    enable(client, other)
    assert client.get(API + "/sessions/" + own["id"] + "?generation=1", headers=headers(other)).status_code == 404
    assert client.get(API + "/blobs/" + CHECKSUM + "?generation=1", headers=headers(other)).status_code == 404
    assert client.get(API + "/index?generation=1", headers=headers(other)).json()["entries"] == []
    store.accounts.logout(account["token"])
    assert client.get(API, headers=headers(account)).status_code == 401
    assert_no_usage(store, other)


def test_pause_retains_copies_reenable_and_clear_erases_every_owner_payload(setup):
    store, account, sync, client = setup
    assert enable(client, account) == {"enabled": True, "generation": 1, "sequence": 0, "eligible": True,
                                       "scopes": ALL_SCOPES}
    assert enable(client, account, generation=1)["generation"] == 1
    upload(client, account)
    original = write(client, account, payload(files=True))
    paused = client.patch(API, json={"enabled": False, "expected_generation": 1}, headers=headers(account)).json()
    assert paused == {"enabled": False, "generation": 2, "sequence": 1, "eligible": True, "scopes": ALL_SCOPES}
    for generation, code in ((1, "sync_generation_changed"), (2, "sync_disabled")):
        result = client.get(API + f"/sessions/synthetic-session?generation={generation}", headers=headers(account))
        assert result.status_code == 409 and result.json()["error"]["code"] == code
    stale_toggle = client.patch(API, json={"enabled": True, "expected_generation": 1}, headers=headers(account))
    assert stale_toggle.status_code == 409
    enable(client, account, generation=2)
    recovered = client.get(API + "/sessions/synthetic-session?generation=3", headers=headers(account)).json()
    assert recovered["snapshot"] == original["snapshot"] and recovered["files"] == original["files"]
    cleared = client.request("DELETE", API, json={"expected_generation": 3}, headers=headers(account))
    assert cleared.json() == {"enabled": False, "generation": 4, "sequence": 1, "eligible": True, "scopes": ALL_SCOPES}
    with store.connection() as db:
        for table in ("sessions", "blobs", "files", "mutations"):
            assert db.execute("SELECT COUNT(*) FROM conversation_sync_" + table).fetchone()[0] == 0
    enable(client, account, generation=4)
    assert sync.index(account["user"]["id"], 5, 0)["entries"] == []
    next_write = write(client, account, payload(generation=5, mutation="next-after-clear"))
    assert next_write["revision"] == 2
    assert_no_usage(store, account)


def test_invitation_required_and_revocation_resets_consent_but_allows_clear(setup):
    store, _eligible, _, client = setup
    account = legacy_personal_account(store, "no_invite")
    auth = headers(account)
    owner = account["user"]["id"]

    assert client.get(API, headers=auth).json() == {"enabled": False, "generation": 0, "sequence": 0, "eligible": False,
                                                   "scopes": ALL_SCOPES}
    blocked = client.patch(API, json={"enabled": True, "expected_generation": 0}, headers=auth)
    assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "sync_invitation_required"
    invite(store, account)
    enable(client, account)
    upload(client, account)
    original = write(client, account, payload(files=True))

    store.accounts.revoke_managed(owner)
    assert store.accounts.authenticate(account["token"]) == owner
    paused = {"enabled": False, "generation": 2, "sequence": 1, "eligible": False, "scopes": ALL_SCOPES}
    assert client.get(API, headers=auth).json() == paused
    assert client.patch(API, json={"enabled": False, "expected_generation": 2}, headers=auth).json() == paused
    for route in ("/index", "/sessions/synthetic-session", "/blobs/" + CHECKSUM, "/preferences", "/key-envelope"):
        blocked = client.get(API + route + "?generation=2", headers=auth)
        assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "sync_invitation_required"
    blocked = client.put(API + "/sessions/synthetic-session", json=payload(generation=2), headers=auth)
    assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "sync_invitation_required"

    invite(store, account)
    assert client.get(API, headers=auth).json() == {**paused, "eligible": True}
    enable(client, account, generation=2)
    recovered = client.get(API + "/sessions/synthetic-session?generation=3", headers=auth).json()
    assert recovered["snapshot"] == original["snapshot"] and recovered["files"] == original["files"]

    store.accounts.revoke_managed(owner)
    cleared = client.request("DELETE", API, json={"expected_generation": 4}, headers=auth)
    assert cleared.json() == {**paused, "generation": 5}
    with store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM conversation_sync_sessions WHERE owner_id=?", (owner,)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM conversation_sync_blobs WHERE owner_id=?", (owner,)).fetchone()[0] == 0


def test_initialize_pauses_pre_invitation_consents_once(setup):
    store, account, sync, client = setup
    enable(client, account)
    write(client, account)
    owner = account["user"]["id"]
    with store.connection(write=True) as db:
        db.execute("DROP TRIGGER sync_pause_on_cloud_revocation")
        db.execute("""CREATE TRIGGER sync_pause_on_invitation_revocation
            AFTER UPDATE OF managed_eligible ON registered_accounts
            WHEN OLD.managed_eligible=1 AND NEW.managed_eligible=0 BEGIN
                UPDATE conversation_sync_settings SET enabled=0,generation=generation+1
                WHERE owner_id=NEW.user_id AND enabled=1;
            END""")
    store.accounts.set_permissions(owner, {"chat_api": True, "image_api": True, "cloud_sync": False})
    sync.initialize()
    sync.initialize()
    assert client.get(API, headers=headers(account)).json() == {
        "enabled": False, "generation": 2, "sequence": 1, "eligible": False, "scopes": ALL_SCOPES,
    }
    with store.connection() as db:
        assert db.execute("SELECT 1 FROM sqlite_master WHERE name='sync_pause_on_invitation_revocation'").fetchone() is None
        assert db.execute("SELECT COUNT(*) FROM conversation_sync_sessions WHERE owner_id=?", (owner,)).fetchone()[0] == 1


def test_cloud_sync_permissions_are_independent_and_revocation_requires_new_consent(setup):
    store, account, _, client = setup
    owner = account["user"]["id"]
    auth = headers(account)
    sync_only = {"chat_api": False, "image_api": False, "cloud_sync": True}
    store.accounts.set_permissions(owner, sync_only)
    enable(client, account)
    original = write(client, account)
    store.accounts.set_permissions(owner, {**sync_only, "chat_api": True})
    assert client.get(API, headers=auth).json()["generation"] == 1
    store.accounts.set_permissions(owner, {**sync_only, "cloud_sync": False, "image_api": True})
    paused = {"enabled": False, "generation": 2, "sequence": 1, "eligible": False, "scopes": ALL_SCOPES}
    assert client.get(API, headers=auth).json() == paused
    assert client.get(API + "/index?generation=2", headers=auth).status_code == 403
    store.accounts.set_permissions(owner, sync_only)
    assert client.get(API, headers=auth).json() == {**paused, "eligible": True}
    assert client.get(API + "/index?generation=2", headers=auth).status_code == 409
    enable(client, account, generation=2)
    restored = client.get(API + "/sessions/synthetic-session?generation=3", headers=auth).json()
    assert restored["snapshot"] == original["snapshot"]
    store.accounts.set_permissions(owner, {**sync_only, "cloud_sync": False, "image_api": True})
    assert client.request("DELETE", API, json={"expected_generation": 4}, headers=auth).status_code == 200
    assert_no_usage(store, account)


def test_scope_changes_block_each_category_and_preserve_copies_until_cleared(setup):
    store, account, _sync, client = setup
    auth = headers(account)
    only_preferences = {"conversations": False, "preferences": True}
    only_conversations = {"conversations": True, "preferences": False}
    session = "/sessions/synthetic-session"
    attachment = "/blobs/" + CHECKSUM
    preference_data = {"themePreference": "dark"}
    enable(client, account)
    upload(client, account)
    original = write(client, account, payload(files=True))

    preference_only = client.patch(API, headers=auth, json={
        "enabled": True, "expected_generation": 1, "scopes": only_preferences,
    })
    assert preference_only.json() == {"enabled": True, "generation": 2, "sequence": 1,
                                      "eligible": True, "scopes": {**only_preferences, "attachments": True}}
    assert enable(client, account, generation=2) == preference_only.json()
    stale = client.patch(API, headers=auth, json={
        "enabled": True, "expected_generation": 1, "scopes": only_conversations,
    })
    assert (stale.status_code, stale.json()["error"]["code"]) == (409, "sync_generation_changed")
    stale_read = client.get(API + session + "?generation=1", headers=auth)
    assert (stale_read.status_code, stale_read.json()["error"]["code"]) == (409, "sync_generation_changed")
    forbidden = [
        client.get(API + suffix + "?generation=2", headers=auth) for suffix in ("/index", session, attachment)
    ] + [
        client.put(API + session, json=payload(generation=2), headers=auth),
        client.request("DELETE", API + session, headers=auth,
                       json={"generation": 2, "expected_revision": 1, "mutation_id": "scope-delete"}),
        client.put(API + attachment + "?generation=2", content=RAW, headers=auth),
    ]
    for response in forbidden:
        assert (response.status_code, response.json()["error"]["code"]) == (409, "sync_scope_disabled")
    saved_preference = client.put(API + "/preferences", headers=auth, json={
        "generation": 2, "expected_revision": 0, "value": preference_data,
    })
    assert saved_preference.json() == {"generation": 2, "revision": 1, "value": preference_data}

    conversation_only = client.patch(API, headers=auth, json={
        "enabled": True, "expected_generation": 2, "scopes": only_conversations,
    })
    assert conversation_only.json()["generation"] == 3
    assert client.get(API + session + "?generation=3", headers=auth).json() == {**original, "generation": 3}
    assert client.get(API + attachment + "?generation=3", headers=auth).content == RAW
    for response in (
        client.get(API + "/preferences?generation=3", headers=auth),
        client.put(API + "/preferences", headers=auth,
                   json={"generation": 3, "expected_revision": 1, "value": {"themePreference": "light"}}),
    ):
        assert (response.status_code, response.json()["error"]["code"]) == (409, "sync_scope_disabled")
    assert client.get(API + "/key-envelope?generation=3", headers=auth).json()["value"] is None

    paused = client.patch(API, headers=auth, json={"enabled": False, "expected_generation": 3})
    assert paused.json()["scopes"] == {**only_conversations, "attachments": True}
    assert enable(client, account, generation=4)["scopes"] == {**only_conversations, "attachments": True}
    restored = client.patch(API, headers=auth, json={
        "enabled": True, "expected_generation": 5, "scopes": ALL_SCOPES,
    })
    assert restored.json()["generation"] == 6
    assert client.get(API + "/preferences?generation=6", headers=auth).json()["value"] == preference_data
    restricted = client.patch(API, headers=auth, json={
        "enabled": True, "expected_generation": 6, "scopes": only_conversations,
    })
    assert restricted.json()["generation"] == 7
    cleared = client.request("DELETE", API, headers=auth, json={"expected_generation": 7})
    assert cleared.json()["scopes"] == {**only_conversations, "attachments": True}
    with store.connection() as db:
        for table in ("sessions", "blobs", "documents"):
            assert db.execute(f"SELECT COUNT(*) FROM conversation_sync_{table}").fetchone()[0] == 0
    assert_no_usage(store, account)


def test_attachment_consent_pauses_transfers_without_losing_existing_originals(setup):
    store, account, sync, client = setup
    auth = headers(account)
    owner = account["user"]["id"]
    session_id = "synthetic-session"
    session = API + "/sessions/" + session_id
    attachment = API + "/blobs/" + CHECKSUM

    assert enable(client, account)["scopes"] == ALL_SCOPES
    # Simulate pre-upgrade storage, then reopen twice to exercise the additive table.
    with store.connection(write=True) as db:
        db.execute("DROP TABLE conversation_sync_attachment_scopes")
        db.execute("INSERT INTO conversation_sync_scopes VALUES(?,?,?)", (owner, 1, 0))
    sync.initialize()
    sync.initialize()
    state = client.get(API, headers=auth).json()
    assert state["scopes"] == {**ALL_SCOPES, "preferences": False}
    assert (state["enabled"], state["generation"]) == (True, 1)

    upload(client, account)
    first = payload(files=True)
    first["files"].append({**first["files"][0], "id": "reply-image", "mime_type": "image/png"})
    first["snapshot"] = {"version": 1, "session": {"id": session_id, "messages": [
        {"id": "stable-user", "role": "user", "content": "用户原文", "files": [{"id": "local-file"}]},
        {"id": "stable-reply", "role": "assistant", "blocks": [{"type": "image", "id": "reply-image"}]},
    ]}}
    saved = write(client, account, first)
    text_only = {**state["scopes"], "attachments": False}
    paused = client.patch(API, headers=auth, json={
        "enabled": True, "expected_generation": 1, "scopes": text_only,
    })
    assert paused.status_code == 200 and paused.json()["scopes"] == text_only
    assert paused.json()["generation"] == 2
    # The previous server build can still write its positional settings row after rollback.
    with store.connection(write=True) as db:
        db.execute("""INSERT INTO conversation_sync_scopes VALUES(?,?,?)
            ON CONFLICT(owner_id) DO UPDATE SET
            conversations=excluded.conversations,preferences=excluded.preferences""", (owner, 1, 0))
    assert client.get(API, headers=auth).json()["scopes"] == text_only

    hidden = client.get(session + "?generation=2", headers=auth).json()
    assert hidden["snapshot"] == saved["snapshot"]
    assert hidden["files"] == []
    for response in (
        client.get(attachment + "?generation=2", headers=auth),
        client.put(attachment + "?generation=2", headers=auth, content=RAW),
        client.put(session, headers=auth, json={**first, "generation": 2, "expected_revision": saved["revision"]}),
    ):
        assert (response.status_code, response.json()["error"]["code"]) == (409, "sync_scope_disabled")

    edited = copy.deepcopy(first["snapshot"])
    edited["session"]["messages"][0]["content"] = "暂停附件同步时编辑正文"
    text_update = write(client, account, {
        **first, "generation": 2, "mutation_id": "edit-with-paused-attachments",
        "snapshot": edited, "files": [], "expected_revision": saved["revision"],
    })
    assert text_update["files"] == []
    assert text_update["snapshot"] == edited

    # An older settings client only sends two scopes, so it must leave the paused originals paused.
    legacy = client.patch(API, headers=auth, json={
        "enabled": True, "expected_generation": 2, "scopes": {"conversations": True, "preferences": False},
    })
    assert legacy.status_code == 200 and legacy.json()["scopes"] == text_only
    assert legacy.json()["generation"] == 2
    resumed = client.patch(API, headers=auth, json={
        "enabled": True, "expected_generation": 2, "scopes": state["scopes"],
    })
    assert resumed.status_code == 200 and resumed.json()["generation"] == 3
    restored = client.get(session + "?generation=3", headers=auth).json()
    assert restored["snapshot"] == edited
    assert restored["files"] == saved["files"]
    assert client.get(attachment + "?generation=3", headers=auth).content == RAW
    # A device that hasn't fetched the original yet may edit the text immediately after resuming.
    edited["session"]["messages"][0]["content"] = "恢复后本机原件仍未下载"
    text_update = write(client, account, {
        **first, "generation": 3, "mutation_id": "edit-before-downloading-originals",
        "snapshot": edited, "files": [], "expected_revision": restored["revision"],
    })
    assert text_update["files"] == saved["files"]
    assert_no_usage(store, account)


def test_unknown_result_replay_and_later_modification_return_conflict(setup):
    _store, account, _sync, client = setup
    enable(client, account)
    source = payload()
    first = write(client, account, source)
    assert write(client, account, source) == first
    altered = copy.deepcopy(source)
    altered["snapshot"]["title"] = "same mutation different body"
    response = client.put(API + "/sessions/synthetic-session", json=altered, headers=headers(account))
    assert response.status_code == 409 and response.json()["current_revision"] == 1
    newer = write(client, account, payload(revision=1, mutation="second-device", text="remote original"))
    assert newer["revision"] == 2
    replay = client.put(API + "/sessions/synthetic-session", json=source, headers=headers(account))
    assert replay.status_code == 409 and replay.json()["error"]["code"] == "sync_conflict"
    assert replay.json()["current_revision"] == 2
    assert client.get(API + "/sessions/synthetic-session?generation=1", headers=headers(account)).json() == newer


def test_two_writers_compare_and_swap_and_delete_tombstone_survives(setup):
    _store, account, sync, client = setup
    enable(client, account)
    owner = account["user"]["id"]
    token_hash = digest(account["token"])

    def attempt(number):
        try:
            return sync.mutate(owner, "same-session", payload(mutation=f"writer-{number}", text=str(number)), token_hash=token_hash)
        except ChatError as error:
            return error.status

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, (1, 2)))
    assert sum(isinstance(result, dict) for result in results) == 1 and results.count(409) == 1
    deleted = client.request("DELETE", API + "/sessions/same-session",
        json={"generation": 1, "expected_revision": 1, "mutation_id": "delete-on-device"}, headers=headers(account)).json()
    assert deleted["deleted"] is True and deleted["snapshot"] is None and deleted["files"] == []
    stale = client.put(API + "/sessions/same-session", json=payload(mutation="offline-stale"), headers=headers(account))
    assert stale.status_code == 409 and stale.json()["current_revision"] == 2
    entries = client.get(API + "/index?generation=1", headers=headers(account)).json()["entries"]
    assert entries == [{key: deleted[key] for key in ("id", "revision", "deleted", "content_hash")}]


def test_incremental_index_has_stable_pagination_and_new_revision(setup, monkeypatch):
    _store, account, _sync, client = setup
    monkeypatch.setattr(module, "PAGE_SIZE", 2)
    enable(client, account)
    for index in range(3):
        write(client, account, payload(mutation=f"new-{index}"), session=f"session-{index}")
    page = client.get(API + "/index?generation=1&after=0", headers=headers(account)).json()
    assert [item["revision"] for item in page["entries"]] == [1, 2]
    assert page["cursor"] == 2 and page["has_more"] is True
    second = client.get(API + "/index?generation=1&after=2", headers=headers(account)).json()
    assert [item["revision"] for item in second["entries"]] == [3] and second["has_more"] is False
    write(client, account, payload(revision=1, mutation="updated-first"), session="session-0")
    latest = client.get(API + "/index?generation=1&after=3", headers=headers(account)).json()
    assert latest["entries"][0]["id"] == "session-0" and latest["cursor"] == 4


def test_blob_hash_private_dedup_references_and_atomic_delete_gc(setup):
    store, account, _sync, client = setup
    enable(client, account)
    invalid = client.put(API + "/blobs/" + CHECKSUM + "?generation=1", content=b"incorrect", headers=headers(account))
    assert invalid.status_code == 422 and invalid.json()["error"]["code"] == "sync_blob_invalid"
    assert upload(client, account) == {"sha256": CHECKSUM, "size": len(RAW)}
    upload(client, account)
    first = write(client, account, payload(files=True))
    second = write(client, account, payload(files=True, mutation="second-file-reference"), session="second-session")
    response = client.get(API + "/blobs/" + CHECKSUM + "?generation=1", headers=headers(account))
    assert response.content == RAW and response.headers["content-type"] == "application/octet-stream"
    assert response.headers["x-content-type-options"] == "nosniff" and response.headers["cache-control"] == "no-store"
    with store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM conversation_sync_blobs").fetchone()[0] == 1
    for item in (first, second):
        result = client.request("DELETE", API + "/sessions/" + item["id"], json={"generation": 1,
            "expected_revision": item["revision"], "mutation_id": "delete-" + item["id"]}, headers=headers(account))
        assert result.status_code == 200
        blob = client.get(API + "/blobs/" + CHECKSUM + "?generation=1", headers=headers(account))
        assert blob.status_code == (200 if item is first else 404)
    assert_no_usage(store, account)


def test_missing_or_wrong_size_blob_cannot_commit_partial_session(setup):
    store, account, _sync, client = setup
    enable(client, account)
    request = payload(files=True)
    missing = client.put(API + "/sessions/synthetic-session", json=request, headers=headers(account))
    assert missing.status_code == 409 and missing.json()["error"]["code"] == "sync_blob_missing"
    upload(client, account)
    request["files"][0]["size"] += 1
    assert client.put(API + "/sessions/synthetic-session", json=request, headers=headers(account)).status_code == 409
    with store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM conversation_sync_sessions").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM conversation_sync_mutations").fetchone()[0] == 0
    assert client.get(API, headers=headers(account)).json()["sequence"] == 0


def test_capacity_counts_snapshots_and_blobs_with_atomic_failure(setup, monkeypatch):
    store, account, sync, client = setup
    enable(client, account)
    upload(client, account)
    first = write(client, account, payload(files=True))
    with store.connection() as db:
        used = sync._used_bytes(db, account["user"]["id"])
    monkeypatch.setattr(module, "MAX_ACCOUNT_BYTES", used)
    assert upload(client, account)["size"] == len(RAW)
    larger = payload(files=True, revision=1, mutation="large-update", text="longer than original text")
    response = client.put(API + "/sessions/synthetic-session", json=larger, headers=headers(account))
    assert response.status_code == 413 and response.json()["error"]["code"] == "sync_storage_full"
    assert client.get(API + "/sessions/synthetic-session?generation=1", headers=headers(account)).json() == first
    assert client.get(API, headers=headers(account)).json()["sequence"] == 1


def test_capacity_uses_resulting_state_after_releasing_replaced_files(setup, monkeypatch):
    store, account, sync, client = setup
    enable(client, account)
    upload(client, account)
    write(client, account, payload(files=True))
    with store.connection() as db:
        used = sync._used_bytes(db, account["user"]["id"])
    monkeypatch.setattr(module, "MAX_ACCOUNT_BYTES", used)
    updated = write(client, account, payload(revision=1, mutation="release-file", text="slightly larger original"))
    assert updated["revision"] == 2 and updated["files"] == []
    with store.connection() as db:
        assert sync._used_bytes(db, account["user"]["id"]) < used


def test_expired_orphans_are_reclaimed_before_snapshot_capacity_check(setup, monkeypatch):
    store, account, _sync, client = setup
    enable(client, account)
    upload(client, account)
    with store.connection(write=True) as db:
        db.execute("UPDATE conversation_sync_blobs SET touched_at=?", (time.time() - module.ORPHAN_TTL_SECONDS - 1,))
    monkeypatch.setattr(module, "MAX_ACCOUNT_BYTES", len(module._encoded(payload()["snapshot"])))
    saved = write(client, account)
    assert saved["revision"] == 1
    with store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM conversation_sync_blobs").fetchone()[0] == 0


def test_staged_upload_recovery_window_and_expired_orphan_cleanup(setup):
    store, account, sync, client = setup
    enable(client, account)
    upload(client, account)
    write(client, account)
    assert client.get(API + "/blobs/" + CHECKSUM + "?generation=1", headers=headers(account)).status_code == 200
    with store.connection(write=True) as db:
        db.execute("UPDATE conversation_sync_blobs SET touched_at=?", (time.time() - module.ORPHAN_TTL_SECONDS - 1,))
    sync.initialize()
    assert client.get(API + "/blobs/" + CHECKSUM + "?generation=1", headers=headers(account)).status_code == 404


def test_concurrent_read_keeps_snapshot_revision_and_file_manifest_together(setup, monkeypatch):
    _store, account, sync, client = setup
    enable(client, account)
    upload(client, account)
    before = write(client, account, payload(files=True))
    original = sync._dto
    pending = True

    def interleave(db, owner, row, generation, attachments):
        nonlocal pending
        if pending:
            pending = False
            sync.mutate(owner, "synthetic-session", payload(revision=1, mutation="concurrent-update", text="new body"))
        return original(db, owner, row, generation, attachments)

    monkeypatch.setattr(sync, "_dto", interleave)
    read = sync.read(account["user"]["id"], "synthetic-session", 1)
    assert read == before
    after = sync.read(account["user"]["id"], "synthetic-session", 1)
    assert after["revision"] == 2 and after["files"] == []
    assert after["snapshot"]["messages"][0]["text"] == "new body"


@pytest.mark.parametrize("raw", [b'{"enabled":true,"enabled":false,"expected_generation":0}',
    b'{"enabled":NaN,"expected_generation":0}', b'{"enabled":true,"expected_generation":true}',
    b'{"enabled":true,"expected_generation":0,"extra":1}', b'\xff', b'[]',
    b'{"enabled":true,"expected_generation":0,"scopes":null}',
    b'{"enabled":true,"expected_generation":0,"scopes":{"conversations":true}}',
    b'{"enabled":true,"expected_generation":0,"scopes":{"conversations":1,"preferences":true}}',
    b'{"enabled":true,"expected_generation":0,"scopes":{"conversations":true,"preferences":true,"attachments":1}}',
    b'{"enabled":true,"expected_generation":0,"scopes":{"conversations":false,"preferences":false,"attachments":true}}',
    b'{"enabled":true,"expected_generation":0,"scopes":{"conversations":false,"preferences":false}}'])
def test_invalid_control_payloads_do_not_change_consent(setup, raw):
    _store, account, _sync, client = setup
    result = client.patch(API, content=raw, headers=headers(account))
    assert result.status_code == 422 and result.headers["cache-control"] == "no-store"
    assert client.get(API, headers=headers(account)).json() == {"enabled": False, "generation": 0, "sequence": 0,
                                                               "eligible": True, "scopes": ALL_SCOPES}


def test_snapshot_depth_size_identity_and_file_manifest_validation(setup, monkeypatch):
    _store, account, _sync, client = setup
    enable(client, account)
    cases = []
    duplicated = payload(files=True)
    duplicated["files"] *= 2
    cases.append(duplicated)
    bad_mime = payload(files=True)
    bad_mime["files"][0]["mime_type"] = "text/plain\r\nX-Unsafe: yes"
    cases.append(bad_mime)
    malformed = payload()
    malformed["snapshot"] = []
    cases.append(malformed)
    deep = payload()
    value = deep["snapshot"]
    for _ in range(module.MAX_JSON_DEPTH + 1):
        value["nested"] = {}
        value = value["nested"]
    cases.append(deep)
    for case in cases:
        response = client.put(API + "/sessions/synthetic-session", json=case, headers=headers(account))
        assert response.status_code == 422
    for suffix in ("generation=1&generation=1", "generation=-1", "generation=1&after=true"):
        assert client.get(API + "/index?" + suffix, headers=headers(account)).status_code == 422
    monkeypatch.setattr(module, "MAX_SNAPSHOT_BYTES", 10)
    assert client.put(API + "/sessions/synthetic-session", json=payload(), headers=headers(account)).status_code == 413


def test_logout_during_body_read_and_before_transaction_prevents_write(setup, monkeypatch):
    store, account, sync, client = setup
    enable(client, account)
    original = Request.stream

    async def revoke_after_body(request):
        async for chunk in original(request):
            yield chunk
        store.accounts.logout(account["token"])

    monkeypatch.setattr(Request, "stream", revoke_after_body)
    response = client.put(API + "/sessions/synthetic-session", json=payload(), headers=headers(account))
    assert response.status_code == 401
    with store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM conversation_sync_sessions").fetchone()[0] == 0
    with pytest.raises(ChatError) as error:
        sync.upload(account["user"]["id"], CHECKSUM, 1, RAW, digest(account["token"]))
    assert error.value.status == 401


@pytest.mark.parametrize("consent_change", ["pause", "revoke", "scope"])
def test_disable_during_upload_prevents_storage_and_stale_cas(setup, monkeypatch, consent_change):
    store, account, sync, client = setup
    enable(client, account)
    original = Request.stream

    async def pause_after_body(request):
        async for chunk in original(request):
            yield chunk
        if consent_change == "revoke":
            store.accounts.revoke_managed(account["user"]["id"])
        else:
            control = {"enabled": False, "expected_generation": 1}
            if consent_change == "scope":
                control.update(enabled=True, scopes={"conversations": False, "preferences": True})
            sync.configure(account["user"]["id"], control, digest(account["token"]))

    monkeypatch.setattr(Request, "stream", pause_after_body)
    response = client.put(API + "/blobs/" + CHECKSUM + "?generation=1", content=RAW, headers=headers(account))
    expected = (403, "sync_invitation_required") if consent_change == "revoke" else (409, "sync_generation_changed")
    assert (response.status_code, response.json()["error"]["code"]) == expected
    with store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM conversation_sync_blobs").fetchone()[0] == 0


def test_real_application_router_is_wired_before_chat_catch_all(tmp_path):
    from app.main import create_app
    app = create_app(Settings(db_path=str(tmp_path / "composition.sqlite3"), worker_enabled=False,
        api_enabled=True, api_key="synthetic-key", admin_token="synthetic-admin-token"))
    with TestClient(app, base_url=ORIGIN) as client:
        store = app.state.store
        account = managed_account(store, "synthetic_composition")
        result = client.get(API, headers=headers(account))
        assert result.status_code == 200 and result.json()["enabled"] is False
        enable(client, account)
        result = write(client, account)
        assert result["snapshot"] == payload()["snapshot"]
        assert_no_usage(app.state.store, account)


def test_preferences_and_envelope_consent_conflicts_and_clear(setup):
    import base64
    store, account, _, client = setup
    pref = API + "/preferences"
    key = API + "/key-envelope"
    auth = headers(account)
    envelope = {"version": 1, **{field: base64.b64encode(bytes(length)).decode()
                for field, length in (("salt", 16), ("iv", 12), ("ciphertext", 32))}}
    assert client.get(key + "?generation=0", headers=auth).json()["error"]["code"] == "sync_disabled"
    enable(client, account)
    def put(path, value, rev=0):
        return client.put(path, headers=auth, json={"generation": 1, "expected_revision": rev, "value": value})
    for path, value in ((pref, {"apiKey": "synthetic"}), (pref, {"thinking": 1}),
                        (pref, {"temperature": "2.01"}), (pref, {"reasoningEffort": "unsupported"}),
                        (pref, {"persona": "🐟" * 1001}), (pref, {"replyTone": "unsupported"}),
                        (pref, {"replyTone": None}), (pref, {"replyTone": 1}),
                        (pref, {"replyWarmth": "warm"}), (pref, {"replyEmojis": True}),
                        (pref, {"replyVisuals": None}),
                        (pref, {"replyDetail": "compare"}), (pref, {"replyDetail": False}),
                        (pref, {"replyApproach": "deep"}), (pref, {"replyApproach": None}),
                        (key, {**envelope, "password": "synthetic"}), (key, {**envelope, "iv": "invalid"})):
        assert put(path, value).status_code == 422
    assert put(key, envelope).json()["revision"] == 1
    preferences = {"themePreference": "dark", "replyTone": "custom", "persona": "🐟" * 1000,
                   "replyWarmth": "more", "replyEnthusiasm": "less", "replyEmojis": "default",
                   "replyVisuals": "less", "replyStructure": "more", "replyDetail": "deep", "replyApproach": "compare",
                   "temperature": "1.25", "reasoningEffort": "high"}
    assert put(pref, preferences).json()["revision"] == 1
    assert client.get(pref + "?generation=1", headers=auth).json()["value"] == preferences
    assert client.get(key + "?generation=1", headers=auth).json()["value"] == envelope
    other = managed_account(store, "isolated_sync")
    enable(client, other)
    assert client.get(key + "?generation=1", headers=headers(other)).json()["value"] is None
    deleted = client.request("DELETE", key, headers=auth, json={"generation": 1, "expected_revision": 1})
    assert deleted.json() == {"generation": 1, "revision": 2, "value": None}
    assert put(key, envelope, 1).json()["current_revision"] == 2
    assert put(key, envelope, 2).status_code == 200
    assert client.request("DELETE", API, headers=auth, json={"expected_generation": 1}).status_code == 200
    enable(client, account, generation=2)
    assert put(key, envelope, 0).json()["error"]["code"] == "sync_generation_changed"
    for path in (key, pref):
        assert client.get(path + "?generation=3", headers=auth).json() == {"value": None, "generation": 3, "revision": 0}
    assert_no_usage(store, account)


def test_site_capacity_allows_retry_and_clear(setup, monkeypatch):
    store, account, sync, client = setup
    enable(client, account)
    monkeypatch.setattr(store, "settings", replace(store.settings, sync_pool_bytes=len(RAW)))
    upload(client, account)
    upload(client, account)
    response = client.put(API + "/sessions/second", json=payload(), headers=headers(account))
    assert response.status_code == 507
    assert client.request("DELETE", API, headers=headers(account), json={"expected_generation": 1}).status_code == 200
