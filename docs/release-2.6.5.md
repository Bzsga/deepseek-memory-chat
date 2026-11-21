# DeepSeek 记忆聊天 2.6.5

Android 2.6.5，versionCode 43。

- 修复部分 Android 相册或文件选择器返回单张或多张图片时，聊天没有添加附件的问题。
- 兼容相册返回通用文件类型的常见图片，按 JPEG、PNG、WebP 或 GIF 扩展名识别并预览。
- 高级 API 设置的输入框把焦点环画在内侧，窄屏也能完整显示。

Android 11 模拟器通过五项选图回传测试，并从 2.6.4 覆盖升级后成功启动。模拟器的 WebView 83 低于聊天页要求的 105，手机相册到聊天缩略图的完整流程仍待真机验证。

官网发布状态见[更新清单](https://digimonlegend.com/continuation-updates/latest.json)。
