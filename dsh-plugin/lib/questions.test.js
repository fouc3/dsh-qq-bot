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
	const io = {
		sendCard: async ({ openid, content, keyboard }) => {
			sent.push({ openid, content, keyboard })
			return `CARD-${sent.length}`
		},
		recallCard: async (openid, messageId) => {
			recalled.push({ openid, messageId })
		},
	}
	const bridge = createQuestionBridge({
		state: createState({}),
		outbox: createOutbox({}),
		config: { questionTimeoutMs: 1000, maxQuestionButtons: 15, ...config },
		logger: {},
		io,
	})
	return { bridge, sent, recalled }
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

test('提问：按钮超上限时不发卡片，直接交回 GUI', async () => {
	const { bridge, sent } = setup({ maxQuestionButtons: 2 })
	const answers = bridge.ask({ callId: 'call-5', questions: QUESTIONS, openid: 'U1', sessionId: 'session-1' })
	assert.equal(await answers, null)
	assert.equal(sent.length, 0)
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
