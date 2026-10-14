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
import { statSync } from 'node:fs'

import { createState } from './lib/state.js'
import { createSocketServer } from './lib/socket.js'
import { createOutbox } from './lib/outbox.js'
import { createSessions } from './lib/sessions.js'
import { createQuestionBridge } from './lib/questions.js'
import { createRounds } from './lib/rounds.js'
import { buildReplyTool } from './lib/reply-tool.js'
import { buildNewSessionCard, buildSessionCard, data as cardData, parseCallback } from './lib/cards.js'
import { createCommandRunner, menuItems, panelItems, parseCommand } from './lib/commands.js'
import {
	EXCLUDED_COMMANDS,
	buildMenuItems,
	isSlashLine,
	listCommands,
	runCommand,
	splitSlashLine,
} from './lib/dsh-commands.js'

export const name = 'dsh-qq-bot'
export const inject = ['agents', 'sessions', 'sessionController', 'workspaceRegistry', 'tools', 'commands']

/**
 * 递归冻结：与 `createUserMessage` 一样，交给框架的消息必须是不可变快照。
 */
function deepFreeze(value, seen = new WeakSet()) {
	if (value === null || typeof value !== 'object' || seen.has(value)) return value
	seen.add(value)
	for (const key of Object.keys(value)) deepFreeze(value[key], seen)
	return Object.freeze(value)
}

/** 构造一条 user 消息（等价于 @deepseek-ai/dsh-llm 的 createUserMessage）。 */
function makeUserMessage(text, source) {
	return deepFreeze({
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text: String(text) }],
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
		maxQuestionButtons: rawConfig?.maxQuestionButtons ?? 15,
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

	// ── 会话级序号：被动回复按 msg_id+msg_seq 去重，所以每条消息都要递增 ──────
	const seqByKey = new Map()
	function nextSeq(key) {
		const next = (seqByKey.get(key) ?? 0) + 1
		seqByKey.set(key, next)
		if (seqByKey.size > 1000) seqByKey.clear()
		return next
	}

	function openidForSession(sessionId) {
		for (const [openid, bound] of Object.entries(state.get().bindings)) {
			if (bound === sessionId) return openid
		}
		return null
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
		sendCard: async ({ openid, content, keyboard, context }) => {
			await recallPreviousCard(openid)
			const messageId = await sendCard({ openid, content, keyboard, context })
			state.setLastCard(openid, messageId)
			return messageId
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

	/** 新建会话的"选目录"卡片（逐层进入，最后点「在这里新建」）。 */
	async function showNewSessionCard({ openid, dir, page = 1, replyContext = {} }) {
		const bound = state.bindingOf(openid)
		const boundCwd = bound && bound !== 'none' ? sessions.get(bound)?.cwd : null
		const start = dir || boundCwd || sessions.defaultRoot()
		const card = buildNewSessionCard({
			dir: start,
			dirs: sessions.listDirs(start),
			page,
			pageSize: Number(config.sessionPageSize) || 8,
			parentPath: sessions.parentOf(start),
		})
		await io.sendCard({ openid, content: card.content, keyboard: card.keyboard, context: replyContext })
		logger.info?.('已发新建会话选目录卡片', { dir: start })
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
	async function deliver({ sessionId, openid, text, interrupt = true, origin = 'qq', context = {} }) {
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
		const round = rounds.beginRound({ sessionId, openid, origin, context })
		round.pendingContext = rounds.roundContextText(round)
		agent.followup(makeUserMessage(text, { kind: 'dsh-qq-bot' }))
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
		onDeliver: async ({ sessionId, openid, text, origin }) => {
			await deliver({ sessionId, openid, text, interrupt: false, origin: origin ?? 'delayed', context: {} })
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
		deliver: ({ sessionId, openid, text, interrupt }) =>
			deliver({ sessionId, openid, text, interrupt, origin: 'qq', context: {} }),
		stopSession: async (sessionId) => {
			const agent = ctx.agents.get(sessionId)
			if (!agent) return { ok: false, reason: '当前没有在运行的轮次' }
			rounds.markStopped(sessionId)
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
				const roundsDisposer = rounds.attachAgent(agent, sessionId)
				return () => {
					try {
						toolDisposer?.()
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
			logger.debug?.('已为会话注册 qq_reply 与轮次监听', { sessionId })
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

		// 1) 有待答提问：文本优先当「其他」答案
		if (questions.hasPending(openid) && (await questions.handleText(openid, event.text))) return

		// 2) 命令
		const parsed = parseCommand(event.text)
		if (parsed) {
			await commands.run({ openid, replyContext: context }, parsed)
			return
		}

		// 3) dsh 内置命令：'/xxx' 直接交给 ctx.commands.execute（不经模型）。
		//    不兼容的（如 feedback）当普通消息处理。
		const slash = splitSlashLine(event.text)
		if (slash && !EXCLUDED_COMMANDS.has(slash.name)) {
			const bound = state.bindingOf(openid)
			const agent = bound && bound !== 'none' ? await agentFor(bound) : null
			if (agent) {
				const outcome = await runCommand(ctx.commands, agent, slash.line, { logger })
				if (outcome.handled) {
					await sendText({
						openid,
						content: outcome.text || (outcome.ok ? `已执行 /${slash.name}` : `/${slash.name} 执行失败`),
						markdown: false,
						context,
					})
					return
				}
			}
		}

		// 4) 普通消息 → 当前绑定会话
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
		await deliver({ sessionId: bound, openid, text: event.text, interrupt: true, origin: 'qq', context })
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
