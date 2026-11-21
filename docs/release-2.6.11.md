# DeepSeek 记忆聊天 2.6.11

Android 2.6.11，versionCode 49，于 2026-11-20 20:15（北京时间）发布。官网更新历史同步部署为 `20261120T121414Z-a76f2f`。[更新清单](https://digimonlegend.com/continuation-updates/latest.json) · [更新历史](https://digimonlegend.com/deepseek/changelog.html)

- 修复通过系统分享或文件选择导入 DeepSeek 官方 ZIP 的兼容性问题。识别独立的会话索引，支持带数据描述符的未压缩文件条目，并校验实际解压大小和 CRC。导入保留会话、分支及附件描述。
- Android 导入解析器的 23 项定向测试通过。实际官网 ZIP 的整包解析通过。Android 11 模拟器验证了系统分享确认后的本地入库，以及从正式签名的 2.6.10 覆盖升级。
- 官网下载入口已指向 49。通过正式入口跳转到 COS 的整包 SHA-256 与签名包一致，分段下载返回 HTTP 206。
