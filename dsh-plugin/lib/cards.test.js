import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
	MODEL_LABEL_WIDTH_LIMIT,
	PROVIDER_LABEL_WIDTH_LIMIT,
	QUESTION_MAX_BUTTONS,
	buildInboxCard,
	buildInboxResult,
	buildMkdirPromptCard,
	buildModelConfirmCard,
	buildModelListCard,
	buildModelProviderCard,
	buildModelSessionPromptCard,
	buildNewSessionCard,
	buildNoticeCard,
	buildPermissionCard,
	buildQuestionCard,
	buildQuestionCards,
	buildQuestionResult,
	buildRunningCard,
	buildSessionCard,
	SHORTCUT_MAX_BUTTONS,
	buildShortcutCard,
	buttonsPerRowFor,
	callbackButton,
	clipLabel,
	data,
	displayWidth,
	parseCallback,
} from './cards.js'

test('clipLabel 按显示宽度截断（中文算 2）', () => {
	assert.equal(displayWidth('abc'), 3)
	assert.equal(displayWidth('中文'), 4)
	assert.equal(clipLabel('短'), '短')
	assert.equal(clipLabel('一二三四五六'), '一二三四…')
	assert.ok(displayWidth(clipLabel('一二三四五六')) <= 10)
	assert.equal(clipLabel('a very long english label'), 'a very lo…')
	assert.equal(clipLabel(''), '…')
})

test('按钮必填项齐全：回调按钮 type=1、指令按钮 type=2', () => {
	const callback = callbackButton('A', 'qqb:q:1:0:opt:0')
	assert.equal(callback.action.type, 1)
	assert.equal(callback.action.data, 'qqb:q:1:0:opt:0')
	assert.equal(callback.action.permission.type, 2)
	assert.ok(callback.action.unsupport_tips)
	assert.equal(callback.render_data.visited_label, 'A')
})

test('会话选择卡片：文件夹是回调按钮，会话是指令按钮（只填输入框）', () => {
	const card = buildSessionCard({
		dir: '/home/u',
		dirs: [{ name: 'proj-a', path: '/home/u/proj-a' }],
		sessions: [{ sessionId: 'session-1', label: '项目甲', running: true }],
		currentLabel: '项目乙(session-9)',
		switchCommand: (id) => (id === 'none' ? '切换会话 none' : `切换会话 ${id}`),
	})

	const buttons = card.keyboard.content.rows.flatMap((row) => row.buttons)
	const folder = buttons.find((b) => b.action.data === data.dir('/home/u/proj-a'))
	const session = buttons.find((b) => b.action.data === '切换会话 session-1')
	const none = buttons.find((b) => b.action.data === '切换会话 none')

	assert.ok(folder, '应有子目录按钮')
	assert.equal(folder.action.type, 1, '文件夹必须是回调按钮')
	assert.ok(session, '应有会话按钮')
	assert.equal(session.action.type, 2, '会话必须是指令按钮（只填输入框）')
	assert.ok(none, '应有"不指定会话"按钮')
	assert.equal(none.action.type, 2)
	assert.match(card.content, /切换会话/)
	assert.match(card.content, /项目乙/)
	assert.match(String(session.render_data.label), /项目甲/)
})

test('结束通知：标题(会话id)已结束 + 「我需要回复」回调按钮', () => {
	const card = buildNoticeCard({ label: '项目甲(session-1)', sessionId: 'session-1' })
	assert.equal(card.content, '项目甲(session-1)已结束')
	const button = card.keyboard.content.rows[0].buttons[0]
	assert.equal(button.render_data.label, '我需要回复')
	assert.equal(button.render_data.visited_label, '已触发')
	assert.equal(button.action.type, 1)
	assert.equal(button.action.data, data.needReply('session-1'))
})

test('提问卡片：按钮只写字母，字母对照与选项小字写在正文里', () => {
	const card = buildQuestionCard({
		callId: 'call-1',
		questions: [
			{
				id: 'q1',
				header: '部署方式',
				question: '这次改动怎么上线？',
				options: [
					{ label: '直接上线', description: '影响面小，回滚快' },
					{ label: '先灰度 10%', description: '需要额外开关' },
					{ label: '今天不动', description: '维持现状' },
				],
			},
		],
	})

	assert.ok(card)
	// 正文里要有字母对照 + 选项下面的小字
	assert.match(card.content, /\*\*A\.\*\*/)
	assert.match(card.content, /直接上线/)
	assert.match(card.content, /> 影响面小，回滚快/)
	assert.match(card.content, /先灰度 10%/)
	assert.match(card.content, /今天不动/)

	const labels = card.keyboard.content.rows.flatMap((row) => row.buttons.map((b) => b.render_data.label))
	assert.deepEqual(labels, ['A', 'B', 'C', '其他', '提交'])

	const buttons = card.keyboard.content.rows.flatMap((row) => row.buttons)
	const byAction = (value) => buttons.find((b) => b.action.data === value)
	assert.ok(byAction(data.question('call-1', 0, 'opt-0')), '字母按钮应回传选项下标')
	assert.ok(byAction(data.question('call-1', 0, 'custom')), '应有「其他」按钮')
	assert.ok(byAction(data.question('call-1', 0, 'submit')), '应有「提交」按钮')
})

test('提问卡片：多题一次性展示，并在正文里说明"不选直接提交=跳过"', () => {
	const card = buildQuestionCard({
		callId: 'c2',
		questions: [
			{ id: 'q1', question: '第一问', options: [{ label: '是' }, { label: '否' }] },
			{ id: 'q2', question: '第二问', options: [{ label: '甲' }, { label: '乙' }] },
		],
		answers: { 0: { selected: ['否'] } },
	})
	assert.match(card.content, /提问 1\/2/)
	assert.match(card.content, /提问 2\/2/)
	assert.match(card.content, /跳过/)
	// 已选项要有标记
	assert.match(card.content, /✅ 否/)
	// 命令照常生效的提示
	assert.match(card.content, /命令.*照常生效/)

	// 选中态**同时**用按钮自身的 style 表示：选中＝蓝(1)、未选中＝灰(0)
	const buttons = card.keyboard.content.rows.flatMap((row) => row.buttons)
	const selected = buttons.find((b) => b.render_data.label === 'B') // 第一问的「否」
	const unselected = buttons.find((b) => b.render_data.label === 'A') // 第一问的「是」
	assert.equal(selected.render_data.style, 1, '选中的字母按钮用蓝色')
	assert.equal(unselected.render_data.style, 0, '未选中的用灰色')
})

test('提问卡片：按钮数超上限返回 null（调用方降级到 dsh GUI）', () => {
	const card = buildQuestionCard({
		callId: 'c3',
		questions: [{ id: 'q1', question: '题', options: Array.from({ length: 20 }, (_, i) => ({ label: `选项${i}` })) }],
		maxButtons: 5,
	})
	assert.equal(card, null)
})

// 补票：线上真踩过——4 道题 17 个按钮，超过旧上限 15 后**整张卡片返回 null**，
// 静默降级到 dsh GUI，QQ 侧的用户什么都看不到，提问一直悬着。
test('提问卡片：4 道题 17 个按钮要能放进一张卡（旧上限 15 会整张作废）', () => {
	const questions = [
		{ id: 'q1', question: '一', options: [{ label: 'a1' }, { label: 'a2' }, { label: 'a3' }, { label: 'a4' }, { label: 'a5' }] },
		{ id: 'q2', question: '二', options: [{ label: 'b1' }, { label: 'b2' }, { label: 'b3' }] },
		{ id: 'q3', question: '三', options: [{ label: 'c1' }, { label: 'c2' }] },
		{ id: 'q4', question: '四', options: [{ label: 'd1' }, { label: 'd2' }] },
	]
	const cards = buildQuestionCards({ callId: 'c4', questions })
	assert.ok(cards, '4 道题必须能出卡（否则 QQ 用户看不到提问）')
	assert.equal(cards.length, 1, '17 个按钮放进一张卡，不该拆')
	assert.equal(cards[0].indices.length, 4)
	const rows = cards[0].keyboard.content.rows
	assert.ok(rows.length <= 5, `行数 ${rows.length} 超平台上限（会 40034029 拒收）`)
	const buttons = rows.flatMap((row) => row.buttons)
	assert.equal(buttons.length, 17)
	assert.equal(buttons.filter((b) => b.render_data.label === '提交').length, 1)
	assert.ok(QUESTION_MAX_BUTTONS >= 17)
})

test('提问卡片：一卡放不下就拆成多张，每张都带「提交」且不超平台行数', () => {
	const mk = (n, count) => ({ id: `q${n}`, question: `第${n}题`, options: Array.from({ length: count }, (_, i) => ({ label: `o${n}-${i}` })) })
	const questions = [mk(1, 5), mk(2, 5), mk(3, 5), mk(4, 5), mk(5, 5), mk(6, 5)]
	const cards = buildQuestionCards({ callId: 'c5', questions })
	assert.ok(cards)
	assert.ok(cards.length > 1, '36 个选项放不下一张卡，必须拆分')
	assert.deepEqual(
		cards.flatMap((card) => card.indices),
		[0, 1, 2, 3, 4, 5],
		'拆分后每道题都要出现，且只出现一次',
	)
	for (const card of cards) {
		const rows = card.keyboard.content.rows
		assert.ok(rows.length <= 5, `拆出来的卡片行数 ${rows.length} 超限`)
		const buttons = rows.flatMap((row) => row.buttons)
		assert.ok(buttons.length <= QUESTION_MAX_BUTTONS, `单卡按钮 ${buttons.length} 超上限`)
		assert.equal(buttons.filter((b) => b.render_data.label === '提交').length, 1, '每张卡片都要能「提交」')
	}
	assert.match(cards[1].content, /本卡是第 2\/2 张/)
	assert.match(cards[1].content, /提交/)
	// 第二张卡里的选项回调要带**真实题序**（3/4/5），不能从 0 重排
	const labels = cards[1].keyboard.content.rows
		.flatMap((row) => row.buttons)
		.map((b) => b.action.data)
	assert.ok(labels.some((raw) => /:q:3:opt-0:/.test(raw)), `第二张卡的按钮要指向第 4 题，实际：${labels.join(' | ')}`)
})

test('提问卡片：单道题自己就放不下时仍然返回 null（不截断选项）', () => {
	const questions = [{ id: 'q1', question: '题', options: Array.from({ length: 30 }, (_, i) => ({ label: `选项${i}` })) }]
	assert.equal(buildQuestionCards({ callId: 'c6', questions }), null)
})

test('会话卡片不超平台键盘限额（≤5 行、每行 ≤5 按钮），装不下就翻页', () => {
	const dirs = Array.from({ length: 12 }, (_, i) => ({ name: `dir${i}`, path: `/home/u/dir${i}` }))
	const sessions = Array.from({ length: 10 }, (_, i) => ({ sessionId: `session-${i}`, label: `会话${i}` }))
	const flat = (card) => card.keyboard.content.rows.flatMap((row) => row.buttons)
	const build = (page) =>
		buildSessionCard({
			dir: '/home/u',
			dirs,
			sessions,
			currentLabel: null,
			page,
			pageSize: 8,
			switchCommand: (id) => `切换会话 ${id}`,
		})

	const first = build(1)
	const rows = first.keyboard.content.rows
	assert.ok(rows.length <= 5, `行数 ${rows.length} 超平台上限（线上就是被 40034029 拒收的）`)
	for (const row of rows) assert.ok(row.buttons.length <= 5, `某行按钮数 ${row.buttons.length} 超限`)
	assert.ok(flat(first).some((b) => b.render_data.label === '下一页'), '装不下必须有下一页')
	assert.ok(flat(first).some((b) => b.render_data.label === '不指定会话'), '导航按钮必须还在')

	const last = build(999)
	assert.ok(last.keyboard.content.rows.length <= 5)
	assert.ok(flat(last).some((b) => b.render_data.label === '上一页'))
	assert.ok(flat(last).some((b) => b.render_data.label === '不指定会话'))
})

// 这条守卫是补票：线上曾因为"卡片排满 5 行后，调用方又外挂一行「返回上级」"
// 被平台 40034029 拒收。现在「返回上级」必须与导航同处一行。
test('会话卡片：「返回上级」+「运行中会话」+「不指定会话」同处一行（用户指定顺序），总行数仍 ≤5', () => {
	const dirs = Array.from({ length: 9 }, (_, i) => ({ name: `dir${i}`, path: `/home/u/dir${i}` }))
	const sessions = Array.from({ length: 9 }, (_, i) => ({ sessionId: `session-${i}`, label: `会话${i}` }))
	const card = buildSessionCard({
		dir: '/home/u',
		dirs,
		sessions,
		currentLabel: null,
		page: 2,
		pageSize: 8,
		parentPath: '/home',
		switchCommand: (id) => `切换会话 ${id}`,
	})
	const rows = card.keyboard.content.rows
	assert.ok(rows.length <= 5, `行数 ${rows.length} 超限（线上就是这么被拒收的）`)
	const nav = rows[rows.length - 1]
	const labels = nav.buttons.map((b) => b.render_data.label)
	// 用户要求（2026-10-16）：「运行中会话」夹在「返回上级」与「不指定会话」之间。
	assert.deepEqual(labels, ['返回上级', '运行中会话', '不指定会话'], '导航行顺序：返回上级 → 运行中会话 → 不指定会话')
	assert.equal(nav.buttons[0].action.data, data.dir('/home'))
	assert.equal(nav.buttons[1].action.data, 'qqb:run:?page=1', '「运行中会话」是回调按钮（点开那张卡），不是填命令')
	assert.equal(nav.buttons[1].action.type, 1, '回调按钮 type=1')
	assert.equal(nav.buttons[2].action.type, 2, '「不指定会话」仍是指令按钮（填 `切换会话 none`）')

	// 根目录没有「返回上级」时这一行就两个按钮，顺序不变。
	const rootCard = buildSessionCard({
		dir: '/',
		dirs: [],
		sessions: [{ sessionId: 'session-9', label: '会话9' }],
		currentLabel: '会话9(session-9)',
		parentPath: null,
		switchCommand: (id) => `切换会话 ${id}`,
	})
	const rootNav = rootCard.keyboard.content.rows.at(-1).buttons.map((b) => b.render_data.label)
	assert.deepEqual(rootNav, ['运行中会话', '不指定会话'])
})

// 用户要求（2026-10-16）：新增「运行中会话」——正文看具体运行状况，**按钮只写编号**；
// 每行 3 个、满 4 行（12 个）一页，**第 5 行留给翻页**。
test('运行中会话卡片：正文写详情、按钮只写编号；3/行、12 个一页、第 5 行翻页', () => {
	const items = Array.from({ length: 14 }, (_, i) => ({
		sessionId: `s-${i + 1}`,
		label: `会${i + 1}`,
		status: `运行中（第 ${i + 1} 轮，已跑 ${i} 秒）`,
		current: i === 0,
	}))
	const card = buildRunningCard({ items, currentLabel: '会1(s-1)' })
	const rows = card.keyboard.content.rows
	assert.equal(rows.length, 5, '4 行内容 + 1 行翻页')
	assert.deepEqual(
		rows.slice(0, 4).map((row) => row.buttons.map((b) => b.render_data.label)),
		[
			['1', '2', '3'],
			['4', '5', '6'],
			['7', '8', '9'],
			['10', '11', '12'],
		],
		'按钮只写编号，每行 3 个，一页 12 个',
	)
	assert.deepEqual(rows[4].buttons.map((b) => b.render_data.label), ['下一页'], '第 5 行翻页')
	assert.equal(rows[0].buttons[0].action.data, 'qqb:run:s-1?page=1', '编号点一下直接切（带当前页）')
	assert.equal(rows[0].buttons[0].action.type, 1, '回调按钮：点一下当场切')
	assert.equal(rows[0].buttons[0].render_data.style, 1, '当前会话的编号是蓝的')
	assert.equal(rows[0].buttons[1].render_data.style, 0, '其余灰的')

	// 正文：具体运行状况在上面（编号 + 标题 + 会话id + 第 N 轮/已跑多久）
	assert.match(card.content, /^\*\*运行中会话\*\*/)
	assert.match(card.content, /当前会话：`会1\(s-1\)`/)
	assert.match(card.content, /共 14 个正在跑 · 第 1\/2 页（每页 12 个）/)
	assert.match(card.content, /^1\. ● \*\*会1\*\*/m)
	assert.match(card.content, /`s-1`/)
	assert.match(card.content, /第 1 轮，已跑 0 秒/)
	assert.doesNotMatch(card.content, /^13\. /m, '第 13 个在第 2 页')

	// 第 2 页：正文列剩下的，按钮从 1 重新编号，翻页行给「上一页」
	const page2 = buildRunningCard({ items, currentLabel: '会1(s-1)', page: 2 })
	const rows2 = page2.keyboard.content.rows
	assert.equal(rows2[0].buttons.length, 2, '第 2 页只剩 2 个')
	assert.deepEqual(rows2[0].buttons.map((b) => b.render_data.label), ['1', '2'])
	assert.equal(rows2[0].buttons[0].action.data, 'qqb:run:s-13?page=2', '第 2 页的 1 号 = 第 13 个会话')
	assert.deepEqual(rows2[1].buttons.map((b) => b.render_data.label), ['上一页'])
	assert.match(page2.content, /^1\. ● \*\*会13\*\*/m)
	assert.match(page2.content, /第 2\/2 页/)

	// 正好 12 个：不需要翻页行（只占 4 行）
	const exact = buildRunningCard({ items: items.slice(0, 12) })
	assert.equal(exact.keyboard.content.rows.length, 4)
	assert.match(exact.content, /第 1\/1 页/)

	// 一个都没有：不给按钮，明说一句（别发一张空卡片让人猜）
	const empty = buildRunningCard({ items: [], currentLabel: '' })
	assert.equal(empty.keyboard.content.rows.length, 0)
	assert.match(empty.content, /没有正在跑的会话/)
	assert.match(empty.content, /`none`（未绑定）/)
})

test('回调 data：run 带页码（切完不回第一页）、runPage 翻页；解析回来对得上', () => {
	assert.equal(data.run(), 'qqb:run:?page=1')
	assert.deepEqual(parseCallback(data.run()), { kind: 'run', sessionId: '', page: 1 })
	assert.deepEqual(parseCallback(data.run('session-9', 3)), { kind: 'run', sessionId: 'session-9', page: 3 })
	assert.equal(data.runPage(2), 'qqb:runp:2')
	assert.deepEqual(parseCallback(data.runPage(2)), { kind: 'runpage', page: 2 })
	assert.equal(parseCallback('qqb:run'), null, '缺冒号的残缺 data 不该被认')
})

test('新建会话卡片：只列子目录，导航行是「返回上级」+「在这里新建」', () => {
	const dirs = [
		{ name: 'proj-a', path: '/home/u/proj-a' },
		{ name: 'proj-b', path: '/home/u/proj-b' },
	]
	const card = buildNewSessionCard({ dir: '/home/u', dirs, parentPath: '/home' })
	const rows = card.keyboard.content.rows
	assert.ok(rows.length <= 5)
	const buttons = rows.flatMap((row) => row.buttons)
	assert.equal(buttons.filter((b) => b.action.data === data.newDir('/home/u/proj-a')).length, 1, '子目录用 newdir 回调')
	assert.deepEqual(
		buttons.filter((b) => b.action.data === data.newHere('/home/u')).map((b) => b.render_data.label),
		['在这里新建'],
	)
	assert.ok(buttons.some((b) => b.action.data === data.newDir('/home')))
	assert.match(card.content, /在这里新建/)
})

test('parseCallback 覆盖四类数据，非本插件的数据返回 null', () => {
	// 目录浏览分两种模式：切换会话 / 新建会话选目录（回调 data 里带模式，无状态）
	assert.deepEqual(parseCallback(data.dir('/home/u')), { kind: 'dir', mode: 'switch', path: '/home/u', page: 1 })
	assert.deepEqual(parseCallback(`${data.dir('/home/u')}?page=3`), { kind: 'dir', mode: 'switch', path: '/home/u', page: 3 })
	assert.deepEqual(parseCallback(data.newDir('/home/u')), { kind: 'dir', mode: 'new', path: '/home/u', page: 1 })
	assert.deepEqual(parseCallback(data.newHere('/home/u')), { kind: 'newhere', path: '/home/u' })
	assert.deepEqual(parseCallback(data.needReply('session-7')), { kind: 'needreply', sessionId: 'session-7' })
	assert.deepEqual(parseCallback(data.question('call-1', 2, 'opt-1')), {
		kind: 'question',
		callId: 'call-1',
		questionIndex: 2,
		action: 'opt-1',
	})
	assert.equal(parseCallback('something-else'), null)
	assert.equal(parseCallback(undefined), null)
})

test('parseCallback：输入态卡片的删除/翻页/发送/清空/取消都能还原', () => {
	assert.deepEqual(parseCallback(data.inbox('rm', 'A3')), { kind: 'inbox', action: 'rm', arg: 'A3' })
	assert.deepEqual(parseCallback(data.inbox('page', '2')), { kind: 'inbox', action: 'page', page: 2 })
	assert.deepEqual(parseCallback(data.inbox('send')), { kind: 'inbox', action: 'send', arg: '' })
	assert.deepEqual(parseCallback(data.inbox('clear')), { kind: 'inbox', action: 'clear', arg: '' })
	assert.deepEqual(parseCallback(data.inbox('cancel')), { kind: 'inbox', action: 'cancel', arg: '' })
})

test('输入态预览卡片：每个附件一个「删除」，语音转写单独一段且排在附件之前', () => {
	const card = buildInboxCard({
		label: 'proj-a(session-1)',
		sessionId: 'session-1',
		text: '看看这个',
		items: [
			{ id: 'A1', kind: 'image', filename: 'cat.png', size: 2048, status: 'stored', image: true },
			{ id: 'A2', kind: 'video', filename: 'big.mp4', size: 999, status: 'oversize', note: '超过自动下载上限 50.0 MB' },
			{ id: 'A3', kind: 'voice', status: 'voice', asrText: '帮我看下' },
		],
		voice: ['帮我看下'],
	})

	assert.match(card.content, /\*\*输入框\*\*/)
	assert.match(card.content, /看看这个/)
	assert.match(card.content, /A1.*cat\.png.*已下载/)
	assert.match(card.content, /A2.*未下载/)
	assert.match(card.content, /A3.*转写：帮我看下/)
	assert.ok(
		card.content.indexOf('**语音转写**') < card.content.indexOf('**附件（3）**'),
		'语音转写要排在附件之前（优先级更高）',
	)

	const labels = card.keyboard.content.rows.flatMap((row) => row.buttons.map((b) => b.render_data.label))
	// 用户要求：取消在最左、发送在最右
	assert.deepEqual(labels, ['删除 A1', '删除 A2', '删除 A3', '取消', '清空正文', '发送'])
	assert.ok(card.keyboard.content.rows.length <= 5)
})

test('输入态预览卡片：附件多时翻页，且每页都不超平台行数', () => {
	const items = Array.from({ length: 10 }, (_, i) => ({
		id: `A${i + 1}`,
		kind: 'file',
		filename: `f${i + 1}.bin`,
		size: 10,
		status: 'stored',
	}))
	const first = buildInboxCard({ label: 'x(s-1)', sessionId: 's-1', text: '', items, page: 1, pageSize: 8 })
	const labels = first.keyboard.content.rows.flatMap((row) => row.buttons.map((b) => b.render_data.label))
	assert.equal(labels.filter((label) => label.startsWith('删除')).length, 8)
	assert.ok(labels.includes('下一页'))
	assert.ok(!labels.includes('上一页'))
	assert.ok(!labels.includes('清空正文'), '没正文就不出现「清空正文」')
	assert.match(first.content, /第 1\/2 页/)
	assert.ok(first.keyboard.content.rows.length <= 5)

	const second = buildInboxCard({ label: 'x(s-1)', sessionId: 's-1', text: '', items, page: 2, pageSize: 8 })
	const secondLabels = second.keyboard.content.rows.flatMap((row) => row.buttons.map((b) => b.render_data.label))
	assert.equal(secondLabels.filter((label) => label.startsWith('删除')).length, 2)
	assert.ok(secondLabels.includes('上一页'))
	assert.ok(!secondLabels.includes('下一页'))
	assert.ok(second.keyboard.content.rows.length <= 5)
})

test('提问结果预览：逐题列出选项/其他/跳过（卡片撤回后还能看到答了什么）', () => {
	const content = buildQuestionResult({
		questions: [
			{ id: 'q1', header: '部署方式', question: '这次改动怎么上线？' },
			{ id: 'q2', question: '要不要通知你？' },
			{ id: 'q3', question: '还有别的吗？' },
		],
		answers: [
			{ id: 'q1', selected: ['先灰度 10%'] },
			{ id: 'q2', selected: [], custom: '跑完给我发一条' },
			{ id: 'q3', selected: [] },
		],
	})
	assert.match(content, /\*\*提问结果\*\* · 3 题/)
	assert.match(content, /1\. 部署方式 · 这次改动怎么上线？/)
	assert.match(content, /> ✅ 先灰度 10%/)
	assert.match(content, /✍️ 其他：跑完给我发一条/)
	assert.match(content, /（没选，按跳过处理）/)
})

test('发送结果预览：正文、语音转写、附件各归各位（语音不再算附件）', () => {
	const content = buildInboxResult({
		label: 'proj-a(session-1)',
		sessionId: 'session-1',
		text: '看看这个\n第二行',
		items: [
			{ id: 'A1', kind: 'image', filename: 'cat.png', size: 2048, status: 'stored', image: true },
			{ id: 'A2', kind: 'file', filename: 'a.pdf', size: 1024, status: 'stored' },
			{ id: 'A3', kind: 'voice', status: 'voice', asrText: '帮我查一下这个报错' },
		],
		voice: [{ id: 'A3', kind: 'voice', status: 'voice', asrText: '帮我查一下这个报错' }],
	})
	assert.match(content, /\*\*已发送\*\* · proj-a\(session-1\)/)
	assert.match(content, /\*\*正文（8 字）\*\*/)
	assert.match(content, /> 看看这个/)
	assert.match(content, /> 第二行/)
	assert.match(content, /\*\*语音转写（平台，可能有误）\*\*/)
	assert.match(content, /🎙 A3：帮我查一下这个报错/)
	assert.match(content, /\*\*附件（2）\*\*/)
	assert.match(content, /A1.*cat\.png.*已下载/)
	assert.match(content, /A2.*a\.pdf/)
	assert.ok(!/\*\*附件（3）\*\*/.test(content), '语音不该算进附件数')
})

test('发送结果预览：超长正文截断并说明；没有正文/附件时如实写"没有"', () => {
	const long = 'x'.repeat(500)
	const content = buildInboxResult({ label: 'L', sessionId: 's-1', text: long, items: [] })
	assert.match(content, /（太长，这里只显示前 400 字）/)
	assert.match(content, /（没有附件）/)

	const empty = buildInboxResult({ label: 'L', sessionId: 's-1', text: '', items: [] })
	assert.match(empty, /\*\*正文（0 字）\*\*/)
	assert.match(empty, /> （没有正文）/)
})

test('新建会话卡片：导航行是 返回上级 | 新建目录 | 在这里新建（顺序固定）', () => {
	const card = buildNewSessionCard({ dir: '/home/u/proj-a', dirs: [], parentPath: '/home/u' })
	const labels = card.keyboard.content.rows.flatMap((row) => row.buttons).map((b) => b.render_data.label)
	assert.deepEqual(labels, ['返回上级', '新建目录', '在这里新建'], '新建目录要夹在返回上级与在这里新建之间')
	assert.doesNotMatch(labels.join('/'), /删除目录/, '目录非空时不出现「删除目录」')
	const card2 = buildNewSessionCard({ dir: '/home/u/empty', dirs: [], parentPath: '/home/u', empty: true })
	const labels2 = card2.keyboard.content.rows.flatMap((row) => row.buttons).map((b) => b.render_data.label)
	assert.deepEqual(labels2, ['返回上级', '新建目录', '在这里新建', '删除目录'], '空目录才在最右侧多一个「删除目录」')
	assert.match(card2.content, /这个目录是空的/)
	assert.match(card2.content, /新建目录/)
	// 根目录（没有上级）时仍然有新建目录/在这里新建
	const root = buildNewSessionCard({ dir: '/', dirs: [], parentPath: null, empty: true })
	const rootLabels = root.keyboard.content.rows.flatMap((row) => row.buttons).map((b) => b.render_data.label)
	assert.deepEqual(rootLabels, ['新建目录', '在这里新建', '删除目录'])
})

test('新建会话卡片：删除目录的第二步只给「取消 / 确认删除」，且不超行数', () => {
	const card = buildNewSessionCard({ dir: '/home/u/empty', dirs: [], parentPath: '/home/u', empty: true, confirming: true })
	const labels = card.keyboard.content.rows.flatMap((row) => row.buttons).map((b) => b.render_data.label)
	assert.deepEqual(labels, ['取消', '确认删除'], '二次确认这一步不给别的动作')
	assert.match(card.content, /确认删除这个目录/)
	assert.match(card.content, /只会删\*\*空目录\*\*/)
	assert.ok(card.keyboard.content.rows.length <= 5)
	// 「确认删除」的回调认得出是第二步
	assert.equal(parseCallback(data.rmdirYes('/home/u/empty')).kind, 'rmdiryes')
	assert.equal(parseCallback(data.rmdir('/home/u/empty')).kind, 'rmdir')
	assert.equal(parseCallback(data.mkdir('/home/u/empty')).kind, 'mkdir')
	assert.deepEqual(parseCallback(data.mkdir('/home/u/empty')), { kind: 'mkdir', path: '/home/u/empty' })
})

test('新建目录提示卡片：自带明确的「取消」按钮', () => {
	const card = buildMkdirPromptCard({ dir: '/home/u/proj' })
	assert.match(card.content, /新建目录/)
	assert.match(card.content, /父目录：`\/home\/u\/proj`/)
	assert.match(card.content, /点下面的「取消」/)
	const buttons = card.keyboard.content.rows.flatMap((row) => row.buttons)
	assert.deepEqual(buttons.map((b) => b.render_data.label), ['取消'], '只有一枚「取消」')
	assert.deepEqual(parseCallback(buttons[0].action.data), { kind: 'mkcancel', path: '/home/u/proj' })
})

test('新建会话卡片：空目录的「删除目录」单独占一行（不与导航挤一起）', () => {
	const card = buildNewSessionCard({ dir: '/home/u/empty', dirs: [], parentPath: '/home/u', empty: true })
	const rows = card.keyboard.content.rows.map((row) => row.buttons.map((b) => b.render_data.label))
	assert.deepEqual(rows.at(-1), ['删除目录'], '破坏性动作单独一行')
	assert.deepEqual(rows.at(-2), ['返回上级', '新建目录', '在这里新建'])
	assert.ok(card.keyboard.content.rows.length <= 5)
})

test('结束通知：多一个「发送消息」指令按钮，填入 `发送 <会话id>`', () => {
	const card = buildNoticeCard({
		label: '项目甲(session-1)',
		sessionId: 'session-1',
		sendCommand: (sessionId) => `发送 ${sessionId}`,
	})
	const buttons = card.keyboard.content.rows[0].buttons
	assert.deepEqual(buttons.map((b) => b.render_data.label), ['我需要回复', '发送消息'])
	assert.equal(buttons[1].action.type, 2, '指令按钮（type=2）才会填输入框')
	assert.equal(buttons[1].action.data, '发送 session-1')
	assert.equal(buttons[1].action.permission.type, 2)
	// 不传 sendCommand 时保持只有一个按钮（向后兼容）
	const plain = buildNoticeCard({ label: '项目甲(session-1)', sessionId: 'session-1' })
	assert.deepEqual(plain.keyboard.content.rows[0].buttons.map((b) => b.render_data.label), ['我需要回复'])
})

// 用户要求（2026-10-16）：`reason=error` 不能再说成"被打断" —— 要写「出现错误」+ 具体报错。
test('结束通知：出错时说「出现错误」并带上具体报错（不再混成"被打断"）', () => {
	const message =
		'prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")'
	const card = buildNoticeCard({
		label: '项目甲(session-1)',
		sessionId: 'session-1',
		interrupted: true, // 出错也属于"非正常结束"，但要盖过"被打断"的措辞
		error: message,
		source: '打断来自某条消息（出错时不该出现）',
	})
	assert.equal(card.content, `项目甲(session-1)出现错误\n> 错误：${message}`)
	assert.doesNotMatch(card.content, /被打断/)
	assert.doesNotMatch(card.content, /打断来自/)
	// 按钮照旧（错误卡也要能点「我需要回复」）
	assert.deepEqual(card.keyboard.content.rows[0].buttons.map((b) => b.render_data.label), ['我需要回复'])

	// 超长报错要截断（平台一条消息有限长，别把整段栈塞进去）
	const long = buildNoticeCard({ label: 'x(s1)', sessionId: 's1', error: 'E'.repeat(500) })
	const quotedLine = long.content.split('\n')[1]
	assert.ok(quotedLine.startsWith('> 错误：EEE'))
	assert.ok(quotedLine.endsWith('…'), '截断要带省略号')
	assert.ok(quotedLine.length <= 170, `截断后不该太长：${quotedLine.length}`)

	// 空/空白 error 不算出错：退回原来的措辞
	assert.equal(buildNoticeCard({ label: 'x(s1)', sessionId: 's1', error: '   ' }).content, 'x(s1)已结束')
	assert.equal(
		buildNoticeCard({ label: 'x(s1)', sessionId: 's1', interrupted: true, error: '' }).content,
		'x(s1)被打断',
	)
})

// 用户要求（2026-10-16）：新增「已开始」通知；QQ 消息打断时不另发开始卡、并进「被打断」卡；
// 命令（`发送`/`快捷`）自己的回执已提示过打断 → 不并这句。
test('开始通知：`已开始` / 续跑带说明 / 打断卡并进"新一轮已开始"', () => {
	const plain = buildNoticeCard({ label: '项目甲(session-1)', sessionId: 'session-1', started: true })
	assert.equal(plain.content, '项目甲(session-1)已开始')
	assert.equal(plain.keyboard.content.rows[0].buttons[0].render_data.label, '我需要回复', '开始卡也带"我需要回复"')

	const chain = buildNoticeCard({ label: '项目甲(session-1)', sessionId: 'session-1', started: true, chain: true })
	assert.equal(chain.content, '项目甲(session-1)已开始\n> 目标/计划续跑（沿用你从 QQ 起的那条链）')

	// 打断 + 紧接着起了新一轮 → 并进这张卡（省一张开始卡，防刷屏）
	const folded = buildNoticeCard({
		label: '项目甲(session-1)',
		sessionId: 'session-1',
		interrupted: true,
		source: '改个方向',
		nextRound: true,
	})
	assert.equal(folded.content, '项目甲(session-1)被打断\n> 打断来自：改个方向\n> 已按这条消息开了新一轮')

	// 命令自己的回执已经写过"会打断…" → nextRound 传 false，不并
	const hinted = buildNoticeCard({ label: '项目甲(session-1)', sessionId: 'session-1', interrupted: true, source: '插一条' })
	assert.equal(hinted.content, '项目甲(session-1)被打断\n> 打断来自：插一条')

	// 出错 / 正常结束都不该出现"新一轮已开始"那句
	const failed = buildNoticeCard({ label: 'x(s1)', sessionId: 's1', interrupted: true, error: 'boom', nextRound: true })
	assert.equal(failed.content, 'x(s1)出现错误\n> 错误：boom')
	assert.equal(
		buildNoticeCard({ label: 'x(s1)', sessionId: 's1', nextRound: true }).content,
		'x(s1)已结束',
		'开始/结束互斥：没传 started 就是结束卡',
	)
})

test('权限卡片：每行两个按钮（放不下就加宽），当前项标记出来', () => {
	const options = [
		{ value: 'read-only', name: '仅可查看', description: '只能看' },
		{ value: 'workspace-write', name: '工作区内修改', description: '工作区内可写' },
		{ value: 'danger-full-access', name: '完全权限', description: '不限制' },
		{ value: 'auto', name: 'Auto review', description: '自动审查' },
	]
	const card = buildPermissionCard({ options, current: 'danger-full-access', sessionId: 'session-1', label: '项目甲(session-1)' })
	const rows = card.keyboard.content.rows.map((row) => row.buttons.map((b) => b.render_data.label))
	assert.deepEqual(
		rows,
		[
			[clipLabel('仅可查看'), clipLabel('工作区内修改')],
			[clipLabel('完全权限'), clipLabel('Auto review')],
		],
		'默认每行两个（按钮 label 受平台宽度限制会截断，正文里有完整名字与序号）',
	)
	assert.match(card.content, /当前：\*\*完全权限\*\*/)
	for (const [index, item] of options.entries()) {
		assert.match(card.content, new RegExp(`${index + 1}\\. \\*\\*${item.name}\\*\\*`), '正文里给序号+名字')
	}
	const flat = card.keyboard.content.rows.flatMap((row) => row.buttons)
	assert.equal(flat[2].render_data.style, 1, '当前项用蓝色（style 4 在客户端会渲染成白色，已弃用）')
	assert.equal(flat[0].render_data.style, 0, '非当前项灰色')
	assert.deepEqual(parseCallback(flat[0].action.data), { kind: 'perm', value: 'read-only' })

	// 选项多到 2/行会超行数 → 自动加宽
	assert.equal(buttonsPerRowFor(4), 2)
	assert.equal(buttonsPerRowFor(10), 2)
	assert.equal(buttonsPerRowFor(11), 3, '11 个选项时 2/行放不下（>5 行），加宽到 3/行')
	assert.equal(buttonsPerRowFor(26), 5)
	const wide = buildPermissionCard({ options: Array.from({ length: 11 }, (_, i) => ({ value: `p${i}`, name: `级别${i}` })), current: 'p0' })
	assert.ok(wide.keyboard.content.rows.length <= 5, '整卡行数仍合法')
	assert.equal(wide.keyboard.content.rows[0].buttons.length, 3)
})

test('输入态卡片按钮颜色：发送＝蓝（主），取消/清空正文＝灰（次）——不能反', () => {
	const card = buildInboxCard({ label: '项目甲(session-1)', sessionId: 'session-1', text: '正文', items: [], voice: '', mode: 'send', page: 1, pageSize: 4 })
	const buttons = card.keyboard.content.rows.at(-1).buttons
	assert.deepEqual(buttons.map((b) => b.render_data.label), ['取消', '清空正文', '发送'])
	assert.equal(buttons[0].render_data.style, 0, '取消＝灰（线上用户把蓝色的取消当成了主按钮，点错过）')
	assert.equal(buttons[1].render_data.style, 0, '清空正文＝灰')
	assert.equal(buttons[2].render_data.style, 1, '发送＝蓝（主操作）')
	// 延迟模式同样：主按钮是「延迟发送」
	const delayed = buildInboxCard({ label: 'x', sessionId: 'session-1', text: '', items: [], voice: '', mode: 'delay', page: 1, pageSize: 4 })
	const delayedButtons = delayed.keyboard.content.rows.at(-1).buttons
	assert.deepEqual(delayedButtons.map((b) => b.render_data.label), ['取消', '延迟发送'])
	assert.equal(delayedButtons[0].render_data.style, 0)
	assert.equal(delayedButtons[1].render_data.style, 1)
})

test('删除确认卡片：确认删除＝红（破坏性），取消＝灰', () => {
	const card = buildNewSessionCard({ dir: '/home/u/empty', dirs: [], parentPath: '/home/u', empty: true, confirming: true })
	const buttons = card.keyboard.content.rows.at(-1).buttons
	assert.equal(buttons[0].render_data.label, '取消')
	assert.equal(buttons[0].render_data.style, 0)
	assert.equal(buttons[1].render_data.label, '确认删除')
	assert.equal(buttons[1].render_data.style, 3, '破坏性动作用红色，不用填充蓝')
})

// ── 模型卡片（提供商 → 模型） ─────────────────────────────────────────────

function modelGroups(count) {
	return Array.from({ length: count }, (_, i) => ({
		id: `p${i}`,
		name: `提供商${i}`,
		models: Array.from({ length: 2 }, (_, j) => ({ id: `m${i}-${j}`, name: `模型${i}-${j}`, description: '' })),
	}))
}

test('模型卡片·提供商：每行 2 个、超一页才有翻页行、当前提供商标蓝、整卡不超 5 行', () => {
	// 10 个提供商正好铺满 5 行 × 2 个 → 不需要翻页行
	const full = buildModelProviderCard({ groups: modelGroups(10), current: { provider: 'p3', model: 'm3-0' } })
	const fullRows = full.keyboard.content.rows
	assert.equal(fullRows.length, 5, '10 个供应商正好 5 行 2 列')
	assert.ok(fullRows.every((row) => row.buttons.length === 2), '每行最多 2 个')
	assert.ok(!full.keyboard.content.rows.flatMap((r) => r.buttons).some((b) => b.render_data.label === '下一页'))
	assert.match(full.content, /当前：\*\*提供商3 \/ 模型3-0\*\*/)
	assert.match(full.content, /提供商 10 个 · 模型 20 个/)
	const currentButton = fullRows
		.flatMap((row) => row.buttons)
		.find((b) => b.action.data === data.model('enter', 'p3'))
	assert.equal(currentButton.render_data.style, 1, '当前提供商标蓝')
	assert.equal(currentButton.render_data.visited_label, '当前')

	// 11 个 → 让出一行给翻页（每页 8 个），整卡仍是 5 行
	const paged = buildModelProviderCard({ groups: modelGroups(11), current: null })
	const pagedRows = paged.keyboard.content.rows
	assert.equal(pagedRows.length, 5, '4 行内容 + 1 行翻页')
	assert.equal(pagedRows[0].buttons.length, 2)
	assert.ok(pagedRows.at(-1).buttons.some((b) => b.render_data.label === '下一页'))
	assert.match(paged.content, /第 1\/2 页（每页 8 个提供商）/)
	assert.match(paged.content, /当前：`（读不到，换过之后就会显示）`/, '读不到当前模型也要照常出卡片')
	assert.deepEqual(parseCallback(pagedRows.at(-1).buttons[0].action.data), { kind: 'model', action: 'page', arg: '2' })
	assert.deepEqual(parseCallback(pagedRows[0].buttons[0].action.data), { kind: 'model', action: 'enter', arg: 'p0' })

	// 第二页只剩 3 个，翻页行只有「上一页」
	const second = buildModelProviderCard({ groups: modelGroups(11), current: null, page: 2 })
	const secondLabels = second.keyboard.content.rows.at(-1).buttons.map((b) => b.render_data.label)
	assert.deepEqual(secondLabels, ['上一页'])

	// 读不到模型的提供商单独提示
	const withFailures = buildModelProviderCard({
		groups: modelGroups(2),
		failures: [{ id: 'broken', name: 'Broken', message: '没 key' }],
	})
	assert.match(withFailures.content, /1 个提供商读不到模型：`Broken`/)
})

test('模型卡片·模型列表：每行 1 个、翻页、导航行只有「返回」、label 照发全名', () => {
	const group = {
		id: 'deepseek',
		name: 'DeepSeek',
		models: [
			{ id: 'deepseek-chat', name: 'DeepSeek Chat', description: '通用对话' },
			{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: '深度推理' },
			{ id: 'deepseek-coder', name: 'DeepSeek Coder', description: '' },
			{ id: 'deepseek-vl', name: 'DeepSeek VL', description: '' },
		],
	}
	const card = buildModelListCard({
		group,
		current: { provider: 'deepseek', model: 'deepseek-chat' },
		label: '项目甲(session-1)',
	})
	const rows = card.keyboard.content.rows
	assert.equal(rows.length, 5, '4 行模型（每行 1 个）+ 1 行导航')
	assert.ok(rows.slice(0, 4).every((row) => row.buttons.length === 1), '模型每行最多 1 个')
	const labels = rows.flatMap((row) => row.buttons.map((b) => b.render_data.label))
	assert.deepEqual(labels.slice(4), ['返回'], '导航行只有「返回」——切别的会话走确认卡片（交互式）')
	assert.ok(labels.includes('DeepSeek Reasoner'), 'label 不再被我们自己砍成省略号')

	// 当前模型：标 ✅ + 蓝色 + visited=当前
	assert.match(card.content, /当前：\*\*DeepSeek \/ DeepSeek Chat\*\*/)
	assert.match(card.content, /1\. \*\*DeepSeek Chat\*\* ✅/)
	const currentButton = rows[0].buttons[0]
	assert.equal(currentButton.render_data.style, 1)
	assert.equal(currentButton.render_data.visited_label, '当前')
	assert.equal(rows[1].buttons[0].render_data.style, 0)
	assert.deepEqual(parseCallback(rows[1].buttons[0].action.data), {
		kind: 'model',
		action: 'pick',
		arg: 'deepseek:deepseek-reasoner',
	})
	// 按钮 id 必须唯一（截断后的 label 可能撞车，所以按序编号）
	const ids = rows.flatMap((row) => row.buttons).map((b) => b.id)
	assert.equal(new Set(ids).size, ids.length, '同一键盘内按钮 id 唯一')
	assert.match(card.content, /进确认卡片/)

	// 6 个模型 → 4 就放不下（要留翻页行）：每页 3 个
	const many = {
		id: 'openai',
		name: 'OpenAI',
		models: Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, name: `模型${i}`, description: '' })),
	}
	const paged = buildModelListCard({ group: many, current: null, page: 1 })
	assert.equal(paged.keyboard.content.rows.length, 5, '3 行模型 + 翻页 + 导航')
	assert.match(paged.content, /第 1\/2 页（每页 3 个模型）/)
	assert.deepEqual(
		paged.keyboard.content.rows.at(-2).buttons.map((b) => b.render_data.label),
		['下一页'],
	)
	assert.deepEqual(parseCallback(paged.keyboard.content.rows.at(-2).buttons[0].action.data), {
		kind: 'model',
		action: 'mpage',
		arg: 'openai:2',
	})
	assert.deepEqual(
		paged.keyboard.content.rows.at(-1).buttons.map((b) => b.render_data.label),
		['返回'],
	)

	// 刚切完（chosen）：正文写明"已切到"，并把这一档标成当前
	const chosenCard = buildModelListCard({
		group,
		current: null,
		chosen: { provider: 'deepseek', model: 'deepseek-reasoner' },
	})
	assert.match(chosenCard.content, /✅ 已切到 \*\*DeepSeek \/ DeepSeek Reasoner\*\*/)
	assert.match(chosenCard.content, /2\. \*\*DeepSeek Reasoner\*\* ✅/)
})

test('模型卡片·提供商/模型：长名字照发（不再自己砍成省略号），只挡病态长名字', () => {
	const group = {
		id: 'deepseek-official',
		name: 'DeepSeek Official 官方渠道名字',
		models: [
			{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (Thinking Mode, 128k)', description: '' },
			{ id: 'very-long', name: '名'.repeat(80), description: '' },
		],
	}
	const providers = buildModelProviderCard({ groups: [group] })
	const providerLabel = providers.keyboard.content.rows[0].buttons[0].render_data.label
	assert.ok(providerLabel.startsWith('DeepSeek Official'), '英文全名保留')
	assert.ok(providerLabel.endsWith('…'), '按宽松上限截断')
	assert.ok(displayWidth(providerLabel) > 10, '比原来"10 个显示宽度"宽得多——不再只显示 5 个中文字')
	assert.ok(displayWidth(providerLabel) <= PROVIDER_LABEL_WIDTH_LIMIT)

	const list = buildModelListCard({ group, current: null })
	const modelLabels = list.keyboard.content.rows.flatMap((row) => row.buttons.map((b) => b.render_data.label))
	assert.equal(modelLabels[0], 'DeepSeek Reasoner (Thinking Mode, 128k)', '模型按钮照发全名')
	assert.ok(modelLabels[1].endsWith('…'), '病态长的名字才截断')
	assert.ok(displayWidth(modelLabels[1]) <= MODEL_LABEL_WIDTH_LIMIT)
})

test('模型卡片·确认卡片：应用到当前会话 / 切到其他会话（交互式）/ 返回', () => {
	const group = { id: 'deepseek', name: 'DeepSeek' }
	const model = { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: '深度推理' }
	const card = buildModelConfirmCard({ group, model, label: '项目甲(session-1)' })

	assert.match(card.content, /\*\*模型 · 确认\*\*/)
	assert.match(card.content, /选中的模型：\*\*DeepSeek \/ DeepSeek Reasoner\*\*/)
	assert.match(card.content, /深度推理/)
	assert.match(card.content, /写出\*\*会话id\*\*/)

	const rows = card.keyboard.content.rows
	assert.deepEqual(
		rows.map((row) => row.buttons.map((b) => b.render_data.label)),
		[['应用到当前会话', '切到其他会话'], ['返回']],
	)
	const buttons = rows.flatMap((row) => row.buttons)
	assert.ok(buttons.every((b) => b.action.type === 1), '三个都是交互式回调按钮（不是填输入框的指令按钮）')
	assert.equal(buttons[0].render_data.style, 1, '主操作「应用到当前会话」＝蓝')
	assert.equal(buttons[1].render_data.style, 0)
	assert.equal(buttons[2].render_data.style, 0)
	assert.deepEqual(parseCallback(buttons[0].action.data), {
		kind: 'model',
		action: 'apply',
		arg: 'deepseek:deepseek-reasoner',
	})
	assert.deepEqual(parseCallback(buttons[1].action.data), {
		kind: 'model',
		action: 'other',
		arg: 'deepseek:deepseek-reasoner',
	})
	assert.deepEqual(parseCallback(buttons[2].action.data), { kind: 'model', action: 'back', arg: 'deepseek' })
	assert.ok(card.keyboard.content.rows.length <= 5)
})

test('模型卡片·「切到其他会话」提示卡片：等用户发会话id，自带「取消」', () => {
	const group = { id: 'deepseek', name: 'DeepSeek' }
	const model = { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }
	const card = buildModelSessionPromptCard({ group, model, label: '项目甲(session-1)' })

	assert.match(card.content, /\*\*模型 · 切到其他会话\*\*/)
	assert.match(card.content, /发一条消息写出\*\*会话id\*\*/)
	const buttons = card.keyboard.content.rows.flatMap((row) => row.buttons)
	assert.deepEqual(buttons.map((b) => b.render_data.label), ['取消'])
	assert.equal(buttons[0].action.type, 1)
	assert.deepEqual(parseCallback(buttons[0].action.data), {
		kind: 'model',
		action: 'cancel',
		arg: 'deepseek:deepseek-reasoner',
	})
})

test('模型卡片回调 data 能原样解析回来（端到端契约）', () => {
	assert.deepEqual(parseCallback(data.model('page', '2')), { kind: 'model', action: 'page', arg: '2' })
	assert.deepEqual(parseCallback(data.model('enter', 'deepseek-official')), {
		kind: 'model',
		action: 'enter',
		arg: 'deepseek-official',
	})
	assert.deepEqual(parseCallback(data.model('mpage', 'deepseek:3')), {
		kind: 'model',
		action: 'mpage',
		arg: 'deepseek:3',
	})
	assert.deepEqual(parseCallback(data.model('pick', 'deepseek:deepseek-chat')), {
		kind: 'model',
		action: 'pick',
		arg: 'deepseek:deepseek-chat',
	})
	assert.deepEqual(parseCallback(data.model('apply', 'deepseek:deepseek-chat')), {
		kind: 'model',
		action: 'apply',
		arg: 'deepseek:deepseek-chat',
	})
	assert.deepEqual(parseCallback(data.model('other', 'deepseek:deepseek-chat')), {
		kind: 'model',
		action: 'other',
		arg: 'deepseek:deepseek-chat',
	})
	assert.deepEqual(parseCallback(data.model('cancel', 'deepseek:deepseek-chat')), {
		kind: 'model',
		action: 'cancel',
		arg: 'deepseek:deepseek-chat',
	})
	assert.deepEqual(parseCallback(data.model('back', 'deepseek')), { kind: 'model', action: 'back', arg: 'deepseek' })
	assert.deepEqual(parseCallback(data.model('list')), { kind: 'model', action: 'list', arg: '' })
	assert.equal(parseCallback(data.model('')), null)
	assert.equal(parseCallback('qqb:mod'), null, '不是本插件的回调前缀')
})

// ── 快捷卡片 ────────────────────────────────────────────────────────────────

test('快捷卡片：一条一个回调按钮（点一下直接切），末行固定「加当前会话」', () => {
	const card = buildShortcutCard({
		items: [
			{ id: 1, label: 'K-Vault-Next', current: false },
			{ id: 2, label: '我的 前端', current: true },
			{ id: 3, label: '另一个项目', current: false },
		],
		currentLabel: '我的 前端(session-2)',
	})
	assert.match(card.content, /当前会话：`我的 前端\(session-2\)`/)
	assert.match(card.content, /只增不重用/, '正文要写明编号不补位（用户是记着编号用的）')
	assert.match(card.content, /快捷 加 \[备注\]/)
	assert.match(card.content, /快捷 备注 #2 <新备注>/)
	assert.match(card.content, /备注里不能有 `#`/)
	assert.match(card.content, /只投消息不切换/, '带消息的那种不切换绑定，正文要说清楚')
	assert.match(card.content, /add a/, '英文缩写也写在卡片上（`add a` / `delete d` / `list l`）')

	const rows = card.keyboard.content.rows.map((row) => row.buttons.map((b) => b.render_data.label))
	assert.deepEqual(rows, [
		['#1 K-Vault-Next', '#2 我的 前端'],
		['#3 另一个项目'],
		['加当前会话'],
	])
	const flat = card.keyboard.content.rows.flatMap((row) => row.buttons)
	assert.equal(flat[0].render_data.style, 0, '非当前灰')
	assert.equal(flat[1].render_data.style, 1, '当前那条标蓝')
	assert.equal(flat[3].action.type, 1, '「加当前会话」也是回调按钮')
	assert.deepEqual(parseCallback(flat[0].action.data), { kind: 'shortcut', action: 'go', arg: '1' })
	assert.deepEqual(parseCallback(flat[1].action.data), { kind: 'shortcut', action: 'go', arg: '2' })
	assert.deepEqual(parseCallback(flat[3].action.data), { kind: 'shortcut', action: 'add', arg: '' })
	// 同一张键盘里按钮 id 必须唯一（label 截断后可能撞车，编号才是真身份）
	assert.equal(new Set(flat.map((b) => b.id)).size, flat.length)

	// 整卡必须合法（平台硬限制：≤5 行、每行 ≤5）
	assert.ok(card.keyboard.content.rows.length <= 5)
	for (const row of card.keyboard.content.rows) assert.ok(row.buttons.length <= 5)
})

test('快捷卡片：空列表只给「加当前会话」+ 引导；超上限只列前 N 条并说明用编号直达', () => {
	const empty = buildShortcutCard({ items: [], currentLabel: '' })
	assert.match(empty.content, /还没有快捷会话/)
	assert.deepEqual(
		empty.keyboard.content.rows.map((row) => row.buttons.map((b) => b.render_data.label)),
		[['加当前会话']],
	)
	assert.match(empty.content, /`none`（未绑定）/)

	const many = buildShortcutCard({
		items: Array.from({ length: SHORTCUT_MAX_BUTTONS + 4 }, (_, i) => ({ id: i + 1, label: `项目 ${i + 1}`, current: false })),
		currentLabel: '',
	})
	const buttons = many.keyboard.content.rows.flatMap((row) => row.buttons)
	assert.equal(buttons.length, SHORTCUT_MAX_BUTTONS + 1, `${SHORTCUT_MAX_BUTTONS} 条 + 加按钮`)
	assert.match(many.content, new RegExp(`按钮只放得下前 ${SHORTCUT_MAX_BUTTONS} 个`))
	assert.ok(many.keyboard.content.rows.length <= 5)
	assert.deepEqual(parseCallback(buttons.at(-1).action.data), { kind: 'shortcut', action: 'add', arg: '' })
	assert.equal(parseCallback('qqb:sc'), null, '缺动作的回调要当成坏数据')
})
