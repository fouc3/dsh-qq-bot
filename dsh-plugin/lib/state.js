/**
 * 插件状态：绑定关系、上一张卡片、待发消息、白名单快照、已发通知。
 *
 * 落盘是原子写（临时文件 + rename，权限 0600）；读坏/读不到都不致命，
 * 回退到空状态并告警 —— 桥要能自己站起来，而不是因为一个状态文件卡住。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 空状态。字段与 docs/protocol.md 第 5 节的队列语义对应。 */
export const EMPTY_STATE = {
	bindings: {}, // openid -> sessionId | "none"
	lastCard: {}, // openid -> 上一张卡片消息 id
	delayed: {}, // sessionId -> { content, openid, at }
	whitelist: { openids: [] },
	notices: {}, // "sessionId:turn" -> true（结束通知去重）
	inbox: {}, // openid -> { sessionId, text, seq, items[] }（「发送」输入态）
	attachSeq: {}, // openid -> 已分配到的附件序号（附件 id 永不重用）
	pendingDir: {}, // openid -> { parent, at }（点了「新建目录」、正在等目录名）
}

function normalize(raw) {
	const base = {
		...EMPTY_STATE,
		bindings: {},
		lastCard: {},
		delayed: {},
		whitelist: { openids: [] },
		notices: {},
		inbox: {},
		attachSeq: {},
		pendingDir: {},
	}
	if (!raw || typeof raw !== 'object') return base
	for (const key of ['bindings', 'lastCard', 'delayed', 'inbox', 'attachSeq', 'pendingDir']) {
		if (raw[key] && typeof raw[key] === 'object') base[key] = { ...raw[key] }
	}
	if (raw.whitelist && typeof raw.whitelist === 'object' && Array.isArray(raw.whitelist.openids)) {
		base.whitelist = { openids: raw.whitelist.openids.filter((v) => typeof v === 'string' && v) }
	}
	if (raw.notices && typeof raw.notices === 'object') base.notices = { ...raw.notices }
	return base
}

function load(file, logger, seed) {
	if (seed && typeof seed === 'object') return seed
	if (!file || !existsSync(file)) return EMPTY_STATE
	try {
		return JSON.parse(readFileSync(file, 'utf8'))
	} catch (error) {
		logger?.warn?.('状态文件解析失败，按空状态启动', { file, error: String(error) })
		return EMPTY_STATE
	}
}

/**
 * 创建状态容器。
 * @param {{file?: string, logger?: object, seed?: object, debounceMs?: number}} options
 */
export function createState({ file, logger, seed, debounceMs = 200 } = {}) {
	const data = normalize(load(file, logger, seed))
	const debounce = Math.max(0, Number(debounceMs) || 0)
	let timer = null
	let dirty = false

	function write() {
		if (!file) {
			dirty = false
			return
		}
		const tmp = `${file}.tmp`
		try {
			mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
			writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
			renameSync(tmp, file)
			try {
				chmodSync(file, 0o600)
			} catch {
				// 某些文件系统不支持 chmod：不影响功能
			}
		} catch (error) {
			logger?.warn?.('写入状态文件失败', { file, error: String(error) })
			try {
				if (existsSync(tmp)) unlinkSync(tmp)
			} catch {
				// 忽略清理失败
			}
			return
		}
		dirty = false
	}

	function schedule() {
		if (!file) return
		if (timer) return
		timer = setTimeout(() => {
			timer = null
			if (dirty) write()
		}, debounce)
		if (typeof timer.unref === 'function') timer.unref()
	}

	return {
		get: () => data,
		/** 修改状态并安排一次落盘。 */
		update(mutator) {
			mutator(data)
			dirty = true
			schedule()
			return data
		},
		/** 立即落盘（停机/关键写入后调用）。 */
		flush() {
			if (timer) {
				clearTimeout(timer)
				timer = null
			}
			if (dirty) write()
		},
		dispose() {
			this.flush()
		},

		// ── 语义化小助手：让调用方不直接碰内部结构 ───────────────────────────
		bindingOf(openid) {
			const value = data.bindings[openid]
			return typeof value === 'string' && value ? value : null
		},
		setBinding(openid, sessionId) {
			return this.update((s) => {
				if (sessionId) s.bindings[openid] = sessionId
				else delete s.bindings[openid]
			})
		},
		setLastCard(openid, messageId) {
			return this.update((s) => {
				if (messageId) s.lastCard[openid] = messageId
				else delete s.lastCard[openid]
			})
		},
		lastCardOf(openid) {
			return data.lastCard[openid] ?? null
		},
		delayedOf(sessionId) {
			return data.delayed[sessionId] ?? null
		},
		setDelayed(sessionId, entry) {
			return this.update((s) => {
				s.delayed[sessionId] = entry
			})
		},
		takeDelayed(sessionId) {
			let taken = null
			this.update((s) => {
				taken = s.delayed[sessionId] ?? null
				delete s.delayed[sessionId]
			})
			return taken
		},
		setWhitelist(openids) {
			return this.update((s) => {
				s.whitelist = { openids: [...new Set(openids.filter(Boolean))] }
			})
		},
		whitelist() {
			return data.whitelist.openids
		},
		markNotice(key) {
			return this.update((s) => {
				s.notices[key] = true
				const keys = Object.keys(s.notices)
				if (keys.length > 500) {
					// 防止无限增长：只保留最近 200 条
					const keep = keys.slice(-200)
					s.notices = Object.fromEntries(keep.map((k) => [k, true]))
				}
			})
		},
		noticeSeen(key) {
			return Boolean(data.notices[key])
		},

		// ── 「发送」输入态（附件先入列，点卡片上的「发送」才投递） ─────────────
		inboxOf(openid) {
			const entry = data.inbox[openid]
			return entry && typeof entry === 'object' ? entry : null
		},
		setInbox(openid, entry) {
			return this.update((s) => {
				if (entry) s.inbox[openid] = entry
				else delete s.inbox[openid]
			})
		},
		clearInbox(openid) {
			return this.setInbox(openid, null)
		},
		/** 「新建目录」点了之后在等目录名。 */
		pendingDirOf(openid) {
			const entry = data.pendingDir[openid]
			return entry && typeof entry === 'object' ? entry : null
		},
		setPendingDir(openid, entry) {
			return this.update((s) => {
				if (entry) s.pendingDir[openid] = entry
				else delete s.pendingDir[openid]
			})
		},
		/** 分配下一个附件 id（`A1`、`A2`…，跨输入态单调递增，绝不重用）。 */
		nextAttachmentId(openid) {
			let id = ''
			this.update((s) => {
				const next = (Number(s.attachSeq[openid]) || 0) + 1
				s.attachSeq[openid] = next
				id = `A${next}`
			})
			return id
		},
	}
}
