import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createOutbox } from './outbox.js'

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

test('ack ok:false：可重投的命令换新 id 重新排队，等待者跟着迁移', async () => {
	const outbox = createOutbox({})
	const { id, acked } = outbox.enqueue('send_c2c', { content: 'hi' }, { expectAck: true })
	await outbox.poll({ waitSeconds: 0 })

	outbox.ack({ id, ok: false, errorCode: 40034128, error: '被动回复超限' })
	const retried = await outbox.poll({ waitSeconds: 0 })
	assert.equal(retried.length, 1)
	assert.notEqual(retried[0].id, id, '重投应换新 id（原 id 已被 Go 侧标记完成？不：失败不消费，但换新 id 更清晰）')
	assert.equal(retried[0].kind, 'send_c2c')

	// 等待者迁移到了新命令上：新命令 ack 成功后原 promise 才会结算
	outbox.ack({ id: retried[0].id, ok: true, messageId: 'M2' })
	assert.deepEqual(await acked, { ok: true, messageId: 'M2' })
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
