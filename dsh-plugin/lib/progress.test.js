import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
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
