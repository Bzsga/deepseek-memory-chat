"""Same-origin streaming chat with the registered identity and shared quota.

Only attachment ownership and content-free call records are persisted here.
Raw conversations, prompts, recordings and attachment bytes stay out of SQLite.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import html
import io
import json
import logging
import os
import re
import time
import wave
from dataclasses import dataclass, field
from email import policy
from email.parser import BytesParser
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import anyio
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse

from .admin_access import _client_ip
from .image_jobs import ImageJobError
from .store import ServiceError, digest


PREFIX = "/chat"
PUBLIC_API_PATH = "/deepseek-api"
WEB_PATH = "/deepseek/"
COOKIE_NAME = "deepseek_session"
MAX_BODY = 70 * 1024 * 1024
MAX_SMALL_RESPONSE = 256 * 1024
MAX_IMAGE_RESPONSE = 32 * 1024 * 1024
IMAGE_HEARTBEAT_SECONDS = 5
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
MAX_USER_DATA_BYTES = 32 * 1024 * 1024
MAX_ASR_BYTES = 8 * 1024 * 1024
ASR_SAMPLE_RATES = {8000, 16000, 22050, 24000, 32000, 44100, 48000}
FILES_BETA = "files-api-2025-04-14"
IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "tif", "tiff", "heic", "heif"}
logger = logging.getLogger(__name__)
FILE_ID = re.compile(r"[A-Za-z0-9_-]{1,200}\Z")
ROUTES = {
    ("GET", "/models"),
    ("POST", "/anthropic/v1/messages"),
    ("POST", "/anthropic/v1/files"),
    ("POST", "/v1/tools/asr"),
    ("POST", "/v1/tools/tts"),
}
KINDS = {"/anthropic/v1/messages": "chat", "/anthropic/v1/files": "file",
         "/v1/tools/asr": "asr", "/v1/tools/tts": "tts"}
COMMON_HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                  "Referrer-Policy": "same-origin"}


@dataclass(frozen=True)
class ChatProvider:
    origin: str
    model: str
    api_key: str = field(repr=False)


@dataclass(frozen=True)
class ImageProvider:
    origin: str
    model: str
    api_key: str = field(repr=False)
    size: str = "1024x1024"
    timeout: float = 100


class ChatError(Exception):
    def __init__(self, status, message, headers=None, code=None):
        self.status, self.message, self.headers = status, message, headers or {}
        self.code = code


class ImageStreamingResponse(StreamingResponse):
    async def stream_response(self, send):
        try:
            await super().stream_response(send)
        finally:
            # ASGI 2.4 can report a disconnect through send(), after a yield.
            # Close the owned generator immediately so it cancels generation.
            with anyio.CancelScope(shield=True):
                await self.body_iterator.aclose()


def _error(status, message, headers=None, code=None):
    error = {"message": message}
    if code:
        error["code"] = code
    return JSONResponse({"error": error}, status_code=status,
                        headers={**COMMON_HEADERS, **(headers or {})})


def _image_type(raw):
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(raw) >= 16 and raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


def _validate_file_upload(body, content_type):
    """Check the selected file before an upstream request consumes allowance."""
    if len(content_type) > 4096 or any(char in content_type for char in "\r\n"):
        raise ChatError(400, "上传格式无效，请重新选择文件。", code="upload_invalid")
    try:
        envelope = ("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode("ascii")
        multipart = BytesParser(policy=policy.default).parsebytes(envelope + body)
        if not multipart.is_multipart() or multipart.defects:
            raise ValueError
        fields, file_part = {}, None
        for part in multipart.iter_parts():
            if part.is_multipart() or part.defects or part.get_content_disposition() != "form-data":
                raise ValueError
            name = part.get_param("name", header="content-disposition")
            if name == "file":
                if file_part is not None or not part.get_filename():
                    raise ValueError
                file_part = part
            else:
                if name not in {"purpose", "expires_after[anchor]", "expires_after[seconds]"} or name in fields:
                    raise ValueError
                payload = part.get_payload(decode=True)
                if payload is None or len(payload) > 128:
                    raise ValueError
                fields[name] = payload.decode("ascii")
        if file_part is None:
            raise ValueError
        purpose = fields.get("purpose", "user_data")
        if purpose not in {"user_data", "text_recognition", "rich_layout_recognition"}:
            raise ValueError
        if ("expires_after[anchor]" in fields) != ("expires_after[seconds]" in fields):
            raise ValueError
        if "expires_after[anchor]" in fields:
            if fields["expires_after[anchor]"] != "created_at" or not fields["expires_after[seconds]"].isdigit():
                raise ValueError
            if not 3600 <= int(fields["expires_after[seconds]"]) <= 2592000:
                raise ValueError
        raw = file_part.get_payload(decode=True)
        if not raw:
            raise ValueError
    except (ValueError, UnicodeError, TypeError):
        raise ChatError(400, "上传格式无效或文件为空，请重新选择文件。", code="upload_invalid") from None

    detected = _image_type(raw)
    declared = file_part.get_content_type()
    declared = {"image/jpg": "image/jpeg", "image/x-png": "image/png"}.get(declared, declared)
    extension = Path(file_part.get_filename()).suffix.lower().lstrip(".")
    image_selected = declared.startswith("image/") or extension in IMAGE_EXTENSIONS
    if purpose == "user_data" and image_selected and detected is None:
        raise ChatError(415, "看图支持 JPG、PNG、GIF 和 WebP，请转换图片格式后上传。", code="upload_image_format")
    if detected and declared.startswith("image/") and declared != detected:
        raise ChatError(415, "图片格式与文件内容不一致，请重新保存后上传。", code="upload_image_format")
    maximum = MAX_UPLOAD_BYTES if detected or purpose != "user_data" else MAX_USER_DATA_BYTES
    if len(raw) > maximum:
        size = maximum // (1024 * 1024)
        raise ChatError(413, f"该文件最多支持 {size} MB，请缩小后重新上传。", code="upload_too_large")
    return detected


def _image_provider_failure(status, retry_after=None):
    failures = {
        400: (422, "图片描述或生成参数未被服务接受，请调整描述后重试。", "image_request_rejected"),
        401: (503, "生图服务鉴权失败，请联系管理员检查配置。", "image_provider_auth"),
        403: (503, "生图服务拒绝访问，请联系管理员检查服务权限。", "image_provider_auth"),
        402: (503, "生图服务额度不足，请联系管理员补充额度。", "image_provider_quota"),
        404: (503, "生图模型或接口不可用，请联系管理员检查配置。", "image_model_unavailable"),
        408: (504, "图片生成等待超时，未收到确定结果。请稍后手动重试。", "image_timeout"),
        422: (422, "图片描述或生成参数未被服务接受，请调整描述后重试。", "image_request_rejected"),
        429: (429, "生图服务请求过多，请稍后重试。", "image_rate_limited"),
        504: (504, "图片生成等待超时，未收到确定结果。请稍后手动重试。", "image_timeout"),
    }
    result_status, message, code = failures.get(status,
        (502, "生图服务暂时无法完成请求，请稍后手动重试。", "image_provider_unavailable"))
    headers = {}
    if status == 429 and isinstance(retry_after, str) and retry_after.isdigit() and len(retry_after) <= 4:
        headers["Retry-After"] = str(min(int(retry_after), 3600))
    logger.warning("Image provider request failed status=%s code=%s", status, code)
    return ChatError(result_status, message, headers, code)


def _validate_asr_upload(body, content_type):
    """Reject malformed or empty local recordings before an allowance is used."""
    try:
        if len(content_type) > 4096 or any(char in content_type for char in "\r\n"):
            raise ValueError
        envelope = ("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode("ascii")
        multipart = BytesParser(policy=policy.default).parsebytes(envelope + body)
        if not multipart.is_multipart() or multipart.defects:
            raise ValueError
        parts = list(multipart.iter_parts())
        if len(parts) != 1:
            raise ValueError
        part = parts[0]
        if (part.is_multipart() or part.defects or part.get_content_disposition() != "form-data"
                or part.get_param("name", header="content-disposition") != "file"):
            raise ValueError
        raw = part.get_payload(decode=True)
        if not raw:
            raise ChatError(400, "录音没有采集到声音，请重新录制。", code="asr_audio_empty")
        if len(raw) > MAX_ASR_BYTES:
            raise ChatError(413, "录音超过 8 MiB，请缩短后重试。", code="asr_audio_too_large")
        # The provider detects the container from bytes, including Ogg uploads
        # whose browser supplied a generic MIME type or filename.
        if raw.startswith(b"OggS") and b"OpusHead" in raw[:512]:
            return
        if not raw.startswith(b"RIFF") or raw[8:12] != b"WAVE":
            raise ValueError
        with wave.open(io.BytesIO(raw), "rb") as audio:
            channels, rate, frames = audio.getnchannels(), audio.getframerate(), audio.getnframes()
            if channels not in (1, 2) or audio.getsampwidth() != 2 or rate not in ASR_SAMPLE_RATES or audio.getcomptype() != "NONE":
                raise ValueError
            if frames > rate * 120:
                raise ChatError(400, "录音超过 120 秒，请缩短后重试。", code="asr_audio_too_long")
            samples = audio.readframes(frames)
            if len(samples) != frames * channels * 2:
                raise ValueError
            if not samples or not any(samples):
                raise ChatError(400, "录音没有采集到声音，请重新录制。", code="asr_audio_empty")
    except (ValueError, UnicodeError, TypeError, EOFError, wave.Error):
        raise ChatError(400, "录音格式无效，请重新录制 PCM16 WAV 或 Ogg Opus 音频。", code="asr_audio_invalid") from None


def _asr_provider_failure(status, retry_after=None):
    failures = {
        400: (400, "语音识别服务无法读取这段录音，请重新录制。", "asr_audio_rejected"),
        401: (503, "语音识别服务鉴权失败，请联系管理员。", "asr_provider_auth"),
        403: (503, "语音识别服务未获授权，请联系管理员。", "asr_provider_auth"),
        402: (503, "语音识别服务额度不足，请联系管理员。", "asr_provider_quota"),
        408: (504, "录音上传超时，请稍后手动重试。", "asr_timeout"),
        413: (413, "录音超过语音识别服务的 8 MiB 上限，请缩短后重试。", "asr_audio_too_large"),
        415: (415, "语音识别服务不支持这段录音的格式，请重新录制。", "asr_audio_invalid"),
        422: (422, "语音识别服务无法处理这段录音，请重新录制。", "asr_audio_rejected"),
        429: (429, "语音识别服务繁忙，请稍后重试。", "asr_rate_limited"),
        503: (503, "语音识别服务繁忙，请稍后重试。", "asr_provider_busy"),
        504: (504, "语音识别超时，请稍后手动重试。", "asr_timeout"),
    }
    result_status, message, code = failures.get(status,
        (502, "语音识别服务暂不可用，请稍后重试。", "asr_provider_unavailable"))
    headers = {}
    if status == 429 and isinstance(retry_after, str) and retry_after.isdigit() and len(retry_after) <= 4:
        headers["Retry-After"] = str(min(int(retry_after), 3600))
    logger.warning("ASR provider request failed status=%s code=%s", status, code)
    return ChatError(result_status, message, headers, code)


async def _asr_document(upstream):
    chunks, size = [], 0
    async for chunk in upstream.aiter_bytes():
        size += len(chunk)
        if size > MAX_SMALL_RESPONSE:
            raise ValueError
        chunks.append(chunk)
    value = json.loads(b"".join(chunks))
    if not isinstance(value, dict) or not isinstance(value.get("text"), str):
        raise ValueError
    result = {"text": value["text"]}
    if isinstance(value.get("request_id"), str) and len(value["request_id"]) <= 200:
        result["request_id"] = value["request_id"]
    if (isinstance(value.get("duration_ms"), int) and not isinstance(value["duration_ms"], bool)
            and 0 <= value["duration_ms"] <= 120000):
        result["duration_ms"] = value["duration_ms"]
    return result


def load_chat_provider(store):
    """Use the dedicated official provider credential without sending it to clients."""
    path = os.environ.get("CHAT_PROVIDER_CONFIG")
    if path:
        document = json.loads(Path(path).read_text(encoding="utf-8-sig"))
        base, model, key = document["base_url"], document["model"], document["api_key"]
    else:
        settings = store.current_settings()
        base, model, key = settings.base_url, settings.model, settings.api_key
    parsed = urlsplit(base)
    if (parsed.scheme != "https" or parsed.hostname != "api.deepseek.com"
            or parsed.port not in (None, 443) or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path.rstrip("/") not in ("", "/v1")):
        raise ValueError("Chat requires the official DeepSeek endpoint")
    if not all(isinstance(value, str) and value and "\r" not in value and "\n" not in value
               for value in (model, key)):
        raise ValueError("Invalid chat provider credentials")
    return ChatProvider("https://api.deepseek.com", model, key)


def load_image_provider():
    """Read the verified AstrBot draw configuration format from a private file."""
    configured = os.environ.get("IMAGE_PROVIDER_CONFIG")
    if not configured:
        return None
    with Path(configured).open("r", encoding="utf-8-sig") as source:
        raw = source.read(32769)
    if len(raw) > 32768:
        raise ValueError("Image provider configuration too large")
    document = json.loads(raw)
    if not isinstance(document, dict):
        raise ValueError("Invalid image provider configuration")
    if document.get("enabled") is False:
        return None
    base = document["base_url"]
    model, key = document["default_model"], document["api_key"]
    parsed = urlsplit(base)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path.rstrip("/")):
        raise ValueError("Invalid image provider origin")
    if not all(isinstance(value, str) and value and len(value) <= 4096
               and not any(char in value for char in "\r\n") for value in (model, key)):
        raise ValueError("Invalid image provider credentials")
    size, timeout = document.get("default_size", "1024x1024"), document.get("request_timeout", 100)
    if not isinstance(size, str) or not re.fullmatch(r"[1-9][0-9]{2,3}x[1-9][0-9]{2,3}", size):
        raise ValueError("Invalid image dimensions")
    if type(timeout) not in (int, float) or not 1 <= timeout <= 180:
        raise ValueError("Invalid image request timeout")
    return ImageProvider(base.rstrip("/"), model, key, size, float(timeout))


def _token(request):
    authorization = request.headers.get("authorization", "")
    if authorization:
        parts = authorization.split(" ", 1)
        return parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else ""
    return request.cookies.get(COOKIE_NAME, "")


def _origin_ok(request, origin):
    supplied = request.headers.get("origin")
    if supplied:
        return supplied == origin
    return request.headers.get("sec-fetch-site") not in ("cross-site", "same-site")


async def _body(request, limit=MAX_BODY, size_message="文件或请求过大，单次请求最多支持 70 MB。"):
    length = request.headers.get("content-length")
    if length is not None:
        try:
            if int(length) < 0:
                raise ValueError
        except ValueError:
            raise ChatError(400, "请求长度无效。") from None
        if int(length) > limit:
            raise ChatError(413, size_message)
    result = bytearray()
    iterator = request.stream().__aiter__()
    while True:
        try:
            chunk = await asyncio.wait_for(anext(iterator), timeout=15)
        except StopAsyncIteration:
            break
        except asyncio.TimeoutError:
            raise ChatError(408, "上传超时，请重试。") from None
        if len(result) + len(chunk) > limit:
            raise ChatError(413, size_message)
        result.extend(chunk)
    return bytes(result)


def _files(store, operation, owner_id, file_id):
    # Lazy creation runs after the unified Store lifespan has initialized accounts.
    with store.connection(write=operation != "owns") as db:
        if operation == "owns":
            exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_files'").fetchone()
            return bool(exists and db.execute("SELECT 1 FROM chat_files WHERE owner_id=? AND file_id=?",
                                             (owner_id, file_id)).fetchone())
        db.execute("""CREATE TABLE IF NOT EXISTS chat_files (
            file_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES registered_accounts(user_id),
            created_at REAL NOT NULL)""")
        if operation == "remember":
            previous = db.execute("SELECT owner_id FROM chat_files WHERE file_id=?", (file_id,)).fetchone()
            if previous is not None and previous["owner_id"] != owner_id:
                return False
            db.execute("INSERT OR IGNORE INTO chat_files VALUES(?,?,?)", (file_id, owner_id, time.time()))
            return True
        db.execute("DELETE FROM chat_files WHERE owner_id=? AND file_id=?", (owner_id, file_id))
        return True


def _personal_quota(quota):
    return {name: quota[name] for name in ("managed_eligible", "user_weekly_limit", "user_weekly_used", "user_weekly_reserved",
                                         "user_weekly_remaining", "reset_at") if name in quota}


def _image_output(document):
    data = document.get("data") if isinstance(document, dict) else None
    if not isinstance(data, list) or not 1 <= len(data) <= 4:
        raise ValueError("Invalid image output")
    normalized = []
    for item in data:
        if not isinstance(item, dict):
            raise ValueError("Invalid image output")
        normalized.append({"b64_json": item.get("b64_json") or item.get("b64")})
    return _validated_images(normalized)


def _validated_images(images):
    """Validate normalized provider output before exposing any generated bytes."""
    if not isinstance(images, list) or not 1 <= len(images) <= 4:
        raise ValueError("Invalid image output count")
    result = []
    total = 0
    for value in images:
        if not isinstance(value, dict) or not isinstance(value.get("b64_json"), str):
            raise ValueError("Missing encoded image")
        encoded = value["b64_json"]
        if not encoded or len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
            raise ValueError("Image output too large")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("Invalid encoded image") from None
        total += len(raw)
        if total > 24 * 1024 * 1024:
            raise ValueError("Image outputs too large")
        if raw.startswith(b"\x89PNG\r\n\x1a\n"):
            mime = "image/png"
        elif raw.startswith(b"\xff\xd8\xff"):
            mime = "image/jpeg"
        elif raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
            mime = "image/webp"
        else:
            raise ValueError("Unsupported image output")
        result.append({"b64_json": encoded, "mime_type": mime})
    return result


def _auth_page(register=False, error=""):
    action, title = ("register", "创建账号") if register else ("login", "欢迎回来")
    link = (f'已有账号？<a href="{PUBLIC_API_PATH}{PREFIX}/login">登录</a>' if register else
            f'还没有账号？<a href="{PUBLIC_API_PATH}{PREFIX}/register">注册</a>')
    return f'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · DeepSeek 记忆聊天</title><style>*{{box-sizing:border-box}}body{{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:#f7f8fc;color:#24252b;font:15px system-ui,sans-serif}}main{{width:min(100%,400px);padding:30px;border-radius:20px;background:white;border:1px solid #e8eaf0}}h1{{font-size:24px;margin:0 0 10px}}p{{color:#747987;line-height:1.6}}label{{display:block;margin:16px 0 8px}}input,button{{width:100%;min-height:44px;border-radius:10px;font:inherit}}input{{border:1px solid #d9dde8;padding:10px 12px}}button{{border:0;margin-top:22px;background:#4d6bfe;color:white}}a{{color:#4d6bfe}}.error{{color:#b83737}}@media(prefers-color-scheme:dark){{body{{background:#1b1c20;color:#eee}}main{{background:#232429;border-color:#363942}}input{{background:#1c1d21;color:#eee;border-color:#444957}}}}</style>
<main><h1>{title}</h1>
<form method="post" action="{PUBLIC_API_PATH}{PREFIX}/{action}"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" required minlength="3" maxlength="32">
<label for="password">密码</label><input id="password" name="password" type="password" autocomplete="{'new-password' if register else 'current-password'}" required minlength="8" maxlength="128">
<p class="error" role="alert">{html.escape(error)}</p><button type="submit">{'注册' if register else '登录'}</button></form><p>{link}</p></main></html>'''


def build_chat_router(store, *, client_factory=None, provider_loader=None, image_provider_loader=None,
                      public_origin=None, image_jobs=None):
    """Build routes without opening credentials, databases or network connections."""
    router = APIRouter(prefix=PREFIX)
    origin = (public_origin or os.environ.get("PUBLIC_ORIGIN", "https://digimonlegend.com")).rstrip("/")
    provider_loader = provider_loader or (lambda: load_chat_provider(store))
    image_provider_loader = image_provider_loader or load_image_provider
    client_factory = client_factory or (lambda: httpx.AsyncClient(
        timeout=httpx.Timeout(connect=15, read=180, write=30, pool=15),
        follow_redirects=False, trust_env=False))

    async def context(request, require_claim=True):
        token = _token(request)
        owner_id = await asyncio.to_thread(store.accounts.authenticate, token)
        if owner_id is None:
            raise ChatError(401, "登录已过期，请重新登录。", {"X-Session-Expired": "1"})
        account = await asyncio.to_thread(store.accounts.me, owner_id)
        claimed = request.headers.get("X-Chat-User-Id")
        if (require_claim or claimed is not None) and claimed != str(owner_id):
            raise ChatError(409, "账号已切换，请刷新页面后继续。", {"X-Session-Changed": "1"})
        return token, owner_id, account

    async def open_upstream(client, outgoing, request, token, owner_id, *, watch_disconnect=True):
        """Stop waiting for headers when the client or registered session ends."""
        task = asyncio.create_task(client.send(outgoing, stream=True, follow_redirects=False))
        try:
            while True:
                done, _pending = await asyncio.wait({task}, timeout=0.25)
                if await asyncio.to_thread(store.accounts.authenticate, token) != owner_id:
                    raise ChatError(401, "登录已过期，请重新登录。", {"X-Session-Expired": "1"})
                if watch_disconnect and await request.is_disconnected():
                    raise ChatError(499, "请求已停止。")
                if done:
                    return task.result()
        finally:
            if not task.done():
                with anyio.CancelScope(shield=True):
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

    async def auth(request, register=False):
        if request.method == "GET":
            if await asyncio.to_thread(store.accounts.authenticate, _token(request)):
                return RedirectResponse(WEB_PATH, status_code=303, headers=COMMON_HEADERS)
            return HTMLResponse(_auth_page(register), headers=COMMON_HEADERS)
        if not _origin_ok(request, origin):
            raise ChatError(403, "请从本站发起操作。")
        fields = parse_qs((await _body(request, 8192)).decode("utf-8"), max_num_fields=4)
        username, password = fields.get("username", [""])[0], fields.get("password", [""])[0]
        try:
            if register:
                result = await asyncio.to_thread(store.accounts.register, username, password,
                    fields.get("invitation_code", [""])[0] or None, _client_ip(request))
            else:
                result = await asyncio.to_thread(store.accounts.login, username, password, _client_ip(request))
        except ServiceError as error:
            return HTMLResponse(_auth_page(register, error.message), status_code=error.status, headers=COMMON_HEADERS)
        response = RedirectResponse(WEB_PATH, status_code=303, headers=COMMON_HEADERS)
        response.set_cookie(COOKIE_NAME, result["token"], max_age=30 * 86400,
                            path=PUBLIC_API_PATH, secure=True, httponly=True, samesite="strict")
        return response

    @router.api_route("/login", methods=["GET", "POST"])
    async def login(request: Request):
        try:
            return await auth(request)
        except (ChatError, ServiceError) as error:
            return _error(error.status, error.message, getattr(error, "headers", None))
        except (ValueError, UnicodeError):
            return _error(400, "登录表单格式无效。")

    @router.api_route("/register", methods=["GET", "POST"])
    async def register(request: Request):
        try:
            return await auth(request, register=True)
        except (ChatError, ServiceError) as error:
            return _error(error.status, error.message, getattr(error, "headers", None))
        except (ValueError, UnicodeError):
            return _error(400, "注册表单格式无效。")

    @router.post("/logout")
    async def logout(request: Request):
        if not _origin_ok(request, origin):
            return _error(403, "请从本站发起操作。")
        await asyncio.to_thread(store.accounts.logout, _token(request))
        response = RedirectResponse(PUBLIC_API_PATH + PREFIX + "/login", status_code=303, headers=COMMON_HEADERS)
        response.delete_cookie(COOKIE_NAME, path=PUBLIC_API_PATH, secure=True, httponly=True, samesite="strict")
        return response

    @router.get("/api/runtime")
    async def runtime(request: Request):
        try:
            _session, owner_id, account = await context(request, require_claim=False)
            model = "deepseek-flash"
            if account["user"]["managed_eligible"]:
                try:
                    model = provider_loader().model
                except (ValueError, OSError, KeyError, TypeError):
                    pass  # Account access and personal API setup work independently of managed credentials.
            try:
                image_provider = image_provider_loader()
            except (ValueError, OSError, KeyError, TypeError):
                image_provider = None
            return JSONResponse({"provider": "DeepSeek", "model": model,
                "features": {"search": True, "files": True, "speech": True,
                             "image_generation": image_provider is not None},
                "image_model": image_provider.model if image_provider else None,
                "user": {"id": str(owner_id), "username": account["user"]["username"], "role": account["user"]["role"],
                         "managed_eligible": account["user"]["managed_eligible"]},
                "weekly_quota": _personal_quota(account["quota"])}, headers=COMMON_HEADERS)
        except (ChatError, ServiceError) as error:
            return _error(error.status, error.message, getattr(error, "headers", None))
        except (ValueError, OSError, KeyError, TypeError):
            return _error(503, "聊天服务配置暂不可用。")

    @router.post("/api/redeem-invite")
    async def redeem_invite(request: Request):
        try:
            if request.url.query or not _origin_ok(request, origin):
                raise ChatError(403, "请从本站发起操作。")
            _session, owner_id, _account = await context(request)
            document = json.loads(await _body(request, 2048))
            if not isinstance(document, dict) or set(document) != {"invitation_code"}:
                raise ValueError
            result = await asyncio.to_thread(store.accounts.redeem_invite, owner_id, document["invitation_code"])
            return JSONResponse({"user": result["user"], "quota": _personal_quota(result["quota"])}, headers=COMMON_HEADERS)
        except (ValueError, UnicodeError, RecursionError):
            return _error(400, "请输入有效的邀请码。")
        except (ChatError, ServiceError) as error:
            return _error(error.status, error.message, getattr(error, "headers", None))

    @router.get("/api/quota")
    async def quota(request: Request):
        try:
            _session, _owner_id, account = await context(request)
            return JSONResponse(_personal_quota(account["quota"]), headers=COMMON_HEADERS)
        except (ChatError, ServiceError) as error:
            return _error(error.status, error.message, getattr(error, "headers", None))

    async def generate_image(request, token, owner_id, provider, prompt, *, watch_disconnect):
        client, upstream, call_id, outcome = None, None, None, "failed"
        read_task = None

        async def perform():
            nonlocal client, upstream, call_id, read_task, outcome
            client = client_factory()
            outgoing = client.build_request("POST", provider.origin + "/v1/images/generations",
                headers={"Authorization": "Bearer " + provider.api_key, "Content-Type": "application/json",
                         "Accept": "application/json", "Accept-Encoding": "identity",
                         "User-Agent": "DeepSeek-Memory-Chat/2.0"},
                json={"model": provider.model, "prompt": prompt, "n": 1, "size": provider.size},
                timeout=httpx.Timeout(provider.timeout, connect=15, write=30, pool=15))
            debit = asyncio.create_task(asyncio.to_thread(store.begin_chat_call, owner_id, "image",
                                                         account_session_hash=digest(token)))
            try:
                call_id = await asyncio.shield(debit)
            except asyncio.CancelledError:
                # The DB operation can finish after cancellation. Recover its
                # ID so the finally block can close that exact call record.
                with anyio.CancelScope(shield=True):
                    call_id = await debit
                raise
            upstream = await open_upstream(client, outgoing, request, token, owner_id,
                                           watch_disconnect=watch_disconnect)
            if not 200 <= upstream.status_code < 300:
                raise _image_provider_failure(upstream.status_code, upstream.headers.get("Retry-After"))
            if "application/json" not in upstream.headers.get("Content-Type", "").lower():
                raise ChatError(502, "生图服务返回了异常格式，请联系管理员检查接口。", code="image_invalid_response")
            chunks, length = [], 0
            iterator = upstream.aiter_bytes().__aiter__()
            read_task = asyncio.create_task(anext(iterator))
            while True:
                done, _pending = await asyncio.wait({read_task}, timeout=0.25)
                if await asyncio.to_thread(store.accounts.authenticate, token) != owner_id:
                    outcome = "aborted"
                    raise ChatError(401, "登录已过期，请重新登录。", {"X-Session-Expired": "1"})
                if watch_disconnect and await request.is_disconnected():
                    outcome = "aborted"
                    raise ChatError(499, "图片生成已停止。")
                if not done:
                    continue
                try:
                    chunk = read_task.result()
                except StopAsyncIteration:
                    break
                length += len(chunk)
                if length > MAX_IMAGE_RESPONSE:
                    raise ChatError(502, "生成图片超过保存上限，请联系管理员调整输出尺寸。", code="image_too_large")
                chunks.append(chunk)
                read_task = asyncio.create_task(anext(iterator))
            result = {"images": _image_output(json.loads(b"".join(chunks))), "model": provider.model}
            if len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_IMAGE_RESPONSE:
                raise ChatError(502, "生成图片超过保存上限，请联系管理员调整输出尺寸。", code="image_too_large")
            outcome = "success"
            return result

        try:
            return await asyncio.wait_for(perform(), timeout=provider.timeout)
        except (ChatError, ServiceError) as error:
            if error.status in (401, 499):
                outcome = "aborted"
            raise
        except asyncio.CancelledError:
            outcome = "aborted"
            raise
        except (asyncio.TimeoutError, httpx.TimeoutException):
            logger.warning("Image provider request failed code=image_timeout")
            raise ChatError(504, "图片生成等待超时，未收到确定结果。请稍后手动重试。", code="image_timeout") from None
        except (httpx.HTTPError, OSError):
            logger.warning("Image provider request failed code=image_connection")
            raise ChatError(502, "生图连接中断，未收到确定结果。请检查网络后手动重试。", code="image_connection") from None
        except (ValueError, UnicodeError, RecursionError):
            logger.warning("Image provider request failed code=image_invalid_response")
            raise ChatError(502, "生图服务未返回有效图片，请联系管理员检查接口。", code="image_invalid_response") from None
        finally:
            with anyio.CancelScope(shield=True):
                if read_task and not read_task.done():
                    read_task.cancel()
                    await asyncio.gather(read_task, return_exceptions=True)
                if upstream:
                    await upstream.aclose()
                if client:
                    await client.aclose()
                if call_id:
                    await asyncio.to_thread(store.finish_chat_call, call_id, outcome)

    if image_jobs is not None:
        async def generate_background(token, owner_id, provider, prompt):
            try:
                return await generate_image(None, token, owner_id, provider, prompt, watch_disconnect=False)
            except (ChatError, ServiceError) as error:
                raise ImageJobError(error.status, error.message,
                    getattr(error, "code", None) or "image_job_failed") from None

        image_jobs.generator = generate_background

    def background_images():
        if image_jobs is None:
            raise ImageJobError(503, "后台图片生成服务暂不可用。", "image_job_unavailable")
        return image_jobs

    @router.post("/api/image-jobs")
    async def create_image_job(request: Request):
        try:
            if request.url.query or not _origin_ok(request, origin):
                raise ChatError(403, "请从本站发起操作。")
            token, owner_id, account = await context(request)
            if not account["user"]["managed_eligible"]:
                raise ChatError(403, account["quota"]["message"], code="managed_ineligible")
            try:
                document = json.loads(await _body(request, 32768))
                if (not isinstance(document, dict) or set(document) != {"prompt", "client_request_id"}
                        or not isinstance(document["prompt"], str)
                        or not 1 <= len(document["prompt"].strip()) <= 8000):
                    raise ValueError
            except (ValueError, UnicodeError, RecursionError):
                raise ChatError(400, "请填写 1–8000 字的图片描述，并提供生成请求编号。") from None
            try:
                provider = image_provider_loader()
            except (ValueError, OSError, KeyError, TypeError):
                provider = None
            result, created = await background_images().create(owner_id, document["client_request_id"],
                document["prompt"].strip(), token, provider)
            return JSONResponse(result, status_code=202 if created else 200, headers=COMMON_HEADERS)
        except (ChatError, ServiceError, ImageJobError) as error:
            return _error(error.status, error.message, getattr(error, "headers", None), getattr(error, "code", None))

    @router.get("/api/image-jobs/{request_id}")
    async def get_image_job(request_id: str, request: Request):
        try:
            if request.url.query:
                raise ChatError(404, "接口不存在。")
            _token, owner_id, _account = await context(request)
            return JSONResponse(await background_images().get(owner_id, request_id), headers=COMMON_HEADERS)
        except (ChatError, ServiceError, ImageJobError) as error:
            return _error(error.status, error.message, getattr(error, "headers", None), getattr(error, "code", None))

    @router.get("/api/image-jobs/{request_id}/result")
    async def get_image_result(request_id: str, request: Request):
        try:
            if request.url.query:
                raise ChatError(404, "接口不存在。")
            _token, owner_id, _account = await context(request)
            return JSONResponse(await background_images().result(owner_id, request_id), headers=COMMON_HEADERS)
        except (ChatError, ServiceError, ImageJobError) as error:
            return _error(error.status, error.message, getattr(error, "headers", None), getattr(error, "code", None))

    @router.post("/api/image-jobs/{request_id}/cancel")
    async def cancel_image_job(request_id: str, request: Request):
        try:
            if request.url.query or not _origin_ok(request, origin):
                raise ChatError(403, "请从本站发起操作。")
            _token, owner_id, _account = await context(request)
            return JSONResponse(await background_images().cancel(owner_id, request_id), headers=COMMON_HEADERS)
        except (ChatError, ServiceError, ImageJobError) as error:
            return _error(error.status, error.message, getattr(error, "headers", None), getattr(error, "code", None))

    async def image_events(request, token, owner_id, provider, prompt):
        task = asyncio.create_task(generate_image(request, token, owner_id, provider, prompt,
                                                  watch_disconnect=False))
        try:
            yield b": image generation started\n\n"
            while not task.done():
                done, _pending = await asyncio.wait({task}, timeout=IMAGE_HEARTBEAT_SECONDS)
                if not done:
                    yield b": keepalive\n\n"
            try:
                result = task.result()
            except (ChatError, ServiceError) as error:
                detail = {"message": error.message, "status": error.status}
                if getattr(error, "code", None):
                    detail["code"] = error.code
                payload = {"error": detail}
                event = "error"
            except Exception:
                logger.error("Image stream failed code=image_internal")
                payload = {"error": {"message": "生图服务出现异常，请稍后手动重试。",
                                     "status": 500, "code": "image_internal"}}
                event = "error"
            else:
                payload, event = result, "result"
            yield ("event: " + event + "\ndata: " + json.dumps(payload, ensure_ascii=False,
                separators=(",", ":")) + "\n\n").encode("utf-8")
        finally:
            with anyio.CancelScope(shield=True):
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    @router.post("/api/images")
    async def images(request: Request):
        try:
            if request.url.query or not _origin_ok(request, origin):
                raise ChatError(403, "请从本站发起操作。")
            token, owner_id, account = await context(request)
            if not account["user"]["managed_eligible"]:
                raise ChatError(403, account["quota"]["message"], code="managed_ineligible")
            try:
                document = json.loads(await _body(request, 32768))
                if (not isinstance(document, dict) or set(document) != {"prompt"}
                        or not isinstance(document["prompt"], str)
                        or not 1 <= len(document["prompt"].strip()) <= 8000):
                    raise ValueError
            except (ValueError, UnicodeError, RecursionError):
                raise ChatError(400, "请填写 1–8000 字的图片描述。") from None
            try:
                provider = image_provider_loader()
            except (ValueError, OSError, KeyError, TypeError):
                provider = None
            if provider is None:
                raise ChatError(503, "生图服务尚未配置，请联系管理员。", code="image_provider_disabled")
            if "text/event-stream" in request.headers.get("accept", "").lower():
                return ImageStreamingResponse(image_events(request, token, owner_id, provider, document["prompt"]),
                    media_type="text/event-stream", headers={**COMMON_HEADERS, "X-Accel-Buffering": "no"})
            result = await generate_image(request, token, owner_id, provider, document["prompt"], watch_disconnect=True)
            return JSONResponse(result, headers=COMMON_HEADERS)
        except (ChatError, ServiceError) as error:
            return _error(error.status, error.message, getattr(error, "headers", None), getattr(error, "code", None))

    async def proxy(request, route):
        if request.url.query:
            raise ChatError(404, "接口不存在。")
        deletion = request.method == "DELETE" and route.startswith("/anthropic/v1/files/")
        file_id = route.rsplit("/", 1)[1] if deletion else None
        if (request.method, route) not in ROUTES and not (deletion and FILE_ID.fullmatch(file_id)):
            raise ChatError(404, "接口不存在。")
        if request.method != "GET" and not _origin_ok(request, origin):
            raise ChatError(403, "请从本站发起操作。")
        token, owner_id, account = await context(request)
        if not account["user"]["managed_eligible"] and not deletion:
            raise ChatError(403, account["quota"]["message"], code="managed_ineligible")
        body = b""
        if request.method == "POST":
            if route == "/v1/tools/asr":
                body = await _body(request, MAX_ASR_BYTES + 65536, "录音超过 8 MiB，请缩短后重试。")
            else:
                body = await _body(request)
        try:
            provider = provider_loader()
        except (ValueError, OSError, KeyError, TypeError):
            raise ChatError(503, "聊天服务配置暂不可用。") from None
        if route == "/anthropic/v1/messages":
            try:
                document = json.loads(body)
                if not isinstance(document, dict) or not isinstance(document.get("messages"), list) or not document["messages"]:
                    raise ValueError
                tools = document.get("tools")
                if isinstance(tools, list) and any(isinstance(tool, dict) and tool.get("name") == "generate_image" for tool in tools):
                    raise ChatError(409, "聊天生图调用已更新，请重新打开聊天页面后重试。", code="image_protocol_updated")
                pending = [document]
                while pending:
                    value = pending.pop()
                    if isinstance(value, dict):
                        if value.get("type") == "file" and "file_id" in value:
                            reference = value["file_id"]
                            if (not isinstance(reference, str) or not FILE_ID.fullmatch(reference)
                                    or not await asyncio.to_thread(_files, store, "owns", owner_id, reference)):
                                raise ChatError(403, "文件不属于当前账号，请重新上传附件。")
                        pending.extend(value.values())
                    elif isinstance(value, list):
                        pending.extend(value)
                document["model"] = provider.model
                body = json.dumps(document, ensure_ascii=False).encode("utf-8")
            except (ValueError, UnicodeError, RecursionError):
                raise ChatError(400, "消息格式无效。") from None
        elif route == "/v1/tools/tts":
            try:
                document = json.loads(body)
                if not isinstance(document, dict) or not isinstance(document.get("text"), str) or not document["text"].strip():
                    raise ValueError
            except (ValueError, UnicodeError, RecursionError):
                raise ChatError(400, "朗读内容无效。") from None
        elif route == "/v1/tools/asr":
            _validate_asr_upload(body, request.headers.get("content-type", ""))
        elif request.method == "POST":
            content_type = request.headers.get("content-type", "")
            if not body or not content_type.startswith("multipart/form-data;") or "boundary=" not in content_type:
                raise ChatError(400, "上传格式无效，请重新选择文件。")
            if route == "/anthropic/v1/files":
                _validate_file_upload(body, content_type)
        if deletion and not await asyncio.to_thread(_files, store, "owns", owner_id, file_id):
            raise ChatError(403, "文件不属于当前账号。")
        headers = {"Authorization": "Bearer " + provider.api_key, "x-api-key": provider.api_key,
                   "Accept-Encoding": "identity", "User-Agent": "DeepSeek-Memory-Chat/2.0"}
        for name in ("Content-Type", "anthropic-beta", "anthropic-version", "Accept"):
            if name in request.headers:
                headers[name] = request.headers[name]
        if route == "/anthropic/v1/files":
            headers.setdefault("anthropic-beta", FILES_BETA)
        client, upstream, call_id = None, None, None
        kind = KINDS.get(route) if request.method == "POST" else None
        try:
            client = client_factory()
            outgoing = client.build_request(request.method, provider.origin + route, headers=headers, content=body)
            if kind:
                call_id = await asyncio.to_thread(store.begin_chat_call, owner_id, kind,
                                                 account_session_hash=digest(token))
            upstream = await open_upstream(client, outgoing, request, token, owner_id)
        except asyncio.CancelledError:
            with anyio.CancelScope(shield=True):
                if call_id:
                    await asyncio.to_thread(store.finish_chat_call, call_id, "aborted")
                if client:
                    await client.aclose()
            raise
        except ChatError as error:
            if call_id:
                await asyncio.to_thread(store.finish_chat_call, call_id,
                                        "aborted" if error.status in (401, 499) else "failed")
            if client:
                await client.aclose()
            raise
        except (httpx.HTTPError, OSError) as failure:
            if call_id:
                await asyncio.to_thread(store.finish_chat_call, call_id, "failed")
            if client:
                await client.aclose()
            if route == "/v1/tools/asr":
                if isinstance(failure, httpx.TimeoutException):
                    raise ChatError(504, "语音识别连接超时，请稍后手动重试。", code="asr_timeout") from None
                raise ChatError(502, "暂时无法连接语音识别服务，请稍后重试。", code="asr_connection_failed") from None
            raise ChatError(502, "暂时无法连接模型服务，请稍后重试。") from None
        except BaseException:
            if client:
                await client.aclose()
            raise
        if not 200 <= upstream.status_code < 300:
            asr_failure = _asr_provider_failure(upstream.status_code, upstream.headers.get("Retry-After")) if route == "/v1/tools/asr" else None
            status = upstream.status_code if upstream.status_code in (400, 413, 415, 422, 429) else 502
            message = {400: "模型服务未接受此请求，请检查消息或附件。", 413: "附件超过模型服务的大小限制。",
                       415: "模型服务不支持此文件格式。", 422: "模型服务无法处理此请求。",
                       429: "模型服务繁忙或额度受限，请稍后重试。"}.get(status, "模型服务暂不可用，请稍后重试。")
            await upstream.aclose()
            await client.aclose()
            if call_id:
                await asyncio.to_thread(store.finish_chat_call, call_id, "failed")
            raise asr_failure or ChatError(status, message)
        if route == "/v1/tools/asr":
            outcome = "failed"
            task = asyncio.create_task(_asr_document(upstream))
            try:
                while True:
                    done, _pending = await asyncio.wait({task}, timeout=0.25)
                    if await asyncio.to_thread(store.accounts.authenticate, token) != owner_id:
                        raise ChatError(401, "登录已过期，请重新登录。", {"X-Session-Expired": "1"})
                    if await request.is_disconnected():
                        raise ChatError(499, "请求已停止。")
                    if done:
                        result = task.result()
                        outcome = "success"
                        return JSONResponse(result, headers=COMMON_HEADERS)
            except asyncio.CancelledError:
                outcome = "aborted"
                raise
            except ChatError as error:
                if error.status in (401, 499):
                    outcome = "aborted"
                raise
            except httpx.TimeoutException:
                raise ChatError(504, "语音识别超时，请稍后手动重试。", code="asr_timeout") from None
            except (ValueError, UnicodeError, httpx.HTTPError, OSError):
                raise ChatError(502, "语音识别服务未返回有效文字，请稍后重试。", code="asr_response_invalid") from None
            finally:
                with anyio.CancelScope(shield=True):
                    if not task.done():
                        task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    await upstream.aclose()
                    await client.aclose()
                    if call_id:
                        await asyncio.to_thread(store.finish_chat_call, call_id, outcome)
        if route == "/anthropic/v1/files":
            try:
                chunks, size = [], 0
                async for chunk in upstream.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_SMALL_RESPONSE:
                        raise ValueError
                    chunks.append(chunk)
                result = b"".join(chunks)
                document = json.loads(result)
                file_id = document.get("id") if isinstance(document, dict) else None
                if (not isinstance(file_id, str) or not FILE_ID.fullmatch(file_id)
                        or await asyncio.to_thread(store.accounts.authenticate, token) != owner_id
                        or not await asyncio.to_thread(_files, store, "remember", owner_id, file_id)):
                    raise ValueError
                await asyncio.to_thread(store.finish_chat_call, call_id, "success")
                return JSONResponse(document, status_code=upstream.status_code, headers=COMMON_HEADERS)
            except asyncio.CancelledError:
                with anyio.CancelScope(shield=True):
                    await asyncio.to_thread(store.finish_chat_call, call_id, "aborted")
                raise
            except (ValueError, UnicodeError, httpx.HTTPError, OSError):
                await asyncio.to_thread(store.finish_chat_call, call_id, "failed")
                raise ChatError(502, "模型服务未返回有效附件，请重新上传。") from None
            finally:
                with anyio.CancelScope(shield=True):
                    await upstream.aclose()
                    await client.aclose()

        async def stream():
            outcome, read_task = "failed", None
            try:
                iterator = upstream.aiter_raw().__aiter__()
                read_task = asyncio.create_task(anext(iterator))
                while True:
                    done, _pending = await asyncio.wait({read_task}, timeout=0.25)
                    if await asyncio.to_thread(store.accounts.authenticate, token) != owner_id:
                        outcome = "aborted"
                        break
                    if not done:
                        continue
                    try:
                        chunk = read_task.result()
                    except StopAsyncIteration:
                        outcome = "success"
                        break
                    if chunk:
                        yield chunk
                    read_task = asyncio.create_task(anext(iterator))
            except asyncio.CancelledError:
                outcome = "aborted"
                raise
            except (httpx.HTTPError, OSError):
                outcome = "failed"
            finally:
                with anyio.CancelScope(shield=True):
                    if read_task and not read_task.done():
                        read_task.cancel()
                        await asyncio.gather(read_task, return_exceptions=True)
                    await upstream.aclose()
                    await client.aclose()
                    if call_id:
                        await asyncio.to_thread(store.finish_chat_call, call_id, outcome)
                    if outcome == "success" and deletion:
                        await asyncio.to_thread(_files, store, "forget", owner_id, file_id)

        response_headers = {**COMMON_HEADERS, "X-Accel-Buffering": "no"}
        if "Content-Encoding" in upstream.headers:
            response_headers["Content-Encoding"] = upstream.headers["Content-Encoding"]
        return StreamingResponse(stream(), status_code=upstream.status_code,
                                 media_type=upstream.headers.get("Content-Type", "application/octet-stream"),
                                 headers=response_headers)

    @router.api_route("/{path:path}", methods=["GET", "POST", "DELETE", "HEAD", "PUT", "OPTIONS"])
    async def dispatch(path: str, request: Request):
        try:
            return await proxy(request, "/" + path)
        except (ChatError, ServiceError) as error:
            return _error(error.status, error.message, getattr(error, "headers", None), getattr(error, "code", None))

    return router
