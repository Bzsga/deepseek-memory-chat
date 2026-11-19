# 构建与测试

Android、网页和后端独立构建。Android 通过 HTTPS 加载已部署的聊天网页，不把 `web/dist` 打包进 APK。当前 Android 源码为 2.6.2 / versionCode 40，网页与后端为 2.6.0。官网分发状态以[更新清单](https://digimonlegend.com/continuation-updates/latest.json)为准。

## 网页

使用 Node.js 22 或更新的兼容版本、pnpm 和项目锁文件，在 `web` 目录运行：

```text
pnpm install --frozen-lockfile
pnpm type
pnpm lint
pnpm build
```

产物为 `web/dist/`，部署在 `/deepseek/`。默认 API 为同源 `/deepseek-api/chat`。开发服务使用 `pnpm dev`，端口 8090；账户 Cookie 和 Android 桥接需符合正式来源约束，单独启动开发服务器不会提供登录后端或原生桥。

受影响逻辑的定向检查：

```text
node scripts/check-continuity.mjs
node scripts/check-memory-flow.mjs
node scripts/check-images.mjs
node scripts/check-session-export.mjs
node scripts/check-session-refresh.mjs
node scripts/check-context-memory.mjs
node scripts/check-shared-conversation.mjs
node scripts/check-voice-input.mjs
node scripts/check-chat-image-tools.mjs
node scripts/check-conversation-shares.mjs
node scripts/check-conversation-sync.mjs
node scripts/check-sync-codec.mjs
node scripts/check-chat-provider.mjs
```

这些检查覆盖背景材料、当前分支整理、ZIP 转换、图片响应、分享原文导入和录音转换，网络部分使用模拟响应。网页开发边界见 [web/README.md](../web/README.md)。

构建后运行 `node scripts/preview-guest.mjs` 可在 `http://127.0.0.1:18091/deepseek/` 检查访客首页。预览固定返回未登录状态，其他 API 拒绝访问，不提供登录或模型服务。它不放宽正式来源校验，也不替代手机 WebView 或原生桥测试。

## Android

需要 JDK 17、Gradle 8.9、Android SDK Platform 35、Build Tools 35.0.0 和 Platform Tools。最低 Android 8.0 / API26；仓库不带 Gradle wrapper。通过 `JAVA_HOME`、`ANDROID_HOME` 或私有 `android/local.properties` 指定工具路径。含中文的工程路径可通过短 ASCII 路径映射访问。

在根目录运行：

```text
gradle --no-daemon --no-watch-fs -p android :app:assembleDebug
gradle --no-daemon --no-watch-fs -p android :app:testDebugUnitTest :app:lintRelease
```

Debug APK：`android/app/build/outputs/apk/debug/app-debug.apk`。有独立测试设备时可运行 `:app:connectedDebugAndroidTest`；涉及清除、恢复和删除的设备检查应使用合成资料，避免覆盖日常数据。

当前 Windows 中文缓存路径中，Gradle 测试 worker 曾在进入用例前报 `GradleWorkerMain` 类无法加载。该环境可先编译定向测试，再用同一 JDK 的 `org.junit.runner.JUnitCore` 和编译类、JUnit 及相应依赖的 classpath 执行，复用已验证入口。2.2.1 的相册复制 4 项通过此方式执行，相册平台 2 项通过 Android 11 仪器执行。各版证据范围见相应发行记录。

Release 签名使用仓库外的私有属性文件：

```properties
storeFile=<keystore绝对路径>
storePassword=<密码>
keyAlias=<别名>
keyPassword=<密码>
```

```text
gradle --no-daemon --no-watch-fs -p android "-PpreviewSigningFile=<签名属性文件路径>" :app:assembleRelease :app:lintRelease
```

产物为 `android/app/build/outputs/apk/release/app-release.apk`。不要公开签名文件；自行签名的包不能覆盖原版同包名应用。正式分发前验证 APK 身份、签名和完整性，详见[更新与发行](app-updates.md)。

## 后端

需要 Python 3.10+。在 `backend` 目录：

```text
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m pytest -q
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1 --no-access-log --no-proxy-headers
```

Linux/macOS 把解释器路径换为 `.venv/bin/python`。运行依赖见 `requirements.txt`。环境模板不会自动加载，真实模型需由启动进程提供私有配置；未启用真实服务时不得把模拟结果当作连通证明。

测试使用合成数据与模拟网络，按改动选择相关用例。后端配置、单实例和反向代理要求见[后端说明](backend.md)。部署模板与打包入口见 [deploy/README.md](../deploy/README.md)；构建成功不代表已经上线或完成真实设备测试。
