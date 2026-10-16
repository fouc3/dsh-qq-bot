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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name as pluginName, inject as pluginInject, HUMAN_SOURCE, PLUGIN_SOURCE } from '../index.js'
import { clipLabel, data as cardData, parseCallback } from './cards.js'
import { REPLY_TOOL_NAME } from './reply-tool.js'
import { ATTACHMENT_TOOL_NAME } from './attachment-tool.js'

// ── 假 dsh 服务 ─────────────────────────────────────────────────────────────

function makeAgent(sessionId) {
	const handlers = {}
	const tools = []
	let idleResolve = null
	let idlePromise = new Promise((resolve) => {
		idleResolve = resolve
	})
	const agent = {
		id: sessionId,
		status: 'idle',
		followed: [],
		cancelled: 0,
		handlers,
		tools,
		// 会话日志：兜底收尾（whenIdle + turn/end 的 reason）会读这里
		session: { id: sessionId, events: [] },
		/** 让 whenIdle() 结算：测试里手动模拟"这一轮真的结束了"。 */
		settleIdle(reason = 'completed', turn = 1) {
			agent.session.events.push({ type: 'turn/end', seq: agent.session.events.length + 1, data: { turn, reason: { kind: reason } } })
			const done = idleResolve
			idlePromise = new Promise((resolve) => {
				idleResolve = resolve
			})
			done?.()
		},
		/** 插件真的来等过吗？测试要等它挂上 whenIdle 再结算，否则会错过。 */
		whenIdleCalls: 0,
		whenIdle() {
			agent.whenIdleCalls += 1
			return idlePromise
		},
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
		// cordis 的 `ctx.get(name)`：按服务名取句柄（测试里就是同名属性；取不到返回 undefined）。
		get(name) {
			return typeof name === 'string' ? ctx[name] : undefined
		},
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
		/** 测试侧触发根作用域事件（等价于 dsh 在会话作用域上 emit 后冒泡到这里）。 */
		emit(event, ...args) {
			for (const handler of events.get(event) ?? []) handler(...args)
		},
		agents: {
			get: (id) => liveAgents.get(id),
			list: () => [...liveAgents.values()],
			/** 测试侧"换一个 agent 实例"（模拟 dsh 重新创建/接管同一个会话）。 */
			adopt(agent) {
				liveAgents.set(agent.id, agent)
			},
			async resume({ resumeSessionId }) {
				ctx.agents.rawResumeCalls.push(resumeSessionId)
				const agent = liveAgents.get(resumeSessionId) ?? makeAgent(resumeSessionId)
				liveAgents.set(resumeSessionId, agent)
				return { agent }
			},
			/** 记录裸 resume 次数：断言"冷会话不该走这条路"。 */
			rawResumeCalls: [],
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
			async create({ cwd }) {
				const sessionId = `session-created-${sessionSummaries.length + 1}`
				sessionSummaries.push({ sessionId, cwd, updatedAt: Date.now(), running: false })
				return { sessionId }
			},
			// 冷会话恢复：**和真实契约同形** —— `@deepseek-ai/dsh-api-session-controller`
			// 注册的 `sessionController` 服务面（≈ `ctx.remote.session`）只有 `resolveAgent`，
			// **没有** `resume`（`resume` 是内部 `ApiSessionAgentController` 的方法）。
			// 控制器恢复时会带上 agentOptions（模型）与 setup（预设=工具），所以插件必须走这条路
			// （裸 agents.resume 会造出没有模型/工具的 agent）。需要"只有 resume"的嵌入方式时，
			// 由测试自己临时挂一个（见「内部 resume」那条）。
			resolvedVia: [],
			async resolveAgent(sessionId) {
				ctx.sessionController.resolvedVia.push(sessionId)
				const agent = liveAgents.get(sessionId) ?? makeAgent(sessionId)
				liveAgents.set(sessionId, agent)
				return { agent }
			},
			// 模型：与 dsh 的 SessionController 同形（modelCatalog / selectModel / projections）。
			selectedModels: [],
			modelSelection: {},
			// 统计投影（sessionStats/tokenUsage/contextBreakdown/contextPressure）：
			// 默认 null = 这个部署没装统计插件 → `状态` 卡片就不出「统计」一节。
			stats: null,
			async modelCatalog() {
				return {
					default: { provider: 'deepseek', model: 'deepseek-chat' },
					routableProviders: ['deepseek', 'openai'],
					groups: [
						{
							id: 'deepseek',
							name: 'DeepSeek',
							models: [
								{ id: 'deepseek-chat', name: 'DeepSeek Chat', description: '通用对话' },
								{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: '深度推理' },
							],
						},
						{
							id: 'openai',
							name: 'OpenAI',
							models: [
								{ id: 'gpt-5.2', name: 'GPT 5.2', description: '' },
								{ id: 'gpt-5.2-codex', name: 'GPT 5.2 Codex', description: '' },
							],
						},
					],
					failures: [{ id: 'broken', name: 'Broken', message: '没 key' }],
				}
			},
			async selectModel({ sessionId, provider, model }) {
				if (model === 'boom') throw new Error('这个会话锁定了模型')
				ctx.sessionController.selectedModels.push({ sessionId, provider, model })
				ctx.sessionController.modelSelection[sessionId] = { provider, model }
				return { selected: { provider, model } }
			},
			async projections({ sessionId }) {
				const value = ctx.sessionController.modelSelection[sessionId]
				// 真实 dsh 里 `sessionController.projections()` 返回**所有**登记的会话投影视图：
				// `model/selection` 来自模型选择，`permissions` 来自 permissionPresets
				// （它的 wire view 就是 `{ currentValue: <预设> }`），四个统计视图来自
				// dsh-session-stats / dsh-token-meter。`状态` 卡片把这些都读出来。
				return {
					asOfSeq: 1,
					values: {
						...(value ? { 'model/selection': { lastUsed: value, pending: null } } : {}),
						permissions: { currentValue: ctx.permissionPresets.currentValue },
						...(ctx.sessionController.stats ?? {}),
					},
				}
			},
		},
		workspaceRegistry: {
			archivedSessionIds: [],
			workspaces: [],
			async archiveSession(sessionId) {
				archived.push(sessionId)
			},
			/** 与 dsh-workspace 的 create 同形：返回实体，实体上有 attachSession。 */
			async create(path, title) {
				// 真实实现会 realpath + 校验"必须已存在的目录"，这里对齐这条契约
				if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`cannot create a Workspace at "${path}": not a directory`)
				const existing = ctx.workspaceRegistry.workspaces.find((item) => item.path === path)
				if (existing) return existing
				const entity = {
					id: `ws-${ctx.workspaceRegistry.workspaces.length + 1}`,
					path,
					title: title ?? path,
					attached: [],
					async attachSession(sessionId) {
						this.attached.push(sessionId)
					},
				}
				ctx.workspaceRegistry.workspaces.push(entity)
				return entity
			},
		},
		attachments: makeAttachmentStore(),
		permissionPresets: {
			currentValue: 'workspace-write',
			setCalls: [],
			catalog() {
				return {
					options: [
						{ value: 'read-only', name: '仅可查看', description: '只能看，不能改' },
						{ value: 'workspace-write', name: '工作区内修改', description: '工作区内可写' },
						{ value: 'danger-full-access', name: '完全权限', description: '不限制' },
					],
					defaultOptions: [],
					defaultPreset: 'workspace-write',
				}
			},
			current() {
				return ctx.permissionPresets.currentValue
			},
			set(session, value) {
				const known = ['read-only', 'workspace-write', 'danger-full-access']
				if (!known.includes(value)) throw new Error(`unknown preset '${value}'`)
				ctx.permissionPresets.currentValue = value
				ctx.permissionPresets.setCalls.push({ sessionId: session?.id, value })
			},
		},
		// dsh 的目标服务（`ctx.goals`）：打断后桥要按"打断前是不是运行中"决定要不要重新武装。
		// `state` 由测试直接摆（null = 这个会话没有目标）；get() 返回**拷贝**，免得插件改到我们的状态。
		goals: {
			state: null,
			resumeCalls: [],
			disarmCalls: [],
			get() {
				if (!this.state) return undefined
				return { roundsStarted: 1, createdAt: 0, updatedAt: 0, maxGoalRounds: 60, ...this.state }
			},
			resume(agent, ref) {
				if (!this.state) throw new Error('no current goal')
				if (ref.id !== this.state.id || ref.revision !== this.state.revision) {
					throw new Error(`goal revision mismatch: ${ref.revision} != ${this.state.revision}`)
				}
				this.resumeCalls.push({ sessionId: agent?.id, ref: { ...ref } })
				this.state = { ...this.state, phase: 'active', activation: 'armed', revision: this.state.revision + 1 }
				return { ...this.state }
			},
			disarm() {
				if (!this.state) return undefined
				this.disarmCalls.push({ ...this.state })
				this.state = { ...this.state, activation: 'disarmed' }
				return { ...this.state }
			},
			pause() {
				if (!this.state) return undefined
				this.state = { ...this.state, phase: 'paused', activation: 'disarmed', revision: this.state.revision + 1 }
				return { ...this.state }
			},
		},
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

function bootPlugin(
	t,
	{ sessions: summaries, live, token = '', commands = null, config = {}, stateSeed = null, dir: reuseDir = null, socket = 'bridge.sock' } = {},
) {
	// `dir` 用来**同一个状态文件启第二次**（模拟重启后的持久化验证）；`socket` 换个名字免得两次抢同一个路径。
	const dir = reuseDir ?? mkdtempSync(join(tmpdir(), 'dsh-qq-bot-'))
	const socketPath = join(dir, socket)
	const stateFile = join(dir, 'state.json')
	if (stateSeed) writeFileSync(stateFile, JSON.stringify(stateSeed))
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

test('register → panel：白名单快照 + 十条命令的面板定义（只绑定配置指定的私聊）', async (t) => {
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
	assert.deepEqual(panel.value.items.map((item) => item.name), [
		'切换会话',
		'运行中会话',
		'快捷',
		'新建会话',
		'状态',
		'发送',
		'停止',
		'归档',
		'延迟发送',
		'权限',
		'模型',
	])
	// 扁平键 menuItems：与 Go 侧 PanelDefinition.MenuItems 对齐（大小写不敏感匹配）
	// 顶层 8 项 = 7 个平铺 + 1 个「管理」二级菜单（停止/归档/权限/运行中会话）+ 2 个 dsh 命令二级菜单 = 10（平台上限）。
	assert.equal(panel.value.menuItems.length, 8)
	assert.equal(panel.value.menuItems[0].name, '切换会话')
	assert.equal(panel.value.menuItems[0].sendMessage, '切换会话')
	assert.equal(panel.value.menuItems[1].sendMessage, '快捷')
	const manageGroup = panel.value.menuItems.find((item) => item.type === 'menu')
	assert.equal(manageGroup.name, '管理')
	assert.deepEqual(manageGroup.children.map((child) => child.name), ['停止', '归档', '权限', '运行中会话'])
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

// 用户要求（2026-10-16）：新增 `运行中会话`（列出**正在跑**的会话，点按钮**直接切过去**），
// 并在「切换会话」卡片的「返回上级」与「不指定会话」之间也放一个入口按钮。
test('端到端：运行中会话 —— 只列正在跑的；点按钮直接切过去并重发卡片；切换会话卡片里有入口', async (t) => {
	const sessions = [
		{ sessionId: 'session-1', cwd: '/home/u/proj-a', updatedAt: 9, running: true },
		{ sessionId: 'session-2', cwd: '/home/u/proj-b', updatedAt: 8, running: false },
		{ sessionId: 'session-3', cwd: '/home/u/proj-c', updatedAt: 7, running: true },
	]
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await drainFor(boot.socketPath, 60)

	// ① 命令：只列正在跑的（session-1 / session-3），空闲的 session-2 不出现
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '运行中会话', msgId: 'M1' })
	const card = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /\*\*运行中会话\*\*/.test(String(c.args.content))) ?? null
	})
	assert.match(String(card.args.content), /共 2 个正在跑/)
	assert.doesNotMatch(String(card.args.content), /proj-b/, '空闲会话不该出现在"运行中"卡片里')
	const buttons = card.args.keyboard.content.rows.flatMap((row) => row.buttons)
	assert.deepEqual(buttons.map((b) => b.action.data).sort(), ['qqb:run:session-1?page=1', 'qqb:run:session-3?page=1'])
	assert.deepEqual(buttons.map((b) => b.render_data.label).sort(), ['1', '2'], '按钮只写编号（用户要求）')
	assert.equal(buttons[0].action.type, 1, '回调按钮：点一下当场切')

	// ② 点 session-3（第 2 个编号）：绑定切过去 + 回执 + 回应互动
	const target = buttons.find((b) => b.action.data.startsWith('qqb:run:session-3'))
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: target.action.data,
		eventId: 'INT-RUN',
		msgId: 'CARD-RUN',
	})
	const after = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.some((c) => c.kind === 'send_c2c' && /已接入/.test(String(c.args.content))) ? list : null
	})
	assert.ok(
		after.some((c) => c.kind === 'respond_interaction' && c.args.code === 0),
		'要回应互动（code=0）',
	)
	const bound = await waitFor(() => {
		try {
			return JSON.parse(readFileSync(boot.stateFile, 'utf8')).bindings?.U1 ?? null
		} catch {
			return null
		}
	})
	assert.equal(bound, 'session-3', '点一下就该切过去')

	// ③ 「切换会话」卡片的导航行里有这个入口，且夹在「返回上级」与「不指定会话」之间
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话', msgId: 'M2' })
	const switchCard = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /\*\*切换会话\*\*/.test(String(c.args.content))) ?? null
	})
	const nav = switchCard.args.keyboard.content.rows.at(-1).buttons.map((b) => b.render_data.label)
	assert.ok(nav.length <= 3, `导航行最多 3 个按钮（实际 ${nav.join('/')}）`)
	assert.equal(nav[0], '返回上级', '顺序：返回上级 → 运行中会话 → 不指定会话')
	assert.equal(nav[1], '运行中会话')
	assert.equal(nav[2], '不指定会话')

	boot.dispose()
})

test('端到端：运行中会话翻页 —— 12 个一页，第 5 行「下一页」，翻过去只列剩下的', async (t) => {
	const sessions = Array.from({ length: 14 }, (_, i) => ({
		sessionId: `session-${i + 1}`,
		cwd: `/home/u/p${i + 1}`,
		updatedAt: 100 - i,
		running: true,
	}))
	const boot = bootPlugin(t, { sessions, live: {} })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await drainFor(boot.socketPath, 60)

	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '运行中会话', msgId: 'M1' })
	const page1 = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /\*\*运行中会话\*\*/.test(String(c.args.content))) ?? null
	})
	assert.match(String(page1.args.content), /共 14 个正在跑 · 第 1\/2 页（每页 12 个）/)
	const rows1 = page1.args.keyboard.content.rows
	assert.equal(rows1.length, 5, '4 行编号 + 1 行翻页（平台 5 行上限）')
	assert.equal(rows1[4].buttons[0].render_data.label, '下一页')

	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: rows1[4].buttons[0].action.data,
		eventId: 'INT-P2',
		msgId: 'CARD-P1',
	})
	const page2 = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /第 2\/2 页/.test(String(c.args.content))) ?? null
	})
	assert.equal(page2.args.keyboard.content.rows[0].buttons.length, 2, '第 2 页只剩 2 个')
	assert.deepEqual(page2.args.keyboard.content.rows[0].buttons.map((b) => b.render_data.label), ['1', '2'])
	assert.deepEqual(page2.args.keyboard.content.rows[1].buttons.map((b) => b.render_data.label), ['上一页'])

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
	// 用户本人在 QQ 里打的字 → 标成**人类输入**（dsh 里 create_goal / update_goal resume
	// 这类"只认人类直接输入"的动作靠的就是这个 kind；插件只是那根线，不该把授权吞掉）。
	assert.equal(agent.followed[0].source.kind, 'user')
	assert.equal(HUMAN_SOURCE.kind, 'user')
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
	const noticeButtons = notice.args.keyboard.content.rows[0].buttons
	assert.equal(noticeButtons[0].render_data.label, '我需要回复')
	assert.equal(noticeButtons[0].action.data, cardData.needReply('session-1'))
	// 「发送消息」是指令按钮：只把「发送 <会话id>」填进输入框（进那个会话的输入态）
	assert.equal(noticeButtons[1].render_data.label, '发送消息')
	assert.equal(noticeButtons[1].action.type, 2)
	assert.equal(noticeButtons[1].action.data, '发送 session-1')

	boot.dispose()
})

// 用户要求（2026-10-16）：`reason=error` 的收尾**不能再说成"被打断"** —— 通知要写
// 「出现错误」并把**具体报错**带出来（线上踩过：`{{model}}` 那个错全被渲染成"被打断"，
// 用户以为是被谁打断的，看不出是模型/配置问题）。
test('端到端：一轮以 reason=error 结束 → 通知写「出现错误」+ 具体报错', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M0' })
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '跑一下', msgId: 'M1' })
	await waitFor(() => agent.followed.length === 1)

	// 认领这一轮，再让它以 error 收尾（形状照 dsh 的 TurnEndReasonMap）
	agent.handlers['session/event'](null, { type: 'turn/start', data: { turn: 1 } })
	const failure =
		'prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")'
	agent.handlers['session/event'](null, {
		type: 'turn/end',
		data: { turn: 1, reason: { kind: 'error', error: { message: failure, code: 'UNKNOWN' } } },
	})

	const notice = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /出现错误/.test(String(c.args.content))) ?? null
	})
	assert.equal(String(notice.args.content), `proj-a(session-1)出现错误\n> 错误：${failure}`)
	assert.doesNotMatch(String(notice.args.content), /被打断/, '出错的措辞必须和"被打断"分开')
	// 按钮照旧：错误卡也要能点「我需要回复」
	assert.equal(notice.args.keyboard.content.rows[0].buttons[0].render_data.label, '我需要回复')

	// 小日志（插件日志进不了 journald，线上只有这里能看）要能看出"出错"和具体报错
	const noted = await waitFor(() => {
		try {
			return JSON.parse(readFileSync(boot.stateFile, 'utf8')).notes.find((line) => /通知已入队：出现错误/.test(line)) ?? null
		} catch {
			return null
		}
	})
	assert.match(noted, /has no value/, '小日志里要带上具体报错')

	boot.dispose()
})

// 用户要求（2026-10-16）：目标/计划**自动续跑**出来的轮次，只要唤醒链能追到"QQ 用户唤醒"的
// 那一轮，就**按用户唤醒算** —— 也要发结束通知（否则长任务一跑起来，QQ 侧就一片安静）。
// 判据用 `state.chainWakes`：我们投递的轮次记 'qq'，计划轮次沿用；**不是我们投的**用户消息
// （在 dsh web 里新起一轮）会把链清掉 —— 那条链不该再往 QQ 发通知。
test('端到端：计划/目标续跑的轮次沿用用户唤醒（也发通知），链断了就不发', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	const emit = (event) => agent.handlers['session/event'](null, event)
	const notices = []

	// 1) 用户从 QQ 起一轮 → 通知（同时这条链被记成"从 QQ 起的"）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M0' })
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '开始长任务', msgId: 'M1' })
	await waitFor(() => agent.followed.length === 1)
	emit({ type: 'turn/start', data: { turn: 1 } })
	emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
	const first = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		notices.push(...list.filter((c) => c.kind === 'send_c2c' && /已结束/.test(String(c.args.content))))
		return notices[0] ?? null
	})
	assert.equal(first.args.content, 'proj-a(session-1)已结束')

	// 2) 计划/目标续跑（本桥没有该轮次）：驱动消息 source.kind='goal' → 建"只发通知"的记录
	emit({ type: 'turn/start', data: { turn: 2 } })
	emit({ type: 'user/message', data: { source: { kind: 'goal' }, content: [{ type: 'text', text: '继续切片' }] } })
	const chained = await waitFor(() => {
		try {
			return JSON.parse(readFileSync(boot.stateFile, 'utf8')).notes.find((line) => /计划轮次开始/.test(line)) ?? null
		} catch {
			return null
		}
	})
	assert.match(chained, /turn=2/, '计划轮次要建"只发通知"的记录')
	emit({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
	await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		notices.push(...list.filter((c) => c.kind === 'send_c2c' && /已结束/.test(String(c.args.content))))
		return notices.length >= 2
	})
	assert.equal(notices[1].args.content, 'proj-a(session-1)已结束', '续跑的那一轮也发通知')
	assert.equal(notices[1].args.keyboard.content.rows[0].buttons[0].render_data.label, '我需要回复')

	// 3) 还没断链：再续一轮照样发
	emit({ type: 'turn/start', data: { turn: 3 } })
	emit({ type: 'user/message', data: { source: { kind: 'goal' }, content: [{ type: 'text', text: '再切一片' }] } })
	emit({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
	await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		notices.push(...list.filter((c) => c.kind === 'send_c2c' && /已结束/.test(String(c.args.content))))
		return notices.length >= 3
	})

	// 4) 链断了：dsh web 里新起一轮（不是本桥投的 kind=user）→ 之后的目标轮**不发**通知
	emit({ type: 'turn/start', data: { turn: 4 } })
	emit({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '（在 web 里发的）' }] } })
	const broken = await waitFor(() => {
		try {
			return JSON.parse(readFileSync(boot.stateFile, 'utf8')).notes.find((line) => /唤醒链断了/.test(line)) ?? null
		} catch {
			return null
		}
	})
	assert.match(broken, /turn=4/)
	emit({ type: 'turn/start', data: { turn: 5 } })
	emit({ type: 'user/message', data: { source: { kind: 'goal' }, content: [{ type: 'text', text: '目标又续了一轮' }] } })
	emit({ type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
	const rest = await drainFor(boot.socketPath, 120)
	notices.push(...rest.filter((c) => c.kind === 'send_c2c' && /已结束/.test(String(c.args.content))))
	assert.equal(notices.length, 3, '链断之后的目标轮不该再发通知')
	const noNotice = await waitFor(() => {
		try {
			return JSON.parse(readFileSync(boot.stateFile, 'utf8')).notes.find((line) => /计划轮次不发通知/.test(line)) ?? null
		} catch {
			return null
		}
	})
	assert.match(noNotice, /turn=5/)

	boot.dispose()
})

// 用户要求（2026-10-16）：新增「已开始」通知。两个例外：
//   ① 一条 QQ 消息**打断**上一轮时不另发开始卡，而是把那句并进「被打断」卡（防刷屏）；
//   ② `发送`/`快捷 <目标> <消息>`/「我需要回复」**自己的回执已经说明"开跑了"** → 也不另发
//      （用户要求："对于这个发送和快捷命令已经有提示的就不加了"）。
test('端到端：开始通知（普通消息发；打断时并进被打断卡；命令已提示的不发）', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M0' })
	await drainFor(boot.socketPath, 60)
	const emit = (event) => agent.handlers['session/event'](null, event)
	const drainAll = async (ms = 80) => drainFor(boot.socketPath, ms)

	// ① 空闲时发一条普通消息 → 有「已开始」卡（和结束卡同一套按钮）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '第一件事', msgId: 'M1' })
	const start = await waitFor(async () => {
		const list = await drainAll()
		return list.find((c) => c.kind === 'send_c2c' && /已开始/.test(String(c.args.content))) ?? null
	})
	assert.equal(String(start.args.content), 'proj-a(session-1)已开始')
	assert.equal(start.args.keyboard.content.rows[0].buttons[0].render_data.label, '我需要回复')
	emit({ type: 'turn/start', data: { turn: 1 } })

	// ② 运行中再发一条**普通消息** → 不另发开始卡；「被打断」卡里并进"已按这条消息开了新一轮"
	agent.status = 'running'
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '改个方向', msgId: 'M2' })
	const interrupted = await waitFor(async () => {
		const list = await drainAll()
		return list.find((c) => c.kind === 'send_c2c' && /被打断/.test(String(c.args.content))) ?? null
	})
	assert.equal(
		String(interrupted.args.content),
		'proj-a(session-1)被打断\n> 打断来自：改个方向\n> 已按这条消息开了新一轮',
	)
	const window1 = await drainAll()
	assert.equal(window1.filter((c) => /已开始/.test(String(c.args.content))).length, 0, '打断时不另发开始卡')
	emit({ type: 'turn/start', data: { turn: 2 } })

	// ③ `发送 <目标> <内容>`：回执已经写了"会打断…" → 被打断卡里**不**再并那句话（也不发开始卡）
	let said = []
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '发送 session-1 插一条', msgId: 'M3' })
	const hinted = await waitFor(async () => {
		const list = await drainAll()
		said = said.concat(list)
		return list.find((c) => c.kind === 'send_c2c' && /被打断/.test(String(c.args.content))) ?? null
	})
	assert.equal(String(hinted.args.content), 'proj-a(session-1)被打断\n> 打断来自：插一条')
	said = said.concat(await drainAll())
	assert.equal(said.filter((c) => /已开始/.test(String(c.args.content))).length, 0, '命令已提示过 → 不发开始卡')
	assert.ok(
		said.some((c) => c.kind === 'send_c2c' && /会打断正在跑的轮次/.test(String(c.args.content))),
		'`发送` 自己的回执里带着"会打断"的提示',
	)

	// ④ 计划/目标续跑（唤醒链追到 QQ 用户）→ **发**开始卡，并说明是续跑
	emit({ type: 'turn/start', data: { turn: 3 } })
	emit({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
	await drainAll()
	emit({ type: 'turn/start', data: { turn: 4 } })
	emit({ type: 'user/message', data: { source: { kind: 'goal' }, content: [{ type: 'text', text: '继续切片' }] } })
	const chainStart = await waitFor(async () => {
		const list = await drainAll()
		return list.find((c) => c.kind === 'send_c2c' && /已开始/.test(String(c.args.content))) ?? null
	})
	assert.equal(String(chainStart.args.content), 'proj-a(session-1)已开始\n> 目标/计划续跑（沿用你从 QQ 起的那条链）')

	boot.dispose()
})

// 线上事故（2026-10-15，10-16 又踩两次）：插件自己 `ctx.agents.resume({resumeSessionId})`
// 唤醒冷会话，造出的 agent **没有模型、没有预设/工具** → 系统提示词里 `{{model}}` 取不到值
// （`prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`）
// 且"编码工具全没了"（bash/Edit/Read…）。dsh 自己的控制器恢复时会带上 agentOptions 与 setup：
//   ctx.agents.resume({ resumeSessionId, agentOptions, setup: composition.setup })
// **真根因**：公开契约里没有 `sessionController.resume` —— 服务面只有 `resolveAgent` /
// `inspect` / `selectModel` / `prompt` / …（`resume` 是内部 `ApiSessionAgentController` 的方法），
// 所以旧代码 `typeof controller.resume === 'function'` 恒为假，**每一条** QQ 冷唤醒都掉进裸恢复兜底。
// 现在的默认 fake 与真实契约同形（只有 resolveAgent、没有 resume），这条测试就是那个回归。
test('冷会话恢复：契约面（只有 resolveAgent、没有 resume）必须走 resolveAgent，不能裸 agents.resume', async (t) => {
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: {} })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', {
		openids: [{ openid: 'U1' }],
		panel: { enabled: true, users: ['U1'] },
		menu: { enabled: true },
	})
	// session-2 不在 live 里 = 冷会话
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-2', msgId: 'M1' })
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '冷会话消息', msgId: 'M2' })

	const agent = await waitFor(() => boot.ctx.agents.get('session-2') ?? null)
	await waitFor(() => agent.followed.length > 0)
	assert.equal(typeof boot.ctx.sessionController.resume, 'undefined', '前置条件：契约面**没有** resume（真实 dsh 就是这样）')
	assert.ok(boot.ctx.sessionController.resolvedVia.includes('session-2'), '冷会话要走控制器的 resolveAgent')
	assert.deepEqual(boot.ctx.agents.rawResumeCalls, [], '绝不能退回裸 agents.resume（会造出没模型/没工具的 agent）')
	assert.equal(agent.followed.at(-1).content[0].text, '冷会话消息', '恢复出来的 agent 要真的收到消息')
	assert.equal(agent.followed.at(-1).source.kind, 'user')
	const notes = await waitFor(() => {
		try {
			return JSON.parse(readFileSync(boot.stateFile, 'utf8')).notes.find((line) => /resolveAgent ✓/.test(line)) ?? null
		} catch {
			return null
		}
	})
	assert.match(notes, /sessio/i, '小日志要记一笔走了哪条恢复入口（插件日志进不了 journald）')

	boot.dispose()
})

// 顺手修（用户 2026-10-16）：那行诊断日志以前写 `String(sessionId).slice(0, 8)` ⇒ 取到的是
// `session-` 这个**前缀**，id 全被吃掉（线上看到的正是 `冷会话恢复：resolveAgent ✓ session-`）。
// 全库小日志都用 `slice(-8)`（会话id 尾部），这里补一条**真能抓住**它的回归用例 ——
// 老用例只 match /sessio/i，坏写法也能过，所以一直没被发现。
test('冷会话恢复：小日志要写得出会话id（尾部 8 位），不能只剩 `session-` 前缀', async (t) => {
	const longId = 'session-ca96b214-668a-4bfc-b218-dc7a7f92ee43'
	const boot = bootPlugin(t, {
		sessions: [{ sessionId: longId, cwd: '/home/u/proj-a', updatedAt: 1, running: false }],
		live: {},
	})
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: `切换会话 ${longId}`, msgId: 'M1' })
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '冷会话消息', msgId: 'M2' })
	await waitFor(() => boot.ctx.agents.get(longId) ?? null)

	const notes = await waitFor(() => {
		try {
			const parsed = JSON.parse(readFileSync(boot.stateFile, 'utf8'))
			return parsed.notes.find((line) => /冷会话恢复：resolveAgent ✓/.test(line)) ?? null
		} catch {
			return null
		}
	})
	assert.match(notes, /resolveAgent ✓ 7f92ee43（/, `要写 id 尾部（实际：${notes}）`)
	assert.doesNotMatch(notes, /resolveAgent ✓ session-（/, '不能只剩 `session-` 前缀')
	boot.dispose()
})

// 线上事故（2026-10-16，第二次踩）：恢复入口**抛错**时，老代码会回退到裸
// `ctx.agents.resume` —— 造出的坏 agent 被当成活 agent 缓存，于是**每条**后续消息都继续
// 报 `{{model}}` 那个错，直到用户手动切一次模型。现在：恢复入口失败 → 不回退，
// 如实回一句"打不开"，并把失败写进小日志。
test('冷会话恢复：控制器 resolveAgent 抛错时**不许**回退裸恢复（那会造出没模型的坏 agent）', async (t) => {
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: {} })
	boot.ctx.sessionController.resolveAgent = async () => {
		throw new Error('boom: resume failed')
	}
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', {
		openids: [{ openid: 'U1' }],
		panel: { enabled: true, users: ['U1'] },
		menu: { enabled: true },
	})
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-2', msgId: 'M1' })
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '冷会话消息', msgId: 'M2' })

	const reply = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /打不开/.test(String(c.args.content))) ?? null
	})
	assert.match(String(reply.args.content), /打不开/, '如实告诉用户这个会话现在打不开')
	assert.deepEqual(boot.ctx.agents.rawResumeCalls, [], '控制器抛错时**绝不能**裸恢复')
	assert.equal(boot.ctx.agents.get('session-2'), undefined, '也不该留下一个半死的 agent')
	const notes = await waitFor(() => {
		try {
			return JSON.parse(readFileSync(boot.stateFile, 'utf8')).notes.find((line) => /不回退裸恢复/.test(line)) ?? null
		} catch {
			return null
		}
	})
	assert.match(notes, /session-2|session2|sessio/i, '小日志要记一笔（插件日志进不了 journald）')

	boot.dispose()
})

// 某些嵌入方式把**内部**控制器的 `resume` 直接暴露出来（服务面上没有，但对象上有）：
// 那条路同样带模型与预设，是安全的，可以用。
test('冷会话恢复：只有内部 resume、没有 resolveAgent 时，走 resume（仍不许裸 agents.resume）', async (t) => {
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: {} })
	boot.ctx.sessionController.resolveAgent = undefined
	boot.ctx.sessionController.resumedVia = []
	boot.ctx.sessionController.resume = async (sessionId) => {
		boot.ctx.sessionController.resumedVia.push(sessionId)
		const agent = boot.ctx.agents.get(sessionId) ?? makeAgent(sessionId)
		boot.ctx.agents.adopt(agent)
		return agent
	}
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', {
		openids: [{ openid: 'U1' }],
		panel: { enabled: true, users: ['U1'] },
		menu: { enabled: true },
	})
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-2', msgId: 'M1' })
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '内部 resume 消息', msgId: 'M2' })

	const agent = await waitFor(() => boot.ctx.agents.get('session-2') ?? null)
	await waitFor(() => agent.followed.length > 0)
	assert.deepEqual(boot.ctx.sessionController.resumedVia, ['session-2'], '走内部控制器的 resume')
	assert.deepEqual(boot.ctx.agents.rawResumeCalls, [], '依然不许裸 agents.resume')
	assert.equal(agent.followed.at(-1).content[0].text, '内部 resume 消息')

	boot.dispose()
})

// 真根因回归的"探针方向"：如果**两个**恢复入口都没有，以前会掉进裸恢复（造坏 agent + 毒死会话）；
// 现在必须什么都不恢复 —— 如实回"打不开"，绝不留坏 agent。
test('冷会话恢复：没有任何控制器恢复入口时**绝不**裸恢复（如实报打不开）', async (t) => {
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: {} })
	boot.ctx.sessionController.resolveAgent = undefined
	boot.ctx.sessionController.resume = undefined
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', {
		openids: [{ openid: 'U1' }],
		panel: { enabled: true, users: ['U1'] },
		menu: { enabled: true },
	})
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-2', msgId: 'M1' })
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '没有入口的消息', msgId: 'M2' })

	const reply = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /打不开/.test(String(c.args.content))) ?? null
	})
	assert.match(String(reply.args.content), /打不开/)
	assert.deepEqual(boot.ctx.agents.rawResumeCalls, [], '没有恢复入口时也**绝不能**裸恢复')
	assert.equal(boot.ctx.agents.get('session-2'), undefined, '不该留下半死的坏 agent')
	const note = await waitFor(() => {
		try {
			return JSON.parse(readFileSync(boot.stateFile, 'utf8')).notes.find((line) => /没有可用的恢复入口/.test(line)) ?? null
		} catch {
			return null
		}
	})
	assert.match(note, /sessio/i, '小日志要记一笔（插件日志进不了 journald）')

	boot.dispose()
})

test('端到端：agent 作用域收不到事件时，根作用域的 session/event 也能认领轮次并发出「已结束」', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M0' })
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '你好', msgId: 'M1' })
	await waitFor(() => agent.followed.length === 1)

	// 只在**根作用域**上喂事件（模拟 agent 实例被换掉 / dsh 只把事件派发给会话范围内的观察者）
	boot.ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/start', data: { turn: 5 } })
	boot.ctx.emit('session/event', { id: 'session-1' }, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })

	const notice = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /已结束/.test(String(c.args.content))) ?? null
	})
	assert.equal(notice.args.content, 'proj-a(session-1)已结束')

	// 状态文件里的小日志要能看出"这轮是根作用域认领的、收尾成功"
	await waitFor(() => {
		try {
			const notes = JSON.parse(readFileSync(boot.stateFile, 'utf8')).notes ?? []
			return notes.some((line) => /认领轮次 turn=5（via root/.test(line))
		} catch {
			return false
		}
	})

	// 其它会话的事件不该被本桥吞掉（只处理"正在跟踪的轮次"）
	boot.ctx.emit('session/event', { id: 'session-other' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

	boot.dispose()
})

test('端到端：agent 实例被换掉后要重挂监听（否则「已结束」通知永远发不出来）', async (t) => {
	const first = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': first } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M0' })
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '第一条', msgId: 'M1' })
	await waitFor(() => first.followed.length === 1)
	assert.equal(typeof first.handlers['session/event'], 'function', '第一个实例挂上了监听')

	// dsh 把同一个会话换成另一个 agent 实例（重新创建/接管），插件下一次投递时必须挂到新实例上
	const second = makeAgent('session-1')
	boot.ctx.agents.adopt(second)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '第二条', msgId: 'M2' })
	await waitFor(() => second.followed.length === 1)
	assert.equal(
		typeof second.handlers['session/event'],
		'function',
		'换实例后必须重挂 —— 老代码只按 sessionId 记"已挂过"，新实例上什么都没有',
	)

	// 新实例上的事件要能正常收尾发通知
	second.handlers['session/event'](null, { type: 'turn/start', data: { turn: 9 } })
	second.handlers['session/event'](null, { type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
	const notice = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /已结束/.test(String(c.args.content))) ?? null
	})
	assert.equal(notice.args.content, 'proj-a(session-1)已结束')

	await waitFor(() => {
		try {
			const notes = JSON.parse(readFileSync(boot.stateFile, 'utf8')).notes ?? []
			return notes.some((line) => /agent 实例换了，重挂监听/.test(line))
		} catch {
			return false
		}
	})

	boot.dispose()
})

test('端到端：事件监听全聋时，whenIdle + 会话日志也能给出正确的「已结束 / 被打断」', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent }, config: { runningPollMs: 5 } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M0' })
	await drainFor(boot.socketPath, 60)

	// 第一轮：**完全不喂 session/event**，只让 whenIdle 结算，日志里写着 completed
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '第一条', msgId: 'M1' })
	await waitFor(() => agent.followed.length === 1)
	agent.status = 'running' // 兜底只在"真的跑起来过"之后才认 whenIdle
	await waitFor(() => agent.whenIdleCalls > 0)
	agent.settleIdle('completed', 3)
	const finished = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /已结束/.test(String(c.args.content))) ?? null
	})
	assert.equal(finished.args.content, 'proj-a(session-1)已结束', '按日志里的 reason=completed 判定为正常结束')
	assert.match(String(finished.args.keyboard.content.rows[0].buttons[0].render_data.label), /我需要回复/)

	// 第二轮：日志里写着 aborted → 必须是「被打断」
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '第二条', msgId: 'M2' })
	await waitFor(() => agent.followed.length === 2)
	agent.status = 'running'
	await waitFor(() => agent.whenIdleCalls > 1)
	agent.settleIdle('aborted', 4)
	const interrupted = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /被打断/.test(String(c.args.content))) ?? null
	})
	assert.equal(interrupted.args.content, 'proj-a(session-1)被打断')

	// 小日志里要能看到走的是兜底路径
	await waitFor(() => {
		try {
			const notes = JSON.parse(readFileSync(boot.stateFile, 'utf8')).notes ?? []
			return notes.some((line) => /whenIdle 兜底收尾/.test(line))
		} catch {
			return false
		}
	})

	boot.dispose()
})

// 线上事故（2026-10-15，用户报"ai 停止后没有发送停止消息"）：
// 上一轮被顶替时 agent 会先报一次 idle，而新轮次刚建好 → 旧代码 3 秒后按"未知原因"收尾，
// 误报「被打断」，这一轮后面真跑完（37 分钟后 completed）的 turn/end 被当成已结束而吃掉，
// 于是「已结束」永远发不出来。
test('端到端：上一轮遗留的 idle 不能把新轮次误判成"被打断"（日志里它还没结束）', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M0' })
	await drainFor(boot.socketPath, 60)

	// 新轮次认领 turn=7（事件路径正常），日志里**还没有** turn/end
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '干活', msgId: 'M1' })
	await waitFor(() => agent.followed.length === 1)
	agent.handlers['session/event'](null, { type: 'turn/start', data: { turn: 7 } })
	// 上一轮被顶替遗留的 idle 事件（真实时序里它就在这附近到）
	agent.handlers['agent/status']({ status: 'idle' })

	// 等过兜底窗口（测试里 20ms）——必须**什么都不发**
	await new Promise((resolve) => setTimeout(resolve, 120))
	const early = await drainFor(boot.socketPath, 60)
	assert.equal(
		early.filter((c) => c.kind === 'send_c2c' && /被打断|已结束/.test(String(c.args.content))).length,
		0,
		'日志里这一轮还没结束，就不能收尾（绝不能误报被打断）',
	)

	// 这一轮后来真的正常结束 → 必须发「已结束」
	agent.session.events.push({ type: 'turn/end', seq: 99, time: Date.now(), data: { turn: 7, reason: { kind: 'completed' } } })
	agent.handlers['session/event'](null, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
	const notice = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /已结束/.test(String(c.args.content))) ?? null
	})
	assert.equal(notice.args.content, 'proj-a(session-1)已结束')

	boot.dispose()
})

test('端到端：idle 兜底要读日志里的真实 reason（completed → 已结束，不是一律"被打断"）', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M0' })
	await drainFor(boot.socketPath, 60)

	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '干活', msgId: 'M1' })
	await waitFor(() => agent.followed.length === 1)
	agent.handlers['session/event'](null, { type: 'turn/start', data: { turn: 8 } })
	// 日志里已经写了 turn=8 completed，但 turn/end 事件走丢了（监听聋）
	agent.session.events.push({ type: 'turn/end', seq: 50, time: Date.now(), data: { turn: 8, reason: { kind: 'completed' } } })
	agent.handlers['agent/status']({ status: 'idle' })

	const notice = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /已结束|被打断/.test(String(c.args.content))) ?? null
	})
	assert.equal(notice.args.content, 'proj-a(session-1)已结束', '日志说 completed 就该报已结束')
	const notes = JSON.parse(readFileSync(boot.stateFile, 'utf8')).notes ?? []
	assert.ok(
		notes.some((line) => /兜底收尾：agent 已 idle 且日志里 turn=8 已结束（reason=completed/.test(line)),
		`小日志应记录兜底用了真实 reason：\n${notes.slice(-5).join('\n')}`,
	)

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
	// 「我需要回复」的唤醒文本是**插件自己写的**：保持插件来源，不冒充用户授权
	// （所以这种轮次里 create_goal / update_goal resume 仍会被 dsh 拒绝——那是对的）
	assert.equal(agent.followed[0].source.kind, PLUGIN_SOURCE.kind)

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

test('端到端：延迟投递必须等驱动空闲——running 时 followup 的唤醒会被吞掉（消息卡在「待发送」）', async (t) => {
	const agent = makeAgent('session-1')
	// 给假 agent 装上 **dsh 驱动的唤醒语义**（本 bug 的关键，不装就复现不了）：
	//   running 且没有 abort 时，`followup` 只把消息放进 next-turn 队列、**不唤醒**
	//   （dsh 的 wakeDriver 此时既不唤醒也不登记 wakeRequested）→ 消息就是界面上的「待发送」；
	//   idle 时 `followup` 立刻开新一轮。
	// 真实 dsh 里"驱动退休"排在 `turn/end` 事件之后（微任务序），所以处理器里发出的
	// followup 一定会撞上 running —— 这正是线上卡住的画面。
	const queue = []
	let turnSeq = 0
	agent.startedTurns = []
	agent.pendingQueue = queue
	const startTurn = () => {
		turnSeq += 1
		agent.startedTurns.push(turnSeq)
		agent.status = 'running'
		queue.shift() // 驱动把队列里最前面的那条捡走
		agent.handlers['session/event'](null, { type: 'turn/start', data: { turn: turnSeq } })
	}
	agent.followup = (message) => {
		agent.followed.push(message)
		queue.push(message)
		if (agent.status === 'idle') startTurn()
	}
	agent.retire = (reason = 'completed') => {
		agent.status = 'idle'
		agent.settleIdle(reason, turnSeq)
	}

	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', {
		openids: [{ openid: 'U1' }],
		panel: { enabled: true, users: ['U1'] },
		menu: { enabled: true },
	})

	// 1) 普通发送：驱动开起第 1 轮
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '发送 session-1 帮我看下', msgId: 'M1' })
	await waitFor(() => agent.startedTurns.length === 1)
	assert.equal(agent.status, 'running', '这一轮在跑')

	// 2) 登记一条延迟消息（先不投递）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '延迟发送 session-1 打完了叫我', msgId: 'M2' })
	await waitFor(async () => (await pumpQueue(boot.socketPath)).some((c) => /已登记/.test(String(c.args.content))))
	assert.equal(agent.followed.length, 1, '延迟发送不该立即投递')

	// 3) 这一轮正常结束：**turn/end 先到，驱动还没退休**（线上就是这个时序）
	agent.handlers['session/event'](null, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
	// 驱动紧接着退休（排在插件那条投递链之后）
	queueMicrotask(() => agent.retire('completed'))

	// 4) 延迟消息必须**真的开出一轮**，而不是躺在「待发送」队列里
	await waitFor(() => agent.startedTurns.length === 2)
	assert.deepEqual(agent.startedTurns, [1, 2], '延迟消息应当自己开一轮')
	assert.equal(queue.length, 0, '不能留在「待发送」队列里')
	assert.equal(agent.followed.at(-1).content[0].text, '打完了叫我')
	assert.equal(agent.followed.at(-1).source.kind, HUMAN_SOURCE.kind, '延迟投递也是"用户在 QQ 里打的字"')

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
	// 二级菜单现在有 2 个：桥自己的「管理」+ dsh 命令（feedback 被排除，只剩 compact/goal）
	const groups = panel.value.menuItems.filter((item) => item.type === 'menu')
	assert.equal(groups.length, 2, '桥的「管理」与 dsh 命令各占一个二级菜单')
	const dshGroup = groups.find((item) => item.name === 'dsh 命令')
	assert.ok(dshGroup, 'dsh 命令应收进二级菜单')
	assert.deepEqual(
		dshGroup.children.map((child) => child.name),
		['compact', 'goal'],
		'feedback 不收纳；技能本来就不在命令表里',
	)
	assert.equal(dshGroup.children[0].sendMessage, '/compact', '点击把 /命令 填进输入框')
	assert.equal(panel.value.menuItems.filter((i) => i.type !== 'menu').length, 7, '顶层 7 条平铺桥命令')

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

	// 认不出的斜杠命令 → **明确回绝，绝不投给 AI**（用户要求：不存在的命令不要放行给模型）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '/unknown 参数', msgId: 'M4' })
	const refused = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /unknown/.test(String(c.args.content)) && /没有/.test(String(c.args.content))) ?? null
	})
	assert.match(String(refused.args.content), /没有发给 AI/, '要明确说"没发给 AI"')
	assert.match(String(refused.args.content), /\/compact/, '顺手列出这个会话真的能用的命令')
	assert.match(String(refused.args.content), /全角/, '给出"想把 / 开头的话当消息发"的出路')
	assert.equal(agent.followed.length, 1, '认不出的斜杠命令绝不能投给 AI')

	// 没绑定会话时发 dsh 命令：同样回绝，不当普通消息
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 none', msgId: 'M5' })
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '/compact', msgId: 'M6' })
	const needBind = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /没有绑定会话/.test(String(c.args.content))) ?? null
	})
	assert.match(String(needBind.args.content), /没有发给 AI/)
	assert.equal(agent.followed.length, 1, '没绑定会话时也不能把 /命令 扔给模型')
})

test('端到端：`/goal resume` 这类命令要原样透传（模型工具不许恢复 paused 目标，命令通道可以）', async (t) => {
	const agent = makeAgent('session-1')
	const executed = []
	const boot = bootPlugin(t, {
		sessions: SUMMARIES,
		live: { 'session-1': agent },
		commands: {
			async list() {
				return [{ name: 'goal', description: '设置或查看长期任务目标' }]
			},
			async execute(target, line) {
				executed.push({ sessionId: target.id, line })
				return { commandId: 'g1', result: { kind: 'success', text: 'Goal resumed（目标已恢复）' } }
			},
		},
	})
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M0' })
	await drainFor(boot.socketPath, 60)

	// 作用：dsh 的 **模型工具** `update_goal resume` 明确拒绝恢复 paused 目标
	// （GOAL_TOOL_RESUME_PAUSED："the model cannot resume a paused goal; the user must resume it"），
	// 而 `/goal resume` 这个**命令**直接调 `ctx.goals.resume`，没有那层限制 —— 所以 QQ 侧
	// 恢复暂停目标的正路是发 `/goal resume`，本桥必须原样透传。
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '/goal resume', msgId: 'M1' })
	await waitFor(() => executed.length === 1)
	assert.equal(executed[0].sessionId, 'session-1')
	assert.equal(executed[0].line, '/goal resume', '命令要原样交给 ctx.commands.execute')
	assert.equal(agent.followed.length, 0, '命令不该被当成提示词发给模型')
	const ack = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /Goal resumed/.test(String(c.args.content))) ?? null
	})
	assert.ok(ack, '命令结果要回给 QQ')

	boot.dispose()
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

test('端到端：新建目录（等名字→创建→默认进去）与空目录删除（二次确认）', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-qq-dirs-'))
	const emptyDir = join(root, 'empty-dir')
	const busyDir = join(root, 'busy-dir')
	mkdirSync(emptyDir)
	mkdirSync(busyDir)
	writeFileSync(join(busyDir, 'a.txt'), 'x')
	t.after(() => rmSync(root, { recursive: true, force: true }))

	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, {
		sessions: [
			{ sessionId: 'session-1', cwd: root, updatedAt: 3, running: false },
			{ sessionId: 'session-2', cwd: emptyDir, updatedAt: 2, running: false },
			{ sessionId: 'session-3', cwd: busyDir, updatedAt: 1, running: false },
		],
		live: { 'session-1': agent },
	})
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M1' })
	await drainFor(boot.socketPath, 60)

	const cardOf = (list) => list.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1) ?? null
	const labelsOf = (card) => card.args.keyboard.content.rows.flatMap((r) => r.buttons).map((b) => b.render_data.label)
	const buttonOf = (card, label) => card.args.keyboard.content.rows.flatMap((r) => r.buttons).find((b) => b.render_data.label === label)

	// 新建会话 → 根目录卡片
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '新建会话', msgId: 'M2' })
	const rootCard = await waitFor(async () => cardOf(await drainFor(boot.socketPath, 80)))
	assert.ok(labelsOf(rootCard).includes('新建目录'), '卡片上要有「新建目录」')
	assert.ok(!labelsOf(rootCard).includes('删除目录'), '根目录非空（有子目录）不给删除按钮')

	// 1) 点「新建目录」→ 进入等名字
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: buttonOf(rootCard, '新建目录').action.data,
		eventId: 'INT-MK',
		msgId: 'CARD-1',
	})
	const asked = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /写出\*\*目录名\*\*/.test(String(c.args.content))) ?? null
	})
	assert.match(asked.args.content, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

	// 2) 发目录名 → 真的建出来，并默认进去（回新目录的卡片）
	const made = join(root, 'made-by-test')
	assert.equal(existsSync(made), false)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: 'made-by-test', msgId: 'M3' })
	assert.equal(existsSync(made), true, '目录要真的建出来')
	const insideCard = await waitFor(async () => cardOf(await drainFor(boot.socketPath, 80)))
	assert.match(insideCard.args.content, /made-by-test/, '默认 cd 进新目录（卡片换成它）')
	assert.ok(labelsOf(insideCard).includes('删除目录'), '新建的空目录可以删')

	// 3) 点「删除目录」→ 只是二次确认，什么都没删
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: buttonOf(insideCard, '删除目录').action.data,
		eventId: 'INT-RM',
		msgId: 'CARD-2',
	})
	const confirmCard = await waitFor(async () => cardOf(await drainFor(boot.socketPath, 80)))
	assert.deepEqual(labelsOf(confirmCard), ['取消', '确认删除'], '第二步只给取消/确认删除')
	assert.equal(existsSync(made), true, '第一步不能删')

	// 4) 点「确认删除」→ 真的删掉，并回到上级卡片
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: buttonOf(confirmCard, '确认删除').action.data,
		eventId: 'INT-RMYES',
		msgId: 'CARD-3',
	})
	const removed = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /已删除空目录/.test(String(c.args.content))) ?? null
	})
	assert.match(removed.args.content, /made-by-test/)
	assert.equal(existsSync(made), false, '确认后才真删')

	// 5) 非空目录不给删除按钮
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '新建会话', msgId: 'M4' })
	const backCard = await waitFor(async () => cardOf(await drainFor(boot.socketPath, 80)))
	const busyButton = buttonOf(backCard, 'busy-dir')
	assert.ok(busyButton, '非空目录仍应列出来')
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: busyButton.action.data,
		eventId: 'INT-ENTER',
		msgId: 'CARD-4',
	})
	const busyCard = await waitFor(async () => cardOf(await drainFor(boot.socketPath, 80)))
	assert.ok(!labelsOf(busyCard).includes('删除目录'), '里面有文件就不给删除按钮')
	assert.equal(existsSync(join(busyDir, 'a.txt')), true)

	// 6) 手工调「确认删除」删非空目录也要被挡住（护栏不只靠"不给按钮"）
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: cardData.rmdirYes(busyDir),
		eventId: 'INT-RMYES2',
		msgId: 'CARD-5',
	})
	const blocked = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /不是空目录/.test(String(c.args.content))) ?? null
	})
	assert.match(blocked.args.content, /不是空目录/)
	assert.equal(existsSync(busyDir), true, '非空目录绝不能被删')

	boot.dispose()
})

test('端到端：QQ 侧新建会话要把目录注册成工作区（否则 Web 端整个文件夹看不见）', async (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-ws-'))
	t.after(() => rmSync(dir, { recursive: true, force: true }))

	const boot = bootPlugin(t, { sessions: [], live: {} })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })

	// 「新建会话 <目录>」直接建
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: `新建会话 ${dir}`, msgId: 'M1' })
	const reply = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c') ?? null
	})
	assert.match(String(reply.args.content), /新建并切换到/, `实际回执：${reply.args.content}`)

	const created = boot.ctx.workspaceRegistry.workspaces.find((ws) => ws.path === dir)
	assert.ok(created, '目录必须被注册成工作区，否则 dsh Web 侧栏里看不到这个文件夹')
	assert.equal(created.title, basenameOf(dir))
	assert.equal(created.attached.length, 1, '新会话要 attach 到工作区上')
	assert.match(created.attached[0], /^session-created-/)
})

// 与 node:path 的 basename 对齐（测试里只用最后一段做断言）
function basenameOf(path) {
	return String(path).split('/').filter(Boolean).pop()
}

test('端到端：点「在这里新建」时同步把该目录注册成工作区（AI 不需要为此拿工具）', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-qq-here-'))
	const dir = join(root, 'proj-new')
	mkdirSync(dir)
	t.after(() => rmSync(root, { recursive: true, force: true }))

	const boot = bootPlugin(t, { sessions: [{ sessionId: 'session-1', cwd: root, updatedAt: 1, running: false }], live: {} })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await drainFor(boot.socketPath, 60)

	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: cardData.newHere(dir),
		eventId: 'INT-HERE',
		msgId: 'CARD-1',
	})
	const reply = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /新建并切换到/.test(String(c.args.content))) ?? null
	})
	assert.match(String(reply.args.content), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

	const workspace = boot.ctx.workspaceRegistry.workspaces.find((item) => item.path === dir)
	assert.ok(workspace, '新建会话时要顺手注册工作区，否则 Web 端看不到这个文件夹')
	assert.equal(workspace.attached.length, 1, '新会话要挂到工作区上')
	assert.match(workspace.attached[0], /^session-created-/)
	assert.equal(workspace.title, 'proj-new')
})

test('端到端：启动补登记——本桥以前跑过轮次的会话（notices 里的）也会被注册成工作区', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-qq-legacy-'))
	const legacyDir = join(root, 'openfield-file-sdk')
	mkdirSync(legacyDir)
	t.after(() => rmSync(root, { recursive: true, force: true }))

	// 旧状态：这个会话跑过轮次（notices 里有 "sessionId:turn"），但当时还没注册工作区
	const boot = bootPlugin(t, {
		sessions: [{ sessionId: 'session-legacy', cwd: legacyDir, updatedAt: 2, running: false }],
		live: {},
		stateSeed: { bindings: {}, notices: { 'session-legacy:2': true } },
	})
	await waitFor(() => existsSync(boot.socketPath))
	// 网关同步（= 插件/网关重启后的握手）会触发补登记
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	const ws = await waitFor(() => boot.ctx.workspaceRegistry.workspaces.find((item) => item.path === legacyDir) ?? null)
	assert.equal(ws.attached.length, 1, '会话要挂到工作区上')
	assert.equal(ws.attached[0], 'session-legacy')
})

test('端到端：/plan 带文本 → 命令只切模式，正文走本桥投递（不再被 steer 绕过）', async (t) => {
	const agent = makeAgent('session-1')
	const executed = []
	const boot = bootPlugin(t, {
		sessions: SUMMARIES,
		live: { 'session-1': agent },
		commands: {
			async list() {
				return [{ name: 'plan', description: 'Enter or leave plan mode' }]
			},
			async execute(target, line) {
				executed.push({ sessionId: target.id, line })
				return {
					commandId: 'c1',
					result: { kind: 'success', text: line === '/plan' ? 'Plan mode on. Use /plan off to leave.' : 'Plan mode off.' },
				}
			},
		},
	})
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M1' })
	await drainFor(boot.socketPath, 60)

	// 1) `/plan <文本>`：命令只该收到「/plan」
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '/plan 参考：/tmp/api.md 来写修改计划', msgId: 'M2' })
	await waitFor(() => agent.followed.length === 1)
	assert.deepEqual(
		executed.map((item) => item.line),
		['/plan'],
		'只把「/plan」交给 dsh：整行交给它会被 steer 绕过本桥（线上就是这个 bug）',
	)
	assert.equal(agent.followed[0].content[0].text, '参考：/tmp/api.md 来写修改计划', '剩下的文本要作为本桥消息投给 AI')
	const afterPlan = await drainFor(boot.socketPath, 60)
	assert.ok(
		afterPlan.some((c) => c.kind === 'send_c2c' && /Plan mode on/.test(String(c.args.content))),
		'命令回执要发到 QQ',
	)

	// 这一轮归本桥结算：跑完必须有「已结束」通知 + 快照里带 QQ 上下文（被 steer 的轮两样都没有）
	agent.handlers['session/event'](null, { type: 'turn/start', data: { turn: 7 } })
	agent.handlers['session/event'](null, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
	const notice = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /已结束/.test(String(c.args.content))) ?? null
	})
	assert.match(String(notice.args.content), /已结束/)
	assert.ok(notice.args.keyboard, '结束通知要带「我需要回复」按钮')

	// 2) `/plan off` 是模式词：整行照旧执行，不投递
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '/plan off', msgId: 'M3' })
	await waitFor(() => executed.length === 2)
	assert.equal(executed[1].line, '/plan off')
	assert.equal(agent.followed.length, 1, '/plan off 不该投递任何消息')

	boot.dispose()
})

test('端到端：plan 模式下提交计划（exit_plan_mode）会把计划正文发到 QQ', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M1' })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '写个计划', msgId: 'M2' })
	await waitFor(() => agent.followed.length === 1)

	agent.handlers['session/event'](null, { type: 'turn/start', data: { turn: 3 } })
	agent.handlers['session/event'](null, {
		type: 'tool/call',
		data: { name: 'exit_plan_mode', arguments: { plan: '# 修改计划\n\n1. 第一步' }, step: 1, callId: 'call-1' },
	})
	const planMsg = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /修改计划/.test(String(c.args.content))) ?? null
	})
	assert.match(String(planMsg.args.content), /第一步/)
	assert.match(String(planMsg.args.content), /plan 模式提交/)
	assert.equal(planMsg.args.markdown, true)

	boot.dispose()
})

test('端到端：用 `发送 <会话id>` 说话的非绑定会话也能回 QQ（qq_reply 不该被"当前绑定"卡住）', async (t) => {
	const agent1 = makeAgent('session-1')
	const agent2 = makeAgent('session-2')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent1, 'session-2': agent2 } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	// 绑定 session-2，但用显式目标跟 session-1 说话
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-2', msgId: 'M1' })
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '发送 session-1 帮我看看', msgId: 'M2' })
	await waitFor(() => agent1.followed.length === 1)
	assert.equal(agent2.followed.length, 0, '不该投到绑定会话')

	const replyTool = agent1.tools.find((tool) => tool.name === REPLY_TOOL_NAME)
	assert.ok(replyTool, '被投递的会话应当拿到 qq_reply 工具')
	const result = await replyTool.execute({ content: '看完了，没问题' })
	// 测试里没有网关 ack，"等待送达确认超时"是正常的；关键是**不能**因为"当前绑定不是它"被拒
	assert.doesNotMatch(
		JSON.stringify(result.failed ?? []),
		/没有绑定 QQ 私聊/,
		'非绑定会话（显式指定发送）也必须能回 QQ',
	)
	const sent = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /看完了，没问题/.test(String(c.args.content))) ?? null
	})
	assert.match(String(sent.args.content), /看完了，没问题/)

	boot.dispose()
})

test('端到端：`权限` 发卡片（每行两个）／带参数直接设定／点按钮切换', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await drainFor(boot.socketPath, 60)

	// 没绑定会话 → 提示先切会话
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '权限', msgId: 'M0' })
	const needBind = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /切换会话/.test(String(c.args.content))) ?? null
	})
	assert.match(String(needBind.args.content), /绑定会话/)

	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M1' })
	await drainFor(boot.socketPath, 60)

	// 裸发 `权限` → 卡片：3 个级别、每行两个、正文标出"当前"
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '权限', msgId: 'M2' })
	const card = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1) ?? null
	})
	assert.match(String(card.args.content), /当前：\*\*工作区内修改\*\*/)
	const rows = card.args.keyboard.content.rows.map((row) => row.buttons.map((b) => b.action.data))
	assert.equal(rows.length, 2, '3 个级别 → 每行两个（2+1）')
	assert.equal(rows[0].length, 2)
	assert.deepEqual(rows[0], [cardData.perm('read-only'), cardData.perm('workspace-write')])
	assert.deepEqual(rows[1], [cardData.perm('danger-full-access')])

	// 点卡片上的「完全权限」→ 切换 + 回执 + 重发卡片（新的"当前"）
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: cardData.perm('danger-full-access'),
		eventId: 'INT-PERM',
		msgId: 'CARD-1',
	})
	const afterSwitch = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.some((c) => c.kind === 'send_c2c' && /权限切成/.test(String(c.args.content))) ? list : null
	})
	const switched = afterSwitch.find((c) => /权限切成/.test(String(c.args.content)))
	assert.match(String(switched.args.content), /完全权限/)
	// 假 agent 现在带 `session`（会话日志，兜底收尾要用），所以这里能拿到真的 session.id
	assert.deepEqual(boot.ctx.permissionPresets.setCalls, [{ sessionId: 'session-1', value: 'danger-full-access' }])
	// 回执与重发的卡片在同一次 drain 里（别分两次取，否则第二条会被前一次消费掉）
	const resent = afterSwitch.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1)
	assert.ok(resent, '切换后要重发权限卡片（标出新的"当前"）')
	assert.match(String(resent.args.content), /当前：\*\*完全权限\*\*/)

	// 带参数直接设定（中文名）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '权限 仅可查看', msgId: 'M3' })
	const direct = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /权限切成/.test(String(c.args.content))) ?? null
	})
	assert.match(String(direct.args.content), /仅可查看/)
	assert.equal(boot.ctx.permissionPresets.setCalls.at(-1).value, 'read-only')

	// 认不出的级别 → 报错 + 回用法
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '权限 瞎写', msgId: 'M4' })
	const bad = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /认不出权限级别/.test(String(c.args.content))) ?? null
	})
	assert.match(String(bad.args.content), /用法：/)

	boot.dispose()
})

// 用户要求（2026-10-16）：`进度` 改名 `状态`，抬头带上"哪个会话 / 哪个模型 / 什么权限"，
// 并去掉原来那句「说明：只读查询，没有打断它」。
test('端到端：`状态` —— 抬头给会话/模型/权限，去掉"只读说明"，旧名 `进度` 仍认', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M0' })
	await drainFor(boot.socketPath, 60)
	// 先切个模型，这样卡片上能读出"用的是哪个模型"
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '模型 deepseek/deepseek-reasoner', msgId: 'M1' })
	await drainFor(boot.socketPath, 60)

	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '状态', msgId: 'M2' })
	const card = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /^\*\*状态\*\*/m.test(String(c.args.content))) ?? null
	})
	const text = String(card.args.content)
	assert.match(text, /> 会话：proj-a\(session-1\)/, '要写清是哪个会话')
	assert.match(text, /> 模型：deepseek \/ deepseek-reasoner/, '要写清用的哪个模型')
	assert.match(text, /> 权限：工作区内修改/, '要写清当前权限（中文显示名）')
	assert.doesNotMatch(text, /说明：/, '用户要求去掉"只读查询"那段说明')
	assert.match(text, /> 状态：/, '保留跑没在跑那行')
	assert.equal(card.args.keyboard, undefined, '状态是纯文本，不带键盘')
	assert.doesNotMatch(text, /统计/, '这个部署没有统计投影 → 不出「统计」一节')

	// 装上统计投影（dsh-session-stats + dsh-token-meter 那四个）→ 卡片多一节「统计」，
	// 数字用用户贴来的那一份钉住换算。
	boot.ctx.sessionController.stats = {
		sessionStats: {
			turns: 7,
			steps: 98,
			llmMs: 35_248_000,
			toolMs: 3_792_000,
			ttftMs: 4_300_000,
			ttftSteps: 500,
			decodeMs: 1_000_000,
			decodeTokens: 191_000,
		},
		tokenUsage: {
			uncachedInputTokens: 10_314_436,
			cacheReadTokens: 916_849_920,
			cacheWriteTokens: 0,
			outputTokens: 1_909_715,
		},
		contextBreakdown: { systemTokens: 4500, toolsTokens: 19_900, messageTokens: 369_000 },
		contextPressure: { contextWindow: 1_000_000, pressureTokens: 500_000, projectedTokens: 540_000 },
	}
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '状态', msgId: 'M2B' })
	const withStats = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.filter((c) => c.kind === 'send_c2c' && /^\*\*状态\*\*/m.test(String(c.args.content))).at(-1) ?? null
	})
	const statsText = String(withStats.args.content)
	assert.match(statsText, /> 模型用时 9 小时 47 分 ｜ 工具调用 1 小时 3 分/)
	assert.match(statsText, /> Token 用量 929\.07M ｜ 缓存命中 99%/)
	assert.match(statsText, /> 上下文已用 54%（~540K \/ 1M）/)
	assert.match(statsText, /> 系统提示词 4\.5K ｜ 工具定义 19\.9K ｜ 对话消息 369K/)

	// 旧名 `进度` 仍然认（别名 → 状态），不能因为改名就被当成普通消息投给 AI
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '进度', msgId: 'M3' })
	const legacy = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /^\*\*状态\*\*/m.test(String(c.args.content))) ?? null
	})
	assert.match(String(legacy.args.content), /> 权限：工作区内修改/, '别名走的是同一条路')
	assert.equal(agent.followed.length, 0, '旧名不能被当成普通消息发给 AI')

	boot.dispose()
})

// 用户要求（2026-10-16）：打断会让 dsh 的目标"失能"——`dsh-goal-round-driver` 收到
// `turn/end reason.kind === 'aborted'` 且被取消的不是目标自己的那一轮时，会直接
// `ctx.goals.disarm()`：**phase 仍是 active 但不再自动续跑**（线上表现是 `roundsStarted: 0`、
// 目标一直躺着，只能人工 `/goal resume`）。如果被取消的恰好是目标自己的轮，驱动走的是 `pause`。
// 所以桥在"打断 + 投递"之后要把它重新武装 —— 但**只恢复打断前处于运行中的目标**。
test('端到端：打断"运行中的目标"后自动重新武装；没目标/已暂停/已失能都不动', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, {
		sessions: SUMMARIES,
		live: { 'session-1': agent },
		config: { goalRearmPollMs: 20, goalRearmWaitMs: 500 },
	})
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M0' })
	await drainFor(boot.socketPath, 60)

	const goals = boot.ctx.goals
	// 模拟"打断那一刻驱动的反应"：cancel() 之后目标被 disarm（真实驱动在 aborted 的 turn/end 里做）
	const cancel = agent.cancel.bind(agent)
	agent.cancel = (...args) => {
		const result = cancel(...args)
		goals.disarm()
		return result
	}
	agent.status = 'running'

	// 1) 打断前是 active + armed（运行中）→ 投递后要重新武装
	goals.state = { id: 'goal-1', revision: 7, phase: 'active', activation: 'armed' }
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '换方向', msgId: 'M1' })
	await waitFor(() => goals.resumeCalls.length === 1)
	assert.deepEqual(goals.resumeCalls[0], { sessionId: 'session-1', ref: { id: 'goal-1', revision: 7 } })
	assert.equal(goals.state.activation, 'armed', '恢复后目标应回到 armed（会自己续跑）')
	// 插件日志进不了 journald，小日志是唯一可观测通道：这一笔必须留痕
	const noted = await waitFor(() => {
		try {
			return JSON.parse(readFileSync(boot.stateFile, 'utf8')).notes.find((line) => /重新武装/.test(line)) ?? null
		} catch {
			return null
		}
	})
	assert.match(noted, /goal-1/, '要写明恢复的是哪个目标')

	// 2) 打断前**没有目标** → 什么都不做
	goals.state = null
	goals.resumeCalls.length = 0
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '再来一条', msgId: 'M2' })
	await drainFor(boot.socketPath, 80)
	assert.equal(goals.resumeCalls.length, 0, '没有目标就不该动什么')

	// 3) 打断前目标是 **paused**（用户自己停的）→ 不该被我们启动起来
	goals.state = { id: 'goal-2', revision: 3, phase: 'paused', activation: 'disarmed' }
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '第三条', msgId: 'M3' })
	await drainFor(boot.socketPath, 80)
	assert.equal(goals.resumeCalls.length, 0, '暂停的目标不该被自动恢复')

	// 4) 打断前 active 但已经 disarmed（本来就没在跑）→ 不算"运行中"，不动
	goals.state = { id: 'goal-3', revision: 5, phase: 'active', activation: 'disarmed' }
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '第四条', msgId: 'M4' })
	await drainFor(boot.socketPath, 80)
	assert.equal(goals.resumeCalls.length, 0, '只有"运行中"（active + armed）的目标才恢复')

	// 5) 用户显式 `停止` 不恢复（那是人主动停的）
	goals.state = { id: 'goal-4', revision: 9, phase: 'active', activation: 'armed' }
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '停止', msgId: 'M5' })
	await drainFor(boot.socketPath, 80)
	assert.equal(goals.resumeCalls.length, 0, '`停止` 是人主动按的，不该把目标又启动起来')

	boot.dispose()
})

// 用户要求（2026-10-16）：确认「快捷」是**持久化**的 —— 插件/宿主重启后条目还在。
// 存储就是状态文件 `state.json` 的 `shortcuts`（openid → { seq, items:[{id,sessionId,name,at}] }）：
// 快捷的增/删/改每次都**立刻 flush**（不是只等 200ms 防抖），写入是 tmp+rename 原子写 0600，
// 启动时 `normalize()` 把它读回来。这条用例**用同一个状态文件启两次插件**（= 模拟重启）。
test('端到端：快捷条目持久化（同一状态文件"重启"插件后 #编号与备注都还在）', async (t) => {
	// ── 第一次启动：加两条（不同会话）+ 改一次备注 ──
	const live1 = { 'session-1': makeAgent('session-1'), 'session-2': makeAgent('session-2') }
	const boot1 = bootPlugin(t, { sessions: SUMMARIES, live: live1 })
	await waitFor(() => existsSync(boot1.socketPath))
	await rpc(boot1.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	const say = async (text, msgId) => {
		await rpc(boot1.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text, msgId })
		await drainFor(boot1.socketPath, 60)
	}
	await say('切换会话 session-1', 'M0')
	await say('快捷 加 前端', 'M1')
	await say('切换会话 session-2', 'M2')
	await say('快捷 加 后端', 'M3')
	await say('快捷 备注 #1 前端主控', 'M4')

	// 落盘是同步 flush 的：直接读文件确认两条 + 备注 + 编号
	const saved = await waitFor(() => {
		try {
			const book = JSON.parse(readFileSync(boot1.stateFile, 'utf8')).shortcuts?.U1
			return book?.items?.length === 2 ? book : null
		} catch {
			return null
		}
	})
	assert.deepEqual(
		saved.items.map((i) => [i.id, i.sessionId, i.name]),
		[
			[1, 'session-1', '前端主控'],
			[2, 'session-2', '后端'],
		],
		'状态文件里应有 #1/#2 与备注（编号只增不重用的 seq 也在）',
	)
	assert.equal(saved.seq, 2)
	const { dir, stateFile } = boot1
	boot1.dispose() // 模拟宿主退出（卸载钩子也会再 flush 一次）

	// ── 第二次启动：同一个状态文件、换个 socket 名 ──
	const boot2 = bootPlugin(t, {
		sessions: [...SUMMARIES, { sessionId: 'session-3', cwd: '/home/u/proj-c', updatedAt: 1, running: false }],
		live: {},
		dir,
		socket: 'bridge2.sock',
	})
	await waitFor(() => existsSync(boot2.socketPath))
	await rpc(boot2.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot2.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '快捷', msgId: 'N0' })
	const help = await waitFor(async () => {
		const list = await drainFor(boot2.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /切过去/.test(String(c.args.content))) ?? null
	})
	const text = String(help.args.content)
	assert.match(text, /> 现有：#1 前端主控、#2 后端/, '"重启"后 #编号与备注原样还在')
	assert.equal(readFileSync(stateFile, 'utf8').includes('前端主控'), true)

	// 编号继续往后走（seq 是持久化的，不会从 1 重来）
	await rpc(boot2.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-3', msgId: 'N1' })
	await drainFor(boot2.socketPath, 60)
	await rpc(boot2.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '快捷 加 第三个', msgId: 'N2' })
	const added = await waitFor(async () => {
		const list = await drainFor(boot2.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /#3/.test(String(c.args.content))) ?? null
	})
	assert.match(String(added.args.content), /#3/, '重启后新加的是 #3（seq 持久化，不重用编号）')

	boot2.dispose()
})

// 同一个持久化面还有一条：状态文件里**预置**的快捷（比如上个进程留下的）要能被读回来，
// `#编号` 与 `seq` 都原样（编号只增不重用的前提）。
test('端到端：快捷持久化（stateSeed：直接给一份含 shortcuts 的状态文件）', async (t) => {
	const boot = bootPlugin(t, {
		sessions: SUMMARIES,
		live: {},
		stateSeed: { shortcuts: { U1: { seq: 5, items: [{ id: 4, sessionId: 'session-1', name: '预置' }] } } },
	})
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '快捷', msgId: 'Y0' })
	const help = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /切过去/.test(String(c.args.content))) ?? null
	})
	assert.match(String(help.args.content), /#4 预置/, '从状态文件读回预置条目（编号也保留）')
	boot.dispose()
})

test('端到端：`发送 <会话id> <正文>` 带引用时，引用要一起投给 AI', async (t) => {
	const agent = makeAgent('session-1')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	// 绑定 session-1：命令路径不需要绑定也会投，但下面的"普通消息"回归需要
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M0' })
	await drainFor(boot.socketPath, 60)

	await rpc(boot.socketPath, 'event', {
		kind: 'c2c_message',
		openid: 'U1',
		text: '发送 session-1 帮我看下这个',
		quote: '这是被引用的那条消息',
		msgId: 'M1',
	})
	await waitFor(() => agent.followed.length === 1)
	assert.equal(agent.followed[0].content[0].text, '[引用的消息] 这是被引用的那条消息\n\n帮我看下这个')

	// 普通消息路径的引用行为不变（回归）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '看这条', quote: '引用原文', msgId: 'M2' })
	await waitFor(() => agent.followed.length === 2)
	assert.equal(agent.followed[1].content[0].text, '[引用的消息] 引用原文\n\n看这条')

	boot.dispose()
})

test('端到端：`模型` 两级卡片（提供商 2/行 → 模型 1/行）／选完模型先确认（应用/切其他会话/返回）／切其他会话是交互式／带参直接切', async (t) => {
	const boot = bootPlugin(t, { sessions: SUMMARIES })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M0' })
	await drainFor(boot.socketPath, 60)

	// 裸发 `模型` → 提供商卡片：每行 2 个、正文标出"当前"、失败提供商如实列出
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '模型', msgId: 'M1' })
	const card = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1) ?? null
	})
	assert.match(String(card.args.content), /\*\*模型\*\*/)
	assert.match(String(card.args.content), /当前：`（读不到，换过之后就会显示）`/, '还没选过模型时如实说读不到')
	assert.match(String(card.args.content), /1 个提供商读不到模型/)
	const rows = card.args.keyboard.content.rows.map((row) => row.buttons.map((b) => b.render_data.label))
	assert.deepEqual(rows, [[clipLabel('DeepSeek'), clipLabel('OpenAI')]], '提供商每行 2 个')

	// 点提供商 → 模型列表卡片：每个模型一行，label 是**全名**（不再自己砍）
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: cardData.model('enter', 'deepseek'),
		eventId: 'INT-MODEL-1',
		msgId: 'CARD-M1',
	})
	const modelCard = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1) ?? null
	})
	assert.match(String(modelCard.args.content), /\*\*模型 · DeepSeek\*\*/)
	const modelRows = modelCard.args.keyboard.content.rows
	assert.ok(
		modelRows.slice(0, -1).every((row) => row.buttons.length === 1),
		'模型每行最多 1 个',
	)
	assert.deepEqual(
		modelCard.args.keyboard.content.rows.flatMap((r) => r.buttons).map((b) => b.render_data.label),
		['DeepSeek Chat', 'DeepSeek Reasoner', '返回'],
		'模型按钮照发全名（以前会被砍成 "DeepSe…"）',
	)

	// 点一个模型 → **确认卡片**（不立刻切！）
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: cardData.model('pick', 'deepseek:deepseek-reasoner'),
		eventId: 'INT-MODEL-2',
		msgId: 'CARD-M2',
	})
	const confirmCard = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1) ?? null
	})
	assert.deepEqual(boot.ctx.sessionController.selectedModels, [], '确认之前绝不能已经切了')
	assert.match(String(confirmCard.args.content), /\*\*模型 · 确认\*\*/)
	assert.match(String(confirmCard.args.content), /选中的模型：\*\*DeepSeek \/ DeepSeek Reasoner\*\*/)
	assert.deepEqual(
		confirmCard.args.keyboard.content.rows.map((row) => row.buttons.map((b) => b.render_data.label)),
		[['应用到当前会话', '切到其他会话'], ['返回']],
	)
	assert.ok(
		confirmCard.args.keyboard.content.rows
			.flatMap((r) => r.buttons)
			.every((b) => b.action.type === 1),
		'三个都是交互式回调按钮（不再是"填输入框"的指令按钮）',
	)

	// 「应用到当前会话」→ 真的切 + 模型列表卡片重发（标出新当前 + ✅）
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: cardData.model('apply', 'deepseek:deepseek-reasoner'),
		eventId: 'INT-MODEL-3',
		msgId: 'CARD-M3',
	})
	const applied = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1) ?? null
	})
	assert.deepEqual(boot.ctx.sessionController.selectedModels, [
		{ sessionId: 'session-1', provider: 'deepseek', model: 'deepseek-reasoner' },
	])
	assert.match(String(applied.args.content), /✅ 已切到 \*\*DeepSeek \/ DeepSeek Reasoner\*\*/)
	assert.match(String(applied.args.content), /当前：\*\*DeepSeek \/ DeepSeek Reasoner\*\*/)

	// 「切到其他会话」→ 提示卡片（等会话id）+ 真的等状态；发一条会话id 就切给那个会话
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: cardData.model('pick', 'deepseek:deepseek-chat'),
		eventId: 'INT-MODEL-4',
		msgId: 'CARD-M4',
	})
	await drainFor(boot.socketPath, 80)
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: cardData.model('other', 'deepseek:deepseek-chat'),
		eventId: 'INT-MODEL-5',
		msgId: 'CARD-M5',
	})
	const promptCard = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1) ?? null
	})
	assert.match(String(promptCard.args.content), /\*\*模型 · 切到其他会话\*\*/)
	assert.deepEqual(promptCard.args.keyboard.content.rows.flatMap((r) => r.buttons).map((b) => b.render_data.label), ['取消'])

	// 认不出的"会话id"：保持等待并说清楚（不会误切）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '这不是会话id', msgId: 'M9' })
	const wrong = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /认不出会话引用|没找到会话/.test(String(c.args.content))) ?? null
	})
	assert.match(String(wrong.args.content), /再发一次/)

	// 发一条真会话id → 切给 session-2（不要求先绑定它），并只回执
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: 'session-2', msgId: 'M10' })
	const switched = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /的模型切成/.test(String(c.args.content))) ?? null
	})
	assert.match(String(switched.args.content), /DeepSeek \/ DeepSeek Chat/)
	assert.deepEqual(boot.ctx.sessionController.selectedModels.at(-1), {
		sessionId: 'session-2',
		provider: 'deepseek',
		model: 'deepseek-chat',
	})
	// 等待状态用完即清：下一条普通消息不会再被吃掉
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '普通消息', msgId: 'M11' })
	const after = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.some((c) => c.kind === 'send_c2c' && /认不出会话引用/.test(String(c.args.content))) ? list : null
	}).catch(() => null)
	assert.equal(after, null, '不该再拿普通消息当会话id')

	// 回到提供商列表：这一次"当前"要标出来，并且提供商按钮是蓝色
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: cardData.model('list'),
		eventId: 'INT-MODEL-6',
		msgId: 'CARD-M6',
	})
	const listed = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /\*\*模型\*\*/.test(String(c.args.content))) ?? null
	})
	assert.match(String(listed.args.content), /当前：\*\*DeepSeek \/ DeepSeek Reasoner\*\*/)
	const dsButton = listed.args.keyboard.content.rows
		.flatMap((row) => row.buttons)
		.find((b) => b.action.data === cardData.model('enter', 'deepseek'))
	assert.equal(dsButton.render_data.style, 1, '当前提供商标蓝')

	// 带参数直接切（显示名/空格也认）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '模型 OpenAI/GPT 5.2', msgId: 'M2' })
	const direct = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /的模型切成/.test(String(c.args.content))) ?? null
	})
	assert.match(String(direct.args.content), /GPT 5\.2/)
	assert.deepEqual(boot.ctx.sessionController.selectedModels.at(-1), {
		sessionId: 'session-1',
		provider: 'openai',
		model: 'gpt-5.2',
	})

	// 末尾带会话id：切给**别的会话**（不要求先绑定它）
	await rpc(boot.socketPath, 'event', {
		kind: 'c2c_message',
		openid: 'U1',
		text: '模型 deepseek/deepseek-chat session-2',
		msgId: 'M3',
	})
	await waitFor(() => boot.ctx.sessionController.selectedModels.at(-1)?.sessionId === 'session-2')
	assert.deepEqual(boot.ctx.sessionController.selectedModels.at(-1), {
		sessionId: 'session-2',
		provider: 'deepseek',
		model: 'deepseek-chat',
	})

	// 认不出的模型 / 写错的会话id：都要明确报错 + 回用法
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '模型 nope/nope', msgId: 'M4' })
	const badModel = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /认不出提供商/.test(String(c.args.content))) ?? null
	})
	assert.match(String(badModel.args.content), /用法：/)

	await rpc(boot.socketPath, 'event', {
		kind: 'c2c_message',
		openid: 'U1',
		text: '模型 deepseek/deepseek-chat session-nope',
		msgId: 'M5',
	})
	const badSession = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /没找到会话/.test(String(c.args.content))) ?? null
	})
	assert.match(String(badSession.args.content), /用法：/)

	boot.dispose()
})

// ── 快捷（#编号 / 备注 / 会话id） ───────────────────────────────────────────

// 快捷和「会话选择卡片」的关键区别：那张卡片的会话按钮是**指令按钮**（只把命令填进
// 输入框），这张是**回调按钮**（点一下当场切过去）——"快捷"要的就是少点两下。
test('端到端：快捷 —— 裸发是帮助、列出给卡片、点按钮直接切、带消息只投递不切换', async (t) => {
	const agent1 = makeAgent('session-1')
	const agent2 = makeAgent('session-2')
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': agent1, 'session-2': agent2 } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', {
		openids: [{ openid: 'U1' }],
		panel: { enabled: true, users: ['U1'] },
		menu: { enabled: true },
	})

	// 0) **裸发 = 帮助**（用户明确要求）：只回文本，不发卡片
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '快捷', msgId: 'M0' })
	const help = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /切过去/.test(String(c.args.content))) ?? null
	})
	assert.match(String(help.args.content), /还没有快捷会话/)
	assert.equal(help.args.keyboard, undefined, '裸发只回帮助文本，不发卡片')

	// 1) 绑到 session-1，加进快捷（带备注）
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M1' })
	await waitFor(async () => (await pumpQueue(boot.socketPath)).some((c) => c.kind === 'send_c2c'))
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '快捷 加 前端', msgId: 'M2' })
	const added = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && /已加入快捷/.test(String(c.args.content))) ?? null
	})
	assert.match(String(added.args.content), /#1 前端/)

	// 2) 换到 session-2，再发 `快捷 列出` 拿卡片
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-2', msgId: 'M3' })
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '快捷 列出', msgId: 'M4' })
	const card = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 60)
		return list.find((c) => c.kind === 'send_c2c' && c.args.keyboard && /快捷/.test(String(c.args.content))) ?? null
	})
	const rows = card.args.keyboard.content.rows
	assert.ok(rows.length <= 5, '键盘行数不能超平台上限')
	for (const row of rows) assert.ok(row.buttons.length <= 5, '每行按钮数不能超平台上限')
	const buttons = rows.flatMap((row) => row.buttons)
	const go = buttons.find((b) => b.action.data === cardData.shortcut('go', 1))
	assert.ok(go, '每条快捷一个回调按钮')
	assert.equal(go.action.type, 1, '快捷按钮是回调按钮（点一下当场切，不是填输入框）')
	assert.equal(go.render_data.label, '#1 前端', '按钮上就是 `#编号 备注`')
	assert.equal(go.render_data.style, 0, '当前绑的是 session-2，所以 #1 不是"当前"')
	assert.ok(buttons.some((b) => b.action.data === cardData.shortcut('add')), '要有「加当前会话」')

	// 3) 点 #1 → **当场切过去**，并把卡片重发一遍标出新的"当前"
	await rpc(boot.socketPath, 'event', {
		kind: 'interaction',
		openid: 'U1',
		buttonData: go.action.data,
		eventId: 'INT-SC',
		msgId: 'CARD-SC',
	})
	const afterClick = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.some((c) => c.kind === 'respond_interaction') ? list : null
	})
	assert.ok(afterClick.some((c) => c.kind === 'respond_interaction' && c.args.code === 0), '按钮要回 code 0')
	assert.ok(
		afterClick.some((c) => c.kind === 'send_c2c' && /已接入/.test(String(c.args.content))),
		'点快捷要回执"已接入"',
	)
	const refreshed = afterClick.filter((c) => c.kind === 'send_c2c' && c.args.keyboard).at(-1)
	assert.ok(refreshed, '点完要重发卡片')
	const refreshedGo = refreshed.args.keyboard.content.rows
		.flatMap((row) => row.buttons)
		.find((b) => b.action.data === cardData.shortcut('go', 1))
	assert.equal(refreshedGo.render_data.style, 1, '重发的卡片要把新的"当前"标蓝')

	// 绑定与快捷条目都真的落盘了（不只是内存里对）
	const readState = () => JSON.parse(readFileSync(boot.stateFile, 'utf8'))
	const saved = await waitFor(() => {
		try {
			return readState().bindings.U1 === 'session-1' ? readState() : null
		} catch {
			return null
		}
	})
	assert.deepEqual(
		saved.shortcuts.U1.items.map((item) => [item.id, item.sessionId, item.name]),
		[[1, 'session-1', '前端']],
	)

	// 4) `快捷 #1 <消息>` = **只投递、不切换**（用户明确要求）：先回到 session-2 再试
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-2', msgId: 'M5' })
	await drainFor(boot.socketPath, 60)
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '快捷 #1 你好', msgId: 'M6' })
	await waitFor(() => agent1.followed.length > 0)
	assert.equal(agent1.followed.at(-1).content[0].text, '你好')
	assert.equal(agent1.followed.at(-1).source.kind, 'user', 'QQ 里打的字要标成人类输入')
	assert.equal(agent2.followed.length, 0, '不能投错会话')
	assert.ok(
		(await drainFor(boot.socketPath, 80)).some((c) => c.kind === 'send_c2c' && /没有切换/.test(String(c.args.content))),
		'回执要说清楚"没有切换"',
	)
	await waitFor(() => readState().bindings.U1 === 'session-2')
	assert.equal(readState().bindings.U1, 'session-2', '带消息的那次绝不能把绑定带走')

	boot.dispose()
})

test('端到端：快捷的备注不能带 #（含 # 的备注必须被拒，列表不能变）', async (t) => {
	const boot = bootPlugin(t, { sessions: SUMMARIES, live: { 'session-1': makeAgent('session-1') } })
	await waitFor(() => existsSync(boot.socketPath))
	await rpc(boot.socketPath, 'register', { openids: [{ openid: 'U1' }], panel: { enabled: true, users: ['U1'] }, menu: { enabled: true } })
	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '切换会话 session-1', msgId: 'M1' })
	await drainFor(boot.socketPath, 60)

	await rpc(boot.socketPath, 'event', { kind: 'c2c_message', openid: 'U1', text: '快捷 加 前端#1', msgId: 'M2' })
	const refused = await waitFor(async () => {
		const list = await drainFor(boot.socketPath, 80)
		return list.find((c) => c.kind === 'send_c2c' && /备注里不能有/.test(String(c.args.content))) ?? null
	})
	assert.match(String(refused.args.content), /管条目/, '被拒时要带上分节帮助')
	assert.equal(JSON.parse(readFileSync(boot.stateFile, 'utf8')).shortcuts?.U1?.items?.length ?? 0, 0)

	boot.dispose()
})
