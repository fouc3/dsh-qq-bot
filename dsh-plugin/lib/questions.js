/**
 * 提问桥：把 dsh 的 ask_user_question 变成 QQ 侧的 md 选择卡片。
 *
 * 卡片设计（用户明确要求）：
 *   - **按钮上只写字母 A/B/C…**；
 *   - 字母对应哪个选项、选项下面的小字（description）全部写在题干与按钮之间的正文里；
 *   - 支持「其他」：用户直接发文字即作为该题的"其他"答案；
 *   - 多题一次性展示；不选任何字母直接点「提交」= 跳过该题；
 *   - 每次选择都先尝试撤回上一张卡片，撤回失败只记 WARN。
 *
 * 超时或被取消时返回 null，由调用方 `next()` 交回 dsh GUI —— 绝不吞掉提问。
 */
import { buildQuestionCard } from './cards.js'

export function createQuestionBridge({ state, outbox, config, logger, io }) {
	const pending = new Map() // callId → entry
	const byOpenid = new Map() // openid → callId

	function entryOfCall(callId) {
		return pending.get(callId) ?? null
	}

	function entryOfOpenid(openid) {
		const callId = byOpenid.get(openid)
		return callId ? entryOfCall(callId) : null
	}

	async function render(entry) {
		const card = buildQuestionCard({
			callId: entry.callId,
			questions: entry.questions,
			answers: entry.answers,
			customFor: entry.customFor,
			maxButtons: Number(config.maxQuestionButtons) || 15,
		})
		if (!card) return null
		// 每次选择都先撤回上一张卡片（撤回失败只 WARN，不阻塞新卡）
		if (entry.cardMsgId) await io.recallCard(entry.openid, entry.cardMsgId)
		const messageId = await io.sendCard({
			openid: entry.openid,
			content: card.content,
			keyboard: card.keyboard,
			context: entry.context,
		})
		entry.cardMsgId = messageId ?? entry.cardMsgId ?? null
		return messageId
	}

	/**
	 * 问一次：发卡片并等用户作答。
	 * @returns {Promise<Array<{id:string,selected:string[],custom?:string}>|null>} null = 交回 dsh GUI
	 */
	async function ask({ callId, questions, openid, sessionId, context = {}, signal }) {
		if (!openid || !Array.isArray(questions) || questions.length === 0) return null

		const probe = buildQuestionCard({
			callId,
			questions,
			answers: {},
			customFor: null,
			maxButtons: Number(config.maxQuestionButtons) || 15,
		})
		if (!probe) {
			logger?.warn?.('提问按钮数超过上限，交回 dsh GUI', { callId, questions: questions.length })
			return null
		}

		const entry = {
			callId,
			openid,
			sessionId,
			questions,
			answers: {},
			customFor: null,
			cardMsgId: null,
			context,
			settled: false,
		}
		pending.set(callId, entry)
		byOpenid.set(openid, callId)

		const timeoutMs = Math.max(1000, Number(config.questionTimeoutMs) || 600000)
		const answer = new Promise((resolve) => {
			entry.resolve = resolve
		})
		entry.timer = setTimeout(() => {
			logger?.warn?.('提问在 QQ 侧超时，交回 dsh GUI', { callId, timeoutMs })
			void settle(entry, null)
		}, timeoutMs)
		if (typeof entry.timer.unref === 'function') entry.timer.unref()

		if (signal) {
			const onAbort = () => void settle(entry, null)
			if (signal.aborted) onAbort()
			else signal.addEventListener?.('abort', onAbort, { once: true })
		}

		try {
			const messageId = await render(entry)
			if (!messageId) {
				// 卡片没发出去（通道失败）：交回 GUI，别让提问悬着
				await settle(entry, null)
			}
		} catch (error) {
			logger?.warn?.('发送提问卡片失败，交回 dsh GUI', { callId, error: String(error) })
			await settle(entry, null)
		}
		return answer
	}

	/** 结算：把 pending 清干净并把答案交给等待者。 */
	async function settle(entry, result) {
		if (entry.settled) return
		entry.settled = true
		if (entry.timer) clearTimeout(entry.timer)
		pending.delete(entry.callId)
		if (byOpenid.get(entry.openid) === entry.callId) byOpenid.delete(entry.openid)
		if (result === null && entry.cardMsgId) {
			await io.recallCard(entry.openid, entry.cardMsgId)
		}
		entry.resolve?.(result)
	}

	function finalAnswers(entry) {
		return entry.questions.map((question, index) => {
			const answer = entry.answers[index] ?? {}
			const selected = Array.isArray(answer.selected) ? [...answer.selected] : []
			const custom = typeof answer.custom === 'string' && answer.custom.trim() ? answer.custom.trim() : undefined
			// 没选也没填 = 跳过（selected 为空、无 custom，与 dsh 的 skipped 语义一致）
			return custom ? { id: question.id, selected, custom } : { id: question.id, selected }
		})
	}

	/**
	 * 处理提问卡片上的按钮。
	 * @returns {{code:number, handled:boolean}} code 是要回应给平台的互动码
	 */
	async function handleCallback(parsed, { openid }) {
		const entry = entryOfCall(parsed.callId)
		if (!entry) {
			logger?.debug?.('收到过期提问卡片的点击', { callId: parsed.callId })
			return { code: 3, handled: false } // 重复/过期
		}
		if (entry.openid !== openid) {
			logger?.warn?.('提问卡片的点击者与提问对象不一致', { callId: parsed.callId })
			return { code: 4, handled: false }
		}

		const question = entry.questions[parsed.questionIndex]
		const action = parsed.action

		try {
			if (action === 'custom') {
				entry.customFor = parsed.questionIndex
			} else if (action === 'submit') {
				const answers = finalAnswers(entry)
				await recallAndSettle(entry)
				return { code: 0, handled: true, answers }
			} else if (action.startsWith('opt-')) {
				const optionIndex = Number(action.slice(4))
				const label = question?.options?.[optionIndex]?.label
				if (typeof label !== 'string') return { code: 1, handled: false }
				const current = entry.answers[parsed.questionIndex] ?? { selected: [] }
				if (question?.multiSelect) {
					const selected = new Set(current.selected ?? [])
					if (selected.has(label)) selected.delete(label)
					else selected.add(label)
					entry.answers[parsed.questionIndex] = { ...current, selected: [...selected] }
				} else {
					entry.answers[parsed.questionIndex] = { ...current, selected: [label] }
				}
				if (entry.customFor === parsed.questionIndex) entry.customFor = null
			} else {
				return { code: 1, handled: false }
			}

			await render(entry)
			return { code: 0, handled: true }
		} catch (error) {
			logger?.warn?.('处理提问卡片点击失败', { callId: parsed.callId, error: String(error) })
			return { code: 1, handled: false }
		}
	}

	async function recallAndSettle(entry) {
		if (entry.cardMsgId) await io.recallCard(entry.openid, entry.cardMsgId)
		const answers = finalAnswers(entry)
		await settle(entry, answers)
	}

	/**
	 * 把待答提问期间收到的普通文本当作「其他」答案。
	 * @returns {Promise<boolean>} 是否被当作答案消费掉了
	 */
	async function handleText(openid, text) {
		const entry = entryOfOpenid(openid)
		if (!entry) return false
		const content = String(text ?? '').trim()
		if (!content) return true // 空文本也算处理过：提问期间不该再走普通消息

		let index = entry.customFor
		if (index === null || index === undefined) {
			index = entry.questions.findIndex((_, i) => {
				const answer = entry.answers[i] ?? {}
				return (answer.selected ?? []).length === 0 && !answer.custom
			})
		}
		if (index < 0) index = 0
		entry.answers[index] = { ...(entry.answers[index] ?? { selected: [] }), custom: content }
		entry.customFor = null
		logger?.info?.('收到提问的「其他」答案', { callId: entry.callId, question: index })
		await render(entry)
		return true
	}

	return {
		ask,
		handleCallback,
		handleText,
		hasPending: (openid) => byOpenid.has(openid),
		pendingCount: () => pending.size,
		/** 插件卸载时把所有提问交回 dsh GUI。 */
		dispose() {
			for (const entry of [...pending.values()]) void settle(entry, null)
		},
		_snapshot: () => [...pending.values()].map((e) => ({ callId: e.callId, openid: e.openid, answers: e.answers })),
	}
}
