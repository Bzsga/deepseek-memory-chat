# 个人 DeepSeek API

聊天设置可选择配套服务或个人 DeepSeek API。新注册账号默认使用个人 Key。登录后在 API 设置中兑换一次性邀请码，可开始使用配套免费额度。升级前的账号保留免费资格，管理员可单独取消。个人模式默认使用 DeepSeek 官方 HTTPS 接口与 deepseek-flash 模型，聊天、自动上下文整理、文件、语音识别和朗读由个人 API 账户计费。账号、会话同步与分享继续使用应用账号。

个人 Key 按设备及工作区单独保存。访客无需注册即可填写自己的 Key，登录后使用该账号独立的资料和凭据。使用独立的本机加密存储，运行时向用户选定的 HTTPS 服务提供相应凭据。会话同步、会话导出和公开分享只处理其定义的会话数据。开启多端同步后可单独备份加密的个人 Key。换设备时输入恢复口令即可还原。忘记口令时可重新填写官方 Key。

图片生成可单独填写个人 Key、Base URL 和模型。配套生图需有免费资格且服务器启用生图。两种方式均不可用时，聊天不会启用绘图工具。普通聊天和语音等直连发生失败时向用户显示对应错误，由用户决定重试。

官方个人请求复用现有 Messages/SSE 和工具解析，使用 credentials omit、固定官方路径和受限鉴权头。个人 Key 错误与应用账号登录失效分别处理。切换服务或替换 Key 时隔离文件上游 ID 与上传缓存，按其所属服务重新上传可用原件。每次请求固定其使用的服务和 Key。

保存配置使用本机操作。真实模型请求由正常聊天等用户操作触发。个人 Key 的权限和余额由 DeepSeek 服务决定。

在聊天或生图设置的高级选项中填写兼容服务的 HTTPS Base URL，再点击「获取模型列表」并选择模型，或直接填写模型 ID。自定义聊天使用 chat/completions。服务需支持浏览器跨域访问。聊天 Key 的口令备份会同时保存目标地址与模型；生图 Key 保存在本机。

回复偏好可填写人格与表达习惯，从下一次普通聊天请求开始生效。开启深度思考时使用所选思考强度，关闭时使用所填温度。留空交由供应商决定，第三方模型支持的选项由供应商决定。

## 当前核验依据

官方资料支持 Messages、搜索与读链接、Files、ASR 和 TTS，同类 DeepSeek API Key 用于这些接口。deepseek-flash 支持图片输入。Android 2.6.2 开始，新建的记忆整理任务直接使用同账号的聊天 API。个人模式复用 Key、服务地址与模型，配套模式共用账号额度。已创建任务沿用原有配置。

- [官方聊天构建指南](https://api-docs.deepseek.com/guides/build_a_chatbot/)
- [Anthropic 兼容说明](https://api-docs.deepseek.com/guides/anthropic_api/)
- [Files API](https://api-docs.deepseek.com/guides/files_api/)
- [语音识别](https://api-docs.deepseek.com/guides/asr/)
- [语音合成](https://api-docs.deepseek.com/guides/tts/)

2026-11-18 对官方 api.deepseek.com 的 Messages、Files、ASR、TTS 路径进行了无凭据 OPTIONS 检查。四个路径均允许应用 HTTPS 来源、POST 和所需 Authorization/Content-Type/anthropic-beta 头。该检查使用 0 次模型请求。
