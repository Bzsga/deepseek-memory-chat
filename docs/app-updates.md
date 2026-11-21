# 应用更新与发行

Android 的「版本与更新」显示已安装版本。发现更新后可查看发布日、安装包大小和更新内容，页面同步显示下载、校验和安装状态。官网发布版本见[更新清单](https://digimonlegend.com/continuation-updates/latest.json)，历次变化见[更新历史](https://digimonlegend.com/deepseek/changelog.html)。

## 分发入口

- 最新版固定下载地址为 [下载 DeepSeek 记忆聊天](https://digimonlegend.com/deepseek/download)。分享这个链接即可，每次正式发布后自动指向新版本。
- 更新清单：`https://digimonlegend.com/continuation-updates/latest.json`。
- 网页：`https://digimonlegend.com/deepseek/`；后端：`https://digimonlegend.com/deepseek-api/`。
- 用户可见的更新摘要统一写入仓库根目录的 [CHANGELOG.md](../CHANGELOG.md)，新条目放在顶部。网页构建会从这份文件生成「更新历史」。发布 APK 时将该版本的简短条目同步到更新清单。详细技术记录沿用 `docs/release-*.md`。

保留现有更新通道名称不代表继续维护两个产品。Android APK、网页和后端分别构建、部署；发布 APK 前应保证其指向的网页和接口已就绪。新工程不新增 GitHub 仓库或绑定新的 Releases 地址。

聊天页面、设置、提示词和服务器行为可在线发布，重新打开聊天页即可加载新版。Android 原生界面、系统下载与文件选择、WebView 桥接和本机数据库等改动随签名 APK 覆盖升级。

`/deepseek/download` 按已发布的 `latest.json` 跳转到清单对应的版本化 APK。已接入 COS 的版本通过主站的版本化地址返回 302，由 COS 提供文件。App 继续使用同源清单和原有下载地址，更新包仍按清单中的大小和 SHA-256 验证。清单或主站安装包无效时，官网入口显示暂不可用。

## 客户端行为

启动或返回前台时静默检查，自动检查最多每五分钟一次。Android 2.5.1 起，选择「稍后」会记住该版本，重启后仍生效。新版本会再次提醒。Android 2.6.9 起，可直接在更新提示点「查看更新内容」，下载中也可以打开说明。「设置 → 关于该软件 → 版本与更新」可以手动检查，查看已推迟的版本和更新说明。

Android 系统下载管理器支持后台下载、查询同一任务、取消和失败后手动重试。完成后检查大小、SHA-256、包名、版本、最低 Android 要求及同签名，安装前再次验证。系统安装需由用户确认，必要时允许安装未知应用。

更新下载不携带聊天或模型服务凭据，不消耗模型次数，不触发模型重试。进行整理、保存或外部导入时暂缓安装。

## 清单与签名

清单为最多 32 KiB 的 UTF-8 JSON，`schemaVersion=1`，包含：

| 字段 | 含义 |
| --- | --- |
| `packageName` | APK 的真实包名 |
| `versionCode` / `versionName` | APK 的真实版本 |
| `apkUrl` | 允许的同源、版本化 HTTPS 下载地址 |
| `apkSize` / `sha256` | 实际大小（最多 64 MiB）和小写 SHA-256 |
| `minSdk` | 当前为 26 |
| `releasedAt` | UTC ISO8601 时间 |
| `changelog` | 最多 8 条，每条最多 200 字符 |

先上传完整 APK、验证内容，再原子替换 `latest.json`。版本化 APK 不可覆盖，使用长期 immutable 缓存；清单使用 `Cache-Control: no-store`。自行签名的包不能覆盖原版同包名应用，签名私钥和密码不得进入源码。

## 发布工具

[verify_release.py](../tools/verify_release.py) 使用 Android SDK 的 `apksigner` 和 `aapt2` 生成绑定 APK 的验证元数据；[publish_release.py](../tools/publish_release.py) 核对哈希、ZIP、版本和签名，再按发布锁、不可变版本目录和原子清单流程上传。

```text
python tools/publish_release.py publish --cos --apk <APK路径> --verified-metadata <验证JSON路径> --changelog-file <说明JSON路径> --ssh-helper <部署连接脚本>
```

说明文件为 UTF-8 JSON 字符串数组。正式发布使用运营者自己的可信 SSH helper。加 `--dry-run` 可在本地检查发布目标和清单。签名私钥和发布凭据由私有发布环境提供。

### COS 镜像

首次配置时为发布进程提供 `DEEPSEEK_COS_BUCKET`（存储桶全名）、`DEEPSEEK_COS_REGION` 和 `DEEPSEEK_COS_ORIGIN`（自定义 HTTPS 下载域名）。上传使用腾讯云 Python SDK `cos-python-sdk-v5`。凭据通过发布进程的私有环境变量 `DEEPSEEK_COS_SECRET_ID`、`DEEPSEEK_COS_SECRET_KEY` 提供。使用 STS 临时凭据时同时提供 `DEEPSEEK_COS_SESSION_TOKEN`。授权范围可限制到目标桶的 `apks/` 对象前缀，上传需要 `cos:PutObject`。

```text
python -m pip install cos-python-sdk-v5
python tools/publish_release.py stage-cos --apk <APK路径> --verified-metadata <验证JSON路径>
python tools/publish_release.py route-cos --apk <APK路径> --verified-metadata <验证JSON路径> --ssh-helper <部署连接脚本>
```

官方正式 APK 默认执行 `publish --cos`。脚本会上传并验证镜像、发布清单，再为该版本接入 COS。`stage-cos` 可为已发布版本补上传。`route-cos` 使用已有 COS 对象接入当前发布版本，仅需部署连接凭据。两条子命令都支持 `--dry-run`。

对象路径包含版本号和 SHA-256。接入前验证公开 HTTPS 下载、分段请求和整包哈希。接入后通过清单里的 `apkUrl` 复核主站 302、COS 的整包下载和分段响应，并用 [verify_public_release.py](../tools/verify_public_release.py) 生成公网验证回执。`cos_redirect_verified=true` 表示已通过正式入口从 COS 取到与签名元数据一致的包。

主站保留同一签名包供回退。需要恢复主站直下时，将 `/etc/nginx/deepseek-continuation-mirrors/apk-<versionCode>.conf` 移出匹配范围，验证 Nginx 配置后重新加载。若发布命令返回 `release_published`，主站更新已经可用，COS 分流仍待接入。可用 `route-cos` 重试，复验完成后再记为 COS 发布完成。

公开下载桶仅用于已签名 APK。账号数据、云同步和临时生成结果沿用服务内的访问权限及清理规则。需要异地备份时，使用独立私有桶、加密副本和单独的恢复凭据。

自托管或分叉版本应修改默认服务、网页、更新清单、下载来源、包名与证书约束，不应向原版服务器发布。构建入口见[building.md](building.md)，统一服务打包见 [deploy/README.md](../deploy/README.md)。
