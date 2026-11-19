"""Read one public DeepSeek snapshot without forwarding account credentials."""
from __future__ import annotations

import asyncio
import json
import os
import re

import anyio
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import Response

from .chat import COMMON_HEADERS, ChatError, _error, _origin_ok, _token


MAX_SHARE_BYTES = 8 * 1024 * 1024
SHARE_TIMEOUT = 30
SHARE_ID = re.compile(r"[A-Za-z0-9_-]{6,128}\Z")
SHARE_ENDPOINT = "https://chat.deepseek.com/api/v0/share/content"
SHARE_USER_AGENT = ("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _invalid_constant(_value):
    raise ValueError("nonfinite JSON number")


def _check_snapshot(raw):
    """Validate the envelope while returning the exact original UTF-8 bytes."""
    try:
        text = raw.decode("utf-8")
        depth, quoted, escaped = 0, False, False
        for char in text:
            if quoted:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    quoted = False
            elif char == '"':
                quoted = True
            elif char in "[{":
                depth += 1
                if depth > 64:
                    raise ValueError("JSON depth")
            elif char in "]}":
                depth -= 1
        root = json.loads(text, object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
        if not isinstance(root, dict):
            raise ValueError("envelope")
        data = root.get("data")
        for node, key in ((root, "code"), (data, "biz_code")):
            if isinstance(node, dict) and node.get(key) is not None:
                code = node[key]
                if type(code) not in (int, float) or code != 0:
                    raise ChatError(404, "分享已失效、已撤销或暂时无法读取，请检查分享链接。")
        source = data.get("biz_data") if isinstance(data, dict) else None
        if not isinstance(source, dict):
            source = data if isinstance(data, dict) else root
        if not isinstance(source, dict):
            raise ValueError("source")
        if any(source.get(key) is True for key in
               ("has_more", "hasMore", "truncated", "is_truncated", "need_load_more")):
            raise ChatError(422, "该分享返回了不完整的消息，请重新分享或使用 ZIP 导入。")
        messages = source.get("messages")
        if not isinstance(messages, list) or not 1 <= len(messages) <= 100000:
            raise ValueError("messages")
        if any(not isinstance(message, dict) for message in messages):
            raise ValueError("message")
    except (ValueError, UnicodeError, RecursionError, TypeError):
        raise ChatError(502, "分享数据格式无法识别，请重新分享或使用 ZIP 导入。") from None


def build_share_import_router(store, *, client_factory=None, public_origin=None):
    """Create an account-bound, fixed-destination public-share reader."""
    router = APIRouter(prefix="/chat")
    origin = (public_origin or os.environ.get("PUBLIC_ORIGIN", "https://digimonlegend.com")).rstrip("/")
    client_factory = client_factory or (lambda: httpx.AsyncClient(
        timeout=httpx.Timeout(connect=10, read=15, write=10, pool=10),
        follow_redirects=False, trust_env=False))

    async def fetch_snapshot(share_id):
        async with client_factory() as client:
            outgoing = client.build_request("GET", SHARE_ENDPOINT,
                params={"share_id": share_id}, headers={"Accept": "application/json",
                    "Accept-Encoding": "identity", "User-Agent": SHARE_USER_AGENT})
            response = await client.send(outgoing, stream=True, follow_redirects=False)
            try:
                if response.status_code in (404, 410):
                    raise ChatError(404, "分享已失效或已撤销，请重新生成分享链接。")
                if response.status_code == 403:
                    raise ChatError(403, "该分享暂时无法访问，请在 DeepSeek 中检查分享权限。")
                if response.status_code == 429:
                    raise ChatError(429, "分享读取过于频繁，请稍后重试。")
                if response.status_code != 200:
                    raise ChatError(502, "DeepSeek 分享服务暂时无法读取，请稍后重试。")
                if response.headers.get("content-encoding", "identity").lower() != "identity":
                    raise ChatError(502, "分享响应格式不受支持，请稍后重试。")
                length = response.headers.get("content-length")
                if length and (not length.isdigit() or int(length) > MAX_SHARE_BYTES):
                    raise ChatError(413, "该分享超过 8 MB，请改用 ZIP 导入。")
                body = bytearray()
                async for chunk in response.aiter_raw():
                    if len(body) + len(chunk) > MAX_SHARE_BYTES:
                        raise ChatError(413, "该分享超过 8 MB，请改用 ZIP 导入。")
                    body.extend(chunk)
                raw = bytes(body)
                _check_snapshot(raw)
                return raw
            finally:
                with anyio.CancelScope(shield=True):
                    await response.aclose()

    @router.get("/api/shared-conversation")
    async def shared_conversation(request: Request, share_id: str = ""):
        task = None
        try:
            if not _origin_ok(request, origin):
                raise ChatError(403, "请从当前应用读取分享。")
            token = _token(request)
            owner_id = await asyncio.to_thread(store.accounts.authenticate, token)
            if owner_id is None:
                raise ChatError(401, "登录已过期，请重新登录。", {"X-Session-Expired": "1"})
            if request.headers.get("X-Chat-User-Id") != str(owner_id):
                raise ChatError(409, "账号已切换，请刷新页面后继续。", {"X-Session-Changed": "1"})
            if not SHARE_ID.fullmatch(share_id):
                raise ChatError(400, "分享链接无效，请粘贴 DeepSeek 的完整分享链接。")
            task = asyncio.create_task(asyncio.wait_for(fetch_snapshot(share_id), SHARE_TIMEOUT))
            while True:
                done, _pending = await asyncio.wait({task}, timeout=0.25)
                if await asyncio.to_thread(store.accounts.authenticate, token) != owner_id:
                    raise ChatError(401, "登录已过期，请重新登录。", {"X-Session-Expired": "1"})
                if await request.is_disconnected():
                    raise ChatError(499, "分享读取已停止。")
                if done:
                    return Response(task.result(), media_type="application/json", headers=COMMON_HEADERS)
        except ChatError as error:
            return _error(error.status, error.message, error.headers)
        except (asyncio.TimeoutError, httpx.TimeoutException):
            return _error(504, "分享读取超时，请检查网络后重试。")
        except httpx.HTTPError:
            return _error(502, "暂时无法连接 DeepSeek 分享服务，请稍后重试。")
        finally:
            if task is not None and not task.done():
                with anyio.CancelScope(shield=True):
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

    return router
