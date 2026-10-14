/**
 * 提问桥：把 dsh 的 ask_user_question 变成 QQ 侧的 md 选择卡片。
 *
 * 卡片设计（用户明确要求）：
 *   - **按钮上只写字母 A/B/C…**；
 *   - 字母对应哪个选项、选项下面的小字（description）全部写在题干与按钮之间的正文里；
 *   - 支持「其他」：用户直接发文字即作为该题的"其他"答案；
 *   - 多题一次性展示；一卡放不下就**拆成多张卡片**（每张都带「提交」）；
 *   - 不选任何字母直接点「提交」= 跳过该题；
 *   - 每次选择都只撤回并重发**被点的那张卡片**，撤回失败只记 WARN。
 *
 * 超时、被取消、或卡片放不下/发不出去时返回 null，由调用方 `next()` 交回 dsh GUI
 * —— 绝不吞掉提问；降级时还会在 QQ 里明说一句，免得用户什么都看不到。
 */
import { buildQuestionCards, QUESTION_MAX_BUTTONS } from './cards.js'

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

	function maxButtons() {
		return Number(config.maxQuestionButtons) || QUESTION_MAX_BUTTONS
	}

	/** 按当前已答状态重新生成一次提问的所有卡片（分组只取决于题目，下标稳定）。 */
	function cardsOf(entry) {
		return buildQuestionCards({
			callId: entry.callId,
			questions: entry.questions,
			answers: entry.answers,
			customFor: entry.customFor,
			maxButtons: maxButtons(),
		})
	}

	/** 第 cardIndex 张卡片在第几组（按题序归属）。 */
	function cardIndexOfQuestion(entry, questionIndex) {
		const index = (entry.groups ?? []).findIndex((indices) => indices.includes(questionIndex))
		return index < 0 ? 0 : index
	}

	async function render(entry, cardIndex = 0) {
		const card = cardsOf(entry)?.[cardIndex]
		if (!card) return null
		// 只撤回**这张卡**的上一条；一次提问可能有好几张卡，别把别的卡也撤了。
		if (entry.cardMsgIds[cardIndex]) await io.recallCard(entry.openid, entry.cardMsgIds[cardIndex])
		const messageId = await io.sendCard({
			openid: entry.openid,
			content: card.content,
			keyboard: card.keyboard,
			context: entry.context,
			// 交给桥自己按卡片下标撤回，别让 io 顺手撤掉上一张（那是另一组题）。
			keepPrevious: true,
		})
		if (messageId) {
			entry.cardMsgIds[cardIndex] = messageId
			entry.cardIndex = cardIndex
		}
		return messageId
	}

	/** 把这次提问发出去的**所有**卡片都撤回（尽力而为）。 */
	async function recallAll(entry) {
		const ids = (entry.cardMsgIds ?? []).filter(Boolean)
		entry.cardMsgIds = []
		for (const messageId of ids) await io.recallCard(entry.openid, messageId)
	}

	/** 卡片发不出去/放不下时的兜底：告诉用户已经交回 dsh GUI，别无声无息。 */
	async function notifyFallback(entry, reason) {
		try {
			await io.notify?.({
				openid: entry.openid,
				content: `**提问没能发到 QQ**（${reason}）。\n> 已经交回 dsh Web 端等你回答；也可以把问题拆小一点再问我一次。`,
				context: entry.context,
			})
		} catch (error) {
			logger?.warn?.('提问降级提示发送失败', { callId: entry.callId, error: String(error) })
		}
	}

	/**
	 * 问一次：发卡片并等用户作答。
	 * @returns {Promise<Array<{id:string,selected:string[],custom?:string}>|null>} null = 交回 dsh GUI
	 */
	async function ask({ callId, questions, openid, sessionId, context = {}, signal }) {
		if (!openid || !Array.isArray(questions) || questions.length === 0) return null

		const entry = {
			callId,
			openid,
			sessionId,
			questions,
			answers: {},
			customFor: null,
			cardMsgIds: [],
			cardIndex: 0,
			groups: null,
			context,
			settled: false,
		}

		const probe = cardsOf(entry)
		if (!probe) {
			logger?.warn?.('提问放不下一张卡片，交回 dsh GUI', { callId, questions: questions.length, maxButtons: maxButtons() })
			await notifyFallback(entry, '按钮太多，QQ 卡片放不下')
			return null
		}
		entry.groups = probe.map((card) => card.indices)
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
			// 一次提问可能拆成好几张卡片，逐张发出去；一张都没发成功就交回 GUI。
			let anySent = false
			for (let cardIndex = 0; cardIndex < entry.groups.length; cardIndex += 1) {
				const messageId = await render(entry, cardIndex)
				if (messageId) anySent = true
			}
			if (!anySent) {
				// 卡片没发出去（通道失败）：交回 GUI，别让提问悬着
				await notifyFallback(entry, '卡片发送失败')
				await settle(entry, null)
			}
		} catch (error) {
			logger?.warn?.('发送提问卡片失败，交回 dsh GUI', { callId, error: String(error) })
			await notifyFallback(entry, '卡片发送失败')
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
		if (result === null) await recallAll(entry)
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

			// 重发**被点的那张卡片**（多卡时其余卡片原地不动）。
			await render(entry, cardIndexOfQuestion(entry, parsed.questionIndex))
			return { code: 0, handled: true }
		} catch (error) {
			logger?.warn?.('处理提问卡片点击失败', { callId: parsed.callId, error: String(error) })
			return { code: 1, handled: false }
		}
	}

	async function recallAndSettle(entry) {
		await recallAll(entry)
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
		await render(entry, cardIndexOfQuestion(entry, index))
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
