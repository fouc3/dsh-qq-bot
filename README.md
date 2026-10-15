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
| 输入态与附件 | `发送` 进**当前会话**的输入态、`发送 <会话id>` 进**那个会话**的输入态（已有内容的输入框不会被静默换目标）：文字攒成正文、图片/文件/语音/视频自动入列（每个附件一个「删除」按钮，操作行**取消在左、发送在右**），点预览卡片上的「发送」才交给 AI——整次投递只有**一条消息**（语音转写/附件清单/正文各一个 content 块，followup 独占一轮，分两条会把正文挂成"待发送"）；没进输入态时直接发来的附件**丢弃并提示**；语音只用**平台转写**且单独一块、转写失败**拦住发送**；超限附件不自动下载，模型可调 `qq_fetch_attachment` 按需拉 |
| 结束通知 | 每轮结束发 `标题(会话id)已结束` + 两个按钮：「我需要回复」（回调）与「**发送消息**」（指令按钮，只把 `发送 <会话id>` 填进输入框 → 进那个会话的输入态） |
| 未回复补救 | **不再要求 AI 必须回复**：没回复时用户点「我需要回复」→ 注入唤醒消息要求 AI 回复该用户，并提示已触发 |
| 提问桥 | dsh 的 `ask_user_question` 在 QQ 侧渲染成 md 选择卡片：**按钮只写字母 A/B/C**，字母对照与选项小字写在题干与按钮之间；支持「其他」打字、提交（空提交=跳过）；一卡放不下（上限 20 个按钮）自动拆多张卡片，每张都能提交；提交后撤回卡片并留一条「提问结果」预览 |
| 结果预览 | 卡片撤回后留痕：提问提交 → 「提问结果 · N 题」（逐题 ✅/✍️其他/跳过）；输入态发送 → 「已发送 · 会话」（正文 N 字、语音转写、附件清单） |
| 指令面板 | 10 条命令注册到 QQ 指令面板；**自定义菜单顶层 8 项**（7 个平铺 + 一个「管理」二级菜单收 `停止/归档/权限`，平台顶层上限 10，得给 dsh 命令的二级菜单留位），面板只绑定配置指定的私聊 |
| 会话选择 | md 卡片：文件夹是回调按钮、会话是指令按钮（点了只把 `切换会话 <id>` 填进输入框） |
| 快捷 | 把常用会话存成快捷入口（命令就叫 `快捷`）：`快捷 加 [备注]` 存**当前会话**，每条自带一个 `#编号`（**只增不重用**：删掉 `#2` 不会让 `#3` 变成别的会话）；`快捷 #2` **直接切过去**（不经过会话选择卡片，**也认备注和会话id**）；`快捷 #2 <消息>` 是**只把消息投给那个会话、不切换当前绑定**（与 `发送` 同义：**会打断**）；备注可自定义、**不能含 `#`**（`#` 是编号专用）、不能是纯数字、不能重名（重名就只认编号）；`快捷 列出` 发卡片（**点按钮当场切**，不是填输入框）+ 一行「加当前会话」；`快捷 删 #2` / `快捷 备注 #2 <新备注>` 管理条目；**子命令中英文都认**：`加`＝`add`/`a`、`删`＝`delete`/`d`、`列出`＝`list`/`l`、`备注`＝`rename`/`r`；**裸发 `快捷` = 帮助**（列出现有条目 + 全部用法） |
| 白名单 | 只有配置里列出的 QQ 私聊能控制 bot；其他账号的消息一律丢弃并记日志 |
| 延迟发送 | **与 `发送` 共用同一套输入态面板**，只是投递时机不同：`发送` **打断**当前轮次立刻投给 AI，`延迟发送` **不打断**、等该会话本轮**正常结束**后再投（含输入态攒的图片/附件分节）；`延迟发送 <会话id> <内容>` 仍是直接登记（覆盖该会话原有待发消息）。**投递前先等驱动真的空闲**（不是"空了但还在收尾"），再走**和普通发送同一条**投递路径——否则消息会卡在 dsh 界面的「待发送」队列里再也不动（线上事故）；延迟投出去的这一轮**也算 QQ 一轮**：有每轮 QQ 上下文注入（模型知道要回 QQ）与结束通知 |
| 新建会话 | `新建会话` 的选目录卡片：`返回上级 \| 新建目录 \| 在这里新建` +（空目录时）单独一行的 `删除目录`；**新建目录**＝点完换一张带「**取消**」按钮的提示卡片 → 发一条消息写目录名 → 在当前目录下建出来并**默认 cd 进去**；**删除目录**只在**空目录**出现、**两步确认**，非空删不掉（`ENOTEMPTY` 护栏）。建会话时同时把目录**注册成 dsh 工作区**（`workspaceRegistry.create` + `attachSession`），否则 dsh Web 侧栏里整个文件夹都看不到 |
| 进度（只读） | `进度` / `进度 <会话id>`：状态、轮次、已跑多久、最近 3 个动作，输出**分两段**——**最近一段思考**（`reasoning` 块）与**最近一段正文**（`text` 块），两段**同款标注**「第 N 步，距最新第 M 步隔 K 步」（只有一段带距离会让用户以为两段打架；以前只有一段"最近一段输出"，常常其实是 reasoning）；**只读不打断**（以前想知道进展只能打断 AI） |
| 权限 | `权限` 发卡片（就是 Web 里那个 仅可查看 / 工作区内修改 / 完全权限 / Auto review 选择器），**每行两个按钮**、放不下自动加宽，点一下即切当前会话的级别；`权限 <级别>` 直接设定（认中文名 / 英文 key / 别名 / 卡片序号）；**显示名跟 Web 同款中文**（服务给的是英文名也按预设 key 覆盖，custom 档保留原名）；服务找不到了就如实回一句，不报错 |
| 模型 | `模型` 发**三级卡片**：①**提供商每行 2 个**（超 10 个才翻页）②点进去**模型每行 1 个**（超 4 个才翻页，正文给序号+完整名字+id）③点模型先出**确认卡片**：**应用到当前会话**（蓝，切完重发列表卡片并标 ✅/新当前）／**切到其他会话**（交互式：发一条消息写出会话id 即切给那个会话，提示卡片自带「取消」）／**返回**；`模型 <提供商>/<模型名字>` 直接切（不过确认卡片，id/显示名/序号都认，宽松匹配大小写空格与 `-`/`.`），末尾可选**会话id**（不跟就是当前会话）；**按钮 label 不再自己砍名字**——模型按钮（每行 1 个）上限 60 个显示宽度、几乎照发全名，交给 QQ 自己渲染；服务是 `ctx.sessionController`（`modelCatalog`/`selectModel`/`projections`，可选访问），冷会话也能切 |
| 提问卡片 | 按钮只写字母（A/B/C…），字母对照与选项小字写在正文；**选中态同时用按钮样式（蓝 `style=1`）与正文 ✅**；待答期间**命令优先**，不会被当成「其他」答案 |
| 按钮配色约定 | **主操作＝蓝 `style=1`、次要/退出＝灰 `style=0`、破坏性＝红 `style=3`；不用 `style=4`**（线上客户端把它渲染成白色，曾导致"取消蓝、发送白"点错） |
| 结束通知 | 正常结束 `…已结束`；被打断 `…被打断` + `> 打断来自：<那条消息>`（拿不到来源就不带引用行）。拿"这一轮真的结束了"有**两条路**：dsh 的 `turn/end` 事件（快）+ 兜底（`whenIdle()` 结算或 `agent/status=idle` 后，**回读会话日志确认我认领的那一轮真的出现过 `turn/end`**，用它的真实 reason）。**"空闲"不等于"我这一轮结束了"**：上一轮被顶替时 agent 也会先报一次 idle，误当收尾就会假报「被打断」、并把这一轮后面真正的 `turn/end` 吃掉（线上事故：37 分钟那轮跑完却没发「已结束」） |
| 人类来源标记 | **用户在 QQ 里打的字**按 `{ kind: 'user' }` 注入（`HUMAN_SOURCE`）——dsh 里有一批动作只认人类输入（`create_goal` / `update_goal edit\|pause\|resume` 要求当前轮里有一条 `source.kind === 'user'` 的 `user/message`），QQ 只是那根线，不标就等于把用户的授权吞了。插件**自己写的话**（「我需要回复」唤醒文本、每轮上下文注入）仍标成插件来源（`PLUGIN_SOURCE`），不冒充用户授权 |
| 排查用的小日志 | `~/.dsh/dsh-qq-bot/state.json` 的 `notes`（最近 40 条）：轮次开始/认领、收尾的 reason 与各门槛、通知入队或跳过、agent 挂载/重挂、收到过几类会话事件。**为什么放状态里**：插件日志进不了 journald（`dsh web` 只在启动时写几行），线上排查"结束通知怎么不发了"这类问题此前完全没有可观测性 |
| 卡片键盘限额 | 内联键盘最多 5 行、每行最多 5 按钮（平台硬限制）：目录与会话共用一页预算、装不下就翻页，导航按钮永远并进一行 |
| 失败退避 | 出站命令按失败类型处理：限速类（40034100/50002 等）指数退避重试（2s→4s→8s，最多 4 次），参数类硬错直接丢弃——避免无限重投把自己打成风暴 |
| dsh 内置命令 | QQ 里发 `/compact`、`/model`、`/goal`… 直接走 `ctx.commands.execute` 执行（不经模型）；这些命令在菜单里**收进二级菜单**（顶层留给桥命令）；技能不在内，「反馈」不兼容。**`/plan <文本>` 特殊处理**：只把 `/plan` 交给 dsh 切模式，文本走本桥正常投递（否则 dsh 会把它 `steer` 进会话、绕过本桥的轮次跟踪，QQ 侧看不到思考与结束通知）；plan 模式下模型提交的计划也会转发到 QQ |

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

### 4. （可选）dsh web 的「ID」按钮

仓库里还有一个**与 QQ 无关**的小 bundle：给 dsh web 的**会话标题栏右上角**加一个「**ID**」
按钮，点开悬浮窗看**当前会话 id** 并一键复制；**不在会话里不显示**；**设置里能关掉**。

```bash
plugin_manager action=install_bundle target=/home/fouc3/Projects/DSH-QQ-Bot/dsh-web-session-id
```

装完刷新页面即可。细节（挂在哪个槽位、设置存哪、为什么这么选）见
[dsh-web-session-id/README.md](dsh-web-session-id/README.md)。

---


## 配置

两侧各一份，都只有极少字段：

- **Go 侧**：`config.yaml`（见 `config.example.yaml` 的中文注释）。要点：
  - `qq.appid`+`qq.client_secret` 或 `qq.access_token` 二选一；
  - `bridge.socket` 必须与插件侧 `socketPath` **完全一致**；
  - `whitelist.users[].openid`：**白名单**（空 = 谁都不能用）；`panel: true` 的那条就是**被绑定指令面板的私聊**；
  - 任意字符串值可写 `${ENV_VAR}`，**引用了未设置的变量会启动失败**（不用环境变量就留空）；
  - 未知键名会启动失败，拼错不会静默忽略。
- **插件侧**：`dsh-plugin/cordis.patch.yml` 里这一行的 `config:`（缺省值见文件内注释）：`socketPath`、可选 `token`、`stateFile`、回复前缀模板、结束通知模板、提问超时、附件自动下载上限 `maxAttachmentBytes`（默认 50 MiB）与模型按需拉取上限 `maxFetchBytes`（默认 500 MiB）等。

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
| `快捷` | **裸发＝帮助**（列出现有条目 + 用法）；`快捷 列出`（`list`/`l`）才是卡片：每条一个按钮（**点一下直接切过去**）+ 末行「加当前会话」 |
| `快捷 加 [备注]` | 把**当前会话**存成快捷入口（自带 `#编号`；同一会话只留一条；备注不能含 `#`、不能纯数字、不能重名） |
| `快捷 #2` / `快捷 <备注>` / `快捷 <会话id>` | **直接切**到目标会话（也认纯数字；认不出的编号会明确报错） |
| `快捷 #2 <消息>` | **只把消息投给**那个会话，**不切换**当前绑定（与 `发送` 同义：**会打断**它正在跑的轮次） |
| `快捷 删 #2` | 删掉一条（编号不补位）；`快捷 备注 #2 <新备注>` 改备注 |
| 子命令写法 | 中英文都认：`加`/`add`/`a`、`删`/`delete`/`d`、`列出`/`list`/`l`、`备注`/`rename`/`r`（`帮助`/`help`/`h` 也是帮助） |
| `新建会话 [目录]` | 不带参数＝选目录卡片（可新建/删除目录、最后「在这里新建」）；带参数＝在目标目录新建并切换 |
| `进度 [目标]` | 只读快照（状态/轮次/耗时/最近动作），**不打断** |
| `发送 <目标> <内容>` | 单次发送到指定会话，不改绑定、**不打断**（忙则排队） |
| `停止 [目标]` | 停止目标会话当前轮次；**不带参数 = 当前会话** |
| `归档 [目标]` | 归档目标会话；**不带参数 = 当前会话** |
| `延迟发送` | 查看该会话的待发消息 |
| `延迟发送 <内容>` | 注册待发消息（每会话一条，覆盖旧值），AI 本轮正常结束后投递 |
| `权限 [级别]` | 不带参数＝权限卡片（每行两个，点一下即切）；带参数＝直接设定当前会话的级别 |
| `模型` | 模型卡片：先选**提供商**（每行 2 个、可翻页）→ 再选**模型**（每行 1 个、可翻页、显示全名）→ **确认**：应用到当前会话 / 切到其他会话（交互式，接着发一条会话id）/ 返回 |
| `模型 <提供商>/<模型名字> [会话id]` | 直接切（认 id/显示名/序号）；末尾跟会话id则切给那个会话，默认当前会话 |

**会话选择卡片**：文件夹用回调按钮逐层进入（每次选择都会撤回上一张卡片），会话用指令按钮 —— 点击只把 `切换会话 <id>` **填进输入框**，由你自己发送。撤回失败（如超过 2 分钟）只记 WARN 并跳过。

**自定义菜单**：顶层 8 项 —— `切换会话 / 快捷 / 新建会话 / 发送 / 延迟发送 / 模型 / 进度` 平铺，外加一个「管理」二级菜单收 `停止 / 归档 / 权限`；后面再接 dsh 内置命令的二级菜单（顶层 8 + 2 = 10，正好用满）。平台顶层上限 10 项，10 条桥命令全平铺会把 dsh 命令挤掉，所以不常点的三条进了二级菜单（指令面板里仍是完整 10 条）。

**结束通知上的「我需要回复」**：点了之后 bot 会校验（绑定关系、会话是否正在运行），然后向会话注入一条"用户点了「我需要回复」，请把上一条消息对应的结果完整回复给用户"的消息并唤醒，客户端提示成功，QQ 侧再回一条「已触发，正在请求回复…」。

---

## 冷会话恢复：必须走会话控制器（别再踩）

QQ 消息要投给一个**没有活 agent** 的会话时，插件会先"唤起"它。这一步**必须**用
`ctx.sessionController.resume(sessionId)`：dsh 的控制器恢复时会带上 `agentOptions`（模型选择）
与 `setup`（预设组合 —— **工具就是从预设组合来的**）：

```js
this.ctx.agents.resume({ resumeSessionId, agentOptions: this.agentOptions(), setup: composition.setup })
```

**踩过的坑（2026-10-15 线上事故）**：插件以前直接裸调 `ctx.agents.resume({ resumeSessionId })`，
造出来的 agent **没有模型、没有预设/工具**，于是：

- `agent.options.model` 为空 → 系统提示词里 `{{model}}` 取不到值 → 本轮直接失败：
  `prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`；
- 预设没组合 → **标准模式的工具全都不在**（bash/文件工具全没了，AI 只剩"嘴"）。

症状是"报错 + 工具全没"一起出现，只有**冷会话**第一次被 QQ 唤起时中招（重启之后、或当时没有
活 agent 的会话），重启 dsh 或显式切一次模型才会消失。现在 `agentFor()` 优先走控制器，
控制器不可用时才回退到裸 `agents.resume`（并记 WARN）。

---

## 延迟投递：必须等驱动真的空闲（别再踩）

`延迟发送` 的投递时机是"**这一轮** AI 正常结束"，而这件事是通过 dsh 的 `turn/end` 事件知道的 ——
也就是说，投递是在 `turn/end` 的**处理器里同步**触发的。问题是：**那一刻驱动还活着**
（dsh-agent-loop 的 `phase.kind === 'running'`，它紧接着才 `setPhase(idle)`），而 dsh 的
`wakeDriver` 在 running 且没有 abort 时**既不唤醒、也不登记唤醒**（`wakeRequested` 不置位）：

```js
// dsh-agent-loop 的原文（简化）
if (this.phase.kind !== "idle") {
  if (... && (this.phase.kind === "maintenance" || wakeAfterAbort)) this.phase.wakeRequested = true;
  return;                       // ← running 且没有 abort：唤醒被丢掉
}
```

于是那一刻 `followup` 交出去的消息只会被插进 next-turn 队列，然后**没人再唤醒它** ——
在 dsh 界面上它就是一直挂着的「**待发送**」，直到有人往那个会话再发一条普通消息才被顺带捡走。

**踩过的坑（2026-10-16 线上事故，session-3bebee33）**：

```
02:36:57 ■ turn 46 completed          ← 这一轮正常结束
02:36:57   延迟投递 → followup（next-turn，马上就在界面上成了「待发送」）
02:36:57   驱动退休，没人再唤醒它      ← 消息就这么挂着
02:37:22   ✕ 用户把这条「待发送」取消了
02:37:30   用户又手打了一遍同样的内容 → 这回立刻开了 turn 47
```

**现在的做法**：投递前先 `waitForIdle()` —— 等 `agent.whenIdle()`（驱动退休后才 settle，
外面套超时）或轮询到 `status !== 'running'`，然后再走**和普通发送完全一样**的那条路
（`onDeliver` → `deliver` → `followup`）。普通发送之所以从没踩过这个空档，是因为它来自
网关 socket 事件，那时驱动早就空闲了。等不到（有别的轮次在跑）也照样投：消息进 next-turn，
由那一轮收尾时捡走，和用户手打一条消息落在待发送队列里的效果一致，不会丢。

顺带修掉同一处的另一个坑：`finishRound` 最后原来无脑 `rounds.delete(sessionId)`，而延迟投递
**紧接着就会建出一个新轮次**（`origin='delayed'`）放进同一张表 —— 那个新轮次会被一起删掉，
于是它拿不到每轮 QQ 上下文注入（模型不知道要回 QQ）、结束通知也丢。现在只删"我这一轮"。
延迟轮次也按"QQ 的一轮"对待（`fromQqUser()`：`qq` 与 `delayed` 一视同仁），结束后照发
「已结束」+「我需要回复」。

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
- ✅ 十个命令都可用（切换会话 / 快捷 / 新建会话 / 进度 / 发送 / 停止 / 归档 / 延迟发送 / 权限 / 模型）；不带参数的 `停止`/`归档`/`权限` 作用于当前会话；需要参数的命令无参时回作用+用法
  —— `lib/commands.test.js` + `lib/plugin.test.js`「发送 / 延迟发送 / 停止 / 归档 / 权限 / 模型」
- ✅ `快捷`：**裸发＝帮助**（列出现有条目 + 用法，不发卡片），`列出`/`list`/`l` 才发卡片；`加 [备注]` 存当前会话、**编号只增不重用**（删了不补位）、同一会话只留一条（再加深只更新备注）；备注**不能含 `#`**、不能纯数字、不能重名（都被拒且列表不变）；目标认 `#编号` / 备注（**最长前缀**匹配，能带空格）/ **会话id**（`<目录> <会话id>` 也认）/ 纯数字，认不出的编号明确报错；**带消息＝只投递、不切换绑定**（用户要求；会打断，带引用也生效）；`删 #2` / `备注 #2 <新备注>` 管理条目；**子命令中英文等价**（`add`/`a`、`delete`/`d`、`list`/`l`、`rename`/`r`，大小写不敏感）；目标会话没了/已归档时如实说并提醒清掉；卡片按钮是**回调按钮（点一下当场切）**+ 末行「加当前会话」，点完重发卡片标出新的"当前"，整卡不超平台 5 行
  —— `lib/commands.test.js`「快捷」（9 条）+ `lib/cards.test.js`「快捷卡片」（2 条）+ `lib/plugin.test.js`「快捷 —— 裸发是帮助、列出给卡片、点按钮直接切、带消息只投递不切换」
- ✅ `权限`：接 `ctx.permissionPresets`（可选访问，缺服务就如实回一句）；内置档显示 Web 同款中文、custom 档保留服务名；卡片每行两个按钮、放不下自动加宽；带参数直接设定（中文名/英文 key/别名/序号）；点按钮切换并重发卡片
  —— `lib/permissions.test.js` + `lib/cards.test.js`「权限卡片」+ `lib/plugin.test.js`「权限」
- ✅ `模型`：接 `ctx.sessionController`（可选访问）——三级卡片（提供商每行 2 个 → 模型每行 1 个，各自翻页 → 确认卡片「应用到当前会话／切到其他会话／返回」）；**切其他会话是交互式**（发一条消息写出会话id 即切给那个会话，认不出会保持等待、可点「取消」返回），不再是把命令填进输入框；带参数直接切（id/显示名/序号、宽松匹配）、末尾可选会话id；**label 不再自己砍名字**（模型按钮上限 60 个显示宽度，几乎照发全名，交给 QQ 渲染；按钮 id 按序编号防撞车）；切失败/认不出都如实回报 + 用法
  —— `lib/models.test.js` + `lib/cards.test.js`「模型卡片」+ `lib/commands.test.js`「模型」+ `lib/plugin.test.js`「模型」（含"确认前绝不切"与"等会话id"两条关键断言）
- ✅ `发送`：裸发进当前会话输入态、只给会话进该会话输入态、带内容才是单次投递；认不出目标回用法、目标不存在报错；**有内容的输入框拒绝静默换目标**（先发送/取消）；**带引用时引用生效**（`[引用的消息] <原文>` 拼在正文前，`延迟发送` 同样）—— 以前命令路径把 `event.quote` 丢了，引用等于没用
  —— `lib/commands.test.js` + `lib/plugin.test.js`「输入态 / 带引用」
- ✅ `进度` 是**只读快照**（不 cancel、不 resume、不发消息）：当前轮次、已跑多久、最近 3 个动作，输出分**思考/正文**两段、**两段同款标注**「第 N 步，距最新第 M 步隔 K 步」；抓不到步号只降级标注；默认时钟不能算出 `NaN`（线上踩过「已跑 NaN 分 NaN 秒」）
  —— `lib/progress.test.js`（并用真会话日志核对过：K-Vault 会话**逐事件复现**了用户那张「思考 95 / 正文 95 / 最新 100」的快照，两段现在都写「距最新第 100 步隔 5 步」；另统计 32 轮里 30 轮同时有思考+正文、其中 13 轮正文落后多步）
- ✅ 指令面板定义：10 条命令、`c2c` + 指定私聊、按 remark 复用与目标差量；自定义菜单顶层 8 项（7 平铺 + 1 个「管理」二级菜单）—— Go `internal/qq/panel_test.go`；插件 `lib/plugin.test.js`「register → panel」
- ✅ 会话选择卡片：文件夹是回调按钮（逐层进入、每步撤回上一张）、会话是指令按钮（只填输入框、不直接切换）
  —— `lib/cards.test.js` + `lib/plugin.test.js`（断言 `action.type` 与 `recall_c2c`）
- ✅ 新建会话的选目录卡片：导航行 `返回上级 | 新建目录 | 在这里新建`，空目录时 `删除目录` **单独一行**；**新建目录**＝点完换成带「**取消**」按钮的提示卡片，发一条消息写目录名 → 真建出来并默认 cd 进去（点取消或发命令即退出等名字）；**删除目录**只在空目录出现、两步确认（第一步什么都不删）；非空目录即便手工调确认回调也被 `ENOTEMPTY` 挡住
- ✅ **在目录里新建会话/新建目录时自动把该目录注册成 dsh 工作区**（`workspaceRegistry.create` + `attachSession`），dsh Web 侧栏才看得到这个文件夹和会话；网关每次同步还会补登记"本桥碰过的"目录与会话（绑定会话 + `createdSessions`/`createdDirs` + **`notices` 里跑过轮次的会话** + 输入态/延迟发送提到的）。**全自动，不为它注册任何模型工具**
  —— `lib/plugin.test.js`「QQ 侧新建会话要把目录注册成工作区」「点『在这里新建』时同步把该目录注册成工作区」「启动补登记」
  —— `lib/cards.test.js` + `lib/plugin.test.js`「新建目录（等名字→创建→默认进去）与空目录删除（二次确认）」
- ✅ 每轮结束发「标题(会话id)已结束」+「我需要回复」+「发送消息」（指令按钮，`type=2`，data=`发送 <会话id>`，只填输入框不投递）；被顶替/未认领/被停止的轮次不发。**"已结束"有两条路**：`turn/end` 事件 + `whenIdle()` 兜底（回读会话日志里的 reason）——线上出现过"只剩被打断通知"，根因是事件监听收不到 `turn/end`，现在即使监听全聋也能判对
  —— `lib/rounds.test.js` + `lib/plugin.test.js`「whenIdle + 会话日志」「agent 实例被换掉后要重挂监听」+ `lib/cards.test.js`
- ✅ **QQ 里用户打的字按人类输入注入**（`source.kind === 'user'`）：dsh 里只认人类直接输入的动作（`create_goal`、`update_goal edit|pause|resume`）在 QQ 触发的轮次里也能用；插件自己写的话（唤醒文本、每轮上下文）仍标插件来源，不冒充授权
  —— `lib/plugin.test.js`（断言投递消息 `source.kind === 'user'`、唤醒文本仍是插件来源）
- ✅ 点「我需要回复」：绑定不符=4、运行中=1（失败，绝不用 2）、成功=0，并注入唤醒消息 + 回「已触发」
  —— `lib/rounds.test.js` + `lib/plugin.test.js`
- ✅ `延迟发送`：与 `发送` 共用输入态面板（mode=delay，卡片标题/主按钮都标明延迟）；只在本轮**正常结束**时投递、被停止/顶替/出错都不投、投递后清槽；**投递前先等驱动真的空闲**（否则 followup 的唤醒会被驱动收尾窗口吞掉 → 消息永远「待发送」）；投出去的这一轮也按 QQ 一轮对待（每轮上下文注入 + 结束通知）；收尾时**不能**把紧随其后新建的延迟轮次一起删掉；输入态登记的**图片与附件/语音分节**一起投；`延迟发送 <目标> <内容>` 仍是直接登记
  —— `lib/rounds.test.js`「只在正常结束时投递」「驱动还没退休就不投递」「也算 QQ 一轮」「不能把新建的延迟轮次删掉」「图片/分节一起投」+ `lib/plugin.test.js`「发送 / 延迟发送 / 停止 / 归档」「延迟投递必须等驱动空闲」
- ✅ 提问：`ask_user_question` → QQ 卡片（按钮只写字母、对照与选项小字在正文、选项/多选/「其他」打字/空提交=跳过/只撤回并重发被点的那张/一卡放不下拆多张/超时或放不下时交回 GUI 并在 QQ 侧说明）；**提交后撤回卡片并立刻发一条「提问结果」预览**
  —— `lib/questions.test.js` + `lib/plugin.test.js`「提问桥」
- ✅ 输入态：裸发 `发送` 进入；输入态里文字只攒正文、附件自动入列并回预览卡片（**不投给 AI**）；点卡片「发送」才投递——**只发一条消息**（语音转写块 → 附件块 → 正文 → 图片块），随后撤回卡片并发一条「已发送」**最终预览**；「删除 A1」只删一条；操作行取消在左、发送在右；「取消」清空退出。**按钮配色**：发送蓝(1)、取消/清空正文/删除附件灰(0)、确认删除红(3)、不用 4（客户端渲染成白色，曾导致点错）
  —— `lib/inbox.test.js` + `lib/cards.test.js`「按钮颜色」+ `lib/plugin.test.js`「输入态」
- ✅ 附件：图片走 `saveImages`（image 块进视觉通道）、文件/视频走 `saveFileStream`（只读副本路径）；语音只用平台转写且单独一段；没有转写的语音标「无法识别」并**拦住发送**；超自动上限（默认 50 MiB）不下载，模型用 `qq_fetch_attachment` 按需拉（默认上限 500 MiB）
  —— `lib/inbox.test.js` + `lib/attachment-tool.js` + `lib/plugin.test.js`「输入态」
- ✅ 没进输入态时直接发来的附件：丢弃 + 回一句提示（不会悄悄进会话）
  —— `lib/plugin.test.js`「输入态」
- ✅ UNIX socket 通道：目录 0700 / socket 0600 / 可选 token / 帧上限 1 MiB / 残留 socket 清理 / health 诊断
  —— `lib/socket.test.js` + Go `internal/bridge/socketclient_test.go`
- ✅ 出站队列 at-least-once（失败不消费、超时重投沿用原 id、撤回不重投、ack 唤醒等待者）
  —— `lib/outbox.test.js` + Go `internal/executor/executor_test.go`
- ✅ dsh 内置命令：QQ 侧 `/compact` 等直接执行（不经模型）、结果回给 QQ；不兼容的「反馈」
  与认不出的命令回退成普通消息；命令在菜单里收进二级菜单且不超顶层 10 项（桥自己的
  `停止/归档/权限` 也收进「管理」二级菜单，好给「模型」腾顶层位）
  —— `lib/dsh-commands.test.js` + `lib/plugin.test.js`「dsh 内置命令从 QQ 直接执行」;
  网关侧 `internal/qq/panel_clip_test.go`（`sub_menu_items` 落库 + 名宽截断 + 菜单差异检测）
- ✅ `/plan <文本>`：命令只切模式（`/plan`）、文本走本桥投递（带 QQ 上下文、轮次跟踪、结束通知）；`/plan off`/`/plan on`/`/plan` 原样执行；plan 模式下 `exit_plan_mode` 的计划正文转发到 QQ
  —— `lib/dsh-commands.test.js`「splitModeCommand」+ `lib/plugin.test.js`「/plan 带文本」「提交计划」
- ✅ 插件在真 `dsh web` 进程里挂载并可用 —— `application: applied`；通道 0600、目录 700；
  对通道发 `health` 得到真实会话数、发 `panel` 得到 10 条命令 + `c2c/specific`
- ✅ `git log` 有提交 —— 见仓库历史
- ⏳ 普通消息进 dsh 后，AI 调 `qq_reply` 时 QQ 真的收到，且开头是 `【标题(会话id)】`
- ⏳ 真实 QQ 客户端的按钮点按行为（单聊 `author.user_openid` 字段已对照 SDK 源码确认：
  `User.UserOpenID` ↔ `json:"user_openid"`）
- ⏳ 真机上的面板可见性与 `GetMenu`

## 测试

```bash
# Go 侧（含假 QQ 平台 + 真 UNIX socket 桩）
go vet ./... && gofmt -l . && go test -race ./...

# 插件侧：语法 + 176 项（含"装配级端到端"）
node --check dsh-plugin/index.js dsh-plugin/lib/*.js
node --test dsh-plugin/lib/*.test.js
```

**重启窗口不丢消息**：网关把 QQ 事件投给 dsh 插件时做了**退避重试**
（`internal/qq` 的 `emitWithRetry`：失败就 0.5s→1s→…→5s 退避，窗口 90s；取消即停），
所以插件/网关重启那几十秒里到的用户消息不再被静默丢弃（线上踩过：`/新建会话 /tmp` 发在重启窗口里，
网关只记了 `本地通道不可用` 就把它丢了）。`deploy/restart-and-verify.sh` 重启前还会先等
发件箱清空（`outboxDepth=0`，最多 60 秒），避免把还没发出去的回复吞掉。

**重启/验证一律外包给临时守护进程**（别占着会话干等）：

```bash
# 重启 + 自检（180 秒后执行，立刻返回）
systemd-run --user --on-active=180 --unit=dsh-qq-restart-N --collect \
  deploy/restart-and-verify.sh /tmp/dsh-qq-bot-restart.log

# 真机卡片验证（等通道 → 注入探针 → 收网关日志 → 写报告，立刻返回）
systemd-run --user --unit=dsh-qq-verify-model --collect \
  deploy/verify-model-card.sh /tmp/dsh-qq-bot-verify.log
```

`deploy/probe-model-card.mjs` 往桥里注入「提供商 → 模型列表 → 确认卡片 → 切到其他会话 →
取消」这一串事件，让插件真的往 QQ 发几张**模型卡片**（全程不调用 `selectModel`，不改任何会话的模型）。
它存在的理由：本地测试只能证明我们**构造**了这些按钮（比如 label 有多宽），平台收不收、
渲染成什么样只有真机能回答 —— 这也是"按钮 label 到底能多长"这个问题唯一可靠的答案来源。
探针自带两条**正向证据**（比"日志里没报错"强）：`pendingModel` 被写入又清除（说明插件认领了
这些事件、openid 确实在白名单里）、`lastCard` 拿到真 `messageId`（插件的 `sendCard` 是
`expectMessageId` 的，说明 QQ 真的收下了卡片）。实测结论：**21 个显示宽度的 label（含中文操作按钮）
平台照收** —— 我们以前按"10 个显示宽度"截断纯属自缚。

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
dsh-web-session-id/   dsh web 的「ID」按钮 bundle（Host 空壳 + 浏览器半边：标题栏按钮、悬浮窗、设置开关）
docs/protocol.md      两侧协议（帧、op、出站命令、队列语义）
```
