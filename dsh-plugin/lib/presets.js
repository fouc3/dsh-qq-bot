/**
 * 角色预设（agent preset）桥：读 dsh 的预设清单、切某个会话的预设。
 *
 * 对应 dsh Web 输入框旁边那个「预设」座位（`@deepseek-ai/dsh-client-ui-agent-preset`）。
 * 服务是 `ctx.get('agentPresets')`（`@deepseek-ai/dsh-agent-preset-registry`）：
 *   - `list()` → `[{ id, name?, description?, order?, broken? }]`（按 order 排序）；
 *   - `remoteExportList()` → `{ presets: [{ …同上, isDefault }] }`（**带 isDefault**，Web 读的就是它）；
 *   - `resolve(id)` → `{ id, broken? }`（不激活 agent 的身份解析）；
 *   - `select(agent, agentPreset)` → 切换，写入一条 `agent-preset/selected` 事件
 *     （会话投影 `agentPreset` 就跟着它走）。
 *
 * ⚠️ `select` 有**前置守卫**：会话一旦开过轮次（`turnBoundary.lastTurn > 0` 或还有未收的轮），
 * dsh 直接抛 `agent-preset/locked`（"This session has already started"）。所以：
 *   - 先读投影 `turnBoundary` **预检**，被锁就如实回一句，**不去把冷会话白唤醒一轮**；
 *   - 只对"还没开跑"的会话才 `select`（那种会话可能需要先把 agent 拉起来，因为 `select`
 *     的入参是 **agent 对象**，不是会话id）。
 *
 * 用**可选访问**：没有该服务的 profile 里插件照常激活，命令回一句"这个部署没有角色预设服务"。
 */

/** 拿不到服务时的兜底文案（命令与卡片共用）。 */
export const NO_SERVICE = '这个部署没有角色预设服务（`ctx.agentPresets`）。'

/** 预设 id 的宽松别名：中文名、英文片段、纯序号都认。 */
function normalizeToken(token) {
	return String(token ?? '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '')
}

export function createPresets({ ctx, logger, agentFor }) {
	/** 服务句柄（可选）。 */
	function service() {
		try {
			return ctx.get?.('agentPresets') ?? ctx.agentPresets ?? null
		} catch {
			return null
		}
	}

	function available() {
		const svc = service()
		return Boolean(svc && (typeof svc.list === 'function' || typeof svc.remoteExportList === 'function'))
	}

	function signal() {
		return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
			? AbortSignal.timeout(10000)
			: new AbortController().signal
	}

	/**
	 * 可选预设清单（按 dsh 给的顺序）。
	 *
	 * 优先 `remoteExportList()`（带 `isDefault`），退回 `list()`；两边都拿不到就空数组
	 * （卡片会写「（读不到）」）。
	 *
	 * @returns {Promise<Array<{value:string, name:string, description:string, isDefault:boolean, broken:string}>>}
	 */
	async function catalog() {
		const svc = service()
		if (!svc) return []
		try {
			let rows = null
			if (typeof svc.remoteExportList === 'function') {
				rows = (await svc.remoteExportList())?.presets ?? null
			}
			if (!Array.isArray(rows) && typeof svc.list === 'function') rows = await svc.list()
			if (!Array.isArray(rows)) return []
			return rows
				.filter((row) => row && typeof row.id === 'string' && row.id)
				.map((row) => ({
					value: row.id,
					// 名字是给人看的：优先 name，没有就退回 id（预设定不起名字时 id 才可读）
					name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : row.id,
					description: typeof row.description === 'string' ? row.description.trim() : '',
					isDefault: row.isDefault === true,
					broken: typeof row.broken === 'string' ? row.broken : '',
				}))
		} catch (error) {
			logger?.warn?.('读取角色预设目录失败', { error: String(error) })
			return []
		}
	}

	/** 会话当前生效的预设 id（会话投影 `agentPreset`；读不到返回空串）。 */
	async function currentForId(sessionId) {
		if (!sessionId) return ''
		try {
			const controller = ctx.get?.('sessionController') ?? null
			if (typeof controller?.projections === 'function') {
				const baseline = await controller.projections({ sessionId }, signal())
				const value = baseline?.values?.agentPreset
				if (typeof value === 'string' && value) return value
			}
		} catch (error) {
			logger?.debug?.('读角色预设投影失败（忽略）', { sessionId, error: String(error) })
		}
		return ''
	}

	/**
	 * 这个会话是不是**已经开跑过**（dsh 会拒绝中途换预设）。
	 *
	 * 判据与 dsh 的守卫一致：投影 `turnBoundary` 存在且（有未收的轮 或 已经跑过至少一轮）。
	 * 读不到投影（老会话/新会话）就当作没锁 —— 让 `select` 自己去判断，别自作主张拦。
	 *
	 * @returns {Promise<{locked:boolean, lastTurn:number, open:boolean}>}
	 */
	async function lockedForId(sessionId) {
		if (!sessionId) return { locked: false, lastTurn: 0, open: false }
		try {
			const controller = ctx.get?.('sessionController') ?? null
			if (typeof controller?.projections === 'function') {
				const baseline = await controller.projections({ sessionId }, signal())
				const boundary = baseline?.values?.turnBoundary
				if (boundary && typeof boundary === 'object') {
					const lastTurn = Number(boundary.lastTurn) || 0
					const open = boundary.openTurnStartSeq !== null && boundary.openTurnStartSeq !== undefined
					return { locked: open || lastTurn > 0, lastTurn, open }
				}
			}
		} catch (error) {
			logger?.debug?.('读 turnBoundary 失败（按未锁处理）', { sessionId, error: String(error) })
		}
		return { locked: false, lastTurn: 0, open: false }
	}

	/** 预设 id → 显示名（拿不到清单时原样返回 id）。 */
	async function nameOf(value) {
		if (typeof value !== 'string' || !value) return ''
		const option = (await catalog()).find((item) => item.value === value)
		return option?.name ?? value
	}

	/**
	 * 把用户输入解析成预设 id。
	 * 认：精确 id / 显示名 / 纯序号（`1` 起，按卡片顺序）。
	 *
	 * @returns {Promise<{ok:true, value:string, name:string}|{ok:false, error:string}>}
	 */
	async function resolveToken(tokens) {
		const raw = (Array.isArray(tokens) ? tokens : [tokens]).map((item) => String(item ?? '').trim()).filter(Boolean)
		if (raw.length === 0) return { ok: false, error: '没有给角色预设。' }
		const joined = raw.join(' ')
		const options = await catalog()
		if (options.length === 0) return { ok: false, error: `这个部署没有可用的角色预设。` }
		const key = normalizeToken(joined)
		const exact = options.find(
			(item) => normalizeToken(item.value) === key || normalizeToken(item.name) === key,
		)
		if (exact) return { ok: true, value: exact.value, name: exact.name }
		if (/^\d+$/.test(key)) {
			const index = Number(key) - 1
			if (index >= 0 && index < options.length) {
				const item = options[index]
				return { ok: true, value: item.value, name: item.name }
			}
		}
		const names = options.slice(0, 6).map((item) => `\`${item.name}\``).join('、')
		return { ok: false, error: `认不出角色预设 \`${joined}\`。可选：${names}${options.length > 6 ? ' …' : ''}` }
	}

	/** 被锁时的统一说辞（把 dsh 的原话也带上，方便对照 Web 端）。 */
	function lockedError() {
		return (
			'这个会话**已经开跑过轮次**，dsh 不允许中途换角色预设' +
			'（原文：`agent-preset/locked` / "This session has already started"）。\n' +
			'> 换预设要在**会话还没开跑**时选（新建会话时挑），或者换一个还没跑过的会话。'
		)
	}

	/**
	 * 切换某个会话的角色预设。
	 *
	 * @param {{sessionId:string, value:string}} input
	 * @returns {Promise<{ok:true, value:string, name:string}|{ok:false, error:string}>}
	 */
	async function set({ sessionId, value }) {
		if (!available()) return { ok: false, error: NO_SERVICE }
		const wanted = String(value ?? '').trim()
		if (!wanted) return { ok: false, error: '角色预设不能为空。' }
		if (!sessionId || sessionId === 'none') return { ok: false, error: '当前没有绑定会话，先 `切换会话`。' }

		// 先看清单：未知 id 直接回绝，别把 dsh 的 not-found 抛给用户。
		const options = await catalog()
		const option = options.find((item) => item.value === wanted)
		if (options.length > 0 && !option) {
			const names = options.slice(0, 6).map((item) => `\`${item.name}\``).join('、')
			return { ok: false, error: `没有 \`${wanted}\` 这个角色预设。可选：${names}${options.length > 6 ? ' …' : ''}` }
		}

		// 预检：已经开跑过的会话 dsh 一定拒，先回话，别去唤醒冷会话白跑一趟。
		const state = await lockedForId(sessionId)
		if (state.locked) return { ok: false, error: lockedError(), locked: true }

		// `select(agent, id)` 的入参是 **agent 对象** ⇒ 冷会话得先按标准路径拉起来
		// （`agentFor` 走 `sessionController.resolveAgent`，带模型与预设组合）。
		let agent = null
		try {
			agent = ctx.agents?.get?.(sessionId) ?? null
		} catch (error) {
			logger?.debug?.('读活 agent 失败', { sessionId, error: String(error) })
		}
		if (!agent && typeof agentFor === 'function') agent = await agentFor(sessionId)
		if (!agent) return { ok: false, error: '这个会话打不开（没有活 agent），没法切角色预设。' }

		try {
			const applied = await service().select(agent, wanted)
			logger?.info?.('已切换角色预设', { sessionId, agentPreset: applied ?? wanted })
			return { ok: true, value: typeof applied === 'string' && applied ? applied : wanted, name: option?.name ?? wanted }
		} catch (error) {
			const code = String(error?.code ?? '')
			const message = String(error?.message ?? error)
			logger?.warn?.('切换角色预设失败', { sessionId, agentPreset: wanted, error: message })
			if (code.includes('agent-preset/locked') || /already started/i.test(message)) {
				return { ok: false, error: lockedError(), locked: true }
			}
			if (code.includes('agent-preset/not-found')) {
				return { ok: false, error: `没有 \`${wanted}\` 这个角色预设（dsh 说：${message}）。` }
			}
			return { ok: false, error: `切换失败：${message}` }
		}
	}

	/** 人话描述一份预设（回执与卡片正文共用）。 */
	async function describe(value) {
		const option = (await catalog()).find((item) => item.value === value)
		if (!option) return value || '未知'
		const tags = [option.isDefault ? '默认' : '', option.broken ? `加载失败：${option.broken}` : ''].filter(Boolean)
		const suffix = tags.length > 0 ? `（${tags.join('，')}）` : ''
		return option.description
			? `**${option.name}**${suffix} — ${option.description}`
			: `**${option.name}**${suffix}`
	}

	return { available, catalog, currentForId, lockedForId, nameOf, resolveToken, set, describe }
}
