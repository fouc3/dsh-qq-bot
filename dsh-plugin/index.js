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
import {
	QUESTION_MAX_BUTTONS,
	buildInboxCard,
	buildInboxResult,
	buildMkdirPromptCard,
	buildNewSessionCard,
	buildSessionCard,
	data as cardData,
	parseCallback,
} from './lib/cards.js'
import { createCommandRunner, menuItems, panelItems, parseCommand } from './lib/commands.js'
import { renderProgress, snapshotProgress } from './lib/progress.js'
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

	// ── 会话级序号：被动回复按 msg_id+msg_seq 去重，所以每条消息都要递增 ──────
	const seqByKey = new Map()
	function nextSeq(key) {
		const next = (seqByKey.get(key) ?? 0) + 1
		seqByKey.set(key, next)
		if (seqByKey.size > 1000) seqByKey.clear()
		return next
	}

	/**
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

	/** 拉一个活 agent：先查在册，冷会话再 resume（会话不存在则返回 null）。 */
	async function agentFor(sessionId) {
		const live = ctx.agents.get(sessionId)
		if (live) return live
		try {
			const handle = await ctx.agents.resume({ resumeSessionId: sessionId })
			return handle?.agent ?? null
		} catch (error) {
			logger.warn?.('恢复会话失败', { sessionId, error: String(error) })
			return null
		}
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
	async function deliver({ sessionId, openid, text, interrupt = true, origin = 'qq', context = {}, images = [], sections = [] }) {
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
		if (interrupt && agent.status === 'running') {
			logger.info?.('会话正在运行，先打断', { sessionId })
			agent.cancel({ kind: 'user' }, { keepInbox: false })
		}
		ensureAgentSetup(agent, sessionId)
		// 被打断时把「这条消息」当作打断来源：通知里会带一行「> 打断来自：…」。
		const round = rounds.beginRound({ sessionId, openid, origin, context, interruptSource: interrupt ? text : '' })
		round.pendingContext = rounds.roundContextText(round)
		// plan 模式下补一句：计划正文也要发到 QQ（否则坐在这边只看得见"已结束"）。
		if (isPlanModeActive(agent)) {
			round.pendingContext +=
				'\n本会话处于 **plan 模式**：提交计划（`exit_plan_mode`）时请**同时用 `qq_reply` 把计划正文发一份到 QQ**——审批仍在 dsh 界面，QQ 端只做"看得到"。'
		}
		// 附件清单/语音转写与正文**同一条消息**（各自一个块）：
		// followup 的语义是"独占一轮"，分两条发会让正文卡在待发送里（踩过）。
		agent.followup(makeUserMessage(text, { kind: 'dsh-qq-bot' }, images, sections))
		return { ok: true }
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
			await deliver({ sessionId, openid, text: body, interrupt: true, origin: 'qq', context, images, sections })
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
		userMessage: (text) => makeUserMessage(text, { kind: 'dsh-qq-bot' }),
		contextMessage: (text) =>
			makeUserMessage(text, {
				kind: 'dsh-qq-bot',
				form: 'snapshot',
				sections: [{ name: 'dsh-qq-bot', text: String(text) }],
			}),
		agentFor,
		nextSeqFor: (sessionId) => nextSeq(`session:${sessionId}`),
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

	const questions = createQuestionBridge({ state, outbox, config, logger, io })

	const commands = createCommandRunner({
		sessions,
		state,
		logger,
		reply: ({ openid, content, markdown = true, replyContext = {} }) =>
			sendText({ openid, content, markdown, context: replyContext }),
		showSessionCard: ({ openid, replyContext }) => showSessionCard({ openid, replyContext }),
		showNewSessionCard: ({ openid, replyContext }) => showNewSessionCard({ openid, replyContext }),
		createSession: ({ openid, cwd }) => createSessionHere({ openid, cwd }),
		// 裸发 `发送` 进入输入态（详细设计见 lib/inbox.js 顶部注释）。
		beginInput: ({ openid, sessionId, replyContext, mode }) => beginInput({ openid, sessionId, replyContext, mode }),
		// 进度是**只读**的：只用 agents.get（不 resume、不 cancel）；拿不到活跃 agent 就如实说没在跑。
		progress: async ({ sessionId }) => {
			const label = sessions.get(sessionId) ? sessions.label(sessionId) : sessionId
			const agent = ctx.agents.get(sessionId)
			if (!agent) {
				return {
					content: `**进度快照**\n> 会话：${label}\n> 状态：没有活跃的 agent（这一轮没在跑）\n\n让它跑起来的话，直接发一条消息即可。`,
				}
			}
			const snapshot = snapshotProgress(agent)
			return { content: renderProgress({ label, snapshot, sessionId }) }
		},
		deliver: ({ sessionId, openid, text, interrupt }) =>
			deliver({ sessionId, openid, text, interrupt, origin: 'qq', context: {} }),
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
	const attached = new Set()
	function ensureAgentSetup(agent, sessionId) {
		if (!agent || attached.has(sessionId)) return
		attached.add(sessionId)
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

	async function onMessage(event) {
		const openid = event.openid
		const context = { msgId: event.msgId ?? '' }

		// 1) 桥命令最优先：**即使正在等提问作答，命令也必须先执行** ——
		//    否则 `停止`/`进度` 这类命令会被提问桥当「其他」答案吃掉。
		const parsed = parseCommand(event.text)
		if (parsed) {
			// 命令也当"取消等目录名"：不然点了「新建目录」又反悔发命令，会有一条
			// 悬着的 pending 把后面某条无关消息当成目录名吃掉。
			if (state.pendingDirOf(openid)) {
				state.setPendingDir(openid, null)
				state.flush()
			}
			await commands.run({ openid, replyContext: context }, parsed)
			return
		}

		// 2) dsh 内置命令：'/xxx' 直接交给 ctx.commands.execute（不经模型），同样优先于提问捕获。
		//    不兼容的（如 feedback）当普通消息处理。
		const slash = splitSlashLine(event.text)
		if (slash && !EXCLUDED_COMMANDS.has(slash.name)) {
			const bound = state.bindingOf(openid)
			const agent = bound && bound !== 'none' ? await agentFor(bound) : null
			if (agent) {
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
			}
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
