"""Registered identities, revocable sessions, and one-use registration invitations.

Local archives never enter this module. Legacy owners and task identities remain
untouched; a registered account always receives a new owner.
"""

import base64
import hashlib
import hmac
import secrets
import time
import unicodedata
import uuid
from datetime import datetime

from .store import DAY, SHANGHAI, ServiceError, digest


PASSWORD_ITERATIONS = 600_000
SESSION_SECONDS = 30 * DAY
LOGIN_WINDOW_SECONDS = 15 * 60
REGISTRATION_WINDOW_SECONDS = 60 * 60
MAX_FAILED_LOGINS_PER_USER = 5
MAX_FAILED_LOGINS_PER_IP = 20
MAX_REGISTRATIONS_PER_IP = 10
PERMISSION_NAMES = ("chat_api", "image_api", "cloud_sync")


def account_permissions(row, open_permissions=None):
    if row is None or (open_permissions is not None and row["disabled"]):
        return dict.fromkeys(PERMISSION_NAMES, False)
    inherited = bool(row["managed_eligible"])
    return {
        name: (open_permissions is not None and open_permissions[name])
        or ((inherited or (name == "cloud_sync" and bool(row["self_service_cloud"])))
            if row[name] is None else bool(row[name]))
        for name in PERMISSION_NAMES
    }


def account_invite_redeemable(row):
    return not row["managed_eligible"] and all(row[name] is None for name in PERMISSION_NAMES)


def validate_permissions(permissions):
    if (not isinstance(permissions, dict) or set(permissions) != set(PERMISSION_NAMES)
            or any(type(value) is not bool for value in permissions.values())):
        raise ServiceError(422, "请为聊天、生图和云同步各选择启用或停用。")


def _invitation_permissions(row):
    return {name: row[name] is None or bool(row[name]) for name in PERMISSION_NAMES}


def _iso(timestamp):
    return datetime.fromtimestamp(timestamp, SHANGHAI).isoformat()


def _username(value):
    if not isinstance(value, str):
        raise ServiceError(422, "用户名须为 3–32 位字母、数字、下划线或短横线")
    name = unicodedata.normalize("NFKC", value.strip())
    if not 3 <= len(name) <= 32 or any(not (char.isalnum() or char in "_-") for char in name):
        raise ServiceError(422, "用户名须为 3–32 位字母、数字、下划线或短横线")
    return name, name.casefold()


def _password(value):
    if not isinstance(value, str) or not 8 <= len(value) <= 128:
        raise ServiceError(422, "密码须为 8–128 个字符")
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise ServiceError(422, "密码包含无效字符") from None
    return value


def _encode(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _hash_password(password):
    salt = secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${_encode(salt)}${_encode(derived)}"


def _verify_password(password, encoded):
    # Unknown usernames and malformed hashes still perform the same expensive KDF.
    salt, expected, valid = b"\0" * 16, b"\0" * 32, False
    if isinstance(encoded, str):
        try:
            algorithm, iterations, salt_text, digest_text = encoded.split("$")
            if algorithm != "pbkdf2_sha256" or iterations != str(PASSWORD_ITERATIONS):
                raise ValueError
            salt_value = base64.b64decode(salt_text + "=" * (-len(salt_text) % 4), altchars=b"-_", validate=True)
            digest_value = base64.b64decode(digest_text + "=" * (-len(digest_text) % 4), altchars=b"-_", validate=True)
            if (len(salt_value) != 16 or len(digest_value) != 32
                    or _encode(salt_value) != salt_text or _encode(digest_value) != digest_text):
                raise ValueError
            salt, expected, valid = salt_value, digest_value, True
        except (ValueError, TypeError):
            pass
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    matches = hmac.compare_digest(actual, expected)
    return valid and matches


class Accounts:
    def __init__(self, store):
        self.store = store

    def initialize(self):
        with self.store.connection(write=True) as db:
            db.execute("""CREATE TABLE IF NOT EXISTS registered_accounts (
                user_id TEXT PRIMARY KEY REFERENCES users(id), username TEXT NOT NULL,
                username_key TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
                registration_kind TEXT NOT NULL CHECK(registration_kind IN ('public','invitation')),
                created_at REAL NOT NULL,
                weekly_limit_override INTEGER DEFAULT NULL CHECK(weekly_limit_override IS NULL OR weekly_limit_override>=0),
                disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1))
            )""")
            # Backfill once. Re-running initialization must never undo a revocation.
            if "managed_eligible" not in {column["name"] for column in db.execute("PRAGMA table_info(registered_accounts)")}:
                db.execute("""ALTER TABLE registered_accounts ADD COLUMN managed_eligible INTEGER
                    NOT NULL DEFAULT 0 CHECK(managed_eligible IN (0,1))""")
                db.execute("UPDATE registered_accounts SET managed_eligible=1")
            if "role" not in {column["name"] for column in db.execute("PRAGMA table_info(registered_accounts)")}:
                db.execute("""ALTER TABLE registered_accounts ADD COLUMN role TEXT
                    NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin'))""")
            account_columns = {column["name"] for column in db.execute("PRAGMA table_info(registered_accounts)")}
            for name in PERMISSION_NAMES:
                if name not in account_columns:
                    db.execute(f"ALTER TABLE registered_accounts ADD COLUMN {name} INTEGER CHECK({name} IN (0,1))")
            if "self_service_cloud" not in account_columns:
                db.execute("""ALTER TABLE registered_accounts ADD COLUMN self_service_cloud INTEGER
                    NOT NULL DEFAULT 0 CHECK(self_service_cloud IN (0,1))""")
            db.execute("""CREATE TABLE IF NOT EXISTS account_registration_policy (
                id INTEGER PRIMARY KEY CHECK(id=1),
                self_service INTEGER NOT NULL CHECK(self_service IN (0,1))
            )""")
            db.execute("INSERT OR IGNORE INTO account_registration_policy VALUES(1,1)")
            db.execute("""CREATE TABLE IF NOT EXISTS account_sessions (
                token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES registered_accounts(user_id),
                created_at REAL NOT NULL, expires_at REAL NOT NULL, revoked_at REAL
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS account_sessions_user ON account_sessions(user_id)")
            db.execute("""CREATE TABLE IF NOT EXISTS account_auth_attempts (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, ip_hash TEXT NOT NULL,
                subject_hash TEXT NOT NULL, created_at REAL NOT NULL, succeeded INTEGER NOT NULL DEFAULT 0
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS account_attempts_time ON account_auth_attempts(kind,created_at)")
            db.execute("""CREATE TABLE IF NOT EXISTS registration_invites (
                id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, unused_plaintext TEXT,
                created_at REAL NOT NULL, expires_at REAL NOT NULL,
                redeemed_at REAL, redeemed_by TEXT REFERENCES registered_accounts(user_id), revoked_at REAL
            )""")
            invite_columns = {column["name"] for column in db.execute("PRAGMA table_info(registration_invites)")}
            for name in PERMISSION_NAMES:
                if name not in invite_columns:
                    db.execute(f"ALTER TABLE registration_invites ADD COLUMN {name} INTEGER CHECK({name} IN (0,1))")
            db.execute("""CREATE TABLE IF NOT EXISTS registration_counter (
                id INTEGER PRIMARY KEY CHECK(id=1), public_registered_count INTEGER NOT NULL CHECK(public_registered_count>=0)
            )""")
            db.execute("INSERT OR IGNORE INTO registration_counter VALUES(1,0)")
            now = time.time()
            db.execute("DELETE FROM account_sessions WHERE expires_at<=?", (now,))
            db.execute("DELETE FROM account_auth_attempts WHERE created_at<=?", (now - REGISTRATION_WINDOW_SECONDS,))
            db.execute("UPDATE registration_invites SET unused_plaintext=NULL WHERE expires_at<=?", (now,))

    def public_registered_count(self, db=None):
        if db is not None:
            return int(db.execute("SELECT public_registered_count FROM registration_counter WHERE id=1").fetchone()[0])
        with self.store.connection() as connection:
            return self.public_registered_count(connection)

    @staticmethod
    def _self_service_enabled(db):
        return bool(db.execute("SELECT self_service FROM account_registration_policy WHERE id=1").fetchone()[0])

    def registration_policy(self):
        with self.store.connection() as db:
            return {"self_service": self._self_service_enabled(db)}

    def set_registration_policy(self, self_service):
        if type(self_service) is not bool:
            raise ServiceError(422, "自助注册状态须为布尔值。")
        with self.store.connection(write=True) as db:
            db.execute("UPDATE account_registration_policy SET self_service=? WHERE id=1", (int(self_service),))
            return {"self_service": self._self_service_enabled(db)}

    def _attempt(self, kind, ip, username_key, now):
        ip_hash, subject_hash = digest(str(ip)), digest(username_key)
        with self.store.connection(write=True) as db:
            db.execute("DELETE FROM account_auth_attempts WHERE created_at<=?", (now - REGISTRATION_WINDOW_SECONDS,))
            if kind == "registration":
                count = db.execute("""SELECT COUNT(*) FROM account_auth_attempts
                    WHERE kind=? AND ip_hash=? AND created_at>?""",
                    (kind, ip_hash, now - REGISTRATION_WINDOW_SECONDS)).fetchone()[0]
                limited = count >= MAX_REGISTRATIONS_PER_IP
            else:
                counts = db.execute("""SELECT COALESCE(SUM(ip_hash=?),0),COALESCE(SUM(subject_hash=?),0)
                    FROM account_auth_attempts WHERE kind='login' AND succeeded=0 AND created_at>?""",
                    (ip_hash, subject_hash, now - LOGIN_WINDOW_SECONDS)).fetchone()
                limited = counts[0] >= MAX_FAILED_LOGINS_PER_IP or counts[1] >= MAX_FAILED_LOGINS_PER_USER
            if limited:
                raise ServiceError(429, "尝试次数过多，请稍后再试")
            attempt_id = str(uuid.uuid4())
            db.execute("INSERT INTO account_auth_attempts VALUES(?,?,?,?,?,0)",
                       (attempt_id, kind, ip_hash, subject_hash, now))
            return attempt_id

    def _session(self, db, owner_id, now):
        token = secrets.token_urlsafe(32)
        expires = now + SESSION_SECONDS
        db.execute("INSERT INTO account_sessions VALUES(?,?,?,?,NULL)", (digest(token), owner_id, now, expires))
        return token, _iso(expires)

    @staticmethod
    def _user(row, permissions=None):
        if permissions is None:
            permissions = account_permissions(row)
        return {"id": row["user_id"], "username": row["username"],
                "role": row["role"], "registration_kind": row["registration_kind"], "created_at": _iso(row["created_at"]),
                "managed_eligible": permissions["chat_api"], "permissions": permissions,
                "invite_redeemable": account_invite_redeemable(row), "enabled": not bool(row["disabled"])}

    def register(self, username, password, invitation_code=None, client_ip="unknown"):
        name, key = _username(username)
        if key == "admin":
            raise ServiceError(409, "此用户名保留给管理员，请更换用户名")
        password = _password(password)
        if isinstance(invitation_code, str):
            invitation_code = invitation_code.strip() or None
        self._attempt("registration", client_ip, key, time.time())
        password_hash = _hash_password(password)
        with self.store.connection(write=True) as db:
            now = time.time()
            self_service = invitation_code is None
            if self_service and not self._self_service_enabled(db):
                raise ServiceError(422, "注册需要邀请码，请填写管理员发放的有效邀请码。")
            if db.execute("SELECT 1 FROM registered_accounts WHERE username_key=?", (key,)).fetchone():
                raise ServiceError(409, "用户名已被注册")
            owner_id = self._create_identity(db, name, key, password_hash, now,
                registration_kind="public" if self_service else "invitation", self_service_cloud=self_service)
            if self_service:
                db.execute("UPDATE registration_counter SET public_registered_count=public_registered_count+1 WHERE id=1")
            else:
                self._redeem_invite(db, owner_id, invitation_code, now)
            self.store._touch_user(db, owner_id, now)
            token, expires = self._session(db, owner_id, now)
        return {"token": token, "expires_at": expires, **self.me(owner_id)}

    @staticmethod
    def _create_identity(db, name, key, password_hash, now, *, role="user", managed_eligible=False,
                         registration_kind="public", self_service_cloud=False):
        owner_id = str(uuid.uuid4())
        # Only revocable account sessions authenticate; the legacy token is never issued.
        db.execute("INSERT INTO users(id,token_hash,budget_limit,created_at,access_mode) VALUES(?,?,0,?,'public')",
                   (owner_id, digest(secrets.token_urlsafe(32)), now))
        db.execute("""INSERT INTO registered_accounts
            (user_id,username,username_key,password_hash,registration_kind,created_at,role,managed_eligible,self_service_cloud)
            VALUES(?,?,?,?,?,?,?,?,?)""",
            (owner_id, name, key, password_hash, registration_kind, now, role, int(managed_eligible), int(self_service_cloud)))
        return owner_id

    def bootstrap_admin(self, password):
        password = _password(password)
        with self.store.connection(write=True) as db:
            row = db.execute("SELECT role,password_hash FROM registered_accounts WHERE username_key='admin'").fetchone()
            if row is not None:
                if row["role"] != "admin":
                    raise ServiceError(409, "同名普通账号已存在，未更改其权限")
                if not _verify_password(password, row["password_hash"]):
                    raise ServiceError(409, "管理员已存在，提供的密码不匹配")
                return False
            self._create_identity(db, "admin", "admin", _hash_password(password), time.time(),
                                  role="admin", managed_eligible=True)
            return True

    def rotate_admin_password(self, password):
        encoded = _hash_password(_password(password))
        with self.store.connection(write=True) as db:
            row = db.execute("SELECT user_id FROM registered_accounts WHERE username_key='admin' AND role='admin' AND disabled=0").fetchone()
            if row is None:
                raise ServiceError(404, "管理员账号不可用")
            db.execute("UPDATE registered_accounts SET password_hash=? WHERE user_id=?", (encoded, row[0]))
            db.execute("UPDATE account_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", (time.time(), row[0]))

    @staticmethod
    def _redeem_invite(db, owner_id, code, now):
        if not isinstance(code, str) or not code.isascii() or not 16 <= len(code.strip()) <= 128:
            raise ServiceError(400, "邀请码无效、已使用或已过期")
        invitation = db.execute("""SELECT id,chat_api,image_api,cloud_sync FROM registration_invites
            WHERE code_hash=? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>?""",
            (digest(code.strip()), now)).fetchone()
        if invitation is None:
            raise ServiceError(400, "邀请码无效、已使用或已过期")
        db.execute("UPDATE registration_invites SET redeemed_at=?,redeemed_by=?,unused_plaintext=NULL WHERE id=?",
                   (now, owner_id, invitation["id"]))
        cloud = invitation["cloud_sync"]
        db.execute("""UPDATE registered_accounts SET managed_eligible=1,chat_api=?,image_api=?,
            cloud_sync=CASE WHEN self_service_cloud=1 AND ?=0 THEN NULL ELSE ? END WHERE user_id=?""",
            (invitation["chat_api"], invitation["image_api"], cloud, cloud, owner_id))

    def redeem_invite(self, owner_id, invitation_code):
        with self.store.connection(write=True) as db:
            row = db.execute("SELECT disabled,managed_eligible,chat_api,image_api,cloud_sync FROM registered_accounts WHERE user_id=?",
                             (owner_id,)).fetchone()
            if row is None or row["disabled"]:
                raise ServiceError(401, "请先注册并登录")
            if not account_invite_redeemable(row):
                raise ServiceError(409, "当前账号已有权限设置，请联系管理员调整。")
            self._redeem_invite(db, owner_id, invitation_code, time.time())
        return self.me(owner_id)

    def revoke_managed(self, owner_id):
        with self.store.connection(write=True) as db:
            if not db.execute("""UPDATE registered_accounts SET managed_eligible=0,chat_api=NULL,image_api=NULL,
                cloud_sync=CASE WHEN self_service_cloud=1 AND cloud_sync=0 THEN 0 ELSE NULL END WHERE user_id=?""",
                (owner_id,)).rowcount:
                raise ServiceError(404, "注册用户不存在")
        return {"id": owner_id, "managed_eligible": False}

    def set_permissions(self, owner_id, permissions):
        validate_permissions(permissions)
        with self.store.connection(write=True) as db:
            if not db.execute("UPDATE registered_accounts SET chat_api=?,image_api=?,cloud_sync=? WHERE user_id=?",
                              (*(int(permissions[name]) for name in PERMISSION_NAMES), owner_id)).rowcount:
                raise ServiceError(404, "注册用户不存在")
            return self._user(db.execute("SELECT * FROM registered_accounts WHERE user_id=?", (owner_id,)).fetchone())

    def login(self, username, password, client_ip="unknown", *, admin_only=False):
        _, key = _username(username)
        password = _password(password)
        attempt_id = self._attempt("login", client_ip, key, time.time())
        with self.store.connection() as db:
            row = db.execute("SELECT * FROM registered_accounts WHERE username_key=?", (key,)).fetchone()
        if not _verify_password(password, row["password_hash"] if row is not None else None):
            raise ServiceError(401, "用户名或密码不正确")
        with self.store.connection(write=True) as db:
            now = time.time()
            # Password derivation runs outside the write lock. Re-read so a
            # simultaneous reset/disable cannot issue a fresh valid session.
            fresh = db.execute("SELECT * FROM registered_accounts WHERE user_id=?", (row["user_id"],)).fetchone()
            if fresh is None or fresh["disabled"] or not hmac.compare_digest(fresh["password_hash"], row["password_hash"]):
                raise ServiceError(401, "账号不可用或密码已变化，请重新登录")
            if admin_only and fresh["role"] != "admin":
                raise ServiceError(403, "当前账号没有管理权限")
            token, expires = self._session(db, row["user_id"], now)
            db.execute("UPDATE account_auth_attempts SET succeeded=1 WHERE id=?", (attempt_id,))
            self.store._touch_user(db, row["user_id"], now)
        return {"token": token, "expires_at": expires, **self.me(row["user_id"])}

    def authenticate(self, token):
        if not isinstance(token, str) or not token or len(token) > 256:
            return None
        with self.store.connection() as db:
            row = db.execute("""SELECT session.user_id,session.expires_at,session.revoked_at
                FROM account_sessions AS session JOIN registered_accounts AS account ON account.user_id=session.user_id
                WHERE session.token_hash=? AND account.disabled=0""", (digest(token),)).fetchone()
        if row is None:
            return None
        now = time.time()
        return row["user_id"] if row["revoked_at"] is None and now < row["expires_at"] else None

    def is_session_active_hash(self, token_hash, db=None):
        if not isinstance(token_hash, str) or len(token_hash) != 64:
            return False
        if db is None:
            with self.store.connection() as connection:
                return self.is_session_active_hash(token_hash, db=connection)
        row = db.execute("""SELECT 1 FROM account_sessions AS session
            JOIN registered_accounts AS account ON account.user_id=session.user_id
            WHERE session.token_hash=? AND session.revoked_at IS NULL AND session.expires_at>? AND account.disabled=0""",
                         (token_hash, time.time())).fetchone()
        return row is not None

    def me(self, owner_id):
        with self.store.connection() as db:
            db.execute("BEGIN")
            row = db.execute("SELECT * FROM registered_accounts WHERE user_id=?", (owner_id,)).fetchone()
            if row is None or row["disabled"]:
                raise ServiceError(401, "请先注册并登录")
            quota = self.store.quota(owner_id, db=db)
            return {"user": self._user(row, quota["permissions"]), "quota": quota}

    def set_enabled(self, owner_id, enabled):
        if type(enabled) is not bool:
            raise ServiceError(422, "账号状态须为布尔值")
        with self.store.connection(write=True) as db:
            row = db.execute("SELECT user_id FROM registered_accounts WHERE user_id=?", (owner_id,)).fetchone()
            if row is None:
                raise ServiceError(404, "注册用户不存在")
            db.execute("UPDATE registered_accounts SET disabled=? WHERE user_id=?", (int(not enabled), owner_id))
            db.execute("UPDATE account_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
                       (time.time(), owner_id))
        return {"id": owner_id, "enabled": enabled}

    def reset_password(self, owner_id):
        password = secrets.token_urlsafe(15)
        encoded = _hash_password(password)
        with self.store.connection(write=True) as db:
            row = db.execute("SELECT username FROM registered_accounts WHERE user_id=?", (owner_id,)).fetchone()
            if row is None:
                raise ServiceError(404, "注册用户不存在")
            db.execute("UPDATE registered_accounts SET password_hash=? WHERE user_id=?", (encoded, owner_id))
            db.execute("UPDATE account_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
                       (time.time(), owner_id))
        # The generated password is returned only once through an authenticated
        # administrator endpoint; it never enters call logs or local archives.
        return {"id": owner_id, "username": row["username"], "password": password}

    def logout(self, token):
        if isinstance(token, str) and token and len(token) <= 256:
            with self.store.connection(write=True) as db:
                db.execute("UPDATE account_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL",
                           (time.time(), digest(token)))
        return {}

    def create_invites(self, count, valid_days, permissions=None):
        if type(count) is not int or not 1 <= count <= 100 or type(valid_days) is not int or not 1 <= valid_days <= 365:
            raise ServiceError(422, "邀请码数量须为 1–100，有效天数须为 1–365")
        if permissions is None:
            overrides = (None,) * len(PERMISSION_NAMES)
            visible_permissions = dict.fromkeys(PERMISSION_NAMES, True)
        else:
            validate_permissions(permissions)
            overrides = tuple(int(permissions[name]) for name in PERMISSION_NAMES)
            visible_permissions = permissions
        invitations = []
        with self.store.connection(write=True) as db:
            now = time.time()
            expires = now + valid_days * DAY
            for _ in range(count):
                code, identity = secrets.token_urlsafe(24), str(uuid.uuid4())
                db.execute("""INSERT INTO registration_invites
                    (id,code_hash,unused_plaintext,created_at,expires_at,chat_api,image_api,cloud_sync) VALUES(?,?,?,?,?,?,?,?)""",
                    (identity, digest(code), code, now, expires, *overrides))
                invitations.append({"id": identity, "code": code, "expires_at": _iso(expires),
                                    "permissions": visible_permissions})
        return {"invitations": invitations}

    def list_invites(self, limit=50, offset=0):
        if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or offset < 0:
            raise ServiceError(422, "分页范围不正确")
        with self.store.connection() as db:
            db.execute("BEGIN")
            now = time.time()
            total = db.execute("""SELECT COUNT(*) FROM registration_invites
                WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>?""", (now,)).fetchone()[0]
            rows = db.execute("""SELECT * FROM registration_invites
                WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>?
                ORDER BY created_at DESC,id LIMIT ? OFFSET ?""", (now, limit, offset)).fetchall()
        invitations = []
        for row in rows:
            item = {"id": row["id"], "created_at": _iso(row["created_at"]), "expires_at": _iso(row["expires_at"]),
                    "redeemed_at": _iso(row["redeemed_at"]) if row["redeemed_at"] is not None else None,
                    "redeemed_by": row["redeemed_by"],
                    "revoked_at": _iso(row["revoked_at"]) if row["revoked_at"] is not None else None,
                    "permissions": _invitation_permissions(row)}
            item["code"] = row["unused_plaintext"]
            invitations.append(item)
        return {"limit": limit, "offset": offset, "total": total, "invitations": invitations}

    def revoke_invite(self, invitation_id):
        with self.store.connection(write=True) as db:
            if db.execute("SELECT 1 FROM registration_invites WHERE id=?", (invitation_id,)).fetchone() is None:
                raise ServiceError(404, "注册邀请码不存在")
            db.execute("""UPDATE registration_invites SET revoked_at=?,unused_plaintext=NULL
                WHERE id=? AND revoked_at IS NULL AND redeemed_at IS NULL""", (time.time(), invitation_id))
        return {}
