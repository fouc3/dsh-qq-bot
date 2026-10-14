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
import { basename, dirname, sep } from 'node:path'

export function createSessions({ ctx, logger, idStyle = 'full' }) {
	const byId = new Map()
	const titles = new Map()
	let refreshedAt = 0

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

	/** 显示名：标题(会话id)；缺标题时退到目录末段。 */
	function describe(sessionId) {
		const entry = byId.get(sessionId)
		const title = titles.get(sessionId)
		const fallback = entry?.cwd ? basename(entry.cwd) : ''
		const shown = title || fallback || ''
		return shown ? `**${shown}**\`(${displayId(sessionId)})\`` : `\`${displayId(sessionId)}\``
	}

	/** 只取"标题(会话id)"这段纯文本（用于消息前缀与通知）。 */
	function label(sessionId) {
		const entry = byId.get(sessionId)
		const title = titles.get(sessionId) || (entry?.cwd ? basename(entry.cwd) : '') || displayId(sessionId)
		return `${title}(${displayId(sessionId)})`
	}

	/** 所有会话 cwd 的最长公共前缀：作为选择卡片的默认根目录。 */
	function defaultRoot() {
		const dirs = visible()
			.map((s) => s.cwd)
			.filter((cwd) => typeof cwd === 'string' && cwd.startsWith('/'))
			.sort()
		if (dirs.length === 0) return '/'
		let prefix = dirs[0]
		for (const dir of dirs) {
			while (prefix && !dir.startsWith(prefix === '/' ? '/' : `${prefix}${sep}`) && dir !== prefix) {
				prefix = dirname(prefix)
			}
			if (!prefix) return '/'
		}
		return prefix || '/'
	}

	/** 某目录下的子目录（只列真正含会话的那些）。 */
	function listDirs(dir) {
		const base = normalizeDir(dir)
		const children = new Map()
		for (const session of visible()) {
			const cwd = session.cwd
			if (typeof cwd !== 'string' || !cwd.startsWith(base === '/' ? '/' : `${base}${sep}`)) continue
			const rest = cwd.slice(base === '/' ? 1 : base.length + 1)
			if (!rest) continue
			const [child] = rest.split(sep)
			if (!child) continue
			children.set(child, { name: child, path: base === '/' ? `/${child}` : `${base}${sep}${child}` })
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
		if (base === '/') return null
		const parent = dirname(base)
		return parent || null
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

		const looksLikeDir = list[0].startsWith('/') || list[0].startsWith('~') || list[0].includes(sep)
		if (looksLikeDir) {
			if (list.length < 2) return null
			const dir = normalizeDir(resolveHome(list[0]))
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
		displayId,
		defaultRoot,
		listDirs,
		sessionsInDir,
		parentOf,
		resolveRef,
		refreshAge: () => refreshedAt,
	}
}

function normalizeDir(dir) {
	if (typeof dir !== 'string' || !dir) return '/'
	let value = resolveHome(dir)
	if (!value.startsWith('/')) value = `/${value}`
	while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1)
	return value
}

function resolveHome(dir) {
	if (dir === '~') return process.env.HOME ?? '~'
	if (dir.startsWith('~/')) return `${process.env.HOME ?? '~'}/${dir.slice(2)}`
	return dir
}
