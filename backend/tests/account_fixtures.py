"""Registered identities for tests whose subject is outside account APIs."""

import time
import uuid

from app.accounts import _hash_password, _username
from app.config import money
from app.store import digest


def managed_account(store, username=None, password="synthetic-fixture-password", client_ip=None):
    identity = uuid.uuid4().hex
    code = store.accounts.create_invites(1, 1)["invitations"][0]["code"]
    return store.accounts.register(username or f"fixture_{identity[:24]}", password,
                                   invitation_code=code, client_ip=client_ip or identity)


def legacy_personal_account(store, username=None, password="synthetic-fixture-password"):
    """Seed a historical public registration that never redeemed an invitation."""
    name, key = _username(username or f"legacy_{uuid.uuid4().hex[:24]}")
    now = time.time()
    password_hash = _hash_password(password)
    with store.connection(write=True) as db:
        owner = store.accounts._create_identity(db, name, key, password_hash, now)
        db.execute("UPDATE registration_counter SET public_registered_count=public_registered_count+1 WHERE id=1")
        store._touch_user(db, owner, now)
        token, expires = store.accounts._session(db, owner, now)
    return {"token": token, "expires_at": expires, **store.accounts.me(owner)}


def registered_session(client):
    return managed_account(client.app.state.store)


def register_owner(store):
    body = managed_account(store)
    return body["user"]["id"], body["token"]


def registered_job(store, owner_id, token, request):
    return store.create_job(owner_id, request, account_session_hash=digest(token))


def registered_budget_owner(store):
    """A qualified, authenticated owner for testing the historical monetary ledger."""
    owner, token = register_owner(store)
    with store.connection(write=True) as db:
        db.execute("UPDATE users SET access_mode='invitation',budget_limit=? WHERE id=?",
                   (money(store.settings.user_budget_cny), owner))
    return owner, token
