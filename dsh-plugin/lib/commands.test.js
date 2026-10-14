import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCommandRunner, menuItems, panelItems, parseCommand, requiresArgs, usageText } from './commands.js'
import { createState } from './state.js'

function makeSessions() {
	const map = new Map([
		['session-1', { sessionId: 'session-1', cwd: '/home/u/proj-a', updatedAt: 2, running: false }],
		['session-2', { sessionId: 'session-2', cwd: '/home/u/proj-b', updatedAt: 1, running: true }],
		['session-archived', { sessionId: 'session-archived', cwd: '/home/u/old', updatedAt: 1, running: false }],
	])
	return {
		get: (id) => map.get(id),
		describe: (id) => `**${id}**\`(${id})\``,
		label: (id) => `标题:${id}(${id})`,
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
	const calls = { replies: [], delivered: [], stopped: [], archived: [], cards: [], inputs: [], modelCards: [], models: [] }
	const state = createState({ seed })
	const runner = createCommandRunner({
		sessions: makeSessions(),
		state,
		logger: {},
		reply: async ({ openid, content }) => calls.replies.push({ openid, content }),
		showSessionCard: async ({ openid, dir }) => calls.cards.push({ openid, dir }),
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
	assert.equal(items.length, 9)
	assert.deepEqual(items.map((i) => i.name), ['切换会话', '新建会话', '进度', '发送', '停止', '归档', '延迟发送', '权限', '模型'])
	assert.equal(items.at(-1).desc, '看/切模型（提供商/模型）')

	// 自定义菜单：顶层只有 7 项（6 个平铺 + 1 个「管理」二级菜单），
	// 这是为了给 dsh 命令的二级菜单留顶层位（平台顶层最多 10 项）。
	const menu = menuItems()
	assert.equal(menu.length, 7)
	assert.deepEqual(
		menu.filter((it) => it.type !== 'menu').map((it) => it.sendMessage),
		['切换会话', '新建会话', '发送', '延迟发送', '模型', '进度'],
	)
	const manage = menu.find((it) => it.type === 'menu')
	assert.equal(manage.name, '管理')
	assert.deepEqual(
		manage.children.map((it) => it.sendMessage),
		['停止', '归档', '权限'],
	)
	// 每条命令都还在菜单里（平铺或二级菜单），不能因为收编而消失
	const shown = new Set([
		...menu.filter((it) => it.type !== 'menu').map((it) => it.name),
		...manage.children.map((it) => it.name),
	])
	assert.deepEqual([...shown].sort(), items.map((i) => i.name).sort())
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
