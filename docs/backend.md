# 统一后端与管理

FastAPI 服务同时提供注册账户、共享周额度、智能整理、流式聊天、图片生成和网页管理后台。使用一个 SQLite Store 和一个运行实例。当前接口权威为 [merge-contract.md](merge-contract.md)，路由导览见 [contracts.md](contracts.md)。

## 启动与路径

在 `backend` 安装 `requirements.txt` 后运行：

```text
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1 --no-access-log --no-proxy-headers
```

部署模板将 `/deepseek-api/` 去前缀转发到 loopback 3144；应用 `/health` 对应公网 `/deepseek-api/health`。网页为 `/deepseek/`，后台为 `/deepseek/admin`（转到 `/deepseek-api/admin`），APK 入口为 `/deepseek/download`。这些是路由约定，实际发布状态应检查当前服务。

同一 SQLite 只运行一个服务实例和 Uvicorn worker。整理执行并发由 `WORKER_CONCURRENCY` 控制，默认 2、范围 1–5。数据库、服务凭据、备用线路和诊断库须保存在工程外的私有持久目录；部署示例见 [deploy/](../deploy/README.md)。

## 环境与服务配置

`.env.example` 不会自动读取，需显式注入启动进程。配置定义见 [config.py](../backend/app/config.py) 和 [chat.py](../backend/app/chat.py)。

| 配置 | 用途 |
| --- | --- |
| `DB_PATH` | SQLite 位置 |
| `API_ENABLED` / `MOCK_MODE` | 启用真实整理或明确标记的本地模拟 |
| `PUBLIC_ENABLED` | 是否开放注册账户的配套免费服务 |
| `WEEKLY_LIMIT` / `USER_WEEKLY_LIMIT` | 服务每周总上限 / 默认每人每周额度，源码默认 350 / 35 |
| `BASE_URL` / `MODEL` / `API_KEY` | 整理用 HTTPS Chat Completions 兼容上游 |
| `CHAT_PROVIDER_CONFIG` | 私有聊天配置文件：`base_url`、`model`、`api_key`；聊天限定官方 DeepSeek 接口 |
| `IMAGE_PROVIDER_CONFIG` | 私有生图配置：`base_url`、`default_model`、`api_key`，可选 `enabled`、`default_size`、`request_timeout` |
| `FALLBACK_PROVIDERS_FILE` | 整理备用线路私有配置；不用于聊天和生图 |
| `ADMIN_TOKEN` | 可选独立运维凭据，不放入普通客户端 |
| `PROVIDER_TIMEOUT_SECONDS` / `WORKER_CONCURRENCY` | 整理超时与并发 |

生图沿用 AstrBot 绘图配置字段，当前接入目标为 `gpt-image-2.6-sunburst`，默认单张 1024×1024。密钥只保留在服务器；启用状态通过 runtime 返回前端。每次显式生图请求只派发一次，不自动重试。

整理备用文件最多两条备用，提供 `providers`、`order`、`slow_seconds` 和 `cooldown_seconds`。线路应先用同样合成内容比较速度再排序；慢响应或故障可切换，每次实际派发分别计次。自配 API 由手机直连，不使用服务器备用密钥。

配置响应不返回上游密钥，后台运行时覆盖值优先于环境默认值。修改环境后需重启；后台可修改的运行项按接口立即生效。

## 注册和周额度

注册只需用户名和密码。注册无总人数上限。新用户默认使用个人 Key。登录后在 API 设置中兑换邀请码可开通免费周额度及云同步资格，升级前已有账号保留免费资格。

周边界为 **Asia/Shanghai 周一 00:00**，`reset_at` 是下一次刷新时间。聊天、整理、上传附件、ASR、TTS 和生图共用账本，每个实际可计次上游派发消耗一次。未发出的整理预约取消会释放；已发送、失败或结果不确定的请求不退款、不自动重放。类别统计只供后台查看，不是独立额度池。

`PATCH /v1/admin/users/{id}/quota` 接受 `weekly_limit`（`null` 恢复跟随默认）和 `this_week_remaining`。调整剩余次数时建议同时携带用户列表返回的 `week`，避免跨周误改。普通客户端只显示个人额度，服务总上限在后台管理。

## 管理后台

开发者入口仅向服务端已认证的 admin 角色展示，管理接口逐次校验权限。Android 复用当前管理员账号会话，网页后台通过已登录账号或管理员账号密码进入。服务器私有命令 `python -m app.admin bootstrap-admin` 从标准输入读取初始密码，创建保留账号 admin；凭据不进入 APK 或仓库。

后台可修改默认周额度、全站周上限，查看注册用户用量，调整个人上限或本周剩余、单独取消免费资格、启用或停用账户和重置密码。取消免费资格会暂停该账号的云同步。邀请码列表包含尚有效、未使用且未撤销的邀请码，每码只能兑换一次。后台还显示同步存储、分享存储和磁盘可用空间。

## 资料、恢复与代理

浏览器用 HttpOnly Cookie，Android 原生用 Bearer，同一账户 ID 对应同一份周额度。Cookie 限定 `/deepseek-api`，要求 HTTPS。Android 内聊天复用原生登录。

聊天、录音、附件和生图正文只经过转发，不写入调用账本；服务保存附件归属与无正文调用记录。整理任务为恢复进度暂存所选消息和结果，终态 24 小时后清理正文；失败诊断可关闭或到期清理。详情见[隐私说明](privacy.md)和[失败诊断](failure-replay.md)。

用户可显式开启默认关闭的多端会话同步。服务器在私有 SQLite 中保存账号隔离的会话快照、附件原件、版本与删除标记，关闭后保留，用户单独清除时删除。同步数据每账号默认最多 512 MiB，数据库备份需覆盖增加的容量。同步接口使用原有账户授权，计入模型账本的请求数为 0，详情见[同步约定](conversation-sync.md)。

反向代理须覆盖 `X-Real-IP`、保留鉴权和同源头、关闭模型流缓冲，且不记录请求正文、密钥或 Bearer。上传与普通整理路由有不同大小约束，采用本项目 [Nginx 模板](../deploy/nginx-location.conf)。公网入口使用 HTTPS，Uvicorn 仅监听私有地址。
