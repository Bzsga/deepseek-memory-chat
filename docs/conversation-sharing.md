# 应用会话分享

点击回复下方的分享箭头，默认选中本次提问和回复。可以在当前分支调整选择，确认后创建公开分享副本。分享包含所选消息正文、图片和附件元数据，创建时保存选定内容。链接持有人可查看，创建者可在应用中撤销。链接默认持续有效，撤销后停止后续读取。

接收者可预览分享，并将其追加为当前账户的新会话继续交流。分享创建、查看、导入和撤销的模型调用次数均为 0。聊天和图片原件由用户明确选择分享后上传到服务器。

## HTTP 接口

以下路径位于 `/deepseek-api` 下，路由须在通用 `/chat/{path:path}` 之前注册。创建、列表和撤销使用现有注册账户身份、Origin 与 `X-Chat-User-Id` 检查，公开读取按随机分享编号授权。

- `POST /chat/api/conversation-shares` 创建，首次 201，同请求编号与相同内容返回 200，不同内容返回 409。
- `GET /chat/api/conversation-shares?conversation_id=...` 返回当前账户的分享列表。
- `DELETE /chat/api/conversation-shares/{id}` 撤销，只允许创建者操作，重复撤销保持成功。
- `GET /chat/api/conversation-shares/{id}` 公开读取，已撤销或不存在返回 404。
- `GET /chat/api/conversation-shares/{id}/images/{image_id}` 公开读取该分享内图片，跟随分享撤销状态。
- `GET` / `HEAD /chat/public-shares/{id}` 返回适配手机的公开 HTML 预览。公网 `/deepseek/share/{id}` 代理到该地址。撤销或不存在时返回友好 HTML 404。

公开响应与图片使用 no-store。公开页面设置 no-referrer，消息按文本安全呈现。分享编号使用至少 192-bit 随机值，服务器私有目录保存图片，文件名由内部安全编号构成。

## 创建格式

```json
{
  "client_request_id": "stable-uuid",
  "conversation_id": "local-session-id",
  "title": "分享标题",
  "messages": [
    {
      "id": "original-message-id",
      "role": "user",
      "content": "原始正文",
      "created_at": 1794931200000,
      "image_ids": ["image-transfer-id"],
      "files": [{"name":"note.txt","size":123,"mime_type":"text/plain"}]
    }
  ],
  "images": [
    {"id":"image-transfer-id","name":"image.png","mime_type":"image/png","b64_json":"..."}
  ]
}
```

正文按原样保存。消息角色为 user 或 assistant，顺序为选定分支顺序。客户端仅从所选消息收集图片，图片列表按编号去重，全部图片均须被消息引用。图片支持 PNG、JPEG、GIF 和 WebP，服务端检查编码、实际类型与大小。正文数据总量最多 8 MiB，整个创建请求最多 64 MiB，每张图片最多 12 MiB。超出时明确提示调整分享范围。

消息正文提取不携带思考、应用动作、系统上下文、派生记忆或未选中的分支。用户附件只分享原图及必要名称/大小/类型元数据。客户端创建前显示所选数量、图片及可见性提示。

创建结果与列表元素使用以下元数据。`created_at` 为毫秒时间戳。

```json
{
  "id":"random-share-id",
  "url":"https://digimonlegend.com/deepseek/share/random-share-id",
  "title":"分享标题",
  "conversation_id":"local-session-id",
  "message_count":1,
  "image_count":1,
  "created_at":1794931200000,
  "revoked":false
}
```

列表响应为 `{"shares":[...]}`。撤销响应为 `{"revoked":true}`。原始内容与图片在撤销时清除，可保留最少的创建者和撤销状态用于幂等。

## 公开快照

```json
{
  "schema_version":1,
  "id":"random-share-id",
  "title":"分享标题",
  "created_at":1794931200000,
  "messages":[
    {"id":"original-message-id","role":"user","content":"原始正文","created_at":1794931200000,"image_ids":["image-transfer-id"],"files":[]}
  ],
  "images":[
    {"id":"image-transfer-id","name":"image.png","mime_type":"image/png","size":68,"url":"/deepseek-api/chat/api/conversation-shares/random-share-id/images/image-transfer-id"}
  ]
}
```

公开快照省略账户身份、客户端请求编号与本机会话编号。网页预览中的“继续这段对话”进入 `/deepseek/?share={id}`。客户端保存待处理分享编号，登录后打开导入预览，经用户点击继续才追加会话。

## 客户端与原生接线

前端共享 API 与导入核心位于 `web/src/services/conversationShares.ts`。对外提供类型化的创建、当前会话分享列表、撤销、公开读取与导入准备能力。现有 `readSharedConversation` 继续作为欢迎页统一入口，同时识别官方 DeepSeek 链接和本应用规范分享链接。

公开预览读取不打开账户资料库。确认导入时下载并验证所需图片，重建本机文件编号，使用现有账户和 epoch 检查，将新会话与图片原子追加。结构化备份保留公开来源链接、原始消息编号及快照。消息来源类型增加 app-share，原始快照只包含公开正文与图片元数据。

Android WebMessagePort 增加 `share.link`，payload 为 `{url,title}`。只接受当前正式来源的 `/deepseek/share/{id}` HTTPS 链接。用户点击分享后打开系统 ACTION_SEND 选择器，ACK 仅表示选择器已打开。浏览器可使用系统 Web Share 或复制链接。

## 验证范围

使用合成正文和图片检查真实路由组装、创建幂等、账户隔离、撤销、图片归属、匿名预览、输入上限和 0 次模型调用。前端检查范围选择、隐私边界、原文与图片导入、来源备份、账户切换、登录后继续及窄屏操作。公开 HTML 与会话分享弹层进行有范围视觉检查。
