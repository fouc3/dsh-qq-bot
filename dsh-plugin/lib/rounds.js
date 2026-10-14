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
	nextSeqFor,
}) {
	const rounds = new Map()

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
		return round
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

	/** 发一条结束/被打断通知（按 会话+轮次 去重）。 */
	function enqueueNotice(round, { interrupted = false, source = '' } = {}) {
		if (!round || round.origin !== 'qq' || !round.openid) return
		const key = `${round.sessionId}:${round.turn ?? round.startedAt}`
		if (state.noticeSeen(key)) return
		const card = buildNoticeCard({
			label: sessions.label(round.sessionId),
			sessionId: round.sessionId,
			interrupted,
			source,
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
		logger?.info?.(interrupted ? '已发被打断通知' : '已发结束通知', {
			sessionId: round.sessionId,
			hasSource: Boolean(source),
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
		if (!round || round.origin !== 'qq') return null
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
				if (!round || round.origin !== 'qq') return decision
				if (round.contextTurn === payload.turn) return decision
				const text = round.pendingContext
				if (!text) return decision
				round.contextTurn = payload.turn
				return { ...decision, messages: [...decision.messages, contextMessage(text)] }
			},
			true,
		)

		on('session/event', (session, event) => onSessionEvent(sessionId, event))
		on('agent/status', ({ status }) => {
			if (status !== 'idle') return
			const round = currentRound(sessionId)
			if (!round || round.ended) return
			// 兜底：turn/end 因异常路径没到，也要给用户一个收尾信号。
			if (round.fallbackTimer) clearTimeout(round.fallbackTimer)
			const delay = Math.max(500, Number(config.noticeFallbackMs) || 3000)
			round.fallbackTimer = setTimeout(() => {
				const latest = currentRound(sessionId)
				if (!latest || latest.ended || latest !== round) return
				logger?.warn?.('未收到 turn/end，按兜底路径收尾', { sessionId })
				void finishRound(sessionId, { reason: 'unknown' })
			}, delay)
			if (typeof round.fallbackTimer.unref === 'function') round.fallbackTimer.unref()
		})

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

	function onSessionEvent(sessionId, event) {
		const round = currentRound(sessionId)
		if (!round) return
		switch (event?.type) {
			case 'turn/start':
				// 认领这一轮：只有认领到的轮次才归本轮结算。
				if (round.turn === null || round.turn === undefined) round.turn = event.data?.turn ?? null
				break
			case 'tool/call':
				if (event.data?.name === REPLY_TOOL_NAME) round.replied = true
				break
			case 'turn/end': {
				const turn = event.data?.turn
				if (round.turn === null || round.turn === undefined) {
					// 还没认领任何轮次：这多半是我们刚打断的那一轮在收尾（被顶替的轮不发通知）
					logger?.debug?.('忽略尚未认领的 turn/end', { sessionId, turn })
					return
				}
				if (turn !== round.turn) {
					logger?.debug?.('忽略其它轮次的 turn/end', { sessionId, turn, current: round.turn })
					return
				}
				void finishRound(sessionId, { reason: event.data?.reason?.kind ?? 'unknown', turn })
				break
			}
			default:
				break
		}
	}

	/** 收尾：发结束通知（必要时）+ 投递延迟消息（仅正常结束）。 */
	async function finishRound(sessionId, { reason, turn } = {}) {
		const round = currentRound(sessionId)
		if (!round || round.ended) return
		round.ended = true
		round.turn = turn ?? round.turn
		if (round.fallbackTimer) {
			clearTimeout(round.fallbackTimer)
			round.fallbackTimer = null
		}

		if (round.origin === 'qq' && !round.superseded && !round.stopped && round.openid) {
			// 只有 reason=completed 才是「正常结束」；aborted/blocked/error 都算被打断。
			enqueueNotice(round, { interrupted: reason !== 'completed' })
		}

		// 延迟发送只在"AI 正常结束这一轮"时投递：被停止/被顶替/出错的轮不算。
		if (reason === 'completed') {
			const delayed = state.takeDelayed(sessionId)
			state.flush()
			if (delayed) {
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

		rounds.delete(sessionId)
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
		currentContext,
		nextSeq,
		pendingInjectText,
		roundContextText,
		roundOf: currentRound,
	}
}
