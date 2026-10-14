import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
	EXCLUDED_COMMANDS,
	buildMenuItems,
	buildSubMenus,
	filterCommands,
	isSlashLine,
	listCommands,
	runCommand,
	splitSlashLine,
} from './dsh-commands.js'
import { menuItems } from './commands.js'

const DESCRIPTORS = [
	{ name: 'compact', description: '压缩以上对话内容', input: { hint: '' } },
	{ name: 'context', description: '查看当前上下文构成' },
	{ name: 'export', description: '将当前会话内容导出为 ZIP' },
	{ name: 'feedback', description: '发送关于当前会话的反馈' },
	{ name: 'goal', description: '设置或查看长期任务目标' },
	{ name: 'mnemon', description: '查看、召回或管理外部记忆' },
	{ name: 'model', description: '选择本会话使用的模型' },
	{ name: 'permission', description: '切换权限预设' },
	{ name: 'plan', description: '进入或退出计划模式' },
	{ name: 'free-search-engine', description: '切换搜索引擎' },
	{ name: 'enhance', description: '提示词增强' },
]

test('斜杠行判定与拆分', () => {
	assert.equal(isSlashLine('/compact'), true)
	assert.equal(isSlashLine('  /goal 完成'), true)
	assert.equal(isSlashLine('你好'), false)
	assert.equal(isSlashLine(undefined), false)

	assert.deepEqual(splitSlashLine('/compact'), { name: 'compact', rest: '', line: '/compact' })
	assert.deepEqual(splitSlashLine('/goal  pause 一下'), { name: 'goal', rest: 'pause 一下', line: '/goal  pause 一下' })
	assert.equal(splitSlashLine('compact'), null)
	assert.equal(splitSlashLine('/'), null)
})

test('过滤：排掉「反馈」，并归一到 name/description/hint', () => {
	const filtered = filterCommands(DESCRIPTORS)
	assert.ok(!filtered.some((c) => c.name === 'feedback'), 'feedback 必须被排除')
	assert.equal(filtered.length, DESCRIPTORS.length - 1)
	assert.deepEqual(filtered[0], { name: 'compact', description: '压缩以上对话内容', hint: '' })
	assert.ok(EXCLUDED_COMMANDS.has('feedback'))
	// 脏数据不应炸
	assert.deepEqual(filterCommands([null, {}, { name: '' }, { name: 'ok' }]), [
		{ name: 'ok', description: '', hint: '' },
	])
})

test('二级菜单：每 ≤5 项一组，点击把 /命令 填进输入框', () => {
	const commands = filterCommands(DESCRIPTORS)
	const groups = buildSubMenus(commands, { label: 'dsh 命令' })
	// 10 条命令 → 2 组
	assert.equal(groups.length, 2)
	assert.equal(groups[0].type, 'menu')
	assert.equal(groups[0].name, 'dsh 命令1')
	assert.equal(groups[1].name, 'dsh 命令2')
	assert.equal(groups[0].children.length, 5)
	assert.equal(groups[1].children.length, 5)
	assert.deepEqual(groups[0].children[0], { name: 'compact', sendMessage: '/compact' })
	// 顶层名宽 ≤10（中文算 2）
	for (const group of groups) {
		const width = [...group.name].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0x7f ? 2 : 1), 0)
		assert.ok(width <= 10, `${group.name} 宽度 ${width} 超过顶层限制`)
	}
	// 单组时不加序号
	assert.equal(buildSubMenus(commands.slice(0, 3), { label: 'dsh 命令' })[0].name, 'dsh 命令')
})

test('完整菜单：桥命令在前，dsh 命令收进后面的二级菜单，且不超顶层 10 项', () => {
	const bridge = menuItems()
	assert.equal(bridge.length, 5)

	const menu = buildMenuItems({ bridge, commands: filterCommands(DESCRIPTORS), label: 'dsh 命令' })
	assert.equal(menu.length, 7, '5 条桥命令 + 2 个二级菜单')
	assert.ok(menu.slice(0, 5).every((it) => it.type === undefined && it.sendMessage), '桥命令仍是 send_message')
	assert.ok(menu.slice(5).every((it) => it.type === 'menu' && it.children.length > 0), 'dsh 命令进二级菜单')

	// 顶层上限：bridge 占满 10 个位置时不再塞二级菜单
	const over = buildMenuItems({ bridge: Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, sendMessage: `c${i}` })), commands: filterCommands(DESCRIPTORS) })
	assert.equal(over.length, 10)
	assert.ok(!over.some((it) => it.type === 'menu'))

	// 命令多于 5 的倍数也不会超顶层（最多 5 个二级菜单）
	const many = Array.from({ length: 40 }, (_, i) => ({ name: `cmd${i}`, description: '' }))
	const wide = buildMenuItems({ bridge, commands: many, label: 'dsh 命令' })
	assert.equal(wide.length, 10)
	assert.equal(wide.filter((it) => it.type === 'menu').length, 5)
})

test('listCommands：服务缺失/报错都退化成空表（菜单照发）', async () => {
	assert.deepEqual(await listCommands(undefined, { id: 's1' }), [])
	assert.deepEqual(await listCommands({ list: async () => DESCRIPTORS }, null), [])
	const ok = await listCommands({ list: async () => DESCRIPTORS }, { id: 's1' })
	assert.equal(ok.length, DESCRIPTORS.length - 1)
	const broken = await listCommands(
		{
			list: async () => {
				throw new Error('服务炸了')
			},
		},
		{ id: 's1' },
		{},
	)
	assert.deepEqual(broken, [])
})

test('runCommand：解析不到返回 handled=false；成功/失败都如实回报', async () => {
	const seen = []
	const commands = {
		async execute(agent, line, attachments, signal) {
			seen.push({ agentId: agent.id, line, attachments: attachments.length, hasSignal: Boolean(signal) })
			if (line.includes('boom')) throw new Error('handler 抛错')
			if (line.includes('unknown')) return undefined
			if (line.includes('fail')) return { commandId: 'c1', result: { kind: 'error', text: '参数不对' } }
			return { commandId: 'c2', result: { kind: 'success', text: '已压缩' } }
		},
	}
	const agent = { id: 'session-1' }

	const ok = await runCommand(commands, agent, '/compact', {})
	assert.deepEqual(ok, { handled: true, ok: true, text: '已压缩' })
	assert.equal(seen[0].attachments, 0, 'QQ 侧没有附件通路，必须传空数组')
	assert.equal(seen[0].hasSignal, true, '必须带 signal')

	const unknown = await runCommand(commands, agent, '/unknown', {})
	assert.deepEqual(unknown, { handled: false })

	const failed = await runCommand(commands, agent, '/goal fail', {})
	assert.equal(failed.handled, true)
	assert.equal(failed.ok, false)
	assert.equal(failed.text, '参数不对')

	const thrown = await runCommand(commands, agent, '/goal boom', {})
	assert.equal(thrown.handled, true)
	assert.equal(thrown.ok, false)
	assert.match(thrown.text, /handler 抛错/)

	// 命令服务缺失 → 不算 handled，交给普通消息通路
	assert.deepEqual(await runCommand(undefined, agent, '/compact', {}), { handled: false })
})
