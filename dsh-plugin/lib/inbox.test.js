import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ATTACH_STATUS, createInbox, formatBytes } from './inbox.js'
import { createState } from './state.js'

/** 造一个只读的"附件服务"替身，记录每次保存。 */
function makeAttachments() {
	const savedImages = []
	const savedFiles = []
	let seq = 0
	return {
		savedImages,
		savedFiles,
		async saveImages(inputs) {
			return inputs.map((input) => {
				savedImages.push(input)
				seq += 1
				return { attachmentId: `img-${seq}`, mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }
			})
		},
		async saveFileStream({ data, name }) {
			let bytes = 0
			for await (const chunk of data) bytes += chunk.length
			seq += 1
			const ref = { attachmentId: `file-${seq}`, name, bytes }
			savedFiles.push({ ref, name })
			return ref
		},
		fileHostPath(ref) {
			return `/home/u/.dsh/attachments/v1/objects/${ref.attachmentId}`
		},
	}
}

/** 造一个 fetch 替身：按 url 返回不同结果。 */
function makeFetch(routes) {
	const calls = []
	const impl = async (url) => {
		calls.push(url)
		const route = routes[url]
		if (!route) return { ok: false, status: 404, headers: { get: () => null }, body: null }
		if (route.fail) return { ok: false, status: route.status ?? 500, headers: { get: () => null }, body: null }
		const chunks = route.chunks ?? [new Uint8Array(route.bytes ?? 10)]
		return {
			ok: true,
			status: 200,
			headers: { get: (name) => (name === 'content-length' && route.contentLength ? String(route.contentLength) : null) },
			body: (async function* () {
				for (const chunk of chunks) yield chunk
			})(),
		}
	}
	impl.calls = calls
	return impl
}

function makeInbox({ config = {}, routes = {}, attachments = makeAttachments() } = {}) {
	const state = createState({})
	const fetchImpl = makeFetch(routes)
	const inbox = createInbox({ state, attachments, config, logger: {}, fetchImpl })
	return { inbox, state, attachments, fetchImpl }
}

const image = { kind: 'image', contentType: 'image/png', filename: 'cat.png', size: 100, url: 'https://x/cat.png' }

test('formatBytes：给出人能看的体积，0 就空着', () => {
	assert.equal(formatBytes(0), '')
	assert.equal(formatBytes(512), '512 B')
	assert.equal(formatBytes(2048), '2.0 KB')
	assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB')
})

test('输入态：文字累加成一条正文，清空与取消各归各位', () => {
	const { inbox, state } = makeInbox()
	assert.equal(inbox.active('U1'), null)

	inbox.begin({ openid: 'U1', sessionId: 's-1' })
	inbox.appendText({ openid: 'U1', text: '第一段' })
	inbox.appendText({ openid: 'U1', text: '第二段' })
	assert.equal(inbox.textOf(inbox.active('U1')), '第一段\n\n第二段')

	// 重复进入同一会话：不清空
	inbox.begin({ openid: 'U1', sessionId: 's-1' })
	assert.equal(inbox.textOf(inbox.active('U1')), '第一段\n\n第二段')

	// 换会话才重置
	inbox.begin({ openid: 'U1', sessionId: 's-2' })
	assert.equal(inbox.textOf(inbox.active('U1')), '')

	inbox.appendText({ openid: 'U1', text: 'x' })
	inbox.clearText({ openid: 'U1' })
	assert.equal(inbox.textOf(inbox.active('U1')), '')

	const drained = inbox.drain({ openid: 'U1' })
	assert.equal(drained.sessionId, 's-2')
	assert.equal(inbox.active('U1'), null)
	assert.equal(state.inboxOf('U1'), null)
})

test('附件入列：图片走图片服务、文件走文件服务、超限不下载、下载失败如实记录', async () => {
	const { inbox, attachments, fetchImpl } = makeInbox({
		config: { maxAttachmentBytes: 1000 },
		routes: {
			'https://x/cat.png': { bytes: 100 },
			'https://x/a.txt': { bytes: 20 },
			'https://x/big.mp4': { bytes: 10 },
			'https://x/boom.bin': { fail: true },
		},
	})
	inbox.begin({ openid: 'U1', sessionId: 's-1' })
	inbox.begin({ openid: 'U1', sessionId: 's-1' })

	await inbox.addAttachments({
		openid: 'U1',
		attachments: [
			image,
			{ kind: 'file', contentType: 'file', filename: 'a.txt', size: 20, url: 'https://x/a.txt' },
			{ kind: 'video', contentType: 'video/mp4', filename: 'big.mp4', size: 9999, url: 'https://x/big.mp4' },
			{ kind: 'file', contentType: 'file', filename: 'boom.bin', size: 10, url: 'https://x/boom.bin' },
		],
	})
	const items = inbox.active('U1').items
	assert.deepEqual(
		items.map((item) => item.id),
		['A1', 'A2', 'A3', 'A4'],
		'附件 id 顺序分配',
	)
	assert.equal(items[0].status, ATTACH_STATUS.stored)
	assert.equal(items[0].image, true)
	assert.equal(attachments.savedImages.length, 1)
	assert.equal(attachments.savedImages[0].mediaType, 'image/png')

	assert.equal(items[1].status, ATTACH_STATUS.stored)
	assert.equal(items[1].image, undefined)
	assert.equal(attachments.savedFiles.length, 1)

	assert.equal(items[2].status, ATTACH_STATUS.oversize, '超过上限就不自动下载')
	assert.match(items[2].note, /超过自动下载上限/)
	assert.ok(!fetchImpl.calls.includes('https://x/big.mp4'), '超限的附件不该发请求')

	assert.equal(items[3].status, ATTACH_STATUS.failed)
	assert.match(items[3].note, /自动下载失败/)

	assert.equal(inbox.storedImages(inbox.active('U1')).length, 1)
	assert.equal(inbox.storedFiles(inbox.active('U1')).length, 1)
	assert.deepEqual(
		inbox.unavailable(inbox.active('U1')).map((item) => item.id),
		['A3', 'A4'],
	)
})

test('附件 id 跨输入态单调递增，绝不重用', async () => {
	const { inbox } = makeInbox({ routes: { 'https://x/a.png': { bytes: 8 } } })
	inbox.begin({ openid: 'U1', sessionId: 's-1' })
	await inbox.addAttachments({ openid: 'U1', attachments: [image] })
	assert.equal(inbox.active('U1').items[0].id, 'A1')

	// 退出输入态再来一次：id 不能从 A1 重来（否则模型手里的旧 id 会指到新附件）
	inbox.drain({ openid: 'U1' })
	inbox.begin({ openid: 'U1', sessionId: 's-1' })
	await inbox.addAttachments({ openid: 'U1', attachments: [image] })
	assert.equal(inbox.active('U1').items[0].id, 'A2')
})

test('语音：有平台转写就带着走；没有转写标成「无法识别」并拦住发送', async () => {
	const { inbox } = makeInbox()
	inbox.begin({ openid: 'U1', sessionId: 's-1' })
	await inbox.addAttachments({
		openid: 'U1',
		attachments: [
			{ kind: 'voice', contentType: 'voice', url: 'https://x/1.silk', asrText: '帮我看下这个报错' },
			{ kind: 'voice', contentType: 'voice', url: 'https://x/2.silk' },
		],
	})
	const entry = inbox.active('U1')
	assert.equal(entry.items[0].status, ATTACH_STATUS.voice)
	assert.equal(entry.items[1].status, ATTACH_STATUS.voiceUnrecognized)
	assert.deepEqual(inbox.voiceText(entry), ['帮我看下这个报错'])
	assert.deepEqual(
		inbox.blockingVoice(entry).map((item) => item.id),
		['A2'],
		'拿不到转写的语音必须拦住发送',
	)

	// 删掉它之后就不再拦
	inbox.removeItem({ openid: 'U1', itemId: 'A2' })
	assert.equal(inbox.blockingVoice(inbox.active('U1')).length, 0)
})

test('模型按需拉取：oversize 的附件下载下来并给出只读副本路径', async () => {
	const { inbox, attachments } = makeInbox({
		config: { maxAttachmentBytes: 10 },
		routes: { 'https://x/big.mp4': { bytes: 32 } },
	})
	inbox.begin({ openid: 'U1', sessionId: 's-1' })
	await inbox.addAttachments({
		openid: 'U1',
		attachments: [{ kind: 'video', contentType: 'video/mp4', filename: 'big.mp4', size: 999, url: 'https://x/big.mp4' }],
	})
	const entry = inbox.active('U1')
	assert.equal(entry.items[0].status, ATTACH_STATUS.oversize)

	inbox.rememberDelivery({ sessionId: 's-1', items: entry.items })
	const missing = await inbox.fetchForModel({ sessionId: 's-1', itemId: 'A9' })
	assert.equal(missing.ok, false)
	assert.match(missing.error, /没有附件 A9/)

	const done = await inbox.fetchForModel({ sessionId: 's-1', itemId: 'A1' })
	assert.equal(done.ok, true)
	assert.equal(done.item.status, ATTACH_STATUS.stored)
	assert.equal(done.hostPath, `/home/u/.dsh/attachments/v1/objects/file-1`)
	assert.equal(attachments.savedFiles.length, 1)

	// 已经存过的再拉一次：直接给路径，不再发请求
	const again = await inbox.fetchForModel({ sessionId: 's-1', itemId: 'A1' })
	assert.equal(again.ok, true)
	assert.equal(again.hostPath, '/home/u/.dsh/attachments/v1/objects/file-1')
})

test('模型按需拉取：链接过期时如实回报失败', async () => {
	const { inbox } = makeInbox({ config: { maxAttachmentBytes: 1 }, routes: { 'https://x/gone.bin': { fail: true } } })
	inbox.begin({ openid: 'U1', sessionId: 's-1' })
	await inbox.addAttachments({
		openid: 'U1',
		attachments: [{ kind: 'file', contentType: 'file', filename: 'gone.bin', size: 10, url: 'https://x/gone.bin' }],
	})
	const entry = inbox.active('U1')
	inbox.rememberDelivery({ sessionId: 's-1', items: entry.items })
	const result = await inbox.fetchForModel({ sessionId: 's-1', itemId: 'A1' })
	assert.equal(result.ok, false)
	assert.match(result.error, /下载失败/)
})

test('下载超限（无 size 信息时用响应体兜底）不会把内容吃进服务', async () => {
	const { inbox, attachments } = makeInbox({
		config: { maxAttachmentBytes: 8 },
		routes: { 'https://x/unknown.bin': { chunks: [new Uint8Array(6), new Uint8Array(6)] } },
	})
	inbox.begin({ openid: 'U1', sessionId: 's-1' })
	await inbox.addAttachments({
		openid: 'U1',
		attachments: [{ kind: 'file', contentType: 'file', filename: 'unknown.bin', size: 0, url: 'https://x/unknown.bin' }],
	})
	const item = inbox.active('U1').items[0]
	assert.equal(item.status, ATTACH_STATUS.failed)
	assert.match(item.note, /超过上限/)
	assert.equal(attachments.savedFiles.length, 0, '超限时不该留下半截文件')
})
