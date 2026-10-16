/**
 * 只读「状态」快照（方案 A）：命令 `状态`（旧名 `进度` 仍认，见 commands.js 的 ALIASES）。
 *
 * 目标：**不打断正在跑的 AI**，也能知道它在干什么。
 * 做法：从会话事件日志里往回读（`session.eventAt`），摘出当前/最近一轮的关键信息：
 *   状态、轮次、已耗时、最近几个工具调用、最近一段 AI 文本；
 *   会话/模型/权限由调用方（index.js）读两条 durable 投影后传进来。
 *
 * 纪律：
 *   - **纯只读**：不 append、不 cancel、不发消息、不 resume（`agents.get` 拿不到就当"没有活跃 agent"）；
 *   - 扫描有上限（maxScan，默认 2000 条；reasoning/tool 事件很密，太小会读不到最近一段正文），
 *     绝不把整个会话读一遍；
 *   - 任何字段缺失都降级，不抛错（状态查不到不该影响主流程）。
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

/** 从 assistant/message 的 content 里取第一段文本（跳过 reasoning / tool-call）。 */
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
 * 从 assistant/message 的 content 里取第一段**思考**（dsh 里是 `reasoning` 块）。
 *
 * 为什么要单独摘：用户看进度时想区分"它在想什么"和"它说出来了什么"——
 * 以前只有一段"最近一段输出"，实际经常是 reasoning（看起来像正文，其实不是）。
 * 兼容旧字段名：个别版本/适配器写的是 `thinking`，也认。
 */
export function extractAssistantReasoning(message) {
	const content = Array.isArray(message?.content) ? message.content : []
	for (const block of content) {
		if ((block?.type === 'reasoning' || block?.type === 'thinking') && typeof block.text === 'string' && block.text.trim()) {
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
 *   lastText: string, lastReasoning: string, latestStep: number|null,
 *   lastTextStep: number|null, lastReasoningStep: number|null,
 *   textStepsBehind: number|null, reasoningStepsBehind: number|null,
 *   lastEventAgoMs: number|null, scanned: number
 * }}
 */
export function snapshotProgress(agent, { now = Date.now, maxScan = 2000 } = {}) {
	const nowMs = typeof now === 'function' ? Number(now()) : Number(now)
	const snapshot = {
		status: String(agent?.status ?? 'unknown'),
		midTurn: false,
		turn: null,
		startedAt: null,
		elapsedMs: null,
		actions: [],
		lastText: '',
		lastReasoning: '',
		latestStep: null,
		lastTextStep: null,
		lastReasoningStep: null,
		textStepsBehind: null,
		reasoningStepsBehind: null,
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
		// 步号（`step/start` 与 `assistant/message` / `tool/call` 都带）：用来回答
		// "这段正文是几步之前写的"。
		const step = typeof event.data?.step === 'number' ? event.data.step : null
		if (step !== null && sameTurn) {
			snapshot.latestStep = snapshot.latestStep === null ? step : Math.max(snapshot.latestStep, step)
		}

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
		if (event.type === 'assistant/message' && sameTurn) {
			if (!snapshot.lastText) {
				snapshot.lastText = extractAssistantText(event.data?.message)
				if (snapshot.lastText) snapshot.lastTextStep = step
			}
			if (!snapshot.lastReasoning) {
				snapshot.lastReasoning = extractAssistantReasoning(event.data?.message)
				if (snapshot.lastReasoning) snapshot.lastReasoningStep = step
			}
		}
	}

	if (snapshot.latestStep !== null && snapshot.lastTextStep !== null) {
		snapshot.textStepsBehind = Math.max(0, snapshot.latestStep - snapshot.lastTextStep)
	}
	if (snapshot.latestStep !== null && snapshot.lastReasoningStep !== null) {
		snapshot.reasoningStepsBehind = Math.max(0, snapshot.latestStep - snapshot.lastReasoningStep)
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

/** 「第 N 步」标注（拿不到步号就不标）。 */
function stepTag(step) {
	return Number.isFinite(step) ? `（第 ${step} 步）` : ''
}

/**
 * 一段输出的步号标注：除"第几步"外，还要写清**距最新步骤隔了多少步**。
 * 例：`（第 9 步，距最新第 14 步隔 5 步）`；当它就是最新一步时写「就是最新一步」。
 *
 * 思考与正文**用同一套措辞**（用户反馈）：线上同时看到「思考（第 95 步）」和
 * 「正文（第 95 步，距最新第 100 步隔 5 步）」，像两段打架 —— 其实两段都是第 95 步
 * 的输出，只是当时只有正文标了距离（那 5 步是正在跑的步骤/纯工具步骤，还没新输出）。
 */
function stepDistanceTag(step, snapshot) {
	if (!Number.isFinite(step)) return ''
	const latest = Number.isFinite(snapshot?.latestStep) ? snapshot.latestStep : null
	if (latest === null) return `（第 ${step} 步）`
	const behind = Math.max(0, latest - step)
	if (behind === 0) return `（第 ${step} 步，就是最新一步）`
	return `（第 ${step} 步，距最新第 ${latest} 步隔 ${behind} 步）`
}

/**
 * 渲染成 QQ 可用的 markdown（只用标题/引用/列表，绝不用表格）。
 *
 * 用户要求（2026-10-16）：标题从「进度快照」改成「**状态**」（命令也从 `进度` 改成 `状态`），
 * 抬头**带上这个会话用的是哪个模型、当前权限**，并**去掉原来的「说明：只读查询…」那一行**；
 * 再把 dsh web 会话底部那块「统计」搬进来（见 `statsLines`），位置放在抬头之后
 * （都是短数字，凑成一眼能看完的概览；长的动作/输出 excerpts 留在后面）。
 *
 * @param {object} input
 * @param {string} input.label 会话显示名（标题(会话id)）
 * @param {string} [input.sessionId] 兜底显示
 * @param {object|null} [input.snapshot] `snapshotProgress(agent)` 的结果；**没有活 agent 时传 null**
 * @param {{provider:string, model:string, source?:'selection'|'log'|'default'}|null} [input.model]
 *   会话当前模型（`models.effective()` 的结果；读不到就 null）。`source='default'` 时会注明
 *   "部署默认" —— 那是"这个会话以后会用哪个"的预测，不是它自己选过的。
 * @param {string} [input.permission] 会话当前权限的显示名（读不到就空串）
 * @param {object|null} [input.stats] `createSessionStats().read()` 的结果（四个投影，缺就是 null）
 */
export function renderProgress({
	label,
	snapshot = null,
	sessionId,
	model = null,
	permission = '',
	stats = null,
}) {
	// 「几秒前」按**采样时刻**算，而不是渲染时刻：渲染可能晚很多，口径要一致。
	const takenAt = Number.isFinite(snapshot?.takenAt) ? snapshot.takenAt : Date.now()
	const modelText =
		model?.provider && model?.model
			? `${model.provider} / ${model.model}${model.source === 'default' ? '（部署默认）' : ''}`
			: '（读不到）'
	const lines = [
		'**状态**',
		`> 会话：${label ?? sessionId}`,
		`> 模型：${modelText}`,
		`> 权限：${permission || '（读不到）'}`,
		`> 状态：${describeStatus(snapshot)}`,
		...statsLines(stats),
	]
	if (!snapshot) {
		lines.push('', '（这个会话现在没有活着的 agent，下面是空的；发一条消息就能让它跑起来。）')
		return lines.join('\n')
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
	// 两段分开（用户要求）：想的是「最近一段思考」，说出来的是「最近一段正文」；
	// **两段都标**"距最新步骤隔了多少步"，这样同一轮里可以直接对比、不会看着像打架。
	if (snapshot.lastReasoning) {
		lines.push('', `**最近一段思考${stepDistanceTag(snapshot.lastReasoningStep, snapshot)}**`, `> ${snapshot.lastReasoning}`)
	}
	if (snapshot.lastText) {
		lines.push('', `**最近一段正文${stepDistanceTag(snapshot.lastTextStep, snapshot)}**`, `> ${snapshot.lastText}`)
	}
	if (!snapshot.lastReasoning && !snapshot.lastText && snapshot.scanned > 0) {
		lines.push('', '最近还没有模型输出（可能刚起轮次或在跑工具）。')
	}
	if (snapshot.scanned === 0) lines.push('', '（会话里还没有可读的事件）')
	return lines.join('\n')
}

function describeStatus(snapshot) {
	if (!snapshot) return '没有活跃的 agent（这一轮没在跑）'
	if (snapshot.midTurn) {
		const elapsed = formatElapsed(snapshot.elapsedMs)
		const turn = snapshot.turn === null ? '' : `第 ${snapshot.turn} 轮，`
		return `运行中（${turn}已跑 ${elapsed || '未知时长'}）`
	}
	if (snapshot.status === 'running') return 'agent 标记为运行中，但没读到当前轮次'
	return '空闲（没在跑，下面是最近一轮的情况）'
}

// ── 「统计」一节：把 dsh web 会话底部那块统计搬进 QQ（用户要求） ──────────────
//
// 数据来自四个会话投影（见 lib/session-stats.js）：`sessionStats`（用时/TTFT/TPS）、
// `tokenUsage`（Token 用量与缓存）、`contextBreakdown`（上下文构成）、
// `contextPressure`（上下文窗口占用）。**缺哪块就少哪行**：四块全缺就不出这一节
// （读不到没必要占位），单个字段为 0 也省略（省得满屏 0）。

/** 毫秒 → 人话时长：≥1 小时写「N 小时 M 分」，否则「M 分 S 秒」/「S 秒」。 */
function formatDuration(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return '0 秒'
	const total = Math.round(ms / 1000)
	const hours = Math.floor(total / 3600)
	const minutes = Math.floor((total % 3600) / 60)
	const seconds = total % 60
	if (hours > 0) return `${hours} 小时 ${minutes} 分`
	if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
	return `${seconds} 秒`
}

/** 毫秒 → 「8.6 秒」（首 token 平均用）。 */
function formatSeconds(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return ''
	const seconds = ms / 1000
	return `${seconds >= 100 ? Math.round(seconds) : Number(seconds.toFixed(1))} 秒`
}

/** 去掉小数点后多余的 0（`369.0K` → `369K`，`1.00M` → `1M`）。 */
function trimZero(text) {
	return text.replace(/\.?0+$/, '')
}

/**
 * token 数 → 紧凑写法（电话上看数字更友好）：
 * `929074071` → `929.07M`、`10314436` → `10.31M`、`4500` → `4.5K`。
 * 精确值在 dsh web 的统计面板里。
 */
function formatTokens(count) {
	const value = Number(count)
	if (!Number.isFinite(value) || value < 0) return ''
	if (value >= 1e9) return `${trimZero((value / 1e9).toFixed(2))}B`
	if (value >= 1e6) return `${trimZero((value / 1e6).toFixed(2))}M`
	if (value >= 1e3) return `${trimZero((value / 1e3).toFixed(1))}K`
	return String(Math.round(value))
}

/** tok/s：输出 token ÷ 解码耗时。 */
function formatTps(tokens, ms) {
	if (!Number.isFinite(tokens) || tokens <= 0) return ''
	if (!Number.isFinite(ms) || ms <= 0) return ''
	return `${Math.round(tokens / (ms / 1000))} tok/s`
}

/** 是不是一个"有意义的正数"（0／null／NaN 都不算）。 */
function positive(value) {
	return Number.isFinite(value) && value > 0
}

/**
 * 「统计」一节的行（含前面的空行与 `**统计**` 标题）；没有任何数据时返回空数组。
 * @param {object|null} stats `createSessionStats().read()` 的结果
 * @returns {string[]}
 */
function statsLines(stats) {
	if (!stats) return []
	const s = stats.sessionStats ?? null
	const usage = stats.tokenUsage ?? null
	const breakdown = stats.contextBreakdown ?? null
	const pressure = stats.contextPressure ?? null
	const rows = []
	const push = (parts) => {
		const text = parts.filter(Boolean).join(' ｜ ')
		if (text) rows.push(`> ${text}`)
	}

	// 1) 用时：模型用时（llmMs）/ 工具调用用时（toolMs）
	push([
		positive(s?.llmMs) ? `模型用时 ${formatDuration(s.llmMs)}` : '',
		positive(s?.toolMs) ? `工具调用 ${formatDuration(s.toolMs)}` : '',
	])

	// 2) 速度：首 token 平均（ttftMs/ttftSteps）/ 输出速度（decodeTokens/decodeMs）
	const ttft = positive(s?.ttftMs) && positive(s?.ttftSteps) ? formatSeconds(s.ttftMs / s.ttftSteps) : ''
	const tps = formatTps(s?.decodeTokens, s?.decodeMs)
	push([ttft ? `首 token 平均 ${ttft}` : '', tps ? `输出速度 ${tps}` : ''])

	// 3) Token 用量（未缓存输入 + 缓存读取 + 缓存写入 + 输出）与缓存命中率
	if (usage) {
		const uncached = Number(usage.uncachedInputTokens) || 0
		const cacheRead = Number(usage.cacheReadTokens) || 0
		const cacheWrite = Number(usage.cacheWriteTokens) || 0
		const output = Number(usage.outputTokens) || 0
		const input = uncached + cacheRead + cacheWrite
		const total = input + output
		const hit = input > 0 ? Math.round((cacheRead / input) * 100) : null
		push([
			positive(total) ? `Token 用量 ${formatTokens(total)}` : '',
			hit === null ? '' : `缓存命中 ${hit}%`,
		])
		push([
			positive(uncached) ? `未缓存输入 ${formatTokens(uncached)}` : '',
			positive(cacheRead) ? `缓存读取 ${formatTokens(cacheRead)}` : '',
			positive(cacheWrite) ? `缓存写入 ${formatTokens(cacheWrite)}` : '',
			positive(output) ? `输出 ${formatTokens(output)}` : '',
		])
	}

	// 4) 上下文已用（占用 ÷ 模型窗口）与构成
	const window = Number(pressure?.contextWindow) || 0
	const usedRaw = Number(pressure?.projectedTokens ?? pressure?.pressureTokens)
	if (positive(window) && Number.isFinite(usedRaw) && usedRaw >= 0) {
		push([`上下文已用 ${Math.round((usedRaw / window) * 100)}%（~${formatTokens(usedRaw)} / ${formatTokens(window)}）`])
	} else if (positive(window) && breakdown) {
		const used =
			(Number(breakdown.systemTokens) || 0) + (Number(breakdown.toolsTokens) || 0) + (Number(breakdown.messageTokens) || 0)
		if (positive(used)) push([`上下文已用 ${Math.round((used / window) * 100)}%（~${formatTokens(used)} / ${formatTokens(window)}）`])
	}
	if (breakdown) {
		push([
			positive(breakdown.systemTokens) ? `系统提示词 ${formatTokens(breakdown.systemTokens)}` : '',
			positive(breakdown.toolsTokens) ? `工具定义 ${formatTokens(breakdown.toolsTokens)}` : '',
			positive(breakdown.messageTokens) ? `对话消息 ${formatTokens(breakdown.messageTokens)}` : '',
		])
	}

	if (rows.length === 0) return []
	return ['', '**统计**', ...rows]
}
