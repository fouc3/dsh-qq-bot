# DSH-QQ-Bot

把 **QQ 私聊**接到本机 **DeepSeek Harness（dsh）**会话上的桥：QQ 用户发消息 → 送进 dsh 会话 → AI 回复/主动汇报 → 回到 QQ。

桥由两半组成，**没有 acpx、没有 HTTP**：

```
QQ 用户 ──私聊──▶ QQ 开放平台 ──WebSocket──▶ Go: dsh-qq-bot
                                              白名单门守 / 指令面板 / 统一发送与上传收口
                                                │  UNIX domain socket（NDJSON，目录 0700 / socket 0600）
                                                ▼
                                          dsh Host 插件 @local/dsh-qq-bot（与 dsh web 同进程）
                                            ├ 会话索引 + 标题折叠
                                            ├ 指令解析 / 会话选择卡片（md + 按钮）
                                            ├ agent/pre-step 注入用户级上下文 + followup 投递 + 打断
                                            ├ qq_reply 工具（md 开关 + 图片/文件附件）
                                            ├ 每轮结束通知「标题(会话id)已结束」+「我需要回复」按钮
                                            └ ask_user_question → QQ 选择卡片
```

**为什么必须是"同进程插件"**：dsh 没有本地 RPC socket，`/api` 需要浏览器签名 Cookie，而 `acp` / `sdk` / `headless` 都是**另一个进程**，碰不到 `dsh web` 里那个活着的 `Agent`（`headless` 还显式拒绝 live / 带 preset / cwd 不匹配的会话）。所以只有进程内的 Host 插件能"把消息送进正在用的会话、并打断它"。

---

## 功能

| 能力 | 说明 |
|---|---|
| 私聊消息转发 | QQ 消息 → 绑定会话；**会话正在跑就先打断**，空闲则直接开轮 |
| AI 回复到 QQ | AI 调用 `qq_reply` 工具；每条回复开头带 `【标题(会话id)】` |
| 富媒体 | `qq_reply` 可发图片/视频/语音/文件：本机路径走分片上传，公网 URL 直传 |
| 结束通知 | 每轮结束发 `标题(会话id)已结束` + 一个「我需要回复」按钮 |
| 未回复补救 | **不再要求 AI 必须回复**：没回复时用户点「我需要回复」→ 注入唤醒消息要求 AI 回复该用户，并提示已触发 |
| 提问桥 | dsh 的 `ask_user_question` 在 QQ 侧渲染成选择卡片（按钮/「其他」打字/提交，空提交=跳过） |
| 指令面板 | 5 条命令注册到 QQ 指令面板 + 自定义菜单，面板只绑定配置指定的私聊 |
| 会话选择 | md 卡片：文件夹是回调按钮、会话是指令按钮（点了只把 `切换会话 <id>` 填进输入框） |
| 白名单 | 只有配置里列出的 QQ 私聊能控制 bot；其他账号的消息一律丢弃并记日志 |
| 延迟发送 | `延迟发送 <内容>` 注册待发消息，AI 本轮**正常结束**后再投递给会话 |

---

## 安装

### 1. 编译 QQ 侧网关

```bash
go build -o bin/qqbot ./cmd/qqbot
cp config.example.yaml config.yaml
$EDITOR config.yaml          # 填 appid/client_secret（或 access_token）、白名单 openid
./bin/qqbot -config config.yaml -check-config    # 只校验配置并打印摘要（不打印密钥）
./bin/qqbot -config config.yaml
```

`go.mod` 用 `replace` 指向本机的 qq-bot-sdk（`../QQ-Bot-CLI/qq-bot-sdk`）。切回发布版：

```bash
go mod edit -dropreplace=github.com/fouc3/qq-bot-sdk
go get github.com/fouc3/qq-bot-sdk@main
```

### 2. 装 dsh 插件（必须装进你正在用的那个 profile，通常是 `web`）

用宿主工具安装（会自己写 profile 的 `package.json` 与 `cordis.patch.yml`）：

```
plugin_manager action=install_bundle target=/home/fouc3/Projects/DSH-QQ-Bot/dsh-plugin
```

或手工：

```bash
dsh plugin --profile web add /home/fouc3/Projects/DSH-QQ-Bot/dsh-plugin
```

装完确认：插件管理器里出现 `@local/dsh-qq-bot`，状态 `applied`；`dsh web` 重启后仍在。

### 3. 起服务并核对

```bash
dsh web                                   # 3000+；插件与它同进程
./bin/qqbot -config config.yaml
ls -ld ~/.dsh/dsh-qq-bot ~/.dsh/dsh-qq-bot/bridge.sock   # 应为 drwx------ 与 srw-------
```

---

## 配置

两侧各一份，都只有极少字段：

- **Go 侧**：`config.yaml`（见 `config.example.yaml` 的中文注释）。要点：
  - `qq.appid`+`qq.client_secret` 或 `qq.access_token` 二选一；
  - `bridge.socket` 必须与插件侧 `socketPath` **完全一致**；
  - `whitelist.users[].openid`：**白名单**（空 = 谁都不能用）；`panel: true` 的那条就是**被绑定指令面板的私聊**；
  - 任意字符串值可写 `${ENV_VAR}`，**引用了未设置的变量会启动失败**（不用环境变量就留空）；
  - 未知键名会启动失败，拼错不会静默忽略。
- **插件侧**：`dsh-plugin/cordis.patch.yml` 里这一行的 `config:`（缺省值见文件内注释）：`socketPath`、可选 `token`、`stateFile`、回复前缀模板、结束通知模板、提问超时等。

**openid 怎么拿**：让目标账号给机器人发一条私聊，网关会记一条 WARN：

```
level=WARN msg="已丢弃非白名单用户的私聊" openid=2A3B4C… text_len=3
```

把它填进 `whitelist.users[].openid` 即可。

---

## 命令

命令都发在私聊里，词前可带一个 `/`（与 QQ 自定义菜单/指令按钮的填充行为兼容）。

| 命令 | 作用 |
|---|---|
| `切换会话` | 发/刷新**会话选择卡片**（不带参数即会话选择） |
| `切换会话 <会话id>` / `切换会话 <目录> <会话id>` | 把当前私聊绑定到该会话 |
| `切换会话 none` | 解除绑定（此后只能用 `发送` 指定会话送消息） |
| `发送 <目标> <内容>` | 单次发送到指定会话，不改绑定、**不打断**（忙则排队） |
| `停止 [目标]` | 停止目标会话当前轮次；**不带参数 = 当前会话** |
| `归档 [目标]` | 归档目标会话；**不带参数 = 当前会话** |
| `延迟发送` | 查看该会话的待发消息 |
| `延迟发送 <内容>` | 注册待发消息（每会话一条，覆盖旧值），AI 本轮正常结束后投递 |

**会话选择卡片**：文件夹用回调按钮逐层进入（每次选择都会撤回上一张卡片），会话用指令按钮 —— 点击只把 `切换会话 <id>` **填进输入框**，由你自己发送。撤回失败（如超过 2 分钟）只记 WARN 并跳过。

**结束通知上的「我需要回复」**：点了之后 bot 会校验（绑定关系、会话是否正在运行），然后向会话注入一条"用户点了「我需要回复」，请把上一条消息对应的结果完整回复给用户"的消息并唤醒，客户端提示成功，QQ 侧再回一条「已触发，正在请求回复…」。

---

## 验收清单

- [ ] 白名单外的账号发命令：无任何效果，网关日志有 WARN（含其 openid）
- [ ] 会话正在跑时发消息：日志出现 cancel，随后开始新一轮；空闲时直接开始
- [ ] 普通消息能进 dsh（会话里能看到消息与注入的上下文），AI 调 `qq_reply` 后 QQ 收到，且开头是 `【标题(会话id)】`
- [ ] AI 本轮没回复：QQ 侧只收到「…已结束」+按钮；点「我需要回复」→ 提示已触发 + AI 被唤醒并回复
- [ ] 富媒体：`qq_reply` 发本机图片成功；>20MB 文件走分片成功；超限文件返回明确错误
- [ ] 五个命令都可用；不带参数的 `停止`/`归档` 作用于当前会话
- [ ] 指令面板在配置指定的私聊可见；`GetMenu` 返回 5 条命令
- [ ] 会话选择卡片：文件夹可逐层进入、上一张被撤回、会话按钮只填输入框
- [ ] `延迟发送` 注册后，在本轮正常结束时收到；不带参数能列出待发消息
- [ ] 提问：`ask_user_question` 在 QQ 出选择卡片，选项/多选/「其他」打字/直接提交跳过都正确，且每步撤回上一张卡片
- [ ] `git log` 有提交

## 测试

```bash
go vet ./... && gofmt -l . && go test ./...
node --check dsh-plugin/index.js dsh-plugin/lib/*.js
node --test dsh-plugin/lib/*.test.js
```

## 边界与已知约束

- 只做**单聊**；群/频道/频道私信不在范围内。
- 单聊被动回复窗口 60 分钟、每条用户消息最多 4 次；超限时自动改发主动消息（受平台频控）。
- 媒体消息不能带键盘（平台限制：键盘只能挂 markdown）。
- `ask_user_question` 走 dsh 默认的 legacy 模式（会一直阻塞），QQ 侧的唯一时间界是插件配置的 `questionTimeoutMs`；超时后交回 dsh GUI（`next()`），不吞掉提问。
- 富媒体语音需 silk 格式；图片只接受 png/jpg，其他格式会被平台降级成文件。
- dsh `web` 必须常驻（插件在它的进程里）。

## 目录

```
cmd/qqbot/            网关入口（-config、-check-config）
internal/config/      配置加载/校验/摘要（未知键失败、${ENV} 严格展开）
internal/logging/     slog 组装
internal/qq/          SDK 客户端、事件、统一发送收口、撤回、富媒体、指令面板
internal/bridge/      unix socket 客户端（NDJSON + 权限校验 + 长轮询）
internal/executor/    出站命令执行（去重 + ack）
dsh-plugin/           dsh Host 插件 bundle（socket 服务、会话/标题、命令与卡片、工具、轮次、提问）
docs/protocol.md      两侧协议（帧、op、出站命令、队列语义）
```
