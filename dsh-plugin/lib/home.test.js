import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { expandHome } from './home.js'

// 以前的实现是 `process.env.HOME ?? …`：Windows 上没有 HOME，于是 `~` 原样留着，
// 组件在**当前工作目录**下建出一个名叫 `~` 的目录（不报错，但 state.json / socket 全放错地方）。
test('~ 展开走 os.homedir()，不依赖 HOME 环境变量（Windows 上通常没有）', () => {
	const saved = process.env.HOME
	delete process.env.HOME
	try {
		assert.equal(expandHome('~'), homedir())
		assert.equal(expandHome('~/.dsh/dsh-qq-bot/state.json'), join(homedir(), '.dsh/dsh-qq-bot/state.json'))
		// Windows 写法也认
		assert.equal(expandHome('~\\.dsh\\state.json'), join(homedir(), '.dsh\\state.json'))
	} finally {
		if (saved !== undefined) process.env.HOME = saved
	}
})

test('不是 ~ 开头的一律原样返回（含空值与管道地址）', () => {
	assert.equal(expandHome('/abs/path'), '/abs/path')
	assert.equal(expandHome('C:\\Users\\me'), 'C:\\Users\\me')
	assert.equal(expandHome('pipe:dsh-qq-bot-bridge'), 'pipe:dsh-qq-bot-bridge')
	assert.equal(expandHome(''), '')
	assert.equal(expandHome(undefined), undefined)
	// 只有开头的 ~ 是家目录，路径中间的不动
	assert.equal(expandHome('/home/~weird/x'), '/home/~weird/x')
})
