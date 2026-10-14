import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
	buildNewSessionCard,
	buildNoticeCard,
	buildQuestionCard,
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
})

test('提问卡片：按钮数超上限返回 null（调用方降级到 dsh GUI）', () => {
	const card = buildQuestionCard({
		callId: 'c3',
		questions: [{ id: 'q1', question: '题', options: Array.from({ length: 20 }, (_, i) => ({ label: `选项${i}` })) }],
		maxButtons: 5,
	})
	assert.equal(card, null)
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
