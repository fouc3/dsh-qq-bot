/**
 * 插件装配的端到端测试：真实 apply() + 真实 UNIX socket + 假 dsh 服务。
 *
 * 这是本仓库能自动做到的最强验证：以真实 NDJSON 帧走完整链路
 * （register/panel/event/outbox.poll/ack/health），并验证 QQ 消息真的
 * 变成了对 agent 的注入消息、卡片与结束通知真的进了出站队列。
 * 不需要 dsh 运行时，也不需要 dsh 的 npm 包 —— bundle 是自包含的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { existsSync, mkdtempSync, statSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name as pluginName, inject as pluginInject } from '../index.js'
import { data as cardData, parseCallback } from './cards.js'
import { REPLY_TOOL_NAME } from './reply-tool.js'
import { ATTACHMENT_TOOL_NAME } from './attachment-tool.js'

// ── 假 dsh 服务 ─────────────────────────────────────────────────────────────

function makeAgent(sessionId) {
	const handlers = {}
	const tools = []
	const agent = {
		id: sessionId,
		status: 'idle',
		followed: [],
		cancelled: 0,
		handlers,
		tools,
		ctx: {
			on(event, handler) {
				handlers[event] = handler
				return () => {}
			},
			effect(callback) {
				const disposer = callback()
				return typeof disposer === 'function' ? disposer : () => {}
			},
			tools: {
				register(definition) {
					tools.push(definition)
					return () => {}
				},
			},
		},
		followup(message) {
			agent.followed.push(message)
		},
		cancel() {
			agent.cancelled += 1
		},
	}
	return agent
}

function makeCtx({ sessionSummaries = [], live = {}, commands = null } = {}) {
	const disposers = []
	const events = new Map()
	const liveAgents = new Map(Object.entries(live))
	const archived = []

	const ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		effect(callback) {
			const disposer = callback()
			disposers.push(typeof disposer === 'function' ? disposer : () => {})
			return () => {}
		},
		on(event, handler) {
			const list = events.get(event) ?? []
			list.push(handler)
			events.set(event, list)
			return () => {}
		},
		agents: {
			get: (id) => liveAgents.get(id),
			list: () => [...liveAgents.values()],
			async resume({ resumeSessionId }) {
				const agent = liveAgents.get(resumeSessionId) ?? makeAgent(resumeSessionId)
				liveAgents.set(resumeSessionId, agent)
				return { agent }
			},
		},
		sessions: { get: () => undefined },
		// dsh 内置命令服务（ctx.commands）：默认"没有命令"，测试可覆盖。
		commands: commands ?? {
			async list() {
				return []
			},
			async execute() {
				return undefined
			},
		},
		sessionController: {
			async list() {
				return { items: sessionSummaries, isEnd: true }
			},
		},
		workspaceRegistry: {
			archivedSessionIds: [],
			async archiveSession(sessionId) {
				archived.push(sessionId)
			},
		},
		attachments: makeAttachmentStore(),
	}

	return {
		ctx,
		liveAgents,
		archived,
		events,
		attachments: ctx.attachments,
		dispose() {
			for (const disposer of disposers.reverse()) disposer()
		},
	}
}

// ── 假附件服务（dsh 的 ctx.attachments） ────────────────────────────────────

function makeAttachmentStore() {
	const images = []
	const files = []
	return {
		images,
		files,
		async saveImages(inputs) {
			return inputs.map((input) => {
				images.push(input)
				return {
					attachmentId: `img-${images.length}`,
					mediaType: input.mediaType,
					bytes: input.data?.length ?? 0,
					width: 1,
					height: 1,
					name: input.name,
				}
			})
		},
		async saveFileStream({ data, name }) {
			let bytes = 0
			for await (const chunk of data) bytes += chunk.length
			files.push({ name, bytes })
			return { attachmentId: `file-${files.length}`, name, bytes }
		},
		fileHostPath(ref) {
			return `/home/u/.dsh/attachments/v1/objects/${ref.attachmentId}`
		},
	}
}

/** 装一个假的 fetch：所有 URL 都返回 fixed 字节数，方便断言下载真的发生了。 */
function stubFetch(bytes = 16) {
	const previous = globalThis.fetch
	const calls = []
	globalThis.fetch = async (url) => {
		calls.push(String(url))
		return {
			ok: true,
			status: 200,
			headers: { get: () => null },
			body: (async function* () {
				yield new Uint8Array(bytes)
			})(),
		}
	}
	return {
		calls,
		restore() {
			globalThis.fetch = previous
		},
	}
}

// ── 通过真实 socket 说话 ────────────────────────────────────────────────────

let rpcSeq = 0

/** 一条连接一次请求（与 Go 侧客户端同款用法）。 */
function rpc(path, op, args = {}, token = '') {
	const id = `t${(rpcSeq += 1)}`
	return new Promise((resolve, reject) => {
		const socket = connect(path)
		let buffer = ''
		const frames = token ? [{ token }, { id, op, args }] : [{ id, op, args }]
		const timer = setTimeout(() => {
			socket.destroy()
			reject(new Error(`RPC 超时：${op}`))
		}, 3000)

		socket.on('connect', () => {
			for (const frame of frames) socket.write(`${JSON.stringify(frame)}\n`)
		})
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8')
			let index
			while ((index = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, index)
				buffer = buffer.slice(index + 1)
				if (!line.trim()) continue
				const frame = JSON.parse(line)
				if (frame.ok === true && frame.id === undefined && token) continue // 握手应答
				if (token && frame.id === undefined) continue
				clearTimeout(timer)
				socket.destroy()
				resolve(frame)
				return
			}
		})
		socket.on('error', (error) => {
			clearTimeout(timer)
			reject(error)
		})
	})
}

async function waitFor(predicate, { timeoutMs = 2000, stepMs = 10 } = {}) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const value = await predicate()
		if (value) return value
		if (Date.now() > deadline) throw new Error('等待条件超时')
		await new Promise((resolve) => setTimeout(resolve, stepMs))
	}
}

/** 拉一次出站队列并全部 ack（模拟 Go 侧执行成功）。 */
async function pumpQueue(path, { ack = true } = {}) {
	const response = await rpc(path, 'outbox.poll', { waitSeconds: 0 })
	const commands = response.value?.commands ?? []
	if (ack) {
		for (const command of commands) {
			await rpc(path, 'ack', { id: command.id, ok: true, messageId: `MSG-${command.id}` })
		}
	}
	return commands
}

/** 反复拉队列并 ack 一小段时间，收集期间产生的全部命令（断言更稳）。 */
async function drainFor(path, ms = 150) {
	const collected = []
	const deadline = Date.now() + ms
	do {
		collected.push(...(await pumpQueue(path)))
		await new Promise((resolve) => setTimeout(resolve, 15))
	} while (Date.now() < deadline)
	return collected
}

function bootPlugin(t, { sessions: summaries, live, token = '', commands = null, config = {} } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-bot-'))
	const socketPath = join(dir, 'bridge.sock')
	const stateFile = join(dir, 'state.json')
	const fake = makeCtx({ sessionSummaries: summaries, live, commands })
	apply(fake.ctx, {
		socketPath,
		stateFile,
		token,
		replyAckTimeoutMs: 50,
		noticeFallbackMs: 20,
		questionTimeoutMs: 5000,
		sessionPageSize: 8,
		...config,
	})
	// 断言失败也要收尾：否则 socket 与定时器会拖住事件循环。
	t?.after?.(() => fake.dispose())
	return { ...fake, dir, socketPath, stateFile }
}

const SUMMARIES = [
	{ sessionId: 'session-1', cwd: '/home/u/proj-a', updatedAt: 5, running: false },
	{ sessionId: 'session-2', cwd: '/home/u/proj-b', updatedAt: 3, running: false },
]

// ── 测试 ────────────────────────────────────────────────────────────────────

test('bundle 自包含：源码里不得 import 任何 @deepseek-ai/*（profile 软链安装下解析不到）', async () => {
	const here = new URL('./', import.meta.url)
	const files = ['../index.js', ...readdirSync(here).filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))]
	const offenders = []
	for (const relative of files) {
		const source = readFileSync(new URL(relative, here), 'utf8')
		for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/g)) {
			if (match[1].startsWith('@deepseek-ai/')) offenders.push(`${relative} → ${match[1]}`)
		}
		for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
			if (match[1].startsWith('@deepseek-ai/')) offenders.push(`${relative} → 动态 import ${match[1]}`)
		}
	}
	assert.deepEqual(offenders, [], 'bundle 必须自包含；需要 dsh 能力时通过 ctx 的服务/事件拿')
})

test('插件导出形态正确，且 apply() 会建出 0600 的 socket', async (t) => {
	const boot = bootPlugin(t, { sessions: SUMMARIES })
	assert.equal(pluginName, 'dsh-qq-bot')
	assert.ok(Array.isArray(pluginInject))
	assert.ok(pluginInject.includes('tools'))

	await waitFor(() => existsSync(boot.socketPath))
	const mode = statSync(boot.socketPath).mode & 0o777
	assert.equal(mode, 0o600)
	assert.equal(statSync(boot.dir).mode & 0o777, 0o700)
	boot.dispose()
})

test('register → panel：白名单快照 + 七条命令的面板定义（只绑定配置指定的私聊）', async (t) => {
	const boot = bootPlugin(t, { sessions: SUMMARIES })
	await waitFor(() => existsSync(boot.socketPath))

	const registered = await rpc(boot.socketPath, 'register', {
		openids: [{ openid: 'U1', note: '运维者' }],
		panel: { enabled: true, users: ['U1'] },
		menu: { enabled: true },
		version: 1,
	})
	assert.equal(registered.ok, true)

	const panel = await rpc(boot.socketPath, 'panel')
	assert.equal(panel.value.scope, 'c2c')
	assert.equal(panel.value.targetType, 'specific')
	assert.equal(panel.value.enabled, true)
	assert.equal(panel.value.menuEnabled, true)
	assert.deepEqual(panel.value.userOpenIds, ['U1'])
	assert.deepEqual(
		panel.value.items.map((item) => item.name),
		['切换会话', '新建会话', '进度', '发送', '停止', '归档', '延迟发送'],
	)
	// 扁平键 menuItems：与 Go 侧 PanelDefinition.MenuItems 对齐（大小写不敏感匹配）
	assert.equal(panel.value.menuItems.length, 7)
	assert.equal(panel.value.menuItems[0].name, '切换会话')
	assert.equal(panel.value.menuItems[0].sendMessage, '切换会话')
	assert.equal(panel.value.menu, undefined)

	// 白名单落了盘（插件重启后仍能门守）
	await waitFor(() => {
		if (!existsSync(boot.stateFile)) return false
		try {
			return JSON.parse(readFileSync(boot.stateFile, 'utf8')).whitelist.openids.includes('U1')
		} catch {
			return false
		}
	})
	boot.dispose()
})

test('非白名单来源的事件在插件侧被丢弃（第二道门守）', async (t) => {
	const boot = bootPlugin(t, { sessions: SUMMARIES })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })

	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U-BAD', text: '切换会话', msgId: 'M1' })
	await new Promise((resolve) => setTimeout(resolve, 30))

	assert.deepEqual(await pumpQueue(boot.socketPath, { ack: false }), [], '白名单外不该产生任何出站命令')
	boot.dispose()
})

test('端到端：命令 → 会话卡片；绑定后普通消息进会话；一轮结束发通知 + 按钮', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', {
		openids: [{ openid: 'U1' }],
		panel: { enabled: true, users: ['U1'] },
		menu: { enabled: true },
	})

	// 1) 未绑定会话时发普通消息 → 回提示（不出站给会话）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '你好', msgId: 'M1' })
	const hint = await waitFor(async () => (await pumpQueue(boot.socketPath)).find((c) => c.kind === 'send_c2c'))
	assert.match(hint.args.content, /没有指定会话/)
	assert.equal(agent.followed.length, 0)

	// 2) `切换会话` → 会话选择卡片（默认根目录 = 所有会话 cwd 的公共前缀，文件夹用回调按钮）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话', msgId: 'M2' })
	const rootCard = await waitFor(async () => {
		const commands = await pumpQueue(boot.socketPath)
		return commands.find((c) => c.kind === 'send_c2c' && c.args.keyboard) ?? null
	})
	assert.equal(rootCard.args.markdown, true, '键盘必须挂 markdown 消息')
	assert.match(rootCard.args.content, /切换会话/)
	// 整条链路（含 index.js 可能追加的按钮）产出的键盘必须合法：≤5 行、每行 ≤5 按钮。
	// 线上就是这里超了一行被平台 40034029 拒收的。
	const rows = rootCard.args.keyboard.content.rows
	assert.ok(rows.length <= 5, `键盘行数 ${rows.length} 超平台上限`)
	for (const row of rows) assert.ok(row.buttons.length <= 5, `某行按钮数 ${row.buttons.length} 超上限`)
	const rootButtons = rows.flatMap((row) => row.buttons)
	const folder = rootButtons.find((b) => b.action.type === 1 && b.action.data === cardData.dir('/home/u/proj-a'))
	assert.ok(folder, '文件夹应是回调按钮（点了由插件翻层）')
	assert.equal(rootButtons.find((b) => b.action.data === cardData.dir('/home/u/proj-a')).render_data.label, 'proj-a')
	assert.ok(rootButtons.some((b) => b.action.type === 2 && b.action.data === '切换会话 none'), '应给出"不指定会话"按钮')

	// 2b) 点文件夹 → 撤回上一张卡片 → 发下一层卡片，其中会话是指令按钮（只填输入框）
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: folder.action.data,
		eventId: 'INT-DIR',
		msgId: 'CARD-ROOT',
	})
	const innerCommands = await drainFor(boot.socketPath)
	const innerCard = innerCommands.find((c) => c.kind === 'send_c2c' && c.args.keyboard && String(c.args.content).includes('/home/u/proj-a'))
	assert.ok(innerCard, '点进目录后应发下一层卡片')
	assert.ok(
		innerCommands.some((c) => c.kind === 'recall_c2c'),
		'每次选择都要尝试撤回上一张卡片',
	)
	const innerButtons = innerCard.args.keyboard.content.rows.flatMap((row) => row.buttons)
	const sessionButton = innerButtons.find((b) => b.action.data === '切换会话 session-1')
	assert.ok(sessionButton, '会话应是指令按钮')
	assert.equal(sessionButton.action.type, 2, '指令按钮：点击只把命令填进输入框，不切换')

	// 3) 绑定会话
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M3' })
	await waitFor(async () => (await pumpQueue(boot.socketPath)).some((c) => c.kind === 'send_c2c'))

	// 4) 绑定后的普通消息 → 注入会话（并注册 qq_reply 工具）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '帮我看看这个', msgId: 'M4' })
	await waitFor(() => agent.followed.length === 1)
	assert.equal(agent.followed[0].role, 'user')
	assert.equal(agent.followed[0].content[0].text, '帮我看看这个')
	assert.equal(agent.followed[0].source.kind, 'dsh-qq-bot')
	assert.ok(agent.followed[0].id, '消息必须带 id')
	assert.ok(Object.isFrozen(agent.followed[0]), '交给框架的消息必须是不可变快照')

	const toolNames = agent.tools.map((tool) => tool.name)
	assert.deepEqual(toolNames.sort(), [ATTACHMENT_TOOL_NAME, REPLY_TOOL_NAME].sort(), '应为该会话注册 qq_reply 与附件拉取工具')
	const replyTool = agent.tools.find((tool) => tool.name === REPLY_TOOL_NAME)
	assert.equal(replyTool.parameters.type, 'object')

	// 4b) 会话正在运行时再来一条普通消息：先打断，再投递新一轮
	agent.status = 'running'
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '换个方向', msgId: 'M5' })
	await waitFor(() => agent.followed.length === 2)
	assert.equal(agent.cancelled, 1, '运行中的会话必须先被打断')
	assert.equal(agent.followed[1].content[0].text, '换个方向')
	// 只有认领到的那一轮才结算：被打断的那一轮不给通知
	agent.handlers['session/event'](null, { type: 'turn/end', data: { turn: 99, reason: { kind: 'aborted' } } })
	const afterAbort = await drainFor(boot.socketPath, 80)
	assert.equal(
		afterAbort.filter((c) => /已结束/.test(String(c.args?.content))).length,
		0,
		'未认领的轮次结束不该发通知',
	)
	agent.status = 'idle'

	// 5) 用户级上下文注入：同一轮只注入一次
	const preStep = agent.handlers['agent/pre-step']
	const next = async () => ({ kind: 'enter', messages: [] })
	const first = await preStep({ turn: 1, signal: { aborted: false } }, next)
	assert.equal(first.messages.length, 1)
	assert.match(first.messages[0].content[0].text, /来自 QQ 私信/)
	assert.equal(first.messages[0].source.form, 'snapshot')
	const second = await preStep({ turn: 1, signal: { aborted: false } }, next)
	assert.equal(second.messages.length, 0)

	// 6) 这一轮结束 → 「标题(会话id)已结束」+「我需要回复」
	agent.handlers['session/event'](null, { type: 'turn/start', data: { turn: 1 } })
	agent.handlers['session/event'](null, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
	const notice = await waitFor(async () => {
		const commands = await pumpQueue(boot.socketPath)
		return commands.find((c) => c.kind === 'send_c2c' && String(c.args.content).includes('已结束'))
	})
	// 标题缺失时用 cwd 末段兜底：所以这里是 proj-a(session-1)
	assert.equal(notice.args.content, 'proj-a(session-1)已结束')
	assert.equal(notice.args.keyboard.content.rows[0].buttons[0].render_data.label, '我需要回复')
	assert.equal(notice.args.keyboard.content.rows[0].buttons[0].action.data, cardData.needReply('session-1'))

	boot.dispose()
})

test('端到端：点「我需要回复」→ 唤醒会话 + 回应互动 + 回确认；运行中则拒绝', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M1' })
	await waitFor(async () => (await pumpQueue(boot.socketPath)).length > 0)

	// 空闲时点按钮
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: cardData.needReply('session-1'),
		eventId: 'INT-1',
		msgId: 'CARD-1',
	})
	await waitFor(() => agent.followed.length === 1)
	assert.match(agent.followed[0].content[0].text, /我需要回复/)

	const commands = await waitFor(async () => {
		const list = await pumpQueue(boot.socketPath)
		return list.length > 0 ? list : null
	})
	const respond = commands.find((c) => c.kind === 'respond_interaction')
	assert.equal(respond.args.code, 0, '成功应回应 code=0（客户端提示已触发）')
	const confirm = commands.find((c) => c.kind === 'send_c2c')
	assert.match(confirm.args.content, /已触发/)
	assert.equal(confirm.args.replyToEventId, 'INT-1', '确认消息用互动事件作被动上下文')

	// 运行中再点：应回应 code=2 且不唤醒
	agent.status = 'running'
	const before = agent.followed.length
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: cardData.needReply('session-1'),
		eventId: 'INT-2',
		msgId: 'CARD-2',
	})
	const busy = await waitFor(async () => {
		const list = await pumpQueue(boot.socketPath)
		return list.find((c) => c.kind === 'respond_interaction') ?? null
	})
	// 运行中的点击必须回「失败(1)」：码 2 的平台语义是「操作太频繁」，
	// 客户端会直接弹这个词（线上就是这么弹的）。
	assert.equal(busy.args.code, 1)
	assert.equal(agent.followed.length, before, '运行中不该再唤醒')

	// 非绑定用户点按钮：code=4
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U-BAD',
		buttonData: cardData.needReply('session-1'),
		eventId: 'INT-3',
		msgId: 'CARD-3',
	})
	await new Promise((resolve) => setTimeout(resolve, 30))
	assert.deepEqual(await pumpQueue(boot.socketPath, { ack: false }), [], '非白名单互动应被门守丢弃')

	boot.dispose()
})

test('端到端：发送 / 延迟发送 / 停止 / 归档', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-2', msgId: 'M1' })
	await waitFor(async () => (await pumpQueue(boot.socketPath)).length > 0)

	// 发送：单次投递（和输入态的「发送」同义＝会打断目标会话正在跑的轮次）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '发送 session-1 帮我看下', msgId: 'M2' })
	await waitFor(() => agent.followed.length === 1)
	assert.equal(agent.followed[0].content[0].text, '帮我看下')
	await waitFor(async () => (await pumpQueue(boot.socketPath)).some((c) => c.kind === 'send_c2c'))

	// 延迟发送：登记而非立即投递
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '延迟发送 session-1 打完了叫我', msgId: 'M3' })
	const receipt = await waitFor(async () => {
		const list = await pumpQueue(boot.socketPath)
		return list.find((c) => c.kind === 'send_c2c' && /已登记/.test(String(c.args.content))) ?? null
	})
	assert.match(receipt.args.content, /已登记/)
	assert.equal(agent.followed.length, 1, '延迟发送不该立即投递')

	// 无参延迟发送 → 和 `发送` **共用同一套输入态面板**（只是 mode=delay）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '延迟发送', msgId: 'M4' })
	const delayCard = await waitFor(async () => {
		const list = await pumpQueue(boot.socketPath)
		return list.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1) ?? null
	})
	assert.match(delayCard.args.content, /输入框（延迟投递）/)
	assert.match(delayCard.args.content, /不打断/)
	assert.match(delayCard.args.content, /session-2/, '裸发作用于当前绑定会话')
	const delayLabels = delayCard.args.keyboard.content.rows.flatMap((r) => r.buttons).map((b) => b.render_data.label)
	assert.ok(delayLabels.includes('延迟发送'), `延迟输入态的主按钮应叫「延迟发送」，实际：${delayLabels.join('/')}`)
	assert.equal(agent.followed.length, 1, '进输入态不该投递')

	// 停止（无参=当前会话 session-2；此刻 session-2 没有活 agent，应给出明确失败提示）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '停止', msgId: 'M5' })
	const stopReply = await waitFor(async () => {
		const list = await pumpQueue(boot.socketPath)
		const reply = list.find((c) => c.kind === 'send_c2c')
		return reply ? String(reply.args.content) : null
	})
	assert.match(stopReply, /没停成|已请求停止/)

	// 归档（无参=当前会话）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '归档', msgId: 'M6' })
	await waitFor(() => boot.archived.includes('session-2'))
	const archivedReply = await waitFor(async () => {
		const list = await pumpQueue(boot.socketPath)
		return list.find((c) => c.kind === 'send_c2c' && /已归档/.test(String(c.args.content))) ?? null
	})
	assert.match(archivedReply.args.content, /已归档/)

	boot.dispose()
})

test('端到端：token 握手与 health 诊断', async (t) => {
	const boot = bootPlugin(t, { sessions: SUMMARIES, token: 's3cret' })
	await waitFor(() => existsSync(boot.socketPath))

	const bad = await rpc(boot.socketPath, 'health')
	assert.equal(bad.ok, false)
	assert.equal(bad.error.code, 'unauthorized')

	const good = await rpc(boot.socketPath, 'health', {}, 's3cret')
	assert.equal(good.ok, true)
	assert.equal(good.value.ok, true)
	assert.equal(good.value.whitelist, 0)
	assert.equal(typeof good.value.outboxDepth, 'number')
	assert.equal(typeof good.value.pendingQuestions, 'number')
	boot.dispose()
})

test('端到端：dsh 内置命令从 QQ 直接执行（不进模型）；技能不在内、反馈排除', async (t) => {
	const agent = makeAgent('session-1')
	const executed = []
	const boot = bootPlugin(t, {
		sessions: SUMMARIES,
		live: { 'session-1': agent },
		commands: {
			async list() {
				return [
					{ name: 'compact', description: '压缩以上对话内容' },
					{ name: 'feedback', description: '发送关于当前会话的反馈' },
					{ name: 'goal', description: '设置或查看长期任务目标' },
				]
			},
			async execute(target, line) {
				executed.push({ sessionId: target.id, line })
				if (line.startsWith('/unknown')) return undefined
				return { commandId: 'c1', result: { kind: 'success', text: '已压缩' } }
			},
		},
	})
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })

	// 菜单：桥命令 + 1 个二级菜单（feedback 被排除，只剩 compact/goal）
	const panel = await rpc(boot.socketPath, 'panel')
	const groups = panel.value.menuItems.filter((item) => item.type === 'menu')
	assert.equal(groups.length, 1, 'dsh 命令应收进二级菜单')
	assert.equal(groups[0].name, 'dsh 命令')
	assert.deepEqual(
		groups[0].children.map((child) => child.name),
		['compact', 'goal'],
		'feedback 不收纳；技能本来就不在命令表里',
	)
	assert.equal(groups[0].children[0].sendMessage, '/compact', '点击把 /命令 填进输入框')
	assert.equal(panel.value.menuItems.filter((i) => i.type !== 'menu').length, 7, '顶层仍是 7 条桥命令')

	// 绑定会话
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M1' })
	await waitFor(async () => (await pumpQueue(boot.socketPath)).length > 0)

	// /compact 直接执行，且不进模型
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '/compact', msgId: 'M2' })
	await waitFor(() => executed.length === 1)
	assert.equal(executed[0].sessionId, 'session-1')
	assert.equal(executed[0].line, '/compact')
	assert.equal(agent.followed.length, 0, '内置命令不该被当成提示词发给模型')
	const ack = await waitFor(async () => {
		const list = await pumpQueue(boot.socketPath)
		return list.find((c) => c.kind === 'send_c2c' && String(c.args.content).includes('已压缩')) ?? null
	})
	assert.ok(ack, '命令结果要回给 QQ')

	// /feedback 被排除 → 当作普通消息进会话
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '/feedback 很好用', msgId: 'M3' })
	await waitFor(() => agent.followed.length === 1)
	assert.equal(executed.length, 1, 'feedback 不该走命令执行')
	assert.equal(agent.followed[0].content[0].text, '/feedback 很好用')

	// 认不出的斜杠命令 → 回退成普通消息
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '/unknown 参数', msgId: 'M4' })
	await waitFor(() => agent.followed.length === 2)
	assert.equal(agent.followed[1].content[0].text, '/unknown 参数')
})

test('提问桥：ask_user_question 的 waterfall 在 QQ 侧发卡片，点选项后结算', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M1' })
	await waitFor(async () => (await pumpQueue(boot.socketPath)).length > 0)

	// 触发 waterfall：index.js 用 prepend 抢在浏览器转发回答者之前
	const handler = boot.events.get('user-questions/request')?.[0]
	assert.ok(handler, '应注册 user-questions/request 监听')

	let nextCalled = false
	const answer = handler(
		{
			agent,
			questions: [
				{
					id: 'q1',
					header: '部署方式',
					question: '怎么上线？',
					options: [
						{ label: '直接上线', description: '影响面小' },
						{ label: '先灰度', description: '需要开关' },
					],
				},
			],
			signal: { aborted: false, addEventListener() {} },
		},
		async () => {
			nextCalled = true
			return { answers: [] }
		},
	)

	// QQ 侧收到提问卡片（按钮只写字母，对照在正文里）
	const card = await waitFor(async () => {
		const list = await pumpQueue(boot.socketPath)
		return list.find((c) => c.kind === 'send_c2c' && /提问/.test(String(c.args.content))) ?? null
	})
	assert.match(card.args.content, /\*\*A\.\*\* 直接上线/)
	assert.match(card.args.content, /> 影响面小/)
	const letterButton = card.args.keyboard.content.rows.flatMap((r) => r.buttons).find((b) => b.render_data.label === 'A')
	assert.ok(letterButton, '按钮应为字母')

	// 用户点 A
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: letterButton.action.data,
		eventId: 'INT-Q1',
		msgId: 'CARD-Q',
	})
	await waitFor(async () => {
		const list = await pumpQueue(boot.socketPath)
		return list.some((c) => c.kind === 'recall_c2c')
	}, { timeoutMs: 3000 })

	// 点提交 → waterfall 拿到答案（callId 用插件自己的解析结果，别手工切字符串）
	const clicked = parseCallback(letterButton.action.data)
	assert.equal(clicked.kind, 'question')
	assert.ok(clicked.callId)
	const submit = cardData.question(clicked.callId, 0, 'submit')
	await rpc(boot.socketPath, 'event', { kind: 'interaction', openid: 'U1', buttonData: submit, eventId: 'INT-Q2', msgId: 'CARD-Q2' })

	const result = await answer
	assert.equal(nextCalled, false, 'QQ 侧答了就不该交回 GUI')
	assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['直接上线'] }] })

	// 卡片撤回后要留一条结果预览：否则用户答完就再也看不到自己答了什么
	const preview = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /提问结果/.test(String(c.args.content))) ?? null
	})
	assert.match(preview.args.content, /1\. 部署方式 · 怎么上线？/)
	assert.match(preview.args.content, /✅ 直接上线/)
	boot.dispose()
})

// 这条守卫是补票：用户发现"等提问作答时打命令，会被提问桥当成「其他」答案"。
test('待答提问期间：桥命令优先执行，不会被当成「其他」答案', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M1' })
	await waitFor(async () => (await pumpQueue(boot.socketPath)).length > 0)

	const handler = boot.events.get('user-questions/request')?.[0]
	assert.ok(handler, '应注册 user-questions/request 监听')
	let nextCalled = false
	const answer = handler(
		{
			agent,
			questions: [{ id: 'q1', header: '随便问', question: '选一个？', options: [{ label: '甲' }, { label: '乙' }] }],
			signal: { aborted: false, addEventListener() {} },
		},
		async () => {
			nextCalled = true
			return { answers: [] }
		},
	)

	const card = await waitFor(async () => {
		const list = await pumpQueue(boot.socketPath)
		return list.find((c) => c.kind === 'send_c2c' && /提问/.test(String(c.args.content))) ?? null
	})
	const before = await rpc(boot.socketPath, 'health')
	assert.equal(before.value.pendingQuestions, 1, '提问应处于待答状态')

	// 关键：待答期间发一条桥命令 —— 必须执行命令，而不是当答案、也不该把提问消费掉
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '停止', msgId: 'M2' })
	const stopReply = await waitFor(async () => {
		const list = await pumpQueue(boot.socketPath)
		return list.find((c) => c.kind === 'send_c2c' && /已请求停止|没停成/.test(String(c.args.content))) ?? null
	})
	assert.ok(stopReply, '命令必须真的执行（而不是被提问桥当「其他」答案吃掉）')
	assert.equal(nextCalled, false, '命令不该让提问结算')

	const after = await rpc(boot.socketPath, 'health')
	assert.equal(after.value.pendingQuestions, 1, '命令之后提问仍然待答')

	// 收尾：这题还能正常答完（命令没把提问搞坏）
	const letterButton = card.args.keyboard.content.rows
		.flatMap((row) => row.buttons)
		.find((b) => b.render_data.label === 'A')
	const clicked = parseCallback(letterButton.action.data)
	await rpc(boot.socketPath, 'event', { kind: 'interaction', openid: 'U1', buttonData: letterButton.action.data, eventId: 'INT-C1', msgId: 'C1' })
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: cardData.question(clicked.callId, 0, 'submit'),
		eventId: 'INT-C2',
		msgId: 'C2',
	})
	const settledAnswers = await answer
	assert.deepEqual(settledAnswers, { answers: [{ id: 'q1', selected: ['甲'] }] })
	assert.equal(nextCalled, false)
	boot.dispose()
})

test('端到端：输入态——附件只能走卡片上的「发送」；裸发附件被丢弃并提示', async (t) => {
	const fetchStub = stubFetch(16)
	t.after(() => fetchStub.restore())
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })

	// 先绑定会话
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M1' })
	await drainFor(boot.socketPath, 60)
	assert.equal(agent.followed.length, 0)

	// 0) 没进输入态时直接发附件：丢弃 + 回一句提示，且**不进会话**
	await rpc(boot.socketPath, 'event', {
		kind: 'c2c_message',
		openid: 'U1',
		text: '',
		msgId: 'M-STRAY',
		attachments: [{ kind: 'image', contentType: 'image/png', filename: 'stray.png', size: 100, url: 'https://x/stray.png' }],
	})
	const stray = await waitFor(async () => (await drainFor(boot.socketPath, 40)).find((c) => c.kind === 'send_c2c'))
	assert.match(stray.args.content, /已丢弃/)
	assert.equal(agent.followed.length, 0, '裸发的附件绝不能进会话')
	assert.equal(fetchStub.calls.length, 0, '被丢弃的附件不该下载')
	assert.equal(boot.attachments.images.length, 0)

	// 1) 裸发 `发送` → 进入输入态：回一句说明 + 一张预览卡片
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '发送', msgId: 'M2' })
	const entered = await drainFor(boot.socketPath, 80)
	const card = entered.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1)
	assert.ok(card, '进入输入态要发预览卡片')
	assert.match(card.args.content, /输入框/)
	assert.equal(card.args.markdown, true, '带键盘的卡片必须是 markdown')
	const cardButtons = () => card.args.keyboard.content.rows.flatMap((row) => row.buttons)
	assert.ok(cardButtons().some((b) => b.render_data.label === '发送'), '卡片上要有「发送」')
	assert.equal(agent.followed.length, 0, '进输入态不该投给 AI')

	// 2) 输入态里发文字：攒成正文，只回卡片，**不投给 AI**
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '看看这张图', msgId: 'M3' })
	const afterText = await drainFor(boot.socketPath, 80)
	const textCard = afterText.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1)
	assert.match(textCard.args.content, /看看这张图/)
	assert.equal(agent.followed.length, 0, '输入态里的文字不该直接投给 AI')

	// 3) 输入态里发图片：自动下载进附件服务，并入列成 A1
	await rpc(boot.socketPath, 'event', {
		kind: 'c2c_message',
		openid: 'U1',
		text: '',
		msgId: 'M4',
		attachments: [{ kind: 'image', contentType: 'image/png', filename: 'cat.png', size: 100, url: 'https://x/cat.png' }],
	})
	const afterImage = await waitFor(async () => {
		const commands = await drainFor(boot.socketPath, 60)
		return commands.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1) ?? null
	})
	assert.match(afterImage.args.content, /A1/)
	assert.match(afterImage.args.content, /cat\.png/)
	assert.equal(boot.attachments.images.length, 1, '图片要存进 dsh 附件服务')
	assert.equal(boot.attachments.images[0].mediaType, 'image/png')
	assert.equal(agent.followed.length, 0)

	// 4) 点卡片上的「发送」→ 才真正投给 AI：分节消息（附件清单）+ 正文（含图片块）
	const sendButton = afterImage.args.keyboard.content.rows
		.flatMap((row) => row.buttons)
		.find((b) => b.render_data.label === '发送')
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: sendButton.action.data,
		eventId: 'INT-SEND',
		msgId: afterImage.args.messageId ?? 'CARD',
	})
	// followup 的语义是"独占一轮"：分两条发会让正文卡在待发送里（线上踩过），
	// 所以整次投递必须只有一条消息，附件清单是它自己的 content 块。
	await waitFor(() => agent.followed.length === 1)
	const delivered = agent.followed[0]
	assert.equal(delivered.form, undefined, '不该用 snapshot 形式：它就是用户这条消息')
	assert.match(delivered.content[0].text, /^## 用户随消息附带的附件/)
	assert.match(delivered.content[0].text, /A1 图片 cat\.png/)
	assert.equal(delivered.content[1].text, '看看这张图')
	assert.equal(delivered.content[2].type, 'image', '图片要以 image 块随正文走')
	assert.equal(delivered.content[2].attachment.attachmentId, 'img-1')

	// 卡片撤回后要留一条**最终预览**：把真正发出去的内容复述一遍
	const sentPreview = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /\*\*已发送\*\*/.test(String(c.args.content))) ?? null
	})
	assert.match(sentPreview.args.content, /看看这张图/)
	assert.match(sentPreview.args.content, /A1.*cat\.png/)

	// 投递后输入态被清空（状态文件是 200ms 防抖落盘，等它写完再读）
	await new Promise((resolve) => setTimeout(resolve, 260))
	const persisted = JSON.parse(readFileSync(boot.stateFile, 'utf8'))
	assert.equal(persisted.inbox?.U1, undefined, '投递后要清掉输入态')

	// 5) 语音没有平台转写 → 拦不住就白拦了：这次发送必须被拒绝
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '发送', msgId: 'M5' })
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', {
		kind: 'c2c_message',
		openid: 'U1',
		text: '',
		msgId: 'M6',
		attachments: [{ kind: 'voice', contentType: 'voice', url: 'https://x/voice.silk' }],
	})
	const voiceCard = await waitFor(async () => {
		const commands = await drainFor(boot.socketPath, 60)
		return commands.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1) ?? null
	})
	assert.match(voiceCard.args.content, /无法识别/)
	const beforeBlocked = agent.followed.length
	const voiceSend = voiceCard.args.keyboard.content.rows
		.flatMap((row) => row.buttons)
		.find((b) => b.render_data.label === '发送')
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: voiceSend.action.data,
		eventId: 'INT-VOICE',
		msgId: voiceCard.args.messageId ?? 'CARD2',
	})
	const blocked = await waitFor(async () => {
		const commands = await drainFor(boot.socketPath, 60)
		return commands.find((c) => c.kind === 'send_c2c' && /被拦住/.test(String(c.args.content))) ?? null
	})
	assert.match(blocked.args.content, /删除/)
	assert.equal(agent.followed.length, beforeBlocked, '有无法识别的语音时绝不能投递')

	// 6) 删掉那条无法识别的语音 + 补一条有转写的语音 → 能发送，且转写单独成块、
	//    不再被当成"没下载的附件"
	const deleteButton = voiceCard.args.keyboard.content.rows
		.flatMap((row) => row.buttons)
		.find((b) => b.render_data.label.startsWith('删除'))
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: deleteButton.action.data,
		eventId: 'INT-DEL',
		msgId: voiceCard.args.messageId ?? 'CARD2',
	})
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', {
		kind: 'c2c_message',
		openid: 'U1',
		text: '看看这个报错',
		msgId: 'M7',
		attachments: [{ kind: 'voice', contentType: 'voice', url: 'https://x/voice2.silk', asrText: '帮我查一下这个报错' }],
	})
	const finalCard = await waitFor(async () => {
		const commands = await drainFor(boot.socketPath, 60)
		return commands.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1) ?? null
	})
	assert.match(finalCard.args.content, /转写：帮我查一下这个报错/)
	const finalSend = finalCard.args.keyboard.content.rows
		.flatMap((row) => row.buttons)
		.find((b) => b.render_data.label === '发送')
	const actionRow = finalCard.args.keyboard.content.rows.at(-1).buttons.map((b) => b.render_data.label)
	assert.deepEqual(actionRow, ['取消', '清空正文', '发送'], '操作行必须是：取消在左、发送在右')
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: finalSend.action.data,
		eventId: 'INT-SEND2',
		msgId: finalCard.args.messageId ?? 'CARD3',
	})
	await waitFor(() => agent.followed.length === beforeBlocked + 1)
	const voiceMessage = agent.followed.at(-1)
	assert.match(voiceMessage.content[0].text, /^## 用户语音的平台转写/)
	assert.match(voiceMessage.content[0].text, /- A\d+：帮我查一下这个报错/)
	assert.equal(voiceMessage.content[1].text, '看看这个报错')
	assert.ok(
		!String(voiceMessage.content[0].text).includes('没有自动下载'),
		'语音只以文本进消息，不该再列成"没下载的附件"',
	)
	assert.equal(voiceMessage.content.length, 2, '没有其它附件时不该多出块')

	boot.dispose()
})

test('端到端：输入态已经有内容时，`发送 <别的会话>` 不会把攒的东西丢掉', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M1' })
	await drainFor(boot.socketPath, 60)

	// 进输入态并写正文
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '发送', msgId: 'M2' })
	await drainFor(boot.socketPath, 80)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '这段别弄丢了', msgId: 'M3' })
	await drainFor(boot.socketPath, 80)

	// 切到另一个会话：应当拒绝并说明，而不是静默清空
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '发送 session-2', msgId: 'M4' })
	const refused = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /没给你切/.test(String(c.args.content))) ?? null
	})
	assert.match(refused.args.content, /session-1/)
	assert.match(refused.args.content, /session-2/)

	// 正文还在：再写一句，卡片里应当两段都在
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '再来一句', msgId: 'M5' })
	const card = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1) ?? null
	})
	assert.match(card.args.content, /这段别弄丢了/)
	assert.match(card.args.content, /再来一句/)
	assert.match(card.args.content, /session-1/, '还在给原来的会话攒')
	boot.dispose()
})
