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
	return { content: { rows } }
}

// ── 回调 data 编解码 ─────────────────────────────────────────────────────

export const data = {
	dir: (path) => `${DATA_PREFIX}:dir:${path}`,
	needReply: (sessionId) => `${DATA_PREFIX}:needreply:${sessionId}`,
	page: (path, page) => `${DATA_PREFIX}:dir:${path}?page=${page}`,
	// callId 放在最后：它是变长的，这样解析时"剩余部分就是 callId"，不会被分隔符切坏。
	question: (callId, questionIndex, action) => `${DATA_PREFIX}:q:${questionIndex}:${action}:${callId}`,
}

/** 解析回调 data；不是本插件的数据返回 null。 */
export function parseCallback(raw) {
	if (typeof raw !== 'string' || !raw.startsWith(`${DATA_PREFIX}:`)) return null
	if (raw.startsWith(`${DATA_PREFIX}:needreply:`)) {
		return { kind: 'needreply', sessionId: raw.slice(`${DATA_PREFIX}:needreply:`.length) }
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
	if (raw.startsWith(`${DATA_PREFIX}:dir:`)) {
		const rest = raw.slice(`${DATA_PREFIX}:dir:`.length)
		const [path, query] = rest.split('?')
		const page = query && query.startsWith('page=') ? Number(query.slice(5)) || 1 : 1
		return { kind: 'dir', path, page }
	}
	return null
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
export function buildSessionCard({ dir, dirs, sessions, currentLabel, page = 1, pageSize = 8, switchCommand }) {
	const totalSessions = sessions.length
	const pages = Math.max(1, Math.ceil(totalSessions / Math.max(1, pageSize)))
	const current = Math.min(Math.max(1, page), pages)
	const slice = sessions.slice((current - 1) * pageSize, current * pageSize)

	const lines = [
		'**切换会话**',
		`> 当前会话：${currentLabel ? `\`${currentLabel}\`` : '`none`（未绑定）'}`,
		`目录：\`${dir}\`（${totalSessions} 个会话，${dirs.length} 个子目录）`,
	]
	if (pages > 1) lines.push(`第 ${current}/${pages} 页`)
	lines.push('', '点文件夹继续选择；点会话会把切换指令**填进输入框**，确认后发送。')

	const buttons = []
	for (const sub of dirs) buttons.push(callbackButton(sub.name, data.dir(sub.path)))
	for (const session of slice) {
		const label = `${session.running ? '● ' : ''}${session.label}`
		buttons.push(commandButton(label, switchCommand(session.sessionId)))
	}
	if (pages > 1) {
		if (current > 1) buttons.push(callbackButton('上一页', data.page(dir, current - 1)))
		if (current < pages) buttons.push(callbackButton('下一页', data.page(dir, current + 1)))
	}
	buttons.push(commandButton('不指定会话', switchCommand('none')))

	return { content: lines.join('\n'), keyboard: keyboardOf(rowsOf(buttons, 3)) }
}

/**
 * 一轮结束通知 + 「我需要回复」按钮。
 *
 * 按钮是回调按钮：点了由插件校验后向会话注入一条唤醒消息（不再自动催促 AI）。
 */
export function buildNoticeCard({ label, sessionId }) {
	const content = `${label}已结束`
	const button = callbackButton('我需要回复', data.needReply(sessionId), { visited: '已触发' })
	return { content, keyboard: keyboardOf([{ buttons: [button] }]) }
}

/**
 * 提问卡片。
 *
 * 关键设计（用户要求）：**按钮上只写字母**，字母对应的选项与"选项下面的小字"
 * （description）全部写在题干与按钮之间的 markdown 正文里。
 *
 * @param {object} input
 * @param {string} input.callId
 * @param {Array<{id:string, question:string, header?:string, detail?:string, options?:Array<{label:string, description?:string}>, multiSelect?:boolean}>} input.questions
 * @param {object} [input.answers] 题序 → { selected: string[], custom?: string }
 * @param {number|null} [input.customFor] 正在等待"其他"输入的题序
 * @param {number} [input.maxButtons]
 * @returns {{content:string, keyboard:object}|null} 按钮超限时返回 null（调用方降级到 dsh GUI）
 */
export function buildQuestionCard({ callId, questions, answers = {}, customFor = null, maxButtons = 15 }) {
	const buttons = []
	const blocks = []

	questions.forEach((question, qIndex) => {
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
				const mark = selected.has(option.label) ? '✅ ' : ''
				lines.push(`**${letter}.** ${mark}${option.label}`)
				if (option.description) lines.push(`> ${option.description}`)
				lines.push('')
				buttons.push(
					callbackButton(letter, data.question(callId, qIndex, `opt-${oIndex}`), {
						visited: letter,
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

	const submit = callbackButton('提交', data.question(callId, 0, 'submit'))
	const allButtons = [...buttons, submit]
	if (allButtons.length > maxButtons) return null

	const content = [...blocks, '> 不选任何字母直接点「提交」= 跳过本题。'].join('\n---\n')
	return { content, keyboard: keyboardOf(rowsOf(allButtons, 4)) }
}
