import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createQuestionBridge } from './questions.js'
import { createOutbox } from './outbox.js'
import { createState } from './state.js'

const QUESTIONS = [
	{
		id: 'q1',
		header: '部署方式',
		question: '这次改动怎么上线？',
		options: [
			{ label: '直接上线', description: '影响面小' },
			{ label: '先灰度', description: '需要开关' },
		],
	},
]

function setup(config = {}) {
	const sent = []
	const recalled = []
	const notified = []
	const io = {
		sendCard: async ({ openid, content, keyboard }) => {
			sent.push({ openid, content, keyboard })
			return `CARD-${sent.length}`
		},
		recallCard: async (openid, messageId) => {
			recalled.push({ openid, messageId })
		},
		notify: async ({ openid, content }) => {
			notified.push({ openid, content })
		},
	}
	const bridge = createQuestionBridge({
		state: createState({}),
		outbox: createOutbox({}),
		config: { questionTimeoutMs: 1000, maxQuestionButtons: 20, ...config },
		logger: {},
		io,
	})
	return { bridge, sent, recalled, notified }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('提问：发卡片 → 点选项 → 撤回旧卡重发 → 打字填「其他」→ 提交结算', async () => {
	const { bridge, sent, recalled } = setup()
	const answers = bridge.ask({ callId: 'call-1', questions: QUESTIONS, openid: 'U1', sessionId: 'session-1' })
	await tick()

	assert.equal(sent.length, 1)
	assert.match(sent[0].content, /\*\*A\.\*\* 直接上线/)
	assert.match(sent[0].content, /> 影响面小/)
	const labels = sent[0].keyboard.content.rows.flatMap((row) => row.buttons.map((b) => b.render_data.label))
	assert.deepEqual(labels, ['A', 'B', '其他', '提交'])

	// 点 A：撤回上一张卡片并重发（显示已选）
	const clicked = await bridge.handleCallback({ kind: 'question', callId: 'call-1', questionIndex: 0, action: 'opt-0' }, { openid: 'U1' })
	assert.equal(clicked.code, 0)
	assert.equal(sent.length, 2, '每次选择都重发一张卡片')
	assert.equal(recalled.length, 1, '每次选择都先撤回上一张卡片')
	assert.match(sent[1].content, /✅ 直接上线/)

	// 打字 = 「其他」
	assert.equal(await bridge.handleText('U1', '我想先本地跑一周'), true)
	assert.equal(sent.length, 3)
	assert.match(sent[2].content, /我想先本地跑一周/)

	// 提交
	const submitted = await bridge.handleCallback({ kind: 'question', callId: 'call-1', questionIndex: 0, action: 'submit' }, { openid: 'U1' })
	assert.equal(submitted.code, 0)

	const result = await answers
	assert.deepEqual(result, [{ id: 'q1', selected: ['直接上线'], custom: '我想先本地跑一周' }])
	assert.equal(bridge.pendingCount(), 0)
})

test('提问：不选任何选项直接提交 = 跳过（空选项、无 custom）', async () => {
	const { bridge, sent } = setup()
	const answers = bridge.ask({ callId: 'call-2', questions: QUESTIONS, openid: 'U1', sessionId: 'session-1' })
	await tick()
	await bridge.handleCallback({ kind: 'question', callId: 'call-2', questionIndex: 0, action: 'submit' }, { openid: 'U1' })

	assert.deepEqual(await answers, [{ id: 'q1', selected: [] }])
	assert.equal(sent.length, 1)
})

test('提问：多选可切换，单选覆盖', async () => {
	const { bridge } = setup()
	const questions = [
		{
			id: 'q-multi',
			question: '选几个',
			multiSelect: true,
			options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }],
		},
	]
	const answers = bridge.ask({ callId: 'call-3', questions, openid: 'U1', sessionId: 'session-1' })
	await tick()

	await bridge.handleCallback({ kind: 'question', callId: 'call-3', questionIndex: 0, action: 'opt-0' }, { openid: 'U1' })
	await bridge.handleCallback({ kind: 'question', callId: 'call-3', questionIndex: 0, action: 'opt-2' }, { openid: 'U1' })
	// 再点一次甲 = 取消
	await bridge.handleCallback({ kind: 'question', callId: 'call-3', questionIndex: 0, action: 'opt-0' }, { openid: 'U1' })
	await bridge.handleCallback({ kind: 'question', callId: 'call-3', questionIndex: 0, action: 'submit' }, { openid: 'U1' })

	assert.deepEqual(await answers, [{ id: 'q-multi', selected: ['丙'] }])
})

test('提问：超时交回 dsh GUI（返回 null）并撤回卡片', async () => {
	const { bridge, recalled } = setup({ questionTimeoutMs: 20 })
	const answers = bridge.ask({ callId: 'call-4', questions: QUESTIONS, openid: 'U1', sessionId: 'session-1' })
	await tick()
	assert.equal(await answers, null)
	assert.equal(recalled.length, 1, '超时也要把卡片撤回')
	assert.equal(bridge.pendingCount(), 0)
})

test('提问：按钮超上限时不发卡片，直接交回 GUI —— 但要在 QQ 里明说一句', async () => {
	const { bridge, sent, notified } = setup({ maxQuestionButtons: 2 })
	const answers = bridge.ask({ callId: 'call-5', questions: QUESTIONS, openid: 'U1', sessionId: 'session-1' })
	assert.equal(await answers, null)
	assert.equal(sent.length, 0)
	assert.equal(notified.length, 1, '降级不能无声无息：线上就是这样漏掉的')
	assert.match(notified[0].content, /交回/)
	assert.equal(bridge.pendingCount(), 0)
})

test('提问：一卡放不下就拆多张；点哪张只重发哪张，提交时全部撤回', async () => {
	const { bridge, sent, recalled, notified } = setup()
	const mk = (n) => ({
		id: `q${n}`,
		question: `第${n}题`,
		options: Array.from({ length: 5 }, (_, i) => ({ label: `o${n}-${i}` })),
	})
	const questions = [1, 2, 3, 4, 5, 6].map(mk)
	const answers = bridge.ask({ callId: 'call-multi', questions, openid: 'U1', sessionId: 'session-1' })
	await tick()

	assert.equal(sent.length, 2, '6 道题 × 5 选项要拆成两张卡片')
	assert.equal(recalled.length, 0, '初次发送不能撤回任何卡片（第一张不能被第二张顶掉）')

	// 第 4 题在第二张卡上：只撤回并重发第二张
	const clicked = await bridge.handleCallback(
		{ kind: 'question', callId: 'call-multi', questionIndex: 3, action: 'opt-0' },
		{ openid: 'U1' },
	)
	assert.equal(clicked.code, 0)
	assert.equal(sent.length, 3)
	assert.deepEqual(recalled.map((entry) => entry.messageId), ['CARD-2'], '只撤回被点的那张卡片')
	assert.match(sent[2].content, /✅ o4-0/)

	// 在第一张卡上提交：所有卡片都要撤回
	const submitted = await bridge.handleCallback(
		{ kind: 'question', callId: 'call-multi', questionIndex: 0, action: 'submit' },
		{ openid: 'U1' },
	)
	assert.equal(submitted.code, 0)
	assert.deepEqual(recalled.map((entry) => entry.messageId), ['CARD-2', 'CARD-1', 'CARD-3'])

	const result = await answers
	assert.equal(result.length, 6)
	assert.deepEqual(result[3], { id: 'q4', selected: ['o4-0'] })
	assert.equal(bridge.pendingCount(), 0)
	assert.equal(notified.length, 0)
})

test('提问：点击者与提问对象不一致时拒绝，且不是重复/过期码', async () => {
	const { bridge } = setup()
	const answers = bridge.ask({ callId: 'call-6', questions: QUESTIONS, openid: 'U1', sessionId: 'session-1' })
	await tick()
	const denied = await bridge.handleCallback({ kind: 'question', callId: 'call-6', questionIndex: 0, action: 'opt-0' }, { openid: 'U2' })
	assert.equal(denied.code, 4)
	// 过期卡片
	const stale = await bridge.handleCallback({ kind: 'question', callId: 'nope', questionIndex: 0, action: 'opt-0' }, { openid: 'U1' })
	assert.equal(stale.code, 3)

	// 收尾，避免悬挂
	await bridge.handleCallback({ kind: 'question', callId: 'call-6', questionIndex: 0, action: 'submit' }, { openid: 'U1' })
	await answers
})

test('提问：没有待答提问时普通文本不被消费', async () => {
	const { bridge } = setup()
	assert.equal(await bridge.handleText('U1', '普通消息'), false)
	assert.equal(bridge.hasPending('U1'), false)
})
