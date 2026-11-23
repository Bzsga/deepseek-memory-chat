"""Public password-reset form opened with an administrator-issued recovery link."""

import base64
import hashlib

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .accounts import PASSWORD_RESET_PATH, PASSWORD_RESET_TOKEN_PATTERN
from .admin_access import _client_ip
from .store import ServiceError


MAX_PASSWORD_RESET_BODY_BYTES = 4096
_HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
}


class PasswordResetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    token: str = Field(pattern=PASSWORD_RESET_TOKEN_PATTERN, min_length=43, max_length=43)
    password: str = Field(min_length=8, max_length=128)


_STYLE = """
:root{font:16px/1.55 system-ui,sans-serif;color-scheme:light dark}
body{margin:0;background:Canvas;color:CanvasText}
main{box-sizing:border-box;width:min(100%,28rem);margin:8vh auto;padding:1.5rem}
h1{margin:0;font-size:1.55rem}a{color:LinkText}
form{margin:1rem 0}label{display:block;font-weight:600;margin:.8rem 0 .3rem}
input,button{box-sizing:border-box;font:inherit;min-height:44px;padding:.55rem .7rem;border-radius:.5rem}
input{width:100%;border:1px solid GrayText}button{margin-top:1rem;width:100%;border:0;background:#2457c5;color:#fff}
button:disabled{opacity:.6}
"""

_SCRIPT = """
(() => {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('token');
  if (location.hash || location.search) {
    history.replaceState(null, '', location.pathname);
  }
  const form = document.getElementById('reset-form');
  const status = document.getElementById('reset-status');
  const password = document.getElementById('password');
  const confirm = document.getElementById('confirm');
  const submit = document.getElementById('submit');
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    status.textContent = '请打开管理员发给你的完整重置链接。';
    return;
  }
  status.textContent = '';
  form.hidden = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    if (password.value !== confirm.value) {
      status.textContent = '两次输入的密码不一致。';
      confirm.focus();
      return;
    }
    submit.disabled = true;
    status.textContent = '正在设置新密码…';
    try {
      const response = await fetch(location.pathname, {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token, password: password.value}),
      });
      if (response.ok) {
        form.reset();
        form.hidden = true;
        status.textContent = '新密码已设置，请重新登录。';
      } else if (response.status === 400) {
        form.reset();
        form.hidden = true;
        status.textContent = '链接无效、已使用或已过期。如果刚设置了新密码，请尝试登录。';
      } else {
        status.textContent = response.status === 429 ? '尝试次数过多，请稍后再试。'
          : response.status === 422 ? '请使用 8–128 个有效字符设置密码。'
          : '暂时无法设置密码，请稍后再试。';
      }
    } catch (_) {
      status.textContent = '连接中断，请重试。如果刚设置了新密码，也可以先尝试登录。';
    } finally {
      submit.disabled = false;
    }
  });
})();
"""


def _csp_hash(source):
    value = base64.b64encode(hashlib.sha256(source.encode("utf-8")).digest()).decode("ascii")
    return f"'sha256-{value}'"


_PAGE_HEADERS = _HEADERS | {
    "Content-Security-Policy": (
        f"default-src 'none'; script-src {_csp_hash(_SCRIPT)}; style-src {_csp_hash(_STYLE)}; "
        "connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'"
    ),
}

_PAGE = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>设置新密码 · DeepSeek 记忆聊天</title>
<style>{_STYLE}</style>
</head>
<body>
<main>
<h1>设置新密码</h1>
<p>新密码设置成功后，此账号以前的登录会失效。</p>
<form id="reset-form" hidden>
<label for="password">新密码</label>
<input id="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128">
<label for="confirm">确认新密码</label>
<input id="confirm" type="password" autocomplete="new-password" required minlength="8" maxlength="128">
<button id="submit" type="submit">保存新密码</button>
</form>
<p id="reset-status" role="status"></p>
<noscript>请在支持 JavaScript 的浏览器中打开重置链接。</noscript>
<a href="/deepseek-api/chat/login">前往登录</a>
</main>
<script>{_SCRIPT}</script>
</body>
</html>
"""


def build_password_recovery_router(store, *, public_origin):
    router = APIRouter(tags=["accounts"])
    origin = public_origin.rstrip("/")

    @router.get(PASSWORD_RESET_PATH, response_class=HTMLResponse)
    def reset_page():
        return HTMLResponse(_PAGE, headers=_PAGE_HEADERS)

    @router.post(PASSWORD_RESET_PATH)
    def reset_password(body: PasswordResetRequest, request: Request):
        if request.headers.get("origin") != origin:
            return JSONResponse({"detail": "请从本站重置页面设置密码。"}, status_code=403, headers=_HEADERS)
        try:
            store.accounts.redeem_password_reset_link(body.token, body.password, _client_ip(request))
        except ServiceError as error:
            return JSONResponse({"detail": error.message}, status_code=error.status, headers=_HEADERS)
        return JSONResponse({"ok": True}, headers=_HEADERS)

    return router
