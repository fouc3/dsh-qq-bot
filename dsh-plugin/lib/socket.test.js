import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtempSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSocketServer, FrameError, MAX_FRAME_BYTES } from './socket.js'

function tmpSocketPath() {
	return join(mkdtempSync(join(tmpdir(), 'qqbot-sock-')), 'bridge.sock')
}

/** 连上 socket，按顺序发若干帧，收集 expect 条应答。 */
function exchange(path, frames, { expect = 1, timeoutMs = 1500 } = {}) {
	return new Promise((resolve, reject) => {
		const socket = connect(path)
		const lines = []
		let buffer = ''
		const done = () => {
			clearTimeout(timer)
			socket.destroy()
			resolve(lines)
		}
		const timer = setTimeout(done, timeoutMs)

		socket.on('connect', () => {
			for (const frame of frames) {
				// 字符串按"原始行"发送，方便测坏 JSON。
				socket.write(`${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n`)
			}
		})
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8')
			let index
			while ((index = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, index)
				buffer = buffer.slice(index + 1)
				if (!line.trim()) continue
				lines.push(JSON.parse(line))
				if (lines.length >= expect) return done()
			}
		})
		socket.on('error', (error) => {
			clearTimeout(timer)
			reject(error)
		})
	})
}

function handlers(extra = {}) {
	return {
		health: async () => ({ ok: true, version: 1 }),
		echo: async (args) => ({ got: args }),
		boom: async () => {
			throw new FrameError('bad-request', '缺少 op')
		},
		crash: async () => {
			throw new Error('内部炸了')
		},
		...extra,
	}
}

async function start(t, options = {}) {
	const path = options.path ?? tmpSocketPath()
	const server = await createSocketServer({ path, logger: {}, handlers: handlers(options.extra), ...options })
	t.after(async () => server.close())
	return { server, path }
}

test('socket 放在 0700 目录里、权限 0600，请求/应答按帧往返', async (t) => {
	const { path } = await start(t)

	const mode = statSync(path).mode & 0o777
	assert.equal(mode, 0o600, 'socket 必须是 0600（权限即认证）')

	const lines = await exchange(path, [{ id: '1', op: 'echo', args: { a: 1 } }])
	assert.deepEqual(lines[0], { id: '1', ok: true, value: { got: { a: 1 } } })
})

test('未知 op / 坏 JSON / 处理函数抛错 都有明确错误码', async (t) => {
	const { path } = await start(t)

	const unknown = await exchange(path, [{ id: 'x', op: 'nope' }])
	assert.equal(unknown[0].ok, false)
	assert.equal(unknown[0].error.code, 'unknown-op')

	const missing = await exchange(path, [{ id: 'y' }])
	assert.equal(missing[0].error.code, 'bad-request')

	const bad = await exchange(path, ['{not json'])
	assert.equal(bad[0].error.code, 'bad-json')

	const domain = await exchange(path, [{ id: 'b', op: 'boom' }])
	assert.equal(domain[0].error.code, 'bad-request')
	assert.match(domain[0].error.message, /缺少 op/)

	const internal = await exchange(path, [{ id: 'c', op: 'crash' }])
	assert.equal(internal[0].error.code, 'internal', '内部错误不暴露细节码')
})

test('token 握手：错误 token 回 unauthorized 并断开，正确 token 继续处理', async (t) => {
	const { path } = await start(t, { token: 'secret', extra: {} })

	const bad = await exchange(path, [{ token: 'wrong' }])
	assert.equal(bad[0].ok, false)
	assert.equal(bad[0].error.code, 'unauthorized')

	const good = await exchange(path, [{ token: 'secret' }, { id: '1', op: 'health' }], { expect: 2 })
	assert.deepEqual(good[0], { ok: true })
	assert.equal(good[1].ok, true)
	assert.equal(good[1].value.ok, true)
})

test('超过帧上限的连接被断开（不试图恢复）', async (t) => {
	const { path } = await start(t, { maxFrameBytes: 512 })

	const huge = { id: 'big', op: 'echo', args: { blob: 'x'.repeat(2048) } }
	const lines = await exchange(path, [huge], { expect: 1, timeoutMs: 500 })
	assert.deepEqual(lines, [], '超大帧不该拿到应答')
})

test('残留 socket 会被清理后重新监听', async (t) => {
	const path = tmpSocketPath()
	writeFileSync(path, 'not a socket')
	const server = await createSocketServer({ path, logger: {}, handlers: handlers() })
	t.after(async () => server.close())

	assert.ok(existsSync(path), '应重新建立了 socket')
	const lines = await exchange(path, [{ id: '1', op: 'health' }])
	assert.equal(lines[0].ok, true)
})

test('MAX_FRAME_BYTES 与 Go 侧约定一致（1 MiB）', () => {
	assert.equal(MAX_FRAME_BYTES, 1 << 20)
})
