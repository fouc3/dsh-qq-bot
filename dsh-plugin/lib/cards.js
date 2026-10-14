/**
 * 卡片构造（纯函数，便于 node --test 直接覆盖）。
 *
 * 两条平台硬约束决定了这里的写法：
 *   1. 键盘只能挂在 markdown 消息上（挂纯文本平台会静默丢按钮）；
 *   2. 按钮 label 上限 10 个字符宽度（中文算 2），超了要截断。
 */

/** 按钮 label 宽度上限（中文/全角算 2）。 */
export const LABEL_WIDTH_LIMIT = 10

/** 回调按钮的 data 前缀：所有卡片互动都走这一个命名空间，避免与将来别的功能抢。 */
export const DATA_PREFIX = 'qqb'

/** 单选按钮最多几个字母（A..Z 够用）。 */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** 字符显示宽度：CJK/全角算 2，其余算 1。 */
export function displayWidth(text) {
	let width = 0
	for (const char of String(text ?? '')) {
		const code = char.codePointAt(0)
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x1f300 && code <= 0x1faff)
		width += wide ? 2 : 1
	}
	return width
}

/** 按宽度截断，超宽补省略号。 */
export function clipLabel(text, limit = LABEL_WIDTH_LIMIT) {
	const source = String(text ?? '').replace(/\s+/g, ' ').trim()
	if (displayWidth(source) <= limit) return source || '…'
	let out = ''
	for (const char of source) {
		if (displayWidth(out + char) > limit - 1) break
		out += char
	}
	return out ? `${out}…` : '…'
}

/**
 * 内联键盘按钮样式（SDK `KeyboardStyle*`：0 灰 / 1 蓝 / 3 红 / 4 蓝色填充）。
 *
 * 线上实测：**style 4 在客户端渲染成白色**——用户因此把「取消」(style 1 = 蓝) 看成主按钮、
 * 把「发送」(style 4) 看成次要按钮，点错过一次。所以这里统一定义：
 * 主操作 = 蓝(1)、次要/退出 = 灰(0)、破坏性 = 红(3)，不再用 4。
 */
export const BUTTON_STYLE = { neutral: 0, primary: 1, danger: 3, fill: 4 }

/**
 * 指令按钮（type=2）：点击只把 data 填进输入框，用户自己发送，不产生互动事件。
 *
 * `labelLimit` 可以放宽 label 宽度上限（模型卡片里的按钮要显示全名）；
 * `id` 可以指定按钮 id —— 平台要求同一键盘内 id 唯一，而截断后的 label 可能撞车。
 */
export function commandButton(label, data, { visited, style = 1, labelLimit = LABEL_WIDTH_LIMIT, id } = {}) {
	const shown = clipLabel(label, labelLimit)
	return {
		id: id ?? `cmd_${shown}`,
		render_data: { label: shown, visited_label: clipLabel(visited ?? label, labelLimit), style },
		action: {
			type: 2,
			data,
			permission: { type: 2 },
			unsupport_tips: '请升级 QQ 客户端',
		},
	}
}

/** 回调按钮（type=1）：点击产生互动事件并把 data 回传（`labelLimit`/`id` 同指令按钮）。 */
export function callbackButton(label, data, { visited, style = 1, group, labelLimit = LABEL_WIDTH_LIMIT, id } = {}) {
	const shown = clipLabel(label, labelLimit)
	const button = {
		id: id ?? `cb_${shown}`,
		render_data: { label: shown, visited_label: clipLabel(visited ?? label, labelLimit), style },
		action: {
			type: 1,
			data,
			permission: { type: 2 },
			unsupport_tips: '请升级 QQ 客户端',
		},
	}
	if (group) button.group_id = group
	return button
}

/** 把按钮按每行 N 个铺开。 */
export function rowsOf(buttons, perRow = 3) {
	const rows = []
	for (let i = 0; i < buttons.length; i += perRow) {
		rows.push({ buttons: buttons.slice(i, i + perRow) })
	}
	return rows
}

export function keyboardOf(rows) {
	// 兜底：任何调用方都不该产出超限键盘（平台会整条消息 40034029 拒收），
	// 真超了就在这里截断成合法形状，而不是让消息发不出去。
	return { content: { rows: clampRows(rows) } }
}

// ── 回调 data 编解码 ─────────────────────────────────────────────────────

export const data = {
	dir: (path) => `${DATA_PREFIX}:dir:${path}`,
	needReply: (sessionId) => `${DATA_PREFIX}:needreply:${sessionId}`,
	page: (path, page) => `${DATA_PREFIX}:dir:${path}?page=${page}`,
	// 新建会话的目录浏览用独立前缀：同一个"点文件夹"动作要能区分是哪张卡片，
	// 否则点进子目录后会错误地回到"切换会话"卡片（回调 data 里带模式，天然无状态）。
	newDir: (path) => `${DATA_PREFIX}:newdir:${path}`,
	newPage: (path, page) => `${DATA_PREFIX}:newdir:${path}?page=${page}`,
	newHere: (path) => `${DATA_PREFIX}:new:${path}`,
	// callId 放在最后：它是变长的，这样解析时"剩余部分就是 callId"，不会被分隔符切坏。
	question: (callId, questionIndex, action) => `${DATA_PREFIX}:q:${questionIndex}:${action}:${callId}`,
	// 输入态预览卡片：rm:<附件id> / page:<n> / send / clear / cancel
	inbox: (action, arg = '') => `${DATA_PREFIX}:inbox:${action}${arg ? `:${arg}` : ''}`,
	// 新建会话的目录卡片：新建目录（等名字）/ 删除目录（两步确认）
	mkdir: (path) => `${DATA_PREFIX}:mkdir:${path}`,
	// 「等目录名」那张提示卡片上的取消
	mkCancel: (path) => `${DATA_PREFIX}:mkx:${path}`,
	rmdir: (path) => `${DATA_PREFIX}:rmdir:${path}`,
	rmdirYes: (path) => `${DATA_PREFIX}:rmdir2:${path}`,
	// 权限卡片：切成某个预设（value 是 dsh 的预设 key，如 danger-full-access）
	perm: (value) => `${DATA_PREFIX}:perm:${value}`,
	// 模型卡片：page（提供商翻页）/ enter（进提供商看模型）/ mpage（提供商内翻页）/
	// pick（切到某个模型）/ list（回到提供商列表）；arg 是提供商 id 或 `提供商id:…`。
	model: (action, arg = '') => `${DATA_PREFIX}:mod:${action}${arg === '' ? '' : `:${arg}`}`,
}

/** 解析回调 data；不是本插件的数据返回 null。 */
export function parseCallback(raw) {
	if (typeof raw !== 'string' || !raw.startsWith(`${DATA_PREFIX}:`)) return null
	if (raw.startsWith(`${DATA_PREFIX}:needreply:`)) {
		return { kind: 'needreply', sessionId: raw.slice(`${DATA_PREFIX}:needreply:`.length) }
	}
	if (raw.startsWith(`${DATA_PREFIX}:inbox:`)) {
		const rest = raw.slice(`${DATA_PREFIX}:inbox:`.length)
		const first = rest.indexOf(':')
		const action = first < 0 ? rest : rest.slice(0, first)
		const arg = first < 0 ? '' : rest.slice(first + 1)
		if (!action) return null
		if (action === 'page') return { kind: 'inbox', action, page: Number(arg) || 1 }
		return { kind: 'inbox', action, arg }
	}
	if (raw.startsWith(`${DATA_PREFIX}:new:`)) {
		return { kind: 'newhere', path: raw.slice(`${DATA_PREFIX}:new:`.length) }
	}
	if (raw.startsWith(`${DATA_PREFIX}:mkdir:`)) {
		return { kind: 'mkdir', path: raw.slice(`${DATA_PREFIX}:mkdir:`.length) }
	}
	if (raw.startsWith(`${DATA_PREFIX}:mkx:`)) {
		return { kind: 'mkcancel', path: raw.slice(`${DATA_PREFIX}:mkx:`.length) }
	}
	if (raw.startsWith(`${DATA_PREFIX}:perm:`)) {
		return { kind: 'perm', value: raw.slice(`${DATA_PREFIX}:perm:`.length) }
	}
	if (raw.startsWith(`${DATA_PREFIX}:mod:`)) {
		const rest = raw.slice(`${DATA_PREFIX}:mod:`.length)
		const first = rest.indexOf(':')
		const action = first < 0 ? rest : rest.slice(0, first)
		const arg = first < 0 ? '' : rest.slice(first + 1)
		if (!action) return null
		return { kind: 'model', action, arg }
	}
	if (raw.startsWith(`${DATA_PREFIX}:rmdir2:`)) {
		return { kind: 'rmdiryes', path: raw.slice(`${DATA_PREFIX}:rmdir2:`.length) }
	}
	if (raw.startsWith(`${DATA_PREFIX}:rmdir:`)) {
		return { kind: 'rmdir', path: raw.slice(`${DATA_PREFIX}:rmdir:`.length) }
	}
	if (raw.startsWith(`${DATA_PREFIX}:q:`)) {
		const rest = raw.slice(`${DATA_PREFIX}:q:`.length)
		const first = rest.indexOf(':')
		const second = rest.indexOf(':', first + 1)
		if (first < 0 || second < 0) return null
		const questionIndex = Number(rest.slice(0, first))
		const action = rest.slice(first + 1, second)
		const callId = rest.slice(second + 1)
		if (!callId || !Number.isInteger(questionIndex) || !action) return null
		return { kind: 'question', callId, questionIndex, action }
	}
	if (raw.startsWith(`${DATA_PREFIX}:newdir:`)) {
		return { kind: 'dir', mode: 'new', ...splitDirPayload(raw.slice(`${DATA_PREFIX}:newdir:`.length)) }
	}
	if (raw.startsWith(`${DATA_PREFIX}:dir:`)) {
		return { kind: 'dir', mode: 'switch', ...splitDirPayload(raw.slice(`${DATA_PREFIX}:dir:`.length)) }
	}
	return null
}

/** 拆目录回调里的路径与页码（path 可能自带冒号，所以只切问号）。 */
function splitDirPayload(rest) {
	const [path, query] = rest.split('?')
	const page = query && query.startsWith('page=') ? Number(query.slice(5)) || 1 : 1
	return { path, page }
}

// ── 卡片 ─────────────────────────────────────────────────────────────────

/**
 * 会话选择卡片：文件夹用回调按钮（逐层进入），会话用指令按钮（只填输入框）。
 *
 * @param {object} input
 * @param {string} input.dir 当前目录
 * @param {Array<{name:string, path:string}>} input.dirs 子目录
 * @param {Array<{sessionId:string, label:string, running:boolean}>} input.sessions 当前目录的会话
 * @param {string|null} input.currentLabel 当前绑定会话的显示名
 * @param {number} [input.page]
 * @param {number} [input.pageSize]
 * @param {(sessionId:string)=>string} input.switchCommand 生成"填进输入框"的命令文本
 */
/** 内联键盘的平台硬限制：最多 5 行，每行最多 5 个按钮（超了平台直接 40034029 拒收）。 */
export const KEYBOARD_MAX_ROWS = 5
export const KEYBOARD_MAX_BUTTONS_PER_ROW = 5

/** 会话卡片的排版：每行 3 个（手机上更好点），整体不超平台行数。 */
const CARD_BUTTONS_PER_ROW = 3
/** 预留两行给"翻页"和"不指定会话"，剩下的才是内容行。 */
const CARD_RESERVED_ROWS = 2

/** 最后一道兜底：把任何布局压回平台限额内（正常排版不该走到这里）。 */
function clampRows(rows, maxRows = KEYBOARD_MAX_ROWS, maxPerRow = KEYBOARD_MAX_BUTTONS_PER_ROW) {
	return rows
		.slice(0, maxRows)
		.map((row) => ({ ...row, buttons: (row.buttons ?? []).slice(0, maxPerRow) }))
		.filter((row) => (row.buttons ?? []).length > 0)
}

export function buildSessionCard({ dir, dirs, sessions, currentLabel, page = 1, pageSize = 8, switchCommand, parentPath }) {
	// 目录与会话共用同一页预算：先目录（导航优先），再会话。
	// 这样无论目录多少，键盘都不会超过平台行数上限。
	const contentRows = Math.max(1, KEYBOARD_MAX_ROWS - CARD_RESERVED_ROWS)
	const slots = Math.max(1, Math.min(Math.max(1, pageSize), contentRows * CARD_BUTTONS_PER_ROW))
	const entries = [
		...dirs.map((sub) => ({ kind: 'dir', label: sub.name, path: sub.path })),
		...sessions.map((session) => ({
			kind: 'session',
			sessionId: session.sessionId,
			label: `${session.running ? '● ' : ''}${session.label}`,
		})),
	]
	const pages = Math.max(1, Math.ceil(entries.length / slots))
	const current = Math.min(Math.max(1, page), pages)
	const slice = entries.slice((current - 1) * slots, current * slots)

	const lines = [
		'**切换会话**',
		`> 当前会话：${currentLabel ? `\`${currentLabel}\`` : '`none`（未绑定）'}`,
		`目录：\`${dir}\`（${sessions.length} 个会话，${dirs.length} 个子目录）`,
	]
	if (pages > 1) lines.push(`第 ${current}/${pages} 页（每页 ${slots} 项）`)
	lines.push('', '点文件夹继续选择；点会话会把切换指令**填进输入框**，确认后发送。')

	const buttons = slice.map((entry) =>
		entry.kind === 'dir'
			? callbackButton(entry.label, data.dir(entry.path))
			: commandButton(entry.label, switchCommand(entry.sessionId)),
	)
	const rows = rowsOf(buttons, CARD_BUTTONS_PER_ROW)

	const pager = []
	if (current > 1) pager.push(callbackButton('上一页', data.page(dir, current - 1)))
	if (current < pages) pager.push(callbackButton('下一页', data.page(dir, current + 1)))
	if (pager.length > 0) rows.push({ buttons: pager })

	// 导航行：「返回上级」与「不指定会话」必须共用同一行 —— 绝不能另起一行，
	// 否则总行数会超平台 5 行上限，整条消息被 40034029 拒收（线上踩过）。
	const nav = []
	if (parentPath) nav.push(callbackButton('返回上级', data.dir(parentPath)))
	nav.push(commandButton('不指定会话', switchCommand('none')))
	rows.push({ buttons: nav })

	return { content: lines.join('\n'), keyboard: keyboardOf(clampRows(rows)) }
}

/**
 * 新建会话的选目录卡片。
 *
 * 只列子目录（逐层进入）。导航按钮共用一行（平台 5 行上限）；
 * 「删除目录」是破坏性动作，**单独占一行**（用户要求），并且**只有空目录**才出现
 * ——多占一行时内容页会相应少一行，保证总行数不超限。
 */
export function buildNewSessionCard({ dir, dirs, page = 1, pageSize = 8, parentPath, empty = false, confirming = false }) {
	const reservedRows = empty ? CARD_RESERVED_ROWS + 1 : CARD_RESERVED_ROWS
	const contentRows = Math.max(1, KEYBOARD_MAX_ROWS - reservedRows)
	const slots = Math.max(1, Math.min(Math.max(1, pageSize), contentRows * CARD_BUTTONS_PER_ROW))
	const pages = Math.max(1, Math.ceil(dirs.length / slots))
	const current = Math.min(Math.max(1, page), pages)
	const slice = dirs.slice((current - 1) * slots, current * slots)

	const lines = ['**新建会话**', `> 目标目录：\`${dir}\``, `子目录 ${dirs.length} 个`]
	if (pages > 1) lines.push(`第 ${current}/${pages} 页`)
	if (confirming) {
		lines.push(
			'',
			`⚠️ **确认删除这个目录？** \`${dir}\``,
			'> 只会删**空目录**（没有任何文件/子目录）；删了没法从 QQ 侧恢复。',
			'> 点「确认删除」执行，点「取消」回到目录列表。',
		)
	} else {
		lines.push('', '逐层点进目标目录，最后点 **在这里新建**。')
		lines.push('', '> 「新建目录」= 发一个目录名，在当前目录下建，建完自动进去。')
		if (empty) lines.push('> 这个目录是空的，所以可以「删除目录」（单独一行，要再确认一次）。')
	}

	const rows = rowsOf(
		slice.map((sub) => callbackButton(sub.name, data.newDir(sub.path))),
		CARD_BUTTONS_PER_ROW,
	)
	const pager = []
	if (!confirming) {
		if (current > 1) pager.push(callbackButton('上一页', data.newPage(dir, current - 1)))
		if (current < pages) pager.push(callbackButton('下一页', data.newPage(dir, current + 1)))
		if (pager.length > 0) rows.push({ buttons: pager })
	}

	if (confirming) {
		// 二次确认：这一步只有"确认删除 / 取消"，别的动作一概不给。
		rows.push({
			buttons: [
				callbackButton('取消', parentPath ? data.newDir(parentPath) : data.newPage(dir, current), {
					style: BUTTON_STYLE.neutral,
				}),
				callbackButton('确认删除', data.rmdirYes(dir), { style: BUTTON_STYLE.danger, visited: '删除中' }),
			],
		})
		return { content: lines.join('\n'), keyboard: keyboardOf(clampRows(rows)) }
	}

	// 用户要求：**新建目录** 夹在「返回上级」与「在这里新建」之间；
	// 「删除目录」是破坏性动作，**另起一行单独放**，且只有空目录才有。
	const nav = []
	if (parentPath) nav.push(callbackButton('返回上级', data.newDir(parentPath)))
	nav.push(callbackButton('新建目录', data.mkdir(dir)))
	nav.push(callbackButton('在这里新建', data.newHere(dir), { visited: '已新建' }))
	rows.push({ buttons: nav })
	if (empty) rows.push({ buttons: [callbackButton('删除目录', data.rmdir(dir))] })

	return { content: lines.join('\n'), keyboard: keyboardOf(clampRows(rows)) }
}

/**
 * 「新建目录」点了之后那张"等目录名"的提示卡片。
 *
 * 用户要求给一个**明确的取消按钮**：不用去记"发个命令就能取消"。
 */
export function buildMkdirPromptCard({ dir }) {
	const lines = [
		'**新建目录**',
		`> 父目录：\`${dir}\``,
		'',
		'> 直接发一条消息写出**目录名**（只能一层，不能带 `/`、`\\`、`..`），',
		'> 我就在这个目录下建，**建完自动进去**。',
		'> 不想建了，点下面的「取消」。',
	]
	const button = callbackButton('取消', data.mkCancel(dir), { style: BUTTON_STYLE.neutral })
	return { content: lines.join('\n'), keyboard: keyboardOf([{ buttons: [button] }]) }
}

/**
 * 一轮结束通知 + 「我需要回复」按钮。
 *
 * 按钮是回调按钮：点了由插件校验后向会话注入一条唤醒消息（不再自动催促 AI）。
 */
/** 把多行文本压成一行并截断（通知里的"打断来自"用）。 */
function oneLine(text, limit = 60) {
	const flat = String(text ?? '')
		.replace(/\s+/g, ' ')
		.trim()
	if (!flat) return ''
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * 一轮结束的通知卡。
 *
 * 用户要求区分两种收尾：
 *   - 正常结束：`标题(id)已结束`
 *   - 被打断：`标题(id)被打断`，并尽量带上"打断来自哪条消息"（`> 打断来自：…`）；
 *     拿不到那条消息时照样报被打断，只是不带引用行。
 */
export function buildNoticeCard({ label, sessionId, interrupted = false, source = '', sendCommand }) {
	const lines = [interrupted ? `${label}被打断` : `${label}已结束`]
	const quoted = interrupted ? oneLine(source) : ''
	if (quoted) lines.push(`> 打断来自：${quoted}`)
	const buttons = [callbackButton('我需要回复', data.needReply(sessionId), { visited: '已触发' })]
	if (typeof sendCommand === 'function') {
		// 「发送消息」是指令按钮：只把 `发送 <会话id>` 填进 QQ 输入框（由用户自己按发送）。
		// 填的是"只给目标"的形式 → 那条命令会**进入该会话的输入态**，可以慢慢写正文、
		// 加附件，最后点输入态卡片上的「发送」才真正投递。
		buttons.push(commandButton('发送消息', sendCommand(sessionId), { style: BUTTON_STYLE.neutral }))
	}
	return { content: lines.join('\n'), keyboard: keyboardOf([{ buttons }]) }
}

/**
 * 权限卡片：一行一个级别的回调按钮（点了就切换）。
 *
 * 用户要求"每行尽可能放两个按钮；放不下（会超平台行数）就扩大，比如每行三个"：
 * 所以先按 2 个/行排，如果行数超上限就依次加宽（3、4、5），确保整卡合法。
 */
export function buildPermissionCard({ options = [], current = '', sessionId = '', label = '' }) {
	const lines = ['**权限**', `> 会话：${label || sessionId || '（当前会话）'}`]
	if (current) {
		const now = options.find((item) => item.value === current)
		lines.push(`> 当前：**${now?.name ?? current}**`)
	}
	lines.push('', '点下面的级别即可切换（作用于当前会话）。')
	for (const [index, item] of options.entries()) {
		lines.push(`${index + 1}. **${item.name}**${item.description ? ` — ${item.description}` : ''}`)
	}

	const perRow = buttonsPerRowFor(options.length)
	const buttons = options.map((item) =>
		callbackButton(item.name, data.perm(item.value), {
			// 当前那一档用蓝色（主色），其余灰色；不再用 style 4（客户端会渲染成白色）。
			style: item.value === current ? BUTTON_STYLE.primary : BUTTON_STYLE.neutral,
			visited: item.value === current ? '当前' : item.name,
		}),
	)
	return { content: lines.join('\n'), keyboard: keyboardOf(clampRows(rowsOf(buttons, perRow))) }
}

/** 选一个"每行几个按钮"：默认 2，行数不够就加宽到 5 为止。 */
export function buttonsPerRowFor(count, { preferred = 2, maxRows = KEYBOARD_MAX_ROWS } = {}) {
	if (count <= 0) return preferred
	for (let perRow = preferred; perRow <= KEYBOARD_MAX_BUTTONS_PER_ROW; perRow += 1) {
		if (Math.ceil(count / perRow) <= maxRows) return perRow
	}
	return KEYBOARD_MAX_BUTTONS_PER_ROW
}

// ── 模型（提供商 → 模型）两级选择卡片 ─────────────────────────────────────
//
// 用户要求：**提供商每行最多 2 个**（可翻页），点进去才是这个提供商的模型，
// **模型每行最多 1 个**（可翻页）——每行少放几个就不会被挤成窄条。
// 两级都遵守平台 5 行 × 5 列上限：内容行之外只多留"翻页行"和"导航行"。
//
// 关于 label 截断（用户明确要求过）：**别自己提前砍名字**。平台文档现在只写
// 「按钮上的文字」，SDK 里那句"at most 10 characters"来自旧文档；我们以前按
// 「10 个显示宽度（中文算 2）」截断，等于把中文名字砍到 5 个字、英文砍到 10 个字母，
// 全名根本看不到。现在单列的模型按钮**基本不截**（交给 QQ 自己渲染/换行），
// 双列的提供商按钮给一个宽松上限，只有病态长的名字才会出现省略号。

/** 模型选择第一级：提供商。 */
export const MODEL_PROVIDERS_PER_ROW = 2
/** 模型选择第二级：模型（用户要求每行最多一个）。 */
export const MODEL_LIST_PER_ROW = 1
/** 提供商按钮（每行 2 个）的 label 宽度上限：够放常见名字。 */
export const PROVIDER_LABEL_WIDTH_LIMIT = 24
/** 模型按钮（每行 1 个）的 label 宽度上限：几乎照发全名，只挡病态长的名字。 */
export const MODEL_LABEL_WIDTH_LIMIT = 60
/** 模型卡片里操作按钮（应用到当前会话 / 切到其他会话 / 返回）的宽度上限。 */
export const MODEL_ACTION_LABEL_WIDTH_LIMIT = 24

/**
 * 用来标注"当前"的一段文字。
 * @param {{provider:string, model:string}|null} current
 * @param {Array} groups
 */
function currentModelText(current, groups) {
	if (!current?.provider || !current?.model) return '`（读不到，换过之后就会显示）`'
	const group = groups.find((item) => item.id === current.provider)
	const model = group?.models?.find((item) => item.id === current.model)
	const shown = group && model ? `${group.name} / ${model.name}` : `${current.provider} / ${current.model}`
	return `**${shown}**（\`${current.provider}/${current.model}\`）`
}

/**
 * 模型卡片第一级：提供商列表（每行 2 个，可翻页）。
 *
 * @param {object} input
 * @param {Array<{id:string,name:string,models:Array}>} input.groups
 * @param {Array<{id:string,name:string,message:string}>} [input.failures]
 * @param {{provider:string,model:string}|null} [input.current]
 * @param {string} [input.label] 会话显示名（标题(会话id)）
 * @param {number} [input.page]
 */
export function buildModelProviderCard({ groups = [], failures = [], current = null, label = '', page = 1 }) {
	const perRow = MODEL_PROVIDERS_PER_ROW
	const capacity = KEYBOARD_MAX_ROWS * perRow
	const slots = groups.length <= capacity ? capacity : (KEYBOARD_MAX_ROWS - 1) * perRow
	const pages = Math.max(1, Math.ceil(groups.length / slots))
	const currentPage = Math.min(Math.max(1, Number(page) || 1), pages)
	const slice = groups.slice((currentPage - 1) * slots, currentPage * slots)
	const modelCount = groups.reduce((total, group) => total + group.models.length, 0)

	const lines = [
		'**模型**',
		`> 会话：${label || '（当前会话）'}`,
		`> 当前：${currentModelText(current, groups)}`,
		`提供商 ${groups.length} 个 · 模型 ${modelCount} 个`,
	]
	if (pages > 1) lines.push(`第 ${currentPage}/${pages} 页（每页 ${slots} 个提供商）`)
	lines.push('', '点一个**提供商**进去选它的模型（每行 1 个模型）。')
	if (failures.length > 0) {
		lines.push(
			'',
			`> ⚠️ ${failures.length} 个提供商读不到模型：${failures.map((item) => `\`${item.name}\``).join('、')}`,
		)
	}

	const rows = rowsOf(
		slice.map((group) =>
			callbackButton(group.name, data.model('enter', group.id), {
				style: current?.provider === group.id ? BUTTON_STYLE.primary : BUTTON_STYLE.neutral,
				visited: current?.provider === group.id ? '当前' : group.name,
				labelLimit: PROVIDER_LABEL_WIDTH_LIMIT,
				id: `cb_provider_${group.id}`,
			}),
		),
		perRow,
	)
	const pager = []
	if (currentPage > 1) pager.push(callbackButton('上一页', data.model('page', String(currentPage - 1))))
	if (currentPage < pages) pager.push(callbackButton('下一页', data.model('page', String(currentPage + 1))))
	if (pager.length > 0) rows.push({ buttons: pager })

	return { content: lines.join('\n'), keyboard: keyboardOf(clampRows(rows)) }
}

/**
 * 模型卡片第二级：某个提供商的模型列表（每行 1 个，可翻页）。
 *
 * 点一个模型**不会立刻切**：先进「确认」卡片（应用到当前会话 / 切到其他会话 / 返回）。
 * 所以这里导航行只需要「返回」（回提供商列表）。
 *
 * @param {object} input
 * @param {{id:string,name:string,models:Array}} input.group
 * @param {{provider:string,model:string}|null} [input.current]
 * @param {string} [input.label]
 * @param {number} [input.page]
 * @param {{provider:string,model:string}|null} [input.chosen] 刚切成功的那一个（正文写明"已切到"）
 */
export function buildModelListCard({ group, current = null, label = '', page = 1, chosen = null }) {
	const models = group?.models ?? []
	const perRow = MODEL_LIST_PER_ROW
	// 导航行固定占一行；翻页行只有在需要时才出现，
	// 所以先按"不放翻页行"算一遍，放不下再让出一行给翻页。
	const navRows = 1
	const capacity = (KEYBOARD_MAX_ROWS - navRows) * perRow
	const slots = models.length <= capacity ? capacity : (KEYBOARD_MAX_ROWS - navRows - 1) * perRow
	const pages = Math.max(1, Math.ceil(models.length / slots))
	const currentPage = Math.min(Math.max(1, Number(page) || 1), pages)
	const slice = models.slice((currentPage - 1) * slots, currentPage * slots)

	const marked = chosen ?? current
	const lines = [
		`**模型 · ${group?.name ?? ''}**`,
		`> 会话：${label || '（当前会话）'}`,
		`> 当前：${currentModelText(marked, group ? [group] : [])}`,
	]
	if (chosen) {
		// chosen 给的是 id（回调 data 里只有 id）：显示名从这一组里查。
		const picked = models.find((model) => model.id === chosen.model)
		lines.push(`✅ 已切到 **${group.name} / ${picked?.name ?? chosen.model}**。`)
	}
	if (pages > 1) lines.push(`第 ${currentPage}/${pages} 页（每页 ${slots} 个模型）`)
	lines.push('', '点一个**模型**进确认卡片（要切给当前会话还是别的会话，那里再选）。')
	for (const [index, model] of slice.entries()) {
		const order = (currentPage - 1) * slots + index + 1
		const isCurrent = marked?.provider === group?.id && marked?.model === model.id
		lines.push(
			`${order}. **${model.name}**${isCurrent ? ' ✅' : ''}${model.description ? ` — ${model.description}` : ''}`,
		)
	}

	const rows = rowsOf(
		slice.map((model, index) =>
			callbackButton(model.name, data.model('pick', `${group.id}:${model.id}`), {
				style:
					marked?.provider === group?.id && marked?.model === model.id
						? BUTTON_STYLE.primary
						: BUTTON_STYLE.neutral,
				visited: marked?.provider === group?.id && marked?.model === model.id ? '当前' : model.name,
				labelLimit: MODEL_LABEL_WIDTH_LIMIT,
				// 同一键盘内 id 必须唯一：截断后的名字可能撞车，所以按序编号。
				id: `cb_model_${group.id}_${index}`,
			}),
		),
		perRow,
	)
	const pager = []
	if (currentPage > 1) pager.push(callbackButton('上一页', data.model('mpage', `${group.id}:${currentPage - 1}`)))
	if (currentPage < pages) pager.push(callbackButton('下一页', data.model('mpage', `${group.id}:${currentPage + 1}`)))
	if (pager.length > 0) rows.push({ buttons: pager })

	rows.push({ buttons: [callbackButton('返回', data.model('list'), { style: BUTTON_STYLE.neutral })] })

	return { content: lines.join('\n'), keyboard: keyboardOf(clampRows(rows)) }
}

/**
 * 模型卡片第三级：**确认**卡片（用户要求）。
 *
 * 选完模型先问一句要切到哪儿，三个都是**交互式**回调按钮：
 *   - 「应用到当前会话」→ 立刻切；
 *   - 「切到其他会话」→ 进"等会话id"状态（用户下一条消息写出会话id，见 index.js），
 *     不再用"往输入框填命令"那种方式（用户明确要求改成交互式）；
 *   - 「返回」→ 回该提供商的模型列表。
 *
 * @param {object} input
 * @param {{id:string,name:string}} input.group
 * @param {{id:string,name:string,description?:string}} input.model
 * @param {string} [input.label] 当前会话显示名
 */
export function buildModelConfirmCard({ group, model, label = '' }) {
	const lines = [
		'**模型 · 确认**',
		`> 会话：${label || '（当前会话）'}`,
		`> 选中的模型：**${group?.name ?? ''} / ${model?.name ?? ''}**（\`${group?.id}/${model?.id}\`）`,
	]
	if (model?.description) lines.push(`> ${model.description}`)
	lines.push(
		'',
		'要切到哪儿？',
		'> 「应用到当前会话」＝就切给上面这个会话。',
		'> 「切到其他会话」＝你接着发一条消息写出**会话id**，我切给那个会话。',
		'> 「返回」＝回到模型列表继续挑。',
	)

	const rows = [
		{
			buttons: [
				callbackButton('应用到当前会话', data.model('apply', `${group.id}:${model.id}`), {
					style: BUTTON_STYLE.primary,
					visited: '已应用',
					labelLimit: MODEL_ACTION_LABEL_WIDTH_LIMIT,
					id: 'cb_model_apply',
				}),
				callbackButton('切到其他会话', data.model('other', `${group.id}:${model.id}`), {
					style: BUTTON_STYLE.neutral,
					labelLimit: MODEL_ACTION_LABEL_WIDTH_LIMIT,
					id: 'cb_model_other',
				}),
			],
		},
		{
			buttons: [
				callbackButton('返回', data.model('back', group.id), {
					style: BUTTON_STYLE.neutral,
					id: 'cb_model_back',
				}),
			],
		},
	]
	return { content: lines.join('\n'), keyboard: keyboardOf(clampRows(rows)) }
}

/**
 * 「切到其他会话」之后那张"等会话id"的提示卡片：自带一个明确的「取消」。
 *
 * @param {object} input
 * @param {{id:string,name:string}} input.group
 * @param {{id:string,name:string}} input.model
 * @param {string} [input.label]
 */
export function buildModelSessionPromptCard({ group, model, label = '' }) {
	const lines = [
		'**模型 · 切到其他会话**',
		`> 会话：${label || '（当前会话）'}`,
		`> 选中的模型：**${group?.name ?? ''} / ${model?.name ?? ''}**（\`${group?.id}/${model?.id}\`）`,
		'',
		'> 直接发一条消息写出**会话id**（`session-…`），我就把模型切给那个会话。',
		'> 不想切了，点下面的「取消」回到确认卡片。',
	]
	const rows = [
		{
			buttons: [
				callbackButton('取消', data.model('cancel', `${group.id}:${model.id}`), {
					style: BUTTON_STYLE.neutral,
					id: 'cb_model_cancel',
				}),
			],
		},
	]
	return { content: lines.join('\n'), keyboard: keyboardOf(clampRows(rows)) }
}

/**
 * 提问卡片。
 *
 * 关键设计（用户要求）：**按钮上只写字母**，字母对应的选项与"选项下面的小字"
 * （description）全部写在题干与按钮之间的 markdown 正文里。
 *
 * 一次提问的按钮（选项 + 每题一个「其他」+ 一个「提交」）放不下一张卡片时，
 * 拆成多张卡片发（见 buildQuestionCards）。线上真踩过：4 道题 17 个按钮超过
 * 单卡上限，卡片返回 null、静默降级到 dsh GUI，QQ 侧的用户什么都看不到。
 */

/** 提问卡片的排版：每行 4 个（手机上更好点）。 */
export const QUESTION_BUTTONS_PER_ROW = 4
/** 单张提问卡片的按钮数上限（平台 5 行 × 每行 4 个）。 */
export const QUESTION_MAX_BUTTONS = KEYBOARD_MAX_ROWS * QUESTION_BUTTONS_PER_ROW

/** 一个问题除了选项之外固定要占的按钮数（「其他」）。 */
function questionButtonCost(question) {
	return (question?.options ?? []).length + 1
}

/** 一张卡片正文里与题目无关的固定提示。 */
function questionHints({ cardIndex, cardTotal }) {
	const hints = [
		'> 不选任何字母直接点「提交」= 跳过本题。',
		'> 命令（如 进度 / 停止 / 切换会话）照常生效，不会被当成答案。',
	]
	if (cardTotal > 1) {
		hints.unshift(
			`> 本卡是第 ${cardIndex}/${cardTotal} 张，其余题目在别的卡片上；随便在哪张点「提交」都算交卷（没答的题按跳过）。`,
		)
	}
	return hints
}

/** 生成一张只包含 indices 这些题的卡片。 */
function renderQuestionCard({ callId, questions, indices, answers, customFor, cardIndex = 1, cardTotal = 1 }) {
	const buttons = []
	const blocks = []

	indices.forEach((qIndex) => {
		const question = questions[qIndex]
		const answer = answers[qIndex] ?? {}
		const selected = new Set(answer.selected ?? [])
		const head = `**提问 ${qIndex + 1}/${questions.length}**${question.header ? ` · \`${question.header}\`` : ''}`
		const lines = [head, '']
		if (question.detail) lines.push(question.detail, '')
		lines.push(question.question, '')

		const options = question.options ?? []
		if (options.length === 0) {
			lines.push('> 本题没有预设选项，直接发消息写出你的答案即可。')
		} else {
			lines.push('---', '')
			options.forEach((option, oIndex) => {
				const letter = LETTERS[oIndex] ?? `#${oIndex + 1}`
				const isSelected = selected.has(option.label)
				const mark = isSelected ? '✅ ' : ''
				lines.push(`**${letter}.** ${mark}${option.label}`)
				if (option.description) lines.push(`> ${option.description}`)
				lines.push('')
				buttons.push(
					callbackButton(letter, data.question(callId, qIndex, `opt-${oIndex}`), {
						visited: letter,
						// 选中态也体现在按钮自身：**选中＝蓝(1)、未选中＝灰(0)**。
						// （以前用 4 当"填充蓝"，线上客户端实际渲染成白色——正好和被"取消/发送"坑到的是同一个坑。）
						// 正文里的 ✅ 保留。
						style: isSelected ? BUTTON_STYLE.primary : BUTTON_STYLE.neutral,
					}),
				)
			})
		}

		const custom = answer.custom
		if (customFor === qIndex) {
			lines.push('**其他**：请直接发一条消息，你说的内容会作为这一题的「其他」答案。')
		} else if (custom) {
			lines.push(`**其他**：${custom}`)
		}
		if (question.multiSelect) lines.push('> 本题可多选：点多个字母，再点「提交」。')
		lines.push('')

		buttons.push(callbackButton('其他', data.question(callId, qIndex, 'custom')))
		blocks.push(lines.join('\n'))
	})

	buttons.push(callbackButton('提交', data.question(callId, indices[0] ?? 0, 'submit')))
	const content = [...blocks, ...questionHints({ cardIndex, cardTotal })].join('\n---\n')
	return { content, keyboard: keyboardOf(rowsOf(buttons, QUESTION_BUTTONS_PER_ROW)), buttons }
}

/**
 * 把一次提问拆成若干张卡片：一张放不下就顺延到下一张，**每张卡片都带「提交」**。
 *
 * 分组的依据只有题目本身（与已答状态无关），所以同一 callId 反复渲染时，
 * 卡片数、每张卡里的题序都是稳定的——调用方可以按下标重发某一张。
 *
 * @param {object} input
 * @param {string} input.callId
 * @param {Array<{id:string, question:string, header?:string, detail?:string, options?:Array<{label:string, description?:string}>, multiSelect?:boolean}>} input.questions
 * @param {object} [input.answers] 题序 → { selected: string[], custom?: string }
 * @param {number|null} [input.customFor] 正在等待"其他"输入的题序
 * @param {number} [input.maxButtons] 单卡按钮上限
 * @returns {Array<{indices:number[], content:string, keyboard:object}>|null}
 *   null = 单道题本身都放不下（**不截断选项**，免得悄悄少给选项），调用方降级到 dsh GUI
 */
export function buildQuestionCards({ callId, questions, answers = {}, customFor = null, maxButtons = QUESTION_MAX_BUTTONS }) {
	const list = Array.isArray(questions) ? questions : []
	if (list.length === 0) return null
	const cap = Math.max(
		3,
		Math.min(Number(maxButtons) || QUESTION_MAX_BUTTONS, KEYBOARD_MAX_ROWS * KEYBOARD_MAX_BUTTONS_PER_ROW),
	)

	const groups = []
	list.forEach((question, qIndex) => {
		const cost = questionButtonCost(question)
		const last = groups[groups.length - 1]
		// 每张卡片固定多占一个「提交」；加上它放不下就开新卡。
		if (last && last.cost + cost + 1 <= cap) {
			last.indices.push(qIndex)
			last.cost += cost
			return
		}
		groups.push({ indices: [qIndex], cost: cost + 1 })
	})

	const cards = groups.map((group, index) =>
		renderQuestionCard({
			callId,
			questions: list,
			indices: group.indices,
			answers,
			customFor,
			cardIndex: index + 1,
			cardTotal: groups.length,
		}),
	)
	if (cards.some((card) => card.buttons.length > cap)) return null
	return cards.map((card, index) => ({
		indices: groups[index].indices,
		content: card.content,
		keyboard: card.keyboard,
	}))
}

/**
 * 单张提问卡片（向后兼容的入口）：拆出来只有一张时返回它，否则返回 null。
 * @returns {{content:string, keyboard:object}|null}
 */
export function buildQuestionCard(input) {
	const cards = buildQuestionCards(input)
	if (!cards || cards.length !== 1) return null
	return { content: cards[0].content, keyboard: cards[0].keyboard }
}

// ── 输入态预览卡片 ───────────────────────────────────────────────────────

/** 卡片上附件要显示的字节数（没有就省略）。 */
function sizeLabel(size) {
	const bytes = Number(size)
	if (!Number.isFinite(bytes) || bytes <= 0) return ''
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const KIND_LABEL = { image: '图片', file: '文件', video: '视频', voice: '语音', unknown: '附件' }

/** 一行附件描述（正文里用，状态写得直白一点）。 */
export function describeInboxItem(item) {
	const bits = [`**${item.id}**`, KIND_LABEL[item.kind] ?? '附件']
	if (item.filename) bits.push(item.filename)
	const size = sizeLabel(item.size)
	if (size) bits.push(size)
	const head = bits.join(' · ')
	switch (item.status) {
		case 'stored':
			return `${head} · ✅ 已下载`
		case 'voice':
			return `${head} · 🎙 转写：${item.asrText}`
		case 'voice-unrecognized':
			return `${head} · ⚠️ **无法识别**：平台没有给出转写文本，请先删除它再「发送」`
		case 'oversize':
			return `${head} · ⚠️ 未下载（${item.note || '超过自动下载上限'}）`
		default:
			return `${head} · ⚠️ 未下载（${item.note || '自动下载失败'}）`
	}
}

/**
 * 输入态预览卡片。
 *
 * 「发送」是唯一把内容交给 AI 的入口；附件各自一个「删除」按钮；
 * 语音转写单独一段（排在附件之前，用户明确要求）。
 *
 * @param {object} input
 * @param {string} [input.label] 会话显示名
 * @param {string} input.sessionId
 * @param {string} input.text 已攒的正文
 * @param {Array<object>} [input.items] 附件条目（inbox.js 的形状）
 * @param {string[]} [input.voice] 语音转写文本
 * @param {number} [input.page]
 * @param {number} [input.pageSize]
 * @returns {{content:string, keyboard:object}}
 */
export function buildInboxCard({ label, sessionId, text, items = [], voice = [], page = 1, pageSize = 8, mode = 'send' }) {
	const delayed = mode === 'delay'
	const total = items.length
	const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
	const current = Math.min(Math.max(1, Number(page) || 1), pages)
	const slice = items.slice((current - 1) * pageSize, current * pageSize)

	const lines = [`**输入框${delayed ? '（延迟投递）' : ''}** · ${label ?? sessionId}`, `> 会话：\`${sessionId}\``, '']
	lines.push('**正文**')
	if (String(text ?? '').trim()) {
		for (const line of String(text).split('\n')) lines.push(`> ${line || ' '}`)
	} else {
		lines.push('> （还没写正文：直接发一条文字就会填进来）')
	}

	if (voice.length) {
		lines.push('', '---', '', '**语音转写**（独立一段，优先级高于其它附件）')
		for (const item of voice) lines.push(`> 🎙 ${item}`)
	}

	lines.push('', '---', '', `**附件（${total}）**`)
	if (total === 0) {
		lines.push('> （还没有附件：直接发图片/文件/语音/视频就会入列）')
	} else {
		for (const item of slice) lines.push(describeInboxItem(item))
	}
	if (pages > 1) lines.push('', `> 第 ${current}/${pages} 页（每页 ${pageSize} 个），用下面的「上一页/下一页」翻。`)
	lines.push(
		'',
		delayed
			? '> 点「延迟发送」= **登记为延迟投递**：不打断这一轮，等它**正常结束**后再交给 AI；「删除」只影响这一条附件。'
			: '> 点「发送」才真正交给 AI；「删除」只影响这一条附件。',
	)

	const itemButtons = slice.map((item) =>
		callbackButton(`删除 ${item.id}`, data.inbox('rm', item.id), { style: BUTTON_STYLE.neutral }),
	)
	const rows = rowsOf(itemButtons, 4)
	if (pages > 1) {
		const nav = []
		if (current > 1) nav.push(callbackButton('上一页', data.inbox('page', String(current - 1)), { style: BUTTON_STYLE.neutral }))
		if (current < pages) nav.push(callbackButton('下一页', data.inbox('page', String(current + 1)), { style: BUTTON_STYLE.neutral }))
		if (nav.length) rows.push({ buttons: nav })
	}
	// 按钮顺序按用户要求：**取消在最左、发送在最右**（发送放右侧才顺手）。
	// 颜色语义：发送＝蓝（主操作），取消/清空正文＝灰（次要）——不能反，用户已经点错过一次。
	const actions = [callbackButton('取消', data.inbox('cancel'), { style: BUTTON_STYLE.neutral })]
	if (String(text ?? '').trim()) {
		actions.push(callbackButton('清空正文', data.inbox('clear'), { style: BUTTON_STYLE.neutral }))
	}
	actions.push(callbackButton(delayed ? '延迟发送' : '发送', data.inbox('send'), { style: BUTTON_STYLE.primary }))
	rows.push({ buttons: actions })

	return { content: lines.join('\n'), keyboard: keyboardOf(rows) }
}

// ── 结果预览（卡片撤回后留一条"我刚才确认了什么"） ───────────────────────

/**
 * 提问结果预览。
 *
 * 为什么需要：提问卡片在提交后会被撤回（否则聊天里一堆积压卡片），
 * 但撤回之后用户就再也看不到"我到底答了什么"了 —— 这里补一条纯文本预览。
 *
 * @param {{questions?:Array<object>, answers?:Array<{id:string,selected?:string[],custom?:string}>}} input
 */
export function buildQuestionResult({ questions = [], answers = [] } = {}) {
	const byId = new Map((answers ?? []).map((answer) => [answer?.id, answer]))
	const lines = [`**提问结果** · ${questions.length} 题`]
	questions.forEach((question, index) => {
		const answer = byId.get(question.id) ?? {}
		const selected = Array.isArray(answer.selected) ? answer.selected : []
		lines.push('', `**${index + 1}. ${question.header ? `${oneLine(question.header, 20)} · ` : ''}${oneLine(question.question, 60)}**`)
		if (selected.length === 0 && !answer.custom) lines.push('> （没选，按跳过处理）')
		for (const label of selected) lines.push(`> ✅ ${oneLine(label, 60)}`)
		if (answer.custom) lines.push(`> ✍️ 其他：${oneLine(answer.custom, 160)}`)
	})
	return lines.join('\n')
}

/** 正文预览最多展示多少字（超出截断并说明）。 */
const RESULT_TEXT_LIMIT = 400

/**
 * 输入态「发送」后的结果预览。
 *
 * 为什么需要：点「发送」后那张预览卡片会被撤回，用户就只看到一句"已发送"；
 * 这里把**真正发出去的内容**复述一遍（正文 / 语音转写 / 附件），便于回头核对。
 *
 * @param {{label?:string, sessionId:string, text?:string, items?:Array<object>, voice?:Array<object>}} input
 */
export function buildInboxResult({ label, sessionId, text = '', items = [], voice = [], mode = 'send' } = {}) {
	const voiceIds = new Set((voice ?? []).map((item) => item.id))
	const body = String(text ?? '').trim()
	const title = mode === 'delay' ? '**已登记**（延迟投递）' : '**已发送**'
	const note = mode === 'delay' ? '> 投递时机：这一轮**正常结束**后（被停止/被顶替/出错都不会投）' : ''
	const lines = [`${title} · ${label ?? sessionId}`, `> 会话：\`${sessionId}\``]
	if (note) lines.push(note)
	lines.push('')

	lines.push(`**正文（${body.length} 字）**`)
	if (body) {
		const shown = body.length > RESULT_TEXT_LIMIT ? `${body.slice(0, RESULT_TEXT_LIMIT)}…` : body
		for (const line of shown.split('\n')) lines.push(`> ${line || ' '}`)
		if (body.length > RESULT_TEXT_LIMIT) lines.push('> （太长，这里只显示前 400 字）')
	} else {
		lines.push('> （没有正文）')
	}

	if ((voice ?? []).length > 0) {
		lines.push('', '---', '', '**语音转写（平台，可能有误）**')
		for (const item of voice) lines.push(`> 🎙 ${item.id}：${oneLine(item.asrText, 200)}`)
	}

	const others = (items ?? []).filter((item) => !voiceIds.has(item.id))
	lines.push('', '---', '', `**附件（${others.length}）**`)
	if (others.length === 0) lines.push('> （没有附件）')
	for (const item of others) lines.push(`- ${describeInboxItem(item)}`)
	return lines.join('\n')
}
