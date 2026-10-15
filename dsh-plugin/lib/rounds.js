/**
 * 轮次跟踪：结束通知、被动回复上下文、延迟发送、以及"用户级上下文"的每轮注入。
 *
 * 判定"这一轮 AI 是否回复过"用的是 dsh 的**持久会话事件**，而不是超时猜测：
 *   - session/event 的 turn/start / turn/end / tool/call（dsh-headless 也是这么结算的）；
 *   - 本轮没回复**不再自动催促**：由用户在「…已结束」通知上点「我需要回复」触发。
 */
import { buildNoticeCard } from './cards.js'
import { REPLY_TOOL_NAME } from './reply-tool.js'

/**
 * plan 模式下模型提交计划的工具名。
 *
 * 取自 `@deepseek-ai/dsh-plan-mode` 的 `EXIT_PLAN_MODE`；它**始终注册**
 * （文档写明"stays registered while plan mode is inactive"），所以不能靠"工具在不在"判断是否在 plan 模式。
 */
export const PLAN_TOOL_NAME = 'exit_plan_mode'

/**
 * 互动回应码（平台固定语义，**别随手改**）：
 *   0 成功（按钮变「已触发」，此后不可再点）
 *   1 失败（按钮保持可点，可重试）
 *   2 操作太频繁 ← 客户端会直接弹「操作太频繁」，别拿它当"忙"
 *   3 重复操作   4 没有权限   5 仅管理员可操作
 */
export const INTERACTION_CODES = {
	success: 0,
	failed: 1,
	tooFrequent: 2,
	duplicate: 3,
	noPermission: 4,
	adminOnly: 5,
}

/**
 * 这一轮是不是 **QQ 用户发起**的：直接投递的（`qq`）或延迟投递的（`delayed`）。
 *
 * 延迟投递就是"用户那条消息，只是等这一轮正常结束才交出去"，所以它和直接投递一样得
 * ①注入 QQ 上下文（否则模型不知道这条来自 QQ、不知道该用 `qq_reply` 回话）
 * ②发结束/被打断通知（否则用户看不到结果）。
 * 只有 `origin` 用于区分"什么时候投的"（日志、排查），不该用它区分"算不算 QQ 的一轮"。
 */
function fromQqUser(round) {
	return round?.origin === 'qq' || round?.origin === 'delayed'
}

export function createRounds({
	state,
	sessions,
	outbox,
	config,
	logger,
	userMessage,
	contextMessage,
	agentFor,
	onDeliver,
	onPlan,
	sendCommand,
	nextSeqFor,
	// 可选：把关键判断记进状态文件（插件日志进不了 journald，线上只有这个出口）。
	note,
}) {
	const rounds = new Map()
	const journal = (text) => {
		try {
			note?.(text)
		} catch {
			// 记账失败绝不影响主流程
		}
	}
	/** 收到过几个会话事件：只在小日志里留前几条，作为"事件到底来没来"的证据。 */
	let observedEvents = 0

	function currentRound(sessionId) {
		return rounds.get(sessionId) ?? null
	}

	/**
	 * 开一轮：会顶替掉上一轮。
	 *
	 * 被顶替 = 被打断：给上一轮补一条「被打断」通知，并尽量带上打断它的那条消息
	 * （interruptSource 拿不到就不带引用行，照样提示被打断）。
	 */
	function beginRound({ sessionId, openid, origin = 'qq', context = {}, pendingContext = null, interruptSource = '' }) {
		const previous = rounds.get(sessionId)
		if (previous) {
			previous.superseded = true
			if (previous.fallbackTimer) clearTimeout(previous.fallbackTimer)
			notifyInterrupted(previous, interruptSource)
		}
		const round = {
			sessionId,
			openid,
			origin,
			context: { msgId: context.msgId ?? '', eventId: context.eventId ?? '' },
			turn: null,
			seq: 0,
			replied: false,
			superseded: false,
			stopped: false,
			ended: false,
			pendingContext,
			contextTurn: null,
			fallbackTimer: null,
			startedAt: Date.now(),
		}
		rounds.set(sessionId, round)
		journal(`轮次开始：${sessionId.slice(-8)} origin=${origin} openid=${openid ? '有' : '无'}`)
		return round
	}

	/**
	 * 兜底：等 agent **真的跑起来再空下来**，然后从会话日志里读这一轮的结束原因并收尾。
	 *
	 * 为什么还要这一条：线上踩过"完成通知不发了"——`session/event` 监听在某些情况下
	 * 收不到（agent 实例被换、或事件派发范围变了），而 `turn/end` 是"已结束"通知的
	 * 唯一依据。`agent.whenIdle()` 是 Agent 的一等 API、不依赖事件订阅；结合
	 * `agent.session.events`（durable log，里面有 turn/end 与它的 reason），
	 * 即使事件监听全聋，也能得出正确的"已结束 / 被打断"。
	 *
	 * **必须先等它跑起来**（线上又踩一次）：刚 followup 完 agent 还是 idle，
	 * 直接 `whenIdle()` 会**立刻结算**，于是新轮次在 3 秒内被判成"被打断"并收尾，
	 * 而这一轮其实跑了 37 分钟才正常结束 —— 「已结束」从此永远发不出来。
	 *
	 * 与事件路径幂等：先到的那个收尾，后到的看到 `round.ended` 直接返回。
	 */
	async function watchIdle(agent, sessionId) {
		if (!agent || typeof agent.whenIdle !== 'function') return
		const round = currentRound(sessionId)
		if (!round) return
		// 等它真的开始跑（status=running）再等 idle。等不到就算了：宁可漏报，也不误报"被打断"。
		const started = await waitForRunning(agent, sessionId, round)
		if (!started) {
			journal(`whenIdle 放弃：没等到它跑起来（${sessionId.slice(-8)}）`)
			return
		}
		try {
			await agent.whenIdle()
		} catch {
			return // 被取消/抛错：交给事件路径或下一次投递
		}
		const latest = currentRound(sessionId)
		if (!latest || latest.ended || latest !== round) return
		const ended = endedTurnFromLog(agent, round)
		journal(
			`whenIdle 兜底收尾：${ended ? `日志显示 turn=${ended.turn} reason=${ended.reason}` : '日志里没读到结束（按未知收尾）'}（${sessionId.slice(-8)}）`,
		)
		void finishRound(sessionId, {
			reason: ended?.reason ?? 'unknown',
			error: ended?.error ?? '',
			turn: ended?.turn ?? round.turn ?? undefined,
			from: 'whenIdle',
		})
	}

	/** 轮询等 agent 进入 running（最多 `runningWaitMs`），异常/被顶替都算放弃。 */
	async function waitForRunning(agent, sessionId, round) {
		const limit = Math.max(1000, Number(config.runningWaitMs) || 60_000)
		const pollMs = Math.max(5, Number(config.runningPollMs) || 500)
		const deadline = Date.now() + limit
		while (Date.now() < deadline) {
			if (round.ended || currentRound(sessionId) !== round) return false
			if (agent.status === 'running') return true
			await sleep(pollMs)
		}
		return false
	}

	/** 可被打断的睡眠（定时器 unref，不拖住进程退出）。 */
	function sleep(ms) {
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, ms)
			if (typeof timer.unref === 'function') timer.unref()
		})
	}

	/**
	 * 从会话日志里确认**我认领的这一轮**是否已经结束：结束返回 `{turn, reason, error}`，没结束返回 null。
	 *
	 * 为什么不能只看"agent 空闲了"：上一轮被顶替（aborted）时也会先来一次 idle，
	 * 而新轮次此时刚建好（甚至刚认领了 turn）——把这次 idle 当收尾就会误报"被打断"，
	 * 并且把这一轮后面真正的 turn/end 吃掉（round.ended 了就不再处理）。
	 */
	function endedTurnFromLog(agent, round) {
		try {
			const events = agent?.session?.events ?? []
			for (let i = events.length - 1; i >= 0; i -= 1) {
				const event = events[i]
				if (event?.type !== 'turn/end') continue
				const turn = typeof event.data?.turn === 'number' ? event.data.turn : null
				const reason = event.data?.reason?.kind ?? 'unknown'
				const error = errorTextOf(event)
				if (round.turn !== null && round.turn !== undefined) {
					// 只有"我这一轮或更靠后"的 turn/end 才算我结束了
					return turn !== null && turn >= round.turn ? { turn, reason, error } : null
				}
				// 还没认领过轮次：只认"本轮开始之后"的结束，避免把上一轮的收尾算进来
				if (typeof event.time === 'number' && typeof round.startedAt === 'number') {
					return event.time >= round.startedAt ? { turn: turn ?? undefined, reason, error } : null
				}
				return { turn: turn ?? undefined, reason, error }
			}
		} catch {
			// 读日志失败：当作"还没结束"，宁可漏报也不误报
		}
		return null
	}

	/**
	 * 标记"用户显式停止"：这也算被打断（不是正常结束），所以立刻发一条「被打断」通知。
	 * source 一般是那条停止动作（QQ 命令原文 / GUI 取消）。
	 */
	function markStopped(sessionId, source = '') {
		const round = rounds.get(sessionId)
		if (!round) return
		round.stopped = true
		notifyInterrupted(round, source)
	}

	/**
	 * `turn/end` 的 `reason=error` 里那段**具体报错**（其它 reason 返回空串）。
	 *
	 * 形状（dsh 的 TurnEndReasonMap）：`{ kind: 'error', error: { message, code } }`。
	 * 用户要求：出错的通知要带上它 —— 只说"被打断"看不出出什么事。
	 */
	function errorTextOf(event) {
		const reason = event?.data?.reason
		if (reason?.kind !== 'error') return ''
		const failure = reason.error ?? {}
		const text = failure.message ?? failure.code ?? ''
		return typeof text === 'string' ? text.trim() : ''
	}

	/** 发一条结束/被打断通知（按 会话+轮次 去重）。 */
	function enqueueNotice(round, { interrupted = false, source = '', error = '' } = {}) {
		if (!round || !fromQqUser(round) || !round.openid) {
			journal(`通知跳过：不是 QQ 用户发起的一轮或没 openid（${round?.sessionId ?? '?'}）`)
			return
		}
		const key = `${round.sessionId}:${round.turn ?? round.startedAt}`
		if (state.noticeSeen(key)) {
			journal(`通知跳过：这个轮次已发过（${key.slice(-12)}）`)
			return
		}
		const card = buildNoticeCard({
			label: sessions.label(round.sessionId),
			sessionId: round.sessionId,
			interrupted,
			error,
			source,
			sendCommand,
		})
		outbox.enqueue('send_c2c', {
			openid: round.openid,
			markdown: true,
			content: card.content,
			keyboard: card.keyboard,
			replyToMsgId: round.context.msgId ?? '',
			replyToEventId: round.context.eventId ?? '',
			msgSeq: nextSeq(round.sessionId),
		})
		state.markNotice(key)
		const kind = error ? '出现错误' : interrupted ? '被打断' : '已结束'
		journal(`通知已入队：${kind} turn=${round.turn ?? '?'}（${key.slice(-12)}）${error ? ` :: ${error.slice(0, 120)}` : ''}`)
		logger?.info?.(`已发通知：${kind}`, {
			sessionId: round.sessionId,
			hasSource: Boolean(source),
			error: error.slice(0, 200),
		})
	}

	/** 被打断（被新消息顶替 / 用户显式停止）：立刻通知，并尽量带上打断来源。 */
	function notifyInterrupted(round, source = '') {
		if (!round || round.ended) return
		round.ended = true
		if (round.fallbackTimer) {
			clearTimeout(round.fallbackTimer)
			round.fallbackTimer = null
		}
		enqueueNotice(round, { interrupted: true, source })
	}

	const currentContext = (sessionId) => currentRound(sessionId)?.context ?? { msgId: '', eventId: '' }

	function nextSeq(sessionId) {
		// 统一由 index.js 提供的计数器发号：同一个 msg_id 下的所有被动回复
		// 共用一个递增序号，避免平台按 msg_id+msg_seq 去重把消息吞掉。
		if (typeof nextSeqFor === 'function') return nextSeqFor(sessionId)
		const round = currentRound(sessionId)
		if (!round) return 1
		round.seq += 1
		return round.seq
	}

	function pendingInjectText(sessionId) {
		const round = currentRound(sessionId)
		if (!fromQqUser(round)) return null
		return round.pendingContext ?? null
	}

	function roundContextText(round) {
		return [
			`这条消息来自 QQ 私信（对方 openid：${round.openid}），会话：${sessions.label(round.sessionId)}。`,
			`要回复用户请调用 \`${REPLY_TOOL_NAME}\` 工具（markdown 开关默认 ${config.defaultMarkdown ? 'true' : 'false'}）。`,
			'每条回复会自动带上这条来自哪个会话的标注；完成时请尽可能详细地回复用户，过程中的进度也可以用它汇报。',
		].join('\n')
	}

	/** 每轮把 QQ 侧的用户级上下文注入进会话（dsh 自带的插件注入机制）。 */
	function attachAgent(agent, sessionId) {
		const disposers = []
		const on = (name, handler, options) => {
			try {
				disposers.push(agent.ctx.on(name, handler, options))
			} catch (error) {
				logger?.warn?.('在 agent 作用域注册监听失败', { name, error: String(error) })
			}
		}

		on(
			'agent/pre-step',
			async (payload, next) => {
				const decision = await next()
				if (decision?.kind === 'reject' || payload?.signal?.aborted) return decision
				const round = currentRound(sessionId)
				if (!fromQqUser(round)) return decision
				if (round.contextTurn === payload.turn) return decision
				const text = round.pendingContext
				if (!text) return decision
				round.contextTurn = payload.turn
				return { ...decision, messages: [...decision.messages, contextMessage(text)] }
			},
			true,
		)

		on('session/event', (session, event) => observe(sessionId, event, 'agent'))
		on('agent/status', ({ status }) => {
			if (status !== 'idle') return
			const round = currentRound(sessionId)
			if (!round || round.ended) return
			// 兜底：turn/end 因异常路径没到，也要给用户一个收尾信号。
			//
			// **但"空闲"不等于"我这一轮结束了"**（线上事故 2026-10-15）：
			// 上一轮被顶替（aborted）时 agent 会先报一次 idle，而此刻新轮次刚建好、
			// 甚至刚认领 turn —— 3 秒后按"未知原因"收尾 → 误报「被打断」，
			// 然后这一轮真跑到 37 分钟后正常结束，**「已结束」永远发不出来**。
			// 所以收尾前必须回读会话日志，确认我认领的那一轮真的出现过 turn/end；
			// 而且要用日志里的**真实 reason**，不能再一律写 unknown。
			if (round.fallbackTimer) clearTimeout(round.fallbackTimer)
			const delay = Math.max(500, Number(config.noticeFallbackMs) || 3000)
			round.fallbackTimer = setTimeout(() => {
				const latest = currentRound(sessionId)
				if (!latest || latest.ended || latest !== round) return
				const ended = endedTurnFromLog(agent, round)
				if (!ended) {
					journal(`忽略 idle 兜底：日志里这一轮还没结束（turn=${round.turn ?? '?'}，${sessionId.slice(-8)}）`)
					return
				}
				journal(`兜底收尾：agent 已 idle 且日志里 turn=${ended.turn} 已结束（reason=${ended.reason}，${sessionId.slice(-8)}）`)
				logger?.warn?.('未收到 turn/end，按日志兜底收尾', { sessionId, turn: ended.turn, reason: ended.reason })
				void finishRound(sessionId, { reason: ended.reason, error: ended.error ?? '', turn: ended.turn, from: 'status-idle' })
			}, delay)
			if (typeof round.fallbackTimer.unref === 'function') round.fallbackTimer.unref()
		})

		journal(`轮次监听已注册：${sessionId.slice(-8)}（agent 作用域）`)

		return () => {
			for (const dispose of disposers) {
				try {
					dispose?.()
				} catch {
					// 忽略卸载失败
				}
			}
		}
	}

	/**
	 * 观察一个会话事件（**同一个实现**给两条注册路径用）。
	 *
	 * 为什么要两条路径：线上出现过"完成通知不发了、只剩被打断通知"——后者由插件侧
	 * （beginRound 顶替 / markStopped）直接发，不需要事件；而"已结束"必须拿到 dsh 的
	 * `turn/end`。所以怀疑 agent 作用域上的 `session/event` 监听在某些情况下收不到事件
	 * （agent 实例被换掉，或 dsh 0.2 的事件派发只发给"会话范围内"的观察者）。
	 * 现在 agent 作用域 + 插件根作用域都注册，谁先到谁生效（认领/收尾都是幂等的），
	 * 并把这些判断记进状态文件的小日志里，下次一看就知道是哪条路在用。
	 *
	 * @param {string} sessionId
	 * @param {object} event
	 * @param {string} from 'agent'（agent 作用域监听）或 'root'（插件根作用域监听）
	 */
	function observe(sessionId, event, from = 'agent') {
		if (observedEvents < 8) {
			observedEvents += 1
			journal(
				`收到会话事件：type=${event?.type ?? '?'}（via ${from}，本桥${currentRound(sessionId) ? '有' : '无'}该轮次，${sessionId.slice(-8)}）`,
			)
		}
		const round = currentRound(sessionId)
		if (!round) return
		switch (event?.type) {
			case 'turn/start':
				// 认领这一轮：只有认领到的轮次才归本轮结算。
				if (round.turn === null || round.turn === undefined) {
					round.turn = event.data?.turn ?? null
					journal(`认领轮次 turn=${round.turn}（via ${from}，${sessionId.slice(-8)}）`)
				}
				break
			case 'tool/call':
				if (event.data?.name === REPLY_TOOL_NAME) round.replied = true
				// plan 模式下模型提交计划：`exit_plan_mode` 的计划正文是给 host 审批界面看的，
				// QQ 端一点也看不到 —— 这里转发一份过去（用户要求 QQ 也能看到计划）。
				if (event.data?.name === PLAN_TOOL_NAME) {
					const plan = String(event.data?.arguments?.plan ?? '').trim()
					if (plan) void onPlan?.({ sessionId: round.sessionId, plan })
				}
				break
			case 'turn/end': {
				const turn = event.data?.turn
				if (round.turn === null || round.turn === undefined) {
					// 还没认领任何轮次：这多半是我们刚打断的那一轮在收尾（被顶替的轮不发通知）
					journal(`忽略 turn/end：还没认领过轮次（turn=${turn} via ${from}，${sessionId.slice(-8)}）`)
					logger?.debug?.('忽略尚未认领的 turn/end', { sessionId, turn })
					return
				}
				if (turn !== round.turn) {
					journal(`忽略 turn/end：轮次不匹配（turn=${turn} 当前=${round.turn} via ${from}）`)
					logger?.debug?.('忽略其它轮次的 turn/end', { sessionId, turn, current: round.turn })
					return
				}
				void finishRound(sessionId, {
					reason: event.data?.reason?.kind ?? 'unknown',
					error: errorTextOf(event),
					turn,
					from,
				})
				break
			}
			default:
				break
		}
	}

	/**
	 * 等 agent **真的空闲**（驱动退休）—— 延迟投递前必须过这一关。
	 *
	 * 为什么（2026-10-16 线上实测，session-3bebee33）：
	 * 延迟投递是在 `turn/end` 的处理器里**同步**触发的，那一刻 dsh 的驱动**还活着**
	 * （`phase.kind === 'running'`，它紧接着才 `setPhase(idle)`）。而 dsh 的 `wakeDriver`
	 * 在 running 且没有 abort 时**既不唤醒、也不登记唤醒**（`wakeRequested` 不置位），
	 * 于是 `followup` 交出去的消息会一直躺在 dsh 界面的「待发送」队列里：
	 *
	 *     turn 46 completed → followup（进 next-turn）→ 驱动随即退休，再没人唤醒它
	 *     → 消息一直"待发送" → 25 秒后被用户取消；直到又发一条普通消息才被顺带捡走。
	 *
	 * 普通发送不踩这个空档：它是从网关 socket 事件进来的，那时驱动早就空闲了。
	 * 所以这里先等它空下来，再走**和普通发送完全一样**的那条路（`onDeliver` → `deliver`）。
	 *
	 * 等不到（有别的轮次在跑）也照样投：那时 `followup` 会进 next-turn 队列，由那一轮
	 * 收尾时捡走 —— 和用户手打一条消息落在待发送队列里的效果一样，不会丢。
	 *
	 * @returns {Promise<boolean>} 交出去之前驱动是不是已经空闲。
	 */
	async function waitForIdle(sessionId) {
		const agent = await agentFor(sessionId)
		if (!agent || agent.status !== 'running') return true
		const limit = Math.max(50, Number(config.idleWaitMs) || 5000)
		const startedAt = Date.now()
		if (typeof agent.whenIdle === 'function') {
			try {
				// whenIdle 在驱动退休后才 settle；外面套超时，兜住"又有别的轮次在跑"。
				await Promise.race([agent.whenIdle(), sleep(limit)])
			} catch {
				// 拿不到 whenIdle（被取消/抛错）：退回下面的轮询
			}
		}
		const pollMs = Math.max(5, Number(config.runningPollMs) || 500)
		const deadline = startedAt + limit
		while (agent.status === 'running' && Date.now() < deadline) await sleep(pollMs)
		return agent.status !== 'running'
	}

	/** 收尾：发结束通知（必要时）+ 投递延迟消息（仅正常结束）。 */
	async function finishRound(sessionId, { reason, turn, from = '', error = '' } = {}) {
		const round = currentRound(sessionId)
		if (!round || round.ended) return
		round.ended = true
		round.turn = turn ?? round.turn
		if (round.fallbackTimer) {
			clearTimeout(round.fallbackTimer)
			round.fallbackTimer = null
		}

		journal(
			`收尾：turn=${round.turn ?? '?'} reason=${reason}${from ? ` via ${from}` : ''} ` +
				`origin=${round.origin} superseded=${round.superseded} stopped=${round.stopped} openid=${round.openid ? '有' : '无'}`,
		)

		if (fromQqUser(round) && !round.superseded && !round.stopped && round.openid) {
			// 只有 reason=completed 才是「正常结束」；aborted/blocked/error 都算被打断 ——
			// 但 **reason=error 单独出一条「出现错误」+ 具体报错**（用户要求：别混进"被打断"）。
			enqueueNotice(round, {
				interrupted: reason !== 'completed',
				error: reason === 'error' ? error : '',
			})
		} else {
			journal('通知不发：轮次不是 QQ 用户发起的／已被顶替／已被停止（按设计）')
		}

		// 延迟发送只在"AI 正常结束这一轮"时投递：被停止/被顶替/出错的轮不算。
		if (reason === 'completed') {
			// 正常结束就把状态立刻落地（通知去重表 notices、待发槽都在里面），别等 debounce。
			const pending = state.delayedOf(sessionId)
			state.flush()
			if (pending) {
				// 先等驱动真的退休（见 waitForIdle），再把它拿走、用普通投递那条路交出去。
				const idle = await waitForIdle(sessionId)
				const delayed = state.takeDelayed(sessionId)
				state.flush()
				if (delayed) {
					journal(
						`延迟投递：${idle ? '驱动已空闲' : '等空闲超时（驱动还在跑）'}，` +
							`按普通投递交给 AI（${sessionId.slice(-8)}）`,
					)
					logger?.info?.('投递延迟消息', { sessionId, from: delayed.openid, items: delayed.itemCount ?? 0 })
					await onDeliver({
						sessionId,
						openid: delayed.openid,
						text: delayed.content,
						origin: 'delayed',
						// 输入态登记的延迟消息可能带图片与附件/语音分节：一起带过去。
						images: delayed.images ?? [],
						sections: delayed.sections ?? [],
					})
				}
			}
		}

		// 只清掉"我这一轮"：延迟投递会在上面**紧接着建一个新轮次**（origin=delayed）并放进
		// 同一张表，无脑 delete 会把那个新轮次一起删掉 —— 那样它就拿不到每轮上下文注入
		// （模型不知道要回 QQ），结束通知也会跟着丢（线上实测就是这个现象）。
		if (rounds.get(sessionId) === round) rounds.delete(sessionId)
	}

	/**
	 * 用户在「…已结束」通知上点「我需要回复」。
	 *
	 * 校验通过后向会话注入一条消息并唤醒，要求它把结果回复给用户。
	 * 互动回应由调用方（index.js 的分发器）统一发送，这里只回一个互动码。
	 *
	 * @returns {Promise<{ok:boolean, code:number, reason?:string}>}
	 */
	async function needReply({ openid, sessionId, interactionId, messageId }) {
		if (state.bindingOf(openid) !== sessionId) {
			logger?.warn?.('非绑定用户点了「我需要回复」', { openid: `${openid.slice(0, 6)}…`, sessionId })
			return { ok: false, code: INTERACTION_CODES.noPermission, reason: 'not-bound' }
		}
		const agent = await agentFor(sessionId)
		if (!agent) {
			return { ok: false, code: INTERACTION_CODES.noPermission, reason: 'no-session' }
		}
		if (agent.status === 'running') {
			// 这里**必须**回「失败」而不是「操作太频繁」：码 2 的平台语义就是
			// 用户点得太频繁，客户端会直接弹「操作太频繁」（线上就是这么弹的）。
			logger?.info?.('会话正在运行，忽略「我需要回复」', { sessionId })
			outbox.enqueue('send_c2c', {
				openid,
				markdown: false,
				content: '这一轮还在跑，等它结束后再点「我需要回复」；着急的话直接发一条消息（会打断当前轮）。',
				replyToEventId: interactionId,
				msgSeq: nextSeq(sessionId),
			})
			return { ok: false, code: INTERACTION_CODES.failed, reason: 'running' }
		}

		const round = beginRound({
			sessionId,
			openid,
			origin: 'qq',
			context: { eventId: interactionId, msgId: messageId ?? '' },
		})
		round.pendingContext = roundContextText(round)
		agent.followup(userMessage(String(config.needReplyText ?? '请把上一条消息对应的结果回复给用户。')))

		outbox.enqueue('send_c2c', {
			openid,
			markdown: false,
			content: String(config.needReplyAckText ?? '已触发，正在请求回复…'),
			replyToEventId: interactionId,
			msgSeq: nextSeq(sessionId),
		})
		logger?.info?.('已按用户点击唤醒会话', { sessionId })
		return { ok: true, code: INTERACTION_CODES.success }
	}

	return {
		beginRound,
		markStopped,
		attachAgent,
		needReply,
		finishRound,
		observe,
		watchIdle,
		currentContext,
		nextSeq,
		pendingInjectText,
		roundContextText,
		roundOf: currentRound,
	}
}
