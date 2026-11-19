"""Opt-in, private conversation replication using transactional SQLite snapshots."""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import logging
import os
import re
import sqlite3
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from .chat import ChatError, _body, _error, _origin_ok, _token
from .share_import import _invalid_constant, _unique_object
from .store import digest
from .storage_capacity import check_growth, sync_usage


MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
MAX_BLOB_BYTES = 64 * 1024 * 1024
MAX_ACCOUNT_BYTES = 512 * 1024 * 1024
MAX_REQUEST_BYTES = 36 * 1024 * 1024
MAX_JSON_DEPTH = 64
ORPHAN_TTL_SECONDS = 24 * 60 * 60
PAGE_SIZE = 200
SHA256 = re.compile(r"[a-f0-9]{64}\Z")
HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
           "Referrer-Policy": "same-origin"}
logger = logging.getLogger(__name__)


class SyncConflict(ChatError):
    def __init__(self, revision):
        super().__init__(409, "云端会话已有其他修改，将保留本机版本。", code="sync_conflict")
        self.current_revision = revision


def _invalid(message="同步资料格式不正确，请重新打开会话后重试。"):
    raise ChatError(422, message)


def _integer(value):
    if type(value) is not int or not 0 <= value <= 9007199254740991:
        _invalid()
    return value


def _identity(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 256
            or any(ord(char) < 32 or char in "/\\" for char in value)):
        _invalid()
    try:
        value.encode("utf-8")
    except UnicodeError:
        _invalid()
    return value


def _fields(value, required):
    if not isinstance(value, dict) or set(value) != set(required):
        _invalid()


def _encoded(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (ValueError, UnicodeError, RecursionError):
        _invalid()


def _parse(raw):
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                           parse_constant=_invalid_constant)
    except (ValueError, UnicodeError, RecursionError):
        _invalid()
    stack = [(iter((value,)), 0)]
    while stack:
        children, depth = stack[-1]
        try:
            item = next(children)
        except StopIteration:
            stack.pop()
            continue
        if depth > MAX_JSON_DEPTH:
            _invalid("同步资料嵌套层数过多。")
        if isinstance(item, dict):
            stack.append((iter(item.values()), depth + 1))
        elif isinstance(item, list):
            stack.append((iter(item), depth + 1))
    return value


def _files(value):
    if not isinstance(value, list) or len(value) > 100000:
        _invalid()
    result, seen = [], set()
    for item in value:
        _fields(item, {"id", "sha256", "size", "mime_type"})
        identity = _identity(item["id"])
        checksum = item["sha256"]
        size = _integer(item["size"])
        mime = item["mime_type"]
        if (identity in seen or not isinstance(checksum, str) or not SHA256.fullmatch(checksum)
                or size > MAX_BLOB_BYTES or not isinstance(mime, str) or len(mime) > 256
                or any(ord(char) < 32 for char in mime)):
            _invalid()
        seen.add(identity)
        result.append({"id": identity, "sha256": checksum, "size": size, "mime_type": mime})
    return sorted(result, key=lambda item: item["id"])


def _validate_preferences(value):
    choices = {"locale": ("zh-CN", "en-US"), "themePreference": ("light", "dark", "system"),
               "ttsVoice": ("stella", "tide"), "reasoningEffort": ("", "low", "medium", "high", "max")}
    flags = {"thinking", "search", "siderCollapsed"}
    if not isinstance(value, dict) or set(value) - (flags | choices.keys() | {"persona", "temperature"}):
        _invalid()
    for name, item in value.items():
        if name in flags:
            if type(item) is not bool:
                _invalid()
        elif name == "persona":
            if not isinstance(item, str):
                _invalid()
            try:
                # The client limits this field in UTF-16 code units.
                if len(item.encode("utf-16-le")) > 4000:
                    _invalid()
            except UnicodeError:
                _invalid()
        elif name == "temperature":
            if not isinstance(item, str) or (item and (not re.fullmatch(r"[0-2](?:\.[0-9]{1,2})?", item) or float(item) > 2)):
                _invalid()
        elif item not in choices[name]:
            _invalid()


def _validate_key_envelope(value):
    # Version 1 uses PBKDF2-HMAC-SHA256 (600000 iterations) and AES-256-GCM with a 128-bit tag.
    _fields(value, {"version", "salt", "iv", "ciphertext"})
    if _integer(value["version"]) != 1:
        _invalid()
    for key, minimum, maximum in (("salt", 16, 16), ("iv", 12, 12), ("ciphertext", 17, 4096)):
        text = value[key]
        if not isinstance(text, str) or len(text) > 4 * ((maximum + 2) // 3):
            _invalid()
        try:
            raw = base64.b64decode(text, validate=True)
        except (ValueError, binascii.Error):
            _invalid()
        if not minimum <= len(raw) <= maximum or base64.b64encode(raw).decode("ascii") != text:
            _invalid()


class ConversationSync:
    def __init__(self, store):
        self.store = store

    def initialize(self):
        with self.store.connection(write=True) as db:
            statements = [
                """CREATE TABLE IF NOT EXISTS conversation_sync_settings (
                    owner_id TEXT PRIMARY KEY REFERENCES registered_accounts(user_id),
                    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
                    generation INTEGER NOT NULL DEFAULT 0, sequence INTEGER NOT NULL DEFAULT 0)""",
                """CREATE TABLE IF NOT EXISTS conversation_sync_documents (
                    owner_id TEXT NOT NULL REFERENCES registered_accounts(user_id), kind TEXT NOT NULL,
                    revision INTEGER NOT NULL, value TEXT, PRIMARY KEY(owner_id,kind))""",
                """CREATE TABLE IF NOT EXISTS conversation_sync_sessions (
                    owner_id TEXT NOT NULL REFERENCES registered_accounts(user_id), id TEXT NOT NULL,
                    revision INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
                    content_hash TEXT NOT NULL, snapshot TEXT, snapshot_size INTEGER NOT NULL,
                    PRIMARY KEY(owner_id,id), UNIQUE(owner_id,revision))""",
                """CREATE TABLE IF NOT EXISTS conversation_sync_blobs (
                    owner_id TEXT NOT NULL REFERENCES registered_accounts(user_id), sha256 TEXT NOT NULL,
                    size INTEGER NOT NULL, data BLOB NOT NULL, touched_at REAL NOT NULL,
                    PRIMARY KEY(owner_id,sha256))""",
                """CREATE TABLE IF NOT EXISTS conversation_sync_files (
                    owner_id TEXT NOT NULL, session_id TEXT NOT NULL, id TEXT NOT NULL,
                    sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime_type TEXT NOT NULL,
                    PRIMARY KEY(owner_id,session_id,id),
                    FOREIGN KEY(owner_id,session_id) REFERENCES conversation_sync_sessions(owner_id,id) ON DELETE CASCADE,
                    FOREIGN KEY(owner_id,sha256) REFERENCES conversation_sync_blobs(owner_id,sha256))""",
                """CREATE TABLE IF NOT EXISTS conversation_sync_mutations (
                    owner_id TEXT NOT NULL REFERENCES registered_accounts(user_id), generation INTEGER NOT NULL,
                    id TEXT NOT NULL, session_id TEXT NOT NULL, request_hash TEXT NOT NULL, revision INTEGER NOT NULL,
                    PRIMARY KEY(owner_id,generation,id))""",
                "CREATE INDEX IF NOT EXISTS sync_blob_size ON conversation_sync_blobs(size)",
                "CREATE INDEX IF NOT EXISTS sync_snapshot_size ON conversation_sync_sessions(snapshot_size)",
                "CREATE INDEX IF NOT EXISTS conversation_sync_file_hash ON conversation_sync_files(owner_id,sha256)",
                """CREATE TRIGGER IF NOT EXISTS sync_pause_on_invitation_revocation
                    AFTER UPDATE OF managed_eligible ON registered_accounts
                    WHEN OLD.managed_eligible=1 AND NEW.managed_eligible=0
                    BEGIN
                        UPDATE conversation_sync_settings SET enabled=0,generation=generation+1
                            WHERE owner_id=NEW.user_id AND enabled=1;
                    END""",
            ]
            for statement in statements:
                db.execute(statement)
            db.execute("""UPDATE conversation_sync_settings SET enabled=0,generation=generation+1
                WHERE enabled=1 AND owner_id IN (SELECT user_id FROM registered_accounts WHERE managed_eligible=0)""")
            self._clean_orphans(db)

    def _authorize(self, db, owner, token_hash, *, require_eligible=False):
        account = db.execute("SELECT disabled,managed_eligible FROM registered_accounts WHERE user_id=?", (owner,)).fetchone()
        valid = account is not None and not account["disabled"]
        if token_hash is not None:
            session = db.execute("""SELECT 1 FROM account_sessions WHERE user_id=? AND token_hash=?
                AND revoked_at IS NULL AND expires_at>?""", (owner, token_hash, time.time())).fetchone()
            valid = valid and session is not None
        if not valid:
            raise ChatError(401, "登录已过期，请重新登录。", {"X-Session-Expired": "1"})
        eligible = bool(account["managed_eligible"])
        if require_eligible and not eligible:
            raise ChatError(403, "云同步需要邀请码资格。", code="sync_invitation_required")
        return eligible

    @staticmethod
    def _state(db, owner):
        row = db.execute("SELECT enabled,generation,sequence FROM conversation_sync_settings WHERE owner_id=?",
                         (owner,)).fetchone()
        return ({"enabled": bool(row["enabled"]), "generation": row["generation"], "sequence": row["sequence"]}
                if row is not None else {"enabled": False, "generation": 0, "sequence": 0})

    def _active(self, db, owner, generation, token_hash):
        self._authorize(db, owner, token_hash, require_eligible=True)
        state = self._state(db, owner)
        if generation != state["generation"]:
            raise ChatError(409, "同步设置已变化，请刷新后重试。", code="sync_generation_changed")
        if not state["enabled"]:
            raise ChatError(409, "多端同步已关闭。", code="sync_disabled")
        return state

    @staticmethod
    def _clean_orphans(db, owner=None, *, immediate=False):
        parameters = []
        conditions = ["NOT EXISTS (SELECT 1 FROM conversation_sync_files f WHERE f.owner_id=b.owner_id AND f.sha256=b.sha256)"]
        if owner is not None:
            conditions.append("b.owner_id=?")
            parameters.append(owner)
        if not immediate:
            conditions.append("b.touched_at<=?")
            parameters.append(time.time() - ORPHAN_TTL_SECONDS)
        db.execute("DELETE FROM conversation_sync_blobs AS b WHERE " + " AND ".join(conditions), parameters)

    @staticmethod
    def _used_bytes(db, owner):
        return db.execute("""SELECT
            (SELECT COALESCE(SUM(snapshot_size),0) FROM conversation_sync_sessions WHERE owner_id=?) +
            (SELECT COALESCE(SUM(size),0) FROM conversation_sync_blobs WHERE owner_id=?)""", (owner, owner)).fetchone()[0]

    def _check_growth(self, db, amount):
        if amount <= 0:
            return
        used = sync_usage(db)
        settings = self.store.settings
        check_growth(settings.db_path, amount, used, settings.sync_pool_bytes, settings.disk_reserve_bytes)

    @staticmethod
    def _capacity(size):
        if size > MAX_ACCOUNT_BYTES:
            raise ChatError(413, "云端会话与附件已达到 512 MiB，请导出或清理后重试。", code="sync_storage_full")

    @staticmethod
    def _dto(db, owner, row, generation):
        files = db.execute("""SELECT id,sha256,size,mime_type FROM conversation_sync_files
            WHERE owner_id=? AND session_id=? ORDER BY id""", (owner, row["id"])).fetchall()
        return {"generation": generation, "id": row["id"], "revision": row["revision"],
                "deleted": bool(row["deleted"]), "content_hash": row["content_hash"],
                "snapshot": json.loads(row["snapshot"]) if row["snapshot"] is not None else None,
                "files": [dict(item) for item in files]}

    def status(self, owner, token_hash=None):
        with self.store.connection() as db:
            db.execute("BEGIN")
            eligible = self._authorize(db, owner, token_hash)
            return {**self._state(db, owner), "eligible": eligible}

    def configure(self, owner, payload, token_hash=None):
        _fields(payload, {"enabled", "expected_generation"})
        expected = _integer(payload["expected_generation"])
        enabled = payload["enabled"]
        if type(enabled) is not bool:
            _invalid()
        with self.store.connection(write=True) as db:
            eligible = self._authorize(db, owner, token_hash, require_eligible=enabled)
            state = self._state(db, owner)
            if expected != state["generation"]:
                raise ChatError(409, "同步设置已变化，请刷新后重试。", code="sync_generation_changed")
            if enabled != state["enabled"]:
                state.update(enabled=enabled, generation=state["generation"] + 1)
                db.execute("""INSERT INTO conversation_sync_settings VALUES(?,?,?,?)
                    ON CONFLICT(owner_id) DO UPDATE SET enabled=excluded.enabled,generation=excluded.generation""",
                           (owner, int(state["enabled"]), state["generation"], state["sequence"]))
            self._authorize(db, owner, token_hash, require_eligible=enabled)
            return {**state, "eligible": eligible}

    def clear(self, owner, payload, token_hash=None):
        _fields(payload, {"expected_generation"})
        expected = _integer(payload["expected_generation"])
        with self.store.connection(write=True) as db:
            eligible = self._authorize(db, owner, token_hash)
            state = self._state(db, owner)
            if expected != state["generation"]:
                raise ChatError(409, "同步设置已变化，请刷新后重试。", code="sync_generation_changed")
            state.update(enabled=False, generation=state["generation"] + 1)
            db.execute("DELETE FROM conversation_sync_sessions WHERE owner_id=?", (owner,))
            db.execute("DELETE FROM conversation_sync_blobs WHERE owner_id=?", (owner,))
            db.execute("DELETE FROM conversation_sync_documents WHERE owner_id=?", (owner,))
            db.execute("DELETE FROM conversation_sync_mutations WHERE owner_id=?", (owner,))
            db.execute("""INSERT INTO conversation_sync_settings VALUES(?,?,?,?) ON CONFLICT(owner_id)
                DO UPDATE SET enabled=0,generation=excluded.generation""",
                       (owner, 0, state["generation"], state["sequence"]))
            self._authorize(db, owner, token_hash)
            return {**state, "eligible": eligible}

    def document(self, owner, kind, generation, token_hash, *, expected=None, value=None):
        with self.store.connection(write=expected is not None) as db:
            if expected is None:
                db.execute("BEGIN")
            self._active(db, owner, generation, token_hash)
            row = db.execute("SELECT revision,value FROM conversation_sync_documents WHERE owner_id=? AND kind=?",
                             (owner, kind)).fetchone()
            revision, saved = (row["revision"], row["value"]) if row else (0, None)
            if expected is not None:
                if revision != expected:
                    raise SyncConflict(revision)
                encoded = None if value is None else _encoded(value).decode("utf-8")
                if row is None or encoded != saved:
                    revision += 1
                    saved = encoded
                    db.execute("""INSERT INTO conversation_sync_documents VALUES(?,?,?,?) ON CONFLICT(owner_id,kind)
                        DO UPDATE SET revision=excluded.revision,value=excluded.value""", (owner, kind, revision, saved))
            return {"generation": generation, "revision": revision, "value": json.loads(saved) if saved else None}

    def index(self, owner, generation, after, token_hash=None):
        generation, after = _integer(generation), _integer(after)
        with self.store.connection() as db:
            db.execute("BEGIN")
            self._active(db, owner, generation, token_hash)
            rows = db.execute("""SELECT id,revision,deleted,content_hash FROM conversation_sync_sessions
                WHERE owner_id=? AND revision>? ORDER BY revision LIMIT ?""", (owner, after, PAGE_SIZE + 1)).fetchall()
            entries = [{**dict(row), "deleted": bool(row["deleted"])} for row in rows[:PAGE_SIZE]]
            return {"generation": generation, "entries": entries,
                    "cursor": entries[-1]["revision"] if entries else after, "has_more": len(rows) > PAGE_SIZE}

    def read(self, owner, session_id, generation, token_hash=None):
        session_id, generation = _identity(session_id), _integer(generation)
        with self.store.connection() as db:
            db.execute("BEGIN")
            self._active(db, owner, generation, token_hash)
            row = db.execute("SELECT * FROM conversation_sync_sessions WHERE owner_id=? AND id=?",
                             (owner, session_id)).fetchone()
            if row is None:
                raise ChatError(404, "云端会话不存在。")
            return self._dto(db, owner, row, generation)

    def mutate(self, owner, session_id, payload, *, deleted=False, token_hash=None):
        required = {"generation", "expected_revision", "mutation_id"}
        _fields(payload, required if deleted else required | {"snapshot", "files"})
        session_id = _identity(session_id)
        generation, expected = _integer(payload["generation"]), _integer(payload["expected_revision"])
        mutation_id = _identity(payload["mutation_id"])
        snapshot, files, snapshot_bytes = None, [], b""
        if not deleted:
            if not isinstance(payload["snapshot"], dict):
                _invalid()
            snapshot_bytes = _encoded(payload["snapshot"])
            if len(snapshot_bytes) > MAX_SNAPSHOT_BYTES:
                raise ChatError(413, "单个云端会话超过 32 MiB，请拆分或导出后重试。")
            snapshot = snapshot_bytes.decode("utf-8")
            files = _files(payload["files"])
        content_hash = hashlib.sha256(_encoded({"snapshot": payload.get("snapshot"), "files": files,
                                               "deleted": deleted})).hexdigest()
        request_hash = hashlib.sha256(_encoded({"session_id": session_id, "deleted": deleted, **payload})).hexdigest()
        with self.store.connection(write=True) as db:
            state = self._active(db, owner, generation, token_hash)
            row = db.execute("SELECT * FROM conversation_sync_sessions WHERE owner_id=? AND id=?",
                             (owner, session_id)).fetchone()
            revision = row["revision"] if row is not None else 0
            previous = db.execute("""SELECT request_hash,revision FROM conversation_sync_mutations
                WHERE owner_id=? AND generation=? AND id=?""", (owner, generation, mutation_id)).fetchone()
            if previous is not None:
                if previous["request_hash"] != request_hash or previous["revision"] != revision:
                    raise SyncConflict(revision)
                return self._dto(db, owner, row, generation)
            if expected != revision:
                raise SyncConflict(revision)
            self._check_growth(db, len(snapshot_bytes) - (row["snapshot_size"] if row else 0))
            for file in files:
                blob = db.execute("SELECT size FROM conversation_sync_blobs WHERE owner_id=? AND sha256=?",
                                  (owner, file["sha256"])).fetchone()
                if blob is None or blob["size"] != file["size"]:
                    raise ChatError(409, "附件尚未完整上传，请重试同步。", code="sync_blob_missing")
            revision = state["sequence"] + 1
            db.execute("UPDATE conversation_sync_settings SET sequence=? WHERE owner_id=?", (revision, owner))
            db.execute("""INSERT INTO conversation_sync_sessions VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,id)
                DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,content_hash=excluded.content_hash,
                snapshot=excluded.snapshot,snapshot_size=excluded.snapshot_size""",
                       (owner, session_id, revision, int(deleted), content_hash, snapshot, len(snapshot_bytes)))
            old_hashes = {item[0] for item in db.execute("SELECT sha256 FROM conversation_sync_files WHERE owner_id=? AND session_id=?",
                                                      (owner, session_id)).fetchall()}
            db.execute("DELETE FROM conversation_sync_files WHERE owner_id=? AND session_id=?", (owner, session_id))
            for file in files:
                db.execute("INSERT INTO conversation_sync_files VALUES(?,?,?,?,?,?)",
                           (owner, session_id, file["id"], file["sha256"], file["size"], file["mime_type"]))
            db.execute("INSERT INTO conversation_sync_mutations VALUES(?,?,?,?,?,?)",
                       (owner, generation, mutation_id, session_id, request_hash, revision))
            # Only retire the replaced session's now-unreferenced files. Recent
            # staged uploads for another conversation retain their recovery window.
            for checksum in old_hashes - {item["sha256"] for item in files}:
                db.execute("""DELETE FROM conversation_sync_blobs WHERE owner_id=? AND sha256=? AND NOT EXISTS
                    (SELECT 1 FROM conversation_sync_files WHERE owner_id=? AND sha256=?)""",
                           (owner, checksum, owner, checksum))
            self._clean_orphans(db, owner)
            # Account for the resulting state. A replacement may free more
            # attachment data than its larger snapshot adds; failures roll back.
            self._capacity(self._used_bytes(db, owner))
            self._authorize(db, owner, token_hash)
            row = db.execute("SELECT * FROM conversation_sync_sessions WHERE owner_id=? AND id=?", (owner, session_id)).fetchone()
            return self._dto(db, owner, row, generation)

    def upload(self, owner, checksum, generation, raw, token_hash=None):
        generation = _integer(generation)
        if not isinstance(checksum, str) or not SHA256.fullmatch(checksum):
            _invalid()
        if len(raw) > MAX_BLOB_BYTES:
            raise ChatError(413, "单个同步附件超过 64 MiB。")
        if hashlib.sha256(raw).hexdigest() != checksum:
            raise ChatError(422, "附件校验失败，请重新同步。", code="sync_blob_invalid")
        with self.store.connection(write=True) as db:
            self._active(db, owner, generation, token_hash)
            self._clean_orphans(db, owner)
            previous = db.execute("SELECT size FROM conversation_sync_blobs WHERE owner_id=? AND sha256=?",
                                  (owner, checksum)).fetchone()
            self._check_growth(db, 0 if previous else len(raw))
            self._capacity(self._used_bytes(db, owner) + (0 if previous is not None else len(raw)))
            db.execute("""INSERT INTO conversation_sync_blobs VALUES(?,?,?,?,?) ON CONFLICT(owner_id,sha256)
                DO UPDATE SET touched_at=excluded.touched_at""", (owner, checksum, len(raw), raw, time.time()))
            self._authorize(db, owner, token_hash)
            return {"sha256": checksum, "size": len(raw)}

    def blob(self, owner, checksum, generation, token_hash=None):
        generation = _integer(generation)
        if not isinstance(checksum, str) or not SHA256.fullmatch(checksum):
            _invalid()
        with self.store.connection() as db:
            db.execute("BEGIN")
            self._active(db, owner, generation, token_hash)
            row = db.execute("SELECT data FROM conversation_sync_blobs WHERE owner_id=? AND sha256=?",
                             (owner, checksum)).fetchone()
            if row is None:
                raise ChatError(404, "同步附件不存在。")
            return bytes(row["data"])


def build_conversation_sync_router(store, sync, public_origin=None):
    router = APIRouter(prefix="/chat/api/conversation-sync")
    origin = (public_origin or os.environ.get("PUBLIC_ORIGIN", "https://digimonlegend.com")).rstrip("/")

    async def owner(request):
        if not _origin_ok(request, origin):
            raise ChatError(403, "请从当前应用管理同步。")
        token = _token(request)
        account = await asyncio.to_thread(store.accounts.authenticate, token)
        if account is None:
            raise ChatError(401, "登录已过期，请重新登录。", {"X-Session-Expired": "1"})
        if request.headers.get("X-Chat-User-Id") != str(account):
            raise ChatError(409, "账号已切换，请刷新页面后继续。", {"X-Session-Changed": "1"})
        return account, digest(token)

    async def execute(request, action, *, body=False, body_limit=MAX_REQUEST_BYTES):
        try:
            account, token_hash = await owner(request)
            payload = None
            if body:
                raw = await _body(request, body_limit, "同步请求超过大小上限，请拆分会话后重试。")
                payload = _parse(raw)
            result = await action(account, token_hash, payload)
            return result if isinstance(result, Response) else JSONResponse(result, headers=HEADERS)
        except ChatError as error:
            if isinstance(error, SyncConflict):
                return JSONResponse({"error": {"message": error.message, "code": error.code},
                                     "current_revision": error.current_revision}, status_code=409, headers=HEADERS)
            return _error(error.status, error.message, {**HEADERS, **error.headers}, error.code)
        except (OSError, sqlite3.Error):
            logger.error("Conversation sync storage operation failed")
            return _error(503, "云端同步暂时不可用，请稍后重试。", HEADERS)

    def query_integer(request, name, default=None):
        values = request.query_params.getlist(name)
        if not values and default is not None:
            return default
        if len(values) != 1 or not re.fullmatch(r"0|[1-9][0-9]{0,15}", values[0]):
            _invalid()
        return _integer(int(values[0]))

    @router.get("")
    async def status(request: Request):
        async def action(account, token_hash, _payload):
            return await asyncio.to_thread(sync.status, account, token_hash)
        return await execute(request, action)

    @router.patch("")
    async def configure(request: Request):
        async def action(account, token_hash, payload):
            return await asyncio.to_thread(sync.configure, account, payload, token_hash)
        return await execute(request, action, body=True)

    @router.delete("")
    async def clear(request: Request):
        async def action(account, token_hash, payload):
            return await asyncio.to_thread(sync.clear, account, payload, token_hash)
        return await execute(request, action, body=True)

    @router.api_route("/preferences", methods=["GET", "PUT"])
    @router.api_route("/key-envelope", methods=["GET", "PUT", "DELETE"])
    async def sync_document(request: Request):
        kind = request.url.path.rsplit("/", 1)[-1]
        async def action(account, token_hash, payload):
            if request.method == "GET":
                return await asyncio.to_thread(sync.document, account, kind, query_integer(request, "generation"), token_hash)
            fields = {"generation", "expected_revision"}
            if request.method == "PUT":
                fields.add("value")
            _fields(payload, fields)
            value = payload.get("value")
            if request.method == "PUT":
                if kind == "preferences":
                    _validate_preferences(value)
                else:
                    _validate_key_envelope(value)
            return await asyncio.to_thread(sync.document, account, kind, _integer(payload["generation"]), token_hash,
                                           expected=_integer(payload["expected_revision"]), value=value)
        return await execute(request, action, body=request.method != "GET", body_limit=16384 if kind == "preferences" else 8192)

    @router.get("/index")
    async def index(request: Request):
        async def action(account, token_hash, _payload):
            return await asyncio.to_thread(sync.index, account, query_integer(request, "generation"),
                                           query_integer(request, "after", 0), token_hash)
        return await execute(request, action)

    @router.get("/sessions/{session_id}")
    async def read(request: Request, session_id: str):
        async def action(account, token_hash, _payload):
            return await asyncio.to_thread(sync.read, account, session_id,
                                           query_integer(request, "generation"), token_hash)
        return await execute(request, action)

    @router.put("/sessions/{session_id}")
    async def write(request: Request, session_id: str):
        async def action(account, token_hash, payload):
            return await asyncio.to_thread(sync.mutate, account, session_id, payload, token_hash=token_hash)
        return await execute(request, action, body=True)

    @router.delete("/sessions/{session_id}")
    async def delete(request: Request, session_id: str):
        async def action(account, token_hash, payload):
            return await asyncio.to_thread(sync.mutate, account, session_id, payload, deleted=True, token_hash=token_hash)
        return await execute(request, action, body=True)

    @router.put("/blobs/{checksum}")
    async def upload(request: Request, checksum: str):
        async def action(account, token_hash, _payload):
            generation = query_integer(request, "generation")
            # Refuse closed or superseded consent before accepting the bytes.
            await asyncio.to_thread(sync.index, account, generation, 0, token_hash)
            raw = await _body(request, MAX_BLOB_BYTES, "单个同步附件超过 64 MiB。")
            return await asyncio.to_thread(sync.upload, account, checksum, generation, raw, token_hash)
        return await execute(request, action)

    @router.get("/blobs/{checksum}")
    async def blob(request: Request, checksum: str):
        async def action(account, token_hash, _payload):
            raw = await asyncio.to_thread(sync.blob, account, checksum, query_integer(request, "generation"), token_hash)
            return Response(raw, media_type="application/octet-stream", headers=HEADERS)
        return await execute(request, action)

    return router
