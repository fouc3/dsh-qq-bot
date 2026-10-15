import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
	extractAssistantReasoning,
	extractAssistantText,
	renderProgress,
	snapshotProgress,
	summarizeToolArgs,
} from './progress.js'

/** 造假 agent：只有插件真正会用到的两个只读接口（seq / eventAt）。 */
function makeAgent({ status = 'running', events = [] } = {}) {
	return {
		status,
		session: {
			seq: events.length,
			eventAt: (seq) => events[seq] ?? null,
		},
	}
}

const ev = (seq, type, time, data = {}) => ({ seq, type, time, data })

test('summarizeToolArgs：认出常见参数，压成一行看得到重点', () => {
	assert.equal(summarizeToolArgs('{"command":"pnpm test 2>&1 | tail -20"}'), 'pnpm test 2>&1 | tail -20')
	assert.equal(summarizeToolArgs('{"file_path":"/home/u/a.js"}'), '/home/u/a.js')
	assert.equal(summarizeToolArgs('{"query":"QQ markdown 表格"}'), 'QQ markdown 表格')
	assert.equal(summarizeToolArgs('not json'), 'not json')
	assert.equal(summarizeToolArgs(''), '')
	assert.equal(summarizeToolArgs(undefined), '')
	// 超长要截断
	assert.ok(summarizeToolArgs(`{"command":"${'x'.repeat(200)}"}`).endsWith('…'))
})

test('extractAssistantText：只取 text 块，跳过 reasoning', () => {
	assert.equal(
		extractAssistantText({ content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: '给用户的结论' }] }),
		'给用户的结论',
	)
	assert.equal(extractAssistantText({ content: [{ type: 'reasoning', text: '只有推理' }] }), '')
	assert.equal(extractAssistantText(null), '')
})

test('extractAssistantReasoning：只取 reasoning 块（thinking 也认），跳过 text/tool-call', () => {
	assert.equal(
		extractAssistantReasoning({
			content: [
				{ type: 'reasoning', text: '先看看这个路径' },
				{ type: 'text', text: '正文' },
				{ type: 'tool-call', text: '' },
			],
		}),
		'先看看这个路径',
	)
	assert.equal(extractAssistantReasoning({ content: [{ type: 'thinking', text: '老字段名也认' }] }), '老字段名也认')
	assert.equal(extractAssistantReasoning({ content: [{ type: 'text', text: '只有正文' }] }), '')
	assert.equal(extractAssistantReasoning(null), '')
})

test('snapshotProgress：思考与正文分开摘，并算出"正文距最新步骤隔了多少步"', () => {
	const t0 = 2_000_000
	const agent = makeAgent({
		events: [
			ev(0, 'turn/start', t0, { turn: 5 }),
			// 第 1 步：说了句正文
			ev(1, 'assistant/message', t0 + 1000, {
				turn: 5,
				step: 1,
				message: { content: [{ type: 'text', text: '先读一下配置' }] },
			}),
			ev(2, 'tool/call', t0 + 2000, { turn: 5, step: 2, name: 'read', arguments: '{"file_path":"a.js"}' }),
			ev(3, 'tool/result', t0 + 3000, { turn: 5, step: 2 }),
			// 第 3 步：只有思考 + 工具调用（还没对外说话）
			ev(4, 'assistant/message', t0 + 4000, {
				turn: 5,
				step: 3,
				message: { content: [{ type: 'reasoning', text: '这个路径可能泄露' }, { type: 'tool-call', text: '' }] },
			}),
			ev(5, 'tool/call', t0 + 5000, { turn: 5, step: 3, name: 'edit', arguments: '{"file_path":"b.md"}' }),
			ev(6, 'step/start', t0 + 6000, { turn: 5, step: 6 }),
			ev(7, 'tool/call', t0 + 7000, { turn: 5, step: 6, name: 'bash', arguments: '{"command":"pnpm test"}' }),
		],
	})
	const snapshot = snapshotProgress(agent, { now: t0 + 8000 })

	assert.equal(snapshot.lastReasoning, '这个路径可能泄露', '思考取 reasoning 块')
	assert.equal(snapshot.lastReasoningStep, 3)
	assert.equal(snapshot.lastText, '先读一下配置', '正文取 text 块（最新那条正文）')
	assert.equal(snapshot.lastTextStep, 1)
	assert.equal(snapshot.latestStep, 6)
	assert.equal(snapshot.textStepsBehind, 5, '正文在第 1 步、最新第 6 步 → 隔 5 步')
	assert.equal(snapshot.reasoningStepsBehind, 3, '思考在第 3 步、最新第 6 步 → 隔 3 步')
})

test('renderProgress：思考与正文分两段，两段都标"距最新步骤隔多少步"', () => {
	const text = renderProgress({
		label: '会话(session-1)',
		sessionId: 'session-1',
		snapshot: {
			status: 'running',
			midTurn: true,
			turn: 5,
			startedAt: Date.now() - 3000,
			elapsedMs: 3000,
			actions: [{ name: 'bash', args: 'pnpm test', at: Date.now() - 1000 }],
			lastReasoning: '这个路径可能泄露',
			lastReasoningStep: 3,
			lastText: '先读一下配置',
			lastTextStep: 1,
			latestStep: 6,
			textStepsBehind: 5,
			reasoningStepsBehind: 3,
			lastEventAgoMs: 1000,
			scanned: 8,
		},
	})
	assert.match(text, /\*\*最近一段思考（第 3 步，距最新第 6 步隔 3 步）\*\*/, '思考也要标出落后多少步（和正文同一套措辞）')
	assert.match(text, /> 这个路径可能泄露/)
	assert.match(text, /\*\*最近一段正文（第 1 步，距最新第 6 步隔 5 步）\*\*/, '正文同样标')
	assert.match(text, /> 先读一下配置/)
	assert.ok(text.indexOf('最近一段思考') < text.indexOf('最近一段正文'))
	assert.doesNotMatch(text, /\|/, '不要出现表格竖线')

	// 两段同在最新一步：都写「就是最新一步」，不会再出现"一个不带距离、一个带距离"的观感
	const same = renderProgress({
		label: 'x',
		sessionId: 's',
		snapshot: {
			status: 'running',
			midTurn: true,
			turn: 2,
			elapsedMs: 100,
			actions: [],
			lastReasoning: '想清楚了',
			lastReasoningStep: 20,
			lastText: '核心已通过',
			lastTextStep: 20,
			latestStep: 20,
			textStepsBehind: 0,
			reasoningStepsBehind: 0,
			scanned: 5,
		},
	})
	assert.match(same, /\*\*最近一段思考（第 20 步，就是最新一步）\*\*/)
	assert.match(same, /\*\*最近一段正文（第 20 步，就是最新一步）\*\*/)

	// 正文就是最新一步：另一种措辞
	const fresh = renderProgress({
		label: 'x',
		sessionId: 's',
		snapshot: {
			status: 'running',
			midTurn: true,
			turn: 1,
			elapsedMs: 100,
			actions: [],
			lastText: '刚写完',
			lastTextStep: 4,
			latestStep: 4,
			textStepsBehind: 0,
			scanned: 3,
		},
	})
	assert.match(fresh, /\*\*最近一段正文（第 4 步，就是最新一步）\*\*/)
})

test('snapshotProgress：抓不到步号时只降级标注，绝不崩、也不印 NaN', () => {
	const agent = makeAgent({
		events: [
			ev(0, 'turn/start', 1000, { turn: 1 }),
			ev(1, 'assistant/message', 1500, { turn: 1, message: { content: [{ type: 'text', text: '没有步号' }] } }),
		],
	})
	const snapshot = snapshotProgress(agent, { now: 3000 })
	assert.equal(snapshot.lastText, '没有步号')
	assert.equal(snapshot.latestStep, null)
	assert.equal(snapshot.lastTextStep, null)
	assert.equal(snapshot.textStepsBehind, null)
	const text = renderProgress({ label: 'x', sessionId: 's', snapshot })
	assert.match(text, /\*\*最近一段正文\*\*/, '没步号就不标，标题仍然给')
	assert.doesNotMatch(text, /NaN/)
})

test('snapshotProgress：抓到当前轮次、耗时、最近动作与最近输出', () => {
	const t0 = 1_000_000
	const agent = makeAgent({
		events: [
			ev(0, 'turn/start', t0, { turn: 3 }),
			ev(1, 'tool/call', t0 + 1000, { turn: 3, name: 'bash', arguments: '{"command":"pnpm test"}' }),
			ev(2, 'tool/result', t0 + 2000, { turn: 3 }),
			ev(3, 'assistant/message', t0 + 3000, { turn: 3, message: { content: [{ type: 'text', text: '正在跑测试' }] } }),
			ev(4, 'tool/call', t0 + 4000, { turn: 3, name: 'read', arguments: '{"file_path":"a.js"}' }),
		],
	})
	const snapshot = snapshotProgress(agent, { now: t0 + 10_000 })

	assert.equal(snapshot.midTurn, true, '最后一条是 turn/start 而没有 turn/end → 仍在跑')
	assert.equal(snapshot.turn, 3)
	assert.equal(snapshot.elapsedMs, 10_000)
	assert.equal(snapshot.lastText, '正在跑测试')
	assert.deepEqual(
		snapshot.actions.map((a) => a.name),
		['read', 'bash'],
		'动作从新到旧，最多 3 条',
	)
	assert.equal(snapshot.actions[0].args, 'a.js')
	assert.equal(snapshot.scanned, 5)
})

test('snapshotProgress：轮次已收尾 → midTurn=false，仍给出最近一轮的信息', () => {
	const agent = makeAgent({
		status: 'idle',
		events: [
			ev(0, 'turn/start', 1000, { turn: 2 }),
			ev(1, 'tool/call', 1500, { turn: 2, name: 'bash', arguments: '{"command":"ls"}' }),
			ev(2, 'turn/end', 2000, { turn: 2 }),
		],
	})
	const snapshot = snapshotProgress(agent, { now: 9000 })
	assert.equal(snapshot.midTurn, false)
	assert.equal(snapshot.turn, 2)
	assert.equal(snapshot.actions.length, 1, '收尾了也要能看到最近做了什么')
	assert.equal(snapshot.actions[0].name, 'bash')
})

test('snapshotProgress：没有会话/没有事件都不炸，只如实给出空快照', () => {
	assert.equal(snapshotProgress(null).midTurn, false)
	assert.equal(snapshotProgress({ status: 'idle' }).scanned, 0)
	const empty = snapshotProgress(makeAgent({ events: [] }))
	assert.equal(empty.scanned, 0)
	assert.deepEqual(empty.actions, [])
})

test('renderProgress：输出是 QQ 能渲染的 markdown（无表格），并写明没打断', () => {
	const running = renderProgress({
		label: '标题(session-1)',
		sessionId: 'session-1',
		snapshot: {
			status: 'running',
			midTurn: true,
			turn: 3,
			startedAt: Date.now() - 5000,
			elapsedMs: 5000,
			actions: [{ name: 'bash', args: 'pnpm test', at: Date.now() - 2000 }],
			lastText: '正在跑测试',
			lastEventAgoMs: 2000,
			scanned: 5,
		},
	})
	assert.match(running, /进度快照/)
	assert.match(running, /标题\(session-1\)/)
	assert.match(running, /运行中/)
	assert.match(running, /第 3 轮/)
	assert.match(running, /没有打断它/, '必须说明只读、没打断')
	assert.match(running, /bash：pnpm test/)
	assert.match(running, /正在跑测试/)
	assert.doesNotMatch(running, /\|/, '不要出现表格竖线')

	const idle = renderProgress({
		label: 'x(session-2)',
		sessionId: 'session-2',
		snapshot: { status: 'idle', midTurn: false, turn: null, startedAt: null, elapsedMs: null, actions: [], lastText: '', lastEventAgoMs: null, scanned: 0 },
	})
	assert.match(idle, /空闲/)
	assert.match(idle, /没有可读的事件/)
})

// 补票：线上真踩过——默认参数 `now = Date.now` 是个**函数**，被当成时间戳用，
// `Date.now - startedAt` 直接算出 NaN，进度里显示「已跑 NaN 分 NaN 秒」。
// 之前单测全都显式传数字，正好漏掉默认分支。
test('snapshotProgress：不传 now 时用真实时钟，绝不能算出 NaN', () => {
	const startedAt = Date.now() - 12_000
	const agent = makeAgent({ events: [ev(0, 'turn/start', startedAt, { turn: 7 })] })

	const snapshot = snapshotProgress(agent)
	assert.ok(Number.isFinite(snapshot.elapsedMs), `耗时必须是有限数字，实际 ${snapshot.elapsedMs}`)
	assert.ok(snapshot.elapsedMs >= 12_000, `至少应有 12 秒，实际 ${snapshot.elapsedMs}`)
	assert.ok(Number.isFinite(snapshot.lastEventAgoMs))

	const text = renderProgress({ label: '会话', snapshot, sessionId: 's-1' })
	assert.doesNotMatch(text, /NaN/, `进度里不能出现 NaN：\n${text}`)
	assert.match(text, /已跑 \d+ 秒/)

	// 默认值和显式传函数是同一种用法，两条路都要能用
	const viaFn = snapshotProgress(agent, { now: () => Date.now() })
	assert.ok(Number.isFinite(viaFn.elapsedMs))

	// 时钟给不出有效时间时，宁可空着也不能印 NaN
	const broken = snapshotProgress(agent, { now: () => Number.NaN })
	assert.equal(broken.elapsedMs, null)
	assert.equal(broken.lastEventAgoMs, null)
	assert.doesNotMatch(renderProgress({ label: '会话', snapshot: broken, sessionId: 's-1' }), /NaN/)
})
