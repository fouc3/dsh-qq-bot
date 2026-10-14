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

/** 指令按钮（type=2）：点击只把 data 填进输入框，用户自己发送，不产生互动事件。 */
export function commandButton(label, data, { visited, style = 1 } = {}) {
	return {
		id: `cmd_${clipLabel(label)}`,
		render_data: { label: clipLabel(label), visited_label: clipLabel(visited ?? label), style },
		action: {
			type: 2,
			data,
			permission: { type: 2 },
			unsupport_tips: '请升级 QQ 客户端',
		},
	}
}

/** 回调按钮（type=1）：点击产生互动事件并把 data 回传。 */
export function callbackButton(label, data, { visited, style = 1, group } = {}) {
	const button = {
		id: `cb_${clipLabel(label)}`,
		render_data: { label: clipLabel(label), visited_label: clipLabel(visited ?? label), style },
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
}

/** 解析回调 data；不是本插件的数据返回 null。 */
export function parseCallback(raw) {
	if (typeof raw !== 'string' || !raw.startsWith(`${DATA_PREFIX}:`)) return null
	if (raw.startsWith(`${DATA_PREFIX}:needreply:`)) {
		return { kind: 'needreply', sessionId: raw.slice(`${DATA_PREFIX}:needreply:`.length) }
	}
	if (raw.startsWith(`${DATA_PREFIX}:new:`)) {
		return { kind: 'newhere', path: raw.slice(`${DATA_PREFIX}:new:`.length) }
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
 * 只列子目录（逐层进入），导航行是「返回上级」+「在这里新建」——
 * 两枚按钮共用一行，绝不另起一行（平台 5 行上限）。
 */
export function buildNewSessionCard({ dir, dirs, page = 1, pageSize = 8, parentPath }) {
	const contentRows = Math.max(1, KEYBOARD_MAX_ROWS - CARD_RESERVED_ROWS)
	const slots = Math.max(1, Math.min(Math.max(1, pageSize), contentRows * CARD_BUTTONS_PER_ROW))
	const pages = Math.max(1, Math.ceil(dirs.length / slots))
	const current = Math.min(Math.max(1, page), pages)
	const slice = dirs.slice((current - 1) * slots, current * slots)

	const lines = ['**新建会话**', `> 目标目录：\`${dir}\``, `子目录 ${dirs.length} 个`]
	if (pages > 1) lines.push(`第 ${current}/${pages} 页`)
	lines.push('', '逐层点进目标目录，最后点 **在这里新建**。')

	const rows = rowsOf(
		slice.map((sub) => callbackButton(sub.name, data.newDir(sub.path))),
		CARD_BUTTONS_PER_ROW,
	)
	const pager = []
	if (current > 1) pager.push(callbackButton('上一页', data.newPage(dir, current - 1)))
	if (current < pages) pager.push(callbackButton('下一页', data.newPage(dir, current + 1)))
	if (pager.length > 0) rows.push({ buttons: pager })

	const nav = []
	if (parentPath) nav.push(callbackButton('返回上级', data.newDir(parentPath)))
	nav.push(callbackButton('在这里新建', data.newHere(dir), { visited: '已新建' }))
	rows.push({ buttons: nav })

	return { content: lines.join('\n'), keyboard: keyboardOf(clampRows(rows)) }
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
export function buildNoticeCard({ label, sessionId, interrupted = false, source = '' }) {
	const lines = [interrupted ? `${label}被打断` : `${label}已结束`]
	const quoted = interrupted ? oneLine(source) : ''
	if (quoted) lines.push(`> 打断来自：${quoted}`)
	const button = callbackButton('我需要回复', data.needReply(sessionId), { visited: '已触发' })
	return { content: lines.join('\n'), keyboard: keyboardOf([{ buttons: [button] }]) }
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
						// 选中态同时也用**按钮自身**的样式表示（4 = 蓝色填充）；
						// 正文里的 ✅ 保留。平台上 style 就是给这种状态用的。
						style: isSelected ? 4 : 1,
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
