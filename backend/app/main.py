import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .config import Settings
from .api_key_guide import build_api_key_guide_router
from .chat import build_chat_router
from .share_import import build_share_import_router
from .conversation_shares import ConversationShares, build_conversation_share_router
from .conversation_sync import ConversationSync, build_conversation_sync_router
from .admin_web import build_admin_web_router
from .admin_access import _client_ip, build_admin_router, initialize_admin
from .feedback import FeedbackStore, MAX_FEEDBACK_BODY_BYTES, build_feedback_router
from .diagnostics import DiagnosticsStore, MAX_DIAGNOSTIC_BODY_BYTES, build_diagnostics_router
from .runner import Runner, ServiceLease
from .image_jobs import ImageJobs
from .releases import build_release_router
from .schemas import (AccountInviteRequest, AccountLoginRequest, AccountRegisterRequest, JobRequest, RedeemRequest, MAX_SOURCE_CHARACTERS, MAX_SOURCE_MESSAGES,
                      MAX_FILTER_CHARACTERS, MAX_FILTER_MESSAGES)
from .store import ServiceError, Store, digest


class BoundedBodyMiddleware:
    def __init__(self, app, max_bytes):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT", "PATCH"}:
            return await self.app(scope, receive, send)
        # The image job route authenticates before applying its own bounded upload read.
        if scope["method"] == "POST" and scope.get("path") == "/chat/api/image-jobs":
            return await self.app(scope, receive, send)
        content = bytearray()
        max_bytes = (MAX_FEEDBACK_BODY_BYTES if scope["method"] == "POST" and scope.get("path") == "/v1/feedback"
                     else self.max_bytes)
        if scope.get("path", "").startswith("/chat/"):
            max_bytes = 70 * 1024 * 1024
        if scope["method"] == "POST" and scope.get("path") == "/v1/diagnostics":
            max_bytes = min(max_bytes, MAX_DIAGNOSTIC_BODY_BYTES)
        while True:
            try:
                event = await asyncio.wait_for(receive(), timeout=15)
            except asyncio.TimeoutError:
                return await JSONResponse({"detail": "上传请求超时"}, status_code=408)(scope, receive, send)
            if event["type"] == "http.disconnect":
                return
            chunk = event.get("body", b"")
            if len(content) + len(chunk) > max_bytes:
                return await JSONResponse({"detail": "请求内容超过大小上限，请分段整理"}, status_code=413)(scope, receive, send)
            content.extend(chunk)
            if not event.get("more_body", False):
                break
        delivered = False

        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(content), "more_body": False}
            return await receive()

        await self.app(scope, bounded_receive, send)


def create_app(settings=None):
    settings = settings or Settings.from_env()
    settings.validate()
    store = Store(settings)
    feedback = FeedbackStore(store)
    diagnostics = DiagnosticsStore(store)
    runner = Runner(settings, store)
    image_jobs = ImageJobs(store, Path(settings.db_path).resolve().parent / "image-results")
    conversation_shares = ConversationShares(store, Path(settings.db_path).resolve().parent / "conversation-shares")
    conversation_sync = ConversationSync(store)
    lease = ServiceLease(settings.db_path)

    @asynccontextmanager
    async def lifespan(app):
        lease.acquire()
        diagnostics_cleanup = None
        try:
            store.initialize()
            conversation_shares.initialize()
            conversation_sync.initialize()
            initialize_admin(store)
            feedback.initialize()
            diagnostics.initialize()
            store.recover_running()
            store.purge_expired()
            await image_jobs.start()
            runner.start()
            diagnostics_cleanup = asyncio.create_task(diagnostics.cleanup())
            yield
        finally:
            if diagnostics_cleanup is not None:
                diagnostics_cleanup.cancel()
                await asyncio.gather(diagnostics_cleanup, return_exceptions=True)
            await image_jobs.stop()
            await runner.stop()
            lease.release()

    app = FastAPI(title="DeepSeek 记忆聊天", version="2.6.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(BoundedBodyMiddleware, max_bytes=settings.max_body_bytes)
    app.state.store = store
    app.state.runner = runner
    app.state.feedback = feedback
    app.state.diagnostics = diagnostics
    app.state.image_jobs = image_jobs
    app.state.conversation_shares = conversation_shares
    app.state.conversation_sync = conversation_sync
    app.include_router(build_admin_router(store))
    app.include_router(build_share_import_router(store))
    app.include_router(build_conversation_share_router(store, conversation_shares))
    app.include_router(build_conversation_sync_router(store, conversation_sync))
    app.include_router(build_chat_router(store, image_jobs=image_jobs))
    app.include_router(build_api_key_guide_router())
    app.include_router(build_admin_web_router(store))
    app.include_router(build_release_router())

    @app.exception_handler(ServiceError)
    async def service_error(request, error):
        return JSONResponse({"detail": error.message}, status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        if request.url.path == "/v1/accounts/register":
            detail = ("邀请码格式不正确，请检查后重试。"
                      if any("invitation_code" in item["loc"] for item in error.errors())
                      else "账号信息格式不正确，请检查用户名和密码")
            return JSONResponse({"detail": detail}, status_code=422)
        if request.url.path.startswith("/v1/accounts/"):
            return JSONResponse({"detail": "账号信息格式不正确，请检查用户名、密码和邀请码"}, status_code=422)
        if request.url.path == "/v1/diagnostics":
            return JSONResponse({"detail": "诊断日志格式不正确；仅接受受支持的技术信息"}, status_code=422)
        if request.url.path.startswith(("/v1/feedback", "/v1/admin/feedback")):
            return JSONResponse({"detail": "反馈格式不正确；请填写正文及 QQ 或微信，最多附 3 张 JPEG/PNG 图片，每张不超过 1 MiB"}, status_code=422)
        if request.url.path.startswith("/v1/admin/"):
            return JSONResponse({"detail": "管理请求格式或范围不正确，请检查填写内容"}, status_code=422)
        detail = "提交的消息格式不正确，请检查消息编号、说话方和正文。"
        for issue in error.errors():
            location = issue.get("loc", ())
            if (len(location) >= 3 and location[0] == "body" and location[1] in {"messages", "context_messages"}
                    and isinstance(location[2], int)):
                number = location[2] + 1
                field = location[3] if len(location) > 3 else ""
                section = "前段参考的" if location[1] == "context_messages" else ""
                if field == "content":
                    detail = f"{section}第 {number} 条消息正文格式不正确，单条上限为 {MAX_SOURCE_CHARACTERS} 字符。"
                elif field == "role":
                    detail = f"{section}第 {number} 条消息的说话方格式不受支持，请核对原文中的角色。"
                elif field == "id":
                    detail = f"{section}第 {number} 条消息缺少有效来源编号，编号上限为 512 字符。"
                break
            if location == ("body", "messages"):
                detail = f"单次消息数量须为 1 到 {MAX_SOURCE_MESSAGES} 条，请缩小整理范围。"
            elif location == ("body", "idempotency_key"):
                detail = "整理任务编号格式不正确，请重新准备此任务。"
            elif location == ("body", "operation"):
                detail = "此任务类型不受支持，请更新应用后重新准备任务。"
            elif issue.get("type") == "value_error":
                source = issue.get("input")
                if isinstance(source, dict) and source.get("operation") == "political_filter":
                    detail = (f"筛查片段格式不正确，每次最多 {MAX_FILTER_MESSAGES} 段，"
                              f"正文合计不超过 {MAX_FILTER_CHARACTERS} 字符，且不附加前段参考。")
                else:
                    detail = f"消息正文或来源关系未通过校验，单次正文上限为 {MAX_SOURCE_CHARACTERS} 字符。"
        return JSONResponse({"detail": detail}, status_code=422)

    def bearer(authorization: str | None = Header(default=None)):
        parts = (authorization or "").split(" ", 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            raise ServiceError(401, "请先连接整理服务并提供会话凭据")
        return parts[1]

    def owner(token=Depends(bearer)):
        return store.authenticate(token)

    app.include_router(build_feedback_router(store, feedback, owner))
    app.include_router(build_diagnostics_router(store, diagnostics, owner))

    @app.get("/health")
    def health():
        worker_ok = not settings.worker_enabled or (
            len(runner.tasks) == settings.worker_concurrency and all(not task.done() for task in runner.tasks)
        )
        healthy = worker_ok and runner.cleanup_ok and runner.cleanup_task is not None and not runner.cleanup_task.done()
        return JSONResponse({"status": "ok" if healthy else "degraded",
                             "service": "deepseek", "mock_mode": settings.mock_mode},
                            status_code=200 if healthy else 503)

    @app.post("/v1/invitations/redeem")
    def redeem(body: RedeemRequest):
        raise ServiceError(410, "旧邀请码入口已关闭，请登录后在 API 设置中兑换免费资格")

    @app.post("/v1/sessions")
    def create_session():
        token, quota = store.create_session()
        return {"token": token, "quota": quota}

    @app.post("/v1/accounts/register")
    def register_account(body: AccountRegisterRequest, request: Request, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.accounts.register(body.username, body.password, body.invitation_code, _client_ip(request))

    @app.get("/v1/accounts/registration")
    def registration_policy(response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.accounts.registration_policy()

    @app.post("/v1/accounts/login")
    def login_account(body: AccountLoginRequest, request: Request, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return store.accounts.login(body.username, body.password, _client_ip(request))

    @app.get("/v1/accounts/me")
    def account_me(response: Response, owner_id=Depends(owner)):
        response.headers["Cache-Control"] = "no-store"
        return store.accounts.me(owner_id)

    @app.post("/v1/accounts/redeem-invite")
    def redeem_account_invite(body: AccountInviteRequest, response: Response, owner_id=Depends(owner)):
        response.headers["Cache-Control"] = "no-store"
        return store.accounts.redeem_invite(owner_id, body.invitation_code)

    @app.post("/v1/accounts/logout")
    def logout_account(response: Response, token=Depends(bearer)):
        response.headers["Cache-Control"] = "no-store"
        return store.accounts.logout(token)

    @app.get("/v1/quota")
    def quota(owner_id=Depends(owner)):
        return store.quota(owner_id)

    @app.post("/v1/jobs")
    async def submit(body: JobRequest, owner_id=Depends(owner), token=Depends(bearer)):
        result = await asyncio.to_thread(store.create_job, owner_id, body, account_session_hash=digest(token))
        runner.notify()
        return result

    @app.get("/v1/jobs/{job_id}")
    def get_job(job_id: str, owner_id=Depends(owner)):
        return store.get_job(owner_id, job_id)

    @app.post("/v1/jobs/{job_id}/cancel")
    def cancel(job_id: str, owner_id=Depends(owner)):
        return store.cancel(owner_id, job_id)

    return app


app = create_app()
