/**
 * 「发送」输入态（俗称"输入框"）：附件先收进来，点预览卡片上的「发送」才交给 AI。
 *
 * 为什么要有这一层：QQ 私聊里没有真正的输入框，用户没法"先挂一张图、再打字说要求"。
 * 所以进入输入态后，用户发的文字与附件都先攒着，机器人回一张预览卡片
 * （每个附件带自己的「删除」按钮），点卡片上的「发送」才把正文 + 附件一起投给 AI。
 *
 * 纪律与取舍：
 *   - 附件默认**自动下载**到 dsh 附件服务（Web 端粘贴同款：图片走视觉、文件给只读副本路径），
 *     单条超过 `maxAttachmentBytes` 就不自动下载，只登记 url，让模型需要时调工具拉；
 *   - 语音**只取平台的转写文本**（`asrText`），本地不做识别；拿不到转写就标记成
 *     「无法识别」并**拦住发送**，直到用户把它删掉（用户明确要求）；
 *   - 下不下来的附件不吞掉：状态记成 failed/oversize，卡片上写清楚，模型可以用
 *     `qq_fetch_attachment` 再试一次（平台的签名直链过期是常态）。
 */

/** 自动下载上限的默认值（插件配置 `maxAttachmentBytes` 可覆盖）。 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
/** 模型主动拉取时的上限（比自动下载宽松，但仍然要有边界）。 */
export const DEFAULT_MAX_FETCH_BYTES = 500 * 1024 * 1024

/** 附件状态。 */
export const ATTACH_STATUS = {
	/** 已下载并存进 dsh 附件服务，有 ref 可用。 */
	stored: 'stored',
	/** 超过自动下载上限，只有 url（模型可以用工具拉）。 */
	oversize: 'oversize',
	/** 自动下载失败（链接过期/网络问题），只有 url。 */
	failed: 'failed',
	/** 语音：有平台转写文本。 */
	voice: 'voice',
	/** 语音：平台没有给转写，**拦住发送**直到删除。 */
	voiceUnrecognized: 'voice-unrecognized',
}

/** 正文总量上限：防止有人往输入态里灌一部长篇小说。 */
const MAX_TEXT_CHARS = 20_000

const asBytes = (value) => {
	const size = Number(value)
	return Number.isFinite(size) && size > 0 ? size : 0
}

/** 人类可读的字节数。 */
export function formatBytes(size) {
	const bytes = asBytes(size)
	if (!bytes) return ''
	const units = ['B', 'KB', 'MB', 'GB']
	let value = bytes
	let unit = 0
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024
		unit += 1
	}
	const shown = unit === 0 ? String(value) : value.toFixed(1)
	return `${shown} ${units[unit]}`
}

/** 平台 content_type → dsh 图片服务认的 mediaType。 */
function imageMediaType(contentType) {
	const lower = String(contentType ?? '').toLowerCase()
	if (lower === 'image/jpeg' || lower === 'image/jpg') return 'image/jpeg'
	if (lower === 'image/png') return 'image/png'
	if (lower === 'image/gif') return 'image/gif'
	return ''
}

/** 把响应体读成字节，超过 cap 直接抛（别把宿主机内存吃干）。 */
async function readCapped(response, cap) {
	const declared = asBytes(response.headers?.get?.('content-length'))
	if (declared && cap && declared > cap) throw new Error(`附件 ${formatBytes(declared)} 超过上限 ${formatBytes(cap)}`)
	const chunks = []
	let total = 0
	for await (const chunk of response.body ?? []) {
		total += chunk.length
		if (cap && total > cap) throw new Error(`附件超过上限 ${formatBytes(cap)}`)
		chunks.push(chunk)
	}
	return new Uint8Array(Buffer.concat(chunks))
}

/** 把响应体流式写进附件服务（大文件用，避免整份进内存）。 */
function streamCapped(response, cap) {
	async function* body() {
		let total = 0
		for await (const chunk of response.body ?? []) {
			total += chunk.length
			if (cap && total > cap) throw new Error(`附件超过上限 ${formatBytes(cap)}`)
			yield chunk
		}
	}
	return body()
}

/**
 * 创建输入态管理器。
 *
 * @param {object} deps
 * @param {object} deps.state 插件状态容器（`inboxOf`/`setInbox`/`nextAttachmentId`）
 * @param {object} deps.attachments dsh 附件服务（`saveImages`/`saveFileStream`/`fileHostPath`）
 * @param {object} [deps.config]
 * @param {object} [deps.logger]
 * @param {Function} [deps.fetchImpl]
 */
export function createInbox({ state, attachments, config = {}, logger, fetchImpl = globalThis.fetch }) {
	const autoCap = asBytes(config.maxAttachmentBytes) || DEFAULT_MAX_ATTACHMENT_BYTES
	const fetchCap = asBytes(config.maxFetchBytes) || DEFAULT_MAX_FETCH_BYTES
	/** sessionId → 最近一次投递的附件（模型调工具时按 id 找回）。 */
	const deliveries = new Map()

	function clone(items) {
		return (items ?? []).map((item) => ({ ...item }))
	}

	function entryOf(openid) {
		const entry = state.inboxOf(openid)
		if (!entry) return null
		return {
			sessionId: entry.sessionId ?? null,
			mode: entry.mode === 'delay' ? 'delay' : 'send',
			segments: [...(entry.segments ?? [])],
			items: clone(entry.items),
			seq: Number(entry.seq) || 0,
		}
	}

	function save(openid, entry) {
		state.setInbox(openid, entry)
		return entry
	}

	function textOf(entry) {
		return (entry?.segments ?? []).join('\n\n').trim()
	}

	/**
	 * 进入输入态。
	 *
	 * 同一个会话重复进入不清空（`发送` 与 `延迟发送` 只是**投递方式**不同，
	 * 切换方式时攒好的正文/附件照样留着）；换了会话才重置。
	 *
	 * @param {{openid:string, sessionId:string, mode?:'send'|'delay'}} input
	 */
	function begin({ openid, sessionId, mode = 'send' }) {
		const wanted = mode === 'delay' ? 'delay' : 'send'
		const existing = entryOf(openid)
		if (existing && existing.sessionId === sessionId) {
			if (existing.mode !== wanted) save(openid, { ...existing, mode: wanted })
			return { ...existing, mode: wanted }
		}
		return save(openid, { sessionId, mode: wanted, segments: [], items: [], seq: 0 })
	}

	function active(openid) {
		return entryOf(openid)
	}

	/** 追加一段正文（多条文字拼成一条，边想边打）。 */
	function appendText({ openid, text }) {
		const entry = entryOf(openid)
		if (!entry) return null
		const content = String(text ?? '').trim()
		if (!content) return entry
		const joined = [...entry.segments, content].join('\n\n')
		entry.segments = [joined.length > MAX_TEXT_CHARS ? joined.slice(0, MAX_TEXT_CHARS) : joined]
		return save(openid, entry)
	}

	function clearText({ openid }) {
		const entry = entryOf(openid)
		if (!entry) return null
		entry.segments = []
		return save(openid, entry)
	}

	async function storeOne(item, { cap }) {
		const response = await fetchImpl(item.url)
		if (!response?.ok) throw new Error(`下载附件失败：HTTP ${response?.status ?? '???'}`)
		const mediaType = imageMediaType(item.contentType)
		if (mediaType && item.kind === 'image') {
			const data = await readCapped(response, cap)
			const refs = await attachments.saveImages([{ data, mediaType, name: item.filename || undefined }])
			const ref = refs?.[0]
			if (!ref) throw new Error('保存图片没有返回引用')
			item.status = ATTACH_STATUS.stored
			item.ref = ref
			item.image = true
			return item
		}
		const ref = await attachments.saveFileStream({ data: streamCapped(response, cap), name: item.filename || undefined })
		if (!ref) throw new Error('保存文件没有返回引用')
		item.status = ATTACH_STATUS.stored
		item.ref = ref
		return item
	}

	/** 收一个附件：语音只留转写，其余按大小决定是否自动下载。 */
	async function addOne(openid, entry, raw) {
		const id = state.nextAttachmentId(openid)
		const item = {
			id,
			kind: String(raw?.kind ?? 'unknown'),
			contentType: String(raw?.contentType ?? ''),
			filename: String(raw?.filename ?? ''),
			size: asBytes(raw?.size),
			url: String(raw?.url ?? ''),
			asrText: String(raw?.asrText ?? ''),
			status: ATTACH_STATUS.failed,
			note: '',
			ref: null,
		}
		if (item.kind === 'voice') {
			// 语音**不下载音频**：只认平台转写。没转写就拦住发送，等用户删掉。
			item.status = item.asrText ? ATTACH_STATUS.voice : ATTACH_STATUS.voiceUnrecognized
			item.note = item.asrText ? '' : '平台没有给出转写文本'
			return item
		}
		if (item.size && item.size > autoCap) {
			item.status = ATTACH_STATUS.oversize
			item.note = `${formatBytes(item.size)} 超过自动下载上限 ${formatBytes(autoCap)}`
			return item
		}
		try {
			return await storeOne(item, { cap: autoCap })
		} catch (error) {
			item.status = ATTACH_STATUS.failed
			item.note = `自动下载失败：${String(error?.message ?? error)}`
			logger?.warn?.('附件自动下载失败', { id, filename: item.filename, error: item.note })
			return item
		}
	}

	async function addAttachments({ openid, attachments: list }) {
		const entry = entryOf(openid)
		if (!entry) return null
		for (const raw of list ?? []) {
			entry.items.push(await addOne(openid, entry, raw))
		}
		save(openid, entry)
		return entry
	}

	function removeItem({ openid, itemId }) {
		const entry = entryOf(openid)
		if (!entry) return null
		entry.items = entry.items.filter((item) => item.id !== itemId)
		return save(openid, entry)
	}

	/** 清空并退出输入态；返回被丢弃的内容（调用方决定要不要提示）。 */
	function drain({ openid }) {
		const entry = entryOf(openid)
		state.clearInbox(openid)
		return entry
	}

	/** 有没有"拦路"的附件（现在只有：平台没给转写的语音）。 */
	function blockingVoice(entry) {
		return (entry?.items ?? []).filter((item) => item.status === ATTACH_STATUS.voiceUnrecognized)
	}

	/** 有平台转写的语音条目：它们只以**文本**进消息，不算"附件"（别再去列"未下载"）。 */
	function voiceItems(entry) {
		return (entry?.items ?? []).filter((item) => item.status === ATTACH_STATUS.voice && item.asrText)
	}

	/** 语音转写（独立一段，优先级高于其它附件）。 */
	function voiceText(entry) {
		return voiceItems(entry).map((item) => item.asrText)
	}

	function storedFiles(entry) {
		return (entry?.items ?? []).filter((item) => item.status === ATTACH_STATUS.stored && !item.image)
	}

	function storedImages(entry) {
		return (entry?.items ?? []).filter((item) => item.status === ATTACH_STATUS.stored && item.image)
	}

	function unavailable(entry) {
		return (entry?.items ?? []).filter(
			(item) => item.status === ATTACH_STATUS.oversize || item.status === ATTACH_STATUS.failed,
		)
	}

	/** 记住这次投递的附件，模型调 `qq_fetch_attachment` 时按 id 找回。 */
	function rememberDelivery({ sessionId, items }) {
		if (!sessionId) return
		deliveries.set(sessionId, clone(items))
	}

	function lookupDelivery({ sessionId, itemId }) {
		const items = deliveries.get(sessionId) ?? []
		return items.find((item) => item.id === itemId) ?? null
	}

	/**
	 * 模型要一份当期没有自动下载的附件：拉下来存进附件服务。
	 * @returns {Promise<{ok:boolean, item?:object, hostPath?:string, error?:string}>}
	 */
	async function fetchForModel({ sessionId, itemId }) {
		const item = lookupDelivery({ sessionId, itemId })
		if (!item) return { ok: false, error: `本次投递里没有附件 ${itemId}（附件 id 只在当次消息里有效）` }
		if (item.status === ATTACH_STATUS.stored) {
			const hostPath = item.ref && attachments.fileHostPath ? attachments.fileHostPath(item.ref) : undefined
			return { ok: true, item, hostPath }
		}
		if (!item.url) return { ok: false, error: `附件 ${itemId} 没有下载地址` }
		try {
			const stored = await storeOne({ ...item }, { cap: fetchCap })
			item.status = stored.status
			item.ref = stored.ref
			item.image = stored.image
			const items = deliveries.get(sessionId) ?? []
			deliveries.set(
				sessionId,
				items.map((entry) => (entry.id === itemId ? { ...item } : entry)),
			)
			const hostPath = item.ref && attachments.fileHostPath ? attachments.fileHostPath(item.ref) : undefined
			return { ok: true, item, hostPath }
		} catch (error) {
			return { ok: false, error: `下载失败：${String(error?.message ?? error)}` }
		}
	}

	return {
		begin,
		active,
		appendText,
		clearText,
		addAttachments,
		removeItem,
		drain,
		textOf,
		blockingVoice,
		voiceText,
		voiceItems,
		storedFiles,
		storedImages,
		unavailable,
		rememberDelivery,
		lookupDelivery,
		fetchForModel,
		/** 测试与诊断用。 */
		_snapshot: () => ({ autoCap, fetchCap, deliveries: [...deliveries.keys()] }),
	}
}
