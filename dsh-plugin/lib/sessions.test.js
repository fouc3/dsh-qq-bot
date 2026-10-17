import { test } from 'node:test'
import assert from 'node:assert/strict'
import { win32 } from 'node:path'

import { createSessions } from './sessions.js'

/**
 * 建一个只有会话索引的假 ctx；`path` 可注入（测试里用 win32 验 Windows 的盘符路径，
 * 本机是 Linux，靠注入来模拟而不是嘴上说"理论上支持"）。
 */
function build(items, pathOps) {
	const ctx = {
		sessionController: { list: async () => ({ items, isEnd: true }) },
		on: () => () => {},
		workspaceRegistry: { archivedSessionIds: [] },
	}
	return createSessions({ ctx, logger: {}, path: pathOps })
}

async function ready(items, pathOps) {
	const sessions = build(items, pathOps)
	await sessions.refresh()
	return sessions
}

const posixItems = [
	{ sessionId: 'session-a', cwd: '/home/u/proj/app', updatedAt: 3 },
	{ sessionId: 'session-b', cwd: '/home/u/proj/lib', updatedAt: 2 },
	{ sessionId: 'session-c', cwd: '/home/u/proj', updatedAt: 1 },
	{ sessionId: 'session-d', cwd: '/home/u/other', updatedAt: 4 },
]

// Windows 上 cwd 是 `C:\…` 这种携带盘符的绝对路径：旧实现只认 `/` 开头，
// 会把它改成 `/C:\…`，于是默认根变成 `/`、目录树一个孩子都列不出来。
const windowsItems = [
	{ sessionId: 'session-a', cwd: 'C:\\Users\\me\\proj\\app', updatedAt: 3 },
	{ sessionId: 'session-b', cwd: 'C:\\Users\\me\\proj\\lib', updatedAt: 2 },
	{ sessionId: 'session-c', cwd: 'C:\\Users\\me\\proj', updatedAt: 1 },
]

test('POSIX：默认根取最长公共前缀，目录树按层列出', async () => {
	const sessions = await ready(posixItems)
	assert.equal(sessions.defaultRoot(), '/home/u')

	const top = sessions.listDirs('/home/u')
	assert.deepEqual(
		top.map((item) => item.name),
		['other', 'proj'],
	)
	assert.deepEqual(
		top.map((item) => item.path),
		['/home/u/other', '/home/u/proj'],
	)

	const mid = sessions.listDirs('/home/u/proj')
	assert.deepEqual(
		mid.map((item) => item.name),
		['app', 'lib'],
	)
	// 结尾多一个 `/` 不影响（normalizeDir 会规范化）
	assert.deepEqual(
		sessions.listDirs('/home/u/proj/').map((item) => item.name),
		['app', 'lib'],
	)

	assert.deepEqual(
		sessions.sessionsInDir('/home/u/proj').map((item) => item.sessionId),
		['session-c'],
	)
	assert.equal(sessions.parentOf('/home/u/proj'), '/home/u')
	assert.equal(sessions.parentOf('/'), null, '根目录没有上一级')
})

test('POSIX：<目录> <会话id> 形式的解析（含"不在这个目录下"）', async () => {
	const sessions = await ready(posixItems)
	assert.deepEqual(sessions.resolveRef(['/home/u/proj', 'session-c']), {
		sessionId: 'session-c',
		cwd: '/home/u/proj',
		content: '',
	})
	const wrongDir = sessions.resolveRef(['/home/u/proj', 'session-a'])
	assert.match(wrongDir.error, /不在目录/)
	const missing = sessions.resolveRef(['session-nope'])
	assert.match(missing.error, /没找到会话/)
})

test('Windows：盘符绝对路径当成绝对路径（不再被改成 /C:\\…）', async () => {
	const sessions = await ready(windowsItems, win32)

	// 公共前缀：C:\Users\me\proj
	assert.equal(sessions.defaultRoot(), 'C:\\Users\\me\\proj')

	assert.deepEqual(sessions.listDirs('C:\\Users\\me'), [{ name: 'proj', path: 'C:\\Users\\me\\proj' }])

	const below = sessions.listDirs('C:\\Users\\me\\proj')
	assert.deepEqual(
		below.map((item) => item.path),
		['C:\\Users\\me\\proj\\app', 'C:\\Users\\me\\proj\\lib'],
	)

	// 正斜杠写进来的同一目录也要认（Windows 两种分隔符都合法）
	assert.deepEqual(
		sessions.listDirs('C:/Users/me/proj').map((item) => item.name),
		['app', 'lib'],
	)
	assert.deepEqual(
		sessions.sessionsInDir('C:/Users/me/proj').map((item) => item.sessionId),
		['session-c'],
	)

	assert.equal(sessions.parentOf('C:\\Users\\me\\proj'), 'C:\\Users\\me')
	assert.equal(sessions.parentOf('C:\\'), null, '盘符根没有上一级（循环必须在这里停）')
})

test('Windows：跨盘符没有公共前缀时退回平台根（不能死循环）', async () => {
	const sessions = await ready(
		[
			{ sessionId: 'session-a', cwd: 'C:\\data\\a' },
			{ sessionId: 'session-b', cwd: 'D:\\work\\b' },
		],
		win32,
	)
	// platformRoot() 在当前平台的 cwd 基础上算；这里只要求"是个根"且真的返回了。
	const expected = win32.parse(process.cwd()).root || '\\'
	assert.equal(sessions.defaultRoot(), expected)
})

test('目录选择：没会话时默认根是平台根', async () => {
	const posix = await ready([])
	assert.equal(posix.defaultRoot(), '/')
	const windows = await ready([], win32)
	assert.equal(windows.defaultRoot(), win32.parse(process.cwd()).root || '\\')
})
