import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createPermissions } from './permissions.js'

/** 假的服务：只有这三个预设 + 一个会抛的未知值。 */
function fakeCtx({ present = true, throwOnCatalog = false } = {}) {
	const calls = []
	const service = {
		currentValue: 'workspace-write',
		catalog() {
			if (throwOnCatalog) throw new Error('boom')
			return {
				options: [
					{ value: 'read-only', name: '仅可查看', description: '只能看，不能改' },
					{ value: 'workspace-write', name: '工作区内修改', description: '工作区内可写' },
					{ value: 'danger-full-access', name: '完全权限', description: '不限制' },
				],
				defaultOptions: [],
				defaultPreset: 'workspace-write',
			}
		},
		current() {
			return this.currentValue
		},
		set(session, value) {
			const known = ['read-only', 'workspace-write', 'danger-full-access']
			if (!known.includes(value)) throw new Error(`unknown preset '${value}'`)
			this.currentValue = value
			calls.push({ sessionId: session?.id, value })
		},
	}
	return { ctx: { get: (name) => (present && name === 'permissionPresets' ? service : undefined) }, calls, service }
}

test('权限：目录/当前值/切换（并如实回执名称与描述）', () => {
	const { ctx, calls } = fakeCtx()
	const permissions = createPermissions({ ctx })
	assert.equal(permissions.available(), true)
	assert.deepEqual(permissions.catalog().map((o) => o.value), ['read-only', 'workspace-write', 'danger-full-access'])
	assert.equal(permissions.current({ id: 's1' }), 'workspace-write')

	const ok = permissions.set({ id: 's1' }, 'danger-full-access')
	assert.equal(ok.ok, true)
	assert.equal(ok.name, '完全权限')
	assert.match(ok.description, /不限制/)
	assert.deepEqual(calls, [{ sessionId: 's1', value: 'danger-full-access' }])
	assert.equal(permissions.current({ id: 's1' }), 'danger-full-access')
	assert.match(permissions.describe('完全权限'), /完全权限/)

	// 未知值：服务会抛，这里必须如实失败而不是崩
	const bad = permissions.set({ id: 's1' }, 'nope')
	assert.equal(bad.ok, false)
	assert.match(bad.error, /nope/)
})

test('权限：解析用户输入（中文名/英文 key/别名/序号），认不出就报错', () => {
	const { ctx } = fakeCtx()
	const permissions = createPermissions({ ctx })
	const cases = [
		[['完全权限'], 'danger-full-access'],
		[['read-only'], 'read-only'],
		[['仅可查看'], 'read-only'],
		[['工作区'], 'workspace-write'],
		[['danger'], 'danger-full-access'],
		[['2'], 'workspace-write'],
		[['3'], 'danger-full-access'],
		[['完全', '权限'], 'danger-full-access'],
	]
	for (const [tokens, want] of cases) {
		const out = permissions.resolveToken(tokens)
		assert.equal(out.ok, true, `${tokens.join(' ')} 应能解析`)
		assert.equal(out.value, want, `${tokens.join(' ')} → ${want}`)
	}
	assert.equal(permissions.resolveToken([]).ok, false)
	assert.equal(permissions.resolveToken(['瞎写']).ok, false)
	assert.equal(permissions.resolveToken(['9']).ok, false, '序号越界要失败')
})

test('权限：没有服务/服务报错时退化成"用不了"，不抛异常', () => {
	const absent = createPermissions({ ctx: { get: () => undefined } })
	assert.equal(absent.available(), false)
	assert.deepEqual(absent.catalog(), [])
	assert.equal(absent.set({ id: 's1' }, 'read-only').ok, false)

	const broken = createPermissions({ ctx: fakeCtx({ throwOnCatalog: true }).ctx })
	assert.deepEqual(broken.catalog(), [], '读目录出错也要返回空表')
})

test('权限：内置档显示 Web 同款中文（服务给的是英文名也不影响），custom 保持原样', () => {
	const ctx = {
		get: () => ({
			catalog: () => ({
				options: [
					{ value: 'read-only', name: 'Read Only' },
					{ value: 'workspace-write', name: 'Workspace Write' },
					{ value: 'danger-full-access', name: 'Full access' },
					{ value: 'auto', name: 'auto' },
					{ value: 'my-mode', name: 'my-mode' },
					{ value: 'team-mode', name: 'Team Mode' },
				],
			}),
			current: () => 'workspace-write',
			set() {},
		}),
	}
	const permissions = createPermissions({ ctx })
	assert.deepEqual(
		permissions.catalog().map((o) => o.name),
		['仅可查看', '工作区内修改', '完全权限', 'Auto review', 'My Mode', 'Team Mode'],
		'内置档用 Web 的中文文案；kebab key 变 Title Case；配置了名字的保持原样',
	)
	// 回执也用中文
	assert.match(permissions.describe('danger-full-access'), /完全权限/)
})
