/**
 * 本地通道服务端：UNIX domain socket + 换行分隔 JSON（NDJSON）。
 *
 * 与 HTTP 不同，这里的认证靠**文件权限**：目录 0700、socket 文件 0600，
 * 只有与 dsh 同账户的进程能连上；需要额外加固时再叠一层 token 握手。
 * 协议细节见 docs/protocol.md。
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { dirname } from 'node:path'
import { timingSafeEqual } from 'node:crypto'

/** 单帧上限（与 Go 侧一致）。 */
export const MAX_FRAME_BYTES = 1 << 20

/** 协议错误：会被序列化成 { ok:false, error:{ code, message } }。 */
export class FrameError extends Error {
	constructor(code, message) {
		super(message)
		this.code = code
	}
}

function safeEqual(a, b) {
	const left = Buffer.from(String(a ?? ''), 'utf8')
	const right = Buffer.from(String(b ?? ''), 'utf8')
	if (left.length !== right.length) return false
	return timingSafeEqual(left, right)
}

/** 探测并清理上一次留下的 socket 文件。 */
async function clearStaleSocket(path, logger) {
	if (!existsSync(path)) return
	const alive = await new Promise((resolve) => {
		const socket = connect(path)
		const done = (value) => {
			socket.removeAllListeners()
			socket.destroy()
			resolve(value)
		}
		socket.once('connect', () => done(true))
		socket.once('error', () => done(false))
	})
	if (alive) {
		throw new Error(`本地通道 socket 已被占用：${path}（是否起了两个 dsh 实例？）`)
	}
	logger?.warn?.('清理残留的通道 socket', { path })
	unlinkSync(path)
}

/**
 * 起一个通道服务端。
 *
 * @param {object} options
 * @param {string} options.path socket 路径
 * @param {string} [options.token] 非空时要求首帧为 {"token":…}
 * @param {object} options.logger
 * @param {Record<string, (args:any)=>any>} options.handlers op → 处理函数（可异步，可 throw FrameError）
 * @param {number} [options.maxFrameBytes]
 * @returns {Promise<{close: () => Promise<void>, path: string}>}
 */
export async function createSocketServer({ path, token = '', logger, handlers, maxFrameBytes = MAX_FRAME_BYTES }) {
	if (!path) throw new Error('通道 socketPath 不能为空')
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	try {
		chmodSync(dirname(path), 0o700)
	} catch {
		// 某些文件系统不支持，忽略
	}
	await clearStaleSocket(path, logger)

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
		server.listen(path, () => {
			server.removeListener('error', reject)
			resolve()
		})
	})
	try {
		chmodSync(path, 0o600)
	} catch (error) {
		logger?.warn?.('设置 socket 权限失败（请确认目录权限）', { path, error: String(error) })
	}

	return {
		path,
		async close() {
			for (const socket of sockets) socket.destroy()
			sockets.clear()
			await new Promise((resolve) => server.close(() => resolve()))
			try {
				if (existsSync(path)) unlinkSync(path)
			} catch {
				// 忽略
			}
		},
	}
}
