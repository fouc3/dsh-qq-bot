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

function makeRunner({ seed = {} } = {}) {
	const calls = { replies: [], delivered: [], stopped: [], archived: [], cards: [] }
	const state = createState({ seed })
	const runner = createCommandRunner({
		sessions: makeSessions(),
		state,
		logger: {},
		reply: async ({ openid, content }) => calls.replies.push({ openid, content }),
		showSessionCard: async ({ openid, dir }) => calls.cards.push({ openid, dir }),
		deliver: async (req) => calls.delivered.push(req),
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
	assert.equal(requiresArgs('发送'), true)
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
	assert.equal(items.length, 5)
	assert.deepEqual(items.map((i) => i.name), ['切换会话', '发送', '停止', '归档', '延迟发送'])
	assert.equal(menuItems()[0].sendMessage, '切换会话')
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

test('发送：无参/缺内容回用法；带目标与内容则投递（不打断）', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('发送'))
	assert.match(calls.replies.at(-1).content, /用法/)
	assert.equal(calls.delivered.length, 0)

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('发送 session-2'))
	assert.match(calls.replies.at(-1).content, /用法/)
	assert.equal(calls.delivered.length, 0)

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('发送 session-2 帮我看下这个'))
	assert.equal(calls.delivered.length, 1)
	assert.equal(calls.delivered[0].sessionId, 'session-2')
	assert.equal(calls.delivered[0].text, '帮我看下这个')
	assert.equal(calls.delivered[0].interrupt, false, '发送不打断')
	assert.match(calls.replies.at(-1).content, /已投递/)
	// 绑定没被改
	assert.equal(s.bindingOf('U1'), 'session-1')
})

test('延迟发送：带目标与内容登记；无参/缺内容回用法', async () => {
	const { runner, calls, state: s } = makeRunner({ seed: boundSeed() })

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('延迟发送'))
	assert.match(calls.replies.at(-1).content, /用法/)

	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('延迟发送 session-2 打完了叫我'))
	assert.equal(s.delayedOf('session-2').content, '打完了叫我')
	assert.equal(s.delayedOf('session-2').openid, 'U1')
	assert.match(calls.replies.at(-1).content, /已登记/)
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

test('未知会话 id 会给出明确错误与用法', async () => {
	const { runner, calls } = makeRunner()
	await runner.run({ openid: 'U1', replyContext: {} }, parseCommand('发送 session-nope 内容'))
	assert.match(calls.replies.at(-1).content, /没找到会话/)
	assert.match(calls.replies.at(-1).content, /用法/)
	assert.equal(calls.delivered.length, 0)
})
