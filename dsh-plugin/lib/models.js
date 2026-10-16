/**
 * 模型（provider/model 选择）桥：读 dsh 的模型目录、切某个会话正在用的模型。
 *
 * 对应 dsh Web 里那个模型选择器（`/model` 弹窗与输入框旁那个座位）：
 *   服务是 `ctx.sessionController`（`@deepseek-ai/dsh-api-session-controller`）：
 *   - `modelCatalog()` → `{ default, routableProviders, groups: [{id,name,models:[{id,name,description?}]}], failures }`
 *     —— 只列出**当前可路由**的提供商与模型；某个提供商查失败会单独进 `failures`；
 *   - `selectModel({ sessionId, provider, model, reasoningEffort? })` → `{ selected }`
 *     —— 注释里写明"会显式 resume 该会话"，所以冷会话也能切（不用先启动 agent）；
 *   - `projections({ sessionId })` → `{ asOfSeq, values: { 'model/selection': { lastUsed, pending } } }`
 *     —— 只读、**不激活 agent**，用来标出"当前是哪一档"。
 *
 * 为什么不做成必需服务：插件在没装该服务的 profile 里也要能激活，
 * 所以走 `ctx.get('sessionController')` 的可选访问，拿不到就回一句人话。
 */

/** 归一化：去空白、小写（"DeepSeek Chat" 与 "deepseekchat" 视为同一串）。 */
function normalizeToken(token) {
	return String(token ?? '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '')
}

/** 更松的归一化：连 `-` `.` `_` 一起去掉（"gpt-5.2" ≈ "gpt52"）。 */
function looseToken(token) {
	return normalizeToken(token).replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
}

/** 把 `a:b:c` 按第一个冒号切成两段（模型选择卡片的回调 data 用）。 */
export function splitOnce(text, sep = ':') {
	const raw = String(text ?? '')
	const at = raw.indexOf(sep)
	if (at < 0) return [raw, '']
	return [raw.slice(0, at), raw.slice(at + 1)]
}

/**
 * 在一个候选列表里挑一个。
 *
 * 顺序（越靠前越优先，避免"名字长得像"把精确匹配挤掉）：
 *   1. 归一化后完全相等（id 或显示名）；
 *   2. 纯序号（`1` 起，按卡片里的顺序）；
 *   3. 去分隔符后完全相等；
 *   4. 唯一子串命中（打一半的名字也能认，但**必须唯一**）。
 *
 * @returns {{item:object}|{error:string}|null} null = 没命中；error = 命中多个（有歧义）。
 */
function pickFrom(items, token, { labelOf, idOf }) {
	const key = normalizeToken(token)
	if (!key) return null
	const loose = looseToken(token)

	const exact = items.find((item) => normalizeToken(idOf(item)) === key || normalizeToken(labelOf(item)) === key)
	if (exact) return { item: exact }

	if (/^\d+$/.test(key)) {
		const index = Number(key) - 1
		if (index >= 0 && index < items.length) return { item: items[index] }
	}

	const looseExact = items.find((item) => looseToken(idOf(item)) === loose || looseToken(labelOf(item)) === loose)
	if (looseExact) return { item: looseExact }

	const hits = items.filter(
		(item) => normalizeToken(idOf(item)).includes(key) || looseToken(labelOf(item)).includes(loose),
	)
	if (hits.length === 1) return { item: hits[0] }
	if (hits.length > 1) {
		const names = hits.slice(0, 6).map((item) => `\`${idOf(item)}\``).join('、')
		return { error: `\`${token}\` 能对上好几个（${names}），写完整一点。` }
	}
	return null
}

export function createModels({ ctx, logger }) {
	/** 服务句柄（可选）：走 ctx.get 取名，取不到再退回插件注入的那个属性。 */
	function service() {
		try {
			return ctx.get?.('sessionController') ?? ctx.sessionController ?? null
		} catch {
			return ctx.sessionController ?? null
		}
	}

	function available() {
		const svc = service()
		return Boolean(svc && typeof svc.modelCatalog === 'function' && typeof svc.selectModel === 'function')
	}

	/** 一个带超时的 signal：目录读取是本地调用，卡住也要有边界。 */
	function signal() {
		if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
			return AbortSignal.timeout(15000)
		}
		return new AbortController().signal
	}

	/**
	 * 当前可路由的模型目录。
	 * @returns {Promise<{ok:true, groups:Array, failures:Array, default:object|null}|{ok:false, error:string}>}
	 */
	async function catalog() {
		if (!available()) {
			return { ok: false, error: '这个部署没有模型服务（`ctx.sessionController`），看不了模型列表。' }
		}
		try {
			const value = await service().modelCatalog()
			const groups = Array.isArray(value?.groups)
				? value.groups
						.filter((group) => group && typeof group.id === 'string' && group.id)
						.map((group) => ({
							id: group.id,
							name: typeof group.name === 'string' && group.name ? group.name : group.id,
							models: (Array.isArray(group.models) ? group.models : [])
								.filter((model) => model && typeof model.id === 'string' && model.id)
								.map((model) => ({
									id: model.id,
									name: typeof model.name === 'string' && model.name ? model.name : model.id,
									description: typeof model.description === 'string' ? model.description : '',
								})),
						}))
						.filter((group) => group.models.length > 0)
				: []
			const failures = Array.isArray(value?.failures)
				? value.failures
						.filter((item) => item && typeof item.id === 'string' && item.id)
						.map((item) => ({
							id: item.id,
							name: typeof item.name === 'string' && item.name ? item.name : item.id,
							message: typeof item.message === 'string' ? item.message : '',
						}))
				: []
			return { ok: true, groups, failures, default: value?.default ?? null }
		} catch (error) {
			logger?.warn?.('读取模型目录失败', { error: String(error) })
			return { ok: false, error: `读取模型目录失败：${String(error?.message ?? error)}` }
		}
	}

	/**
	 * 某个会话当前生效的模型（pending 优先，其次 lastUsed）。
	 * @returns {Promise<{provider:string, model:string}|null>}
	 */
	async function current(sessionId) {
		if (!sessionId || typeof service()?.projections !== 'function') return null
		try {
			const baseline = await service().projections({ sessionId }, signal())
			const value = baseline?.values?.['model/selection']
			const selection = value?.pending ?? value?.lastUsed ?? null
			if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return null
			return { provider: selection.provider, model: selection.model }
		} catch (error) {
			// 读不到就只是"卡片上不标当前"，不该让整个面板失败。
			logger?.debug?.('读取会话模型失败（忽略）', { sessionId, error: String(error) })
			return null
		}
	}

	/**
	 * 从会话日志里最后一次 `request/header` 取**真正用过**的模型（只读，冷会话也行）。
	 *
	 * 形状：`{ type:'request/header', data:{ header:{ config:{ provider, model, maxTokens } } } }`。
	 * 用 `sessionController.inspect()`：它读的是已存会话 / 内存快照，**不会 resume、不激活 agent**。
	 */
	async function modelFromLog(sessionId) {
		if (typeof service()?.inspect !== 'function') return null
		try {
			const observed = await service().inspect(sessionId, signal())
			const events = observed?.events
			if (!Array.isArray(events)) return null
			// 从最新往回扫，遇到第一个带模型配置的 request/header 就收工（不拷贝整条日志）。
			for (let index = events.length - 1; index >= 0; index -= 1) {
				const event = events[index]
				if (event?.type !== 'request/header') continue
				const config = event.data?.header?.config ?? {}
				const provider = typeof config.provider === 'string' ? config.provider.trim() : ''
				const model = typeof config.model === 'string' ? config.model.trim() : ''
				if (provider && model) return { provider, model }
			}
		} catch (error) {
			logger?.debug?.('从会话日志读取模型失败（忽略）', { sessionId, error: String(error) })
		}
		return null
	}

	/** 部署默认模型（拿不到服务或没配就 null）。 */
	function defaultModel() {
		try {
			const owner = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel ?? null
			const selection = owner?.currentSelection?.()
			const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : ''
			const model = typeof selection?.model === 'string' ? selection.model.trim() : ''
			if (provider && model) return { provider, model }
		} catch (error) {
			logger?.debug?.('读取部署默认模型失败（忽略）', { error: String(error) })
		}
		return null
	}

	/**
	 * 这个会话**实际会用/刚用过**的模型 —— 给「状态」卡这类只读展示用，**绝不 resume**。
	 *
	 * 线上反馈：`状态` 卡的「模型」对某些会话一直是「（读不到）」。因为这里以前只看
	 * `model/selection` 投影（用户**显式选过**才有）——很多会话（比如目标链里长期在跑的）
	 * 从没点过选择器，投影就是空的。顺序改成：
	 *   1. `model/selection`：以后会用哪个（用户显式选过）；
	 *   2. 会话日志最后一次 `request/header`：这一轮**真正用过**哪个（冷会话也能读）；
	 *   3. 部署默认模型：还没跑过的会话将来会用哪个 —— 标成 `default`，卡片上注明"部署默认"，
	 *      免得把"预测值"说成"这个会话的模型"。
	 *
	 * @param {string} sessionId
	 * @returns {Promise<{provider:string, model:string, source:'selection'|'log'|'default'}|null>}
	 */
	async function effective(sessionId) {
		if (!sessionId) return null
		const chosen = await current(sessionId)
		if (chosen) return { ...chosen, source: 'selection' }
		const used = await modelFromLog(sessionId)
		if (used) return { ...used, source: 'log' }
		const fallback = defaultModel()
		return fallback ? { ...fallback, source: 'default' } : null
	}

	/**
	 * 把 `提供商/模型名字` 解析成具体的一对 id。
	 *
	 * 认：提供商 id 或显示名、模型 id 或显示名、卡片里的序号（`2/3`）；
	 * 也认不带斜杠的写法（全库唯一命中时才认，否则报歧义）。
	 *
	 * @param {string} spec 用户给的 `提供商/模型名字`
	 * @param {Array} groups catalog() 的 groups
	 * @returns {{ok:true, group:object, model:object, text:string}|{ok:false, error:string}}
	 */
	function resolveToken(spec, groups) {
		const raw = String(spec ?? '').trim()
		if (!raw) return { ok: false, error: '没有给模型。' }
		if (!Array.isArray(groups) || groups.length === 0) {
			return { ok: false, error: '这个部署现在没有任何可用的模型。' }
		}

		const slash = raw.indexOf('/')
		if (slash >= 0) {
			const providerToken = raw.slice(0, slash).trim()
			const modelToken = raw.slice(slash + 1).trim()
			if (!providerToken) return { ok: false, error: `\`${raw}\` 里没写提供商，格式是 \`提供商/模型名字\`。` }
			if (!modelToken) return { ok: false, error: `\`${raw}\` 里没写模型名字，格式是 \`提供商/模型名字\`。` }
			const found = pickFrom(groups, providerToken, { idOf: (g) => g.id, labelOf: (g) => g.name })
			if (!found) return { ok: false, error: `认不出提供商 \`${providerToken}\`，发 \`模型\` 看卡片。` }
			if (found.error) return { ok: false, error: found.error }
			const model = pickFrom(found.item.models, modelToken, { idOf: (m) => m.id, labelOf: (m) => m.name })
			if (!model) {
				return { ok: false, error: `提供商 \`${found.item.name}\` 里没有 \`${modelToken}\`，发 \`模型\` 点进去看列表。` }
			}
			if (model.error) return { ok: false, error: model.error }
			return { ok: true, group: found.item, model: model.item, text: describe(found.item, model.item) }
		}

		// 没有斜杠：先当提供商试（认出来就提示要补模型名字）。
		const asProvider = pickFrom(groups, raw, { idOf: (g) => g.id, labelOf: (g) => g.name })
		if (asProvider && !asProvider.error) {
			return {
				ok: false,
				error: `\`${raw}\` 是提供商，还差模型名字：写成 \`${asProvider.item.id}/<模型名字>\`。`,
			}
		}
		// 不然就在所有提供商里找模型（必须唯一）。
		const hits = []
		for (const group of groups) {
			const found = pickFrom(group.models, raw, { idOf: (m) => m.id, labelOf: (m) => m.name })
			if (found?.item) hits.push({ group, model: found.item })
			else if (found?.error) return { ok: false, error: found.error }
		}
		if (hits.length === 1) {
			return { ok: true, group: hits[0].group, model: hits[0].model, text: describe(hits[0].group, hits[0].model) }
		}
		if (hits.length > 1) {
			const names = hits
				.slice(0, 6)
				.map((hit) => `\`${hit.group.id}/${hit.model.id}\``)
				.join('、')
			return { ok: false, error: `\`${raw}\` 在好几个提供商里都有（${names}），写成 \`提供商/模型名字\`。` }
		}
		return {
			ok: false,
			error: `认不出模型 \`${raw}\`。写成 \`提供商/模型名字\`（发 \`模型\` 有卡片），例如 \`${groups[0].id}/${groups[0].models[0]?.id ?? '模型id'}\`。`,
		}
	}

	/**
	 * 把某个会话的模型切到 {provider, model}。
	 * @returns {Promise<{ok:true, selected:object}|{ok:false, error:string}>}
	 */
	async function set(sessionId, selection) {
		if (!available()) return { ok: false, error: '这个部署没有模型服务（`ctx.sessionController`）。' }
		const provider = String(selection?.provider ?? '').trim()
		const model = String(selection?.model ?? '').trim()
		if (!sessionId || !provider || !model) return { ok: false, error: '会话或模型没给全。' }
		try {
			const value = await service().selectModel({ sessionId, provider, model })
			logger?.info?.('已切换会话模型', { sessionId, provider, model })
			return { ok: true, selected: value?.selected ?? { provider, model } }
		} catch (error) {
			logger?.warn?.('切换会话模型失败', { sessionId, provider, model, error: String(error) })
			return { ok: false, error: `切换失败：${String(error?.message ?? error)}` }
		}
	}

	/** 人话描述一对模型（回执与卡片正文共用）。 */
	function describe(group, model) {
		if (!group || !model) return ''
		return `**${group.name} / ${model.name}**（\`${group.id}/${model.id}\`）`
	}

	return { available, catalog, current, effective, resolveToken, set, describe }
}
