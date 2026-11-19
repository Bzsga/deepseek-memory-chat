# 网页与后端 2.3.1

本批加入默认关闭的多端会话同步和个人 DeepSeek API 配置，调整图片预览与保存操作，并根据一加 13 实测反馈修正手机聊天滚动结构。Android 继续使用 2.3.0 / versionCode 33，通过在线网页加载本批功能。

## 多端会话同步

聊天设置的数据管理可开启同账号多端同步，会话、分支、引用、思考、来源、会话记忆和本机可用的附件原件保存为私有云端副本。默认关闭时只读取开关元数据。关闭后暂停传输并保留云端，单独清除云端会话会同时关闭同步，本机内容保留。同步操作使用 0 次模型额度。

后端使用现有私有 SQLite 事务保存快照、BLOB、引用、代际和版本。账号身份、generation、CAS、删除标记与幂等保护离线及并发修改。后端有效覆盖 23 个定向用例，独立复核发现并修复读取混版和容量判断顺序，全部已验证。前端 engine 与 codec、既有记忆与分享回归通过，真实 Edge IndexedDB 12 组检查通过，覆盖跨标签旧缓存、过期确认、原子远端写入、备份替换、代际隔离和数据库升级。证据位于 `build/qa/conversation-sync/`。

设置生产包在 320/390 宽检查默认关闭、上传确认、状态与错误重试、备份/删除传播提示、暂停及清云端确认，共 6 组通过，证据位于 `build/qa/conversation-sync-settings-ui/`。详细协议与留存见[同步说明](conversation-sync.md)。

线上同账号 A 的两个隔离 Edge 端完整通过 8 段场景。默认关闭时内容请求为 0，设置开启后另一端取得当前两条消息、旧分支、记忆、来源、1968 字节 PNG 和 42 字节文本原件。双端各自新增会话会合并，同会话离线重命名保留双方版本，正常删除传播。另一账号 B 读取 A 的快照与附件均为 404。关闭后本机编辑的内容请求为 0。UI 清除云端后同步关闭，本机三会话与两份原件保留，四张私有内容表及 blob 字节数均为 0。两账号额度均为 35→35，模型、任务与普通上传账本全为 0。两合成账号、邀请、同步设置与三个浏览器档案全部清理，公开注册数保持 1。证据为 `build/qa/conversation-sync-live/live-report.json`。报告中的粗阶段标签沿用初段值，默认关闭断言依据首个 PATCH 前的请求序列及独立关闭观察窗口。

## 手机滚动与系统长截屏

用户反馈一加 13 使用 2.3.0 仍无法系统长截屏。此前适配了 Android ScrollCaptureCallback，但页面本身使用固定外壳与内部滚动。AOSP 的默认 WebViewCaptureHelper 依据 WebView 文档高度和原生滚动位置工作，内部滚动无法提供对应范围。一加当前系统私有截图链路缺少公开实现证据。

本批将手机会话改为真实 document 滚动，固定顶栏与输入栏，并动态预留键盘遮挡空间。现有截图回调仍可使用该文档滚动区。12 组生产包浏览器检查通过，真实触摸事件推动 window.scrollY 与 scrollingElement 同步，消息内部滚动范围为 0，固定界面保持位置。另覆盖 320 宽、桌面断点、临时零视口、覆盖式键盘、分页、取消、浮层与卸载恢复，使用 0 次模型调用。证据位于 `build/qa/scroll-document/`。一加 13 系统截图界面仍缺本轮直接实测证据。

实现依据见 [AOSP WebViewCaptureHelper](https://android.googlesource.com/platform/frameworks/base/+/5a87b681d466f5dfeda53f3f9082f5de92bfc9b6/core/java/com/android/internal/view/WebViewCaptureHelper.java)与[一加官方用户手册](https://service.oneplus.com/content/dam/support/user-manuals/common/OxygenOS_14.0_User_Manual.pdf)。

## 图片操作

生成图片与上传图片共用同页全屏预览。点击放大，双指、滚轮或双击缩放并拖动，长按或右键显示保存菜单，原始 Blob 继续走既有相册保存桥。聊天消息中的常驻保存按钮已移入图片操作菜单。缺失原件和保存失败仍提供反馈与重试。

图片生产包 5 组合成浏览器检查通过，覆盖真实双指缩放、拖动、关闭恢复、缩略图长按松手后保留菜单、上传图保存，以及 App 菜单文案与原始 Blob SHA 一致。长按新弹层被旧触摸兼容 mousedown 关闭的问题已通过仅图片菜单启用的遮罩新指针检查修正，取消、Esc 和独立新触摸照常关闭。证据为 `build/qa/image-interactions-ui/report.json`。相册平台写入使用此前验证过的原生通道，本批验证菜单与原件交付。

## 个人 DeepSeek API

聊天设置提供配套服务和个人 DeepSeek API 两种方式。个人 Key 按当前设备和应用账号加密保存，通过官方直连接口调用聊天、联网、文件与语音，使用 DeepSeek 官方账户计费。图片生成使用独立配套次数，设置与生图入口显示来源。账号、分享与同步保留其账号接口，Key 配置使用独立本机存储。具体协议与官方资料见[个人 API 说明](personal-deepseek.md)。

真实 Edge 的 IndexedDB/WebCrypto 与模拟上游通过 4 个文档场景，覆盖不可导出的 AES-GCM 密钥、密文、重载解密、损坏配置、账号隔离、官方来源及请求参数冻结、Files/ASR/TTS、错误脱敏、个人 401、文件归属与当前 store 入口。个人附件错误等待用户决定重试，切换服务会暂停聊天与语音，草稿附件转为可重试状态。独立复核关闭三项集成问题，记录为 `build/qa/personal-deepseek/boundary-independent-review.md`，核心回归为 `build/qa/chat-provider/report.json`。

个人服务设置的 5 组生产 UI 逻辑检查和后续窄屏显示复核通过，证据位于 `build/qa/personal-provider-ui/`。最后补一行移动端主题按钮最小宽度恢复两列，320 宽截图确认文字与滚动条保持间距。上述个人模式检查使用合成 Key、0 次真实网络和模型请求，实际个人 Key 的生成链路缺少本批真实调用证据。官方接口另有无凭据 OPTIONS 核验，回执为 `build/qa/personal-deepseek/preflight.json`。

## 部署与验证

最终部署为 `20261117T185749Z-4f97e4`，服务 active，公网入口和两项入口资源与本地终包逐字节匹配，health 正常，匿名 runtime 与同步设置均返回 401，下载入口与既有 code 33 APK 清单匹配。回执为 `build/deployment.json` 和 `build/qa/public-routing-2.3.1.json`。线上同步使用此前同逻辑候选 `20261117T185215Z-f3e5ad`，仅最后一行主题布局 CSS 在验证后补入最终部署，其回执保存于 `build/qa/deployment-sync-live-2.3.1.json`。

本批全部网页类型检查、lint 与生产构建通过。Android 继续使用已完整核验的 2.3.0 / code 33 APK，网页关闭后重开或浏览器刷新加载 2.3.1。默认同步关闭和默认配套服务均沿正常入口验证，本批真实模型调用为 0。
