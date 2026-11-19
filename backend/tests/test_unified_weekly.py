"""Calendar-week shared allowance and account administration, using synthetic data."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import pytest
from pydantic import ValidationError

from account_fixtures import managed_account
from app.admin_access import UserQuotaPatch, _statistics, _users
from app.config import Settings
from app.schemas import AdminConfigPatch, JobRequest
from app.store import SHANGHAI, ServiceError, Store, digest, local_week, reset_at

PASSWORD = "synthetic original password"


def timestamp(value):
    return datetime.fromisoformat(value).timestamp()


@pytest.fixture
def clock(monkeypatch):
    current = [timestamp("2026-11-15T23:59:59+08:00")]
    monkeypatch.setattr("app.store.time.time", lambda: current[0])
    return current


@pytest.fixture
def store(tmp_path, clock):
    result = Store(Settings(db_path=str(tmp_path / "weekly.sqlite3"), worker_enabled=False,
                            api_enabled=True, api_key="synthetic-upstream-key",
                            weekly_limit=20, user_weekly_limit=5))
    result.initialize()
    return result


def user(store, name="weekly_user"):
    return managed_account(store, name, PASSWORD, client_ip=name)


def submit(store, session, key="synthetic-weekly-job"):
    return store.create_job(session["user"]["id"], JobRequest.model_validate({
        "idempotency_key": key,
        "messages": [{"id": "synthetic-message", "role": "user", "content": "只用于本地测试的原文。"}],
    }), account_session_hash=digest(session["token"]))


def charge(store, session, kind="chat"):
    return store.begin_chat_call(session["user"]["id"], kind, account_session_hash=digest(session["token"]))


def status(call):
    with pytest.raises(ServiceError) as caught:
        call()
    return caught.value.status


@pytest.mark.parametrize("when,week,reset", [
    ("2026-11-15T23:59:59+08:00", "2026-11-09", "2026-11-16T00:00:00+08:00"),
    ("2026-11-16T00:00:00+08:00", "2026-11-16", "2026-11-23T00:00:00+08:00"),
    ("2026-11-16T17:00:00+08:00", "2026-11-16", "2026-11-23T00:00:00+08:00"),
    ("2027-01-03T23:59:59+08:00", "2026-12-28", "2027-01-04T00:00:00+08:00"),
])
def test_week_starts_only_on_monday_in_shanghai(when, week, reset):
    assert local_week(timestamp(when)) == week
    assert reset_at(timestamp(when)) == reset


def test_week_counts_multiple_dates_and_resets_at_monday(store, clock):
    session = user(store)
    clock[0] = timestamp("2026-11-11T10:00:00+08:00")
    for kind in ("chat", "file", "asr"):
        call_id = charge(store, session, kind)
        store.finish_chat_call(call_id, "success")
    clock[0] = timestamp("2026-11-15T23:59:59+08:00")
    charge(store, session, "tts")
    quota = store.quota(session["user"]["id"])
    assert quota["user_weekly_used"] == 4
    assert quota["user_weekly_remaining"] == 1
    assert quota["reset_at"] == "2026-11-16T00:00:00+08:00"
    clock[0] += 1
    quota = store.quota(session["user"]["id"])
    assert quota["user_weekly_used"] == 0
    assert quota["user_weekly_remaining"] == 5
    assert quota["reset_at"] == "2026-11-23T00:00:00+08:00"


def test_chat_and_organize_share_capacity_including_queued_reservations(store):
    session = user(store)
    owner = session["user"]["id"]
    store.update_config({"user_weekly_limit": 2})
    job = submit(store, session)
    first = charge(store, session)
    quota = store.quota(owner)
    assert (quota["user_weekly_used"], quota["user_weekly_reserved"], quota["user_weekly_remaining"]) == (1, 1, 0)
    assert status(lambda: charge(store, session)) == 429
    assert store.claim_next()["id"] == job["id"]
    assert store.quota(owner)["user_weekly_used"] == 2
    store.finish_chat_call(first, "failed")
    assert store.quota(owner)["user_weekly_remaining"] == 0  # A sent request is still consumed.
    stats = _statistics(store, 7)
    assert stats["totals"]["requests"] == 2
    assert stats["totals"]["calls_by_kind"] == {"organize": 1, "chat": 1, "file": 0, "asr": 0, "tts": 0, "image": 0}
    listed = _users(store, 50, 0)
    assert listed["week"] == "2026-11-09"
    assert listed["users"][0]["weekly_used"] == 2


def test_cancelling_unsent_organize_releases_capacity_for_chat(store):
    session = user(store)
    store.update_config({"user_weekly_limit": 1})
    job = submit(store, session)
    assert status(lambda: charge(store, session)) == 429
    store.cancel(session["user"]["id"], job["id"])
    assert charge(store, session)


def test_atomic_last_slot_across_concurrent_chat_dispatches(store):
    session = user(store)
    store.update_config({"user_weekly_limit": 2})
    def attempt(_):
        try:
            return charge(store, session)
        except ServiceError as error:
            assert error.status == 429
            return None
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(attempt, range(16)))
    assert sum(value is not None for value in results) == 2
    assert store.quota(session["user"]["id"])["user_weekly_used"] == 2


def test_existing_accounts_follow_dynamic_default_override_and_current_week_cap(store, clock):
    session = user(store)
    owner = session["user"]["id"]
    charge(store, session)
    store.update_config({"user_weekly_limit": 7})
    assert store.quota(owner)["user_weekly_remaining"] == 6
    store.update_user_quota(owner, {"weekly_limit": 4})
    store.update_config({"user_weekly_limit": 9})
    assert store.quota(owner)["user_weekly_remaining"] == 3
    cap = store.update_user_quota(owner, {"this_week_remaining": 1, "week": "2026-11-09"})
    assert cap["weekly_remaining"] == 1
    store.update_user_quota(owner, {"weekly_limit": None})
    assert store.quota(owner)["user_weekly_remaining"] == 1
    clock[0] = timestamp("2026-11-16T00:00:00+08:00")
    assert store.quota(owner)["user_weekly_remaining"] == 9
    assert status(lambda: store.update_user_quota(owner, {"this_week_remaining": 4, "week": "2026-11-09"})) == 409


def test_restart_marks_dispatched_chat_uncertain_without_refunding_or_replaying(store):
    session = user(store)
    call_id = charge(store, session)
    store.recover_running()
    with store.connection() as db:
        row = db.execute("SELECT * FROM chat_calls WHERE id=?", (call_id,)).fetchone()
        assert row["status"] == "uncertain"
        assert db.execute("SELECT COUNT(*) FROM chat_calls").fetchone()[0] == 1
    assert store.quota(session["user"]["id"])["user_weekly_used"] == 1


def test_disable_revokes_sessions_blocks_both_features_and_is_reversible(store):
    session = user(store)
    owner = session["user"]["id"]
    job = submit(store, session)
    assert store.accounts.set_enabled(owner, False)["enabled"] is False
    assert store.accounts.authenticate(session["token"]) is None
    assert not store.accounts.is_session_active_hash(digest(session["token"]))
    assert status(lambda: charge(store, session)) == 401
    assert status(lambda: store.accounts.login("weekly_user", PASSWORD)) == 401
    assert store.claim_next() is None
    assert store.get_job(owner, job["id"])["status"] == "failed"
    assert store.quota(owner)["user_weekly_reserved"] == 0
    store.accounts.set_enabled(owner, True)
    assert store.accounts.authenticate(session["token"]) is None
    fresh = store.accounts.login("weekly_user", PASSWORD)
    assert charge(store, fresh)


def test_reset_password_revokes_all_old_sessions(store):
    session = user(store)
    second = store.accounts.login("weekly_user", PASSWORD)
    result = store.accounts.reset_password(session["user"]["id"])
    assert result["username"] == "weekly_user"
    for previous in (session, second):
        assert store.accounts.authenticate(previous["token"]) is None
        assert status(lambda: charge(store, previous)) == 401
    assert status(lambda: store.accounts.login("weekly_user", PASSWORD)) == 401
    fresh = store.accounts.login("weekly_user", result["password"])
    assert charge(store, fresh)


def test_weekly_admin_schema_is_explicit_and_rejects_stale_daily_fields():
    assert UserQuotaPatch(week="2026-11-16", this_week_remaining=3).week == "2026-11-16"
    with pytest.raises(ValidationError):
        UserQuotaPatch(week="2026-11-17", this_week_remaining=3)
    with pytest.raises(ValidationError):
        AdminConfigPatch(daily_limit=50)
    assert AdminConfigPatch(weekly_limit=350, user_weekly_limit=35).weekly_limit == 350


def test_admin_http_can_adjust_shared_weekly_allowance_disable_and_reset(tmp_path):
    from fastapi.testclient import TestClient
    from app.main import create_app
    config = Settings(db_path=str(tmp_path / "http-weekly.sqlite3"), worker_enabled=False,
                      api_enabled=True, api_key="synthetic-upstream-key",
                      admin_token="synthetic-admin-token-for-weekly-http", user_weekly_limit=5)
    with TestClient(create_app(config)) as client:
        session = managed_account(client.app.state.store, "http_weekly", PASSWORD)
        owner = session["user"]["id"]
        bearer = {"Authorization": "Bearer " + session["token"]}
        admin = {"Authorization": "Bearer " + config.admin_token}
        config_result = client.patch("/v1/admin/config", headers=admin, json={"user_weekly_limit": 9})
        assert config_result.status_code == 200
        assert client.get("/v1/quota", headers=bearer).json()["user_weekly_remaining"] == 9
        listing = client.get("/v1/admin/users", headers=admin).json()
        assert listing["users"][0]["enabled"] is True
        patched = client.patch(f"/v1/admin/users/{owner}/quota", headers=admin,
                               json={"this_week_remaining": 2, "week": listing["week"]})
        assert patched.status_code == 200 and patched.json()["weekly_remaining"] == 2
        stats = client.get("/v1/admin/stats", headers=admin).json()
        assert "this_week" in stats and "daily" in stats
        assert client.patch(f"/v1/admin/users/{owner}/status", headers=admin,
                            json={"enabled": False}).status_code == 200
        assert client.get("/v1/accounts/me", headers=bearer).status_code == 401
        assert client.patch(f"/v1/admin/users/{owner}/status", headers=admin,
                            json={"enabled": True}).status_code == 200
        reset = client.post(f"/v1/admin/users/{owner}/reset-password", headers=admin)
        assert reset.status_code == 200
        fresh = client.post("/v1/accounts/login", json={"username": "http_weekly", "password": reset.json()["password"]})
        assert fresh.status_code == 200
        assert fresh.json()["quota"]["user_weekly_remaining"] == 2


def test_image_dispatch_uses_the_same_weekly_allowance_and_admin_category(store):
    session = user(store)
    call_id = charge(store, session, "image")
    store.finish_chat_call(call_id, "success")
    assert store.quota(session["user"]["id"])["user_weekly_used"] == 1
    assert _users(store, 10, 0)["users"][0]["calls_by_kind"]["image"] == 1
    assert _statistics(store, 7)["totals"]["calls_by_kind"]["image"] == 1
