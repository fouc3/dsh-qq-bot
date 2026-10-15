# dsh web 会话 ID 按钮（`@local/dsh-web-session-id`）

给 dsh web 的**会话标题栏右上角**加一个「**ID**」小按钮：点开一个悬浮窗，看**当前会话 id**
并**一键复制**；**不在会话里就不显示**；**设置里能关掉**这个按钮。

```
会话标题栏：  标题…                            [ ID ]  ← 这里（在原有 utilities 那一排里）
点 ID：       ┌─────────────────────────┐
              │ 当前会话 ID              │
              │ session-3bebee33-…       │  ← 可选中（user-select: all）
              │                  [复制]  │
              └─────────────────────────┘
```

## 安装

```bash
plugin_manager action=install_bundle target=/home/fouc3/Projects/DSH-QQ-Bot/dsh-web-session-id
# 或手工：
dsh plugin --profile web add /home/fouc3/Projects/DSH-QQ-Bot/dsh-web-session-id
```

装完**刷新页面**：浏览器模块名单是页面加载时由宿主下发的，新的一行要等下一次加载才会出现。

结构：Host 半边 `index.js` 是**空壳**（`apply() {}`），界面全在 `client.js`
（`window.__ModuleLoader__.load({ id: '@local/dsh-web-session-id', factory })`），
`package.json` 的 `dsh.client` 声明 `platform: web` / `immediately` /
`inject: ['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-settings']`。

## 它挂在哪、为什么

| 需求 | 落点 | 依据 |
|---|---|---|
| 右上角一个按钮 | `conversation.session.header.utilities`（"Right-aligned Session utilities"） | `Slots.listSubTree` 查到的槽位；宿主自己的 `open-in-app`(-10)、`session-log-download`(0) 与第三方 `dsh-watcher`(50) 都在这排，我们取 **order 20** |
| 不在会话就不显示 | 同上：该槽位 **scope 是 session** | 没有会话时整个 `conversation.session.header` 都不渲染 —— 不靠插件自己判断 |
| 设置里能关掉 | `settings.general.item`（General 里的一行偏好）+ `localStorage` | 该槽位的说明写明"标签、当前值、写入都由你画"；客户端 Service 目录里没有通用偏好/存储服务，`host.call` 只属于**动态包**，bundle 的浏览器半边拿不到 |

按钮的取值/写法抄的是宿主自己的 `ConversationRoot` 样式（`headerUtilities` 是
`flex + gap:8px`；行内小按钮＝透明底 + `--dsw-radius-md` + hover
`--dsw-alias-interactive-bg-hover`），颜色全部用 `--dsw-*` 主题 token，
`<style>` 作为组件子元素渲染（组件卸载即消失），**不往 `document.head/body` 写东西**。
**不 require 任何 `@deepseek-ai/*` 包**，只 `require('react')`；文案走 `ctx.get('locale')`
（可选 Service，注册 `dsh-web-session-id` 命名空间的中英字典，注册失败就退回内置文案），
语言切换靠 `locale.subscribe` 触发重渲染。

## 关掉这个按钮（两种）

1. **设置 → 通用 → 「会话 ID 按钮」**：关掉后按钮立即消失（存在浏览器 `localStorage`，
   键 `dsh-web-session-id:hidden`，只影响这个浏览器）。
2. **设置 → 插件**里禁用 `dsh-web-session-id` 这一行：整个 bundle 都不再注入（全局、彻底）。

## 验收

- 语法：`node --check client.js index.js`（浏览器半边是纯 JS，无 JSX/TS）。
- 清单：`package.json` 的 `dsh.client` + `exports["./client"]`；`cordis.patch.yml` 插入一行。
- 安装门：`plugin_manager install_bundle` 返回 `application: applied`、`warnings: []`。
- 活的槽位占用：刷新页面后
  `cordis_inspect_query(platform=client, provider=Slots, method=listSubTree, input={root:"conversation.session.header.utilities"})`
  的 occupants 里应出现 `session-id`（同排还有 `open-in-app` / `session-log-download` / `dsh-watcher`）。
- 视觉与复制行为：需要真人在页面上点一下（本环境没有浏览器控制，不做 DOM 仿真）。
