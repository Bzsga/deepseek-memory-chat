# 多端会话同步

普通自助注册账号拥有基础云同步资格。管理员也可为账号单独设置权限、通过邀请码授予权限，或向所有登录账号开放云同步。同一账号共享同步开关和范围，初始关闭，由用户确认后开启。启用时可分别选择「聊天记录」「聊天偏好」和「图片与附件原件」。聊天记录包含正文、分支、会话记忆、续聊来源和附件信息。新版客户端首次开启时不勾选原件，且只有选中聊天记录时才可同步原件。已有设置沿用其选择，早期同时同步会话和附件的账号保留原件范围。原生独立记忆档案使用自己的备份入口。

取消某项会暂停该类资料的同步并保留云端副本。暂停原件时，聊天更新可以继续同步，仍被会话引用的云端原件继续保留。重新勾选原件后，各设备会补传或补取此前暂缓的原件。用户关闭同步或账号失去生效的「云同步」权限时，全部同步暂停。取消全员开放时，仍具备有效授权的账号可继续同步。重新获得权限后需手动开启。在同步设置中可清除所有云端副本。撤回权限后仍可清除，清除时同时关闭同步，本机资料保留。公开分享副本由分享管理独立撤销。

同步使用私有账号接口，始终验证当前注册会话、同源和 X-Chat-User-Id。服务端开关和 generation 是写入授权的一部分，关闭、重开与清除会使旧请求失效。同步操作消耗 0 次模型额度。

聊天偏好包括基础风格、回答详略、回应方式、表达与排版细项、自定义文字、思考强度和温度。保存新版偏好后，仍打开旧网页的设备需重新打开聊天页才能同步相应设置。个人聊天 Key 可以在「同步设置 → 个人 API Key 备份」手动加密备份或恢复。会话和聊天偏好的选项只控制相应资料。清除云端数据会同时删除偏好及密钥备份。

## 接口约定

API 基础路径为 `/deepseek-api/chat/api/conversation-sync`，router 位于聊天通用路径之前。

- `GET /` 返回 `{eligible,enabled,generation,sequence,scopes}`。`scopes` 由布尔值 `conversations`、`preferences`、`attachments` 组成。早期设置缺少 `attachments` 时沿用原件随会话同步的行为。
- `PATCH /` 接受 `{enabled,expected_generation,scopes?}`。缺少 `scopes` 或早期客户端省略 `attachments` 时保留对应设置。启用时至少选中聊天记录或聊天偏好，原件依赖聊天范围。开关或范围实际变化时 generation 加一，代际冲突返回 409。
- `DELETE /` 接受 `{expected_generation}`，原子关闭同步、增加 generation 并清除私有会话、删除标记及附件，返回新状态。
- `GET/PUT /preferences` 读写账号偏好，`GET/PUT/DELETE /key-envelope` 管理客户端加密密钥备份。读取需 generation，写入还需 expected_revision。
- `GET /index?generation=N&after=N` 返回 `{generation,entries:[{id,revision,deleted,content_hash}],cursor,has_more}`。按 revision 顺序最多 200 条，包含删除标记。
- `GET /sessions/{id}?generation=N` 返回 `{generation,id,revision,deleted,content_hash,snapshot,files}`。关闭原件范围时 files 为空，snapshot 仍包含附件信息。删除标记的 snapshot 为 null、files 为空。
- `PUT /sessions/{id}` 接受 `{generation,expected_revision,mutation_id,snapshot,files}`。snapshot 为前端版本化的私有会话对象，files 为 `{id,sha256,size,mime_type}` 列表。expected_revision 为 0 表示首次创建。成功返回该会话的完整 DTO。
- `DELETE /sessions/{id}` 接受 `{generation,expected_revision,mutation_id}`，写入删除标记并返回 DTO。
- `PUT /blobs/{sha256}?generation=N` 上传二进制原件，服务端校验 SHA-256 与大小后返回 `{sha256,size}`。附件为当前账号私有，单文件最多 64 MiB。
- `GET /blobs/{sha256}?generation=N` 返回当前账号附件，使用 application/octet-stream、no-store 和 nosniff。

上述无尾部路径使用精确的基础路径。没有资格时，启用或访问同步内容返回 403 `sync_invitation_required`，登录账号可查询同步状态、暂停同步与清除云端内容。有资格但同步关闭时访问同步内容返回 409 `sync_disabled`，访问未选中的资料返回 409 `sync_scope_disabled`。代际过期或版本冲突返回 409 `sync_generation_changed` 或 `sync_conflict`。认证错误沿用 401，当前账号声明不匹配沿用 409。所有响应设置 no-store。

每次会话变更获得账号内单调增加的 revision。mutation_id 在账号与代际内幂等，未知结果可查询或按相同编号与相同内容重试。若该变更已应用且会话仍为同版，返回同版结果；若后来已有新版本，重试返回 sync_conflict，保留当前版本。已同步删除保留有版本的标记。并发覆盖使用 expected_revision 比较，客户端保留冲突版本为另一会话。服务端在读取正文之后、提交之前再次验证当前会话有效性与同步状态。

snapshot JSON 上限 32 MiB。私有会话与附件合计每账号默认上限 512 MiB，达到上限时明确提示清理或导出。附件先上传，全部引用校验成功后才提交会话。删除会话及清除云端后回收失去引用的原件，未关联的中断上传在后续操作或清理中回收。

服务器在现有私有 SQLite 数据库保存同步快照、附件 BLOB、引用、版本与开关，写入与回收在同一事务完成。服务备份须覆盖该数据库及其增长。

## 客户端边界

已登录的网页和 Android 客户端向同一服务查询同步状态。访客维持本机隔离。没有资格或开关关闭时只查询同步状态。首次开启或新设备先合并远端和本机，随后同步本机变更。重新联网、回到前台和定时轮询触发检查。

同步使用独立持久元数据和本机变更标记。远端落盘与 revision 更新在同一 IndexedDB 事务完成。网络期间本机新增修改、删除、备份恢复、退出和账号变化都必须使旧应用操作失效。生成中或尚未落盘的会话延后处理。同步恢复只读取已存在的模型结果，后台任务编号与待执行动作留在原设备。

会话编码保留原文、稳定消息及分支编号、引用、来源和会话记忆，排除账号凭据、API Key、输入草稿、服务端附件身份和未完成任务。已有备份校验、原子事务和来源重映射逻辑按适用范围复用。冲突恢复在正常会话列表可见，供用户继续或自行删除。
