/**
 * 本地通道服务端：换行分隔 JSON（NDJSON）跑在本地通道上。
 *
 * POSIX 用 UNIX domain socket：与 HTTP 不同，这里的认证靠**文件权限**——
 * 目录 0700、socket 文件 0600，只有与 dsh 同账户的进程能连上；需要额外加固时再叠一层 token 握手。
 * Windows 只能用**命名管道**（libuv 的 pipe 就是 NPFS 管道，建不出 AF_UNIX）：那边没有权限位可依，
 * 所以 token 在 Windows 上是必填项。两种地址都由 parseEndpoint() 归一，协议细节见 docs/protocol.md。
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { dirname } from 'node:path'
import { timingSafeEqual } from 'node:crypto'

/** 单帧上限（与 Go 侧一致）。 */
export const MAX_FRAME_BYTES = 1 << 20

/** Windows 命名管道的固定前缀。 */
const PIPE_PREFIX = '\\\\.\\pipe\\'

/** 协议错误：会被序列化成 { ok:false, error:{ code, message } }。 */
export class FrameError extends Error {
	constructor(code, message) {
		super(message)
		this.code = code
	}
}

/**
 * 解析通道地址（与 Go 侧 internal/bridge 的 ParseEndpoint 同一套语义）。
 *
 *   `/run/dsh/bridge.sock` / `unix:/run/dsh/bridge.sock`  → { kind: 'unix',  target: 路径 }
 *   `pipe:名字` / `pipe:\\.\pipe\名字`                      → { kind: 'pipe',  target: '\\.\pipe\名字' }
 *
 * 只认这两个**短**方案：`C:\…` 冒号前是单个字母，不会被当成方案名（仍按 unix 路径处理）。
 *
 * @param {string} raw
 * @returns {{kind: 'unix'|'pipe', target: string, label: string}}
 */
export function parseEndpoint(raw) {
	const value = String(raw ?? '').trim()
	if (!value) throw new Error('通道 socketPath 不能为空')
	const match = /^(unix|pipe):([\s\S]*)$/i.exec(value)
	if (!match) return { kind: 'unix', target: value, label: value }
	const scheme = match[1].toLowerCase()
	const rest = match[2].trim()
	if (!rest) {
		throw new Error(
			scheme === 'pipe'
				? `通道地址 ${JSON.stringify(raw)} 缺少管道名（应为 pipe:<名字>）`
				: `通道地址 ${JSON.stringify(raw)} 缺少路径（应为 unix:<路径>）`,
		)
	}
	if (scheme === 'pipe') {
		const name = hasPipePrefix(rest) ? rest.slice(PIPE_PREFIX.length) : rest
		return { kind: 'pipe', target: `${PIPE_PREFIX}${name}`, label: `pipe:${name}` }
	}
	return { kind: 'unix', target: rest, label: rest }
}

/** 判断是否已带 `\\.\pipe\` 前缀（Windows 的路径不区分大小写）。 */
function hasPipePrefix(value) {
	return value.slice(0, PIPE_PREFIX.length).toLowerCase() === PIPE_PREFIX.toLowerCase()
}

function safeEqual(a, b) {
	const left = Buffer.from(String(a ?? ''), 'utf8')
	const right = Buffer.from(String(b ?? ''), 'utf8')
	if (left.length !== right.length) return false
	return timingSafeEqual(left, right)
}

/** 探测某个 socket 路径后面还有没有活着的服务端。 */
function probeSocket(path) {
	return new Promise((resolve) => {
		const socket = connect(path)
		const done = (value) => {
			socket.removeAllListeners()
			socket.destroy()
			resolve(value)
		}
		socket.once('connect', () => done(true))
		socket.once('error', () => done(false))
	})
}

/**
 * 探测并清理上一次留下的 socket 文件。
 *
 * **为什么不能"看到没人应答就立刻 unlink 再 listen"**：Node/libuv 在关闭一个 UNIX server
 * 时是**按路径名 unlink** 的（不是按 inode）。profile 热重载（改 `cordis.patch.yml`）是
 * "先 dispose 旧实例、再 apply 新实例"，旧实例的 `server.close()` 是异步的：它把连接断掉后，
 * 还要等 uv_close 真正完成才会 unlink。如果新实例在这中间探到"没人应答"就抢先 listen 同名路径，
 * 旧实例随后那一下 unlink 会把**新实例刚建好的 socket** 删掉 —— 表现为 `ss` 里监听还在、
 * 但路径没了，所有客户端 lstat 直接 `no such file`，桥永久断掉（线上事故 2026-10-16 03:53）。
 *
 * 所以这里的顺序是：老实例还活着 → 等它退出（`waitMs`）；老实例已经不响应但路径还在 →
 * 再等一小会儿看它自己消失（`settleMs`，那就是它 uv_close 的 unlink）；真·残留文件
 * （进程崩了，没人会再删它）等不到，就由我们清掉。两个等待都是"宁可慢一点，绝不抢名字"。
 */
async function clearStaleSocket(path, logger, { waitMs = 3000, pollMs = 20, settleMs = 200 } = {}) {
	if (!existsSync(path)) return
	const deadline = Date.now() + waitMs
	let waited = false
	while (await probeSocket(path)) {
		if (Date.now() >= deadline) {
			throw new Error(`本地通道 socket 已被占用：${path}（是否起了两个 dsh 实例？）`)
		}
		if (!waited) {
			logger?.warn?.('通道 socket 仍被占用，等老实例退出后接管', { path })
			waited = true
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}

	// 没人应答了，但路径还在：给它一点时间自己消失（老实例 uv_close 的 unlink 就在这一刻）。
	const settleDeadline = Date.now() + settleMs
	while (existsSync(path) && Date.now() < settleDeadline) {
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}
	if (!existsSync(path)) return

	logger?.warn?.('清理残留的通道 socket', { path })
	try {
		unlinkSync(path)
	} catch {
		// 理论上到不了这里；真到了也不致命（listen 会再报错）
	}
}

/**
 * 命名管道的"抢占"处理。
 *
 * 命名管道没有文件、也没有 unlink：进程一死名字就没了，所以**不需要清理**。
 * 唯一要处理的是热重载那个窗口——老实例可能还在应答（或刚断还在收尾），
 * 这时照样"宁可慢一点，绝不抢名字"：等它不应答了再 listen。
 */
async function waitForPipeName(target, logger, { waitMs = 3000, pollMs = 20 } = {}) {
	const deadline = Date.now() + waitMs
	let warned = false
	while (await probeSocket(target)) {
		if (Date.now() >= deadline) {
			throw new Error(`本地通道命名管道已被占用：${target}（是否起了两个 dsh 实例？）`)
		}
		if (!warned) {
			logger?.warn?.('通道命名管道仍被占用，等老实例退出后接管', { target })
			warned = true
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs))
	}
}

/**
 * 起一个通道服务端。
 *
 * @param {object} options
 * @param {string} options.path 通道地址：POSIX 写 socket 路径，Windows 写 `pipe:名字`
 * @param {string} [options.token] 非空时要求首帧为 {"token":…}（Windows 命名管道上必填）
 * @param {object} options.logger
 * @param {Record<string, (args:any)=>any>} options.handlers op → 处理函数（可异步，可 throw FrameError）
 * @param {number} [options.maxFrameBytes]
 * @param {number} [options.waitMs] 接管前等老实例退出的上限（默认 3000ms；测试里会调小）
 * @returns {Promise<{close: () => Promise<void>, path: string, kind: string, target: string}>}
 */
export async function createSocketServer({
	path,
	token = '',
	logger,
	handlers,
	maxFrameBytes = MAX_FRAME_BYTES,
	waitMs,
}) {
	const endpoint = parseEndpoint(path)
	if (endpoint.kind === 'pipe') {
		if (process.platform !== 'win32') {
			// 不做兜底猜测：在 Linux 上 listen 一个 `\\.\pipe\…` 名字，会真的在**当前目录**
			// 建出一个叫 `\\.\pipe\…` 的 socket 文件，然后网关怎么都连不上。这里直接说清楚。
			throw new Error(
				`通道地址 ${endpoint.label} 是 Windows 命名管道，本机（${process.platform}）用不了；` +
					'请改成 UNIX domain socket 路径（如 ~/.dsh/dsh-qq-bot/bridge.sock）',
			)
		}
		await waitForPipeName(endpoint.target, logger, waitMs === undefined ? undefined : { waitMs })
	} else {
		mkdirSync(dirname(endpoint.target), { recursive: true, mode: 0o700 })
		try {
			chmodSync(dirname(endpoint.target), 0o700)
		} catch {
			// 某些文件系统不支持，忽略
		}
		await clearStaleSocket(endpoint.target, logger, waitMs === undefined ? undefined : { waitMs })
	}

	const server = createServer({ allowHalfOpen: false })
	/** 让所有在途连接随关闭一起断开。 */
	const sockets = new Set()

	server.on('connection', (socket) => {
		sockets.add(socket)
		socket.on('close', () => sockets.delete(socket))
		socket.on('error', (error) => logger?.warn?.('通道连接出错', { error: String(error) }))

		let buffer = ''
		let handshaken = token === ''
		let chain = Promise.resolve()

		const reply = (obj) => {
			const line = `${JSON.stringify(obj)}\n`
			if (line.length > maxFrameBytes) {
				socket.write(`${JSON.stringify({ ok: false, error: { code: 'too-large', message: '应答超过帧上限' } })}\n`)
				socket.destroy()
				return
			}
			socket.write(line)
		}

		const handleLine = async (line) => {
			if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) {
				logger?.warn?.('通道收到超大帧，断开连接')
				socket.destroy()
				return
			}
			let frame
			try {
				frame = JSON.parse(line)
			} catch {
				reply({ id: null, ok: false, error: { code: 'bad-json', message: '帧不是合法 JSON' } })
				return
			}

			if (!handshaken) {
				if (!safeEqual(frame?.token, token)) {
					logger?.warn?.('通道握手失败：token 不匹配')
					socket.write(`${JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'token 不匹配' } })}\n`)
					socket.destroy()
					return
				}
				handshaken = true
				socket.write('{"ok":true}\n')
				return
			}

			const id = frame?.id ?? null
			const op = frame?.op
			if (typeof op !== 'string' || !op) {
				reply({ id, ok: false, error: { code: 'bad-request', message: '缺少 op' } })
				return
			}
			const handler = handlers[op]
			if (typeof handler !== 'function') {
				reply({ id, ok: false, error: { code: 'unknown-op', message: `未知 op：${op}` } })
				return
			}
			const started = Date.now()
			try {
				const value = await handler(frame?.args ?? {})
				logger?.debug?.('通道调用完成', { op, ms: Date.now() - started })
				reply(value === undefined ? { id, ok: true } : { id, ok: true, value })
			} catch (error) {
				const code = error instanceof FrameError ? error.code : 'internal'
				logger?.warn?.('通道调用失败', { op, code, error: String(error?.message ?? error) })
				reply({ id, ok: false, error: { code, message: String(error?.message ?? error) } })
			}
		}

		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8')
			if (Buffer.byteLength(buffer, 'utf8') > maxFrameBytes) {
				logger?.warn?.('通道缓冲区超限，断开连接')
				socket.destroy()
				return
			}
			let index
			while ((index = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, index)
				buffer = buffer.slice(index + 1)
				if (!line.trim()) continue
				// 每条连接内串行处理，避免同一连接的请求互相插队。
				chain = chain.then(() => handleLine(line)).catch((error) => {
					logger?.warn?.('通道处理链异常', { error: String(error) })
				})
			}
		})
	})

	await new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(endpoint.target, () => {
			server.removeListener('error', reject)
			resolve()
		})
	})
	if (endpoint.kind === 'unix') {
		try {
			chmodSync(endpoint.target, 0o600)
		} catch (error) {
			logger?.warn?.('设置 socket 权限失败（请确认目录权限）', { path: endpoint.label, error: String(error) })
		}
	}

	return {
		path: endpoint.label,
		kind: endpoint.kind,
		target: endpoint.target,
		async close() {
			for (const socket of sockets) socket.destroy()
			sockets.clear()
			// 路径的清理**交给 Node/libuv**（关 UNIX server 时它自己会按绑定的名字 unlink；
			// 命名管道没有文件可清）。我们自己再 unlink 一次没有收益，却会参与"按名字删掉新实例路径"的竞态。
			await new Promise((resolve) => server.close(() => resolve()))
		},
	}
}
