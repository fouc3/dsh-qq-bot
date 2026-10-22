import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCommandRunner, menuItems, panelItems, parseCommand, requiresArgs, usageText } from './commands.js'
import { createState } from './state.js'

function makeSessions() {
	const map = new Map([
		['session-1', { sessionId: 'session-1', cwd: '/home/u/proj-a', updatedAt: 2, running: false }],
		['session-2', { sessionId: 'session-2', cwd: '/home/u/proj-b', updatedAt: 1, running: true }],
		['session-3', { sessionId: 'session-3', cwd: '/home/u/proj-c', updatedAt: 1, running: false }],
		['session-archived', { sessionId: 'session-archived', cwd: '/home/u/old', updatedAt: 1, running: false }],
	])
	return {
		get: (id) => map.get(id),
		describe: (id) => `**${id}**\`(${id})\``,
		label: (id) => `标题:${id}(${id})`,
		titleOf: (id) => `标题:${id}`,
		displayId: (id) => id,
		isArchived: (id) => id === 'session-archived',
		defaultRoot: () => '/home/u',
		listDirs: () => [],
		sessionsInDir: () => [],
		parentOf: () => null,
		resolveRef(tokens) {
			const list = [...tokens]
			if (list.length === 0) return null
			if (list[0] === 'none') return { sessionId: 'none', content: list.slice(1).join(' ') }
			if (map.has(list[0])) return { sessionId: list[0], cwd: map.get(list[0]).cwd, content: list.slice(1).join(' ') }
			if (list[0].startsWith('/')) {
				if (!map.has(list[1])) return { error: `目录 \`${list[0]}\` 下没找到会话` }
				return { sessionId: list[1], cwd: map.get(list[1]).cwd, content: list.slice(2).join(' ') }
			}
			if (list[0].startsWith('session-')) return { error: `没找到会话 \`${list[0]}\`` }
			return null
		},
	}
}

function makeRunner({ seed = {}, modelResult = { ok: true, text: '**DeepSeek / DeepSeek Chat**' } } = {}) {
	const calls = {
		replies: [],
		delivered: [],
		stopped: [],
		archived: [],
		cards: [],
		inputs: [],
		modelCards: [],
		models: [],
		shortcutCards: [],
		runningCards: [],
		presetCards: [],
		presets: [],
	}
	const state = createState({ seed })
	const runner = createCommandRunner({
		sessions: makeSessions(),
		state,
		logger: {},
		reply: async ({ openid, content }) => calls.replies.push({ openid, content }),
		showSessionCard: async ({ openid, dir }) => calls.cards.push({ openid, dir }),
		showShortcutCard: async ({ openid, page = 1 }) =>
			calls.shortcutCards.push({ openid, page, items: state.shortcutsOf(openid) }),
		showRunningCard: async ({ openid, page = 1 }) => calls.runningCards.push({ openid, page }),
		showPresetCard: async ({ openid, sessionId }) => calls.presetCards.push({ openid, sessionId }),
		setPreset: async ({ openid, sessionId, tokens }) => {
			calls.presets.push({ openid, sessionId, tokens })
			return { ok: true, value: 'adventure', text: '**冒险模式** — 探索优先' }
		},
		showModelCard: async ({ openid, sessionId }) => calls.modelCards.push({ openid, sessionId }),
		setModel: async ({ openid, sessionId, spec }) => {
			calls.models.push({ openid, sessionId, spec })
			return modelResult
		},
		deliver: async (req) => calls.delivered.push(req),
		beginInput: async ({ openid, sessionId, mode = 'send' }) => {
			calls.inputs.push({ openid, sessionId, ...(mode === 'send' ? {} : { mode }) })
			return { ok: true }
		},
		stopSession: async (sessionId) => {
			calls.stopped.push(sessionId)
			return { ok: true }
		},
		archiveSession: async (sessionId) => {
			calls.archived.push(sessionId)
			return { ok: true }
		},
	})
	return { runner, calls, state }
}

const boundSeed = () => ({ bindings: { U1: 'session-1' } })

test('parseCommand：可带一个前导斜杠，非命令返回 null', () => {
	assert.deepEqual(parseCommand('切换会话'), { name: '切换会话', tokens: [], rest: '' })
	assert.deepEqual(parseCommand('/发送 session-1 你好'), { name: '发送', tokens: ['session-1', '你好'], rest: 'session-1 你好' })
	assert.deepEqual(parseCommand('  延迟发送  session-2  打完了叫我 '), {
		name: '延迟发送',
		tokens: ['session-2', '打完了叫我'],
		rest: 'session-2 打完了叫我',
	})
	// 旧名 `进度` 是 `状态` 的别名（改名后手滑按老习惯发，不该被当成普通消息投给 AI）
	assert.deepEqual(parseCommand('进度'), { name: '状态', tokens: [], rest: '' })
	assert.deepEqual(parseCommand('进度 session-1'), { name: '状态', tokens: ['session-1'], rest: 'session-1' })
	assert.equal(parseCommand('你好'), null)
	assert.equal(parseCommand('/'), null)
	assert.equal(parseCommand(''), null)
	assert.equal(requiresArgs('发送'), false, '裸发 `发送` 要能进输入态，所以不算"必须带参"')
	assert.equal(requiresArgs('延迟发送'), false, '裸发 `延迟发送` 也要能进输入态')
	assert.equal(requiresArgs('停止'), false)
})

test('需要参数的命令无参时回作用与用法', () => {
	const usage = usageText('延迟发送')
	assert.match(usage, /延迟发送/)
	assert.match(usage, /作用：/)
	assert.match(usage, /用法：/)
	assert.match(usage, /延迟发送 <会话id> <内容>/)
})

test('面板条目与菜单条目都由同一张命令表派生', () => {
	const items = panelItems()
	assert.equal(items.length, 12)
	assert.deepEqual(items.map((i) => i.name), [
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
		'角色预设',
	])
	assert.equal(items.at(-1).desc, '看/切角色预设（生存/冒险…）')

	// 自定义菜单：顶层仍只有 8 项（7 个平铺 + 1 个「管理」二级菜单）——
	// 平台顶层最多 10，得给 dsh 命令的二级菜单留位，所以新命令进「管理」。
	const menu = menuItems()
	assert.equal(menu.length, 8)
	assert.deepEqual(
		menu.filter((it) => it.type !== 'menu').map((it) => it.sendMessage),
		['切换会话', '快捷', '新建会话', '发送', '延迟发送', '模型', '状态'],
	)
	const manage = menu.find((it) => it.type === 'menu')
	assert.equal(manage.name, '管理')
	assert.deepEqual(
		manage.children.map((it) => it.sendMessage),
		['停止', '归档', '权限', '运行中会话', '角色预设'],
	)
	// 每条命令都还在菜单里（平铺或二级菜单），不能因为收编而消失
	const shown = new Set([
		...menu.filter((it) => it.type !== 'menu').map((it) => it.name),
		...manage.children.map((it) => it.name),
	])
	assert.deepEqual([...shown].sort(), items.map((i) => i.name).sort())
})

// 用户要求（2026-10-16）：新增 `运行中会话`（无参发卡片；带会话id 直接切）。
test('运行中会话：无参发卡片；带会话id 直接切（复用 switchSession）', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })

	const carded = await runner.run({ openid: 'U1', quote: '' }, { name: '运行中会话', tokens: [], rest: '' })
	assert.equal(carded.handled, true)
	assert.equal(calls.runningCards.length, 1, '无参 = 发那张卡片')
	assert.equal(calls.runningCards[0].page, 1, '默认第一页')

	// 带会话id：直接切过去（等价 `切换会话 <id>`，不重复实现）
	const switched = await runner.run({ openid: 'U1', quote: '' }, { name: '运行中会话', tokens: ['session-2'], rest: 'session-2' })
	assert.equal(switched.handled, true)
	assert.equal(s.bindingOf('U1'), 'session-2', '点一下就该切过去')
	assert.ok(calls.replies.some((r) => /已接入/.test(r.content)), '要有切过去的回执')

	// 从卡片上点过来（fromCard）：切完把卡片重发一遍，标出新的「当前会话」，**留在原来那一页**
	calls.runningCards.length = 0
	await runner.run(
		{ openid: 'U1', quote: '', fromCard: true, page: 3 },
		{ name: '运行中会话', tokens: ['session-1'], rest: 'session-1' },
	)
	assert.equal(s.bindingOf('U1'), 'session-1')
	assert.equal(calls.runningCards.length, 1, '卡片上点过来要重发卡片（更新"当前"）')
	assert.equal(calls.runningCards[0].page, 3, '重发要留在第 3 页，不能跳回第一页')
})

// 用户要求（2026-10-17）：`角色预设` —— 无参发卡片（与权限卡同款逻辑）；带参数直接切；别名 `预设` 也认。
test('角色预设：无参发卡片；带参数直接切；没绑定会话先提示切换；别名 预设 认', async () => {
	const { runner, calls } = makeRunner({ seed: boundSeed() })

	const carded = await runner.run({ openid: 'U1', quote: '', replyContext: {} }, { name: '角色预设', tokens: [], rest: '' })
	assert.equal(carded.handled, true)
	assert.deepEqual(calls.presetCards, [{ openid: 'U1', sessionId: 'session-1' }], '无参 = 发卡片（作用于当前绑定会话）')

	const set = await runner.run(
		{ openid: 'U1', quote: '', replyContext: {} },
		{ name: '角色预设', tokens: ['冒险模式'], rest: '冒险模式' },
	)
	assert.equal(set.handled, true)
	assert.deepEqual(calls.presets, [{ openid: 'U1', sessionId: 'session-1', tokens: ['冒险模式'] }], '带参 = 直接切')
	assert.ok(
		calls.replies.some((r) => /已把/.test(r.content) && /角色预设切成/.test(r.content)),
		'要有切过去的回执',
	)

	// 没绑定会话：先提示 `切换会话`（与 `权限` 一致），不发卡片
	const { runner: unbound, calls: unboundCalls } = makeRunner({ seed: {} })
	const hint = await unbound.run({ openid: 'U1', quote: '', replyContext: {} }, { name: '角色预设', tokens: [], rest: '' })
	assert.equal(hint.handled, true)
	assert.equal(unboundCalls.presetCards.length, 0)
	assert.match(unboundCalls.replies.at(-1).content, /先 `切换会话`/)

	// 别名：`预设` → `角色预设`
	assert.equal(parseCommand('预设')?.name, '角色预设')
	assert.deepEqual(parseCommand('角色预设 生存模式')?.tokens, ['生存模式'])
})

test('切换会话：无参=会话选择；带会话id=绑定；none=解绑', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话'))
	assert.equal(calls.cards.length, 1)

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-2'))
	assert.equal(s.bindingOf('U1'), 'session-2')
	assert.match(calls.replies.at(-1).content, /已接入/)

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 none'))
	assert.equal(s.bindingOf('U1'), null)
	assert.match(calls.replies.at(-1).content, /解除绑定/)
})

test('切换会话：归档会话不能接入', async () => {
	const { runner, calls } = makeRunner({ seed: boundSeed() })
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-archived'))
	assert.match(calls.replies.at(-1).content, /已归档/)
})

test('发送：裸发进输入态；缺内容回用法；带目标与内容则投递（不打断）', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })

	// 裸发 `发送` = 进当前会话的输入态（不投递、不打断）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('发送'))
	assert.deepEqual(calls.inputs, [{ openid: 'U1', sessionId: 'session-1' }])
	assert.equal(calls.delivered.length, 0)

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('发送 session-2'))
	// 只给目标会话 = 进**那个会话**的输入态（用户要求：不再回用法）
	assert.deepEqual(calls.inputs, [
		{ openid: 'U1', sessionId: 'session-1' },
		{ openid: 'U1', sessionId: 'session-2' },
	])
	assert.equal(calls.delivered.length, 0)
	// 绑定没被改
	assert.equal(s.bindingOf('U1'), 'session-1')

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('发送 session-2 帮我看下这个'))
	assert.equal(calls.delivered.length, 1)
	assert.equal(calls.delivered[0].sessionId, 'session-2')
	assert.equal(calls.delivered[0].text, '帮我看下这个')
	assert.equal(calls.delivered[0].interrupt, true, '发送＝打断当前轮次（不想打断用 延迟发送）')
	assert.match(calls.replies.at(-1).content, /已投递/)
})

test('发送：认不出目标时回用法、目标不存在时明确报错（都不会误进输入态）', async () => {
	const { runner, calls } = makeRunner({ seed: boundSeed() })

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('发送 你好'))
	assert.equal(calls.inputs.length, 0)
	assert.match(calls.replies.at(-1).content, /用法/)

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('发送 session-nope'))
	assert.equal(calls.inputs.length, 0)
	assert.match(calls.replies.at(-1).content, /没找到会话|目录/)
})

test('发送：没绑定会话时裸发不进输入态，而是回用法', async () => {
	const { runner, calls } = makeRunner()
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('发送'))
	assert.equal(calls.inputs.length, 0)
	assert.match(calls.replies.at(-1).content, /没有绑定会话/)
})

test('延迟发送：与发送共用输入态面板（mode=delay）；带内容则直接登记', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })

	// 裸发 → 进当前会话的**延迟**输入态
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('延迟发送'))
	assert.deepEqual(calls.inputs, [{ openid: 'U1', sessionId: 'session-1', mode: 'delay' }])

	// 只给目标 → 进那个会话的延迟输入态
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('延迟发送 session-2'))
	assert.deepEqual(calls.inputs.at(-1), { openid: 'U1', sessionId: 'session-2', mode: 'delay' })

	// 带内容 → 直接登记（覆盖该会话原有待发消息）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('延迟发送 session-2 打完了叫我'))
	assert.equal(s.delayedOf('session-2').content, '打完了叫我')
	assert.equal(s.delayedOf('session-2').openid, 'U1')
	assert.match(calls.replies.at(-1).content, /已登记/)
})

test('延迟发送：目标不存在时报错、认不出目标时回用法（都不会误进输入态）', async () => {
	const { runner, calls } = makeRunner({ seed: boundSeed() })

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('延迟发送 hello'))
	assert.equal(calls.inputs.length, 0)
	assert.match(calls.replies.at(-1).content, /用法/)

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('延迟发送 session-nope'))
	assert.equal(calls.inputs.length, 0)
	assert.match(calls.replies.at(-1).content, /没找到会话|目录/)
})

test('停止/归档：无参作用于当前会话，带参作用于指定会话', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('停止'))
	assert.deepEqual(calls.stopped, ['session-1'])

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('停止 session-2'))
	assert.deepEqual(calls.stopped, ['session-1', 'session-2'])

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('归档 session-1'))
	assert.deepEqual(calls.archived, ['session-1'])
	// 归档后应解除指向它的绑定
	assert.equal(s.bindingOf('U1'), null)
	assert.match(calls.replies.at(-1).content, /已归档/)
})

test('未绑定会话时停止/归档会提示', async () => {
	const { runner, calls } = makeRunner()
	await runner.run({ openid: 'U9', replyContext: {} }, parseCommand('停止'))
	assert.match(calls.replies.at(-1).content, /当前没有绑定会话/)
	assert.equal(calls.stopped.length, 0)
})

test('模型：不带参数发提供商卡片；带参数直接切；末尾可选会话id（默认当前会话）', async () => {
	const { runner, calls } = makeRunner({ seed: boundSeed() })

	// 不带参数 → 卡片（作用于当前绑定会话）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('模型'))
	assert.deepEqual(calls.modelCards, [{ openid: 'U1', sessionId: 'session-1' }])
	assert.equal(calls.models.length, 0)

	// 带 `提供商/模型` → 直接切当前会话
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('模型 deepseek/deepseek-chat'))
	assert.deepEqual(calls.models, [{ openid: 'U1', sessionId: 'session-1', spec: 'deepseek/deepseek-chat' }])
	assert.match(calls.replies.at(-1).content, /已把 .*session-1.* 的模型切成/)

	// 末尾跟会话id → 切给那个会话
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('模型 deepseek/deepseek-reasoner session-2'))
	assert.deepEqual(calls.models.at(-1), {
		openid: 'U1',
		sessionId: 'session-2',
		spec: 'deepseek/deepseek-reasoner',
	})

	// 模型名字里带空格也不能被当成会话id（认不出就整段都是模型名字）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('模型 OpenAI/GPT 5.2'))
	assert.deepEqual(calls.models.at(-1), { openid: 'U1', sessionId: 'session-1', spec: 'OpenAI/GPT 5.2' })
})

test('模型：会话id写错要明确报错（不能当成模型名字）；切失败要带用法；没绑定会话也提示', async () => {
	const { runner, calls } = makeRunner({ seed: boundSeed() })

	// `session-nope` 认成"会话id但不存在" → 报错，且**不能**把会话id当模型名字去切
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('模型 deepseek/deepseek-chat session-nope'))
	assert.equal(calls.models.length, 0)
	assert.match(calls.replies.at(-1).content, /没找到会话/)
	assert.match(calls.replies.at(-1).content, /用法/)

	// 底层切失败（服务报错/会话锁模型）→ 原样带上错误 + 用法
	const failing = makeRunner({ seed: boundSeed(), modelResult: { ok: false, error: '这个会话锁定了模型' } })
	await failing.runner.run({ openid: 'U1', replyContext: {} }, parseCommand('模型 deepseek/deepseek-chat'))
	assert.match(failing.calls.replies.at(-1).content, /这个会话锁定了模型/)
	assert.match(failing.calls.replies.at(-1).content, /用法/)

	// 没绑定会话：无参要提示，带会话id照常能切
	const free = makeRunner()
	await free.runner.run({ openid: 'U9', replyContext: {} }, parseCommand('模型'))
	assert.equal(free.calls.modelCards.length, 0)
	assert.match(free.calls.replies.at(-1).content, /当前没有绑定会话/)

	await free.runner.run({ openid: 'U9', replyContext: {} }, parseCommand('模型 deepseek/deepseek-chat session-2'))
	assert.deepEqual(free.calls.models, [{ openid: 'U9', sessionId: 'session-2', spec: 'deepseek/deepseek-chat' }])

	// 用法里两种写法都要写出来
	const usage = usageText('模型')
	assert.match(usage, /模型 <提供商>\/<模型名字>/)
	assert.match(usage, /模型 <提供商>\/<模型名字> <会话id>/)
})

test('未知会话 id 会给出明确错误与用法', async () => {
	const { runner, calls } = makeRunner()
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('发送 session-nope 内容'))
	assert.match(calls.replies.at(-1).content, /没找到会话/)
	assert.match(calls.replies.at(-1).content, /用法/)
	assert.equal(calls.delivered.length, 0)
})

test('发送/延迟发送带引用：被引用的那条要一起带给 AI', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })

	// `发送 <会话id> <正文>` + 引用
	await runner.run(
		{ openid: 'U1', replyContext: {}, quote: '这是被引用的那条消息' },
		parseCommand('发送 session-2 帮我看下这个'),
	)
	assert.equal(calls.delivered.length, 1)
	assert.equal(
		calls.delivered[0].text,
		'[引用的消息] 这是被引用的那条消息\n\n帮我看下这个',
		'引用要拼在正文前面（与普通消息路径同格式）',
	)

	// 没有引用时不能凭空多一行
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('发送 session-2 再来一条'))
	assert.equal(calls.delivered.at(-1).text, '再来一条')

	// `延迟发送 <会话id> <正文>` + 引用：登记的内容也要带引用
	await runner.run(
		{ openid: 'U1', replyContext: {}, quote: '引用内容' },
		parseCommand('延迟发送 session-2 打完了叫我'),
	)
	assert.equal(s.delayedOf('session-2').content, '[引用的消息] 引用内容\n\n打完了叫我')
})

// ── 快捷（#编号 / 备注 / 会话id） ───────────────────────────────────────────

test('快捷：裸发=帮助（不是卡片）；`列出`/`list`/`l` 才发卡片；`加`把当前会话存成 #1', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })

	// 裸发 = 帮助（用户要求）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷'))
	assert.equal(calls.shortcutCards.length, 0, '裸发不该发卡片')
	const help = calls.replies.at(-1).content
	assert.match(help, /^\*\*快捷\*\* —— 常用会话的快捷入口/, '开头一句话说清这是什么')
	assert.match(help, /\*\*切过去\*\*/, '分节：切过去')
	assert.match(help, /\*\*管条目\*\*/, '分节：管条目')
	assert.match(help, /快捷 加 \[备注\]/)
	assert.match(help, /英文缩写/, '英文缩写写在末尾的引用块里')
	assert.match(help, /还没有快捷会话/, '空列表：末尾要带上"现在有几条"')
	assert.ok(help.indexOf('还没有快捷会话') > help.indexOf('管条目'), '状态写在帮助后面（先给读法）')

	// 中英文都认：列表
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 列出'))
	assert.equal(calls.shortcutCards.length, 1)
	assert.deepEqual(calls.shortcutCards[0].items, [])

	// 不带备注：#1，备注为空（显示时用会话标题）；中文 / 英文缩写都认
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => [i.id, i.sessionId, i.name]), [[1, 'session-1', '']])
	assert.match(calls.replies.at(-1).content, /已加入快捷.*#1/s)

	// 切到别的会话再加一条 → #2
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-2'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 后端'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => [i.id, i.sessionId, i.name]), [
		[1, 'session-1', ''],
		[2, 'session-2', '后端'],
	])
	assert.match(calls.replies.at(-1).content, /#2 后端/)

	// 同一个会话再加一次：只更新备注，不攒第二条
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 后端主线'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => [i.id, i.sessionId, i.name]), [
		[1, 'session-1', ''],
		[2, 'session-2', '后端主线'],
	])
	assert.match(calls.replies.at(-1).content, /已经在快捷里/)
})

// 用户 2026-10-17：「同一个文件夹会话咋还误判 / 哦，你没支持填写 session 吗，加下」
// 以前 `快捷 加` 只认**当前绑定会话**，后面跟的会话id被整串当成备注 ⇒ 往同一条上改，
// 看起来就像"同一个文件夹的两个会话被误判成同一条"。现在末尾写会话id就存指定的那个。
test('快捷 加 [备注] <会话id>：存**指定的**会话（不同会话各自一条，不再并进当前那条）', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() }) // U1 绑 session-1

	// ① 指定 session-2（不是当前绑定的）→ 新增一条，前面那段是备注
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 proj-b session-2'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => [i.id, i.sessionId, i.name]), [[1, 'session-2', 'proj-b']])
	assert.match(calls.replies.at(-1).content, /已加入快捷/)
	assert.equal(s.bindingOf('U1'), 'session-1', '加条目不该改当前绑定')

	// ② 再加另一个会话 → 必须是**新编号**（用户报的就是这里：以前并进同一条）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 proj-c session-3'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => [i.id, i.sessionId, i.name]), [
		[1, 'session-2', 'proj-b'],
		[2, 'session-3', 'proj-c'],
	])
	assert.match(calls.replies.at(-1).content, /#2/)

	// ③ 同一个会话再加一次（带新备注）→ 还是原来那条，只改备注
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 新备注 session-2'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => [i.id, i.sessionId, i.name]), [
		[1, 'session-2', '新备注'],
		[2, 'session-3', 'proj-c'],
	])
	assert.match(calls.replies.at(-1).content, /已经在快捷里/)

	// ④ 只写会话id（不带备注）也认；备注里带空格的老写法不受影响
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 session-1'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => [i.id, i.sessionId, i.name]), [
		[1, 'session-2', '新备注'],
		[2, 'session-3', 'proj-c'],
		[3, 'session-1', ''],
	])

	// ⑤ 认不出会话id时报错（说"找不到会话"，而不是"没有绑定会话"——用户明明绑着），也不能悄悄当备注存进去
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 某个备注 session-nope'))
	const after = s.shortcutsOf('U1')
	assert.equal(after.length, 3, '认不出会话就不能新增条目')
	assert.match(calls.replies.at(-1).content, /找不到会话/, '要说清楚是"找不到那个会话"')
})

// 需求（2026-10-17）：「把快捷 #1 的会话id 改为 <新会话>」。
// 编号只增不重用，所以"删了再加"拿不回 #1 —— 得有一条原地改目标的命令。
test('快捷 改 #编号 <会话id>：原地换目标，编号与备注都不动', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 memos'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-2'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 后端'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => [i.id, i.sessionId, i.name]), [
		[1, 'session-1', 'memos'],
		[2, 'session-2', '后端'],
	])

	// ① 正常改：#1 从 session-1 换成 session-3
	const cardsBefore = calls.shortcutCards.length
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 改 #1 session-3'))
	assert.deepEqual(
		s.shortcutsOf('U1').map((i) => [i.id, i.sessionId, i.name]),
		[
			[1, 'session-3', 'memos'],
			[2, 'session-2', '后端'],
		],
		'编号与备注都不动，只换指向',
	)
	assert.match(calls.replies.at(-1).content, /#1 memos/)
	assert.match(calls.replies.at(-1).content, /session-3/)
	assert.match(calls.replies.at(-1).content, /session-1/, '要告诉用户原来是哪个')
	assert.equal(s.bindingOf('U1'), 'session-2', '改目标不该动当前绑定')
	assert.ok(calls.shortcutCards.length >= cardsBefore, '改完逻辑不接受崩溃即可（卡片重发只在 fromCard 时）')

	// ② 用备注定位也认；英文别名 set 也认
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 set 后端 session-1'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => [i.id, i.sessionId]), [
		[1, 'session-3'],
		[2, 'session-1'],
	])

	// ③ 改成已经指向它的那条 → 拒绝（同一条会话不存两次）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 改 #1 session-1'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => [i.id, i.sessionId]), [
		[1, 'session-3'],
		[2, 'session-1'],
	])
	assert.match(calls.replies.at(-1).content, /#2 已经指向这个会话/)

	// ④ 目标会话认不出来 → 报错且状态不动
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 改 #1 session-nope'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => [i.id, i.sessionId]), [
		[1, 'session-3'],
		[2, 'session-1'],
	])
	assert.match(calls.replies.at(-1).content, /找不到会话/)

	// ⑤ 本来就是这个会话 → 如实说"没改动"
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 改 #1 session-3'))
	assert.match(calls.replies.at(-1).content, /本来就指向/)

	// ⑥ 不写会话id = 改到**当前会话**（2026-10-18 用户要求）：#2 现在是 session-1，当前绑定 session-2
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 改 #2'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => [i.id, i.sessionId]), [
		[1, 'session-3'],
		[2, 'session-2'],
	])
	assert.match(calls.replies.at(-1).content, /当前会话/)

	// ⑦ 连改哪一条都没说 → 给用法；没有这条 → 明确说没有
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 改'))
	assert.match(calls.replies.at(-1).content, /用法/)
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 改 #9 session-1'))
	assert.match(calls.replies.at(-1).content, /没找到快捷/)
})

test('快捷 改 #编号 不带会话id：当前没绑定会话就明确报错，不静默按 none 改', async () => {
	const { runner, calls, state: s } = makeRunner({
		seed: { shortcuts: { U1: { seq: 2, items: [{ id: 1, sessionId: 'session-1', name: 'memos' }] } } },
	})
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 改 #1'))
	assert.match(calls.replies.at(-1).content, /当前没有绑定会话/)
	assert.deepEqual(
		s.shortcutsOf('U1').map((i) => i.sessionId),
		['session-1'],
		'没绑定时不能改动指向',
	)
})

// 用户 2026-10-18：「新增补位命令，因为目前它是不补位的；补位命令就是手动执行补位，
// 补位命令不出现在列表菜单」。
test('快捷 补位：手动把编号压成 1..N 连号（指向与备注不动，seq 跟着降）', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })
	// 造窟窿：#1 #2 #3 依次加，然后删掉 #2
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 甲'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-2'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 乙'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-3'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 丙'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 删 #2'))
	assert.deepEqual(
		s.shortcutsOf('U1').map((item) => [item.id, item.sessionId, item.name]),
		[
			[1, 'session-1', '甲'],
			[3, 'session-3', '丙'],
		],
		'删了不补位：#3 还在原来的编号上',
	)

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 补位'))
	assert.deepEqual(
		s.shortcutsOf('U1').map((item) => [item.id, item.sessionId, item.name]),
		[
			[1, 'session-1', '甲'],
			[2, 'session-3', '丙'],
		],
		'编号压成连号，指向与备注都不动',
	)
	const reply = calls.replies.at(-1).content
	assert.match(reply, /已补位/)
	assert.match(reply, /`#3` → `#2`/, '要告诉用户哪一条挪了')
	assert.match(reply, /之后新加的从 `#3` 开始/)
	assert.match(reply, /手动发一次/, '说明为什么要手动')

	// 补完位后 `#2` 指的就是原来 #3（session-3），而不是被删掉的那条
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 #2'))
	assert.equal(s.bindingOf('U1'), 'session-3', '补位后 #2 必须指向原来 #3 的那个会话')
	// 新加的从 #3 继续（seq 已降到 2；换个还没存过的会话才叫"新加"）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-2'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 丁'))
	assert.deepEqual(s.shortcutsOf('U1').map((item) => item.id), [1, 2, 3])

	// 已经连号：再补一次是空操作，只回一句
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 补位'))
	assert.match(calls.replies.at(-1).content, /已经是连号/)
	// 英文别名也认（`pack` / `renumber`）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 pack'))
	assert.match(calls.replies.at(-1).content, /已经是连号/)

	// 一条都没有：说清楚没法补，别静默
	const empty = makeRunner({ seed: boundSeed() })
	await empty.runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 补位'))
	assert.match(empty.calls.replies.at(-1).content, /还没有快捷会话/)
})

// 「补位」是 `快捷` 的子命令，**不注册**进指令面板/自定义菜单（用户明确要求）。
test('补位不出现在列表菜单（指令面板与自定义菜单里都没有它）', async () => {
	const menuNames = menuItems().flatMap((item) => [item.name, ...(item.children ?? []).map((child) => child.name)])
	assert.ok(!menuNames.includes('补位'), '自定义菜单里不该出现「补位」')
	assert.deepEqual(
		panelItems().map((item) => item.name).filter((name) => name === '补位'),
		[],
		'指令面板里也不该出现「补位」',
	)
})

test('快捷：英文缩写与中文等价（add/a、delete/d、list/l、rename/r，大小写不敏感）', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 add 前端'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => [i.id, i.sessionId, i.name]), [[1, 'session-1', '前端']])

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 l'))
	assert.ok(calls.shortcutCards.length >= 1, '`l` = 列出')

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 r #1 前端主控'))
	assert.equal(s.shortcutsOf('U1')[0].name, '前端主控', '`r` = 备注/改名')

	// 大写也认（`A`/`D` 不该被当成名字或会话）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 R #1 前端'))
	assert.equal(s.shortcutsOf('U1')[0].name, '前端')

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 delete #1'))
	assert.equal(s.shortcutsOf('U1').length, 0, '`delete` = 删')
})

test('快捷：编号只增不重用（删掉 #1 之后新加的还是 #3）', async () => {
	const { runner, state: s } = makeRunner({ seed: boundSeed() })
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 一'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-2'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 二'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 删 #1'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => i.id), [2], '#2 不能被补位成 #1')

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-3'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 三'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => i.id), [2, 3], '新加的是 #3，不是复用 #1')
})

test('快捷：备注不能含 #、不能纯数字、不能重名；未绑定会话时加不进去', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 #1号'))
	assert.equal(s.shortcutsOf('U1').length, 0, '含 # 的备注必须被拒')
	assert.match(calls.replies.at(-1).content, /备注里不能有/)

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 3'))
	assert.equal(s.shortcutsOf('U1').length, 0, '纯数字备注会被当成编号，必须被拒')
	assert.match(calls.replies.at(-1).content, /备注不能只用数字/)

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 前端'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-2'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 前端'))
	assert.deepEqual(s.shortcutsOf('U1').map((i) => [i.id, i.sessionId]), [[1, 'session-1']], '重名的备注要拒掉')
	assert.match(calls.replies.at(-1).content, /已经用在 \*\*#1\*\*/)

	// 没绑定会话：加不进去（要说清楚先怎么办）
	const free = makeRunner()
	await free.runner.run({ openid: 'U9', replyContext: {} }, parseCommand('快捷 加 前端'))
	assert.equal(free.state.shortcutsOf('U9').length, 0)
	assert.match(free.calls.replies.at(-1).content, /当前没有绑定会话/)
})

test('快捷：直达切换（#编号 / 备注 / 纯数字 / 带空格的备注 / 会话id）', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 前端'))

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-2'))

	// #编号
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 #1'))
	assert.equal(s.bindingOf('U1'), 'session-1')
	assert.match(calls.replies.at(-1).content, /已接入.*#1 前端/s)

	// 备注（不带 #）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 前端'))
	assert.equal(s.bindingOf('U1'), 'session-1')

	// 纯数字当编号
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-2'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 1'))
	assert.equal(s.bindingOf('U1'), 'session-1')

	// **会话id 直接写**（用户要求；与 `切换会话 <会话id>` 同规则）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 session-2'))
	assert.equal(s.bindingOf('U1'), 'session-2')
	assert.equal(calls.delivered.length, 0, '只给目标＝切换，不投递')
})

test('快捷：带消息是**只投递、不切换**（用户明确要求）', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 前端'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 备注 #1 我的 前端'))
	// 现在绑在 session-2：往 #1 丢一条消息，**绑定必须不动**
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-2'))

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 #1 帮我看下这个'))
	assert.equal(s.bindingOf('U1'), 'session-2', '带消息不该切换绑定')
	assert.equal(calls.delivered.length, 1)
	assert.deepEqual(
		{ sessionId: calls.delivered[0].sessionId, text: calls.delivered[0].text, interrupt: calls.delivered[0].interrupt },
		{ sessionId: 'session-1', text: '帮我看下这个', interrupt: true },
	)
	assert.match(calls.replies.at(-1).content, /没有切换/)

	// 带引用的消息也要拼上
	await runner.run({ openid: 'U1', replyContext: {}, quote: '被引用的' }, parseCommand('快捷 我的 前端 接着上面说'))
	assert.equal(calls.delivered.at(-1).text, '[引用的消息] 被引用的\n\n接着上面说')
	assert.equal(s.bindingOf('U1'), 'session-2')

	// 备注带空格：最长前缀匹配（剩下的算消息）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 我的 前端 再来一条'))
	assert.equal(calls.delivered.at(-1).sessionId, 'session-1')
	assert.equal(calls.delivered.at(-1).text, '再来一条')

	// 会话id + 消息：同样只投递不切换
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 session-3 第三条'))
	assert.equal(calls.delivered.at(-1).sessionId, 'session-3')
	assert.equal(s.bindingOf('U1'), 'session-2')
})

test('快捷：删 / 改名 / 认不出的目标回帮助 / 认不出的编号要报错', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 前端'))

	// 改名（空备注 = 清掉）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 备注 #1 前端主控'))
	assert.equal(s.shortcutsOf('U1')[0].name, '前端主控')
	assert.match(calls.replies.at(-1).content, /已改成/)

	// 认不出的编号：明确报错（不能静默回用法）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 #9'))
	assert.match(calls.replies.at(-1).content, /没找到快捷/)

	// 删（认名字也认编号）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 删 前端主控'))
	assert.equal(s.shortcutsOf('U1').length, 0)
	assert.match(calls.replies.at(-1).content, /已删除快捷/)

	// 列表空着时的认不出：给引导
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 随便什么'))
	assert.match(calls.replies.at(-1).content, /还没有快捷会话/)
	assert.match(calls.replies.at(-1).content, /切过去/, '认不出时给的是分节帮助')

	// 列表非空但认不出：回帮助（带现有条目）
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 前端'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 随便什么'))
	assert.match(calls.replies.at(-1).content, /切过去/)
	assert.match(calls.replies.at(-1).content, /现有：/)
})

test('快捷：卡片点进来的动作（fromCard）要把卡片重发一遍标出新的当前', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 前端'))
	assert.equal(calls.shortcutCards.length, 0, '命令路径不该自己重发卡片')

	await runner.run(
		{ openid: 'U1', replyContext: {}, fromCard: true },
		parseCommand('快捷 加'),
	)
	assert.equal(calls.shortcutCards.length, 1, '点卡片上的按钮做的动作要刷新卡片')
	assert.equal(calls.shortcutCards[0].items.length, 1)
	assert.equal(s.bindingOf('U1'), 'session-1')
})

// 用户 2026-10-18：「在第 2 页点某个编号切过去之后，重发的卡片跳回了第 1 页」——
// 切完必须留在**原来那一页**。
test('快捷：从卡片切换后重发的卡片留在原来那一页（不跳回第 1 页）', async () => {
	const { runner, calls } = makeRunner({ seed: boundSeed() })
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-2'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-1'))
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 加 甲')) // #1 → session-1
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('切换会话 session-2'))
	await runner.run(
		{ openid: 'U1', replyContext: {}, fromCard: true, page: 2 },
		parseCommand('快捷 #1'),
	)
	assert.equal(calls.shortcutCards.length, 1, 'fromCard 要重发卡片')
	assert.equal(calls.shortcutCards[0].page, 2, '页码要原样带回去（以前缺省成第 1 页）')
	// 命令路径（不是从卡片点的）本来就不重发，不受影响
	calls.shortcutCards.length = 0
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 #1'))
	assert.equal(calls.shortcutCards.length, 0, '命令路径不该自己重发卡片')
})

test('快捷：目标会话没了/已归档时如实说，并提醒清掉这一条', async () => {
	const { runner, calls } = makeRunner({
		seed: { bindings: { U1: 'session-1' }, shortcuts: { U1: { seq: 2, items: [
			{ id: 1, sessionId: 'session-gone', name: '没了的' },
			{ id: 2, sessionId: 'session-archived', name: '归档的' },
		] } } },
	})
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 #1'))
	assert.match(calls.replies.at(-1).content, /已经不在了/)
	assert.match(calls.replies.at(-1).content, /快捷 删 #1/, '要告诉用户怎么清掉这条')
	assert.equal(calls.delivered.length, 0)

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('快捷 归档的'))
	assert.match(calls.replies.at(-1).content, /已归档/)
})

