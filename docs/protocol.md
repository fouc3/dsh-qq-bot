# DSH-QQ-Bot 本地通道协议

QQ 侧网关（Go，下称 **bot**）与 dsh 侧插件（`@local/dsh-qq-bot`，下称 **plugin**）之间的唯一通道。

- **载体**：UNIX domain socket（不是 TCP、不是 HTTP）。
- **默认路径**：`~/.dsh/dsh-qq-bot/bridge.sock`（两侧配置必须一致）。
- **权限**：父目录 `0700`、socket 文件 `0600`、状态文件 `0600` —— **权限即认证**：只有与 dsh 同账户的进程能连上。
- **编码**：UTF-8，换行分隔 JSON（NDJSON），一次请求一行、一次响应一行。
- **上限**：单行 1 MiB；超限即断连（服务端不试图恢复）。
- **方向**：bot 总是客户端（主动拨号）；plugin 是服务端。bot 崩溃/重启不影响 plugin 状态。

## 1. 连接与握手

```
（config.token 为空时不需要握手，直接发请求）
C→S  {"token":"<插件配置里的 token>"}
S→C  {"ok":true}
（失败）
S→C  {"ok":false,"error":{"code":"unauthorized","message":"token 不匹配"}}   → 服务端随即关闭连接
```

- token 用常量时间比较；失败不区分"没带 token"与"token 不对"。
- 握手必须在 5 秒内完成。
- 建议：**每请求一条连接**（拨号 → 一帧请求 → 一帧响应 → 关闭），简单且天然串行；
  `outbox.poll` 用自己的长连接（它要占用整个等待窗口）。

## 2. 请求 / 响应帧

```
C→S  {"id":"<调用方自定的字符串>","op":"<op 名>","args":{…}}
S→C  {"id":"<原样回显>","ok":true,"value":{…}}
S→C  {"id":"<原样回显>","ok":false,"error":{"code":"…","message":"…"}}
```

- `args` 缺省为 `{}`；`id` 缺省为 `null` 并原样回显。
- **失败不消费任何状态**：`ok:false` 表示这次没有生效，bot 可以原样重试。

### 错误码

| code | 含义 |
|---|---|
| `unauthorized` | token 不匹配（服务端会关连接） |
| `bad-json` | 帧不是合法 JSON |
| `bad-request` | 缺少 `op`，或 `args` 不满足该 op 的 schema |
| `too-large` | 单行超过 1 MiB |
| `unknown-op` | 未知 op |
| `internal` | plugin 内部错误（细节在 `message`，正文与 token 不记录到日志） |

## 3. op 一览

| op | args | value |
|---|---|---|
| `register` | `{"openids":[{"openid":"…","note":"…"}],"panel":{"enabled":true,"users":["…"]},"menu":{"enabled":true},"version":1}` | `{"ok":true}` |
| `panel` | `{}` | `{"scope":"c2c","targetType":"specific","userOpenIds":["…"],"items":[{"name":"…","desc":"…"}],"menu":{"items":[{"name":"…","sendMessage":"…"}]}}` |
| `event` | `{"kind":"c2c_message","openid":"…","text":"…","msgId":"…","at":"RFC3339"}` / `{"kind":"interaction","openid":"…","buttonData":"…","eventId":"…","msgId":"…"}` / `{"kind":"ready"}` | `{"accepted":true}` |
| `outbox.poll` | `{"waitSeconds":25}` | `{"commands":[ … ]}`（可能为空数组） |
| `ack` | `{"id":"<命令 id>","ok":true,"messageId":"…"}` | `{"ok":true}` |
| `health` | `{}` | `{"ok":true,"version":"…","bindings":n,"pendingQuestions":n,"outboxDepth":n,"titles":n}` |

### register

bot 启动时（重连后也会重发）上报白名单快照与面板意图，plugin 把它持久化：

- `panel.users` = 配置里 `panel: true` 的那些私聊 openid；
- plugin 用它做**二次门守**（第一道门守在 bot 侧），并在 `panel` op 里回给 bot；
- 未 register 之前，plugin 认为白名单为空（谁都不能控制）。

### event

- `event` 立即返回 `{"accepted":true}`，**处理是异步的**：bot 不该等结果，也不该因为一次 `ok:true` 认为消息已经被 AI 看到。
- bot **必须**在事件回调里只做两件事：白名单门守 + 发这一帧；不要在 QQ 的事件循环里等待。

### outbox.poll

长轮询：有命令立刻返回，没有则最多等 `waitSeconds` 秒后返回空数组。

```json
{"id":"p1","op":"outbox.poll","args":{"waitSeconds":25}}
{"id":"p1","ok":true,"value":{"commands":[{"id":"c-17","kind":"send_c2c","args":{…}}]}}
```

### ack

每条命令都必须 ack 一次（成功或失败）：

```json
{"id":"a1","op":"ack","args":{"id":"c-17","ok":true,"messageId":"MSGID"}}
{"id":"a2","op":"ack","args":{"id":"c-18","ok":false,"errorCode":40034128,"error":"被动回复超限"}}
```

## 4. 出站命令

命令结构：`{"id":"<命令 id>","kind":"<kind>","args":{…}}`。

### send_c2c

```json
{"openid":"…","markdown":true,"content":"【标题(session-…)\n】…",
 "keyboard":{…},"replyToMsgId":"…","replyToEventId":"…","msgSeq":1}
```

- `markdown` 决定按 markdown 渲染（bot 统一用 `msg_type=2`；键盘只能挂 markdown 消息）。
- `keyboard` 为 QQ 内嵌键盘的原始结构（行/按钮），bot 原样透传并对必填项做本地校验。
- **被动回复优先级**：`replyToEventId`（按钮互动）> `replyToMsgId`（用户消息）> 主动消息。
  被动窗口：单聊 60 分钟、每个 `msg_id` 最多 4 次；超限/过期时 bot 自动改发主动消息。

### send_media

```json
{"openid":"…","kind":"image","path":"/home/…/a.png","name":"a.png",
 "url":"https://…","replyToMsgId":"…","replyToEventId":"…","msgSeq":2}
```

- `kind` ∈ `image`（png/jpg，≤20MB）/ `video`（mp4，≤30MB）/ `voice`（silk，≤20MB）/ `file`（任意，≤200MB）。
- `path`（本机文件，走分片上传）与 `url`（公网地址，平台自己下载）**二选一**，同时给时优先 `path`。
- 一条命令 = 一条 QQ 消息（平台一条 `media` 只能带一个 `file_info`）。

### recall_c2c

```json
{"openid":"…","messageId":"…"}
```

撤回失败（含超 2 分钟的 `40064004`）只记 WARN，不算命令失败。

### respond_interaction

```json
{"interactionId":"…","code":0}
```

`code`：0 成功（按钮进终态）/ 1 失败（按钮可再点）/ 2 操作频繁 / 3 重复 / 4 无权限 / 5 仅管理员。
**同一个 interaction 只会被回应一次**（由客户端保证，服务端不报错）。

### publish_panel

```json
{"remark":"DSH-QQ-BOT 指令面板","enabled":true,
 "menuEnabled":true,
 "items":[{"name":"切换会话","desc":"选择要接入的会话"}],
 "userOpenIds":["…"]}
```

bot 收到后按 `remark` 找到已有面板 → 更新；找不到 → 创建；并把 `userOpenIds` 差量同步。

## 5. 队列语义

- plugin 持有所有**未 ack** 的命令；一条命令 60 秒未 ack 会被重新下发（at-least-once）。
- bot 负责去重：命令 id 写入本地小文件（权限 0600），重启后仍能识别已执行过的命令。
- `ok:false` 的 ack **不消费命令**：命令会再次下发（用于"这次确实没发出去，稍后重试"）。
- 命令在 `ack ok:true` 后从队列移除；`recall_c2c` 与 `respond_interaction` 不重投（失败只记日志）。

**反向（QQ → plugin）也有一层重试**：bot 把 QQ 事件（`event` / `ready`）投给 plugin 时，
若本地通道暂时不可用（plugin/gateway 正在重启，socket 短暂不存在），不会直接丢弃，
而是**退避重试**（0.5s→1s→2s→…→5s，窗口 90 秒；上下文取消即停），
直到通道回来或超窗口后记为错误。以前这里一失败就把事件丢掉，
用户在重启窗口里发的消息会**静默消失**（线上踩过：`/新建会话 /tmp`）。

## 6. 交互与文案约定（plugin 侧生成，bot 侧不理解语义）

| 场景 | 内容 |
|---|---|
| AI 回复 | 正文以 `【{标题}({sessionId})】` 开头（模板可配） |
| 一轮结束通知 | `{标题}({sessionId})已结束` + 键盘单行两按钮：「我需要回复」`action.type=1`、`data="qqb:needreply:<sessionId>"`；「发送消息」`action.type=2`（指令按钮，只把 `发送 <sessionId>` 填进输入框） |
| 权限卡片 | 每档一个回调按钮，`data="qqb:perm:<预设key>"`（如 `danger-full-access`）；每行 2 个、放不下自动加宽；当前档 `style=1`（蓝）、其余 `style=0`（灰） |
| 会话选择卡片 | 文件夹按钮 `action.type=1`、`data="qqb:dir:<路径>"`；会话按钮 `action.type=2`（指令按钮，只把 `切换会话 <sessionId>` 填进输入框）。新建会话卡片另有 `qqb:mkdir:`（新建目录，等名字）、`qqb:mkx:`（取消等名字）、`qqb:rmdir:` / `qqb:rmdir2:`（删除空目录的两步确认） |
| 提问卡片 | 选项 `data="qqq:<callId>:<题序>:<选项序>"`、其他 `…:custom`、提交 `…:submit`；选中 `style=1`、未选中 `style=0` |
| 按钮配色 | 主操作＝蓝 `1`、次要/退出＝灰 `0`、破坏性＝红 `3`；**不用 `4`**（SDK 名为"蓝色填充"，线上客户端实际渲染成白色，曾导致"取消蓝、发送白"被点错） |

bot 对 `buttonData` 只做一件事：原样塞进 `event` 帧（`data.Data.Resolved.ButtonData`）。
