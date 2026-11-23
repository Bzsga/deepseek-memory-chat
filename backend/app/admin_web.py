"""Retirement notice for bookmarks to the former browser administration page."""
from fastapi import APIRouter
from fastapi.responses import PlainTextResponse


def build_admin_web_router():
    router = APIRouter()

    @router.api_route("/admin", methods=["GET", "HEAD", "POST"], include_in_schema=False)
    @router.api_route("/admin/", methods=["GET", "HEAD", "POST"], include_in_schema=False)
    def retired_admin_page():
        return PlainTextResponse(
            "网页版管理后台已关闭。请在 App 登录管理员账号，然后打开「设置 → 关于 → 开发者工具」。",
            status_code=410,
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    return router
