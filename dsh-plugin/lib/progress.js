/**
 * 只读进度快照（方案 A）。
 *
 * 目标：**不打断正在跑的 AI**，也能知道它在干什么。
 * 做法：从会话事件日志里往回读（`session.eventAt`），摘出当前/最近一轮的关键信息：
 *   状态、轮次、已耗时、最近几个工具调用、最近一段 AI 文本。
 *
 * 纪律：
 *   - **纯只读**：不 append、不 cancel、不发消息、不 resume（`agents.get` 拿不到就当"没有活跃 agent"）；
 *   - 扫描有上限（maxScan），绝不把整个会话读一遍；
 *   - 任何字段缺失都降级，不抛错（进度查不到不该影响主流程）。
 */

/** 每条动作/文本最多截断到这个长度。 */
const SUMMARY_LIMIT = 60
const TEXT_LIMIT = 140

function clip(text, limit) {
	const flat = String(text ?? '')
		.replace(/\s+/g, ' ')
		.trim()
	if (!flat) return ''
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/** 把工具参数压成一句人类可读的摘要（认不出来就给前几个键）。 */
export function summarizeToolArgs(rawArguments) {
	if (typeof rawArguments !== 'string' || !rawArguments.trim()) return ''
	let args
	try {
		args = JSON.parse(rawArguments)
	} catch {
		return clip(rawArguments, SUMMARY_LIMIT)
	}
	if (!args || typeof args !== 'object') return clip(String(args), SUMMARY_LIMIT)
	const pick =
		args.command ??
		args.file_path ??
		args.path ??
		args.url ??
		args.query ??
		args.pattern ??
		args.content ??
		Object.values(args).find((value) => typeof value === 'string')
	return clip(pick, SUMMARY_LIMIT)
}

/** 从 assistant/message 的 content 里取第一段文本（跳过 reasoning）。 */
export function extractAssistantText(message) {
	const content = Array.isArray(message?.content) ? message.content : []
	for (const block of content) {
		if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
			return clip(block.text, TEXT_LIMIT)
		}
	}
	return ''
}

/**
 * 采一份快照。纯读事件，不改任何状态。
 *
 * `now` 既接受时间戳（测试用），也接受取时间的函数（默认就是 `Date.now`）。
 * 线上踩过：默认参数是函数却被当成时间戳用，`Date.now - startedAt` 直接算出
 * NaN，进度里显示成「已跑 NaN 分 NaN 秒」；单测都显式传数字，正好漏掉默认分支。
 *
 * @param {{status?:string, session?:object}|null} agent
 * @returns {{
 *   status: string, midTurn: boolean, turn: number|null, startedAt: number|null,
 *   elapsedMs: number|null, actions: Array<{name:string,args:string,at:number|null}>,
 *   lastText: string, lastEventAgoMs: number|null, scanned: number
 * }}
 */
export function snapshotProgress(agent, { now = Date.now, maxScan = 800 } = {}) {
	const nowMs = typeof now === 'function' ? Number(now()) : Number(now)
	const snapshot = {
		status: String(agent?.status ?? 'unknown'),
		midTurn: false,
		turn: null,
		startedAt: null,
		elapsedMs: null,
		actions: [],
		lastText: '',
		lastEventAgoMs: null,
		scanned: 0,
		takenAt: Number.isFinite(nowMs) ? nowMs : null,
	}
	const session = agent?.session
	if (!session || typeof session.seq !== 'number' || typeof session.eventAt !== 'function') {
		return snapshot
	}

	const end = session.seq - 1
	const floor = Math.max(0, end - maxScan)
	let turnBoundarySeen = false
	let lastEventTime = null

	for (let i = end; i >= floor; i -= 1) {
		const event = session.eventAt(i)
		if (!event) continue
		snapshot.scanned += 1
		if (typeof event.time === 'number' && lastEventTime === null) lastEventTime = event.time
		const turn = event.data?.turn ?? null
		const sameTurn = snapshot.turn === null || turn === null || turn === snapshot.turn

		if (!turnBoundarySeen && (event.type === 'turn/end' || event.type === 'turn/start')) {
			turnBoundarySeen = true
			snapshot.midTurn = event.type === 'turn/start'
		}
		if (event.type === 'turn/start' && snapshot.turn === null) {
			snapshot.turn = turn
			snapshot.startedAt = typeof event.time === 'number' ? event.time : null
		}
		if (event.type === 'tool/call' && snapshot.actions.length < 3 && sameTurn) {
			snapshot.actions.push({
				name: String(event.data?.name ?? ''),
				args: summarizeToolArgs(event.data?.arguments),
				at: typeof event.time === 'number' ? event.time : null,
			})
		}
		if (!snapshot.lastText && event.type === 'assistant/message' && sameTurn) {
			snapshot.lastText = extractAssistantText(event.data?.message)
		}
	}

	if (snapshot.startedAt !== null && Number.isFinite(nowMs)) {
		snapshot.elapsedMs = Math.max(0, nowMs - snapshot.startedAt)
	}
	if (lastEventTime !== null && Number.isFinite(nowMs)) {
		snapshot.lastEventAgoMs = Math.max(0, nowMs - lastEventTime)
	}
	return snapshot
}

const formatAgo = (ms) => {
	if (!Number.isFinite(ms)) return ''
	if (ms < 1000) return '刚刚'
	if (ms < 60_000) return `${Math.round(ms / 1000)} 秒前`
	return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒前`
}

const formatElapsed = (ms) => {
	// 有限性守卫：宁可说「未知时长」，也绝不把 NaN 印到用户面前。
	if (!Number.isFinite(ms)) return ''
	if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`
	return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`
}

/** 渲染成 QQ 可用的 markdown（只用标题/引用/列表，绝不用表格）。 */
export function renderProgress({ label, snapshot, sessionId }) {
	// 「几秒前」按**采样时刻**算，而不是渲染时刻：渲染可能晚很多，口径要一致。
	const takenAt = Number.isFinite(snapshot?.takenAt) ? snapshot.takenAt : Date.now()
	const lines = ['**进度快照**', `> 会话：${label ?? sessionId}`, `> 状态：${describeStatus(snapshot)}`]
	if (snapshot.midTurn) {
		lines.push('> 说明：只读查询，**没有打断它**（AI 还在继续跑）')
	} else {
		lines.push('> 说明：当前没有在跑的轮次，下面是最近一轮的情况')
	}
	if (snapshot.actions.length === 0) {
		lines.push('', '最近还没有工具调用记录。')
	} else {
		lines.push('', '**最近动作**（从新到旧）')
		for (const action of snapshot.actions) {
			const at = Number.isFinite(action?.at) ? action.at : null
			const ago = formatAgo(at === null ? null : takenAt - at)
			lines.push(`- ${action.name}${action.args ? `：${action.args}` : ''}${ago ? `（${ago}）` : ''}`)
		}
	}
	if (snapshot.lastText) {
		lines.push('', '**最近一段输出**', `> ${snapshot.lastText}`)
	}
	if (snapshot.scanned === 0) lines.push('', '（会话里还没有可读的事件）')
	return lines.join('\n')
}

function describeStatus(snapshot) {
	if (snapshot.midTurn) {
		const elapsed = formatElapsed(snapshot.elapsedMs)
		const turn = snapshot.turn === null ? '' : `第 ${snapshot.turn} 轮，`
		return `运行中（${turn}已跑 ${elapsed || '未知时长'}）`
	}
	if (snapshot.status === 'running') return 'agent 标记为运行中，但没读到当前轮次'
	return '空闲'
}
