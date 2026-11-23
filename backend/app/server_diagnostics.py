"""Observe supported API failures without collecting request or response contents."""

import asyncio
from uuid import uuid4

from starlette.datastructures import MutableHeaders


def diagnostic_area(path):
    if path in {"/health", "/chat/api/runtime"}:
        return "runtime"
    if path in {"/chat/login", "/chat/register", "/chat/logout", "/chat/api/redeem-invite"} or path.startswith("/v1/accounts/"):
        return "account"
    if path.startswith("/chat/api/conversation-sync"):
        return "sync"
    if path == "/chat/api/images" or path.startswith("/chat/api/image-jobs"):
        return "image"
    if path.startswith("/chat/anthropic/v1/files"):
        return "attachment"
    if path == "/chat/anthropic/v1/messages" or path.startswith("/chat/v1/tools/"):
        return "chat"
    if path == "/v1/jobs" or path.startswith("/v1/jobs/"):
        return "organization"
    if path == "/download":
        return "update"
    return None


class ServerDiagnostics:
    def __init__(self, diagnostics, release):
        self.diagnostics = diagnostics
        self.release = release
        self.pending = asyncio.Queue(maxsize=256)

    def record(self, area, status, request_id, *, crashed=False):
        if crashed:
            code = "unexpected_error"
        elif status in {408, 504}:
            code = "timeout"
        elif status >= 500:
            code = "http_error"
        else:
            return
        try:
            self.pending.put_nowait((area, code, "response", status, request_id))
        except asyncio.QueueFull:
            pass  # Failure bursts must not block the API.

    async def run(self):
        while True:
            event = await self.pending.get()
            try:
                await asyncio.to_thread(self.diagnostics.record_server, *event, release=self.release)
            except Exception:
                # A diagnostic storage failure must not stop subsequent monitoring.
                continue


class ServerDiagnosticsMiddleware:
    def __init__(self, app, diagnostics):
        self.app = app
        self.diagnostics = diagnostics

    async def __call__(self, scope, receive, send):
        area = diagnostic_area(scope.get("path", "")) if scope["type"] == "http" else None
        if area is None:
            return await self.app(scope, receive, send)

        request_id = str(uuid4())
        status = None

        async def send_observed(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message)["X-Request-ID"] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_observed)
        except Exception:
            self.diagnostics.record(area, status if status and status >= 500 else 500, request_id, crashed=True)
            raise
        else:
            if status is not None:
                self.diagnostics.record(area, status, request_id)
