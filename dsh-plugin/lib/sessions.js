/**
 * 会话索引与标题。
 *
 * 索引来源：启动时 page 一遍 sessionController.list()，之后靠 api-session/* 事件增量维护；
 * 归档会话（workspaceRegistry.archivedSessionIds）一律过滤掉 —— 它们被 dsh 的
 * 归档门禁止跑模型步，列出来只会让用户白点。
 *
 * 标题来源（用于「标题(会话id)」这种显示）：
 *   1. 持久事件 session/title（latest-wins，权威）；
 *   2. summary.projections.values.title（冷会话的缓存投影）；
 *   3. 兜底：cwd 的最后一段 → 会话 id。
 */
import * as nodePath from 'node:path'

import { expandHome } from './home.js'

/**
 * @param {object} options
 * @param {object} options.ctx dsh 上下文（要 sessionController.list / on / workspaceRegistry）
 * @param {object} options.logger
 * @param {'full'|'short'} [options.idStyle]
 * @param {object} [options.path] 注入的 node:path（默认本平台的；测试里注入 win32 验盘符路径）
 */
export function createSessions({ ctx, logger, idStyle = 'full', path: pathOps = nodePath }) {
	const sep = pathOps.sep
	const byId = new Map()
	const titles = new Map()
	let refreshedAt = 0

	/** 平台根：POSIX 是 `/`，Windows 是当前盘的 `C:\`。 */
	function platformRoot() {
		return pathOps.parse(process.cwd()).root || sep
	}

	/** 是不是某个"根"（`/` 或 `C:\`）。 */
	function isRoot(value) {
		return typeof value === 'string' && value !== '' && pathOps.parse(value).root === value
	}

	/** dir 是否等于 prefix 或在其之下（根后面不再补分隔符）。 */
	function isUnder(dir, prefix) {
		return dir === prefix || dir.startsWith(isRoot(prefix) ? prefix : `${prefix}${sep}`)
	}

	/** 拼一层子目录。 */
	function childPath(base, name) {
		return isRoot(base) ? `${base}${name}` : `${base}${sep}${name}`
	}

	/**
	 * 目录归一：展开 `~`、补成绝对路径、按平台规范分隔符与结尾。
	 *
	 * 以前是写死的 POSIX 逻辑（不是 `/` 开头就加 `/`），Windows 上 `C:\Users\x`
	 * 会被改成 `/C:\Users\x`，于是目录树、默认根、按目录归组全乱。
	 */
	function normalizeDir(dir) {
		if (typeof dir !== 'string' || !dir) return platformRoot()
		const value = expandHome(dir)
		const absolute = pathOps.isAbsolute(value) ? value : `${sep}${value}`
		// path.normalize 会把分隔符统一、但**保留结尾分隔符**（'/a/b/' 还是 '/a/b/'），
		// 这里再按平台去掉多余的结尾（根不动）。
		let normalized = pathOps.normalize(absolute)
		while (normalized.length > 1 && !isRoot(normalized) && (normalized.endsWith(sep) || normalized.endsWith('/'))) {
			normalized = normalized.slice(0, -1)
		}
		return normalized
	}

	function displayId(sessionId) {
		if (idStyle === 'short') return String(sessionId).replace(/^session-/, '')
		return String(sessionId)
	}

	function recordTitle(sessionId, title) {
		if (!sessionId || typeof title !== 'string' || !title.trim()) return
		titles.set(sessionId, title.trim())
	}

	function upsert(summary) {
		if (!summary?.sessionId) return
		const previous = byId.get(summary.sessionId) ?? {}
		byId.set(summary.sessionId, { ...previous, ...summary })
		const projected = summary.projections?.values?.title
		if (typeof projected === 'string' && projected.trim()) recordTitle(summary.sessionId, projected)
	}

	/** 一次性播种：从某个活会话的 durable log 里找最后一条 session/title。 */
	function seedTitle(session) {
		if (!session || titles.has(session.id)) return
		try {
			const events = session.events ?? []
			for (let i = events.length - 1; i >= 0; i -= 1) {
				const event = events[i]
				if (event?.type === 'session/title' && event.data?.title) {
					recordTitle(session.id, event.data.title)
					return
				}
			}
		} catch (error) {
			logger?.debug?.('播种会话标题失败（忽略）', { error: String(error) })
		}
	}

	async function refresh() {
		try {
			let cursor
			for (let page = 0; page < 50; page += 1) {
				const value = await ctx.sessionController.list(cursor ? { cursor } : {}, new AbortController().signal)
				for (const summary of value?.items ?? []) upsert(summary)
				cursor = value?.nextCursor
				if (!cursor || value?.isEnd) break
			}
			refreshedAt = Date.now()
			logger?.info?.('会话索引已建立', { sessions: byId.size })
		} catch (error) {
			logger?.warn?.('读取会话列表失败', { error: String(error) })
		}
	}

	function subscribe() {
		const disposers = []
		const on = (name, handler) => {
			try {
				disposers.push(ctx.on(name, handler))
			} catch (error) {
				logger?.warn?.('订阅会话事件失败', { name, error: String(error) })
			}
		}
		on('api-session/added', (summary) => upsert(summary))
		on('api-session/removed', (sessionId) => byId.delete(sessionId))
		on('api-session/activity', (sessionId, updatedAt) => {
			const entry = byId.get(sessionId)
			if (entry) entry.updatedAt = updatedAt
		})
		on('api-session/status', (sessionId, running) => {
			const entry = byId.get(sessionId)
			if (entry) entry.running = running
		})
		on('session/event', (session, event) => {
			if (event?.type === 'session/title' && event.data?.title) recordTitle(session.id, event.data.title)
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

	function isArchived(sessionId) {
		try {
			const ids = ctx.workspaceRegistry?.archivedSessionIds ?? []
			return ids.includes(sessionId)
		} catch {
			return false
		}
	}

	function visible() {
		return [...byId.values()].filter((s) => !s.origin && !isArchived(s.sessionId))
	}

	function get(sessionId) {
		return byId.get(sessionId)
	}

	/**
	 * **正在跑的**会话（`running` 为真）—— 「运行中会话」命令与那张卡片用。
	 *
	 * `running` 由 `api-session/status` 事件维护，是**会话级**状态（不是"有没有活 agent"：
	 * 空闲会话的 agent 可能还活着，但它没在跑）。按最近活动排序。
	 *
	 * @param {number} [limit] 只要前 N 条（0/不传 = 全部）
	 */
	function runningSessions(limit = 0) {
		const list = visible()
			.filter((session) => session.running)
			.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
		const sliced = limit > 0 ? list.slice(0, limit) : list
		return sliced.map((session) => ({
			sessionId: session.sessionId,
			cwd: session.cwd,
			label: titles.get(session.sessionId) || displayId(session.sessionId),
			running: true,
		}))
	}

	/** 显示名：标题(会话id)；缺标题时退到目录末段。 */
	function describe(sessionId) {
		const entry = byId.get(sessionId)
		const title = titles.get(sessionId)
		const fallback = entry?.cwd ? pathOps.basename(entry.cwd) : ''
		const shown = title || fallback || ''
		return shown ? `**${shown}**\`(${displayId(sessionId)})\`` : `\`${displayId(sessionId)}\``
	}

	/** 只取"标题(会话id)"这段纯文本（用于消息前缀与通知）。 */
	function label(sessionId) {
		const entry = byId.get(sessionId)
		const title = titles.get(sessionId) || (entry?.cwd ? pathOps.basename(entry.cwd) : '') || displayId(sessionId)
		return `${title}(${displayId(sessionId)})`
	}

	/** 只取标题（按钮 label 用：那里不该出现会话id，太占宽度）。 */
	function titleOf(sessionId) {
		const entry = byId.get(sessionId)
		return titles.get(sessionId) || (entry?.cwd ? pathOps.basename(entry.cwd) : '') || ''
	}

	/** 所有会话 cwd 的最长公共前缀：作为选择卡片的默认根目录。 */
	function defaultRoot() {
		const dirs = visible()
			.map((session) => session.cwd)
			.filter((cwd) => typeof cwd === 'string' && pathOps.isAbsolute(cwd))
			.sort()
		if (dirs.length === 0) return platformRoot()
		let prefix = dirs[0]
		for (const dir of dirs) {
			while (prefix && !isUnder(dir, prefix)) {
				const parent = pathOps.dirname(prefix)
				// 走到根了还没包住：Windows 上换盘符（C: 与 D: 没有共同前缀）就是这个情形。
				if (!parent || parent === prefix) return platformRoot()
				prefix = parent
			}
			if (!prefix) return platformRoot()
		}
		return prefix || platformRoot()
	}

	/** 某目录下的子目录（只列真正含会话的那些）。 */
	function listDirs(dir) {
		const base = normalizeDir(dir)
		const children = new Map()
		for (const session of visible()) {
			const cwd = session.cwd
			if (typeof cwd !== 'string' || !isUnder(cwd, base)) continue
			const rest = cwd.slice(isRoot(base) ? base.length : base.length + 1)
			if (!rest) continue
			const [child] = rest.split(sep)
			if (!child) continue
			children.set(child, { name: child, path: childPath(base, child) })
		}
		return [...children.values()].sort((a, b) => a.name.localeCompare(b.name))
	}

	/** 恰好等于某目录的会话。 */
	function sessionsInDir(dir) {
		const base = normalizeDir(dir)
		return visible()
			.filter((session) => normalizeDir(session.cwd) === base)
			.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
			.map((session) => ({
				sessionId: session.sessionId,
				label: titles.get(session.sessionId) || displayId(session.sessionId),
				running: Boolean(session.running),
			}))
	}

	function parentOf(dir) {
		const base = normalizeDir(dir)
		if (isRoot(base)) return null
		const parent = pathOps.dirname(base)
		return parent && parent !== base ? parent : null
	}

	/**
	 * 解析 `<会话id>` 或 `<目录> <会话id>` 形式的目标。
	 *
	 * @returns {{sessionId:string, cwd?:string, content:string}|{error:string}|null}
	 *   null 表示"参数不足以构成目标"（调用方回用法）；
	 *   {error} 表示看起来像个目标但解析不了（调用方回错误 + 用法）。
	 */
	function resolveRef(tokens) {
		const list = (tokens ?? []).filter((t) => t !== undefined)
		if (list.length === 0) return null
		if (list[0] === 'none') return { sessionId: 'none', content: list.slice(1).join(' ') }

		if (byId.has(list[0])) {
			return { sessionId: list[0], cwd: byId.get(list[0])?.cwd, content: list.slice(1).join(' ') }
		}

		const looksLikeDir =
			list[0].startsWith('/') || list[0].startsWith('~') || list[0].includes(sep) || pathOps.isAbsolute(list[0])
		if (looksLikeDir) {
			if (list.length < 2) return null
			// normalizeDir 内部就会展开 ~，这里不用再展开一次。
			const dir = normalizeDir(list[0])
			if (!byId.has(list[1])) return { error: `目录 \`${list[0]}\` 下没找到会话 \`${list[1]}\`。` }
			const entry = byId.get(list[1])
			if (normalizeDir(entry?.cwd) !== dir) {
				return { error: `会话 \`${list[1]}\` 不在目录 \`${list[0]}\` 下（它在 \`${entry?.cwd ?? '未知'}\`）。` }
			}
			return { sessionId: list[1], cwd: entry?.cwd, content: list.slice(2).join(' ') }
		}

		if (list[0].startsWith('session-')) {
			return { error: `没找到会话 \`${list[0]}\`（发 \`切换会话\` 看列表）。` }
		}
		return null
	}

	return {
		refresh,
		subscribe,
		recordTitle,
		seedTitle,
		isArchived,
		visible,
		get,
		describe,
		label,
		titleOf,
		displayId,
		defaultRoot,
		listDirs,
		sessionsInDir,
		runningSessions,
		parentOf,
		resolveRef,
		refreshAge: () => refreshedAt,
	}
}
