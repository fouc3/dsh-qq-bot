import { test } from 'node:test'
import assert from 'node:assert/strict'

import { backoffMs, createOutbox, isTransientFailure } from './outbox.js'

test('poll 立刻返回已入队命令，ack 成功后通知等待者', async () => {
	const outbox = createOutbox({})
	const { id, acked } = outbox.enqueue('send_c2c', { content: 'hi' }, { expectAck: true })

	const commands = await outbox.poll({ waitSeconds: 0 })
	assert.equal(commands.length, 1)
	assert.equal(commands[0].id, id)
	assert.equal(commands[0].kind, 'send_c2c')
	assert.equal(commands[0].args.content, 'hi')

	outbox.ack({ id, ok: true, messageId: 'M1' })
	assert.deepEqual(await acked, { ok: true, messageId: 'M1' })
	assert.equal(outbox.depth(), 0)
})

test('poll 无命令时按 waitSeconds 立刻返回空（waitSeconds=0 不挂住）', async () => {
	const outbox = createOutbox({})
	const started = Date.now()
	assert.deepEqual(await outbox.poll({ waitSeconds: 0 }), [])
	assert.ok(Date.now() - started < 500)
})

test('长轮询会被新命令唤醒', async () => {
	const outbox = createOutbox({})
	const waiting = outbox.poll({ waitSeconds: 5 })
	setTimeout(() => outbox.enqueue('recall_c2c', { openid: 'U', messageId: 'M' }), 10)

	const commands = await waiting
	assert.equal(commands.length, 1)
	assert.equal(commands[0].kind, 'recall_c2c')
})

test('ack ok:false（限速类）：退避后重投、等待者跟着迁移', async () => {
	let clock = 1_000_000
	const outbox = createOutbox({ now: () => clock })
	const { id, acked } = outbox.enqueue('send_c2c', { content: 'hi' }, { expectAck: true })
	await outbox.poll({ waitSeconds: 0 })

	outbox.ack({ id, ok: false, errorCode: 40034100, error: '主动消息发送超过频控限制' })
	// 退避期内不下发（否则就是无限重试风暴）
	assert.deepEqual(await outbox.poll({ waitSeconds: 0 }), [], '退避未到点不该重投')

	clock += 2000
	const retried = await outbox.poll({ waitSeconds: 0 })
	assert.equal(retried.length, 1, '退避到点后重投')
	assert.notEqual(retried[0].id, id, '重投换新 id')

	// 等待者迁移到了新命令上：新命令 ack 成功后原 promise 才会结算
	outbox.ack({ id: retried[0].id, ok: true, messageId: 'M2' })
	assert.deepEqual(await acked, { ok: true, messageId: 'M2' })
})

test('ack ok:false（参数硬错）：不重投、如实回报失败（这正是线上风暴的根因）', async () => {
	const outbox = createOutbox({})
	const { id, acked } = outbox.enqueue('send_c2c', { content: 'x' }, { expectAck: true })
	const first = await outbox.poll({ waitSeconds: 0 })
	outbox.ack({ id: first[0].id, ok: false, errorCode: 40034029, error: '内联键盘行/列超限' })

	const result = await acked
	assert.equal(result.ok, false)
	assert.match(result.error, /键盘/)
	assert.deepEqual(await outbox.poll({ waitSeconds: 0 }), [], '硬错不该留在队列里反复重投')
	assert.equal(outbox.depth(), 0)
})

test('重试次数用尽后丢弃（不再无限重投）', async () => {
	let clock = 1_000_000
	const outbox = createOutbox({ now: () => clock })
	const { acked } = outbox.enqueue('send_c2c', { content: 'x' }, { expectAck: true })

	let id = (await outbox.poll({ waitSeconds: 0 }))[0].id
	for (let attempt = 1; attempt <= 5; attempt += 1) {
		outbox.ack({ id, ok: false, errorCode: 50002, error: '频率限制' })
		clock += 120_000 // 越过任何退避
		const next = await outbox.poll({ waitSeconds: 0 })
		if (next.length === 0) break
		id = next[0].id
	}
	const result = await acked
	assert.equal(result.ok, false, '次数用尽后必须结算成失败，而不是永远挂着重投')
	assert.equal(outbox.depth(), 0)
})

test('退避是增长的（2s → 4s → 8s，封顶 60s）', () => {
	assert.equal(backoffMs(1), 2_000)
	assert.equal(backoffMs(2), 4_000)
	assert.equal(backoffMs(3), 8_000)
	assert.equal(backoffMs(20), 60_000)
	assert.equal(isTransientFailure({ errorCode: 40034100 }), true)
	assert.equal(isTransientFailure({ errorCode: 50002 }), true)
	assert.equal(isTransientFailure({ errorCode: 503 }), true)
	assert.equal(isTransientFailure({ errorCode: 40034029 }), false, '键盘超限重试无意义')
	assert.equal(isTransientFailure({ errorCode: 40034025 }), false, 'event_id 无效重试无意义')
	assert.equal(isTransientFailure({ error: 'dial timeout' }), true, '超时按可重试处理')
})

test('撤回失败不重投（尽力而为）', async () => {
	const outbox = createOutbox({})
	outbox.enqueue('recall_c2c', { openid: 'U', messageId: 'M' })
	const commands = await outbox.poll({ waitSeconds: 0 })
	outbox.ack({ id: commands[0].id, ok: false, errorCode: 40064004, error: '超过撤回时限' })

	assert.equal(outbox.depth(), 0)
	assert.deepEqual(await outbox.poll({ waitSeconds: 0 }), [])
})

test('超时未 ack 的命令会重新排到待下发，且沿用原 id', async () => {
	let clock = 0
	const outbox = createOutbox({ inflightTimeoutMs: 100, now: () => clock })
	outbox.enqueue('send_c2c', { content: 'x' })

	const first = await outbox.poll({ waitSeconds: 0 })
	assert.equal(first.length, 1)

	clock = 10_000
	const second = await outbox.poll({ waitSeconds: 0 })
	assert.equal(second.length, 1)
	assert.equal(second[0].id, first[0].id, '沿用原 id：Go 侧按 id 去重，重投才不会重复发送')
})

test('dispose 让在途等待者立刻拿到未确认，不挂在 await 上', async () => {
	const outbox = createOutbox({})
	const { acked } = outbox.enqueue('send_c2c', { content: 'x' }, { expectAck: true })
	await outbox.poll({ waitSeconds: 0 })
	outbox.dispose()
	const result = await acked
	assert.equal(result.ok, false)
	assert.match(result.error, /通道关闭/)
})

test('未知命令的 ack 被忽略（可能已超时重投）', () => {
	const outbox = createOutbox({})
	assert.doesNotThrow(() => outbox.ack({ id: 'nope', ok: true }))
	assert.doesNotThrow(() => outbox.ack({ ok: true }))
	assert.doesNotThrow(() => outbox.ack(undefined))
})
