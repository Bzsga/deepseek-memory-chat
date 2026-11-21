# DeepSeek 记忆聊天接口契约

Android 主工程位于 `android/`，React 聊天界面位于 `web/`，统一 FastAPI 服务位于 `backend/`。

公开页面路径为 `/deepseek/`，API 挂载在 `/deepseek-api`。以下 HTTP 路径相对于该 API 根路径。网页的 `API_ORIGIN` 为 `/deepseek-api/chat`。

## 账号与注册

| 方法与路径 | 输入或结果 |
| --- | --- |
| `GET /v1/accounts/registration` | 公开查询 `{self_service}` |
| `POST /v1/accounts/register` | `{username,password,invitation_code?}`，邀请码是否必填取决于注册策略 |
| `POST /v1/accounts/redeem-invite` | 登录后提交 `{invitation_code}`，返回 `{user,quota}` |
| `POST /v1/accounts/login` | 用户名和密码 |
| `GET /v1/accounts/me` | 当前用户及额度 |
| `POST /v1/accounts/logout` | 撤销当前登录会话 |
| `GET /v1/quota` | 账号额度、服务状态和整理能力 |

注册与登录返回 `{token, expires_at, user, quota}`。用户名为 3–32 个字母、数字、下划线或短横线，按 NFKC 规范化并忽略大小写比较。密码长度为 8–128，保留输入空白。登录会话有效期为 30 天。

自助注册获得基础云同步资格，用户自行启用同步。填写邀请码时，校验及消耗邀请码与创建账号在同一个事务内完成。已注册且符合条件的用户可兑换一次性邀请码。账号及额度中的 `permissions` 分别返回配套聊天、生图和云同步的生效授权，`managed_eligible` 是配套聊天权限的兼容字段。

Android 使用 `Authorization: Bearer <token>`。内嵌聊天使用同一账号 token 对应的 `deepseek_session` Cookie，属性为 Secure、HttpOnly、SameSite=Strict，Path 为 `/deepseek-api`。App 通过原生账号页面管理登录，浏览器使用 `/chat/login`、`/chat/register` 和 `/chat/logout`。

## 每周共用额度

周期为北京时间周一零点至下周一零点，`reset_at` 返回下一次刷新时间。用户字段为 `user_weekly_limit`、`user_weekly_used`、`user_weekly_reserved` 和 `user_weekly_remaining`。全站字段使用相应的 `weekly_*` 名称，普通用户界面展示个人次数。

聊天、文件上传、识音、朗读、生图和免费智能整理共用同一份额度。服务在实际派发前原子检查账号、额度和整理预留，每次派发计一次。已经派发的失败、停止和结果未知请求保留计数。长文分段和备用线路分别记录实际派发，任务恢复沿用原请求身份。

参数或文件归属检查在派发前完成。模型列表、文件删除、页面访问和本地资料操作可直接使用。后台提供调用类型、状态和时间统计。日常聊天记录与附件原件保存在客户端本机，智能操作会将本次所需内容发送到服务处理。

## 聊天与生图

| 方法与路径 | 用途 |
| --- | --- |
| `GET /chat/api/runtime` | 模型、功能开关、当前用户和 `weekly_quota` |
| `POST /chat/api/redeem-invite` | 同源 Cookie 兑换，输入与原生兑换接口相同 |
| `GET /chat/api/quota` | 当前个人周额度 |
| `GET /chat/models` | 模型列表 |
| `POST /chat/anthropic/v1/messages` | 流式聊天 |
| `POST /chat/anthropic/v1/files` | 文件上传 |
| `DELETE /chat/anthropic/v1/files/{file_id}` | 删除本账号文件 |
| `POST /chat/v1/tools/asr` | 语音识别 |
| `POST /chat/v1/tools/tts` | 文字朗读 |
| `POST /chat/api/images` | 按描述生成图片 |

`runtime` 返回 `{provider, model, features, image_model, user, weekly_quota}`。功能开关包括 `search`、`files`、`speech` 和 `image_generation`。服务端按配置选择模型与上游凭据，浏览器仅持有登录 Cookie。

聊天 API 请求携带 `X-Chat-User-Id`，与当前 Cookie 身份一致。身份变化返回 409 和 `X-Session-Changed: 1`，过期或已撤销会话返回 401 和 `X-Session-Expired: 1`。模型、附件和语音接口沿用当前客户端协议，文件标识绑定上传账号。

生图请求为 `{prompt}`，描述长度为 1–8000。服务向配置的上游请求一张图片，返回 `{images: [{b64_json, mime_type}], model}`。客户端校验 PNG、JPEG 或 WebP 文件头与 MIME，保存本机原件并在回复中展示。结果在本机保存成功前保留内存缓存，用户可重试保存或直接保存图片。生图请求由用户发起，停止、超时和后续手动重试各自记录状态。

## 整理任务

| 方法与路径 | 用途 |
| --- | --- |
| `POST /v1/jobs` | 提交带幂等键的整理请求 |
| `GET /v1/jobs/{job_id}` | 查询原任务状态与结果 |
| `POST /v1/jobs/{job_id}/cancel` | 请求停止任务 |

原生 `SummaryProtocol` 与服务端 `provider` 定义整理内容和来源校验。每个任务保存选中会话、分支、消息范围、服务设置、所属账号和请求身份。已完成分段可恢复使用，未知请求先按原身份查询。人工编辑、固定和删除由本机档案合并逻辑保护。

## 管理接口

开发者入口仅向管理员账号显示。管理接口支持已认证的管理员账号 Bearer，会话与运维鉴权由服务端检查。以下路径均以 `/v1/admin` 开头。

| 方法与路径 | 用途 |
| --- | --- |
| `POST /login` | 管理员账号和密码登录 |
| `POST /session` | 通过同源管理员账号 Cookie 建立管理会话 |
| `GET /config`、`PATCH /config` | 服务开关和默认周额度 |
| `GET /account-feature-access`、`PATCH /account-feature-access` | 读取或保存对所有登录账号开放的配套聊天、配套生图和云同步权限 |
| `GET /stats` | 全站与分类调用统计 |
| `GET /users` | 注册用户、个人周额度和调用情况 |
| `PATCH /users/{user_id}/quota` | 设置个人周额度或本周剩余 |
| `POST /users/{user_id}/revoke-managed` | 取消免费资格，保留账号 |
| `PATCH /users/{user_id}/status` | 启用或停用账号 |
| `POST /users/{user_id}/reset-password` | 生成并返回新密码 |
| `GET /registration-invites` | 分页列出有效且未使用的邀请码 |
| `POST /registration-invites` | 创建一次性邀请码 |

额度修改支持 `weekly_limit` 和 `this_week_remaining`。`weekly_limit: null` 恢复使用默认值。修改本周剩余可同时传当前周一日期 `week`，跨周时返回 409 并要求刷新。本周显式剩余额度优先于个人周额度和全局默认值。

停用账号和重置密码会撤销该账号的登录会话。邀请码创建输入为 `{count, valid_days}`，未使用邀请码列表提供完整 `code`，便于管理员分享。

## 本机聊天与记忆通道

WebMessagePort 限于可信主页面 `https://digimonlegend.com/deepseek/`。原生以固定目标 origin `https://digimonlegend.com` 发送 `{type: "deepseek.connect", version: 1}` 和一个端口。消息为有界 JSON，最大 2 MiB，统一携带 `version: 1`、请求 `id` 和 `type`。回应为 `{version, id, type: "ack", ok, error?}`。

网页发送 `organize` 时，payload 包含 `conversationId`、`title`、当前分支的 `messages`，以及可选 `sourceArchiveId`。每条消息包含稳定 `id`、`role`、原始 `content` 和可选 `createdAt`。角色为 `user` 或 `assistant`，正文来自用户文字和助手正文块。App 将其保存为本机来源并打开选择与准备页。`memory.open` 和 `account.open` 分别进入记忆和账号页面。

原生发送 `continuation.create` 时，payload 为 `{title, text, sourceArchiveId}`。网页追加一个本机空会话，将资料保存到专门的 `continuity` 背景字段。`nativeHandoffId` 记录投递身份，持久化成功后回复 ack，原生再清理暂存。重复投递复用同一份会话。

背景原文以完整内容保存，并在后续每次请求的 system 字段附带一次。模型请求由用户发送下一句话时开始。来源档案标识随再次整理传回原生，支持补入最近聊天。

用户操作说明见[续聊流程](conversation-continuity.md)，构建与更新入口见[构建说明](building.md)和[更新说明](app-updates.md)。
