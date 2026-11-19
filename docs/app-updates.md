# 应用更新与发行

Android 2.6.2 的「版本与更新」页面显示已安装版本。发现更新后可查看发布日、安装包大小和更新内容，页面同步显示下载、校验和安装状态。官网发布版本见[更新清单](https://digimonlegend.com/continuation-updates/latest.json)。

## 分发入口

- 下载：`https://digimonlegend.com/deepseek/download`。
- 更新清单：`https://digimonlegend.com/continuation-updates/latest.json`。
- 网页：`https://digimonlegend.com/deepseek/`；后端：`https://digimonlegend.com/deepseek-api/`。

保留现有更新通道名称不代表继续维护两个产品。Android APK、网页和后端分别构建、部署；发布 APK 前应保证其指向的网页和接口已就绪。新工程不新增 GitHub 仓库或绑定新的 Releases 地址。

`/deepseek/download` 按已发布的 `latest.json` 动态跳转到清单对应的版本化 APK，不把当前源码版本当作已发布版本。清单身份、目标地址或文件无效时返回暂不可用，不回退到写死的旧包。2.0.1 源码已包含该路由，线上生效状态见发行记录。

## 客户端行为

启动或返回前台时静默检查，自动检查最多每五分钟一次。Android 2.5.1 起，选择「稍后」会记住该版本，重启后仍生效。新版本会再次提醒。「设置 → 关于该软件 → 版本与更新」可以手动检查，查看已推迟的版本和更新说明。

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
python tools/publish_release.py publish --apk <APK路径> --verified-metadata <验证JSON路径> --changelog-file <说明JSON路径> --dry-run
```

说明文件为 UTF-8 JSON 字符串数组。`--dry-run` 只做本地检查，不上传。真实发布需提供运营者自己的可信 SSH helper；源码不含私钥、服务器凭据或任意站点的发布权限。

自托管或分叉版本应修改默认服务、网页、更新清单、下载来源、包名与证书约束，不应向原版服务器发布。构建入口见[building.md](building.md)，统一服务打包见 [deploy/README.md](../deploy/README.md)。
