# DeepSeek 记忆聊天 2.6.24

Android 2.6.24（versionCode 62）于 2026-11-23 13:30（北京时间）发布。 [固定下载入口](https://digimonlegend.com/deepseek/download) · [更新清单](https://digimonlegend.com/continuation-updates/latest.json) · [更新历史](https://digimonlegend.com/deepseek/changelog.html)

## 本次更新

- 个人 DeepSeek 聊天可启用 MCP。设置中可测试工具，聊天中的确认卡会显示调用目标和参数，并提供允许或跳过操作。
- Android 个人 API 的普通回复可在后台继续生成。返回应用可接回同一次请求。
- 续聊会话可打开本机来源档案，也可用档案中最新的背景刷新当前会话。

## 验证记录

- 官方签名 APK 以 2.6.23 为基线，保留原生单会话 JSON 和 ZIP 导入能力。发行构建、lint 及 24 项针对性单测通过。
- Android 11、WebView 83 模拟器同签名覆盖升级后保留合成私有数据。最终 APK 和对应网页联测验证了 MCP 跳过与允许、后台回复完成后接回同一条请求，以及原生桥接刷新并打开指定的本机档案。网页界面的档案操作也通过浏览器合成测试，验证未调用真实模型服务。
- 网页发布为 `20261123T052921Z-d26137`，公网核对了入口、更新历史、新资源、服务健康状态、COS 整包 SHA-256 和固定链接的分段下载。
