/**
 * dsh-qq-bot：把 QQ 私聊接到本机 dsh 会话上的插件（Host 插件，与 dsh web 同进程）。
 *
 * 职责边界：
 *   - Go 侧网关（qq-bot-sdk）负责 QQ 协议、白名单第一道门守、指令面板发布；
 *   - 本插件负责会话索引/标题、指令解析与卡片、把 QQ 消息注入会话、
 *     qq_reply 工具、每轮结束通知与「我需要回复」、提问桥、延迟发送。
 *
 * 为什么必须是同进程插件：dsh 没有本地 RPC socket，`/api` 需要浏览器 Cookie，
 * 而 acp/sdk/headless 都是另一个进程，碰不到这里活着的 Agent。
 *
 * 为什么**不 import 任何 dsh 包**：profile 里安装本地目录 bundle 是软链，
 * Node 按 realpath 解析依赖，`/home/fouc3/Projects/...` 这条链上并没有
 * `@deepseek-ai/*`（那是 dsh 安装目录与 `~/.dsh/profiles/node_modules` 提供的）。
 * 所以本 bundle 自包含：工具定义用原始 JSON Schema，用户消息本地构造。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { createState } from './lib/state.js'
import { createSocketServer } from './lib/socket.js'
import { createOutbox } from './lib/outbox.js'
import { createSessions } from './lib/sessions.js'
import { createQuestionBridge } from './lib/questions.js'
import { createRounds } from './lib/rounds.js'
import { buildReplyTool } from './lib/reply-tool.js'
import { ATTACHMENT_TOOL_NAME, buildAttachmentTool } from './lib/attachment-tool.js'
import { DEFAULT_MAX_ATTACHMENT_BYTES, DEFAULT_MAX_FETCH_BYTES, createInbox, formatBytes } from './lib/inbox.js'
import { createPermissions } from './lib/permissions.js'
import { createModels, splitOnce } from './lib/models.js'
import { createSessionStats } from './lib/session-stats.js'
import {
	QUESTION_MAX_BUTTONS,
	buildInboxCard,
	buildModelConfirmCard,
	buildModelListCard,
	buildModelProviderCard,
	buildModelSessionPromptCard,
	buildPermissionCard,
	buildInboxResult,
	buildMkdirPromptCard,
	buildNewSessionCard,
	buildRunningCard,
	buildSessionCard,
	buildShortcutCard,
	data as cardData,
	parseCallback,
} from './lib/cards.js'
import { createCommandRunner, menuItems, panelItems, parseCommand } from './lib/commands.js'
import { describeStatus, renderProgress, snapshotProgress } from './lib/progress.js'
import {
	EXCLUDED_COMMANDS,
	buildMenuItems,
	isSlashLine,
	listCommands,
	runCommand,
	splitSlashLine,
	splitModeCommand,
} from './lib/dsh-commands.js'

export const name = 'dsh-qq-bot'
export const inject = ['agents', 'sessions', 'sessionController', 'workspaceRegistry', 'tools', 'commands', 'attachments']

/**
 * 递归冻结：与 `createUserMessage` 一样，交给框架的消息必须是不可变快照。
 */
function deepFreeze(value, seen = new WeakSet()) {
	if (value === null || typeof value !== 'object' || seen.has(value)) return value
	seen.add(value)
	for (const key of Object.keys(value)) deepFreeze(value[key], seen)
	return Object.freeze(value)
}

/** 睡一会儿：只在"等某个异步状态落定"的轮询路径上用（绝不阻塞事件循环）。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

/** 链接卡片（ark）当文字处理：抽标题/描述/跳转链接，让 AI 知道用户分享的是什么。 */
function arkAsText(ark) {
	if (!ark) return ''
	const bits = []
	const kind = ark.name || ark.kind
	if (kind) bits.push(`[链接卡片·${kind}]`)
	if (ark.title) bits.push(ark.title)
	if (ark.desc) bits.push(`（${ark.desc}）`)
	if (ark.url) bits.push(ark.url)
	return bits.join(' ').trim()
}

/**
 * 构造一条 user 消息（等价于 @deepseek-ai/dsh-llm 的 createUserMessage）。
 *
 * `sections`（语音转写、附件清单）跟在正文**同一条消息**里，但各自一个 content 块、
 * 带 `## 标题`——所以转写错了也不会跟用户的原话混成一句。
 *
 * 为什么不另发一条消息：`agent.followup()` 的语义是「这条消息独占自己的一轮」，
 * 连发两条 = 第二条被挂成"待发送"等下一轮（线上踩过：正文卡在待发送里，
 * 附件清单先跑了）。要一起给模型，就必须是一条消息。
 */
function makeUserMessage(text, source, images = [], sections = []) {
	const content = []
	for (const section of sections) {
		content.push({ type: 'text', text: `## ${section.name}\n${section.text}` })
	}
	content.push({ type: 'text', text: String(text) })
	// 图片以 image 块随消息走：模型支持视觉就是真看图，不支持时由 dsh 自动降级成
	// 「图片已存到 <路径>」的占位文本（前端粘贴走的是同一条路）。
	for (const ref of images) content.push({ type: 'image', attachment: ref })
	return deepFreeze({
		id: randomUUID(),
		role: 'user',
		content,
		source,
	})
}

/**
 * 「用户本人的话」的来源标记：`{ kind: 'user' }`。
 *
 * 为什么不能标成插件自己的 kind：dsh 里有一批动作**只认人类输入**
 * （`@deepseek-ai/dsh-tool-goal` 的 `hasDirectHumanInput`：当前轮里必须有一条
 * `user/message` 且 `source.kind === 'user'`，否则 `create_goal` /
 * `update_goal edit|pause|resume` 直接拒绝："this goal operation requires a direct
 * human turn on a top-level agent"）。QQ 里打字的**就是用户本人**，插件只是那根线，
 * 所以这里如实标记为人类输入 —— 用户在 QQ 里说"继续/恢复目标"时才真的能恢复目标。
 * （dsh 自己的注释也是这么约定的：`followup()` 不带 source 就会解析成 `user`，
 * "非人类来源必须自己标明"，我们标明的是"这条确实是人类的原话"。）
 *
 * 反过来，插件自己写的话（每轮上下文注入、「我需要回复」的唤醒文本）**不**用这个标记，
 * 免得冒充用户授权。
 */
export const HUMAN_SOURCE = { kind: 'user' }

/** 插件自己写的消息（上下文注入、唤醒文本）的来源标记。 */
export const PLUGIN_SOURCE = { kind: 'dsh-qq-bot' }

function expandHome(path) {
	if (typeof path !== 'string' || !path) return path
	if (path === '~') return process.env.HOME ?? path
	if (path.startsWith('~/')) return `${process.env.HOME ?? '~'}/${path.slice(2)}`
	return path
}

export function apply(ctx, rawConfig) {
	const config = {
		replyHeader: rawConfig?.replyHeader ?? true,
		replyHeaderTemplate: rawConfig?.replyHeaderTemplate ?? '【{title}({id})】',
		noticeTemplate: rawConfig?.noticeTemplate ?? '{title}({id})已结束',
		idStyle: rawConfig?.idStyle ?? 'full',
		defaultMarkdown: rawConfig?.defaultMarkdown ?? true,
		questionTimeoutMs: rawConfig?.questionTimeoutMs ?? 600000,
		// 单张提问卡片的按钮上限（平台 5 行 × 每行 4 个）；超了就由提问桥拆成多张卡片。
		maxQuestionButtons: rawConfig?.maxQuestionButtons ?? QUESTION_MAX_BUTTONS,
		// 附件（图片/文件/视频）自动下载的单条上限；超过就只登记 url，等模型按需用工具拉。
		maxAttachmentBytes: rawConfig?.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
		// 模型主动拉取单个附件的上限（比自动下载宽松，但仍然要有边界）。
		maxFetchBytes: rawConfig?.maxFetchBytes ?? DEFAULT_MAX_FETCH_BYTES,
		replyAckTimeoutMs: rawConfig?.replyAckTimeoutMs ?? 8000,
		noticeFallbackMs: rawConfig?.noticeFallbackMs ?? 3000,
		// 投递后最多等多久"它真的开始跑"（等不到就不走 whenIdle 兜底，宁可漏报也不误报）
		runningWaitMs: rawConfig?.runningWaitMs ?? 60_000,
		runningPollMs: rawConfig?.runningPollMs ?? 500,
		// 打断"运行中的目标"之后，最多盯多久把它重新武装起来（见 rearmGoalAfterInterrupt）。
		goalRearmWaitMs: rawConfig?.goalRearmWaitMs ?? 5000,
		goalRearmPollMs: rawConfig?.goalRearmPollMs ?? 250,
		sessionPageSize: rawConfig?.sessionPageSize ?? 8,
		needReplyText: rawConfig?.needReplyText ?? '用户点了「我需要回复」。请把上一条消息对应的结果完整地回复给用户。',
		needReplyAckText: rawConfig?.needReplyAckText ?? '已触发，正在请求回复…',
		dshMenuLabel: rawConfig?.dshMenuLabel ?? 'dsh 命令',
	}
	const socketPath = expandHome(rawConfig?.socketPath ?? '~/.dsh/dsh-qq-bot/bridge.sock')
	const stateFile = expandHome(rawConfig?.stateFile ?? '~/.dsh/dsh-qq-bot/state.json')
	const token = rawConfig?.token ?? ''
	const logger = ctx.logger ?? console

	const state = createState({ file: stateFile, logger })
	const outbox = createOutbox({ logger })
	const sessions = createSessions({ ctx, logger, idStyle: config.idStyle })
	// 输入态（"输入框"）：附件先进这里，点卡片上的「发送」才交给 AI。
	const inbox = createInbox({ state, attachments: ctx.attachments, config, logger })
	// 权限预设（就是 Web 里那个 仅可查看/工作区内修改/完全权限 选择器）：可选服务。
	const permissions = createPermissions({ ctx, logger })
	// 模型目录与切换（就是 Web 里那个模型选择器）：可选服务，见 lib/models.js。
	const models = createModels({ ctx, logger })
	// 会话统计（Web 会话底部那块）：读 dsh 的四个会话投影，见 lib/session-stats.js。
	const sessionStats = createSessionStats({ ctx, logger })

	// ── 会话级序号：被动回复按 msg_id+msg_seq 去重，所以每条消息都要递增 ──────
	const seqByKey = new Map()
	function nextSeq(key) {
		const next = (seqByKey.get(key) ?? 0) + 1
		seqByKey.set(key, next)
		if (seqByKey.size > 1000) seqByKey.clear()
		return next
	}

	/**
	 * 权限卡片：把 dsh 的权限预设列成按钮（每行 2 个，放不下自动加宽），点一下就切。
	 */
	async function showPermissionCard({ openid, sessionId, replyContext = {} }) {
		const agent = await agentFor(sessionId)
		if (!agent) {
			await sendText({
				openid,
				content: `会话 \`${sessionId}\` 现在打不开，没法看权限。`,
				markdown: true,
				context: replyContext,
			})
			return null
		}
		const options = permissions.catalog()
		if (options.length === 0) {
			await sendText({
				openid,
				content: '这个部署没有权限服务（`ctx.permissionPresets`），看不了权限级别。',
				markdown: true,
				context: replyContext,
			})
			return null
		}
		const card = buildPermissionCard({
			options,
			current: permissions.current(agent.session),
			sessionId,
			label: sessions.label(sessionId),
		})
		await io.sendCard({ openid, content: card.content, keyboard: card.keyboard, context: replyContext })
		return card
	}

	/**
	 * 直接把某个会话的权限切成 tokens 指定的级别。
	 * @returns {{ok:boolean, text?:string, error?:string}|null}
	 */
	async function setPermissionForSession({ openid, sessionId, tokens }) {
		const agent = await agentFor(sessionId)
		if (!agent) return { ok: false, error: `会话 \`${sessionId}\` 现在打不开。` }
		const resolved = permissions.resolveToken(tokens)
		if (!resolved.ok) return { ok: false, error: resolved.error }
		const result = permissions.set(agent.session, resolved.value)
		if (!result.ok) return result
		return { ok: true, value: result.value, text: permissions.describe(result.value) }
	}

	/**
	 * 模型卡片第一级：提供商列表（每行 2 个，可翻页）。
	 *
	 * 作用对象是**当前绑定会话**；卡片上标出它现在用的是哪个提供商的哪个模型。
	 */
	async function showModelCard({ openid, sessionId, page = 1, replyContext = {} }) {
		const catalog = await models.catalog()
		if (!catalog.ok) {
			await sendText({ openid, content: catalog.error, markdown: true, context: replyContext })
			return null
		}
		if (catalog.groups.length === 0) {
			const hint = catalog.failures.length > 0
				? `\n\n> 读不到模型的提供商：${catalog.failures.map((item) => `\`${item.name}\``).join('、')}`
				: ''
			await sendText({
				openid,
				content: `这个部署现在没有任何**可路由**的模型（都没配好 key 或都读失败）。${hint}`,
				markdown: true,
				context: replyContext,
			})
			return null
		}
		const current = await models.current(sessionId)
		const card = buildModelProviderCard({
			groups: catalog.groups,
			failures: catalog.failures,
			current,
			label: sessions.get(sessionId) ? sessions.label(sessionId) : sessionId,
			page,
		})
		await io.sendCard({ openid, content: card.content, keyboard: card.keyboard, context: replyContext })
		return card
	}

	/**
	 * 模型卡片第二级：某个提供商的模型列表（每行 1 个，可翻页）。
	 *
	 * `chosen` 是刚切成功的那一个：卡片会写成"✅ 已切到 …"并标成当前。
	 */
	async function showModelListCard({ openid, sessionId, providerId, page = 1, chosen = null, replyContext = {} }) {
		const catalog = await models.catalog()
		if (!catalog.ok) {
			await sendText({ openid, content: catalog.error, markdown: true, context: replyContext })
			return null
		}
		const group = catalog.groups.find((item) => item.id === providerId)
		if (!group) {
			// 目录变了（提供商被禁用/读失败）：退回提供商列表，别让用户对着死卡片点。
			await sendText({ openid, content: `提供商 \`${providerId}\` 现在不可用，这是最新的列表。`, markdown: true, context: replyContext })
			return showModelCard({ openid, sessionId, replyContext })
		}
		const current = await models.current(sessionId)
		const card = buildModelListCard({
			group,
			current,
			chosen: chosen && chosen.provider === group.id ? chosen : null,
			label: sessions.get(sessionId) ? sessions.label(sessionId) : sessionId,
			page,
		})
		await io.sendCard({ openid, content: card.content, keyboard: card.keyboard, context: replyContext })
		return card
	}

	/** 从目录里找一对 {group, model}；找不到返回 null。 */
	async function lookupModel(providerId, modelId) {
		const catalog = await models.catalog()
		if (!catalog.ok) return { error: catalog.error }
		const group = catalog.groups.find((item) => item.id === providerId)
		if (!group) return { error: `提供商 \`${providerId}\` 现在不可用（发 \`模型\` 看最新列表）。` }
		const model = group.models.find((item) => item.id === modelId)
		if (!model) return { error: `提供商 \`${group.name}\` 里没有 \`${modelId}\`（发 \`模型\` 重新挑）。` }
		return { group, model }
	}

	/**
	 * 模型卡片第三级：确认卡片（用户要求"选完模型先确认：应用到当前会话 / 切其他会话 / 返回"）。
	 */
	async function showModelConfirmCard({ openid, sessionId, providerId, modelId, replyContext = {} }) {
		const found = await lookupModel(providerId, modelId)
		if (found.error) {
			await sendText({ openid, content: found.error, markdown: true, context: replyContext })
			return null
		}
		const card = buildModelConfirmCard({
			group: found.group,
			model: found.model,
			label: sessions.get(sessionId) ? sessions.label(sessionId) : sessionId,
		})
		await io.sendCard({ openid, content: card.content, keyboard: card.keyboard, context: replyContext })
		return card
	}

	/**
	 * 「切到其他会话」：进"等会话id"状态并发一张提示卡片（自带「取消」）。
	 *
	 * 用户明确要求这里是**交互式**的（而不是"把命令填进输入框"）：
	 * 下一条消息写出会话id，就切给那个会话。
	 */
	async function beginModelSessionPrompt({ openid, providerId, modelId, replyContext = {} }) {
		const found = await lookupModel(providerId, modelId)
		if (found.error) {
			await sendText({ openid, content: found.error, markdown: true, context: replyContext })
			return null
		}
		state.setPendingModel(openid, {
			provider: found.group.id,
			model: found.model.id,
			at: new Date().toISOString(),
		})
		state.flush()
		const boundId = sessionIdOfPendingTarget(openid)
		const card = buildModelSessionPromptCard({
			group: found.group,
			model: found.model,
			label: boundId ? sessions.label(boundId) : '',
		})
		await io.sendCard({ openid, content: card.content, keyboard: card.keyboard, context: replyContext })
		return card
	}

	/** 等会话id时那张提示卡片上「会话：」显示的就是当前绑定会话（没绑定则留空）。 */
	function sessionIdOfPendingTarget(openid) {
		const bound = state.bindingOf(openid)
		return bound && bound !== 'none' && sessions.get(bound) ? bound : ''
	}


	/**
	 * 把某个会话的模型切成 spec（`提供商/模型名字`）指定的那一档。
	 * @returns {Promise<{ok:boolean, text?:string, error?:string}|null>}
	 */
	async function setModelForSession({ openid, sessionId, spec }) {
		const catalog = await models.catalog()
		if (!catalog.ok) return { ok: false, error: catalog.error }
		const resolved = models.resolveToken(spec, catalog.groups)
		if (!resolved.ok) return { ok: false, error: resolved.error }
		const result = await models.set(sessionId, { provider: resolved.group.id, model: resolved.model.id })
		if (!result.ok) return result
		return { ok: true, value: `${resolved.group.id}/${resolved.model.id}`, text: models.describe(resolved.group, resolved.model) }
	}	/**
	 * 这个会话归哪个 QQ 私聊。
	 *
	 * 先看当前绑定；没有绑定就回退到"最近一次从 QQ 跟它说过话的人"——
	 * `发送 <会话id> <内容>` / 输入态能往**非绑定会话**投递，那种会话也必须能回 QQ
	 * （线上踩过：显式指定的会话回话时报"该会话当前没有绑定 QQ 私聊"）。
	 */
	function openidForSession(sessionId) {
		for (const [openid, bound] of Object.entries(state.get().bindings)) {
			if (bound === sessionId) return openid
		}
		return state.sessionOwnerOf(sessionId)
	}

	function isWhitelisted(openid) {
		return state.whitelist().includes(openid)
	}

	/**
	 * 挑一个"代表 agent"来枚举 dsh 命令（命令是按 agent 作用域的）。
	 * 优先被 QQ 绑定的活会话，其次任意活会话，都没有就返回 null。
	 */
	function representativeAgent() {
		const live = ctx.agents.list?.() ?? []
		for (const agent of live) {
			if (openidForSession(agent.id)) return agent
		}
		return live[0] ?? null
	}

	/**
	 * 拿"会话控制器"的候选句柄（按顺序找可用的恢复入口）。
	 *
	 * 正常部署里 `ctx.sessionController`（插件 `inject` 注入的实例）与
	 * `ctx.get('sessionController')` 是同一个对象；但**暴露面**可能不同（有的宿主只给契约面，
	 * 或者 `ctx.get` 拿到的是 `ctx.remote.session` 那种代理），所以两个都留着。
	 */
	function sessionControllers() {
		const found = []
		const push = (label, value) => {
			if (value === undefined || value === null || typeof value !== 'object') return
			if (found.some((item) => item.value === value)) return
			found.push({ label, value })
		}
		try {
			push('ctx.sessionController', ctx.sessionController)
		} catch {
			// 这个部署没注入该服务
		}
		try {
			push("ctx.get('sessionController')", ctx.get?.('sessionController'))
		} catch {
			// 这个部署没有该服务
		}
		return found
	}

	/** 报错文本（状态小日志/日志用；别把 `[object Object]` 写进去）。 */
	function describeError(error) {
		if (error === undefined || error === null) return '未知原因'
		return String(error.message ?? error)
	}

	/**
	 * 拉一个活 agent：先查在册，冷会话交给 dsh 的会话控制器恢复（恢复不了返回 null）。
	 *
	 * **冷会话的恢复入口只有契约里的 `resolveAgent` 值得信**（线上事故 2026-10-15 / 10-16）：
	 * dsh 恢复冷会话时会带上 `agentOptions`（模型选择）与 `setup`（预设组合，工具从这里来），
	 * 它内部的实现就是 `ApiSessionAgentController.resume`：
	 *   `this.ctx.agents.resume({ resumeSessionId, agentOptions: this.agentOptions(), setup: composition.setup })`
	 * 而**公开契约里根本没有 `resume` 这个方法** —— `@deepseek-ai/dsh-api-session-controller`
	 * 注册的 `sessionController` 服务面（也就是 `ctx.remote.session` 那套）只有
	 * `resolveAgent` / `inspect` / `selectModel` / `prompt` / `list` / `page` / `projections` / …
	 * （`resume` 是内部的 `ApiSessionAgentController` 的方法，没挂到服务上）。所以：
	 *
	 *   ① `sessionController.resolveAgent(sessionId)` ← **唯一正确的冷会话唤醒入口**
	 *      （返回 `{ agent }` 或 `{ error }`）。dsh Web 端自己唤醒冷会话也走它。
	 *   ② 某些嵌入方式会把内部控制器的 `resume` 直接暴露出来；也带模型与预设，安全的。
	 *   ③ **绝不再裸 `ctx.agents.resume({ resumeSessionId })`**：它没有 `agentOptions`/`setup`，
	 *      造出的 agent **没有模型、没有预设工具**：
	 *        - `agent.options.model` 为空 → 系统提示词里 `{{model}}` 取不到值 → 本轮直接
	 *          `prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`；
	 *        - 预设没组合 → **编码工具全没**（bash/Edit/Read…）；
	 *        - 更糟：这个坏 agent 会被 dsh 当成**活 agent 缓存住**，之后每条消息都继续失败。
	 *      宁可这一条消息如实失败（调用方回一句"会话打不开"），也不要造一个坏 agent。
	 *
	 * 为什么以前一直踩：旧代码判的是 `typeof controller.resume === 'function'` —— 契约里没有它，
	 * 这个判断**永远为假**，于是**每一条** QQ 冷唤醒都掉进 ③ 的兜底（症状就是"只有 QQ 拉起的
	 * 冷会话中招，手工在 Web 里切一次模型就'好了'"：Web 端恢复走 `resolveAgent`/`selectModel`）。
	 */
	async function agentFor(sessionId) {
		const live = ctx.agents.get(sessionId)
		if (live) return live
		const controllers = sessionControllers()
		// 取会话id **尾部** 8 位（`…-7f92ee43`）：全库小日志都用这个口径；以前写成
		// `slice(0, 8)` ⇒ 每行都只剩 `session-`（前缀把 id 吃光了，多会话时没法归因）。
		const short = String(sessionId).slice(-8)

		// ① 契约入口：resolveAgent（带上模型与预设；就是 dsh 自己恢复冷会话那条路）。
		for (const { label, value } of controllers) {
			if (typeof value.resolveAgent !== 'function') continue
			try {
				const found = await value.resolveAgent(sessionId)
				const agent = found?.agent ?? null
				if (agent) {
					state.note(`冷会话恢复：resolveAgent ✓ ${short}（${label}）`)
					return agent
				}
				state.note(`冷会话恢复：resolveAgent 没给出 agent ${short}（${label}）:: ${describeError(found?.error)}`)
				logger.warn?.('会话控制器没给出 agent', { sessionId, via: label, error: describeError(found?.error) })
				return null
			} catch (error) {
				state.note(`冷会话恢复失败（不回退裸恢复）：${short}（${label}） :: ${describeError(error)}`)
				logger.warn?.('会话控制器恢复失败（不回退裸恢复）', { sessionId, via: label, error: describeError(error) })
				return null
			}
		}

		// ② 某些嵌入方式把内部控制器的 resume 暴露出来了：同样带模型与预设，安全的。
		for (const { label, value } of controllers) {
			if (typeof value.resume !== 'function') continue
			try {
				const agent = await value.resume(sessionId)
				if (agent) {
					state.note(`冷会话恢复：resume ✓ ${short}（${label}）`)
					return agent
				}
			} catch (error) {
				state.note(`冷会话恢复失败（不回退裸恢复）：${short}（${label}） :: ${describeError(error)}`)
				logger.warn?.('会话控制器恢复失败（不回退裸恢复）', { sessionId, via: label, error: describeError(error) })
				return null
			}
			return null
		}

		// ③ 没有任何控制器恢复入口：**绝不裸恢复** —— 裸恢复救不了这一条消息，反而会把这个会话毒死。
		state.note(
			`冷会话没有可用的恢复入口（不裸恢复）：${short}（候选：${controllers.map((item) => item.label).join(' / ') || '无'}）`,
		)
		logger.warn?.('这个部署没有会话控制器恢复入口，冷会话唤不醒', { sessionId })
		return null
	}

	// ── 对 QQ 的发送封装（全部走出站队列） ───────────────────────────────────
	async function waitAck(acked) {
		const timeoutMs = Math.max(500, Number(config.replyAckTimeoutMs) || 8000)
		let timer = null
		const timeout = new Promise((resolve) => {
			timer = setTimeout(() => resolve({ ok: false, error: '等待送达确认超时' }), timeoutMs)
			if (typeof timer.unref === 'function') timer.unref()
		})
		try {
			return await Promise.race([acked, timeout])
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	async function sendText({ openid, content, markdown = false, keyboard = null, context = {}, expectMessageId = false }) {
		const args = {
			openid,
			markdown,
			content,
			replyToMsgId: context.msgId ?? '',
			replyToEventId: context.eventId ?? '',
			msgSeq: nextSeq(`s:${openid}`),
		}
		// 键盘必须挂在 markdown 消息上；Go 侧还会再兜一次（带键盘强制 markdown）。
		if (keyboard) args.keyboard = keyboard
		const { acked } = outbox.enqueue('send_c2c', args, { expectAck: expectMessageId })
		if (!expectMessageId) return null
		const result = await waitAck(acked)
		return result.ok ? (result.messageId ?? null) : null
	}

	async function sendCard({ openid, content, keyboard, context = {} }) {
		return sendText({ openid, content, markdown: true, keyboard, context, expectMessageId: true })
	}

	async function recallCard(openid, messageId) {
		if (!openid || !messageId) return
		outbox.enqueue('recall_c2c', { openid, messageId })
		if (state.lastCardOf(openid) === messageId) state.setLastCard(openid, null)
	}

	/** 撤回上一张卡片（失败只记日志，绝不阻塞后续发送）。 */
	async function recallPreviousCard(openid) {
		const previous = state.lastCardOf(openid)
		if (!previous) return
		await recallCard(openid, previous)
	}

	const io = {
		recallCard,
		// keepPrevious：一次提问可能拆成多张卡片，由调用方按下标自己撤回，
		// 不能让发第二张的时候顺手把第一张撤掉。
		sendCard: async ({ openid, content, keyboard, context, keepPrevious = false }) => {
			if (!keepPrevious) await recallPreviousCard(openid)
			const messageId = await sendCard({ openid, content, keyboard, context })
			state.setLastCard(openid, messageId)
			return messageId
		},
		// 降级兜底用：纯文本告诉用户"这次提问没发到 QQ"，别无声无息。
		notify: async ({ openid, content, context }) => {
			await sendText({ openid, content, markdown: true, context })
		},
	}

	// ── 会话选择卡片 / 新建会话选目录卡片 ───────────────────────────────────
	async function showSessionCard({ openid, dir, page = 1, replyContext = {} }) {
		const bound = state.bindingOf(openid)
		const boundCwd = bound && bound !== 'none' ? sessions.get(bound)?.cwd : null
		const start = dir || boundCwd || sessions.defaultRoot()
		const card = buildSessionCard({
			dir: start,
			dirs: sessions.listDirs(start),
			sessions: sessions.sessionsInDir(start),
			currentLabel: bound && bound !== 'none' ? sessions.label(bound) : null,
			page,
			pageSize: Number(config.sessionPageSize) || 8,
			// 「返回上级」由卡片自己并进导航行：另起一行会突破平台 5 行上限，
			// 整条消息被 40034029 拒收（线上踩过）。
			parentPath: sessions.parentOf(start),
			switchCommand: (sessionId) => (sessionId === 'none' ? '切换会话 none' : `切换会话 ${sessionId}`),
		})
		await io.sendCard({ openid, content: card.content, keyboard: card.keyboard, context: replyContext })
		logger.info?.('已发会话选择卡片', { dir: start, sessions: sessions.sessionsInDir(start).length })
	}

	/**
	 * 快捷卡片：一条一个回调按钮（点一下**直接切过去**），末行是「加当前会话」。
	 *
	 * 和会话选择卡片的关键区别：那张卡片的会话按钮是**指令按钮**（只把命令填进输入框），
	 * 这张是**回调按钮**（当场切）——"快捷"要的就是少点两下，再让用户自己发一次就白快捷了。
	 */
	async function showShortcutCard({ openid, replyContext = {} }) {
		const bound = state.bindingOf(openid)
		const items = state.shortcutsOf(openid).map((item) => ({
			id: item.id,
			// 按钮 label 只放标题：会话id 会把 label 吃掉一半宽度（`#2 K-Vault-Next` 才是能认的）
			label: String(item.name ?? '').trim() || sessions.titleOf(item.sessionId) || sessions.displayId(item.sessionId),
			current: item.sessionId === bound,
		}))
		const card = buildShortcutCard({
			items,
			currentLabel: bound && bound !== 'none' ? sessions.label(bound) : '',
		})
		await io.sendCard({ openid, content: card.content, keyboard: card.keyboard, context: replyContext })
		logger.info?.('已发快捷卡片', { count: items.length })
	}

	/**
	 * 「运行中会话」卡片：列出**正在跑**的会话（每条带"第 N 轮 / 已跑多久"），
	 * 点按钮**直接切过去**（回调按钮，不用再按发送）。
	 *
	 * 用户要求（2026-10-16）：新增这个命令；并在「切换会话」卡片的「返回上级」与
	 * 「不指定会话」之间也放一个入口按钮。`running` 取的是**会话级**状态
	 * （`api-session/status` 事件维护），不是"有没有活 agent"。
	 */
	async function showRunningCard({ openid, page = 1, replyContext = {} }) {
		const bound = state.bindingOf(openid)
		const items = sessions.runningSessions().map((session) => {
			const agent = ctx.agents.get(session.sessionId)
			const snapshot = agent ? snapshotProgress(agent) : null
			return {
				sessionId: session.sessionId,
				label: session.label,
				status: snapshot ? describeStatus(snapshot) : '',
				current: session.sessionId === bound,
			}
		})
		const card = buildRunningCard({
			items,
			currentLabel: bound && bound !== 'none' ? sessions.label(bound) : '',
			page,
		})
		await io.sendCard({ openid, content: card.content, keyboard: card.keyboard, context: replyContext })
		logger.info?.('已发运行中会话卡片', { count: items.length, page })
	}

	/**
	 * 目录是不是**彻底空的**（没有任何文件/子目录/隐藏文件）。
	 *
	 * 只有空目录才给「删除目录」按钮：`rmdir` 本来也只删空目录，
	 * 而且能顺手挡住"以为删的是空壳、其实里面还有东西"的误操作。
	 */
	function isDirEmpty(dir) {
		try {
			return readdirSync(dir).length === 0
		} catch (error) {
			logger.warn?.('读取目录失败，按"非空"处理（不给删除按钮）', { dir, error: String(error) })
			return false
		}
	}

	/** 路径是不是一个真实存在的目录。 */
	function isDirectory(path) {
		try {
			return statSync(path).isDirectory()
		} catch {
			return false
		}
	}

	/**
	 * 新建会话的"选目录"卡片（逐层进入，最后点「在这里新建」）。
	 *
	 * `confirming=true` 时渲染第二步：删除目录的二次确认（确认/取消）。
	 */
	async function showNewSessionCard({ openid, dir, page = 1, replyContext = {}, confirming = false }) {
		const bound = state.bindingOf(openid)
		const boundCwd = bound && bound !== 'none' ? sessions.get(bound)?.cwd : null
		const start = dir || boundCwd || sessions.defaultRoot()
		const card = buildNewSessionCard({
			dir: start,
			dirs: sessions.listDirs(start),
			page,
			pageSize: Number(config.sessionPageSize) || 8,
			parentPath: sessions.parentOf(start),
			empty: isDirEmpty(start),
			confirming,
		})
		await io.sendCard({ openid, content: card.content, keyboard: card.keyboard, context: replyContext })
		logger.info?.('已发新建会话选目录卡片', { dir: start, confirming })
	}

	/**
	 * 在指定目录下建一个子目录（目录名只允许一层，不给路径分隔符）。
	 * @returns {{ok:boolean, path?:string, error?:string}}
	 */
	function createSubDirectory({ parent, name }) {
		const raw = String(name ?? '').trim()
		if (!raw) return { ok: false, error: '目录名不能为空。' }
		if (/[\\/\0]/.test(raw) || raw === '.' || raw === '..') {
			return { ok: false, error: '目录名只能是一层名字，不能带 `/`、`\\` 或 `..`。' }
		}
		const path = join(parent, raw)
		try {
			mkdirSync(path) // 不带 recursive：父目录不存在/已存在都如实报错
		} catch (error) {
			if (error?.code === 'EEXIST') return { ok: false, error: `\`${path}\` 已经存在了。` }
			return { ok: false, error: `新建目录失败：${String(error?.message ?? error)}` }
		}
		return { ok: true, path }
	}

	/** 删掉一个空目录（二次确认后才调用）。 */
	function removeEmptyDir(dir) {
		const path = String(dir ?? '').trim()
		if (!path || path === '/' || path === (process.env.HOME ?? '\u0000')) {
			return { ok: false, error: '这个路径不允许删除。' }
		}
		try {
			rmdirSync(path) // 只删空目录：非空会 ENOTEMPTY，正好是我们要的护栏
		} catch (error) {
			if (error?.code === 'ENOTEMPTY') return { ok: false, error: `\`${path}\` 不是空目录（里面有文件或子目录），不删。` }
			if (error?.code === 'ENOENT') return { ok: false, error: `\`${path}\` 已经不在了。` }
			return { ok: false, error: `删除目录失败：${String(error?.message ?? error)}` }
		}
		return { ok: true, removed: path, parent: sessions.parentOf(path) ?? null, name: basename(path) }
	}

	// ── 工作区注册（让 dsh Web 端也看得到 QQ 建出来的目录+会话） ──────────────
	/**
	 * dsh Web 的侧栏是按**工作区**分组的，而工作区是注册表里的一条记录：
	 * 只 `sessionController.create({cwd})` 而不建工作区，Web 端就**整个文件夹都看不见**
	 * （线上踩过：QQ 里新建的 `openfield-file-sdk` 目录+会话在浏览器里完全找不到）。
	 *
	 * 这里对齐 dsh 自己的创建流程（`dsh-api-session-controller`）：
	 * `workspaceRegistry.create(path)` → `workspace.attachSession(sessionId)`。
	 */
	const ensuredWorkspaces = new Set()
	/**
	 * 注册工作区（+ 把会话挂上去）。幂等；`force` 时跳过缓存再试一次。
	 * @param {{path:string, sessionId?:string, title?:string, force?:boolean}} input
	 */
	async function ensureWorkspaceFor({ path, sessionId, title, force = false }) {
		const dir = String(path ?? '').trim()
		if (!dir) return { ok: false, error: '目录不能为空。' }
		if (typeof ctx.workspaceRegistry?.create !== 'function') return { ok: false, error: '当前 dsh 没有工作区注册表。' }
		const key = `${dir}|${sessionId ?? ''}`
		if (!force && ensuredWorkspaces.has(key)) return { ok: true, cached: true, path: dir }
		try {
			const workspace = await ctx.workspaceRegistry.create(dir, title || basename(dir))
			if (sessionId && typeof workspace?.attachSession === 'function') await workspace.attachSession(sessionId)
			ensuredWorkspaces.add(key)
			logger.info?.('已把目录注册为工作区（Web 端可见）', { path: dir, sessionId })
			return { ok: true, path: dir, sessionId: sessionId ?? '', workspaceId: workspace?.id ?? '' }
		} catch (error) {
			// 不进缓存：下次还有机会补上（比如目录刚被删又重建）
			logger.warn?.('注册工作区失败', { path: dir, sessionId, error: String(error) })
			return { ok: false, path: dir, error: String(error?.message ?? error) }
		}
	}

	/**
	 * 补登记"本桥碰过的目录/会话"的工作区。
	 *
	 * 为什么只补这些、而不是所有会话：Web 侧栏只显示**注册过的工作区**，
	 * 但把用户已有的几百个会话 cwd 全注册一遍会把侧栏塞满。
	 * 所以名单限定为"本桥自己造的/跑过轮次的"：
	 *   - `createdSessions` / `createdDirs`：本桥建出来的会话与目录；
	 *   - 当前绑定会话；
	 *   - `notices` 的 key（`sessionId:turn`）：本桥跑过并通知过的会话
	 *     —— 这条能捞回"修复上线之前"建的会话（比如 openfield-file-sdk）；
	 *   - 输入态 / 延迟发送里提到的会话。
	 */
	async function repairWorkspaces() {
		const targets = new Map() // sessionId -> cwd
		const dirs = new Set()
		const addSession = (sessionId) => {
			const id = String(sessionId ?? '')
			if (!id || id === 'none' || targets.has(id)) return
			const cwd = sessions.get(id)?.cwd
			if (cwd) targets.set(id, cwd)
		}
		const snapshot = state.get() ?? {}
		for (const sessionId of Object.values(snapshot.bindings ?? {})) addSession(sessionId)
		for (const [sessionId, cwd] of Object.entries(state.createdSessions() ?? {})) {
			addSession(sessionId)
			if (cwd && !targets.has(sessionId)) targets.set(sessionId, cwd)
		}
		for (const key of Object.keys(snapshot.notices ?? {})) addSession(key.slice(0, key.lastIndexOf(':')))
		for (const entry of Object.values(snapshot.inbox ?? {})) addSession(entry?.sessionId)
		for (const sessionId of Object.keys(snapshot.delayed ?? {})) addSession(sessionId)
		for (const dir of state.createdDirs() ?? []) dirs.add(dir)

		for (const [sessionId, cwd] of targets) await ensureWorkspaceFor({ path: cwd, sessionId })
		for (const dir of dirs) await ensureWorkspaceFor({ path: dir })
		if (targets.size > 0 || dirs.size > 0) logger.info?.('补登记工作区完成', { sessions: targets.size, dirs: dirs.size })
	}

	/**
	 * 会话是不是在 plan 模式。
	 *
	 * 用可选访问 `ctx.get('planMode')`（不写进 inject）：
	 * 没有 plan 服务的 profile 里插件照样要能激活。
	 */
	function isPlanModeActive(agent) {
		try {
			const controller = ctx.get?.('planMode')
			return Boolean(controller?.get?.(agent)?.active)
		} catch {
			return false
		}
	}

	/**
	 * 在指定目录新建会话，并默认切换过去。
	 * 目录必须是真实存在的目录（防止打错路径建出一堆垃圾会话）。
	 */
	async function createSessionHere({ openid, cwd }) {
		const raw = String(cwd ?? '').trim()
		if (!raw) return { ok: false, error: '目录不能为空。' }
		const path = expandHome(raw)
		// 只允许在**已存在**的目录里新建：打错一个字符就建出一堆垃圾会话很难收。
		let isDir = false
		try {
			isDir = statSync(path).isDirectory()
		} catch {
			return { ok: false, error: `\`${path}\` 打不开（不存在或没权限）。` }
		}
		if (!isDir) return { ok: false, error: `\`${path}\` 不是目录。` }
		try {
			const created = await ctx.sessionController.create({ cwd: path })
			const sessionId = created?.sessionId
			if (!sessionId) return { ok: false, error: '创建会话没有返回 id。' }
			await sessions.refresh()
			// 先建工作区再绑定：不然 Web 侧栏里不会有这个文件夹。
			await ensureWorkspaceFor({ path, sessionId })
			// 留个记录：以后启动时按这份名单补登记（万一这次注册失败/当时没注册上）。
			state.markCreatedSession(sessionId, path)
			state.flush()
			state.setBinding(openid, sessionId)
			state.setLastCard(openid, null)
			logger.info?.('已新建并切换会话', { cwd: path, sessionId })
			return { ok: true, cwd: path, sessionId, label: sessions.label(sessionId), hint: '直接发消息就能开始用。' }
		} catch (error) {
			logger.warn?.('新建会话失败', { cwd: path, error: String(error) })
			return { ok: false, error: `在 \`${path}\` 新建会话失败：${String(error?.message ?? error)}` }
		}
	}

	// ── 消息投递（打断 + 用户级上下文注入 + 唤醒） ───────────────────────────
	async function deliver({
		sessionId,
		openid,
		text,
		interrupt = true,
		origin = 'qq',
		context = {},
		images = [],
		sections = [],
		// `发送`/`快捷 <目标> <消息>`/「我需要回复」自己的回执里已经写了"会打断它正在跑的轮次"/
		// "正在请求回复…" → 被打断卡不再并"已按这条消息开了新一轮"，也不再另发开始卡
		// （用户要求：已经有提示的不重复，防止刷屏）。
		interruptHinted = false,
		startHinted = false,
	}) {
		// 记下"谁在跟这个会话说话"：非绑定会话（`发送 <会话id> …` / 输入态）也要能回 QQ。
		if (openid) state.rememberSessionOwner(sessionId, openid)
		const agent = await agentFor(sessionId)
		if (!agent) {
			await sendText({
				openid,
				content: `会话 \`${sessionId}\` 现在打不开（可能已删除）。发 \`切换会话\` 重新选择。`,
				markdown: true,
				context,
			})
			return { ok: false }
		}
		// 打断之前先记下"目标"的状态：**只有运行中（active + armed）的目标**在打断后才需要恢复
		// （见 rearmGoalAfterInterrupt 的注释）。没有目标 / 已暂停都不动。
		const goalBefore = interrupt && agent.status === 'running' ? runningGoal(agent) : null
		if (interrupt && agent.status === 'running') {
			logger.info?.('会话正在运行，先打断', { sessionId, goal: goalBefore ? `${goalBefore.id}@${goalBefore.revision}` : '无' })
			agent.cancel({ kind: 'user' }, { keepInbox: false })
		}
		ensureAgentSetup(agent, sessionId)
		// 被打断时把「这条消息」当作打断来源：通知里会带一行「> 打断来自：…」。
		const round = rounds.beginRound({
			sessionId,
			openid,
			origin,
			context,
			interruptSource: interrupt ? text : '',
			interruptHinted,
			startHinted,
		})
		round.pendingContext = rounds.roundContextText(round)
		// plan 模式下补一句：计划正文也要发到 QQ（否则坐在这边只看得见"已结束"）。
		if (isPlanModeActive(agent)) {
			round.pendingContext +=
				'\n本会话处于 **plan 模式**：提交计划（`exit_plan_mode`）时请**同时用 `qq_reply` 把计划正文发一份到 QQ**——审批仍在 dsh 界面，QQ 端只做"看得到"。'
		}
		// 附件清单/语音转写与正文**同一条消息**（各自一个块）：
		// followup 的语义是"独占一轮"，分两条发会让正文卡在待发送里（踩过）。
		// source：这是**用户本人在 QQ 里打的字**，标成人类输入（见 HUMAN_SOURCE 的说明），
		// 这样 dsh 里那些"只认人类直接输入"的动作（例如 create_goal / update_goal resume）
		// 在 QQ 触发的轮次里也能用。
		agent.followup(makeUserMessage(text, HUMAN_SOURCE, images, sections))
		// 兜底收尾：事件路径（session/event 的 turn/end）在某些情况下收不到，
		// 就用 Agent 的一等 API whenIdle + 会话日志里的 reason 收尾（见 rounds.watchIdle）。
		rounds.watchIdle(agent, sessionId)
		// 恢复被我这次打断的目标（不 await：投递不该被它拖住）。
		if (goalBefore) void rearmGoalAfterInterrupt(agent, goalBefore)
		return { ok: true }
	}

	// ── 目标（goal）：打断会把它"失能"，这里负责按用户要求恢复运行中的那个 ──────
	/**
	 * 读目标的**只读视图**（`ctx.goals.get(agent)`；没有 goal 服务或没有目标就返回 null）。
	 * 不吞异常：读不到只记日志，绝不影响投递。
	 */
	function goalViewOf(agent) {
		try {
			const goals = ctx.get?.('goals') ?? null
			if (!goals || typeof goals.get !== 'function') return null
			return goals.get(agent) ?? null
		} catch (error) {
			logger.debug?.('读取目标失败（忽略）', { sessionId: agent?.id, error: String(error) })
			return null
		}
	}

	/**
	 * 「运行中的目标」＝ `phase === 'active' && activation === 'armed'`（会自己续跑的才算运行中）。
	 *
	 * 用户要求（2026-10-16）：**只有打断前处于运行中的目标才恢复**；打断前没有目标、
	 * 或者目标处于暂停（`paused`/`blocked`/`complete`，以及 active 但已经 `disarmed` 的）
	 * 都**不做任何操作** —— 免得把用户自己停下的目标又给启动起来。
	 */
	function runningGoal(agent) {
		const view = goalViewOf(agent)
		if (!view || view.phase !== 'active' || view.activation !== 'armed') return null
		return { id: view.id, revision: view.revision }
	}

	/**
	 * 打断之后把那个"运行中的目标"重新武装起来。
	 *
	 * 为什么需要：`dsh-goal-round-driver` 收到 `turn/end reason.kind === 'aborted'` 时，如果被取消的
	 * 不是目标自己的那一轮（我们打断的就是这种情况），它会直接 `ctx.goals.disarm(agent)` ——
	 * **失能但 phase 仍是 active**，于是"结束后不会被唤起"，自动续跑永久停住（线上事故：
	 * K-Vault 会话一轮被 QQ 消息打断后 `roundsStarted: 0`、目标一直躺着，只能人工 `/goal resume`）。
	 * 如果被取消的恰好是目标自己的那一轮，驱动那边走的是 `ctx.goals.pause()`（phase 变 paused）。
	 *
	 * 时序：disarm/pause 发生在 **aborted 的 turn/end 处理器里**（异步，可能晚于本函数），
	 * 所以这里**轮询**：每次重新读一遍当前目标，用**当前 revision** 调 `resume()`（revision 会变，
	 * 不能用打断前那个旧 ref）；只在"同一目标 + 仍是 active 或 paused"时恢复，
	 * 恢复后又观察到它稳住在 armed 就收手。目标被换掉/完成/阻塞/到轮次上限都立刻放弃。
	 */
	async function rearmGoalAfterInterrupt(agent, before) {
		const goals = (() => {
			try {
				return ctx.get?.('goals') ?? null
			} catch {
				return null
			}
		})()
		if (!goals || typeof goals.resume !== 'function') return
		const pollMs = Math.max(20, Number(config.goalRearmPollMs) || 250)
		const deadline = Date.now() + Math.max(pollMs, Number(config.goalRearmWaitMs) || 5000)
		let resumed = 0
		for (;;) {
			const view = goalViewOf(agent)
			if (!view || view.id !== before.id) return
			if (view.phase === 'complete' || view.phase === 'blocked') return
			if (view.activation === 'armed') {
				if (resumed > 0) return // 恢复成功并且稳住了：收手
			} else if (view.phase === 'active' || view.phase === 'paused') {
				try {
					goals.resume(agent, { id: view.id, revision: view.revision })
					resumed += 1
					// 目标id也取尾部 8 位（`goal-3a6cac77-…-2023cad69bb0` → `cad69bb0`）：
					// 以前 `slice(0, 8)` 得到的是 `goal-3a6`，只剩 3 位十六进制，区分不了目标。
					const short = String(view.id).slice(-8)
					state.note(`目标被这次打断关掉了，已重新武装：${short} rev ${view.revision}（phase=${view.phase}）`)
					logger.info?.('已重新武装被打断的目标', { sessionId: agent.id, phase: view.phase, revision: view.revision })
				} catch (error) {
					// 到轮次上限、revision 变了、agent 不再是活实例…都只是"恢复不了"：记一笔就走。
					state.note(`恢复目标失败（${String(error?.message ?? error)}），请人工 /goal resume`)
					logger.warn?.('重新武装目标失败', { sessionId: agent.id, error: String(error) })
					return
				}
			}
			if (Date.now() >= deadline) return
			await sleep(pollMs)
		}
	}

	// ── 输入态（"输入框"）：附件先入列，点卡片上的「发送」才投递 ──────────────
	/** 把当前输入态渲染成预览卡片（每次都重发，用户看到的就是"输入框"的当前样子）。 */
	async function showInboxCard({ openid, sessionId, context = {}, page = 1, mode }) {
		const entry = inbox.active(openid)
		if (!entry) return null
		const card = buildInboxCard({
			label: sessions.label(sessionId),
			sessionId,
			text: inbox.textOf(entry),
			items: entry.items,
			voice: inbox.voiceText(entry),
			page,
			pageSize: Number(config.sessionPageSize) || 8,
			mode: mode ?? entry.mode,
		})
		await io.sendCard({ openid, content: card.content, keyboard: card.keyboard, context })
		return card
	}

	/**
	 * 进入输入态（`发送` = 立即投递；`延迟发送` = 本轮正常结束后投递）。
	 *
	 * 两个命令**共用同一套面板**，区别只有投递时机；输入态本身带 `mode`。
	 * 已经有内容时**不让静默换目标**：那会把攒好的正文/附件一起丢掉。
	 */
	async function beginInput({ openid, sessionId, replyContext = {}, mode = 'send' }) {
		const delayed = mode === 'delay'
		const before = inbox.active(openid)
		const pendingItems = (before?.items ?? []).length
		const pendingText = inbox.textOf(before)
		const hasContent = Boolean(pendingText) || pendingItems > 0
		if (hasContent && before.sessionId !== sessionId) {
			await sendText({
				openid,
				content:
					`你现在有一个给 **${sessions.label(before.sessionId)}** 的输入框（正文 ${pendingText ? `${pendingText.length} 字` : '空'} + 附件 ${pendingItems} 个）。\n` +
					`> 先点那张卡片上的「发送」发出去，或点「取消」丢掉，再切到 **${sessions.label(sessionId)}** —— 直接切会把攒的内容丢掉，所以这里没给你切。`,
				markdown: true,
				context: replyContext,
			})
			await showInboxCard({ openid, sessionId: before.sessionId, context: replyContext, mode: before.mode })
			return { ok: false, reason: 'inbox-other-session' }
		}
		if (hasContent) {
			await sendText({
				openid,
				content: delayed
					? '已经有一个没发出去的输入框了：接着往里加就行，点卡片上的「延迟发送」再交出去（不想留就点「取消」）。'
					: '已经有一个没发出去的输入框了，接着往里加就行；不想留就点卡片上的「取消」。',
				markdown: true,
				context: replyContext,
			})
		}
		inbox.begin({ openid, sessionId, mode })
		await sendText({
			openid,
			content:
				`已进入 **${sessions.label(sessionId)}** 的输入态${delayed ? '（延迟投递）' : ''}。\n` +
				'> 下面发的文字会攒成正文，图片/文件/语音/视频自动入列；\n' +
				(delayed
					? '> 点卡片上的「延迟发送」= 登记为延迟投递：**不打断**这一轮，等它**正常结束**后再交给 AI。'
					: '> 点卡片上的「发送」才真正交给 AI，「删除 A1」可以单独去掉某个附件。'),
			markdown: true,
			context: replyContext,
		})
		await showInboxCard({ openid, sessionId, context: replyContext, mode })
		return { ok: true }
	}

	/** 点卡片上的「发送」：正文 + 语音转写 + 附件一起投给 AI。 */
	async function sendFromInbox({ openid, context = {} }) {
		const entry = inbox.active(openid)
		if (!entry) {
			await sendText({ openid, content: '现在不在输入态。发 `发送` 进入输入态。', markdown: true, context })
			return { ok: false, reason: 'no-input-mode' }
		}
		const blocking = inbox.blockingVoice(entry)
		if (blocking.length > 0) {
			await sendText({
				openid,
				content:
					`有 ${blocking.length} 条语音拿不到平台转写（${blocking.map((item) => item.id).join(' / ')}），` +
					'按你的要求这次发送被拦住了：先点「删除」把它们去掉，再发送。',
				markdown: true,
				context,
			})
			return { ok: false, reason: 'voice-unrecognized' }
		}
		const text = inbox.textOf(entry)
		const items = entry.items ?? []
		if (!text && items.length === 0) {
			await sendText({ openid, content: '输入框是空的：先发正文或附件。', markdown: true, context })
			return { ok: false, reason: 'empty' }
		}

		const images = []
		const voiceItems = inbox.voiceItems(entry)
		const voiceIds = new Set(voiceItems.map((item) => item.id))
		const attachmentLines = []
		for (const item of items) {
			// 语音只以文本进消息（在"语音转写"那一段里），别在这儿再说它"没下载"。
			if (voiceIds.has(item.id)) continue
			const name = item.filename || item.id
			if (item.status === 'stored' && item.image) {
				images.push(item.ref)
				attachmentLines.push(`- ${item.id} 图片 ${name}（作为图片随本条消息给出）`)
				continue
			}
			if (item.status === 'stored') {
				const host = ctx.attachments?.fileHostPath?.(item.ref) ?? ''
				attachmentLines.push(`- ${item.id} ${item.kind === 'video' ? '视频' : '文件'} ${name}：只读副本在 \`${host}\``)
				continue
			}
			attachmentLines.push(
				`- ${item.id} ${item.kind === 'video' ? '视频' : item.kind === 'voice' ? '语音' : '文件'} ${name}：没有自动下载（${item.note || '未知原因'}）` +
					`，需要内容时调用 \`${ATTACHMENT_TOOL_NAME}\`（id="${item.id}"）拉取`,
			)
		}
		const sections = []
		if (voiceItems.length > 0) {
			// 语音转写单独一段，且排在附件前面：它可能出错，优先级却最高（用户要求）。
			sections.push({
				name: '用户语音的平台转写（可能有误，别当成用户的原话）',
				text: voiceItems.map((item) => `- ${item.id}：${item.asrText}`).join('\n'),
			})
		}
		if (attachmentLines.length > 0) sections.push({ name: '用户随消息附带的附件', text: attachmentLines.join('\n') })

		const sessionId = entry.sessionId
		const label = sessions.label(sessionId)
		const delayed = entry.mode === 'delay'
		inbox.rememberDelivery({ sessionId, items })
		inbox.drain({ openid })
		const cardId = state.lastCardOf(openid)
		if (cardId) await io.recallCard(openid, cardId)
		const body = text || '（用户没有写正文：内容见上面的分节，请按语音转写/附件回应）'
		if (delayed) {
			// 延迟投递：只登记，不打断当前轮次；等这一轮**正常结束**后由 rounds 投递。
			state.setDelayed(sessionId, {
				content: body,
				openid,
				at: new Date().toISOString(),
				images,
				sections,
				itemCount: items.length,
			})
			state.flush()
			logger.info?.('输入态已登记延迟消息', { sessionId, items: items.length })
		} else {
			await deliver({ sessionId, openid, text: body, interrupt: true, origin: 'qq', context, images, sections, startHinted: true })
		}
		// 卡片撤回后留一条**最终预览**：把真正发出去的内容复述一遍（用户要求）。
		await sendText({
			openid,
			content: buildInboxResult({ label, sessionId, text, items, voice: voiceItems, mode: entry.mode }),
			markdown: true,
			context,
		})
		return { ok: true }
	}

	/** 退出输入态（卡片上的「取消」）。 */
	async function cancelInbox({ openid, context = {} }) {
		const entry = inbox.drain({ openid })
		const count = (entry?.items ?? []).length
		const cardId = state.lastCardOf(openid)
		if (cardId) await io.recallCard(openid, cardId)
		await sendText({
			openid,
			content: `已退出输入态${count ? `，丢弃了 ${count} 个附件` : ''}。普通消息照旧直接进会话。`,
			markdown: true,
			context,
		})
		return { ok: true }
	}

	// ── 轮次、提问、命令 ─────────────────────────────────────────────────────
	const rounds = createRounds({
		state,
		sessions,
		outbox,
		config,
		logger,
		// 关键判断写进状态文件的小日志（插件日志进不了 journald，线上只能这样看）。
		note: (text) => state.note(text),
		// 「我需要回复」的唤醒文本 / 每轮上下文注入：**插件自己写的话**，用插件来源，
		// 不冒充用户授权（所以这一类轮次里 goal 操作仍会被 dsh 拒绝 —— 那是对的）。
		userMessage: (text) => makeUserMessage(text, PLUGIN_SOURCE),
		contextMessage: (text) =>
			makeUserMessage(text, {
				...PLUGIN_SOURCE,
				form: 'snapshot',
				sections: [{ name: 'dsh-qq-bot', text: String(text) }],
			}),
		agentFor,
		nextSeqFor: (sessionId) => nextSeq(`session:${sessionId}`),
		// 「已结束」卡片上的「发送消息」：填 `发送 <会话id>` → 进该会话的输入态。
		sendCommand: (sessionId) => `发送 ${sessionId}`,
		// 延迟投递：**和普通发送走同一条路**（`deliver` → `followup`），区别只有 `interrupt:false`
		// （不打断）—— 而且 rounds 会先等驱动真的空闲再调这里（见 rounds.waitForIdle：
		// 在 `turn/end` 处理器里直接 followup 会被驱动收尾窗口吞掉唤醒，消息卡在「待发送」）。
		onDeliver: async ({ sessionId, openid, text, origin, images = [], sections = [] }) => {
			await deliver({ sessionId, openid, text, interrupt: false, origin: origin ?? 'delayed', context: {}, images, sections })
		},
		// plan 模式下模型提交计划：把计划正文也发到 QQ（host 的审批界面 QQ 端看不到）。
		onPlan: async ({ sessionId, plan }) => {
			const openid = openidForSession(sessionId)
			if (!openid) return
			const body = plan.length > 1800 ? `${plan.slice(0, 1800)}\n\n…（计划过长，已截断）` : plan
			await sendText({
				openid,
				content: `**计划（plan 模式提交，审批仍在 dsh 界面）**\n\n${body}`,
				markdown: true,
				context: {},
			})
		},
	})

	/**
	 * 兜底监听：插件根作用域也听一遍 `session/event`（只看本桥**正在跟踪**的会话）。
	 *
	 * 为什么需要：线上的病是"完成通知不发了、只剩被打断通知"——被打断那类是插件自己
	 * （beginRound 顶替 / markStopped）直接发的，不需要事件；而"已结束"必须拿到 dsh 的
	 * `turn/end`。agent 作用域上的监听在 agent 实例被换掉、或 dsh 的事件派发只发给
	 * "会话范围内的观察者"时就收不到了，所以再加一条根作用域的路径。
	 * 两条路都可能喂同一个事件：认领轮次 / 收尾都是幂等的，重复调用不会有副作用
	 * （`observe` 只在还没认领时认领，`finishRound` 对已结束的轮次直接返回）。
	 */
	ctx.effect(
		() =>
			ctx.on('session/event', (session, event) => {
				const sessionId = session?.id ?? session?.sessionId ?? (typeof session === 'string' ? session : '')
				if (!sessionId) return
				if (!rounds.roundOf(sessionId)) return
				rounds.observe(sessionId, event, 'root')
			}),
		'dsh-qq-bot: session/event (root)',
	)

	const questions = createQuestionBridge({ state, outbox, config, logger, io })

	const commands = createCommandRunner({
		sessions,
		state,
		logger,
		reply: ({ openid, content, markdown = true, replyContext = {} }) =>
			sendText({ openid, content, markdown, context: replyContext }),
		showSessionCard: ({ openid, replyContext }) => showSessionCard({ openid, replyContext }),
		showNewSessionCard: ({ openid, replyContext }) => showNewSessionCard({ openid, replyContext }),
		showShortcutCard: ({ openid, replyContext }) => showShortcutCard({ openid, replyContext }),
		showRunningCard: ({ openid, replyContext }) => showRunningCard({ openid, replyContext }),
		createSession: ({ openid, cwd }) => createSessionHere({ openid, cwd }),
		// 权限卡片 / 直接设定（dsh 的权限预设是 per-session 的，见 lib/permissions.js）。
		showPermissionCard: ({ openid, sessionId, replyContext }) =>
			showPermissionCard({ openid, sessionId, replyContext }),
		setPermission: ({ openid, sessionId, tokens }) => setPermissionForSession({ openid, sessionId, tokens }),
		// 模型卡片（提供商 → 模型两级）/ 直接切（见 lib/models.js）。
		showModelCard: ({ openid, sessionId, replyContext }) => showModelCard({ openid, sessionId, replyContext }),
		setModel: ({ openid, sessionId, spec }) => setModelForSession({ openid, sessionId, spec }),
		// 裸发 `发送` 进入输入态（详细设计见 lib/inbox.js 顶部注释）。
		beginInput: ({ openid, sessionId, replyContext, mode }) => beginInput({ openid, sessionId, replyContext, mode }),
		// 「状态」是**只读**的：只用 agents.get（**不 resume、不 cancel**）+ dsh 登记的会话投影
		// （模型 `model/selection`、权限 `permissions`、统计 `sessionStats`/`tokenUsage`/
		// `contextBreakdown`/`contextPressure`）；没有活 agent 也照样给模型、权限与统计，
		// 只把"跑起来"那段状态写清楚。
		progress: async ({ sessionId }) => {
			const label = sessions.get(sessionId) ? sessions.label(sessionId) : sessionId
			const agent = ctx.agents.get(sessionId)
			// 用 `effective`（选择 → 会话日志里真正用过的 → 部署默认）：很多会话从没点过模型选择器，
			// 只看 `model/selection` 会一直显示「（读不到）」（线上反馈）。仍然只读、不 resume。
			const model = await models.effective(sessionId)
			const permission = permissions.nameOf(await permissions.currentForId(sessionId))
			const stats = await sessionStats.read(sessionId)
			const snapshot = agent ? snapshotProgress(agent) : null
			return { content: renderProgress({ label, snapshot, sessionId, model, permission, stats }) }
		},
		deliver: ({ sessionId, openid, text, interrupt, interruptHinted = false, startHinted = false }) =>
			deliver({ sessionId, openid, text, interrupt, interruptHinted, startHinted, origin: 'qq', context: {} }),
		stopSession: async (sessionId) => {
			const agent = ctx.agents.get(sessionId)
			if (!agent) return { ok: false, reason: '当前没有在运行的轮次' }
			rounds.markStopped(sessionId, '用户发送了「停止」命令')
			agent.cancel({ kind: 'user' }, { keepInbox: true })
			return { ok: true }
		},
		archiveSession: async (sessionId) => {
			try {
				await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
				return { ok: true }
			} catch (error) {
				return { ok: false, reason: String(error?.message ?? error) }
			}
		},
	})

	// ── 每个"被 QQ 绑定"的 agent：注册 qq_reply 工具 + 轮次监听 ──────────────
	const attached = new Map() // sessionId -> 已经挂过的 agent 实例（实例换了要重挂）
	const agentIds = new WeakMap()
	let agentSeq = 0
	function agentTag(agent) {
		if (!agent) return '?'
		if (!agentIds.has(agent)) agentIds.set(agent, ++agentSeq)
		return `#${agentIds.get(agent)}`
	}
	function ensureAgentSetup(agent, sessionId) {
		if (!agent) return
		const previous = attached.get(sessionId)
		if (previous === agent) return
		attached.set(sessionId, agent)
		if (previous) {
			// 线上问题：以前这里只按 sessionId 记"已挂过"，agent 实例被 dsh 换掉后
			// 就不再挂新实例 —— `qq_reply`/轮次监听留在死实例上，于是**"已结束"通知
			// 永远发不出来**（只有插件侧直接发的"被打断"还会发）。
			state.note(`agent 实例换了，重挂监听：${sessionId}（${agentTag(previous)} → ${agentTag(agent)}）`)
			logger.warn?.('agent 实例已更换，重新挂载工具与轮次监听', {
				sessionId,
				from: agentTag(previous),
				to: agentTag(agent),
			})
		} else {
			state.note(`首次挂载 agent 监听：${sessionId}（${agentTag(agent)}）`)
		}
		const target = {
			sessionId,
			openid: () => openidForSession(sessionId),
			label: () => {
				const label = sessions.label(sessionId)
				// label() 形如 "标题(session-xxx)"：拆成模板要的两段
				const match = /^(.*)\((.*)\)$/.exec(label)
				return { title: match?.[1] ?? label, id: match?.[2] ?? sessionId }
			},
			context: () => rounds.currentContext(sessionId),
			nextSeq: () => rounds.nextSeq(sessionId),
		}
		try {
			agent.ctx.effect(() => {
				// 直接注册 ToolDefinition：bundle 自包含，不依赖 dsh 包里的 defineTool。
				const toolDisposer = agent.ctx.tools.register(buildReplyTool({ outbox, config, logger, target }))
				// 没自动下载的附件（过大/下载失败）：让模型按需拉一份只读副本。
				const attachDisposer = agent.ctx.tools.register(buildAttachmentTool({ inbox, logger, target }))
				const roundsDisposer = rounds.attachAgent(agent, sessionId)
				return () => {
					try {
						toolDisposer?.()
					} catch {
						// 忽略
					}
					try {
						attachDisposer?.()
					} catch {
						// 忽略
					}
					try {
						roundsDisposer?.()
					} catch {
						// 忽略
					}
				}
			}, 'dsh-qq-bot: agent scope')
			logger.debug?.('已为会话注册 qq_reply / qq_fetch_attachment 与轮次监听', { sessionId })
		} catch (error) {
			attached.delete(sessionId)
			logger.warn?.('为会话注册工具失败', { sessionId, error: String(error) })
		}
	}

	ctx.effect(() => {
		const dispose = ctx.on('agent/created', ({ agent }) => {
			try {
				sessions.seedTitle(agent.session)
			} catch {
				// 忽略标题播种失败
			}
			if (openidForSession(agent.id)) ensureAgentSetup(agent, agent.id)
		})
		// 插件热装时补一次：GUI 里可能已经有活着的、被绑定的会话
		for (const agent of ctx.agents.list?.() ?? []) {
			if (openidForSession(agent.id)) ensureAgentSetup(agent, agent.id)
		}
		return dispose
	}, 'dsh-qq-bot: agent/created')

	// ── 提问桥：抢在浏览器转发回答者之前认领 ─────────────────────────────────
	ctx.effect(
		() =>
			ctx.on(
				'user-questions/request',
				async (request, next) => {
					const agent = request?.agent
					if (!agent) return next()
					const openid = openidForSession(agent.id)
					if (!openid) return next()
					const callId = String(request.wait?.callId ?? `${agent.id}:${Date.now().toString(36)}`)
					const answers = await questions.ask({
						callId,
						questions: request.questions ?? [],
						openid,
						sessionId: agent.id,
						context: rounds.currentContext(agent.id),
						signal: request.signal,
					})
					if (!answers) return next()
					return { answers }
				},
				true,
			),
		'dsh-qq-bot: user-questions',
	)

	// ── QQ 事件分发（由 Go 侧通过 socket 送进来） ────────────────────────────
	async function onQQEvent(event) {
		const openid = event?.openid
		if (event?.kind === 'ready') {
			logger.info?.('QQ 网关已就绪')
			return
		}
		if (!openid) return
		if (!isWhitelisted(openid)) {
			// 第二道门守：Go 侧已经拦过一次，这里拦的是配置不同步/直连场景。
			logger.warn?.('丢弃非白名单来源的事件', { openid: `${openid.slice(0, 6)}…`, kind: event?.kind })
			return
		}
		if (event.kind === 'c2c_message') return onMessage(event)
		if (event.kind === 'interaction') return onInteraction(event)
	}

	/**
	 * 认不出的斜杠命令：明确回绝 + 列出这台会话真正可用的命令。
	 *
	 * 关键：**这一条不投给 AI**。slash 命令进模型没有任何意义，只会让模型对着一条不存在的
	 * 命令瞎答；顺带给出"想发以 `/` 开头的话"的出路（换全角 `／`，它就不会被当命令截走）。
	 */
	async function unknownSlashText(agent, name) {
		const available = await listCommands(ctx.commands, agent, logger)
		const lines = [`没有 \`/${name}\` 这个命令，**这一条没有发给 AI**。`]
		if (available.length > 0) {
			lines.push(`> 这个会话可用：${available.map((cmd) => `\`/${cmd.name}\``).join('、')}`)
		}
		lines.push('> 桥自己的命令是中文的：`快捷`、`发送`、`延迟发送`、`状态`、`模型`…')
		lines.push('> 真要把以 `/` 开头的话当消息发，把开头那个换成全角 `／`。')
		return lines.join('\n')
	}

	/** 没绑定会话时的斜杠命令：同样回绝，不当普通消息。 */
	function noSessionSlashText(name) {
		return [
			`当前没有绑定会话，\`/${name}\` 执行不了，**这一条没有发给 AI**。`,
			'> 先发 `切换会话` 接一个，再用 dsh 命令；桥自己的命令（`快捷`/`发送`/`状态`…）不需要会话。',
			'> 真要把以 `/` 开头的话当消息发，把开头那个换成全角 `／`。',
		].join('\n')
	}

	async function onMessage(event) {
		const openid = event.openid
		const context = { msgId: event.msgId ?? '' }

		// 1) 桥命令最优先：**即使正在等提问作答，命令也必须先执行** ——
		//    否则 `停止`/`状态` 这类命令会被提问桥当「其他」答案吃掉。
		const parsed = parseCommand(event.text)
		if (parsed) {
			// 命令也当"取消等目录名/等会话id"：不然点了「新建目录」或「切到其他会话」
			// 又反悔发命令，会有一条悬着的 pending 把后面某条无关消息吃掉。
			if (state.pendingDirOf(openid) || state.pendingModelOf(openid)) {
				state.setPendingDir(openid, null)
				state.setPendingModel(openid, null)
				state.flush()
			}
			// 引用也要交给命令：`发送 <会话id> <正文>` 带引用时，引用必须生效。
			await commands.run({ openid, replyContext: context, quote: event.quote ?? '' }, parsed)
			return
		}

		// 2) dsh 内置命令：'/xxx' 直接交给 ctx.commands.execute（不经模型），同样优先于提问捕获。
		//    **认不出就到这儿为止**：明确回一句"没有这个命令"，**绝不回落到普通消息** ——
		//    用户要求"不存在的命令不要放行给 AI"（以前 `/unknown 参数` 会被当消息投进会话，
		//    模型只好对着一条不存在的命令瞎答）。
		//    例外只有 `feedback`（EXCLUDED_COMMANDS）：它是真命令、桥不兼容，仍按普通消息处理。
		const slash = splitSlashLine(event.text)
		if (slash && !EXCLUDED_COMMANDS.has(slash.name)) {
			const bound = state.bindingOf(openid)
			const agent = bound && bound !== 'none' ? await agentFor(bound) : null
			if (agent) {
				// 拿 dsh 命令也当"取消等待"（同桥命令）。
				if (state.pendingDirOf(openid) || state.pendingModelOf(openid)) {
					state.setPendingDir(openid, null)
					state.setPendingModel(openid, null)
					state.flush()
				}
				// `/plan <文本>` 要拆开：命令切模式，文本走本桥投递（见 splitModeCommand 的注释）。
				const split = splitModeCommand(slash)
				const outcome = await runCommand(ctx.commands, agent, split.command, { logger })
				if (outcome.handled) {
					await sendText({
						openid,
						content: outcome.text || (outcome.ok ? `已执行 /${slash.name}` : `/${slash.name} 执行失败`),
						markdown: false,
						context,
					})
					if (split.message) {
						await deliver({ sessionId: bound, openid, text: split.message, interrupt: true, origin: 'qq', context })
					}
					return
				}
				await sendText({ openid, content: await unknownSlashText(agent, slash.name), markdown: true, context })
				return
			}
			// 没绑定会话 / 没有活 agent：也明确回绝（不能当成普通消息扔给模型）。
			await sendText({ openid, content: noSessionSlashText(slash.name), markdown: true, context })
			return
		}

		// 3) 有待答提问：普通文本＝该题的「其他」答案
		if (questions.hasPending(openid) && (await questions.handleText(openid, event.text))) return

		// 3b) 点了「新建目录」在等目录名：这条文字就是目录名。
		const pendingDir = state.pendingDirOf(openid)
		if (pendingDir && String(event.text ?? '').trim() && !(Array.isArray(event.attachments) && event.attachments.length > 0)) {
			state.setPendingDir(openid, null)
			state.flush()
			const result = createSubDirectory({ parent: pendingDir.parent, name: String(event.text).trim() })
			if (!result.ok) {
				// 名字不合法/已存在：保持"等名字"状态，让用户直接再发一次；
				// 想退出就点提示卡片上的「取消」。
				state.setPendingDir(openid, pendingDir)
				state.flush()
				await sendText({ openid, content: `${result.error}\n\n再发一次目录名，或点上面卡片上的「取消」。`, markdown: true, context })
				return
			}
			await sendText({
				openid,
				content: `已新建目录 \`${result.path}\`，并进去了（下面是它）。`,
				markdown: true,
				context,
			})
			// 目录也顺手注册成工作区：这样 dsh Web 侧栏里马上就能看到这个文件夹。
			state.markCreatedDir(result.path)
			state.flush()
			await ensureWorkspaceFor({ path: result.path })
			// 默认 cd 进去：直接把新目录的卡片发出来，接着点「在这里新建」就建在这里。
			await showNewSessionCard({ openid, dir: result.path, replyContext: context })
			return
		}

		// 3c) 模型卡片上点了「切到其他会话」在等会话id：这条文字就是会话id（交互式，见上）。
		//     认不出就**保持等待**并说清楚，想退出点提示卡片上的「取消」或直接发命令。
		const pendingModel = state.pendingModelOf(openid)
		if (
			pendingModel &&
			String(event.text ?? '').trim() &&
			!(Array.isArray(event.attachments) && event.attachments.length > 0)
		) {
			const raw = String(event.text).trim()
			const ref = sessions.resolveRef(raw.split(/\s+/))
			const target = !ref?.error && ref?.sessionId && ref.sessionId !== 'none' ? ref.sessionId : ''
			if (!target) {
				await sendText({
					openid,
					content: `${
						ref?.error ?? `认不出会话引用 \`${raw}\`。`
					}\n\n再发一次**会话id**（\`session-…\`），或点上面卡片上的「取消」。`,
					markdown: true,
					context,
				})
				return
			}
			state.setPendingModel(openid, null)
			state.flush()
			const result = await setModelForSession({
				openid,
				sessionId: target,
				spec: `${pendingModel.provider}/${pendingModel.model}`,
			})
			if (!result?.ok) {
				await sendText({ openid, content: result?.error ?? '切换模型失败。', markdown: true, context })
				return
			}
			// 只回执、不重发模型卡片：卡片上的"当前"是按**绑定会话**读的，
			// 切给别的会话时重发会标错（用户看的是另一个会话的当前模型）。
			await sendText({
				openid,
				content: `已把 ${sessions.describe(target)} 的模型切成 ${result.text}。`,
				markdown: true,
				context,
			})
			return
		}

		// 4) 输入态：文字攒成正文、附件自动入列，都只回一张预览卡片（**不投给 AI**）。
		//    用户明确要求：附件只能通过卡片上的「发送」交出去。
		const income = inbox.active(openid)
		const incoming = Array.isArray(event.attachments) ? event.attachments : []
		const arkText = arkAsText(event.ark)
		if (income) {
			if (incoming.length > 0) await inbox.addAttachments({ openid, attachments: incoming })
			const parts = []
			if (arkText) parts.push(arkText)
			if (event.quote) parts.push(`[引用的消息] ${event.quote}`)
			if (String(event.text ?? '').trim()) parts.push(String(event.text).trim())
			if (parts.length > 0) inbox.appendText({ openid, text: parts.join('\n\n') })
			await showInboxCard({ openid, sessionId: income.sessionId, context })
			return
		}

		// 5) 没进输入态时直接发来的附件：丢弃 + 回一句提示（用户选的「丢弃并回一句」）。
		//    链接卡片当文字处理（它不是可下载的附件），所以这里只数真正的附件。
		if (incoming.length > 0) {
			await sendText({
				openid,
				content: `这条消息带的 ${incoming.length} 个附件已丢弃：附件只能先发 \`发送\` 进入输入态，再传进来。`,
				markdown: true,
				context,
			})
		}

		// 6) 普通消息 → 当前绑定会话
		const bound = state.bindingOf(openid)
		if (!bound || bound === 'none') {
			await sendText({
				openid,
				content: '当前没有指定会话。发 `切换会话` 选择，或用 `发送 <会话id> <内容>` 单次投递。',
				markdown: true,
				context,
			})
			return
		}
		if (!sessions.get(bound)) {
			state.setBinding(openid, null)
			await sendText({ openid, content: `绑定的会话 \`${bound}\` 已不可用，已解除绑定。发 \`切换会话\` 重新选择。`, markdown: true, context })
			return
		}
		// 引用消息：把被引用的那条也带进会话，否则 AI 看不到用户在说哪一条。
		// 链接卡片（ark）当文字带进去；真正的附件在第 5 步已经丢弃并提示过了。
		const body = [arkText, event.quote ? `[引用的消息] ${event.quote}` : '', event.text]
			.map((part) => String(part ?? '').trim())
			.filter(Boolean)
			.join('\n\n')
		if (!body) return
		await deliver({ sessionId: bound, openid, text: body, interrupt: true, origin: 'qq', context })
	}

	async function onInteraction(event) {
		const openid = event.openid
		const parsed = parseCallback(event.buttonData)
		let code = 1
		if (!parsed) {
			logger.debug?.('收到未知按钮数据', { data: event.buttonData })
		} else if (parsed.kind === 'dir') {
			code = 0
			try {
				// 同一套目录浏览有两种模式：切换会话 / 新建会话选目录。
				const show = parsed.mode === 'new' ? showNewSessionCard : showSessionCard
				await show({
					openid,
					dir: parsed.path,
					page: parsed.page,
					replyContext: { eventId: event.eventId, msgId: event.msgId ?? '' },
				})
			} catch (error) {
				logger.warn?.('切换目录失败', { error: String(error) })
				code = 1
			}
		} else if (parsed.kind === 'mkdir') {
			// 「新建目录」：进入"等目录名"状态，用户下一条文字就是目录名。
			const ctxReply = { eventId: event.eventId, msgId: event.msgId ?? '' }
			if (!isDirectory(parsed.path)) {
				// 路径已经不在了（比如被外部删掉）：别把名字写到一个不存在的父目录下。
				await sendText({ openid, content: `目录 \`${parsed.path}\` 打不开，重新发 \`新建会话\` 选一次吧。`, markdown: true, context: ctxReply })
			} else {
				state.setPendingDir(openid, { parent: parsed.path, at: new Date().toISOString() })
				state.flush()
				// 提示卡片自带一个明确的「取消」（用户要求），不用去记"发命令也能取消"。
				const prompt = buildMkdirPromptCard({ dir: parsed.path })
				await io.sendCard({ openid, content: prompt.content, keyboard: prompt.keyboard, context: ctxReply })
			}
			code = 0
		} else if (parsed.kind === 'mkcancel') {
			// 「新建目录」提示卡片上的取消：清掉等名字状态，回到目录列表。
			const ctxReply = { eventId: event.eventId, msgId: event.msgId ?? '' }
			state.setPendingDir(openid, null)
			state.flush()
			await sendText({ openid, content: '已取消新建目录。', markdown: true, context: ctxReply })
			await showNewSessionCard({ openid, dir: parsed.path, replyContext: ctxReply })
			code = 0
		} else if (parsed.kind === 'model') {
			// 模型卡片：提供商翻页 / 进提供商 / 提供商内翻页 / 切某个模型 / 回提供商列表。
			// 全部作用于**当前绑定会话**（与 `权限` 一致）。
			const ctxReply = { eventId: event.eventId, msgId: event.msgId ?? '' }
			const bound = state.bindingOf(openid)
			if (!bound || bound === 'none') {
				await sendText({ openid, content: '当前没有绑定会话，先 `切换会话`。', markdown: true, context: ctxReply })
				code = 1
			} else if (parsed.action === 'page') {
				await showModelCard({ openid, sessionId: bound, page: Number(parsed.arg) || 1, replyContext: ctxReply })
				code = 0
			} else if (parsed.action === 'list') {
				await showModelCard({ openid, sessionId: bound, replyContext: ctxReply })
				code = 0
			} else if (parsed.action === 'enter') {
				await showModelListCard({ openid, sessionId: bound, providerId: parsed.arg, replyContext: ctxReply })
				code = 0
			} else if (parsed.action === 'mpage') {
				const [providerId, page] = splitOnce(parsed.arg)
				await showModelListCard({
					openid,
					sessionId: bound,
					providerId,
					page: Number(page) || 1,
					replyContext: ctxReply,
				})
				code = 0
			} else if (parsed.action === 'pick') {
				// 点模型**不立刻切**：先给确认卡片（应用到当前会话 / 切到其他会话 / 返回）。
				const [providerId, modelId] = splitOnce(parsed.arg)
				await showModelConfirmCard({ openid, sessionId: bound, providerId, modelId, replyContext: ctxReply })
				code = 0
			} else if (parsed.action === 'apply') {
				// 确认卡片上的「应用到当前会话」：切完把模型列表卡片重发一遍（标出新当前 + ✅）。
				const [providerId, modelId] = splitOnce(parsed.arg)
				const result = await setModelForSession({ openid, sessionId: bound, spec: `${providerId}/${modelId}` })
				if (!result?.ok) {
					await sendText({ openid, content: result?.error ?? '切换模型失败。', markdown: true, context: ctxReply })
					code = 1
				} else {
					await showModelListCard({
						openid,
						sessionId: bound,
						providerId,
						chosen: { provider: providerId, model: modelId },
						replyContext: ctxReply,
					})
					code = 0
				}
			} else if (parsed.action === 'other') {
				// 确认卡片上的「切到其他会话」：进"等会话id"状态（交互式，不再是填命令）。
				const [providerId, modelId] = splitOnce(parsed.arg)
				await beginModelSessionPrompt({ openid, providerId, modelId, replyContext: ctxReply })
				code = 0
			} else if (parsed.action === 'cancel') {
				// "等会话id"卡片上的「取消」：清掉等待状态，回到确认卡片。
				const [providerId, modelId] = splitOnce(parsed.arg)
				state.setPendingModel(openid, null)
				state.flush()
				await showModelConfirmCard({ openid, sessionId: bound, providerId, modelId, replyContext: ctxReply })
				code = 0
			} else if (parsed.action === 'back') {
				// 确认卡片上的「返回」：回到该提供商的模型列表。
				await showModelListCard({ openid, sessionId: bound, providerId: parsed.arg, replyContext: ctxReply })
				code = 0
			} else {
				logger.debug?.('收到未知的模型卡片动作', { action: parsed.action })
				code = 1
			}
		} else if (parsed.kind === 'run') {
			// 「运行中会话」：空 arg = 打开那张卡片；带会话id = **直接切过去**。
			// 语义全在 commands.js（`运行中会话`），这里只把按钮翻译成等价的命令文本；
			// `page` 走 context 带过去，切完重发卡片才不会跳回第一页。
			// `fromCard: true` 让命令侧切完把卡片重发一遍（标出新的「当前会话」）。
			const ctxReply = { eventId: event.eventId, msgId: event.msgId ?? '' }
			const tokens = parsed.sessionId ? [parsed.sessionId] : []
			await commands.run(
				{ openid, replyContext: ctxReply, quote: '', fromCard: true, page: parsed.page },
				{ name: '运行中会话', tokens, rest: tokens.join(' ') },
			)
			code = 0
		} else if (parsed.kind === 'runpage') {
			// 翻页：直接重发那张卡片（和目录卡片的翻页同款做法）。
			const ctxReply = { eventId: event.eventId, msgId: event.msgId ?? '' }
			await showRunningCard({ openid, page: parsed.page, replyContext: ctxReply })
			code = 0
		} else if (parsed.kind === 'shortcut') {
			// 快捷卡片：go（点某条 = 直接切过去）/ add（把当前会话加进来）。
			// 语义全在 commands.js 里，这里只把按钮翻译成等价的命令文本，避免两套实现。
			// `fromCard: true` 让命令侧做完把卡片重发一遍（标出新的「当前」）。
			const ctxReply = { eventId: event.eventId, msgId: event.msgId ?? '' }
			const tokens = parsed.action === 'add' ? ['加'] : [`#${parsed.arg}`]
			await commands.run(
				{ openid, replyContext: ctxReply, quote: '', fromCard: true },
				{ name: '快捷', tokens, rest: tokens.join(' ') },
			)
			code = 0
		} else if (parsed.kind === 'perm') {
			// 权限卡片上的级别按钮：切成这个预设，并把卡片重发一遍（标出新的"当前"）。
			const ctxReply = { eventId: event.eventId, msgId: event.msgId ?? '' }
			const bound = state.bindingOf(openid)
			if (!bound || bound === 'none') {
				await sendText({ openid, content: '当前没有绑定会话，先 `切换会话`。', markdown: true, context: ctxReply })
				code = 1
			} else {
				const result = await setPermissionForSession({ openid, sessionId: bound, tokens: [parsed.value] })
				if (!result?.ok) {
					await sendText({ openid, content: result?.error ?? '切换权限失败。', markdown: true, context: ctxReply })
					code = 1
				} else {
					await sendText({
						openid,
						content: `已把 **${sessions.describe(bound)}** 的权限切成 ${result.text}。`,
						markdown: true,
						context: ctxReply,
					})
					await showPermissionCard({ openid, sessionId: bound, replyContext: ctxReply })
					code = 0
				}
			}
		} else if (parsed.kind === 'rmdir') {
			// 「删除目录」第一步：换成二次确认卡片，别的都不做。
			await showNewSessionCard({
				openid,
				dir: parsed.path,
				replyContext: { eventId: event.eventId, msgId: event.msgId ?? '' },
				confirming: true,
			})
			code = 0
		} else if (parsed.kind === 'rmdiryes') {
			// 「确认删除」第二步：只删空目录，删完回到上级目录的卡片。
			const ctxReply = { eventId: event.eventId, msgId: event.msgId ?? '' }
			const result = removeEmptyDir(parsed.path)
			if (!result.ok) {
				await sendText({ openid, content: result.error, markdown: true, context: ctxReply })
				await showNewSessionCard({ openid, dir: parsed.path, replyContext: ctxReply })
			} else {
				state.setLastCard(openid, null)
				await sendText({
					openid,
					content: `已删除空目录 \`${result.removed}\`（没有动它以外的东西）。`,
					markdown: true,
					context: ctxReply,
				})
				if (result.parent) await showNewSessionCard({ openid, dir: result.parent, replyContext: ctxReply })
			}
			code = 0
		} else if (parsed.kind === 'newhere') {
			// 「在这里新建」：建完默认切过去，并把结果回给 QQ。
			code = 0
			const result = await createSessionHere({ openid, cwd: parsed.path })
			if (result.ok) {
				await sendText({
					openid,
					content: `已在 \`${result.cwd}\` 新建并切换到 **${result.label}**\n\n直接发消息就能开始用。`,
					markdown: true,
					context: { eventId: event.eventId, msgId: event.msgId ?? '' },
				})
			} else {
				await sendText({ openid, content: result.error, markdown: true, context: { eventId: event.eventId, msgId: event.msgId ?? '' } })
			}
		} else if (parsed.kind === 'needreply') {
			const result = await rounds.needReply({
				openid,
				sessionId: parsed.sessionId,
				interactionId: event.eventId,
				messageId: event.msgId ?? '',
			})
			code = result.code ?? (result.ok ? 0 : 1)
		} else if (parsed.kind === 'question') {
			const result = await questions.handleCallback({ ...parsed, callId: parsed.callId }, { openid })
			code = result.code
		} else if (parsed.kind === 'inbox') {
			const ctxReply = { eventId: event.eventId, msgId: event.msgId ?? '' }
			const entry = inbox.active(openid)
			if (!entry) {
				await sendText({ openid, content: '这个输入框已经结束了。发 `发送` 重新进入输入态。', markdown: true, context: ctxReply })
			} else if (parsed.action === 'rm') {
				inbox.removeItem({ openid, itemId: parsed.arg })
				await showInboxCard({ openid, sessionId: entry.sessionId, context: ctxReply })
				code = 0
			} else if (parsed.action === 'clear') {
				inbox.clearText({ openid })
				await showInboxCard({ openid, sessionId: entry.sessionId, context: ctxReply })
				code = 0
			} else if (parsed.action === 'page') {
				await showInboxCard({ openid, sessionId: entry.sessionId, context: ctxReply, page: parsed.page })
				code = 0
			} else if (parsed.action === 'cancel') {
				await cancelInbox({ openid, context: ctxReply })
				code = 0
			} else if (parsed.action === 'send') {
				const result = await sendFromInbox({ openid, context: ctxReply })
				// 被拦住（语音没转写/空输入框）时回 code 1：按钮保持可点，用户处理完还能再试。
				code = result.ok ? 0 : 1
			}
		}
		outbox.enqueue('respond_interaction', { interactionId: event.eventId, code })
	}

	// ── 本地通道 ─────────────────────────────────────────────────────────────
	let registered = { panel: { enabled: true, users: [] }, menu: { enabled: true } }

	let socketServer = null
	let socketClosed = false
	createSocketServer({
		path: socketPath,
		token,
		logger,
		handlers: {
			register: async (args) => {
				const openids = Array.isArray(args?.openids)
					? args.openids.map((item) => (typeof item === 'string' ? item : item?.openid)).filter(Boolean)
					: []
				state.setWhitelist(openids)
				state.flush()
				registered = {
					panel: {
						enabled: args?.panel?.enabled ?? true,
						users: Array.isArray(args?.panel?.users) ? args.panel.users.filter(Boolean) : [],
					},
					menu: { enabled: args?.menu?.enabled ?? true },
				}
				logger.info?.('已接收白名单与面板意图', { openids: openids.length, panelUsers: registered.panel.users.length })
				// 补登记历史遗漏：以前 QQ 侧建会话只 create、没建工作区，Web 端
				// 整个文件夹都看不到。网关每次同步（含插件重启后）都补一次，幂等。
				try {
					await sessions.refresh()
					await repairWorkspaces()
				} catch (error) {
					logger.warn?.('补登记工作区失败', { error: String(error) })
				}
				return { ok: true }
			},
			panel: async () => {
				// dsh 内置命令收进二级菜单（顶层留给桥自己的命令）。
				// 命令是按 agent 作用域的，所以挑一个代表：优先"被 QQ 绑定的活会话"，
				// 其次任意活会话；都没有时只发桥命令（下次网关重同步时再补齐）。
				const descriptors = await listCommands(ctx.commands, representativeAgent(), logger)
				return {
					scope: 'c2c',
					targetType: 'specific',
					// enabled / menuEnabled 只是把 register 收到的意图回显出来，方便直接用
					// socket 排查；**是否真的发布以 Go 侧 config.yaml 为准**（配置唯一来源在那）。
					enabled: registered.panel.enabled,
					menuEnabled: registered.menu.enabled,
					userOpenIds: registered.panel.users,
					items: panelItems(),
					// 扁平键 menuItems：与 Go 侧 PanelDefinition.MenuItems 对齐。
					menuItems: registered.menu.enabled
						? buildMenuItems({ bridge: menuItems(), commands: descriptors, label: config.dshMenuLabel })
						: [],
				}
			},
			event: async (args) => {
				// 立即返回，异步处理：QQ 的事件回调不该被这里拖住。
				void onQQEvent(args).catch((error) => logger.warn?.('处理 QQ 事件失败', { error: String(error) }))
				return { accepted: true }
			},
			'outbox.poll': async (args) => ({ commands: await outbox.poll({ waitSeconds: args?.waitSeconds ?? 25 }) }),
			ack: async (args) => {
				outbox.ack(args ?? {})
				return { ok: true }
			},
			health: async () => ({
				ok: true,
				version: 1,
				bindings: Object.keys(state.get().bindings).length,
				pendingQuestions: questions.pendingCount(),
				outboxDepth: outbox.depth(),
				titles: sessions.visible().length,
				whitelist: state.whitelist().length,
			}),
		},
	})
		.then((server) => {
			if (socketClosed) {
				void server.close()
				return
			}
			socketServer = server
			logger.info?.('本地通道已就绪', { socket: server.path })
		})
		.catch((error) => {
			logger.error?.('本地通道启动失败（QQ 侧将连不上）', { socket: socketPath, error: String(error) })
		})

	ctx.effect(
		() => () => {
			socketClosed = true
			void socketServer?.close()
			questions.dispose()
			outbox.dispose()
			state.flush()
		},
		'dsh-qq-bot: shutdown',
	)

	// ── 启动：建立索引 + 订阅 ────────────────────────────────────────────────
	const unsubscribe = sessions.subscribe()
	void sessions.refresh()
	ctx.effect(() => () => unsubscribe(), 'dsh-qq-bot: session index')

	logger.info?.('dsh-qq-bot 插件已加载', {
		socket: socketPath,
		whitelist: state.whitelist().length,
	})
}
