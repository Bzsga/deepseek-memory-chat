"""Registered identities for tests whose subject is jobs rather than account APIs."""

import uuid

from app.config import money
from app.store import digest


def managed_account(store, username=None, password="synthetic-fixture-password", client_ip=None):
    identity = uuid.uuid4().hex
    account = store.accounts.register(username or f"fixture_{identity[:24]}", password, client_ip=client_ip or identity)
    code = store.accounts.create_invites(1, 1)["invitations"][0]["code"]
    account.update(store.accounts.redeem_invite(account["user"]["id"], code))
    return account


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
