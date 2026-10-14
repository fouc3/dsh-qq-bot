import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRounds } from './rounds.js'
import { createState } from './state.js'
import { parseCallback, data as cardData } from './cards.js'

const CONFIG = {
	noticeFallbackMs: 20,
	defaultMarkdown: true,
	needReplyText: '请把结果回复给用户。',
	needReplyAckText: '已触发，正在请求回复…',
}

function setup({ seed = { bindings: { U1: 'session-1' } }, agent = null } = {}) {
	const enqueued = []
	const delivered = []
	const outbox = {
		enqueue(kind, args) {
			enqueued.push({ kind, args })
			return { id: `c${enqueued.length}`, acked: Promise.resolve({ ok: true }) }
		},
	}
	const state = createState({ seed })
	const sessions = {
		label: (id) => `标题(${id})`,
		describe: (id) => `**标题**\`(${id})\``,
	}
	const stubAgent = agent ?? makeStubAgent()
	const rounds = createRounds({
		state,
		sessions,
		outbox,
		config: CONFIG,
		logger: {},
		userMessage: (text) => ({ text }),
		contextMessage: (text) => ({ injected: text }),
		agentFor: async (sessionId) => (sessionId === 'session-1' ? stubAgent : null),
		onDeliver: async (req) => delivered.push(req),
	})
	rounds.attachAgent(stubAgent, 'session-1')
	return { rounds, state, enqueued, delivered, agent: stubAgent }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/** 假 agent：把注册到 agent.ctx 上的监听收起来，供测试直接触发。 */
function makeStubAgent() {
	const handlers = {}
	const agent = {
		id: 'session-1',
		status: 'idle',
		followed: [],
		handlers,
		ctx: {
			on(name, handler) {
				handlers[name] = handler
				return () => {}
			},
		},
		followup(message) {
			agent.followed.push(message)
		},
		cancel() {
			agent.cancelled = (agent.cancelled ?? 0) + 1
		},
	}
	return agent
}

function sessionEvent(agent, event) {
	return agent.handlers['session/event'](null, event)
}

test('一轮正常结束：发「标题(会话id)已结束」+「我需要回复」按钮', async () => {
	const { rounds, enqueued, agent } = setup()
	rounds.beginRound({ sessionId: 'session-1', openid: 'U1', origin: 'qq', context: { msgId: 'UM' } })

	sessionEvent(agent, { type: 'turn/start', data: { turn: 3 } })
	sessionEvent(agent, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
	await tick()

	const notice = enqueued.find((e) => e.kind === 'send_c2c' && String(e.args.content).includes('已结束'))
	assert.ok(notice, '应发结束通知')
	assert.equal(notice.args.content, '标题(session-1)已结束')
	assert.equal(notice.args.openid, 'U1')
	assert.equal(notice.args.replyToMsgId, 'UM')
	const button = notice.args.keyboard.content.rows[0].buttons[0]
	assert.equal(button.render_data.label, '我需要回复')
	assert.deepEqual(parseCallback(button.action.data), { kind: 'needreply', sessionId: 'session-1' })
})

test('AI 调过 qq_reply 也照发结束通知（只是记录状态不同）', async () => {
	const { rounds, enqueued, agent } = setup()
	rounds.beginRound({ sessionId: 'session-1', openid: 'U1', origin: 'qq', context: { msgId: 'UM' } })
	sessionEvent(agent, { type: 'turn/start', data: { turn: 1 } })
	sessionEvent(agent, { type: 'tool/call', data: { turn: 1, name: 'qq_reply' } })
	sessionEvent(agent, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
	await tick()
	assert.ok(enqueued.some((e) => String(e.args.content).includes('已结束')))
})

test('被打断与正常结束要区分：被顶替/显式停止发「被打断」通知并带上打断来源', async () => {
	const noticesOf = (list) =>
		list.filter((e) => e.kind === 'send_c2c' && /已结束|被打断/.test(String(e.args.content))).map((e) => String(e.args.content))

	// 被新消息顶替：旧轮要发「被打断」，并带上打断它的那条消息
	const first = setup()
	first.rounds.beginRound({ sessionId: 'session-1', openid: 'U1', origin: 'qq' })
	first.rounds.beginRound({ sessionId: 'session-1', openid: 'U1', origin: 'qq', interruptSource: '帮我看下这个报错' })
	await tick()
	const interrupted = noticesOf(first.enqueued)
	assert.equal(interrupted.length, 1, '被顶替的轮要有一条被打断通知')
	assert.match(interrupted[0], /被打断/)
	assert.doesNotMatch(interrupted[0], /已结束/)
	assert.match(interrupted[0], /打断来自：帮我看下这个报错/)

	// 拿不到打断来源时：照样报被打断，只是不带引用行
	const noSource = setup()
	noSource.rounds.beginRound({ sessionId: 'session-1', openid: 'U1', origin: 'qq' })
	noSource.rounds.beginRound({ sessionId: 'session-1', openid: 'U1', origin: 'qq' })
	await tick()
	const withoutSource = noticesOf(noSource.enqueued)
	assert.equal(withoutSource.length, 1)
	assert.match(withoutSource[0], /被打断/)
	assert.doesNotMatch(withoutSource[0], /打断来自/)

	// 用户显式停止：也算被打断
	const stopped = setup()
	stopped.rounds.beginRound({ sessionId: 'session-1', openid: 'U1', origin: 'qq' })
	stopped.rounds.markStopped('session-1', '用户发送了「停止」命令')
	await tick()
	const stoppedNotices = noticesOf(stopped.enqueued)
	assert.equal(stoppedNotices.length, 1, '显式停止也要通知，且是「被打断」')
	assert.match(stoppedNotices[0], /被打断/)
	assert.match(stoppedNotices[0], /停止/)

	// 还没认领任何轮次时的 turn/end（被我们打断的那一轮收尾）不该重复发通知
	const unclaimed = setup()
	unclaimed.rounds.beginRound({ sessionId: 'session-1', openid: 'U1', origin: 'qq' })
	unclaimed.agent.handlers['session/event'](null, { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } })
	await tick()
	assert.equal(noticesOf(unclaimed.enqueued).length, 0)
})

test('正常结束发「已结束」；认领到的轮次 abort（非顶替）也算被打断', async () => {
	const done = setup()
	done.rounds.beginRound({ sessionId: 'session-1', openid: 'U1', origin: 'qq' })
	sessionEvent(done.agent, { type: 'turn/start', data: { turn: 1 } })
	sessionEvent(done.agent, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
	await tick()
	const ok = done.enqueued.filter((e) => e.kind === 'send_c2c').map((e) => String(e.args.content)).join('|')
	assert.match(ok, /已结束/)
	assert.doesNotMatch(ok, /被打断/)

	const aborted = setup()
	aborted.rounds.beginRound({ sessionId: 'session-1', openid: 'U1', origin: 'qq' })
	sessionEvent(aborted.agent, { type: 'turn/start', data: { turn: 4 } })
	sessionEvent(aborted.agent, { type: 'turn/end', data: { turn: 4, reason: { kind: 'aborted' } } })
	await tick()
	const bad = aborted.enqueued.filter((e) => e.kind === 'send_c2c').map((e) => String(e.args.content)).join('|')
	assert.match(bad, /被打断/)
})

test('延迟发送：只在"正常结束"时投递；被停止/出错不投递', async () => {
	const { rounds, state, delivered, agent } = setup()
	state.setDelayed('session-1', { content: '打完了叫我', openid: 'U1', at: 'now' })

	rounds.beginRound({ sessionId: 'session-1', openid: 'U1', origin: 'qq' })
	sessionEvent(agent, { type: 'turn/start', data: { turn: 5 } })
	sessionEvent(agent, { type: 'turn/end', data: { turn: 5, reason: { kind: 'aborted' } } })
	await tick()
	assert.equal(delivered.length, 0, '被打断的轮不投递延迟消息')
	assert.ok(state.delayedOf('session-1'), '待发消息应保留')

	rounds.beginRound({ sessionId: 'session-1', openid: 'U1', origin: 'qq' })
	sessionEvent(agent, { type: 'turn/start', data: { turn: 6 } })
	sessionEvent(agent, { type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } })
	await tick()
	assert.equal(delivered.length, 1)
	assert.equal(delivered[0].text, '打完了叫我')
	assert.equal(state.delayedOf('session-1'), null, '投递后应清槽')
})

test('每轮把用户级上下文注入进会话（每个 turn 只注入一次）', async () => {
	const { rounds, agent } = setup()
	const round = rounds.beginRound({ sessionId: 'session-1', openid: 'U1', origin: 'qq' })
	round.pendingContext = '这是 QQ 私信拉起的这一轮'

	const preStep = agent.handlers['agent/pre-step']
	const next = async () => ({ kind: 'enter', messages: [{ text: '原有消息' }] })

	const first = await preStep({ turn: 4, signal: { aborted: false } }, next)
	assert.equal(first.messages.length, 2)
	assert.equal(first.messages[1].injected, '这是 QQ 私信拉起的这一轮')

	const second = await preStep({ turn: 4, signal: { aborted: false } }, next)
	assert.equal(second.messages.length, 1, '同一个 turn 不重复注入')

	const third = await preStep({ turn: 5, signal: { aborted: false } }, next)
	assert.equal(third.messages.length, 2, '新 turn 再注入一次')
})

test('「我需要回复」：绑定不符=4、正在运行=1（失败，别用 2）、成功=0 并注入唤醒消息 + 确认消息', async () => {
	const { rounds, enqueued, agent } = setup()

	const notBound = await rounds.needReply({ openid: 'U2', sessionId: 'session-1', interactionId: 'I1' })
	assert.equal(notBound.code, 4)
	assert.equal(agent.followed.length, 0)

	agent.status = 'running'
	const busy = await rounds.needReply({ openid: 'U1', sessionId: 'session-1', interactionId: 'I2' })
	// 关键：不能是 2 —— 平台的码 2 语义是「操作太频繁」，客户端会直接弹这个词
	assert.equal(busy.code, 1)
	assert.equal(agent.followed.length, 0)

	agent.status = 'idle'
	const ok = await rounds.needReply({ openid: 'U1', sessionId: 'session-1', interactionId: 'I3', messageId: 'MSG' })
	assert.equal(ok.code, 0)
	assert.equal(agent.followed.length, 1)
	assert.equal(agent.followed[0].text, '请把结果回复给用户。')

	const ack = enqueued.find((e) => e.kind === 'send_c2c' && e.args.content === '已触发，正在请求回复…')
	assert.ok(ack, '应回一条「已触发」确认')
	assert.equal(ack.args.replyToEventId, 'I3')
	assert.equal(ack.args.markdown, false)

	// 会话不存在（agentFor 对未知会话返回 null）
	const missing = setup()
	const gone = await missing.rounds.needReply({ openid: 'U1', sessionId: 'session-9', interactionId: 'I4' })
	assert.equal(gone.code, 4)
})

test('通道给的按钮数据能被 parseCallback 正确还原（端到端契约）', () => {
	const parsed = parseCallback(cardData.needReply('session-abc'))
	assert.equal(parsed.kind, 'needreply')
	assert.equal(parsed.sessionId, 'session-abc')
})
