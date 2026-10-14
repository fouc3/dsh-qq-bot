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
| 提问桥 | dsh 的 `ask_user_question` 在 QQ 侧渲染成 md 选择卡片：**按钮只写字母 A/B/C**，字母对照与选项小字写在题干与按钮之间；支持「其他」打字、提交（空提交=跳过） |
| 指令面板 | 5 条命令注册到 QQ 指令面板 + 自定义菜单，面板只绑定配置指定的私聊 |
| 会话选择 | md 卡片：文件夹是回调按钮、会话是指令按钮（点了只把 `切换会话 <id>` 填进输入框） |
| 白名单 | 只有配置里列出的 QQ 私聊能控制 bot；其他账号的消息一律丢弃并记日志 |
| 延迟发送 | `延迟发送 <会话id> <内容>` 登记待发消息，该会话本轮**正常结束**后再投递给会话 |
| 新建会话 | `新建会话`（选目录卡片，逐层进入后点「在这里新建」）或 `新建会话 <目录>`；建完**默认切到新会话** |
| 卡片键盘限额 | 内联键盘最多 5 行、每行最多 5 按钮（平台硬限制）：目录与会话共用一页预算、装不下就翻页，导航按钮永远并进一行 |
| 失败退避 | 出站命令按失败类型处理：限速类（40034100/50002 等）指数退避重试（2s→4s→8s，最多 4 次），参数类硬错直接丢弃——避免无限重投把自己打成风暴 |
| dsh 内置命令 | QQ 里发 `/compact`、`/model`、`/goal`… 直接走 `ctx.commands.execute` 执行（不经模型）；这些命令在菜单里**收进二级菜单**（顶层留给桥命令）；技能不在内，「反馈」不兼容 |

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

### 1.5 用 systemd 用户服务常驻（推荐，别用后台任务）

网关连的是你 home 下的 socket、要跟着你的登录会话跑，所以用**用户级**服务：

```bash
cp deploy/dsh-qq-bot.service ~/.config/systemd/user/     # 仓库里的是 %h 路径版模板
systemctl --user daemon-reload
systemctl --user enable --now dsh-qq-bot
systemctl --user status dsh-qq-bot
journalctl --user -u dsh-qq-bot -f          # 看日志
```

崩了会自动拉起（`Restart=always`）。想让它在**没登录时也常驻**，需要
`loginctl enable-linger $USER`（这是系统级设置，自己决定要不要开）。

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

> **本机已安装并验证（2026-10-14）**：`plugin_manager install_bundle` 返回
> `application: applied`；profile 里记录为 `link:/home/fouc3/Projects/DSH-QQ-Bot/dsh-plugin`
> （软链安装——这正是插件必须自包含、不能 import dsh 包的原因）。在**运行中的 dsh web 进程**里实测：
> 通道 `~/.dsh/dsh-qq-bot/bridge.sock` 为 `srw-------`（目录 700）；直接对该 socket 发 `health`
> 得到 `{ok:true,version:1,bindings:0,outboxDepth:0,titles:197,whitelist:0}`（197 = 真实会话数）；
> 发 `panel` 得到 `scope=c2c / target=specific / 5 条命令 / 5 条菜单`。
>
> 装它之前需要先放行 profile 里既有的第三方 git 包（否则 pnpm 会以
> `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 拒绝任何安装）：把
> `~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds` 里
> `dsh-pause@https://codeload.github.com/better-er/dsh-pause/tar.gz/14f5fd3...` 从占位符
> `set this to true or false` 改成 `true`。这是**允许该第三方包执行安装脚本**的安全决定，需你拍板。
>
> **不能用裸 `--patch` 行把插件"插"进现有 profile**（已实测）：覆盖式补丁只能按 id
> 改写**已有**条目，新增条目会报 `patch: entry "<id>" not found`；新增要用
> `- insert:` 形式（本 bundle 的 `cordis.patch.yml` 用的就是这个形式，由
> `install_bundle` 在包的上下文里合并）。所以安装这一步走 `plugin_manager` 最省事。
> （`--dump-config` 只回显补丁行，能查 YAML 方言是否正确，但**不代表已经挂载**。）

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

`✅` = 已有自动化证据（跑下面两条命令即可复现），`⏳` = 必须真 QQ 环境（凭据 + 私聊 openid），只能你本地验。

- ✅ 白名单外的账号发命令：无任何效果，网关日志有 WARN（含其 openid）
  —— Go `internal/qq/events_test.go`；插件第二道门守 `lib/plugin.test.js`「非白名单来源的事件在插件侧被丢弃」
- ✅ 会话正在跑时发消息：先 cancel 再开新一轮；空闲时直接开始
  —— `lib/plugin.test.js`「命令 → 会话卡片…」（4b 步：断言 `agent.cancelled === 1` 与投递顺序）
- ✅ 被动回复失效（超 60 分钟 / 超 4 次）自动改发主动消息 —— Go `internal/qq/messaging_test.go`
- ✅ 富媒体上传：URL 直发、本机文件分片（校验和 + 预签名 PUT + 失败重试）、超限报错
  —— Go `internal/qq/media_test.go`（含分片与 `md5_10m`）
- ✅ 五个命令都可用；不带参数的 `停止`/`归档` 作用于当前会话；需要参数的命令无参时回作用+用法
  —— `lib/commands.test.js` + `lib/plugin.test.js`「发送 / 延迟发送 / 停止 / 归档」
- ✅ 指令面板定义：5 条命令、`c2c` + 指定私聊、按 remark 复用与目标差量 —— Go `internal/qq/panel_test.go`；插件 `lib/plugin.test.js`「register → panel」
- ✅ 会话选择卡片：文件夹是回调按钮（逐层进入、每步撤回上一张）、会话是指令按钮（只填输入框、不直接切换）
  —— `lib/cards.test.js` + `lib/plugin.test.js`（断言 `action.type` 与 `recall_c2c`）
- ✅ 每轮结束发「标题(会话id)已结束」+「我需要回复」；被顶替/未认领/被停止的轮次不发
  —— `lib/rounds.test.js` + `lib/plugin.test.js`
- ✅ 点「我需要回复」：绑定不符=4、运行中=2、成功=0，并注入唤醒消息 + 回「已触发」
  —— `lib/rounds.test.js` + `lib/plugin.test.js`
- ✅ `延迟发送 <目标> <内容>` 登记、只在本轮**正常结束**时投递、投递后清槽；无参回用法
  —— `lib/rounds.test.js`「只在正常结束时投递」+ `lib/commands.test.js`
- ✅ 提问：`ask_user_question` → QQ 卡片（按钮只写字母、对照与选项小字在正文、选项/多选/「其他」打字/空提交=跳过/每步撤回上一张/超时交回 GUI）
  —— `lib/questions.test.js` + `lib/plugin.test.js`「提问桥」
- ✅ UNIX socket 通道：目录 0700 / socket 0600 / 可选 token / 帧上限 1 MiB / 残留 socket 清理 / health 诊断
  —— `lib/socket.test.js` + Go `internal/bridge/socketclient_test.go`
- ✅ 出站队列 at-least-once（失败不消费、超时重投沿用原 id、撤回不重投、ack 唤醒等待者）
  —— `lib/outbox.test.js` + Go `internal/executor/executor_test.go`
- ✅ dsh 内置命令：QQ 侧 `/compact` 等直接执行（不经模型）、结果回给 QQ；不兼容的「反馈」
  与认不出的命令回退成普通消息；命令在菜单里收进二级菜单且不超顶层 10 项
  —— `lib/dsh-commands.test.js` + `lib/plugin.test.js`「dsh 内置命令从 QQ 直接执行」;
  网关侧 `internal/qq/panel_clip_test.go`（`sub_menu_items` 落库 + 名宽截断 + 菜单差异检测）
- ✅ 插件在真 `dsh web` 进程里挂载并可用 —— `application: applied`；通道 0600、目录 700；
  对通道发 `health` 得到真实会话数（197）、发 `panel` 得到 5 条命令 + `c2c/specific`
- ✅ `git log` 有提交 —— 见仓库历史
- ⏳ 普通消息进 dsh 后，AI 调 `qq_reply` 时 QQ 真的收到，且开头是 `【标题(会话id)】`
- ⏳ 真实 QQ 客户端的按钮点按行为（单聊 `author.user_openid` 字段已对照 SDK 源码确认：
  `User.UserOpenID` ↔ `json:"user_openid"`）
- ⏳ 真机上的面板可见性与 `GetMenu`

## 测试

```bash
# Go 侧（含假 QQ 平台 + 真 UNIX socket 桩）
go vet ./... && gofmt -l . && go test -race ./...

# 插件侧：语法 + 70 项（含"装配级端到端"）
node --check dsh-plugin/index.js dsh-plugin/lib/*.js
node --test dsh-plugin/lib/*.test.js
```

`lib/plugin.test.js` 是**装配级端到端**：真的调用插件导出的 `apply()`，起真的 UNIX socket，
以真实 NDJSON 帧走 `register / panel / event / outbox.poll / ack / health`，
断言 QQ 消息真的变成了对 agent 的注入消息、卡片/结束通知真的进了出站队列、
按钮点按真的走了回调路由、提问 waterfall 真的在 QQ 侧结算。它用假 dsh 服务替代运行时，
所以不需要凭据也不需要 `dsh web`。

**bundle 自包含**：`dsh-plugin/` 里**没有任何 `@deepseek-ai/*` import**（工具定义用原始
JSON Schema，用户消息本地构造）。原因：profile 安装本地目录是 pnpm 软链，Node 按 realpath
解析依赖，而 `~/Projects/...` 这条链上并没有 `@deepseek-ai/*`（那是 dsh 安装目录和
`~/.dsh/profiles/node_modules` 提供的）。自包含后无论软链还是拷贝安装都能加载。

**尚未验证**：真 QQ 凭证下的端到端收发（需要你自己的机器人凭据与私聊 openid）。
插件本体已在运行中的 `dsh web` 里挂载并通过通道自检（见上面"安装"）。

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
