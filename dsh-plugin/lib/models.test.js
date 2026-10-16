import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createModels, splitOnce } from './models.js'

/** 一份两提供商的假目录。 */
const GROUPS = [
	{
		id: 'deepseek',
		name: 'DeepSeek',
		models: [
			{ id: 'deepseek-chat', name: 'DeepSeek Chat', description: '通用对话' },
			{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: '深度推理' },
		],
	},
	{
		id: 'openai',
		name: 'OpenAI',
		models: [
			{ id: 'gpt-5.2', name: 'GPT 5.2', description: '' },
			{ id: 'gpt-5.2-codex', name: 'GPT 5.2 Codex', description: '' },
		],
	},
]

/**
 * 假的 `ctx.sessionController`。
 *
 * @param {object} [options]
 * @param {boolean} [options.present] 服务是否存在
 * @param {boolean} [options.throwOnCatalog] 读目录是否抛
 * @param {object} [options.projections] sessionId → `model/selection` 投影值
 * @param {string} [options.selectError] selectModel 抛错的文本
 * @param {object} [options.events] sessionId → 会话日志事件数组（`inspect()` 的返回）
 * @param {boolean} [options.inspectThrows] `inspect()` 是否抛
 * @param {object} [options.defaultModel] 部署默认模型（`agentDefaultModel.currentSelection()`）
 */
function fakeCtx({
	present = true,
	throwOnCatalog = false,
	projections = {},
	selectError = '',
	events = {},
	inspectThrows = false,
	defaultModel = null,
} = {}) {
	const calls = { set: [], projections: [], inspect: [] }
	const service = {
		async modelCatalog() {
			if (throwOnCatalog) throw new Error('目录炸了')
			return {
				default: { provider: 'deepseek', model: 'deepseek-chat' },
				routableProviders: GROUPS.map((group) => group.id),
				groups: GROUPS,
				failures: [{ id: 'broken', name: 'Broken', message: '没 key' }],
			}
		},
		async selectModel(request) {
			calls.set.push(request)
			if (selectError) throw new Error(selectError)
			return { selected: { provider: request.provider, model: request.model } }
		},
		async projections(request) {
			calls.projections.push(request.sessionId)
			const value = projections[request.sessionId]
			if (value === undefined) return null
			return { asOfSeq: 7, values: { 'model/selection': value } }
		},
		async inspect(sessionId) {
			calls.inspect.push(sessionId)
			if (inspectThrows) throw new Error('日志读不了')
			const list = events[sessionId]
			return { meta: { id: sessionId }, events: list === undefined ? [] : list }
		},
	}
	const ctx = {
		get: (name) => {
			if (present && name === 'sessionController') return service
			if (defaultModel && name === 'agentDefaultModel') return { currentSelection: () => defaultModel }
			return undefined
		},
	}
	return { ctx, calls }
}

/** 造一条 `request/header` 事件（模型藏在 `data.header.config` 里，与真实日志一致）。 */
function headerEvent(provider, model) {
	return { type: 'request/header', seq: 1, data: { header: { config: { provider, model, maxTokens: 384000 } } } }
}

test('模型：读目录（归一化 + 失败提供商如实带上），没有服务时退化成"用不了"', async () => {
	const { ctx } = fakeCtx()
	const models = createModels({ ctx })
	assert.equal(models.available(), true)
	const catalog = await models.catalog()
	assert.equal(catalog.ok, true)
	assert.deepEqual(catalog.groups.map((group) => group.id), ['deepseek', 'openai'])
	assert.equal(catalog.groups[0].models[0].name, 'DeepSeek Chat')
	assert.equal(catalog.groups[0].models[0].description, '通用对话')
	assert.deepEqual(catalog.failures.map((item) => item.name), ['Broken'])
	assert.equal(catalog.default.model, 'deepseek-chat')

	const absent = createModels({ ctx: { get: () => undefined } })
	assert.equal(absent.available(), false)
	const missing = await absent.catalog()
	assert.equal(missing.ok, false)
	assert.match(missing.error, /没有模型服务/)

	const broken = createModels({ ctx: fakeCtx({ throwOnCatalog: true }).ctx })
	const failed = await broken.catalog()
	assert.equal(failed.ok, false, '读目录出错要如实失败，不能假装空目录')
	assert.match(failed.error, /读取模型目录失败/)
})

test('模型：当前模型取 pending 优先、其次 lastUsed；读不到就是 null', async () => {
	const { ctx, calls } = fakeCtx({
		projections: {
			'session-a': { lastUsed: { provider: 'deepseek', model: 'deepseek-chat' }, pending: null },
			'session-b': {
				lastUsed: { provider: 'deepseek', model: 'deepseek-chat' },
				pending: { provider: 'openai', model: 'gpt-5.2' },
			},
		},
	})
	const models = createModels({ ctx })
	assert.deepEqual(await models.current('session-a'), { provider: 'deepseek', model: 'deepseek-chat' })
	assert.deepEqual(await models.current('session-b'), { provider: 'openai', model: 'gpt-5.2' }, 'pending 优先')
	assert.equal(await models.current('session-none'), null, '没有投影就是 null（卡片不标当前）')
	assert.equal(await models.current(''), null)
	assert.ok(calls.projections.includes('session-a'))
})

// 线上反馈：`状态` 卡的「模型」对没点过模型选择器的会话一直显示「（读不到）」。
// `effective()` 补两级兜底：会话日志里**真正用过**的（冷会话也能读）→ 部署默认（标注出来）。
test('模型：effective 依次取 选择 → 会话日志里用过的 → 部署默认，不会因为没选过就"读不到"', async () => {
	const { ctx, calls } = fakeCtx({
		projections: { 'session-chosen': { lastUsed: { provider: 'openai', model: 'gpt-5.2' }, pending: null } },
		events: {
			// 只有历史请求头、没有选择投影 —— 目标链里长期在跑的会话就是这样
			'session-used': [
				headerEvent('deepseek', 'deepseek-chat'),
				{ type: 'turn/start', seq: 2, data: { turn: 1 } },
				headerEvent('apple-tokenplan', 'deepseek-v4.1-flash'),
			],
			// 从没跑过（连请求头都没有）的会话
			'session-fresh': [{ type: 'session/start', seq: 1, data: {} }],
		},
		defaultModel: { provider: 'f', model: 'deepseek-v4.1-flash' },
	})
	const models = createModels({ ctx })

	assert.deepEqual(await models.effective('session-chosen'), {
		provider: 'openai',
		model: 'gpt-5.2',
		source: 'selection',
	})
	assert.deepEqual(
		await models.effective('session-used'),
		{ provider: 'apple-tokenplan', model: 'deepseek-v4.1-flash', source: 'log' },
		'取最后一次请求头（最新那个），不是第一次',
	)
	assert.deepEqual(
		await models.effective('session-fresh'),
		{ provider: 'f', model: 'deepseek-v4.1-flash', source: 'default' },
		'还没跑过就报部署默认（卡片会注明）',
	)
	assert.equal(await models.effective(''), null)
	assert.ok(calls.inspect.includes('session-used'), '兜底真的读了会话日志（inspect）')
})

test('模型：effective 的每一级失败都不致命（inspect 抛错 / 没有默认 / 没有服务 → null）', async () => {
	// inspect 抛错：仍然可以退到部署默认
	const throwing = fakeCtx({ inspectThrows: true, defaultModel: { provider: 'f', model: 'x' } })
	const modelsA = createModels({ ctx: throwing.ctx })
	assert.deepEqual(await modelsA.effective('session-1'), { provider: 'f', model: 'x', source: 'default' })

	// 什么都读不到（没有默认、日志空）→ null（卡片才会写「读不到」）
	const bare = fakeCtx()
	assert.equal(await createModels({ ctx: bare.ctx }).effective('session-1'), null)

	// 连服务都没有 → null，不能抛
	const none = fakeCtx({ present: false })
	assert.equal(await createModels({ ctx: none.ctx }).effective('session-1'), null)
})

test('模型：解析 `提供商/模型名字`（id/显示名/序号都认）', async () => {
	const { ctx } = fakeCtx()
	const models = createModels({ ctx })
	const { groups } = await models.catalog()
	const cases = [
		['deepseek/deepseek-chat', 'deepseek', 'deepseek-chat'],
		['deepseek/DeepSeek Reasoner', 'deepseek', 'deepseek-reasoner'],
		['DeepSeek/chat', 'deepseek', 'deepseek-chat'],
		['deepseek/2', 'deepseek', 'deepseek-reasoner'],
		['2/1', 'openai', 'gpt-5.2'],
		['openai/GPT 5.2 Codex', 'openai', 'gpt-5.2-codex'],
		['openai/gpt52codex', 'openai', 'gpt-5.2-codex'],
	]
	for (const [spec, provider, model] of cases) {
		const out = models.resolveToken(spec, groups)
		assert.equal(out.ok, true, `${spec} 应能解析：${out.error ?? ''}`)
		assert.equal(out.group.id, provider, spec)
		assert.equal(out.model.id, model, spec)
		assert.match(out.text, new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
	}
})

test('模型：不带斜杠时——是全库唯一的模型才认，提供商/歧义/认不出都要说清', async () => {
	const { ctx } = fakeCtx()
	const models = createModels({ ctx })
	const { groups } = await models.catalog()

	const unique = models.resolveToken('deepseek-reasoner', groups)
	assert.equal(unique.ok, true)
	assert.equal(unique.model.id, 'deepseek-reasoner')

	// 只写了提供商：要提示补模型名字
	const providerOnly = models.resolveToken('deepseek', groups)
	assert.equal(providerOnly.ok, false)
	assert.match(providerOnly.error, /还差模型名字/)
	assert.match(providerOnly.error, /deepseek\/<模型名字>/)

	// 认不出
	const unknown = models.resolveToken('不存在的模型', groups)
	assert.equal(unknown.ok, false)
	assert.match(unknown.error, /认不出模型/)
	assert.match(unknown.error, /deepseek\/deepseek-chat/, '要给一个能照着抄的例子')

	// 有歧义：`gpt` 在 openai 里能对上两个 → 报歧义（而不是随便挑一个）
	const ambiguous = models.resolveToken('gpt', groups)
	assert.equal(ambiguous.ok, false)
	assert.match(ambiguous.error, /能对上好几个|在好几个提供商里都有/)

	assert.equal(models.resolveToken('', groups).ok, false)
	assert.equal(models.resolveToken('deepseek/chat', []).ok, false, '空目录时直接失败')
	assert.equal(models.resolveToken('deepseek/', groups).ok, false, '缺模型名字')
	assert.equal(models.resolveToken('/chat', groups).ok, false, '缺提供商')
})

test('模型：切换会话模型（成功记下出参，失败如实回报）', async () => {
	const okCtx = fakeCtx()
	const models = createModels({ ctx: okCtx.ctx })
	const ok = await models.set('session-1', { provider: 'openai', model: 'gpt-5.2' })
	assert.equal(ok.ok, true)
	assert.deepEqual(okCtx.calls.set, [{ sessionId: 'session-1', provider: 'openai', model: 'gpt-5.2' }])

	const bad = createModels({ ctx: fakeCtx({ selectError: '这个会话锁定了模型' }).ctx })
	const failed = await bad.set('session-1', { provider: 'openai', model: 'gpt-5.2' })
	assert.equal(failed.ok, false)
	assert.match(failed.error, /这个会话锁定了模型/)

	assert.equal((await models.set('', { provider: 'a', model: 'b' })).ok, false)
	assert.equal((await models.set('s', { provider: 'a' })).ok, false)
})

test('splitOnce：按第一个分隔符切两段（模型卡片回调 data 用）', () => {
	assert.deepEqual(splitOnce('deepseek:deepseek-chat'), ['deepseek', 'deepseek-chat'])
	assert.deepEqual(splitOnce('deepseek:2'), ['deepseek', '2'])
	assert.deepEqual(splitOnce('deepseek'), ['deepseek', ''])
	assert.deepEqual(splitOnce(''), ['', ''])
})
