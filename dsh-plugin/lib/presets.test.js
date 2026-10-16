import { test } from 'node:test'
import assert from 'node:assert/strict'

import { NO_SERVICE, createPresets } from './presets.js'

const ROWS = [
	{ id: 'survival', name: '生存模式', description: '离线自给自足', isDefault: true },
	{ id: 'adventure', name: '冒险模式', description: '探索优先', isDefault: false },
	{ id: 'spectator', name: '旁观模式', description: '只读审查', isDefault: false },
]

/** 造一根假的 `ctx`：只提供 agentPresets 服务、sessionController.projections 与 agents.get。 */
function fakeCtx({ withService = true, useListOnly = false, rows = ROWS, projections = {}, live = {}, selectThrows = null } = {}) {
	const calls = { select: [], projections: [], resumed: [] }
	const service = withService
		? {
				...(useListOnly
					? { async list() { return rows } }
					: { async remoteExportList() { return { presets: rows } } }),
				async select(agent, agentPreset) {
					calls.select.push({ sessionId: agent?.id, agentPreset })
					if (selectThrows) throw selectThrows
					return agentPreset
				},
			}
		: null
	const ctx = {
		get: (name) => {
			if (name === 'agentPresets') return service ?? undefined
			if (name === 'sessionController') {
				return {
					async projections({ sessionId }) {
						calls.projections.push(sessionId)
						return { values: projections }
					},
				}
			}
			return undefined
		},
		agents: { get: (id) => live[id] ?? null },
	}
	const agentFor = async (sessionId) => {
		calls.resumed.push(sessionId)
		return live[sessionId] ?? { id: sessionId, session: { id: sessionId } }
	}
	return { ctx, calls, agentFor }
}

test('角色预设：清单优先 remoteExportList（带 isDefault），退回 list；没服务就是空', async () => {
	const a = fakeCtx()
	const presetsA = createPresets({ ctx: a.ctx, logger: {} })
	assert.equal(presetsA.available(), true)
	const rowsA = await presetsA.catalog()
	assert.deepEqual(rowsA.map((row) => row.value), ['survival', 'adventure', 'spectator'], '顺序照 dsh 给的')
	assert.deepEqual(rowsA[0], {
		value: 'survival',
		name: '生存模式',
		description: '离线自给自足',
		isDefault: true,
		broken: '',
	})

	// 只有 list() 时也要能用（行里带 isDefault 就照带；不带就是 false）
	const b = fakeCtx({ useListOnly: true })
	const rowsB = await createPresets({ ctx: b.ctx, logger: {} }).catalog()
	assert.equal(rowsB.length, 3)
	assert.equal(rowsB[0].name, '生存模式')
	assert.equal(rowsB[0].isDefault, true, 'list() 行里带的 isDefault 也照带')
	const noFlag = fakeCtx({ useListOnly: true, rows: [{ id: 'survival', name: '生存模式' }] })
	assert.equal((await createPresets({ ctx: noFlag.ctx, logger: {} }).catalog())[0].isDefault, false)

	// 没有服务 / 行里没有 id → 空数组（卡片会写"没有服务"）
	const c = fakeCtx({ withService: false })
	assert.equal(createPresets({ ctx: c.ctx, logger: {} }).available(), false)
	assert.deepEqual(await createPresets({ ctx: c.ctx, logger: {} }).catalog(), [])
	const d = fakeCtx({ rows: [{ name: '没有id' }, { id: 'ok' }] })
	assert.deepEqual((await createPresets({ ctx: d.ctx, logger: {} }).catalog()).map((r) => r.value), ['ok'])
})

test('角色预设：当前值读会话投影 agentPreset；turnBoundary 判断"是不是已经开跑过"', async () => {
	const fresh = fakeCtx({ projections: { agentPreset: 'adventure' } })
	const presets = createPresets({ ctx: fresh.ctx, logger: {} })
	assert.equal(await presets.currentForId('session-1'), 'adventure')
	assert.deepEqual(await presets.lockedForId('session-1'), { locked: false, lastTurn: 0, open: false })

	// 已经跑过若干轮 → 锁
	const ran = fakeCtx({ projections: { agentPreset: 'survival', turnBoundary: { lastTurn: 3, openTurnStartSeq: null } } })
	assert.deepEqual(await createPresets({ ctx: ran.ctx, logger: {} }).lockedForId('session-1'), {
		locked: true,
		lastTurn: 3,
		open: false,
	})

	// 有没收的轮（openTurnStartSeq 不为 null）→ 也锁
	const open = fakeCtx({ projections: { turnBoundary: { lastTurn: 0, openTurnStartSeq: 12 } } })
	assert.equal((await createPresets({ ctx: open.ctx, logger: {} }).lockedForId('session-1')).locked, true)

	// 边界在、但没跑过（lastTurn 0 且没有未收轮）→ 不锁
	const idle = fakeCtx({ projections: { turnBoundary: { lastTurn: 0, openTurnStartSeq: null } } })
	assert.equal((await createPresets({ ctx: idle.ctx, logger: {} }).lockedForId('session-1')).locked, false)
})

test('角色预设：切之前先预检 —— 已开跑的会话直接回绝，**不去白唤醒**', async () => {
	const ran = fakeCtx({
		projections: { agentPreset: 'survival', turnBoundary: { lastTurn: 5, openTurnStartSeq: null } },
	})
	const presets = createPresets({ ctx: ran.ctx, logger: {}, agentFor: ran.agentFor })
	const result = await presets.set({ sessionId: 'session-1', value: 'adventure' })
	assert.equal(result.ok, false)
	assert.equal(result.locked, true)
	assert.match(result.error, /已经开跑过轮次/)
	assert.match(result.error, /already started/, '把 dsh 的原话带上，方便对照 Web 端')
	assert.deepEqual(ran.calls.select, [], '被锁就不该去调 select')
	assert.deepEqual(ran.calls.resumed, [], '更不该为了它把冷会话唤醒')
})

test('角色预设：活 agent 直接切；冷会话先按标准路径拉起来再切；失败如实回报', async () => {
	const agent = { id: 'session-1', session: { id: 'session-1' } }
	const live = fakeCtx({ live: { 'session-1': agent } })
	const presetsLive = createPresets({ ctx: live.ctx, logger: {}, agentFor: live.agentFor })
	const ok = await presetsLive.set({ sessionId: 'session-1', value: 'adventure' })
	assert.equal(ok.ok, true)
	assert.equal(ok.value, 'adventure')
	assert.equal(ok.name, '冒险模式')
	assert.deepEqual(live.calls.select, [{ sessionId: 'session-1', agentPreset: 'adventure' }])
	assert.deepEqual(live.calls.resumed, [], '有活 agent 就不用恢复')

	// 冷会话（没有活 agent）：靠注入的 agentFor 拉起来
	const cold = fakeCtx({})
	const presetsCold = createPresets({ ctx: cold.ctx, logger: {}, agentFor: cold.agentFor })
	assert.equal((await presetsCold.set({ sessionId: 'session-9', value: 'spectator' })).ok, true)
	assert.deepEqual(cold.calls.resumed, ['session-9'], '冷会话要先拉起来（select 的入参是 agent 对象）')
	assert.deepEqual(cold.calls.select, [{ sessionId: 'session-9', agentPreset: 'spectator' }])

	// 未知预设：别把 dsh 的 not-found 抛给用户
	const unknown = fakeCtx()
	const presetsUnknown = createPresets({ ctx: unknown.ctx, logger: {}, agentFor: unknown.agentFor })
	const bad = await presetsUnknown.set({ sessionId: 'session-1', value: 'nope' })
	assert.equal(bad.ok, false)
	assert.match(bad.error, /没有 `nope` 这个角色预设/)
	assert.match(bad.error, /生存模式/, '要列出可选项')
	assert.deepEqual(unknown.calls.select, [])

	// dsh 自己抛 locked：也翻成同一句人话
	const lockedErr = new Error('This session has already started')
	lockedErr.code = 'agent-preset/locked'
	const throwing = fakeCtx({ selectThrows: lockedErr })
	const presetsThrowing = createPresets({ ctx: throwing.ctx, logger: {}, agentFor: throwing.agentFor })
	const refused = await presetsThrowing.set({ sessionId: 'session-1', value: 'adventure' })
	assert.equal(refused.locked, true)
	assert.match(refused.error, /已经开跑过轮次/)

	// 没有服务
	const none = fakeCtx({ withService: false })
	const presetsNone = createPresets({ ctx: none.ctx, logger: {}, agentFor: none.agentFor })
	assert.deepEqual(await presetsNone.set({ sessionId: 'session-1', value: 'adventure' }), {
		ok: false,
		error: NO_SERVICE,
	})
})

test('角色预设：解析 id / 显示名 / 序号；认不出时列出可选', async () => {
	const { ctx } = fakeCtx()
	const presets = createPresets({ ctx, logger: {} })
	assert.deepEqual(await presets.resolveToken(['adventure']), { ok: true, value: 'adventure', name: '冒险模式' })
	assert.deepEqual(await presets.resolveToken(['生存模式']), { ok: true, value: 'survival', name: '生存模式' })
	assert.deepEqual(await presets.resolveToken(['2']), { ok: true, value: 'adventure', name: '冒险模式' })
	assert.equal((await presets.resolveToken(['nope'])).ok, false)
	assert.match((await presets.resolveToken(['nope'])).error, /认不出角色预设/)
	assert.equal((await presets.resolveToken([])).ok, false)

	// describe：带上「默认」与说明
	assert.match(await presets.describe('survival'), /生存模式/)
	assert.match(await presets.describe('survival'), /默认/)
	assert.match(await presets.describe('survival'), /离线自给自足/)
})
