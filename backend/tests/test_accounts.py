import json
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from account_fixtures import legacy_personal_account, managed_account
from app.accounts import Accounts, MAX_FAILED_LOGINS_PER_USER, PASSWORD_ITERATIONS, SESSION_SECONDS
from app.config import Settings
from app.store import DAY, ServiceError, Store, digest


PASSWORD = "synthetic password 123"


@pytest.fixture
def registered(tmp_path):
    store = Store(Settings(db_path=str(tmp_path / "accounts.sqlite3"), worker_enabled=False,
                           api_enabled=True, api_key="synthetic-provider-key", user_weekly_limit=5))
    store.initialize()
    accounts = getattr(store, "accounts", None) or Accounts(store)
    accounts.initialize()
    return store, accounts


def failure(call):
    with pytest.raises(ServiceError) as caught:
        call()
    return caught.value.status


def invite_code(accounts):
    return accounts.create_invites(1, 7)["invitations"][0]["code"]


def test_register_login_normalization_private_hashes_and_independent_owner(registered):
    store, accounts = registered
    legacy_token, _ = store.create_session()
    legacy_owner = store.authenticate(legacy_token)
    code = invite_code(accounts)
    first = accounts.register("  Ａlice_测试  ", PASSWORD, invitation_code=f" {code} ")
    owner = first["user"]["id"]
    assert owner != legacy_owner
    assert first["user"]["username"] == "Alice_测试"
    assert first["user"]["registration_kind"] == "invitation"
    assert first["user"]["managed_eligible"]
    assert first["user"]["permissions"] == {"chat_api": True, "image_api": True, "cloud_sync": True}
    assert not first["user"]["invite_redeemable"]
    assert first["quota"]["user_weekly_remaining"] == 5
    assert accounts.authenticate(first["token"]) == owner
    assert accounts.is_session_active_hash(digest(first["token"]))
    login = accounts.login("alice_测试", PASSWORD)
    assert login["user"] == first["user"]
    assert login["token"] != first["token"]
    assert accounts.me(owner)["user"] == first["user"]
    assert failure(lambda: accounts.register("ALICE_测试", PASSWORD, invite_code(accounts))) == 409
    with store.connection() as db:
        account = db.execute("SELECT * FROM registered_accounts WHERE user_id=?", (owner,)).fetchone()
        session = db.execute("SELECT * FROM account_sessions WHERE token_hash=?", (digest(first["token"]),)).fetchone()
        legacy = db.execute("SELECT token_hash FROM users WHERE id=?", (owner,)).fetchone()[0]
        assert account["password_hash"].startswith(f"pbkdf2_sha256${PASSWORD_ITERATIONS}$")
        assert PASSWORD not in account["password_hash"]
        assert account["weekly_limit_override"] is None
        assert session["expires_at"] - session["created_at"] == SESSION_SECONDS
        assert session["token_hash"] != first["token"]
        assert legacy != digest(first["token"])
    public = json.dumps(accounts.me(owner), ensure_ascii=False)
    for secret in (PASSWORD, first["token"], login["token"], account["password_hash"], account["username_key"]):
        assert secret not in public
    assert accounts.public_registered_count() == 0


def test_logout_and_expiry_revoke_current_session_without_revoking_new_session(registered):
    store, accounts = registered
    session = managed_account(store, "session_test", PASSWORD)
    token, owner = session["token"], session["user"]["id"]
    accounts.logout(token)
    assert accounts.authenticate(token) is None
    assert not accounts.is_session_active_hash(digest(token))
    accounts.logout(token)  # Idempotent, and does not touch a newer session.
    fresh = accounts.login("session_test", PASSWORD)
    assert accounts.authenticate(fresh["token"]) == owner
    restarted = Accounts(store)
    restarted.initialize()
    assert restarted.authenticate(token) is None
    assert restarted.authenticate(fresh["token"]) == owner
    with store.connection(write=True) as db:
        db.execute("UPDATE account_sessions SET expires_at=? WHERE token_hash=?", (time.time() - 10, digest(fresh["token"])))
    assert restarted.authenticate(fresh["token"]) is None
    assert not restarted.is_session_active_hash(digest(fresh["token"]))
    with store.connection(write=True) as db:
        db.execute("UPDATE account_sessions SET expires_at=? WHERE token_hash=?", (time.time() - DAY - 1, digest(fresh["token"])))
    assert restarted.authenticate(fresh["token"]) is None
    assert restarted.authenticate("not-a-session") is None


def test_concurrent_registrations_with_one_invite_create_one_managed_account(registered):
    store, accounts = registered
    store.update_config({"public_registration_limit": 0})
    invite = invite_code(accounts)

    def register(index):
        try:
            return accounts.register(f"invited_{index}", PASSWORD, invite)
        except ServiceError as error:
            return error.status

    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(register, range(3)))
    assert results.count(400) == 2
    winner = next(result for result in results if isinstance(result, dict))
    assert winner["user"]["managed_eligible"] is True
    assert winner["quota"]["user_weekly_remaining"] == 5
    assert accounts.public_registered_count() == 0
    with store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM registered_accounts").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1
        assert db.execute("SELECT COUNT(*) FROM account_sessions").fetchone()[0] == 1
        assert db.execute("SELECT redeemed_by FROM registration_invites").fetchone()[0] == winner["user"]["id"]


def test_existing_personal_accounts_redeem_same_invite_pool_atomically(registered):
    store, accounts = registered
    owners = [legacy_personal_account(store, f"public_{i}", PASSWORD)["user"]["id"] for i in range(3)]
    assert accounts.public_registered_count() == 3
    invite = accounts.create_invites(1, 7)["invitations"][0]["code"]

    def redeem(owner):
        try:
            return accounts.redeem_invite(owner, invite)["user"]["id"]
        except ServiceError as error:
            return error.status

    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(redeem, owners))
    assert results.count(400) == 2
    winner = next(owner for owner in owners if owner in results)
    assert accounts.me(winner)["quota"]["managed_eligible"]
    assert failure(lambda: accounts.register("already_redeemed", PASSWORD, invite)) == 400
    spare = accounts.create_invites(1, 7)["invitations"][0]["code"]
    assert failure(lambda: accounts.redeem_invite(winner, spare)) == 409
    accounts.revoke_managed(winner)
    accounts.initialize()
    quota = accounts.me(winner)["quota"]
    assert not quota["managed_eligible"] and quota["user_weekly_remaining"] == 0
    assert failure(lambda: accounts.redeem_invite(winner, invite)) == 400
    assert accounts.redeem_invite(winner, spare)["quota"]["user_weekly_remaining"] == 5


def test_account_permission_override_blocks_invitation_elevation_and_survives_restart(registered):
    store, accounts = registered
    account = legacy_personal_account(store, "override_owner", PASSWORD)
    owner = account["user"]["id"]
    assert account["user"]["invite_redeemable"]
    assert failure(lambda: accounts.set_permissions(owner, {"chat_api": True})) == 422
    image_only = {"chat_api": False, "image_api": True, "cloud_sync": False}
    assert accounts.set_permissions(owner, image_only)["permissions"] == image_only
    assert accounts.me(owner)["quota"]["user_weekly_remaining"] == 5
    spare = invite_code(accounts)
    assert failure(lambda: accounts.redeem_invite(owner, spare)) == 409
    assert accounts.list_invites()["invitations"][0]["code"] == spare
    accounts.initialize()
    assert accounts.me(owner)["user"]["permissions"] == image_only
    assert accounts.authenticate(account["token"]) == owner
    denied = accounts.set_permissions(owner, dict.fromkeys(image_only, False))
    assert denied["managed_eligible"] is False and denied["invite_redeemable"] is False
    assert failure(lambda: accounts.redeem_invite(owner, spare)) == 409


def test_scoped_invites_grant_only_selected_permissions_on_signup_and_redemption(registered):
    store, accounts = registered
    image_only = {"chat_api": False, "image_api": True, "cloud_sync": False}
    sync_only = {"chat_api": False, "image_api": False, "cloud_sync": True}
    registration_only = dict.fromkeys(image_only, False)
    requested = (image_only, sync_only, registration_only)
    invitations = [accounts.create_invites(1, 7, permissions=permissions)["invitations"][0] for permissions in requested]
    visible = {row["id"]: row["permissions"] for row in accounts.list_invites()["invitations"]}
    assert all(invite["permissions"] == visible[invite["id"]] == permissions
               for invite, permissions in zip(invitations, requested))

    first = accounts.register("invited_image", PASSWORD, invitations[0]["code"])
    existing = legacy_personal_account(store, "sync_redeemer", PASSWORD)["user"]["id"]
    sync = accounts.redeem_invite(existing, invitations[1]["code"])
    free = accounts.register("registration_only", PASSWORD, invitations[2]["code"])
    for result, permissions, remaining in zip((first, sync, free), requested, (5, 0, 0)):
        assert result["user"]["permissions"] == permissions
        assert result["quota"]["user_weekly_remaining"] == remaining
        assert result["user"]["invite_redeemable"] is False
    assert accounts.list_invites()["invitations"] == []
    assert failure(lambda: accounts.register("reuse_invite", PASSWORD, invitations[0]["code"])) == 400
    assert failure(lambda: accounts.redeem_invite(free["user"]["id"], invite_code(accounts))) == 409


def test_upgrade_keeps_existing_public_and_invited_users_once(registered):
    store, accounts = registered
    old = [legacy_personal_account(store, "old_public", PASSWORD), managed_account(store, "old_invited", PASSWORD)]
    with store.connection(write=True) as db:
        db.execute("ALTER TABLE registered_accounts DROP COLUMN managed_eligible")
    accounts.initialize()
    assert all(accounts.me(account["user"]["id"])["user"]["managed_eligible"] for account in old)
    accounts.revoke_managed(old[1]["user"]["id"])
    accounts.initialize()
    assert not accounts.me(old[1]["user"]["id"])["user"]["managed_eligible"]
    accounts.set_registration_policy(False)
    assert failure(lambda: accounts.register("new_public", PASSWORD)) == 422


def test_redeemed_invitation_clears_plaintext_and_records_owner(registered):
    store, accounts = registered
    store.update_config({"public_registration_limit": 0})
    invitation = accounts.create_invites(1, 7)["invitations"][0]
    assert accounts.list_invites()["invitations"][0]["code"] == invitation["code"]

    owner = accounts.register("redeem_owner", PASSWORD, invitation["code"])["user"]["id"]
    assert accounts.list_invites()["invitations"] == []
    assert accounts.list_invites()["total"] == 0
    with store.connection() as db:
        row = db.execute("SELECT * FROM registration_invites WHERE id=?", (invitation["id"],)).fetchone()
        assert row["code_hash"] == digest(invitation["code"])
        assert row["unused_plaintext"] is None
        assert row["redeemed_by"] == owner


def test_failed_registration_rolls_back_counter_owner_and_invitation(registered, monkeypatch):
    store, accounts = registered
    invitation = accounts.create_invites(1, 7)["invitations"][0]
    original_session = accounts._session

    def failed_session(*args):
        raise RuntimeError("synthetic session failure")

    monkeypatch.setattr(accounts, "_session", failed_session)
    with pytest.raises(RuntimeError, match="synthetic session failure"):
        accounts.register("rollback_invited", PASSWORD, invitation["code"])
    assert accounts.public_registered_count() == 0
    with store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM registered_accounts").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
        assert db.execute("SELECT redeemed_at FROM registration_invites").fetchone()[0] is None
    monkeypatch.setattr(accounts, "_session", original_session)
    owner = accounts.register("rollback_invited", PASSWORD, invitation["code"])
    assert owner["user"]["managed_eligible"]
    assert accounts.public_registered_count() == 0


def test_duplicate_username_does_not_consume_invite_and_revoked_or_expired_codes_fail(registered):
    store, accounts = registered
    managed_account(store, "existing_user", PASSWORD)
    invitations = accounts.create_invites(3, 7)["invitations"]
    assert failure(lambda: accounts.register("EXISTING_USER", PASSWORD, invitations[0]["code"])) == 409

    accounts.revoke_invite(invitations[1]["id"])
    assert failure(lambda: accounts.register("revoked_user", PASSWORD, invitations[1]["code"])) == 400
    with store.connection(write=True) as db:
        db.execute("UPDATE registration_invites SET expires_at=? WHERE id=?", (time.time() - 1, invitations[2]["id"]))
    assert failure(lambda: accounts.register("expired_user", PASSWORD, invitations[2]["code"])) == 400
    assert accounts.register("valid_user", PASSWORD, invitations[0]["code"])["user"]["managed_eligible"]
    listed = {item["id"]: item for item in accounts.list_invites()["invitations"]}
    assert listed == {}
    accounts.initialize()
    with store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM registration_invites WHERE unused_plaintext IS NOT NULL").fetchone()[0] == 0
    assert accounts.public_registered_count() == 0


def test_failed_login_throttle_persists_and_checks_unknown_names_equally(registered):
    store, accounts = registered
    managed_account(store, "login_limit", PASSWORD)
    for _ in range(MAX_FAILED_LOGINS_PER_USER):
        assert failure(lambda: accounts.login("login_limit", "wrong password", client_ip="203.0.113.1")) == 401
    restarted = Accounts(store)
    restarted.initialize()
    assert failure(lambda: restarted.login("login_limit", PASSWORD, client_ip="203.0.113.2")) == 429
    assert failure(lambda: restarted.login("unknown_login", "wrong password", client_ip="203.0.113.3")) == 401
    with store.connection(write=True) as db:
        db.execute("UPDATE account_auth_attempts SET created_at=?", (time.time() - 3601,))
    assert restarted.login("LOGIN_LIMIT", PASSWORD)["user"]["username"] == "login_limit"


@pytest.mark.parametrize("username,password", [("aa", PASSWORD), ("contains space", PASSWORD),
                                             ("valid_name", "short"), ("valid_name", "x" * 129),
                                             ("valid_name", "x" * 8 + "\ud800")])
def test_invalid_credentials_do_not_create_owners(registered, username, password):
    store, accounts = registered
    code = invite_code(accounts)
    assert failure(lambda: accounts.register(username, password, code)) == 422
    assert accounts.public_registered_count() == 0
    assert accounts.list_invites()["invitations"][0]["code"] == code
    with store.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
