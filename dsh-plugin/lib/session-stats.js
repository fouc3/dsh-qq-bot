/**
 * 会话「统计」桥：把 dsh web 会话底部那块统计搬进 QQ（`状态` 卡片的「统计」一节）。
 *
 * 数据全来自 dsh 自己登记的**会话投影**（`ctx.sessionController.projections({sessionId})`
 * 的 `values`），只读、不激活 agent，所以冷会话也读得到：
 *
 *   - `sessionStats`（`@deepseek-ai/dsh-session-stats`）
 *       `{ turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens }`
 *       → 模型用时 / 工具调用用时 / 首 token 平均（TTFT）/ 输出速度（TPS）
 *   - `tokenUsage`（`@deepseek-ai/dsh-token-meter`）
 *       `{ uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }`
 *       → Token 用量（四项之和）/ 缓存命中（cacheRead ÷(cacheRead+uncachedInput)）
 *   - `contextBreakdown`（同上）
 *       `{ systemTokens, toolsTokens, messageTokens }`
 *       → 上下文构成：系统提示词 / 工具定义 / 对话消息
 *   - `contextPressure`（同上）
 *       `{ contextWindow?, pressureTokens?, projectedTokens? }`
 *       → 上下文已用：`projectedTokens`（没有就用 `pressureTokens`）÷ `contextWindow`
 *
 * 这些投影**不一定存在**（没装对应插件的部署、或还没跑过任何一轮）：读不到就返回 null，
 * 由 `renderProgress` 决定省略哪几行——绝不因为缺数据就让整张卡片失败。
 */

/** 一次 projections 调用里我们要的四个投影键。 */
const STAT_KEYS = ['sessionStats', 'tokenUsage', 'contextBreakdown', 'contextPressure']

export function createSessionStats({ ctx, logger }) {
	/** 服务句柄（可选）：走 ctx.get 取名，取不到再退回插件注入的那个属性。 */
	function service() {
		try {
			return ctx.get?.('sessionController') ?? ctx.sessionController ?? null
		} catch {
			return ctx.sessionController ?? null
		}
	}

	/** 一个带超时的 signal：投影是本地读取，卡住也要有边界。 */
	function signal() {
		if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
			return AbortSignal.timeout(10_000)
		}
		return new AbortController().signal
	}

	/**
	 * 读某个会话的统计投影。
	 *
	 * @param {string} sessionId
	 * @returns {Promise<{stats:object, sessionStats:object|null, tokenUsage:object|null,
	 *   contextBreakdown:object|null, contextPressure:object|null}>} 读不到的一律 null
	 */
	async function read(sessionId) {
		const empty = {
			sessionStats: null,
			tokenUsage: null,
			contextBreakdown: null,
			contextPressure: null,
		}
		if (!sessionId || typeof service()?.projections !== 'function') return empty
		try {
			const baseline = await service().projections({ sessionId }, signal())
			const values = baseline?.values ?? {}
			const pick = (key) => {
				const value = values[key]
				return value && typeof value === 'object' ? value : null
			}
			return {
				sessionStats: pick('sessionStats'),
				tokenUsage: pick('tokenUsage'),
				contextBreakdown: pick('contextBreakdown'),
				contextPressure: pick('contextPressure'),
			}
		} catch (error) {
			// 读不到只是"卡片上不显示统计"，不该影响主流程。
			logger?.debug?.('读取会话统计投影失败（忽略）', { sessionId, error: String(error) })
			return empty
		}
	}

	return { read, keys: STAT_KEYS }
}
