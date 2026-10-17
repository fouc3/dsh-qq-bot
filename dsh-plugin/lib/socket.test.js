import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtempSync, statSync, unlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSocketServer, FrameError, MAX_FRAME_BYTES, parseEndpoint } from './socket.js'

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

// 线上事故（2026-10-16 03:53）：改 `cordis.patch.yml` 触发 profile 热重载 ——
// 「先 dispose 旧实例、再 apply 新实例」中间有个窗口：旧 server 已经不理新连接（所以探测像"残留"），
// 但它的 uv_close 还没跑完；Node/libuv 关闭 UNIX server 时会**按路径名 unlink**。
// 旧实现这时会立刻 unlink 再 listen，抢到的名字随后被旧实例那一下 unlink 删掉：
// `ss` 里监听还在，路径却没了 → 网关从 03:53:15 起一直 "no such file"，桥永久断。
test('热重载竞态：新实例绝不抢在老实例的 close 之前 listen（否则路径会被它删掉）', async (t) => {
	const path = tmpSocketPath()
	const old = await createSocketServer({ path, logger: {}, handlers: handlers() })

	// 新实例此刻来接管：老实例还在 listen → 它必须等，而不是"清掉路径就抢名字"。
	const pending = createSocketServer({ path, logger: {}, handlers: handlers(), waitMs: 2000 })
	await new Promise((resolve) => setTimeout(resolve, 50))
	const closing = old.close()
	const fresh = await pending
	t.after(async () => fresh.close())
	await closing
	// 老实例的 uv_close 是"先断连接、再 unlink 名字"：这里给它跑完的机会。
	await new Promise((resolve) => setTimeout(resolve, 50))

	assert.ok(existsSync(path), '新实例的 socket 路径必须还在（被老实例按名字删掉 = 桥永久断）')
	const lines = await exchange(path, [{ id: '1', op: 'health' }])
	assert.equal(lines[0].ok, true, '新实例必须真的在服务（网关要能连上）')
})

test('热重载：老实例还活着时新实例会等它退出，而不是直接抛"已被占用"', async (t) => {
	const path = tmpSocketPath()
	const old = await createSocketServer({ path, logger: {}, handlers: handlers() })

	const pending = createSocketServer({ path, logger: {}, handlers: handlers() })
	await new Promise((resolve) => setTimeout(resolve, 150))
	await old.close()

	const fresh = await pending
	t.after(async () => fresh.close())
	assert.ok(existsSync(path), '等老实例退出后应成功接管并重建 socket')
	const lines = await exchange(path, [{ id: '1', op: 'health' }])
	assert.equal(lines[0].ok, true)
})

test('真的两个实例并存（老实例不退出）才抛"已被占用"', async (t) => {
	const path = tmpSocketPath()
	const first = await createSocketServer({ path, logger: {}, handlers: handlers() })
	t.after(async () => first.close())

	await assert.rejects(
		() => createSocketServer({ path, logger: {}, handlers: handlers(), waitMs: 200 }),
		/已被占用/,
	)
})

test('关掉服务端后路径由 Node/libuv 清掉（我们不再自己 unlink，避免误删新实例的路径）', async (t) => {
	const path = tmpSocketPath()
	const server = await createSocketServer({ path, logger: {}, handlers: handlers() })
	assert.ok(existsSync(path))
	await server.close()
	await new Promise((resolve) => setTimeout(resolve, 20))
	assert.equal(existsSync(path), false, '关完不该留下残留路径（否则下次启动要多等 settleMs）')
})

test('MAX_FRAME_BYTES 与 Go 侧约定一致（1 MiB）', () => {
	assert.equal(MAX_FRAME_BYTES, 1 << 20)
})

// Windows 上没有 AF_UNIX 可用（libuv 的 pipe 是 NPFS 管道），所以地址多了 pipe: 写法。
// 解析规则必须与 Go 侧 internal/bridge.ParseEndpoint 一致，否则两边认的不是同一个名字。
test('parseEndpoint：裸路径 / unix: / pipe: 三种写法归一', () => {
	assert.deepEqual(parseEndpoint('/run/dsh/bridge.sock'), {
		kind: 'unix',
		target: '/run/dsh/bridge.sock',
		label: '/run/dsh/bridge.sock',
	})
	const unix = parseEndpoint('unix:/run/x.sock')
	assert.equal(unix.kind, 'unix')
	assert.equal(unix.target, '/run/x.sock')

	const pipe = parseEndpoint('pipe:dsh-qq-bot-bridge')
	assert.equal(pipe.kind, 'pipe')
	assert.equal(pipe.target, '\\\\.\\pipe\\dsh-qq-bot-bridge', '要补上 \\\\.\\pipe\\ 前缀')
	assert.equal(pipe.label, 'pipe:dsh-qq-bot-bridge', '日志里只写名字')

	// 已经带前缀的不重复加，且前缀大小写不敏感
	assert.equal(parseEndpoint('pipe:\\\\.\\pipe\\demo').target, '\\\\.\\pipe\\demo')
	assert.equal(parseEndpoint('PIPE:\\\\.\\PIPE\\demo').target, '\\\\.\\pipe\\demo')

	// Windows 盘符不算方案（否则 C: 会被当成 pipe/unix 前缀）
	assert.equal(parseEndpoint('C:\\Users\\me\\bridge.sock').kind, 'unix')

	assert.throws(() => parseEndpoint(''), /不能为空/)
	assert.throws(() => parseEndpoint('pipe:'), /缺少管道名/)
	assert.throws(() => parseEndpoint('unix:'), /缺少路径/)
})

// 不在 POSIX 上"尽力而为"：配错成 pipe: 就明确报错，而不是在当前目录建出一个
// 叫 `\\.\pipe\…` 的 socket 文件（那会让人排查半天"为什么网关连不上"）。
test('POSIX 上配 pipe: 直接报错', async (t) => {
	if (process.platform === 'win32') {
		t.skip('Windows 上管道是正常用法')
		return
	}
	await assert.rejects(
		() => createSocketServer({ path: 'pipe:demo-x', logger: {}, handlers: handlers() }),
		/命名管道/,
	)
	assert.equal(existsSync('\\\\.\\pipe\\demo-x'), false, '不许在当前目录留下怪文件')
})

// 真机行为：Windows 上 createSocketServer 走命名管道分支（没有 mkdir / chmod / unlink 那一套）。
// 本机（Linux）没法 listen 管道，所以这里整条跳过。
test('命名管道：Windows 上能 listen，其他平台只验解析', async (t) => {
	if (process.platform !== 'win32') {
		t.skip('命名管道只在 Windows 上可 listen')
		return
	}
	const name = `qqbot-test-${process.pid}-${Date.now()}`
	const server = await createSocketServer({
		path: `pipe:${name}`,
		token: 'tk',
		logger: {},
		handlers: handlers(),
	})
	t.after(async () => server.close())
	assert.equal(server.kind, 'pipe')
	assert.equal(server.path, `pipe:${name}`)
	assert.equal(server.target, `\\\\.\\pipe\\${name}`)

	const lines = await exchange(server.target, [{ token: 'tk' }, { id: '1', op: 'health' }], { expect: 2 })
	assert.equal(lines[1].ok, true, '命名管道要真的能收发帧')
})
