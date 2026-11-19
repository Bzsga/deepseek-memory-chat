# 2.2.1 发行记录

本版处理用户在 2.2.0 上反馈的分享接口 404、Android 麦克风不可用，以及保存图片需要选择文件位置的问题。Android、网页和后端版本为 2.2.1，versionCode 32。

## 分享读取

完整 FastAPI 应用先注册通用 `/chat/{path:path}` 路由，导致后注册的分享读取接口被截获并返回“接口不存在”。已将分享路由移到通用路由之前。

新增通过 `create_app` 组装的回归，修复前复现 404，修复后验证匿名 401、正常登录读取原始快照、未知接口 404，并确认读取不增加调用和额度消耗。原有分享检查与新增集成检查共 18 项通过。

该路由修正先部署到 `20261117T144553Z-ac3121`，当时使用 2.2.0 网页资源和 APK，服务 active。热修回执保存在 `build/qa/share-route-hotfix-deployment.json`，完整 2.2.1 的发布证据见下文。

已按用户截图核对实际分享链接，使用临时账号经正式公开路由读取，HTTP 200 返回 28,691 字节。生产 TypeScript 读流、解析和预览准备链路取得 10 条消息，用户和助手各 5 条，单根 9 条树边，角色、原文快照及预览一致。额度 35→35，聊天调用、整理和生图任务均为 0。临时账号与邀请码已删除，公开注册计数保持 1，真实原文仅在内存使用。证据为 `build/qa/share-live-fix/summary.json`。

## Android 语音

Android 清单缺少 `MODIFY_AUDIO_SETTINGS` 正常权限。Chromium 的 Android 音频管理存在同时检查此权限与 `RECORD_AUDIO` 的设备选择路径，失败可使输入流创建返回空值。已补齐权限。依据为 [Chromium Java 音频管理](https://chromium.googlesource.com/chromium/src/media/+/refs/heads/main/base/android/java/src/org/chromium/media/AudioManagerAndroid.java)和 [Chromium Android 输入流](https://chromium.googlesource.com/chromium/src/media/+/refs/heads/main/audio/android/audio_manager_android.cc)。

采集改用设备默认的 `audio: true`，继续在本机将采样数据转为单声道 16-kHz PCM16 WAV。WebView 授权请求取消时清理对应引用，系统权限请求仍在等待时复用其结果，避免重复启动授权弹窗。授予 WebView 权限前检查可信来源与当前主页面。NotReadableError 改为提示检查系统麦克风开关与应用权限。

录音定向检查 11 项通过，网页类型、lint 和构建通过，权限取消竞态经独立源码检查。2.2.0 的真实 ASR 识别与计次证据继续适用服务端链路，本次没有额外派发 ASR。用户手机未连接，具体设备 WebView 分支和修复后的硬件录音效果尚未直接验证。

## 保存图片到相册

图片通过现有可信 Blob 导出通道传给 Android 后，直接复制原始字节到 `Pictures/DeepSeek/`，成功后显示“已保存到相册”。Android 10 及以上使用 MediaStore pending entry，完整写入后发布，失败清理未完成条目。Android 8/9 按需申请限定到 API 28 的存储写入权限，写入完成后通过 MediaScanner 加入相册，重名时保留已有图片。

JVM 4 项检查通过，覆盖原始字节一致、写入/发布失败回滚、空图片拒绝和文件名/MIME。现有 Android 11 / API 30 模拟器上的 2 项仪器检查通过，确认 `Pictures/DeepSeek/`、`IS_PENDING=0`、原始字节读回一致，以及空图失败后无残留。两种合成图片前缀查询无记录，测试缓存已清理，启动的模拟器已关闭。证据为 `build/qa/gallery-save/instrumentation.txt` 和 `media-cleanup.txt`。

本地 Gradle JUnit worker 在进入用例前遇到已知中文路径类加载异常，复用编译产物直接运行 JUnitCore 完成 4 项。相册平台测试通过 direct adb instrumentation runner 完成，未下载缺失的 UTP host 插件，实际用例与断言完整执行。定向 JVM 入口为 `build/qa/gallery-save/run-copy-junit.ps1`，设备测试类为 `GalleryImageStoreTest`。

## 发布

网页与后端 2.2.1 已部署为 `20261117T145803Z-27e8b9`，服务 active，路由检查通过。最终网页入口及 2 项入口资源与本地生产构建一致，health 正常，匿名 runtime 返回 401，下载入口匹配最新更新清单。回执为 `build/deployment.json` 和 `build/qa/public-routing-2.2.1.json`。

Android assembleRelease 与 lintRelease 成功，lint 为 0 errors、9 warnings。其中新增两项分别为已有 API29 分支保护的 MediaStore 常量和仅整体赋值的可保存 ArrayList 状态，代码路径已核对。最终 APK 中已验证 `RECORD_AUDIO`、`MODIFY_AUDIO_SETTINGS` 和 maxSdkVersion 28 的 `WRITE_EXTERNAL_STORAGE`，相册实现类已入包。签名保持原证书。

APK 于 `2026-11-17T15:05:29Z` 发布，包名 `app.banzhan.deepseekcontinuation`，versionCode 32，versionName 2.2.1，minSdk 26。文件大小为 13,561,673 字节，SHA-256 为 `46e4e99ffaefa263d612170a1a3888669c0aca9d3e44acd6faa758e9813a8952`。本地身份、签名与权限回执分别为 `build/verified-release-2.2.1.json` 和 `build/qa/apk-permissions-2.2.1.txt`，发布回执为 `build/qa/publication-2.2.1.json`。

公网完整 APK 下载和清单核对通过，清单 no-store、APK immutable，证据为 `build/qa/public-release-2.2.1.json`。应用内更新和统一[下载入口](https://digimonlegend.com/deepseek/download)已指向本版。录音原生权限和图片直接存相册需要安装新版 APK 后生效。
