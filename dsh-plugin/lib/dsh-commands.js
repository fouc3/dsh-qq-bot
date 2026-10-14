/**
 * dsh 内置命令（Human-command registry）与 QQ 之间的桥。
 *
 * 两件事：
 *   1. 枚举某个 agent 当前的有效命令（`ctx.commands.list(agent)`），用于把
 *      **dsh 内置命令收进 QQ 菜单的二级菜单**（顶层留给桥自己的命令）；
 *   2. 把 QQ 里发来的 `/xxx` 直接交给 `ctx.commands.execute(agent, line, [], signal)`
 *      执行 —— 这是一条不经过模型的"人类命令"通路。
 *
 * 边界（用户明确要求）：
 *   - **技能不在其中**：技能是给模型用的工具（tool），不是人类命令，本来就不在
 *     `ctx.commands` 里；
 *   - **「反馈」(feedback) 不兼容**：列在 EXCLUDED_COMMANDS 里，QQ 侧既不收纳
 *     进菜单，也不执行（会按普通消息处理）。
 *
 * 平台菜单限额（QQ 硬限制）：顶层 ≤10 项、二级菜单 ≤5 项；名宽按"中文算 2"。
 */

/** 不兼容的 dsh 命令（用户要求：反馈不用兼容）。 */
export const EXCLUDED_COMMANDS = new Set(['feedback'])

/** 菜单限额。 */
export const MENU_TOP_LIMIT = 10
export const SUBMENU_ITEM_LIMIT = 5

/** 是否是斜杠命令行（判定用，不解析）。 */
export function isSlashLine(text) {
	return typeof text === 'string' && text.trimStart().startsWith('/')
}

/** 拆出命令名与其余参数：'/发送 a b' → {name:'发送', rest:'a b'}。 */
export function splitSlashLine(text) {
	const line = String(text ?? '').trim()
	if (!line.startsWith('/')) return null
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(line)
	if (!match) return null
	return { name: match[1], rest: match[2] ?? '', line }
}

/**
 * `/plan <文本>` 要拆成"命令 + 消息"两件事。
 *
 * dsh 的 `/plan` 的输入是 `[off|message]`：文本非 `off` 时它会**进入 plan 模式**
 * 并把这段文本 `agent.steer(createUserMessage({source:{kind:'user'}}))` 塞进会话。
 * 那条 steer 起出来的轮次**不经过本桥的投递路径**，于是：
 *   - 轮次没有被 `beginRound` 认领 → 没有进度/思考流、没有「已结束 + 我需要回复」通知；
 *   - 也就没有注入"这条消息来自 QQ、要回请用 qq_reply"的上下文 → 模型不知道要回 QQ。
 * 线上表现就是「思考没出现、发了没反应」。
 *
 * 所以这里自己拆：命令只剩 `/plan`（切模式，不 steer），文本交给本桥正常投递。
 *
 * @returns {{command:string, message:string}} message 为空表示按原样执行整行
 */
export function splitModeCommand(slash) {
	if (!slash || slash.name !== 'plan') return { command: slash?.line ?? '', message: '' }
	const rest = String(slash.rest ?? '').trim()
	// `off` / `on` 是模式词，不是要给 AI 的消息
	if (!rest || rest === 'off' || rest === 'on') return { command: slash.line, message: '' }
	return { command: `/${slash.name}`, message: rest }
}

/** 过滤 + 归一化描述符（去掉不兼容命令与无效项）。 */
export function filterCommands(descriptors, excluded = EXCLUDED_COMMANDS) {
	return (descriptors ?? [])
		.filter((d) => d && typeof d.name === 'string' && d.name !== '' && !excluded.has(d.name))
		.map((d) => ({
			name: d.name,
			description: typeof d.description === 'string' ? d.description : '',
			hint: typeof d.input?.hint === 'string' ? d.input.hint : '',
		}))
}

/**
 * 把命令切成二级菜单项：每 ≤5 个一组，各成一个可折叠菜单。
 *
 * @param {Array<{name:string}>} commands
 * @param {object} [options]
 * @param {string} [options.label] 二级菜单名（多组时自动加序号）
 * @param {number} [options.topLevelBudget] 最多占几个顶层位（顶层总限额 10）
 */
export function buildSubMenus(commands, { label = 'dsh 命令', topLevelBudget = MENU_TOP_LIMIT } = {}) {
	const groups = []
	for (let i = 0; i < commands.length; i += SUBMENU_ITEM_LIMIT) {
		groups.push(commands.slice(i, i + SUBMENU_ITEM_LIMIT))
	}
	return groups.slice(0, Math.max(0, topLevelBudget)).map((group, index) => ({
		name: groups.length > 1 ? `${label}${index + 1}` : label,
		type: 'menu',
		children: group.map((cmd) => ({
			name: cmd.name,
			// 点一下把 '/命令' 填进输入框（与平台 send_message 语义一致）
			sendMessage: `/${cmd.name}`,
		})),
	}))
}

/** 组装完整菜单：桥命令在前，dsh 命令收进后面的二级菜单。 */
export function buildMenuItems({ bridge = [], commands = [], label, topLevelBudget = MENU_TOP_LIMIT } = {}) {
	const items = bridge.slice(0, topLevelBudget)
	const room = Math.max(0, topLevelBudget - items.length)
	if (commands.length > 0 && room > 0) {
		items.push(...buildSubMenus(commands, { label, topLevelBudget: room }))
	}
	return items
}

/** 枚举某个 agent 的有效命令；服务缺失或报错都退化成空表（菜单照发）。 */
export async function listCommands(commands, agent, logger) {
	if (!commands || !agent || typeof commands.list !== 'function') return []
	try {
		return filterCommands(await commands.list(agent))
	} catch (error) {
		logger?.warn?.('枚举 dsh 命令失败', { error: String(error) })
		return []
	}
}

/**
 * 执行一条斜杠命令。
 *
 * @returns {Promise<{handled:boolean, ok?:boolean, text?:string}>}
 *   handled=false 表示没解析到（未知命令/语法不对），调用方应回退成普通消息。
 */
export async function runCommand(commands, agent, line, { signal, logger } = {}) {
	if (!commands || !agent || typeof commands.execute !== 'function') return { handled: false }
	let fallbackSignal = signal
	if (!fallbackSignal) {
		fallbackSignal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
			? AbortSignal.timeout(120000)
			: new AbortController().signal
	}
	try {
		const execution = await commands.execute(agent, line, [], fallbackSignal)
		if (!execution) return { handled: false }
		const result = execution.result ?? {}
		return {
			handled: true,
			ok: result.kind === 'success',
			text: typeof result.text === 'string' ? result.text : '',
		}
	} catch (error) {
		logger?.warn?.('执行 dsh 命令失败', { line, error: String(error) })
		return { handled: true, ok: false, text: `命令执行失败：${String(error?.message ?? error)}` }
	}
}
