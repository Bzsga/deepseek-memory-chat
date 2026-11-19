"""Explicitly published, immutable conversation copies; never dispatch models."""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import html
import json
import logging
import os
from pathlib import Path
import re
import secrets
import shutil
import time
import uuid

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response

from .chat import ChatError, _body, _error, _image_type, _origin_ok, _token
from .storage_capacity import check_growth, share_usage
from .share_import import _invalid_constant, _unique_object


MAX_REQUEST_BYTES = 64 * 1024 * 1024
MAX_TEXT_BYTES = 8 * 1024 * 1024
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
SHARE_ID = re.compile(r"[A-Za-z0-9_-]{32}\Z")
IMAGE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
PUBLIC_API_PATH = "/deepseek-api/chat/api/conversation-shares"
PUBLIC_HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                  "Referrer-Policy": "no-referrer"}
PAGE_HEADERS = {**PUBLIC_HEADERS,
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY"}
logger = logging.getLogger(__name__)


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _invalid():
    raise ChatError(422, "分享内容格式不正确，请重新选择要分享的消息。")


def _string(value, maximum, *, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not value and not empty):
        _invalid()
    try:
        value.encode("utf-8")
    except UnicodeError:
        _invalid()
    return value


def _integer(value):
    if type(value) is not int or not 0 <= value <= 9007199254740991:
        _invalid()
    return value


def _fields(value, expected, optional=()):
    if not isinstance(value, dict) or set(value) - set(expected) - set(optional) or set(expected) - set(value):
        _invalid()


def _prepare(raw):
    """Use a strict allowlist so hidden contexts cannot become public accidentally."""
    if len(raw) > MAX_REQUEST_BYTES:
        raise ChatError(413, "分享请求超过 64 MiB，请减少消息或图片后重试。")
    try:
        payload = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                             parse_constant=_invalid_constant)
    except (ValueError, UnicodeError, RecursionError):
        _invalid()
    _fields(payload, {"client_request_id", "conversation_id", "title", "messages", "images"})
    request_id = _string(payload["client_request_id"], 512)
    conversation_id = _string(payload["conversation_id"], 512)
    title = _string(payload["title"], 1024, empty=True)
    if not isinstance(payload["messages"], list) or not 1 <= len(payload["messages"]) <= 100000:
        _invalid()
    messages, message_ids, referenced = [], set(), set()
    for item in payload["messages"]:
        _fields(item, {"id", "role", "content", "created_at", "image_ids", "files"})
        message_id = _string(item["id"], 512)
        if message_id in message_ids or item["role"] not in ("user", "assistant"):
            _invalid()
        message_ids.add(message_id)
        content = _string(item["content"], MAX_REQUEST_BYTES, empty=True)
        created_at = _integer(item["created_at"])
        ids = item["image_ids"]
        if not isinstance(ids, list) or any(not isinstance(value, str) or not IMAGE_ID.fullmatch(value) for value in ids):
            _invalid()
        if len(ids) != len(set(ids)):
            _invalid()
        referenced.update(ids)
        if not isinstance(item["files"], list):
            _invalid()
        files = []
        for file in item["files"]:
            _fields(file, {"name", "size", "mime_type"})
            files.append({"name": _string(file["name"], 1024), "size": _integer(file["size"]),
                          "mime_type": _string(file["mime_type"], 255, empty=True)})
        messages.append({"id": message_id, "role": item["role"], "content": content,
                         "created_at": created_at, "image_ids": list(ids), "files": files})
    if len(_json({"title": title, "messages": messages}).encode("utf-8")) > MAX_TEXT_BYTES:
        raise ChatError(413, "分享正文超过 8 MiB，请减少所选消息后重试。")
    if not isinstance(payload["images"], list):
        _invalid()
    images, image_ids = [], set()
    for item in payload["images"]:
        _fields(item, {"id", "name", "mime_type", "b64_json"})
        image_id = item["id"]
        if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id) or image_id in image_ids:
            _invalid()
        image_ids.add(image_id)
        name = _string(item["name"], 1024)
        mime = _string(item["mime_type"], 255)
        encoded = item["b64_json"]
        if not isinstance(encoded, str):
            _invalid()
        if len(encoded) > 4 * ((MAX_IMAGE_BYTES + 2) // 3):
            raise ChatError(413, "每张分享图片最多 12 MiB，请缩小图片或减少分享范围。")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise ChatError(422, "分享图片编码无效，请重新选择图片。") from None
        if len(content) > MAX_IMAGE_BYTES:
            raise ChatError(413, "每张分享图片最多 12 MiB，请缩小图片或减少分享范围。")
        if not content or _image_type(content) != mime:
            raise ChatError(415, "分享图片仅支持内容匹配的 PNG、JPEG、GIF 和 WebP。")
        images.append({"id": image_id, "name": name, "mime_type": mime, "content": content,
                       "size": len(content)})
    if image_ids != referenced:
        raise ChatError(422, "分享图片与所选消息不匹配，请重新选择分享范围。")
    # Canonical JSON makes property order irrelevant while retaining exact text,
    # message order and image bytes. Nothing from an unselected message is added.
    fingerprint = {"conversation_id": conversation_id, "title": title, "messages": messages,
                   "images": [{key: image[key] for key in ("id", "name", "mime_type", "size")}
                              | {"sha256": hashlib.sha256(image["content"]).hexdigest()} for image in images]}
    checksum = hashlib.sha256(json.dumps(fingerprint, ensure_ascii=False, sort_keys=True,
                                        separators=(",", ":")).encode("utf-8")).hexdigest()
    return request_id, conversation_id, title, messages, images, checksum


class ConversationShares:
    def __init__(self, store, directory):
        self.store, self.directory = store, Path(directory)

    def initialize(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        with self.store.connection(write=True) as db:
            db.execute("""CREATE TABLE IF NOT EXISTS conversation_shares (
                id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES registered_accounts(user_id),
                client_request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
                conversation_id TEXT, title TEXT, message_count INTEGER NOT NULL,
                image_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
                revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
                UNIQUE(owner_id,client_request_id))""")
            db.execute("CREATE INDEX IF NOT EXISTS conversation_shares_owner ON conversation_shares(owner_id,conversation_id,created_at)")
            if "stored_bytes" not in {row[1] for row in db.execute("PRAGMA table_info(conversation_shares)")}:
                db.execute("ALTER TABLE conversation_shares ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0")
                for row in db.execute("SELECT id FROM conversation_shares WHERE revoked=0").fetchall():
                    folder = self._folder(row["id"])
                    if folder.is_dir():
                        size = sum(file.stat().st_size for file in folder.iterdir() if file.is_file())
                        db.execute("UPDATE conversation_shares SET stored_bytes=? WHERE id=?", (size, row["id"]))
            active = {row["id"] for row in db.execute("SELECT id FROM conversation_shares WHERE revoked=0")}
        # Initialization runs once before requests. Clean copies whose transaction
        # did not commit, and files left by an interrupted revoke.
        for candidate in self.directory.iterdir():
            if SHARE_ID.fullmatch(candidate.name) and candidate.name not in active:
                self._remove(candidate.name)

    def _folder(self, share_id):
        if not isinstance(share_id, str) or not SHARE_ID.fullmatch(share_id):
            raise ChatError(404, "分享不存在或已撤销。")
        return self.directory / share_id

    def _remove(self, share_id):
        folder = self._folder(share_id)
        if folder.is_symlink():
            folder.unlink()
        elif folder.exists():
            shutil.rmtree(folder)

    @staticmethod
    def _write(path, raw):
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())

    @staticmethod
    def _metadata(row, origin):
        return {"id": row["id"], "url": origin + "/deepseek/share/" + row["id"],
                "title": row["title"] or "", "conversation_id": row["conversation_id"] or "",
                "message_count": row["message_count"], "image_count": row["image_count"],
                "created_at": row["created_at"], "revoked": bool(row["revoked"])}

    def create(self, owner, raw, origin):
        request_id, conversation_id, title, messages, images, checksum = _prepare(raw)
        created_id = None
        try:
            # The same SQLite writer lock serializes retries across processes.
            # A committed share always has its entire immutable copy on disk.
            with self.store.connection(write=True) as db:
                previous = db.execute("SELECT * FROM conversation_shares WHERE owner_id=? AND client_request_id=?",
                                      (owner, request_id)).fetchone()
                if previous is not None:
                    if previous["payload_hash"] != checksum:
                        raise ChatError(409, "此分享请求编号已用于不同内容，请重新创建分享。")
                    return self._metadata(previous, origin), False
                share_id = secrets.token_urlsafe(24)
                folder = self._folder(share_id)
                folder.mkdir(mode=0o700)
                created_id = share_id
                folder.chmod(0o700)
                created_at = int(time.time() * 1000)
                manifest = []
                for image in images:
                    storage_id = uuid.uuid4().hex
                    manifest.append({key: image[key] for key in ("id", "name", "mime_type", "size")}
                                    | {"storage_id": storage_id})
                snapshot = {"schema_version": 1, "id": share_id, "title": title,
                            "created_at": created_at, "messages": messages, "images": manifest}
                public_size = len(_json(self._public_snapshot(snapshot)).encode("utf-8"))
                if public_size > MAX_SNAPSHOT_BYTES:
                    raise ChatError(413, "分享消息和图片信息超过 16 MiB，请减少分享范围。")
                serialized = _json(snapshot).encode("utf-8")
                size = len(serialized) + sum(len(image["content"]) for image in images)
                count, owner_used = db.execute("SELECT COUNT(*),COALESCE(SUM(stored_bytes),0) FROM conversation_shares WHERE owner_id=? AND revoked=0", (owner,)).fetchone()
                if count >= 100 or owner_used + size > 128 * 1024**2:
                    raise ChatError(413, "公开分享已达账号上限（100 条或 128 MiB），请先撤销旧分享。")
                used = share_usage(db)
                settings = self.store.settings
                check_growth(self.directory / "snapshot.json", size, used, settings.share_pool_bytes, settings.disk_reserve_bytes)
                for image, item in zip(images, manifest):
                    self._write(folder / item["storage_id"], image["content"])
                self._write(folder / "snapshot.json", serialized)
                db.execute("""INSERT INTO conversation_shares(id,owner_id,client_request_id,payload_hash,
                    conversation_id,title,message_count,image_count,created_at,stored_bytes) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                    (share_id, owner, request_id, checksum, conversation_id, title, len(messages), len(images), created_at, size))
                row = db.execute("SELECT * FROM conversation_shares WHERE id=?", (share_id,)).fetchone()
                result = self._metadata(row, origin)
            return result, True
        except BaseException:
            if created_id is not None:
                self._remove(created_id)
            raise

    def list(self, owner, conversation_id, origin):
        if conversation_id is not None:
            _string(conversation_id, 512)
        with self.store.connection() as db:
            query = "SELECT * FROM conversation_shares WHERE owner_id=? AND revoked=0"
            params = [owner]
            if conversation_id is not None:
                query += " AND conversation_id=?"
                params.append(conversation_id)
            rows = db.execute(query + " ORDER BY created_at DESC,id", params).fetchall()
        return {"shares": [self._metadata(row, origin) for row in rows]}

    def revoke(self, owner, share_id):
        self._folder(share_id)
        with self.store.connection(write=True) as db:
            row = db.execute("SELECT owner_id FROM conversation_shares WHERE id=?", (share_id,)).fetchone()
            if row is None or row["owner_id"] != owner:
                raise ChatError(404, "分享不存在或不属于当前账号。")
            db.execute("""UPDATE conversation_shares SET revoked=1,title=NULL,conversation_id=NULL,
                message_count=0,image_count=0 WHERE id=?""", (share_id,))
        # Denial is durable before deletion; a filesystem error cannot reopen it.
        # A retry and startup both finish interrupted deletion.
        self._remove(share_id)
        return {"revoked": True}

    def _snapshot(self, share_id):
        folder = self._folder(share_id)
        with self.store.connection() as db:
            exists = db.execute("SELECT 1 FROM conversation_shares WHERE id=? AND revoked=0", (share_id,)).fetchone()
            if exists is None:
                raise ChatError(404, "分享不存在或已撤销。")
            try:
                return json.loads((folder / "snapshot.json").read_bytes())
            except FileNotFoundError:
                raise ChatError(404, "分享不存在或已撤销。") from None

    @staticmethod
    def _public_snapshot(snapshot):
        return {**snapshot, "images": [{key: image[key] for key in ("id", "name", "mime_type", "size")}
                | {"url": PUBLIC_API_PATH + "/" + snapshot["id"] + "/images/" + image["id"]}
                for image in snapshot["images"]]}

    def public(self, share_id):
        return self._public_snapshot(self._snapshot(share_id))

    def image(self, share_id, image_id):
        if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id):
            raise ChatError(404, "分享图片不存在或已撤销。")
        snapshot = self._snapshot(share_id)
        image = next((item for item in snapshot["images"] if item["id"] == image_id), None)
        if image is None:
            raise ChatError(404, "分享图片不存在或已撤销。")
        # storage_id is generated internally and never comes from an HTTP path.
        if not re.fullmatch(r"[a-f0-9]{32}", image["storage_id"]):
            raise OSError("Invalid private image identity")
        try:
            raw = (self._folder(share_id) / image["storage_id"]).read_bytes()
        except FileNotFoundError:
            raise ChatError(404, "分享图片不存在或已撤销。") from None
        return raw, image["mime_type"]


def _page(snapshot):
    escape = html.escape
    title = escape(snapshot["title"] or "分享的对话")
    images = {image["id"]: image for image in snapshot["images"]}
    messages = []
    for message in snapshot["messages"]:
        role = "用户" if message["role"] == "user" else "DeepSeek"
        media = "".join('<img loading="lazy" src="' + escape(images[value]["url"], quote=True)
                        + '" alt="' + escape(images[value]["name"], quote=True) + '">' for value in message["image_ids"])
        files = "".join('<li>' + escape(file["name"]) + ' · ' + str(file["size"]) + ' 字节</li>'
                        for file in message["files"])
        messages.append('<article class="' + message["role"] + '"><div class="role">' + role
                        + '</div><div class="content">' + escape(message["content"]) + '</div>' + media
                        + ('<ul class="files">' + files + '</ul>' if files else '') + '</article>')
    return ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<meta name="referrer" content="no-referrer"><title>' + title + ' · DeepSeek 记忆聊天</title>'
            '<style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#262626;'
            'font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header,main,footer{'
            'width:min(760px,100%);margin:auto;padding:24px}header{border-bottom:1px solid #eee}'
            'header small{color:#536df0}h1{font-size:24px;line-height:1.4;margin:8px 0;overflow-wrap:anywhere}'
            'header p,footer p{font-size:13px;color:#747474;margin:8px 0}article{margin:0 0 28px;'
            'overflow-wrap:anywhere}.role{font-size:13px;color:#777;margin-bottom:8px}.content{'
            'white-space:pre-wrap}.user{background:#f5f6fa;padding:16px 20px;border-radius:18px}'
            'img{display:block;max-width:100%;height:auto;max-height:75vh;object-fit:contain;margin-top:14px;'
            'border-radius:10px}.files{font-size:13px;color:#777;padding-left:20px}footer{'
            'border-top:1px solid #eee;padding-bottom:32px}a{display:block;background:#4d6bfe;color:white;'
            'text-align:center;text-decoration:none;padding:12px 18px;border-radius:14px}'
            '@media(max-width:480px){header,main,footer{padding:20px 16px}h1{font-size:21px}}</style></head>'
            '<body><header><small>DeepSeek 记忆聊天 · 公开分享</small><h1>' + title + '</h1>'
            '<p>这是创建者选定的对话副本，任何持有链接的人都可以查看。</p></header><main>'
            + ''.join(messages) + '</main><footer><a href="/deepseek/?share=' + snapshot["id"]
            + '">继续这段对话</a><p>导入为你的新会话后继续交流。创建者可随时撤销分享。</p></footer></body></html>')


def _unavailable_page(message):
    return ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<meta name="referrer" content="no-referrer"><title>分享暂不可用 · DeepSeek 记忆聊天</title>'
            '<style>body{margin:0;padding:48px 20px;background:#fff;color:#262626;'
            'font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}'
            'main{max-width:620px;margin:auto}small{color:#536df0}h1{font-size:24px}'
            'p{overflow-wrap:anywhere}a{display:inline-block;margin-top:16px;padding:10px 20px;'
            'background:#4d6bfe;color:white;border-radius:12px;text-decoration:none}</style></head>'
            '<body><main><small>DeepSeek 记忆聊天</small><h1>分享暂不可用</h1><p>'
            + html.escape(message) + '</p><a href="/deepseek/">回到聊天</a></main></body></html>')


def build_conversation_share_router(store, shares, public_origin=None):
    router = APIRouter(prefix="/chat")
    origin = (public_origin or os.environ.get("PUBLIC_ORIGIN", "https://digimonlegend.com")).rstrip("/")

    async def owner(request):
        if not _origin_ok(request, origin):
            raise ChatError(403, "请从当前应用管理分享。")
        owner_id = await asyncio.to_thread(store.accounts.authenticate, _token(request))
        if owner_id is None:
            raise ChatError(401, "登录已过期，请重新登录。", {"X-Session-Expired": "1"})
        if request.headers.get("X-Chat-User-Id") != str(owner_id):
            raise ChatError(409, "账号已切换，请刷新页面后继续。", {"X-Session-Changed": "1"})
        return owner_id

    def failure(error):
        if isinstance(error, ChatError):
            return _error(error.status, error.message, {**PUBLIC_HEADERS, **error.headers})
        logger.error("Conversation share storage failed type=%s", type(error).__name__)
        return _error(503, "分享暂时无法保存或读取，请稍后重试。", PUBLIC_HEADERS)

    @router.post("/api/conversation-shares")
    async def create(request: Request):
        try:
            account = await owner(request)
            raw = await _body(request, MAX_REQUEST_BYTES, "分享请求超过 64 MiB，请减少消息或图片后重试。")
            # Revalidate after upload; no stale account write after session expiry.
            if await owner(request) != account:
                raise ChatError(409, "账号已切换，请刷新页面后继续。", {"X-Session-Changed": "1"})
            result, created = await asyncio.to_thread(shares.create, account, raw, origin)
            return JSONResponse(result, status_code=201 if created else 200, headers=PUBLIC_HEADERS)
        except (ChatError, OSError) as error:
            return failure(error)

    @router.get("/api/conversation-shares")
    async def list_shares(request: Request, conversation_id: str | None = None):
        try:
            return JSONResponse(await asyncio.to_thread(shares.list, await owner(request), conversation_id, origin), headers=PUBLIC_HEADERS)
        except (ChatError, OSError) as error:
            return failure(error)

    @router.delete("/api/conversation-shares/{share_id}")
    async def revoke(request: Request, share_id: str):
        try:
            return JSONResponse(await asyncio.to_thread(shares.revoke, await owner(request), share_id), headers=PUBLIC_HEADERS)
        except (ChatError, OSError) as error:
            return failure(error)

    @router.api_route("/api/conversation-shares/{share_id}", methods=["GET", "HEAD"])
    async def public(share_id: str):
        try:
            return JSONResponse(await asyncio.to_thread(shares.public, share_id), headers=PUBLIC_HEADERS)
        except (ChatError, OSError) as error:
            return failure(error)

    @router.api_route("/api/conversation-shares/{share_id}/images/{image_id}", methods=["GET", "HEAD"])
    async def image(share_id: str, image_id: str):
        try:
            raw, mime = await asyncio.to_thread(shares.image, share_id, image_id)
            return Response(raw, media_type=mime, headers=PUBLIC_HEADERS)
        except (ChatError, OSError) as error:
            return failure(error)

    @router.api_route("/public-shares/{share_id}", methods=["GET", "HEAD"])
    async def page(share_id: str):
        try:
            snapshot = await asyncio.to_thread(shares.public, share_id)
            return HTMLResponse(_page(snapshot), headers=PAGE_HEADERS)
        except ChatError as error:
            return HTMLResponse(_unavailable_page(error.message), status_code=error.status, headers=PAGE_HEADERS)
        except OSError as error:
            logger.error("Conversation share page failed type=%s", type(error).__name__)
            return HTMLResponse(_unavailable_page("分享暂时无法读取，请稍后重试。"), status_code=503, headers=PAGE_HEADERS)

    return router
