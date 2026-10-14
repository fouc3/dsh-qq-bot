/**
 * 出站命令队列。
 *
 * 与 Go 网关之间的语义（docs/protocol.md 第 4-5 节）：
 *   - 命令按 id 下发，Go 侧执行完必须 ack；
 *   - 长时间没 ack 的命令会被重新下发（at-least-once），由 Go 侧按 id 去重；
 *   - ack ok:false 表示"这次没成功"：**只有值得重试的才重投**（限速/服务端临时故障），
 *     并且按指数退避延后下发；参数类硬错（如键盘超限）直接丢弃并如实回报，
 *     不能无限重投把自己打成风暴（线上真的发生过）。
 */

/** 失败后是否值得重投。撤回是尽力而为，重投没有意义。 */
const RETRANSMIT_ON_FAILURE = {
	send_c2c: true,
	send_media: true,
	respond_interaction: true,
	recall_c2c: false,
	publish_panel: false,
}

/** 平台错误码里明确"过一会儿再来"的。 */
const TRANSIENT_ERROR_CODES = new Set([
	40034100, // 主动消息发送超过频控限制
	50002, // 频率限制
	40034009, // 指令面板操作进行中，请稍后重试
])

/** 重试上限与退避schedule（指数：2s → 4s → 8s，封顶 60s）。 */
const MAX_ATTEMPTS = 4
const BASE_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 60_000

/**
 * 这次失败值不值得重试？
 *
 * QQ 的 OpenAPI 错误码不是 HTTP 状态码（形如 40034029），**默认不重试**：
 * 参数/超限/权限类错误重试多少次都一样，而无限重投会把日志和平台打爆
 * （线上真的发生过：键盘超限 → 失败 → 重投 → 再失败，2 分钟 240 次）。
 * 只有明确列出的限速类、5xx 类才退避重试；没有平台码（多半是本地/传输层问题）
 * 允许有限次重试。
 */
export function isTransientFailure({ errorCode, error } = {}) {
	if (typeof errorCode === 'number' && errorCode !== 0) {
		if (TRANSIENT_ERROR_CODES.has(errorCode)) return true
		if (errorCode >= 500 && errorCode < 1000) return true // 服务端临时故障
		return false // 其余平台错误码：重试没有意义
	}
	const text = String(error ?? '')
	if (/timeout|超时|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|socket|网络|tls/i.test(text)) return true
	return true
}

/** 第 attempts 次失败后应等多久（attempts 从 1 开始）。 */
export function backoffMs(attempts) {
	const step = Math.max(0, Number(attempts) - 1)
	return Math.min(BASE_BACKOFF_MS * 2 ** step, MAX_BACKOFF_MS)
}

export function createOutbox({ logger, inflightTimeoutMs = 60_000, now = Date.now } = {}) {
	const pending = [] // 待下发
	const inflight = new Map() // id -> { command, since }
	const waitersById = new Map() // id -> resolve（有人在等这条命令的执行结果）
	const pollWaiters = new Set() // 长轮询等待者
	let seq = 0

	const nextId = () => {
		seq += 1
		return `cmd-${now().toString(36)}-${seq}`
	}

	const wake = () => {
		for (const waiter of [...pollWaiters]) waiter()
	}

	/** 超时未 ack 的命令回到待下发（Go 侧按 id 去重，所以重投是安全的）。 */
	function releaseStale() {
		const deadline = now() - inflightTimeoutMs
		for (const [id, entry] of inflight) {
			if (entry.since <= deadline) {
				logger?.warn?.('出站命令超时未 ack，重新排队', { id, kind: entry.command.kind })
				inflight.delete(id)
				entry.command.id = id // 沿用原 id：Go 侧的去重记录才能命中
				pending.push(entry.command)
			}
		}
	}

	/** 把待下发命令交给客户端（退避未到点的留在队列里）。 */
	function drain() {
		const t = now()
		const ready = []
		for (const command of pending) {
			if (!command.notBefore || command.notBefore <= t) ready.push(command)
		}
		if (ready.length === 0) return []
		const readyIds = new Set(ready.map((c) => c.id))
		for (let i = pending.length - 1; i >= 0; i -= 1) {
			if (readyIds.has(pending[i].id)) pending.splice(i, 1)
		}
		for (const command of ready) {
			inflight.set(command.id, { command, since: now() })
		}
		return ready.map(({ id, kind, args }) => ({ id, kind, args }))
	}

	/** 队列里最早一条退避命令的到点时间；没有则 null。 */
	function earliestDue() {
		let next = null
		for (const command of pending) {
			if (!command.notBefore) continue
			if (next === null || command.notBefore < next) next = command.notBefore
		}
		return next
	}

	/** 让等待者按退避到点时间醒来，而不是空转轮询。 */
	let dueTimer = null
	function scheduleDue() {
		const next = earliestDue()
		if (next === null) return
		if (dueTimer) clearTimeout(dueTimer)
		dueTimer = setTimeout(() => {
			dueTimer = null
			wake()
		}, Math.max(0, next - now()))
		if (typeof dueTimer.unref === 'function') dueTimer.unref()
	}

	return {
		/**
		 * 入队一条命令。
		 *
		 * @param {string} kind send_c2c / send_media / recall_c2c / respond_interaction / publish_panel
		 * @param {object} args 命令参数
		 * @param {{expectAck?: boolean}} [options] expectAck 为真时调用方会 await 返回值里的 acked
		 * @returns {{id: string, acked: Promise<{ok:boolean, messageId?:string, error?:string}>}}
		 */
		enqueue(kind, args, { expectAck = false } = {}) {
			const command = { id: nextId(), kind, args }
			let resolve = () => {}
			const acked = new Promise((r) => {
				resolve = r
			})
			if (expectAck) waitersById.set(command.id, resolve)
			pending.push(command)
			wake()
			return { id: command.id, acked }
		},

		/** long-poll：有命令立刻返回，否则等到命令到来或 waitSeconds 到点。 */
		async poll({ waitSeconds = 25 } = {}) {
			releaseStale()
			const ready = drain()
			if (ready.length > 0) return ready

			const ms = Math.min(Math.max(Number(waitSeconds) || 0, 0), 300) * 1000
			// 有退避中的命令时，最多等到最早那条到点：既不空转，也不提前下发。
			const next = earliestDue()
			const waitMs = next === null ? ms : Math.min(ms, Math.max(0, next - now()))
			await new Promise((resolve) => {
				let timer = null
				const waiter = () => {
					if (timer) clearTimeout(timer)
					pollWaiters.delete(waiter)
					resolve()
				}
				pollWaiters.add(waiter)
				// waitSeconds=0 时也要立刻返回，不能干等（否则调用方永远挂住）。
				timer = setTimeout(waiter, waitMs)
				if (typeof timer.unref === 'function') timer.unref()
			})
			releaseStale()
			return drain()
		},

		/** 处理 Go 侧的 ack。 */
		ack({ id, ok, messageId, errorCode, error } = {}) {
			if (typeof id !== 'string' || !id) {
				logger?.warn?.('收到缺少 id 的 ack，忽略')
				return
			}
			const entry = inflight.get(id)
			if (!entry) {
				logger?.debug?.('收到未知命令的 ack（可能已超时重投）', { id, ok })
				return
			}
			inflight.delete(id)

			if (ok) {
				waitersById.get(id)?.({ ok: true, messageId })
				waitersById.delete(id)
				return
			}

			const kind = entry.command.kind
			const waiter = waitersById.get(id)
			waitersById.delete(id)
			const failure = { ok: false, error: error || `平台错误码 ${errorCode}`, errorCode }

			if (!RETRANSMIT_ON_FAILURE[kind]) {
				logger?.warn?.('出站命令执行失败（不重投）', { id, kind, errorCode, error })
				waiter?.(failure)
				return
			}

			const attempts = entry.command.attempts ?? 1
			if (!isTransientFailure({ errorCode, error }) || attempts >= MAX_ATTEMPTS) {
				// 硬错（参数/超限/权限）重试多少次都一样；次数用尽也不再重投。
				logger?.warn?.('出站命令失败且不再重试，丢弃', { id, kind, errorCode, error, attempts })
				waiter?.(failure)
				return
			}

			const delay = backoffMs(attempts)
			const retryId = nextId()
			logger?.warn?.('出站命令失败，退避后重试', { id, kind, errorCode, attempts, delayMs: delay, error })
			if (waiter) waitersById.set(retryId, waiter)
			pending.push({ ...entry.command, id: retryId, attempts: attempts + 1, notBefore: now() + delay })
			scheduleDue()
		},

		/** 队列里还有多少条（含在途）。 */
		depth() {
			return pending.length + inflight.size
		},

		/** 关闭：让所有在途等待者立刻拿到"未确认"，不挂在 await 上。 */
		dispose() {
			if (dueTimer) {
				clearTimeout(dueTimer)
				dueTimer = null
			}
			for (const [id, resolve] of waitersById) {
				resolve({ ok: false, error: '通道关闭，未确认送达' })
				waitersById.delete(id)
			}
			wake()
		},

		/** 仅供测试观察内部状态。 */
		_snapshot() {
			return {
				pending: pending.map((c) => ({ id: c.id, kind: c.kind, args: c.args })),
				inflight: [...inflight.keys()],
				waiters: [...waitersById.keys()],
			}
		},
	}
}
