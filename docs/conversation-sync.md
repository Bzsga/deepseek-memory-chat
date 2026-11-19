# 多端会话同步

有免费资格的账号可开启多端同步。资格来自兑换一次性邀请码或老账号迁移。同一账号共享同步开关，默认关闭。开启后，聊天页面自动同步会话、分支、会话记忆、续聊来源，以及本机仍有原件的图片和附件。原生独立记忆档案继续使用其原有备份入口。

关闭同步或被管理员取消资格后暂停上传和读取，云端副本保留。重新获邀后需手动开启。设置提供单独的清除云端入口，取消资格后仍可清除，清除时同时关闭同步，本机资料保留。公开分享副本由分享管理独立撤销。

同步使用私有账号接口，始终验证当前注册会话、同源和 X-Chat-User-Id。服务端开关和 generation 是写入授权的一部分，关闭、重开与清除会使旧请求失效。同步操作消耗 0 次模型额度。

常用聊天偏好随账号同步，包括人格、思考强度和温度。个人聊天 Key 支持单独的加密备份与恢复。关闭同步会暂停访问，清除云端数据会同时删除偏好及密钥备份。

## 接口约定

API 基础路径为 `/deepseek-api/chat/api/conversation-sync`，router 位于聊天通用路径之前。

- `GET /` 返回 `{eligible,enabled,generation,sequence}`。`eligible` 反映当前账号的免费资格，初始开关、代际和序号分别为 false、0、0。
- `PATCH /` 接受 `{enabled,expected_generation}`。状态实际变化时 generation 加一，返回新状态。相同状态返回当前状态，代际冲突返回 409。
- `DELETE /` 接受 `{expected_generation}`，原子关闭同步、增加 generation 并清除私有会话、删除标记及附件，返回新状态。
- `GET/PUT /preferences` 读写账号偏好，`GET/PUT/DELETE /key-envelope` 管理客户端加密密钥备份。读取需 generation，写入还需 expected_revision。
- `GET /index?generation=N&after=N` 返回 `{generation,entries:[{id,revision,deleted,content_hash}],cursor,has_more}`。按 revision 顺序最多 200 条，包含删除标记。
- `GET /sessions/{id}?generation=N` 返回 `{generation,id,revision,deleted,content_hash,snapshot,files}`，删除标记的 snapshot 为 null、files 为空。
- `PUT /sessions/{id}` 接受 `{generation,expected_revision,mutation_id,snapshot,files}`。snapshot 为前端版本化的私有会话对象，files 为 `{id,sha256,size,mime_type}` 列表。expected_revision 为 0 表示首次创建。成功返回该会话的完整 DTO。
- `DELETE /sessions/{id}` 接受 `{generation,expected_revision,mutation_id}`，写入删除标记并返回 DTO。
- `PUT /blobs/{sha256}?generation=N` 上传二进制原件，服务端校验 SHA-256 与大小后返回 `{sha256,size}`。附件为当前账号私有，单文件最多 64 MiB。
- `GET /blobs/{sha256}?generation=N` 返回当前账号附件，使用 application/octet-stream、no-store 和 nosniff。

上述无尾部路径使用精确的基础路径，不依赖重定向。没有资格时，启用或访问同步内容返回 403 `sync_invitation_required`，登录账号可查询同步状态、暂停同步与清除云端内容。有资格但同步关闭时，访问同步内容返回 409 `sync_disabled`。代际过期或版本冲突返回 409 `sync_generation_changed` 或 `sync_conflict`。认证错误沿用 401，当前账号声明不匹配沿用 409。所有响应设置 no-store。

每次会话变更获得账号内单调增加的 revision。mutation_id 在账号与代际内幂等，未知结果可查询或按相同编号与相同内容重试。若该变更已应用且会话仍为同版，返回同版结果；若后来已有新版本，重试返回 sync_conflict，保留当前版本。已同步删除保留有版本的标记。并发覆盖使用 expected_revision 比较，客户端保留冲突版本为另一会话。服务端在读取正文之后、提交之前再次验证当前会话有效性与同步状态。

snapshot JSON 上限 32 MiB。私有会话与附件合计每账号默认上限 512 MiB，达到上限时明确提示清理或导出。附件先上传，全部引用校验成功后才提交会话。删除会话及清除云端后回收失去引用的原件，未关联的中断上传在后续操作或清理中回收。

服务器在现有私有 SQLite 数据库保存同步快照、附件 BLOB、引用、版本与开关，写入与回收在同一事务完成。服务备份须覆盖该数据库及其增长。

## 客户端边界

已登录的网页和 Android 客户端向同一服务查询同步状态。访客维持本机隔离。没有资格或开关关闭时只查询同步状态。首次开启或新设备先合并远端和本机，随后同步本机变更。重新联网、回到前台和定时轮询触发检查。

同步使用独立持久元数据和本机变更标记。远端落盘与 revision 更新在同一 IndexedDB 事务完成。网络期间本机新增修改、删除、备份恢复、退出和账号变化都必须使旧应用操作失效。生成中或尚未落盘的会话延后处理。同步恢复只读取已存在的模型结果，后台任务编号与待执行动作留在原设备。

会话编码保留原文、稳定消息及分支编号、引用、来源和会话记忆，排除账号凭据、API Key、输入草稿、服务端附件身份和未完成任务。已有备份校验、原子事务和来源重映射逻辑按适用范围复用。冲突恢复在正常会话列表可见，供用户继续或自行删除。
