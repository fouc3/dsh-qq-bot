import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
	QUESTION_MAX_BUTTONS,
	buildInboxCard,
	buildInboxResult,
	buildMkdirPromptCard,
	buildNewSessionCard,
	buildNoticeCard,
	buildQuestionCard,
	buildQuestionCards,
	buildQuestionResult,
	buildSessionCard,
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

	// 选中态**同时**用按钮自身的 style 表示（4 = 蓝色填充），未选中 1
	const buttons = card.keyboard.content.rows.flatMap((row) => row.buttons)
	const selected = buttons.find((b) => b.render_data.label === 'B') // 第一问的「否」
	const unselected = buttons.find((b) => b.render_data.label === 'A') // 第一问的「是」
	assert.equal(selected.render_data.style, 4, '选中的字母按钮要用填充样式')
	assert.equal(unselected.render_data.style, 1, '未选中的保持普通样式')
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
test('会话卡片：「返回上级」与「不指定会话」同处一行，总行数仍 ≤5', () => {
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
	assert.deepEqual(labels, ['返回上级', '不指定会话'], '导航行应同时含返回上级与不指定会话')
	assert.equal(nav.buttons[0].action.data, data.dir('/home'))
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
