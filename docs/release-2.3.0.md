# 2.3.0 发行记录

本版接入普通聊天自动生图、自家会话分享与导入续聊、Android 系统长截屏适配，并修复合并后遗留的管理地址迁移、备份范围和额度文案。Android、网页和后端版本为 2.3.0，Android versionCode 33。

## 普通聊天生图

聊天模型通过带本轮随机标识的末尾应用动作调用已配置的生图服务，生成结果作为当前回复显示。能力询问由模型继续澄清绘图需求，具体生图请求由模型选择动作。图片任务复用稳定请求编号、本地保存、后台执行与切屏恢复。

具体执行生图通常包含一次聊天请求与一次生图请求，按实际派发共计 2 次。需要自动整理、上传附件时仍按实际请求计次。图片作为本轮最终结果显示，工具调用的原始数据保存在本机与结构化会话备份中，后续模型历史使用实际结果的文字说明。

现有联网、阅读、审核、标题和 reminder 扩展继续按原接口发送，生图动作通过本轮系统说明约定。前端只在完整流结束后校验单动作、随机标识及有界参数，随后交给已有后台任务。网关定向回归核对现有扩展参数完整转发，并在派发前拒绝旧候选的原生 `generate_image` 声明，提示重新打开页面，避免重复扣次。

最初尝试原生客户端工具与现有扩展组合，真实能力询问请求返回 HTTP 400，测试账本 chat 1 次 failed、图片 0 次，额度 35→34。未继续第二个绘图请求，记录保留为 `build/qa/auto-image-live/auto-image-live-2.3.0-v2.json`。上游正文被原网关丢弃，无法确定具体拒绝字段。官方资料没有充分保证这一混用组合，因此采用应用动作方案，并将线上恢复到已验证的 2.2.1 构建后继续修复。参考 [DeepSeek 联网工具](https://api-docs.deepseek.com/zh-cn/guides/web_tools/)和 [Anthropic 兼容说明](https://api-docs.deepseek.com/guides/anthropic_api/)。

前端类型、lint、协议与普通 store/SSE 入口定向回归通过，相关图片任务、上下文、记忆和会话导出回归通过。覆盖每请求独立标识、跨文本块隐藏、完整结束判定、漂亮打印 JSON、思考中的惰性控制片段、停止、恢复、编辑、重新生成、账户/分支/删除隔离和原始动作归档。思考片段被隐藏后保留原始证据，并禁用该回复的续写前缀以避免签名不匹配。

生产包本地 UI 场景通过能力询问、具体生图、2 chat＋1 image、页面销毁后的同编号 GET 恢复，并确认 DOM、保存正文和点击复制都隐藏控制段。HTTP 400 合成场景确认失败证据在清理前保存。报告为 `build/qa/auto-image-live/auto-image-local-mock-v3.json` 和 `auto-image-local-error-mock-v3.json`，两者均为零真实模型调用。

真实合成账号场景已通过。能力询问正常回答，下一轮明确绘图请求得到有效 1024×1024 白底蓝圆。原页在 7.04 秒销毁，新页仅用 GET 恢复同一任务。账本为 chat success 2、image success 1，额度 35→32，控制片段在 DOM、保存正文和复制结果中均已隐藏。临时账号、邀请、任务、图片和浏览器资料全部清理，公开注册计数保持 1。证据为 `build/qa/auto-image-live/auto-image-live-2.3.0-v3.json`。后续分享和截图改动沿用此有效证据。

## 管理地址与合并遗留

旧安装的开发者偏好独立保存在加密设置中，原先启动只迁移了普通服务设置，管理地址仍可能停留在已退休的 continuation-api。现已复用精确旧官方地址识别，在启动、手动保存管理地址和恢复当前服务设置时迁移，重置所属旧管理会话。当前服务默认值使用统一配置来源。

原生备份和清除入口改为明确描述“导入的对话原件与记忆档案”，并指引通过聊天设置的数据管理处理聊天及图片。账户余量文案使用共用次数。网页清理旧角色体系中不可达、路径错误的管理链接。

Android 编译与直接 JUnitCore 执行通过 69 项定向检查，其中 4 项覆盖管理地址迁移与幂等、正常登录请求路径、精确地址边界和冻结任务保存。使用合成数据与模拟网络。签名构建与 lint 已通过，lint 为 0 errors、9 warnings，APK 身份、版本与同签名核验通过。设备端冷启动迁移没有直接实测证据。

## 会话分享与续聊

会话菜单可选择当前分支的正文、图片与附件元数据创建公开副本，复制链接或打开系统分享面板。链接持有人可匿名查看，接收者可在新对话页读取并预览，经确认追加原文、来源与图片。聊天设置的数据管理集中列出所有自己的分享，本机会话删除后仍可撤销。公开副本持续有效，直到创建者撤销，隐私说明已同步其服务器留存范围。

后端 32 项定向 pytest 通过，覆盖真实路由组装、创建幂等、账户授权、图片归属、撤销清理、公开 HTML/HEAD、友好 404 与限额。独立后端复核记录为 `build/qa/conversation-share-backend/independent-review.md`。前端核心、既有官方分享导入和记忆回归、类型与 lint 均通过。Android 系统分享链接校验 4 项 JUnit 通过，证据为 `build/qa/native-share-link-junit.log`。

生产包合成 UI 的选择、创建、跨会话管理、访客暂存、登录预览和原文图片导入场景通过，公开 HTML 使用真实响应头另做 390/320 宽检查。报告位于 `build/qa/conversation-sharing-ui/`。一名独立审查者查看 12 张手机截图，发现并修正撤销提示与当前有效链接含混的问题，针对两张更新截图复核后解决。审查记录为 `build/qa/conversation-sharing-visual-review/review.md`。App 导入预览保持只读元数据，用户可通过原分享查看图片，确认后再下载原图。

线上双账号合成场景已通过。A 通过正常 UI 创建一次分享，包含所选两条原文和一张 PNG，公开 HTML、快照与图片匿名读取成功。B 从新对话页粘贴链接，预览时账户资料库写入与图片读取均为 0，确认后追加原文、来源与图片，既有会话保留。B 越权撤销返回 404，A 在全账户分享管理中撤销后，三类公开资源均返回 404，HTML 显示友好说明。两账号额度均为 35→35，chat_calls、jobs、image_jobs 和 chat_files 全为 0，合成账号、邀请、撤销记录与浏览器档案全部清理，公开注册数保持 1。证据为 `build/qa/conversation-share-live/live-report-v2.json`。首轮脚手正则转义错误发生在分享创建之前，查证分享请求与服务端分享行均为 0，修正脚手后恢复本次验证，原失败记录仍保留。

## 系统长截屏

聊天消息使用 DOM 内部滚动，外层 WebView 文档高度固定，系统默认 WebView 滚动识别因此缺少有效范围。Android 12 / API 31 起通过公开 `ScrollCaptureCallback` 接入现有消息滚动区，并以 VisualState、frame commit、PixelCopy 和 HardwareRenderer 生成系统截图块。固定标题与输入框排除在滚动区域外。

截图暂时暂停跟随，结束、取消、切换会话或内容变化后恢复阅读位置。流式生成、缩放和遮挡浮层期间暂停提供目标。范围为当前已加载的消息，较早历史可先在聊天中加载。保留现有分页与正常滚动方式。

Kotlin 编译、6 项截图几何 JUnit 和生产包浏览器 7 组合成 DOM 场景通过，涵盖手机/宽屏边界、跟随与阅读位置恢复、取消与过期回调、浮层、内容/视口变化、切换会话、分页和页面卸载。证据为 `build/qa/chat-scroll-capture-junit.log` 和 `build/qa/scroll-capture/scroll-capture-results.json`。这些检查使用 0 次模型调用。Android 12 及以上实体手机的系统截图界面与厂商实现尚缺直接实测证据，Android 8–11 保持已有截图能力。官方接口说明见 [ScrollCaptureCallback](https://developer.android.com/reference/android/view/ScrollCaptureCallback)。

## 发布

当前完整网页和后端部署为 `20261117T172526Z-edd14c`，服务 active，公网路由检查通过。自动生图真实验证所用前一部署为 `20261117T162254Z-f3f0a8`，回执保存在 `build/qa/deployment-auto-image-2.3.0.json`。此前原生工具组合候选的回退回执为 `build/qa/rollback-chat-after-tool-400.json`。

最终 APK 为 13,578,057 字节，versionCode 33，versionName 2.3.0，minSdk 26，SHA-256 为 `74b43bb81d9744b436ba41a6506bbd9207bc40537ab0290b39576432d09320a9`。全部原生源码冻结后重新执行 assembleRelease 与 lintRelease，结果为 0 errors、9 warnings，并重新复制与验证此终包。同签名与身份回执为 `build/verified-release-2.3.0.json`，构建日志为 `build/qa/final-native-2.3.0-build.log`。

APK 于 `2026-11-17T17:30:55Z` 发布到既有 code 33 更新目录，应用内更新与下载入口已指向本版。公网核验包括完整下载后的哈希与字节数、清单和缓存策略、网页入口及两项入口资源逐字节匹配、health 正常、匿名 runtime 返回 401、下载重定向指向 latest。回执为 `build/qa/public-apk-2.3.0.json` 和 `build/qa/public-routing-2.3.0.json`。原生系统分享和长截屏适配需安装本版 APK，网页功能在重新打开后加载。
