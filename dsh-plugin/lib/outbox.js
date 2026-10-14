/**
 * 出站命令队列。
 *
 * 与 Go 网关之间的语义（docs/protocol.md 第 4-5 节）：
 *   - 命令按 id 下发，Go 侧执行完必须 ack；
 *   - 长时间没 ack 的命令会被重新下发（at-least-once），由 Go 侧按 id 去重；
 *   - ack ok:false 表示"这次没成功"，命令回到队列作为一次重试机会。
 */

/** 失败后是否值得重投。撤回是尽力而为，重投没有意义。 */
const RETRANSMIT_ON_FAILURE = {
	send_c2c: true,
	send_media: true,
	respond_interaction: true,
	recall_c2c: false,
	publish_panel: false,
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

	/** 把待下发命令交给客户端。 */
	function drain() {
		const ready = pending.splice(0, pending.length)
		for (const command of ready) {
			inflight.set(command.id, { command, since: now() })
		}
		return ready.map(({ id, kind, args }) => ({ id, kind, args }))
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
			await new Promise((resolve) => {
				let timer = null
				const waiter = () => {
					if (timer) clearTimeout(timer)
					pollWaiters.delete(waiter)
					resolve()
				}
				pollWaiters.add(waiter)
				// waitSeconds=0 时也要立刻返回，不能干等（否则调用方永远挂住）。
				timer = setTimeout(waiter, ms)
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

			if (RETRANSMIT_ON_FAILURE[kind]) {
				logger?.warn?.('出站命令执行失败，重新排队重试', { id, kind, errorCode, error })
				const retryId = nextId()
				if (waiter) waitersById.set(retryId, waiter)
				pending.push({ ...entry.command, id: retryId })
				wake()
				return
			}
			logger?.warn?.('出站命令执行失败（不重投）', { id, kind, errorCode, error })
			waiter?.({ ok: false, error: error || `平台错误码 ${errorCode}` })
		},

		/** 队列里还有多少条（含在途）。 */
		depth() {
			return pending.length + inflight.size
		},

		/** 关闭：让所有在途等待者立刻拿到"未确认"，不挂在 await 上。 */
		dispose() {
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
