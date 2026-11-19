import hashlib
import hmac
import ipaddress
import os
import secrets
import time
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .schemas import AccountLoginRequest, AdminConfigPatch
from .store import PROVIDER_REQUEST_USAGE_SQL, SHANGHAI, local_day, local_week, reset_at


SESSION_SECONDS = 12 * 60 * 60
TERMINAL_STATUSES = ("completed", "failed", "uncertain", "cancelled")


class UserQuotaPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    weekly_limit: int | None = Field(default=None, ge=0, le=1_000_000)
    this_week_remaining: int | None = Field(default=None, ge=0, le=1_000_000)
    week: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")

    @model_validator(mode="after")
    def valid_changes(self):
        for field in ("this_week_remaining", "week"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError("本周次数及日期不能为 null")
        if self.week is not None:
            try:
                if date.fromisoformat(self.week).weekday() != 0:
                    raise ValueError
            except ValueError:
                raise ValueError("周次须为北京时间周一日期") from None
        return self


class AccountStatusPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool


class RegistrationInviteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    count: int = Field(default=1, ge=1, le=100)
    valid_days: int = Field(default=7, ge=1, le=365)


def _hash(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _iso(timestamp):
    return datetime.fromtimestamp(timestamp, SHANGHAI).isoformat()


def _client_ip(request):
    host = request.client.host if request.client is not None else "unknown"
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return host
    if address.is_loopback:
        forwarded = request.headers.get("x-real-ip")
        if forwarded:
            try:
                return str(ipaddress.ip_address(forwarded.strip()))
            except ValueError:
                pass
    return str(address)


def initialize_admin(store):
    with store.connection(write=True) as db:
        db.execute("""CREATE TABLE IF NOT EXISTS admin_sessions (
            token_hash TEXT PRIMARY KEY, created_at REAL NOT NULL, expires_at REAL NOT NULL
        )""")
        if "parent_hash" not in {col["name"] for col in db.execute("PRAGMA table_info(admin_sessions)")}:
            db.execute("ALTER TABLE admin_sessions ADD COLUMN parent_hash TEXT")
        db.execute("DELETE FROM admin_sessions WHERE parent_hash IS NULL OR expires_at<=?", (time.time(),))


def _account_session(db, token_hash):
    return db.execute("""SELECT a.role,s.expires_at FROM account_sessions s
        JOIN registered_accounts a ON a.user_id=s.user_id WHERE token_hash=? AND s.revoked_at IS NULL
        AND s.expires_at>? AND a.disabled=0""", (token_hash, time.time())).fetchone()


def admin_cookie_active(store, request):
    cookie = request.cookies.get("deepseek_session", "")
    if not cookie or len(cookie) > 256:
        return False
    with store.connection() as db:
        row = _account_session(db, _hash(cookie))
        return row is not None and row["role"] == "admin"


def require_admin_origin(request):
    origin = os.environ.get("PUBLIC_ORIGIN", "https://digimonlegend.com").rstrip("/")
    if request.headers.get("origin") != origin:
        raise HTTPException(403, "请从本站管理页面发起操作")


def _management_session(store, parent):
    if not parent or len(parent) > 256:
        raise HTTPException(401, "请先登录管理员账号")
    token = secrets.token_urlsafe(32)
    now = time.time()
    parent_hash = _hash(parent)
    with store.connection(write=True) as db:
        account = _account_session(db, parent_hash)
        if account is None:
            raise HTTPException(401, "请先登录管理员账号")
        if account["role"] != "admin":
            raise HTTPException(403, "当前账号没有管理权限")
        db.execute("DELETE FROM admin_sessions WHERE expires_at<=?", (now,))
        expires = min(account["expires_at"], now + SESSION_SECONDS)
        db.execute("INSERT INTO admin_sessions(token_hash,created_at,expires_at,parent_hash) VALUES(?,?,?,?)",
                   (_hash(token), now, expires, parent_hash))
    return {"token": token, "expires_at": _iso(expires)}


def _statistics(store, days):
    now = time.time()
    end = datetime.fromtimestamp(now, SHANGHAI).date()
    start = end - timedelta(days=days - 1)
    start_date, end_date = start.isoformat(), end.isoformat()
    start_at = datetime(start.year, start.month, start.day, tzinfo=SHANGHAI).timestamp()
    after_end = end + timedelta(days=1)
    end_at = datetime(after_end.year, after_end.month, after_end.day, tzinfo=SHANGHAI).timestamp()
    daily = {}
    for offset in range(days):
        date = (start + timedelta(days=offset)).isoformat()
        daily[date] = {"date": date, "new_users": 0, "active_users": 0, "requests": 0,
                       "usage_known_requests": 0, "usage_unknown_requests": 0,
                       "input_tokens": 0, "output_tokens": 0,
                       **{status: 0 for status in TERMINAL_STATUSES}}
    with store.connection() as db:
        db.execute("BEGIN")
        settings = store._settings(db)
        totals = {"users": int(db.execute("SELECT COUNT(*) FROM registered_accounts").fetchone()[0])}
        totals["active_users"] = int(db.execute(
            """SELECT COUNT(DISTINCT activity.user_id) FROM user_activity AS activity
               JOIN registered_accounts AS account ON account.user_id=activity.user_id
               WHERE activity.day BETWEEN ? AND ?""",
            (start_date, end_date),
        ).fetchone()[0])
        for row in db.execute("""SELECT strftime('%Y-%m-%d',created_at,'unixepoch','+8 hours') AS date,
                COUNT(*) AS new_users FROM registered_accounts WHERE created_at>=? AND created_at<? GROUP BY date""",
                (start_at, end_at)):
            daily[row["date"]]["new_users"] = int(row["new_users"])
        for row in db.execute("""SELECT activity.day,COUNT(*) AS active_users FROM user_activity AS activity
                JOIN registered_accounts AS account ON account.user_id=activity.user_id
                WHERE activity.day BETWEEN ? AND ? GROUP BY activity.day""", (start_date, end_date)):
            daily[row["day"]]["active_users"] = int(row["active_users"])
        for row in db.execute(f"""WITH provider_request_usage AS ({PROVIDER_REQUEST_USAGE_SQL})
                SELECT count_day,COUNT(*) AS requests,
                SUM(CASE WHEN usage_known=1 THEN 1 ELSE 0 END) AS usage_known_requests,
                SUM(CASE WHEN usage_known=1 THEN 0 ELSE 1 END) AS usage_unknown_requests,
                COALESCE(SUM(CASE WHEN usage_known=1 THEN input_tokens ELSE 0 END),0) AS input_tokens,
                COALESCE(SUM(CASE WHEN usage_known=1 THEN output_tokens ELSE 0 END),0) AS output_tokens
                FROM provider_request_usage WHERE count_day BETWEEN ? AND ? GROUP BY count_day""",
                (start_date, end_date)):
            for field in ("requests", "usage_known_requests", "usage_unknown_requests", "input_tokens", "output_tokens"):
                daily[row["count_day"]][field] = int(row[field])
        for row in db.execute("""SELECT strftime('%Y-%m-%d',created_at,'unixepoch','+8 hours') AS date,
                status,COUNT(*) AS count FROM jobs WHERE created_at>=? AND created_at<?
                AND status IN ('completed','failed','uncertain','cancelled') GROUP BY date,status""",
                (start_at, end_at)):
            daily[row["date"]][row["status"]] = int(row["count"])
        for field in ("new_users", "requests", "usage_known_requests", "usage_unknown_requests",
                      "input_tokens", "output_tokens", *TERMINAL_STATUSES):
            totals[field] = sum(day[field] for day in daily.values())
        for status in ("queued", "running"):
            totals[status] = int(db.execute("SELECT COUNT(*) FROM jobs WHERE status=?", (status,)).fetchone()[0])
        quota = store.weekly_quota(db, settings=settings, timestamp=now)
        this_week = {field: int(quota[field]) for field in ("weekly_limit", "weekly_used", "weekly_reserved", "weekly_remaining")}
        this_week["reset_at"] = quota.get("reset_at", reset_at(now))
        totals["calls_by_kind"] = {kind: 0 for kind in ("organize", "chat", "file", "asr", "tts", "image")}
        for row in db.execute("""SELECT kind,COUNT(*) AS count FROM chat_calls
                WHERE started_at>=? AND started_at<? GROUP BY kind""", (start_at, end_at)):
            totals["calls_by_kind"][row["kind"]] = int(row["count"])
        totals["calls_by_kind"]["organize"] = totals["requests"] - sum(totals["calls_by_kind"].values())
    return {"timezone": "Asia/Shanghai", "days": days, "start_date": start_date, "end_date": end_date,
            "generated_at": _iso(now), "totals": totals, "this_week": this_week, "daily": list(daily.values())}


def _users(store, limit, offset):
    now = time.time()
    week = local_week(now)
    users = []
    with store.connection() as db:
        db.execute("BEGIN")
        settings = store._settings(db)
        total = int(db.execute("SELECT COUNT(*) FROM registered_accounts").fetchone()[0])
        rows = db.execute(f"""WITH provider_request_usage AS ({PROVIDER_REQUEST_USAGE_SQL}), page AS (
                SELECT u.id,u.access_mode,a.created_at,u.last_seen,a.username,a.registration_kind,a.weekly_limit_override,a.disabled,a.managed_eligible,a.role
                FROM registered_accounts AS a JOIN users AS u ON u.id=a.user_id
                ORDER BY a.created_at DESC,u.id LIMIT ? OFFSET ?
            ), request_totals AS (
                SELECT owner_id,SUM(count_day>=? AND count_day<?) AS weekly_used,COUNT(*) AS total_requests,
                    SUM(usage_known=1) AS usage_known_requests,SUM(usage_known<>1) AS usage_unknown_requests,
                    SUM(CASE WHEN usage_known=1 THEN input_tokens ELSE 0 END) AS input_tokens,
                    SUM(CASE WHEN usage_known=1 THEN output_tokens ELSE 0 END) AS output_tokens
                FROM provider_request_usage WHERE owner_id IN (SELECT id FROM page) GROUP BY owner_id
            ), job_totals AS (
                SELECT owner_id,SUM(count_state='reserved') AS weekly_reserved,
                    SUM(status='completed') AS completed,SUM(status='failed') AS failed,
                    SUM(status='uncertain') AS uncertain,SUM(status='cancelled') AS cancelled
                FROM jobs WHERE owner_id IN (SELECT id FROM page) GROUP BY owner_id
            ) SELECT page.id,page.access_mode,page.created_at,page.last_seen,
                page.username,page.registration_kind,page.weekly_limit_override,page.disabled,page.managed_eligible,page.role,
                COALESCE(request_totals.weekly_used,0) AS weekly_used,
                COALESCE(job_totals.weekly_reserved,0) AS weekly_reserved,
                COALESCE(request_totals.total_requests,0) AS total_requests,
                COALESCE(request_totals.usage_known_requests,0) AS usage_known_requests,
                COALESCE(request_totals.usage_unknown_requests,0) AS usage_unknown_requests,
                COALESCE(job_totals.completed,0) AS completed,
                COALESCE(job_totals.failed,0) AS failed,
                COALESCE(job_totals.uncertain,0) AS uncertain,
                COALESCE(job_totals.cancelled,0) AS cancelled,
                COALESCE(request_totals.input_tokens,0) AS input_tokens,
                COALESCE(request_totals.output_tokens,0) AS output_tokens
            FROM page LEFT JOIN request_totals ON request_totals.owner_id=page.id
                LEFT JOIN job_totals ON job_totals.owner_id=page.id
            ORDER BY page.created_at DESC,page.id""",
            (limit, offset, week, reset_at(now)[:10])).fetchall()
        for row in rows:
            quota = store.weekly_quota(db, row["id"], settings=settings, timestamp=now)
            counts = {field: int(row[field]) for field in ("weekly_used", "weekly_reserved", "total_requests",
                      "usage_known_requests", "usage_unknown_requests",
                      "completed", "failed", "uncertain", "cancelled", "input_tokens", "output_tokens")}
            calls_by_kind = {kind: 0 for kind in ("organize", "chat", "file", "asr", "tts", "image")}
            for call in db.execute("SELECT kind,COUNT(*) AS count FROM chat_calls WHERE owner_id=? GROUP BY kind", (row["id"],)):
                calls_by_kind[call["kind"]] = int(call["count"])
            calls_by_kind["organize"] = counts["total_requests"] - sum(calls_by_kind.values())
            users.append({"id": row["id"],
                          "username": row["username"], "role": row["role"], "registration_kind": row["registration_kind"],
                          "enabled": not bool(row["disabled"]), "managed_eligible": bool(row["managed_eligible"]),
                          "weekly_limit_override": row["weekly_limit_override"],
                          "access_mode": "public" if settings.public_enabled or row["access_mode"] == "public" else "invitation",
                          "created_at": _iso(row["created_at"]),
                          "last_seen_at": _iso(row["last_seen"]) if row["last_seen"] is not None else None,
                          "weekly_limit": int(quota["user_weekly_limit"]),
                          "weekly_remaining": int(quota["user_weekly_remaining"]),
                          "calls_by_kind": calls_by_kind,
                          **counts})
    return {"limit": limit, "offset": offset, "total": total, "users": users,
            "week": week, "reset_at": reset_at(now)}


def admin_authorizer(store):
    def require_admin(response: Response, authorization: str | None = Header(default=None)):
        response.headers["Cache-Control"] = "no-store"
        parts = (authorization or "").split(" ", 1)
        if len(parts) != 2 or parts[0].lower() != "bearer" or not 1 <= len(parts[1]) <= 512:
            raise HTTPException(401, "请先登录管理员账号")
        token_hash = _hash(parts[1])
        # The deployment credential is a separate, explicit bearer, never a browser login.
        operations_token = store.settings.admin_token
        if operations_token and hmac.compare_digest(token_hash, _hash(operations_token)):
            return
        with store.connection() as db:
            db.execute("BEGIN")
            session = db.execute("SELECT parent_hash FROM admin_sessions WHERE token_hash=? AND expires_at>?",
                                 (token_hash, time.time())).fetchone()
            account = _account_session(db, session["parent_hash"] if session else token_hash)
        if account is None:
            raise HTTPException(401, "管理员凭据无效或已过期")
        if account["role"] != "admin":
            raise HTTPException(403, "当前账号没有管理权限")

    return require_admin


def build_admin_router(store):
    router = APIRouter(prefix="/v1/admin", tags=["administration"])
    require_admin = admin_authorizer(store)

    @router.post("/login")
    def login(body: AccountLoginRequest, request: Request, response: Response):
        response.headers["Cache-Control"] = "no-store"
        account = store.accounts.login(body.username, body.password, _client_ip(request), admin_only=True)
        return _management_session(store, account["token"])

    @router.post("/session")
    def browser_session(request: Request, response: Response):
        require_admin_origin(request)
        response.headers["Cache-Control"] = "no-store"
        return _management_session(store, request.cookies.get("deepseek_session"))

    @router.post("/logout", dependencies=[Depends(require_admin)])
    def end_management_session(request: Request, response: Response, authorization: str = Header()):
        cookie = request.cookies.get("deepseek_session")
        if cookie:
            require_admin_origin(request)
        management_hash = _hash(authorization.split(" ", 1)[1])
        with store.connection(write=True) as db:
            session = db.execute("SELECT parent_hash FROM admin_sessions WHERE token_hash=?", (management_hash,)).fetchone()
            db.execute("DELETE FROM admin_sessions WHERE token_hash=?", (management_hash,))
            if session and cookie and hmac.compare_digest(session["parent_hash"], _hash(cookie)):
                db.execute("UPDATE account_sessions SET revoked_at=? WHERE token_hash=?", (time.time(), session["parent_hash"]))
                response.delete_cookie("deepseek_session", path="/deepseek-api", secure=True, httponly=True, samesite="strict")
        return {}

    @router.get("/config", dependencies=[Depends(require_admin)])
    def get_config():
        return store.admin_config()

    @router.patch("/config", dependencies=[Depends(require_admin)])
    def update_config(body: AdminConfigPatch):
        return store.update_config(body.model_dump(exclude_unset=True))

    @router.get("/storage", dependencies=[Depends(require_admin)])
    def storage():
        from .storage_capacity import capacity_report
        return capacity_report(store)

    @router.get("/stats", dependencies=[Depends(require_admin)])
    def statistics(days: int = Query(default=7, ge=1, le=90)):
        return _statistics(store, days)

    @router.get("/users", dependencies=[Depends(require_admin)])
    def users(limit: int = Query(default=50, ge=1, le=200), offset: int = Query(default=0, ge=0)):
        return _users(store, limit, offset)

    @router.patch("/users/{user_id}/quota", dependencies=[Depends(require_admin)])
    def update_user_quota(user_id: str, body: UserQuotaPatch):
        return store.update_user_quota(user_id, body.model_dump(exclude_unset=True))

    @router.patch("/users/{user_id}/status", dependencies=[Depends(require_admin)])
    def update_user_status(user_id: str, body: AccountStatusPatch):
        return store.accounts.set_enabled(user_id, body.enabled)

    @router.post("/users/{user_id}/revoke-managed", dependencies=[Depends(require_admin)])
    def revoke_managed(user_id: str):
        return store.accounts.revoke_managed(user_id)

    @router.post("/users/{user_id}/reset-password", dependencies=[Depends(require_admin)])
    def reset_user_password(user_id: str):
        return store.accounts.reset_password(user_id)

    @router.get("/registration-invites", dependencies=[Depends(require_admin)])
    def registration_invites(limit: int = Query(default=50, ge=1, le=100), offset: int = Query(default=0, ge=0)):
        return store.accounts.list_invites(limit, offset)

    @router.post("/registration-invites", dependencies=[Depends(require_admin)])
    def create_registration_invites(body: RegistrationInviteRequest):
        return store.accounts.create_invites(body.count, body.valid_days)

    return router
