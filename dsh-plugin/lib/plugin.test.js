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
	}

	return {
		ctx,
		liveAgents,
		archived,
		events,
		dispose() {
			for (const disposer of disposers.reverse()) disposer()
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

test('register → panel：白名单快照 + 五条命令的面板定义（只绑定配置指定的私聊）', async (t) => {
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
		['切换会话', '发送', '停止', '归档', '延迟发送'],
	)
	// 扁平键 menuItems：与 Go 侧 PanelDefinition.MenuItems 对齐（大小写不敏感匹配）
	assert.equal(panel.value.menuItems.length, 5)
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
	const rootButtons = rootCard.args.keyboard.content.rows.flatMap((row) => row.buttons)
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

	assert.equal(agent.tools.length, 1, '应为该会话注册 qq_reply')
	assert.equal(agent.tools[0].name, REPLY_TOOL_NAME)
	assert.equal(agent.tools[0].parameters.type, 'object')

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
	assert.equal(busy.args.code, 2)
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

	// 发送：不打断（agent 处于 idle，仍然只投递一次）
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

	// 无参延迟发送 → 回用法（不再"查看待发消息"）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '延迟发送', msgId: 'M4' })
	const usage = await waitFor(async () => {
		const list = await pumpQueue(boot.socketPath)
		return list.find((c) => c.kind === 'send_c2c' && /作用：/.test(String(c.args.content))) ?? null
	})
	assert.match(usage.args.content, /延迟发送 <会话id> <内容>/)

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
	assert.equal(panel.value.menuItems.filter((i) => i.type !== 'menu').length, 5, '顶层仍有 5 条桥命令')

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
	boot.dispose()
})
