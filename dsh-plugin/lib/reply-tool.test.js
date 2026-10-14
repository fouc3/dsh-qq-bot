import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildReplyTool, REPLY_TOOL_NAME } from './reply-tool.js'

const CONFIG = {
	replyHeader: true,
	replyHeaderTemplate: '【{title}({id})】',
	defaultMarkdown: true,
	replyAckTimeoutMs: 50,
}

function setup({ acked = { ok: true, messageId: 'M1' }, ackResolve } = {}) {
	const enqueued = []
	let seq = 0
	const outbox = {
		enqueue(kind, args, options) {
			enqueued.push({ kind, args, options })
			return {
				id: `c${enqueued.length}`,
				acked: ackResolve ? ackResolve() : Promise.resolve(acked),
			}
		},
	}
	const target = {
		sessionId: 'session-1',
		openid: () => 'U1',
		label: () => ({ title: '标题', id: 'session-1' }),
		context: () => ({ msgId: 'USER-MSG', eventId: '' }),
		nextSeq: () => {
			seq += 1
			return seq
		},
	}
	return { tool: buildReplyTool({ outbox, config: CONFIG, logger: {}, target }), enqueued }
}

test('工具名与描述覆盖"完成时详细回复 / 过程中汇报 / md 开关 / 仅被 QQ 拉起时使用"', () => {
	const { tool } = setup()
	assert.equal(tool.name, REPLY_TOOL_NAME)
	assert.match(tool.description, /完成时请尽可能详细/)
	assert.match(tool.description, /过程中也可以随时调用/)
	assert.match(tool.description, /markdown/)
	assert.match(tool.description, /只在你被 QQ 消息拉起时使用/)
	// bundle 自包含：参数是注册表要的原始 JSON Schema（不是 dsh 的 DSL）
	assert.equal(tool.parameters.type, 'object')
	assert.ok(tool.parameters.properties.content)
	assert.ok(tool.parameters.properties.markdown)
	assert.ok(tool.parameters.properties.attachments)
	assert.equal(tool.parameters.properties.attachments.items.properties.kind.type, 'string')
	assert.deepEqual(tool.parameters.properties.attachments.items.required, ['kind'])
	assert.equal(tool.parameters.additionalProperties, false)
	assert.equal(tool.output.schema.type, 'object')
	assert.deepEqual(tool.output.schema.required, ['ok'])
	assert.equal(typeof tool.output.render, 'function')
	assert.equal(typeof tool.execute, 'function')
})

test('正文回复：自动带上来源标注，并作为被动回复发出', async () => {
	const { tool, enqueued } = setup()
	const result = await tool.execute({ content: '改完了，这是结果' })

	assert.equal(result.ok, true)
	assert.deepEqual(result.sent, [{ kind: 'text', messageId: 'M1' }])
	assert.equal(enqueued.length, 1)
	assert.equal(enqueued[0].kind, 'send_c2c')
	assert.equal(enqueued[0].args.content, '【标题(session-1)】\n改完了，这是结果')
	assert.equal(enqueued[0].args.markdown, true)
	assert.equal(enqueued[0].args.replyToMsgId, 'USER-MSG')
	assert.equal(enqueued[0].args.msgSeq, 1)
	assert.equal(enqueued[0].options.expectAck, true)
})

test('markdown 开关：AI 传 false 时按纯文本发', async () => {
	const { tool, enqueued } = setup()
	await tool.execute({ content: '普通文本', markdown: false })
	assert.equal(enqueued[0].args.markdown, false)
})

test('只发附件：先补一条带来源标注的单行文本，再逐条发媒体', async () => {
	const { tool, enqueued } = setup()
	const result = await tool.execute({
		attachments: [
			{ kind: 'image', path: '/tmp/a.png' },
			{ kind: 'file', url: 'https://example.com/b.pdf', name: 'b.pdf' },
		],
	})

	assert.equal(result.ok, true)
	assert.equal(enqueued.length, 3)
	assert.equal(enqueued[0].kind, 'send_c2c')
	assert.equal(enqueued[0].args.content, '【标题(session-1)】')
	assert.equal(enqueued[1].kind, 'send_media')
	assert.equal(enqueued[1].args.kind, 'image')
	assert.equal(enqueued[1].args.path, '/tmp/a.png')
	assert.equal(enqueued[2].kind, 'send_media')
	assert.equal(enqueued[2].args.url, 'https://example.com/b.pdf')
	assert.equal(enqueued[2].args.name, 'b.pdf')
	assert.deepEqual(
		result.sent.map((s) => s.kind),
		['preface', 'image', 'file'],
	)
})

test('参数校验：空内容、非法 kind、缺 path/url 都如实回报失败', async () => {
	const { tool, enqueued } = setup()

	const empty = await tool.execute({})
	assert.equal(empty.ok, false)
	assert.match(empty.failed[0].error, /至少要给一个/)

	const badKind = await tool.execute({ attachments: [{ kind: 'audio', path: '/tmp/a' }] })
	assert.equal(badKind.ok, false)
	assert.match(badKind.failed[0].error, /kind 必须是/)

	const noSource = await tool.execute({ attachments: [{ kind: 'image' }] })
	assert.equal(noSource.ok, false)
	assert.match(noSource.failed[0].error, /path 与 url/)

	// 非法附件不该产生媒体命令（只有 preface 那条文本）
	assert.equal(enqueued.filter((e) => e.kind === 'send_media').length, 0)
})

test('未绑定 QQ 私聊时明确拒绝', async () => {
	const { enqueued } = setup()
	const openidless = buildReplyTool({
		outbox: { enqueue: () => ({ acked: Promise.resolve({ ok: true }) }) },
		config: CONFIG,
		logger: {},
		target: { sessionId: 'session-1', openid: () => null, label: () => ({ title: 'x', id: 'x' }), context: () => ({}), nextSeq: () => 1 },
	})
	const result = await openidless.execute({ content: 'hi' })
	assert.equal(result.ok, false)
	assert.match(result.failed[0].error, /没有绑定 QQ 私聊/)
	assert.equal(enqueued.length, 0)
})

test('等待送达确认超时：如实回报失败而不是假装成功', async () => {
	const { tool } = setup({ ackResolve: () => new Promise(() => {}) })
	const result = await tool.execute({ content: '结果' })
	assert.equal(result.ok, false)
	assert.match(result.failed[0].error, /超时/)
})

test('平台拒绝送达：回报平台错误', async () => {
	const { tool } = setup({ acked: { ok: false, error: '平台错误码 40034006' } })
	const result = await tool.execute({ content: '结果' })
	assert.equal(result.ok, false)
	assert.match(result.failed[0].error, /40034006/)
})
