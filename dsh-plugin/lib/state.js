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
	pendingModel: {}, // openid -> { provider, model, at }（点了「切到其他会话」、正在等会话id）
	createdSessions: {}, // sessionId -> cwd（本桥建出来的会话：用来补登记工作区）
	createdDirs: [], // 本桥建出来的目录（新建目录）：用来补登记工作区
	sessionOwners: {}, // sessionId -> openid（最近一次从 QQ 跟这个会话说过话的人）
	// 唤醒链：sessionId -> 'qq'（当前这条链是从 QQ 用户唤醒起的，目标/计划续跑的轮次也算）。
	chainWakes: {},
	// 快捷（命令 `快捷`）：openid -> { seq, items: [{ id, sessionId, name, at }] }。
	// `id` 是按钮上那个 `#数字编号`：**只增不重用**（删掉 #2 后 #3 仍是原来那个会话），
	// 否则用户记在脑子里的编号会悄悄指到别的会话。`name` 是自定义备注（空 = 用会话标题）。
	shortcuts: {},
	// 插件自己的"小日志"：最近 40 条关键决策（轮次认领/结束、通知入队或跳过、agent 挂载）。
	// 为什么放状态里：**插件日志进不了 journald**（dsh-web 只把启动几行写进 journal），
	// 线上排查"结束通知怎么不发了"这种问题，只有这里能看见插件当时是怎么判断的。
	notes: [],
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
		pendingModel: {},
		createdSessions: {},
		createdDirs: [],
		sessionOwners: {},
		chainWakes: {},
		shortcuts: {},
	}
	if (!raw || typeof raw !== 'object') return base
	for (const key of ['bindings', 'lastCard', 'delayed', 'inbox', 'attachSeq', 'pendingDir', 'pendingModel', 'createdSessions', 'sessionOwners', 'chainWakes', 'shortcuts']) {
		if (raw[key] && typeof raw[key] === 'object') base[key] = { ...raw[key] }
	}
	if (Array.isArray(raw.createdDirs)) base.createdDirs = raw.createdDirs.filter((item) => typeof item === 'string' && item)
	if (Array.isArray(raw.notes)) base.notes = raw.notes.slice(-40)
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
				if (entry) {
					// 两种"等一条消息"的状态不能同时挂：后设的把前一个顶掉。
					delete s.pendingModel[openid]
					s.pendingDir[openid] = entry
				} else {
					delete s.pendingDir[openid]
				}
			})
		},
		/** 「切到其他会话」点了之后在等会话id（模型卡片第二级确认里的交互式分支）。 */
		pendingModelOf(openid) {
			const entry = data.pendingModel[openid]
			return entry && typeof entry === 'object' ? entry : null
		},
		setPendingModel(openid, entry) {
			return this.update((s) => {
				if (entry) {
					delete s.pendingDir[openid]
					s.pendingModel[openid] = entry
				} else {
					delete s.pendingModel[openid]
				}
			})
		},
		/** 记一笔"这个会话是本桥建的"（启动时用来补登记它的工作区）。 */
		markCreatedSession(sessionId, cwd) {
			if (!sessionId || !cwd) return
			return this.update((s) => {
				s.createdSessions[sessionId] = cwd
			})
		},
		/**
		 * 记一条"插件当时的判断"（有上限，最后 40 条）。
		 *
		 * 线上排查用：dsh 只把插件日志写在进程里，journald 里看不到，所以关键决策
		 * （认领到哪一轮、为什么发/不发结束通知、agent 是不是换了实例）落到状态文件里。
		 */
		note(text) {
			const entry = `${new Date().toISOString().slice(11, 19)} ${String(text).slice(0, 160)}`
			return this.update((s) => {
				s.notes = [...(s.notes ?? []), entry].slice(-40)
			})
		},
		notes() {
			return [...(data.notes ?? [])]
		},
		createdSessions() {
			return { ...data.createdSessions }
		},
		/** 记一笔"这个目录是本桥建的"。 */
		markCreatedDir(path) {
			if (!path) return
			return this.update((s) => {
				if (!s.createdDirs.includes(path)) s.createdDirs = [...s.createdDirs, path].slice(-50)
			})
		},
		createdDirs() {
			return [...data.createdDirs]
		},
		/**
		 * 记下"最近一次从 QQ 跟这个会话说过话的人"。
		 *
		 * 为什么需要：`发送 <会话id> <内容>` / 输入态可以往**非绑定会话**投递，
		 * 那时候 AI 用 `qq_reply` 回话不能因为"当前绑定不是它"就拒绝
		 * （线上踩过：显式指定的会话回不了 QQ，报"该会话当前没有绑定 QQ 私聊"）。
		 */
		rememberSessionOwner(sessionId, openid) {
			if (!sessionId || !openid) return
			return this.update((s) => {
				s.sessionOwners[sessionId] = openid
			})
		},
		sessionOwnerOf(sessionId) {
			const owner = data.sessionOwners?.[sessionId]
			return typeof owner === 'string' && owner ? owner : null
		},
		/**
		 * 「这一轮的唤醒链是不是从 QQ 用户起的」——`qq` = 用户从 QQ 唤醒的那条链还在延续，
		 * 空串/无 = 不是（例如在 dsh web 里新起的一轮，或从来没从 QQ 说过话）。
		 *
		 * 为什么要记：目标/计划**自动续跑**出来的轮次不是用户发起的，但用户要求
		 * "只要唤醒链能追到用户唤醒的那一轮，就按用户唤醒算"（也要发结束通知）。
		 */
		setChainWake(sessionId, kind = '') {
			if (!sessionId) return
			return this.update((s) => {
				if (kind) s.chainWakes[sessionId] = kind
				else delete s.chainWakes[sessionId]
			})
		},
		chainWakeOf(sessionId) {
			const kind = data.chainWakes?.[sessionId]
			return typeof kind === 'string' ? kind : ''
		},

		// ── 快捷（自带 #编号 + 自定义备注） ─────────────────────────────────
		/** 某人的快捷列表（拷贝，调用方改不坏状态）。 */
		shortcutsOf(openid) {
			const book = data.shortcuts?.[openid]
			if (!book || !Array.isArray(book.items)) return []
			return book.items
				.filter((item) => item && typeof item === 'object' && item.sessionId)
				.map((item) => ({ ...item }))
		},
		/**
		 * 加一条（同一个会话只留一条：已在列表里就更新备注）。
		 * @returns {{item:object, existed:boolean}}
		 */
		addShortcut(openid, { sessionId, name = '' } = {}) {
			if (!openid || !sessionId) return null
			let result = null
			this.update((s) => {
				// 读坏的状态文件（shortcuts 不是对象/items 不是数组）在这里自愈，不抛错。
				const book = s.shortcuts?.[openid]
				const items = Array.isArray(book?.items) ? book.items : []
				const seq = Number(book?.seq) || 0
				const existing = items.find((item) => item?.sessionId === sessionId)
				if (existing) {
					if (name) existing.name = name
					result = { item: { ...existing }, existed: true }
				} else {
					const item = { id: seq + 1, sessionId, name: name || '', at: new Date().toISOString() }
					items.push(item)
					result = { item: { ...item }, existed: false }
				}
				s.shortcuts[openid] = { seq: Math.max(seq, result.item.id), items }
			})
			return result
		},
		/** 改备注。找不到返回 null。 */
		renameShortcut(openid, id, name) {
			let found = null
			this.update((s) => {
				const items = s.shortcuts?.[openid]?.items
				if (!Array.isArray(items)) return
				const item = items.find((entry) => Number(entry?.id) === Number(id))
				if (!item) return
				item.name = name || ''
				found = { ...item }
			})
			return found
		},
		/** 删一条。找不到返回 null（**不补位**：编号只增不重用）。 */
		removeShortcut(openid, id) {
			let found = null
			this.update((s) => {
				const book = s.shortcuts?.[openid]
				if (!book || !Array.isArray(book.items)) return
				const index = book.items.findIndex((entry) => Number(entry?.id) === Number(id))
				if (index < 0) return
				found = { ...book.items[index] }
				book.items.splice(index, 1)
			})
			return found
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
