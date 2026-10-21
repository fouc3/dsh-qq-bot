import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_ENTRIES, SNAPSHOT_VERSION, TEXT_LIMIT, clipText, createResumeStore } from './resume.js'

function tmpFile() {
	return join(mkdtempSync(join(tmpdir(), 'qqbot-resume-')), 'running.json')
}

test('运行快照：写进去能读回来（0600、版本化、字段归一）', () => {
	const file = tmpFile()
	const store = createResumeStore({ file, logger: {} })
	const saved = store.save([
		{ sessionId: 'session-1', title: 'memos', cwd: '/home/u/proj', turn: 148, text: '正在写后端路由', at: 1 },
		// 坏条目（没有 sessionId）要被丢掉，不能进快照
		{ title: '没有id', turn: 3 },
	])
	assert.equal(saved.version, SNAPSHOT_VERSION)
	assert.equal(statSync(file).mode & 0o777, 0o600, '快照是 0600（只有本账户能读）')

	const back = store.load()
	assert.deepEqual(back.sessions.map((item) => item.sessionId), ['session-1'])
	assert.equal(back.sessions[0].turn, 148)
	assert.match(readFileSync(file, 'utf8'), /"version": 1/)
})

test('运行快照：坏文件/不存在都当空（绝不挡住启动）', () => {
	const file = tmpFile()
	const store = createResumeStore({ file, logger: {} })
	assert.deepEqual(store.load().sessions, [], '文件不存在时是空')

	writeFileSync(file, '{ not json')
	assert.deepEqual(store.load().sessions, [], '坏 JSON 当空')

	writeFileSync(file, JSON.stringify({ version: 99, sessions: [{ sessionId: 'session-x' }, null, 'x'] }))
	assert.deepEqual(store.load().sessions.map((item) => item.sessionId), ['session-x'], '只留下合法的条目')

	// 没有配置路径时：读写都是安全的空操作
	const noop = createResumeStore({ file: '', logger: {} })
	assert.deepEqual(noop.load().sessions, [])
	assert.equal(noop.save([{ sessionId: 'session-1' }]), undefined)
})

test('运行快照：条目上限与摘要裁剪', () => {
	const file = tmpFile()
	const store = createResumeStore({ file, logger: {} })
	const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => ({ sessionId: `session-${i + 1}` }))
	store.save(many)
	assert.equal(store.load().sessions.length, MAX_ENTRIES, `最多存 ${MAX_ENTRIES} 条`)

	const long = 'x'.repeat(TEXT_LIMIT + 50)
	assert.equal([...clipText(long)].length, TEXT_LIMIT + 1, '超长裁到上限 + 省略号')
	assert.equal(clipText('多行\n文本\t带空白'), '多行 文本 带空白', '换行/制表压成空格')
	assert.equal(clipText(''), '')
	assert.equal(clipText(null), '')
})
