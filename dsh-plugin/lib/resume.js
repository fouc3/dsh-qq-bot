/**
 * 「上次运行被打断的会话」快照：写侧（心跳）+ 读侧（下次启动）。
 *
 * 为什么要有它：dsh 被 `systemctl restart`、崩溃、kill -9 时，**正在跑的轮次会被打断**，
 * 用户回到 QQ 时只看见一堆「已结束/被打断」，不知道刚才那个长任务停在哪儿、也没法一键接着跑。
 *
 * 为什么是心跳而不是退出钩子：kill -9 / OOM / 断电时退出钩子根本不跑，
 * 只有"死前最后一份快照"靠得住。所以只要有任何会话在跑，就每 `interval` 毫秒刷一次盘
 * （内容没变就不写，避免空转写盘）。
 *
 * 文件形状（版本化，读坏了一律当空，绝不让它影响启动）：
 * ```json
 * { "version": 1, "at": "2026-10-18T09:00:00.000Z", "sessions": [
 *   { "sessionId": "session-…", "title": "…", "cwd": "/…",
 *     "turn": 148, "startedAt": 1789000000000, "text": "最后一段正文（裁过）", "at": 1789000005000 }
 * ] }
 * ```
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 快照格式版本（以后加字段靠它判定）。 */
export const SNAPSHOT_VERSION = 1
/** 最多记多少条（再多也没人看，且文件要小）。 */
export const MAX_ENTRIES = 20
/** 摘要正文截断长度。 */
export const TEXT_LIMIT = 140

/** 把长文本裁成一行摘要（换行压平、超长加省略号）。 */
export function clipText(text, limit = TEXT_LIMIT) {
	const value = String(text ?? '')
		.replace(/\s+/g, ' ')
		.trim()
	if (!value) return ''
	const chars = [...value]
	return chars.length <= limit ? value : `${chars.slice(0, limit).join('')}…`
}

/** 单条记录的归一化（容忍手工改坏/旧版本字段）。 */
function normalizeEntry(raw) {
	if (!raw || typeof raw !== 'object') return null
	const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
	if (!sessionId) return null
	const turn = Number(raw.turn)
	return {
		sessionId,
		title: typeof raw.title === 'string' ? raw.title : '',
		cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
		turn: Number.isFinite(turn) && turn > 0 ? Math.floor(turn) : null,
		startedAt: Number.isFinite(Number(raw.startedAt)) && Number(raw.startedAt) > 0 ? Number(raw.startedAt) : null,
		text: clipText(raw.text),
		at: Number.isFinite(Number(raw.at)) && Number(raw.at) > 0 ? Number(raw.at) : null,
	}
}

/**
 * 快照的读写。**所有失败都不抛**：这是给"启动时提醒"用的辅助设施，
 * 读不到/写不进最多是少一条提醒，绝不能挡住插件启动。
 */
export function createResumeStore({ file, logger }) {
	const path = String(file ?? '').trim()

	function load() {
		if (!path) return { version: SNAPSHOT_VERSION, at: null, sessions: [] }
		try {
			if (!existsSync(path)) return { version: SNAPSHOT_VERSION, at: null, sessions: [] }
			const raw = JSON.parse(readFileSync(path, 'utf8'))
			const list = Array.isArray(raw?.sessions) ? raw.sessions : []
			const sessions = list
				.map(normalizeEntry)
				.filter(Boolean)
				.slice(0, MAX_ENTRIES)
			return { version: SNAPSHOT_VERSION, at: typeof raw?.at === 'string' ? raw.at : null, sessions }
		} catch (error) {
			logger?.warn?.('读取运行快照失败（当作没有）', { file: path, error: String(error) })
			return { version: SNAPSHOT_VERSION, at: null, sessions: [] }
		}
	}

	function save(sessions) {
		if (!path) return
		const list = (Array.isArray(sessions) ? sessions : [])
			.map(normalizeEntry)
			.filter(Boolean)
			.slice(0, MAX_ENTRIES)
		const payload = { version: SNAPSHOT_VERSION, at: new Date().toISOString(), sessions: list }
		const tmp = `${path}.tmp`
		try {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
			writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
			renameSync(tmp, path)
			try {
				chmodSync(path, 0o600)
			} catch {
				// 某些文件系统不支持 chmod：不影响功能
			}
			return payload
		} catch (error) {
			logger?.warn?.('写入运行快照失败', { file: path, error: String(error) })
			try {
				if (existsSync(tmp)) unlinkSync(tmp)
			} catch {
				// 忽略清理失败
			}
			return null
		}
	}

	return { file: path, load, save }
}
