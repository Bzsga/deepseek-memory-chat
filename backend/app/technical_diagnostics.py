"""Bounded technical events for Android, web and managed requests."""
import asyncio
from collections import Counter
import hmac
import secrets
import sqlite3
import threading
import time
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from starlette.requests import ClientDisconnect

from .admin_access import _client_ip, admin_authorizer


TECHNICAL_DIAGNOSTICS_PATH = "/v1/technical-diagnostics/events"
ADMIN_TECHNICAL_DIAGNOSTICS_PATH = "/v1/admin/technical-diagnostics"
MAX_TECHNICAL_DIAGNOSTIC_BODY_BYTES = 32 * 1024
RETENTION_DAYS = 30
RETENTION_SECONDS = RETENTION_DAYS * 86400
MAX_CLIENT_EVENTS = 24_000
MAX_SERVER_EVENTS = 12_000
MAX_REQUESTS_PER_PEER_HOUR = 120
MAX_REQUESTS_TOTAL_PER_HOUR = 1_200

Area = Literal["startup", "webview", "runtime", "chat", "image", "import", "attachment", "account", "sync", "update", "organization"]
Code = Literal["timeout", "load_failed", "update_required", "http_error", "network_error", "crash", "render_gone", "invalid_response",
               "operation_failed", "storage_error", "integrity_error", "unexpected_error"]
Stage = Literal["initialize", "navigate", "document", "render", "request", "response", "download", "verify", "save",
                "read", "parse", "upload", "apply", "install"]


DETAILS_BY_AREA = {
    "import": frozenset({
        "import_empty", "import_size_limit", "import_unsupported_file", "import_no_conversations",
        "import_zip_validation", "import_zip_read", "import_json_syntax", "import_json_structure",
        "import_json_read", "import_validation", "import_save",
    }),
    "webview": frozenset({
        "webview_navigation", "webview_document", "webview_visual_callback", "webview_page_ready",
    }),
    "organization": frozenset({
        "authentication_rejected", "network_before_headers", "network_reading_body",
        "invalid_model_response", "upstream_http", "organization_local",
        "model_envelope_invalid", "model_finish_incomplete", "model_content_blank", "model_entries_invalid",
    }),
}
InputSizeBand = Literal["empty", "up_to_256_kib", "up_to_1_mib", "up_to_8_mib", "up_to_32_mib", "over_32_mib"]
TECHNICAL_CONTEXT_COLUMNS = ("detail", "input_format", "input_size_band", "service_mode")


def _canonical_uuid(value):
    if value is None or (len(value) == 36 and str(UUID(value)) == value):
        return value
    raise ValueError("Expected canonical UUID")


class TechnicalEvent(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    event_id: str = Field(min_length=36, max_length=36)
    occurred_at: int = Field(ge=0, le=4_102_444_800)
    source: Literal["android", "web", "server"]
    release: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9._+\-]+$")
    area: Area
    code: Code
    stage: Stage | None = None
    android_sdk: int | None = Field(default=None, ge=1, le=1000)
    manufacturer: str | None = Field(default=None, min_length=1, max_length=80, pattern=r"^[A-Za-z0-9 ._()+\-]+$")
    model: str | None = Field(default=None, min_length=1, max_length=80, pattern=r"^[A-Za-z0-9 ._()+\-]+$")
    webview_version: str | None = Field(default=None, max_length=40, pattern=r"^[0-9]+(?:\.[0-9]+)*$")
    webview_provider: str | None = Field(default=None, min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.]+$")
    http_status: int | None = Field(default=None, ge=100, le=599)
    elapsed_ms: int | None = Field(default=None, ge=0, le=86_400_000)
    request_id: str | None = Field(default=None, min_length=36, max_length=36)
    detail: str | None = Field(default=None, max_length=40)
    input_format: Literal["json", "zip", "unknown"] | None = None
    input_size_band: InputSizeBand | None = None
    service_mode: Literal["personal", "managed"] | None = None

    @field_validator("event_id", "request_id")
    @classmethod
    def canonical_uuid(cls, value):
        return _canonical_uuid(value)

    @model_validator(mode="after")
    def provider_requires_android(self):
        if self.webview_provider is not None and (self.android_sdk is None or self.source == "server"):
            raise ValueError("WebView provider requires an Android context")
        if self.code == "update_required" and (self.source, self.area, self.stage) != ("android", "webview", "initialize"):
            raise ValueError("WebView update notice requires Android initialization")
        if self.detail is not None and (self.source != "android" or
                                        self.detail not in DETAILS_BY_AREA.get(self.area, ())):
            raise ValueError("Unexpected event detail")
        if (self.input_format is not None or self.input_size_band is not None) and (
                self.source != "android" or self.area != "import"):
            raise ValueError("Unexpected import metadata")
        if self.service_mode is not None and (self.source != "android" or self.area != "organization"):
            raise ValueError("Unexpected service mode")
        if self.service_mode == "personal" and self.request_id is not None:
            raise ValueError("Personal upstream identifiers are not accepted")
        return self


class ClientTechnicalEvent(TechnicalEvent):
    source: Literal["android", "web"]


class TechnicalEventBatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    events: list[ClientTechnicalEvent] = Field(min_length=1, max_length=20)


class DiagnosticResolution(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    resolved: bool
    group: bool = False
    since: int = Field(default=0, ge=0, le=4_102_444_800)


_FIELDS = tuple(TechnicalEvent.model_fields)
_FIELD_LIST = ",".join(_FIELDS)
_INSERT = f"INSERT INTO technical_diagnostic_events ({_FIELD_LIST},received_at) VALUES ({','.join('?' for _ in range(len(_FIELDS) + 1))})"


class TechnicalDiagnostics:
    def __init__(self, store):
        self.store = store
        self._rate_lock = threading.Lock()
        self._rate_secret = secrets.token_bytes(32)
        self._hour = -1
        self._peer_requests = Counter()
        self._hour_requests = 0

    def initialize(self):
        with self.store.connection(write=True) as db:
            db.execute("""CREATE TABLE IF NOT EXISTS technical_diagnostic_events (
                event_id TEXT PRIMARY KEY NOT NULL, occurred_at INTEGER NOT NULL,
                received_at INTEGER NOT NULL, source TEXT NOT NULL, release TEXT NOT NULL,
                area TEXT NOT NULL, code TEXT NOT NULL, stage TEXT, android_sdk INTEGER,
                manufacturer TEXT, model TEXT, webview_version TEXT, webview_provider TEXT, http_status INTEGER,
                elapsed_ms INTEGER, request_id TEXT, resolved_at INTEGER
            )""")
            columns = {column["name"] for column in db.execute("PRAGMA table_info(technical_diagnostic_events)")}
            if "resolved_at" not in columns:
                db.execute("ALTER TABLE technical_diagnostic_events ADD COLUMN resolved_at INTEGER")
            for column in TECHNICAL_CONTEXT_COLUMNS:
                if column not in columns:
                    db.execute(f"ALTER TABLE technical_diagnostic_events ADD COLUMN {column} TEXT")
            db.execute("CREATE INDEX IF NOT EXISTS technical_diagnostics_received ON technical_diagnostic_events(received_at)")
            db.execute("""CREATE INDEX IF NOT EXISTS technical_diagnostics_group
                ON technical_diagnostic_events(source,area,code,stage,received_at)""")
            db.execute("""CREATE INDEX IF NOT EXISTS technical_diagnostics_request
                ON technical_diagnostic_events(request_id,received_at) WHERE request_id IS NOT NULL""")
            self._purge(db, int(time.time()))

    @staticmethod
    def _purge(db, now):
        return db.execute("DELETE FROM technical_diagnostic_events WHERE received_at<?", (now - RETENTION_SECONDS,)).rowcount

    def purge_expired(self):
        with self.store.connection(write=True) as db:
            return self._purge(db, int(time.time()))

    async def cleanup(self):
        while True:
            await asyncio.sleep(3600)
            try:
                await asyncio.to_thread(self.purge_expired)
            except sqlite3.Error:
                # Retry during the next pass or write without disturbing service traffic.
                continue

    def allow_request(self, ip):
        hour = int(time.monotonic() // 3600)
        peer = hmac.digest(self._rate_secret, ip.encode("utf-8"), "sha256")
        with self._rate_lock:
            if self._hour != hour:
                self._hour = hour
                self._peer_requests.clear()
                self._hour_requests = 0
            if self._peer_requests[peer] >= MAX_REQUESTS_PER_PEER_HOUR or self._hour_requests >= MAX_REQUESTS_TOTAL_PER_HOUR:
                raise HTTPException(429, "诊断请求较多，请稍后重试", headers={"Retry-After": "3600"})
            self._peer_requests[peer] += 1
            self._hour_requests += 1

    def accept(self, batch):
        now = int(time.time())
        accepted = {}
        with self.store.connection(write=True) as db:
            self._purge(db, now)
            pending = {}
            for event in batch.events:
                values = event.model_dump()
                event_id = event.event_id
                previous = accepted.get(event_id)
                if previous is None:
                    row = db.execute(f"SELECT {_FIELD_LIST} FROM technical_diagnostic_events WHERE event_id=?", (event_id,)).fetchone()
                    previous = dict(row) if row is not None else None
                if previous is not None and previous != values:
                    raise HTTPException(409, "诊断编号已用于其他事件")
                if previous is None and event.occurred_at >= now - RETENTION_SECONDS:
                    pending[event_id] = values
                accepted[event_id] = values
            if pending:
                used = db.execute("SELECT COUNT(*) FROM technical_diagnostic_events WHERE source IN ('android','web')").fetchone()[0]
                if used + len(pending) > MAX_CLIENT_EVENTS:
                    raise HTTPException(429, "诊断存储暂已达到上限", headers={"Retry-After": "3600"})
                db.executemany(_INSERT, [tuple(values[key] for key in _FIELDS) + (now,) for values in pending.values()])
        return {"accepted_event_ids": list(accepted)}

    def record_server(self, area, code, stage, http_status, request_id, release="server"):
        now = int(time.time())
        event = TechnicalEvent(event_id=str(uuid4()), occurred_at=now, source="server", release=release,
                               area=area, code=code, stage=stage, http_status=http_status, request_id=request_id)
        with self.store.connection(write=True) as db:
            self._purge(db, now)
            used = db.execute("SELECT COUNT(*) FROM technical_diagnostic_events WHERE source='server'").fetchone()[0]
            if used >= MAX_SERVER_EVENTS:
                db.execute("""DELETE FROM technical_diagnostic_events WHERE event_id IN (
                    SELECT event_id FROM technical_diagnostic_events WHERE source='server'
                    ORDER BY received_at,event_id LIMIT ?)""", (used - MAX_SERVER_EVENTS + 1,))
            db.execute(_INSERT, tuple(getattr(event, field) for field in _FIELDS) + (now,))
        return event.event_id

    def groups(self, since=0, limit=50, status="pending"):
        since = max(since, int(time.time()) - RETENTION_SECONDS)
        resolved = status == "resolved"
        with self.store.connection() as db:
            db.execute("BEGIN")
            rows = db.execute("""SELECT source,area,code,stage,COUNT(*) AS count,
                MIN(MIN(occurred_at,received_at)) AS first_at,MAX(MIN(occurred_at,received_at)) AS last_at,
                MAX(received_at) AS last_received_at
                FROM technical_diagnostic_events WHERE received_at>=? AND (resolved_at IS NOT NULL)=?
                GROUP BY source,area,code,stage ORDER BY last_received_at DESC,count DESC,source,area,code,stage LIMIT ?""",
                (since, resolved, limit)).fetchall()
            return [self._group_details(db, dict(row), since, resolved) for row in rows]

    @staticmethod
    def _group_details(db, group, since, resolved):
        scope = """FROM technical_diagnostic_events WHERE source=? AND area=? AND code=? AND stage IS ?
            AND received_at>=? AND (resolved_at IS NOT NULL)=?"""
        args = (group["source"], group["area"], group["code"], group["stage"], since, resolved)
        releases = db.execute(f"SELECT release,COUNT(*) AS count {scope} GROUP BY release ORDER BY count DESC,release LIMIT 8", args)
        group["releases"] = [dict(row) for row in releases]
        models = db.execute(f"""SELECT manufacturer,model,COUNT(*) AS count {scope}
            AND model IS NOT NULL GROUP BY manufacturer,model ORDER BY count DESC,manufacturer,model LIMIT 8""", args)
        group["models"] = [dict(row) for row in models]
        # The last inserted row anchors group updates to the selected snapshot.
        group["latest_event_id"] = db.execute(
            f"SELECT event_id {scope} ORDER BY rowid DESC LIMIT 1", args).fetchone()["event_id"]
        return group

    def set_resolution(self, event_id, resolved, group=False, since=0):
        now = int(time.time())
        since = max(since if group else 0, now - RETENTION_SECONDS)
        with self.store.connection(write=True) as db:
            anchor = db.execute("""SELECT rowid,source,area,code,stage FROM technical_diagnostic_events
                WHERE event_id=? AND received_at>=?""", (event_id, since)).fetchone()
            if anchor is None:
                raise HTTPException(404, "找不到所选诊断记录，请刷新后重试", headers={"Cache-Control": "no-store"})
            resolved_at = now if resolved else None
            if group:
                return db.execute("""UPDATE technical_diagnostic_events SET resolved_at=?
                    WHERE (resolved_at IS NOT NULL)<>? AND source=? AND area=? AND code=? AND stage IS ?
                      AND received_at>=? AND rowid<=?""",
                    (resolved_at, resolved, anchor["source"], anchor["area"], anchor["code"], anchor["stage"],
                     since, anchor["rowid"])).rowcount
            return db.execute("""UPDATE technical_diagnostic_events SET resolved_at=?
                WHERE event_id=? AND (resolved_at IS NOT NULL)<>?""", (resolved_at, event_id, resolved)).rowcount

    def event(self, event_id):
        with self.store.connection() as db:
            row = db.execute("SELECT * FROM technical_diagnostic_events WHERE event_id=? AND received_at>=?",
                             (event_id, int(time.time()) - RETENTION_SECONDS)).fetchone()
        return dict(row) if row else None

    def related_events(self, request_id, event_id):
        with self.store.connection() as db:
            rows = db.execute("""SELECT * FROM technical_diagnostic_events
                WHERE request_id=? AND received_at>=? AND event_id<>?
                ORDER BY received_at DESC,event_id DESC LIMIT 10""",
                (request_id, int(time.time()) - RETENTION_SECONDS, event_id)).fetchall()
        return [dict(row) for row in rows]


def build_technical_diagnostics_router(store, diagnostics, public_origin):
    router = APIRouter()
    require_admin = admin_authorizer(store)
    origin = public_origin.rstrip("/")

    @router.post(TECHNICAL_DIAGNOSTICS_PATH)
    async def submit(request: Request, response: Response):
        request_origin = request.headers.get("origin")
        if request_origin is not None and request_origin != origin:
            raise HTTPException(403, "诊断请求来源不受支持")
        if request.headers.get("content-type", "").partition(";")[0].strip().lower() != "application/json":
            raise HTTPException(415, "诊断请求必须为 JSON")
        diagnostics.allow_request(_client_ip(request))
        content = bytearray()
        try:
            async for chunk in request.stream():
                if len(content) + len(chunk) > MAX_TECHNICAL_DIAGNOSTIC_BODY_BYTES:
                    raise HTTPException(413, "诊断请求超过大小上限")
                content.extend(chunk)
            batch = TechnicalEventBatch.model_validate_json(content)
        except ClientDisconnect:
            raise HTTPException(400, "诊断请求未接收完整") from None
        except ValidationError:
            raise HTTPException(422, "诊断请求格式不正确") from None
        response.headers["Cache-Control"] = "no-store"
        return await asyncio.to_thread(diagnostics.accept, batch)

    @router.get(ADMIN_TECHNICAL_DIAGNOSTICS_PATH, dependencies=[Depends(require_admin)])
    def list_diagnostics(response: Response, limit: int = Query(default=50, ge=1, le=100),
                         since: int = Query(default=0, ge=0, le=4_102_444_800),
                         status: Literal["pending", "resolved"] = Query(default="pending"),
                         event_id: str | None = Query(default=None, max_length=36)):
        response.headers["Cache-Control"] = "no-store"
        if event_id is not None:
            try:
                _canonical_uuid(event_id)
            except ValueError:
                raise HTTPException(422, "诊断编号格式不正确") from None
            event = diagnostics.event(event_id)
            related = diagnostics.related_events(event["request_id"], event_id) if event and event["request_id"] else []
            return {"event": event, "related_events": related, "retention_days": RETENTION_DAYS,
                    "supports_resolution": True}
        return {"groups": diagnostics.groups(since, limit, status), "retention_days": RETENTION_DAYS,
                "supports_resolution": True}

    @router.put(ADMIN_TECHNICAL_DIAGNOSTICS_PATH + "/{event_id}/resolution", dependencies=[Depends(require_admin)])
    def set_diagnostic_resolution(event_id: str, body: DiagnosticResolution, response: Response):
        response.headers["Cache-Control"] = "no-store"
        try:
            _canonical_uuid(event_id)
        except ValueError:
            raise HTTPException(422, "诊断编号格式不正确", headers={"Cache-Control": "no-store"}) from None
        return {"updated": diagnostics.set_resolution(event_id, body.resolved, body.group, body.since)}

    return router
