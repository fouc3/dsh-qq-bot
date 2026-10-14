/**
 * 权限（permission preset）桥：读 dsh 的预设目录、切当前会话的预设。
 *
 * 对应 dsh Web 里那个「仅可查看 / 工作区内修改 / 完全权限（Auto review）」选择器：
 * 服务是 `ctx.permissionPresets`（`@deepseek-ai/dsh-permission-presets`），
 *   - `catalog()` → `{ options: [{ value, name, description? }] }`（可选项，顺序即贡献顺序）
 *   - `current(session)` → 当前生效的预设 value
 *   - `set(session, value)` → 切换（未知 value 会抛）
 *
 * 用**可选访问** `ctx.get('permissionPresets')`：没有该服务的 profile 里插件照常激活，
 * 只是命令回一句"这个部署没有权限服务"。
 */

/**
 * dsh Web 端（简体中文）对内置预设的文案。
 *
 * 为什么需要：`catalog()` 给的 `name` 来自**部署配置/服务**（线上没配 name 时就是英文，
 * 如 "Read Only"），而 Web 选择器显示的是它自己的 i18n 文案（`preset.readOnly` → 仅可查看…）。
 * 用户要求"卡片显示和 Web 同款中文"，所以按预设 key 覆盖；未知/custom 才回退服务给的名字。
 * 文案取自 `@deepseek-ai/dsh-client-ui-permission-presets` 的 zh 字典。
 */
const PRESET_LABELS = {
	'read-only': '仅可查看',
	'workspace-write': '工作区内修改',
	'danger-full-access': '完全权限',
	auto: 'Auto review',
	custom: '自定义',
}

/** 把 `my-mode` 这种 kebab key 变成 `My Mode`（与 Web 的 displayPresetName 行为一致）。 */
function titleCaseKebab(name) {
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
	return name
		.split('-')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ')
}

/** 一个预设对外的显示名：内置档用中文，其它用服务给的名字（kebab key 则 Title Case）。 */
function displayName(item) {
	const builtin = PRESET_LABELS[item.value]
	if (builtin) return builtin
	return titleCaseKebab(item.name || item.value)
}

/** 直接设定的 token → 预设 value 的宽松别名（中文名/英文片段/level 名都认）。 */
const VALUE_ALIASES = {
	只读: 'read-only',
	仅可查看: 'read-only',
	查看: 'read-only',
	readonly: 'read-only',
	'read-only': 'read-only',
	read: 'read-only',
	工作区: 'workspace-write',
	工作区内修改: 'workspace-write',
	workspace: 'workspace-write',
	'workspace-write': 'workspace-write',
	完全: 'danger-full-access',
	完全权限: 'danger-full-access',
	full: 'danger-full-access',
	'danger-full-access': 'danger-full-access',
	danger: 'danger-full-access',
	auto: 'auto',
	自动: 'auto',
	自动审查: 'auto',
}

/** 取值时的模糊匹配：先精确（value/name/别名），再去掉空格、大小写后比较。 */
function normalizeToken(token) {
	return String(token ?? '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '')
}

export function createPermissions({ ctx, logger }) {
	/** 服务句柄（可选）。 */
	function service() {
		try {
			return ctx.get?.('permissionPresets') ?? null
		} catch {
			return null
		}
	}

	function available() {
		const svc = service()
		return Boolean(svc && typeof svc.catalog === 'function' && typeof svc.set === 'function')
	}

	/** 可选项（拿不到服务时返回空数组）。 */
	function catalog() {
		try {
			const options = service()?.catalog?.()?.options
			return Array.isArray(options)
				? options
						.filter((item) => item && typeof item.value === 'string' && item.value)
						.map((item) => ({
							value: item.value,
							// 显示名统一走 displayName：内置三档 + auto 用 Web 同款中文
							name: displayName({
								value: item.value,
								name: typeof item.name === 'string' && item.name ? item.name : item.value,
							}),
							description: typeof item.description === 'string' ? item.description : '',
						}))
				: []
		} catch (error) {
			logger?.warn?.('读取权限预设目录失败', { error: String(error) })
			return []
		}
	}

	/** 当前会话生效的预设 value（拿不到就返回空串）。 */
	function current(session) {
		try {
			const value = service()?.current?.(session)
			return typeof value === 'string' ? value : ''
		} catch (error) {
			logger?.warn?.('读取当前权限预设失败', { error: String(error) })
			return ''
		}
	}

	/**
	 * 把用户输入解析成预设 value。
	 * 认：精确 value / 预设显示名 / 别名表 / 纯序号（`1` 起）。
	 * @returns {{ok:true, value:string}|{ok:false, error:string}}
	 */
	function resolveToken(tokens) {
		const raw = (Array.isArray(tokens) ? tokens : [tokens]).map((item) => String(item ?? '').trim()).filter(Boolean)
		if (raw.length === 0) return { ok: false, error: '没有给权限级别。' }
		const joined = raw.join(' ')
		const options = catalog()
		if (options.length === 0) return { ok: false, error: '这个部署没有可用的权限预设。' }
		const key = normalizeToken(joined)
		const alias = VALUE_ALIASES[key]
		if (alias && options.some((item) => item.value === alias)) return { ok: true, value: alias }
		const exact = options.find(
			(item) => normalizeToken(item.value) === key || normalizeToken(item.name) === key,
		)
		if (exact) return { ok: true, value: exact.value }
		// 纯序号
		if (/^\d+$/.test(key)) {
			const index = Number(key) - 1
			if (index >= 0 && index < options.length) return { ok: true, value: options[index].value }
		}
		return { ok: false, error: `认不出权限级别 \`${joined}\`。` }
	}

	/** 切换当前会话的预设。 */
	function set(session, value) {
		if (!available()) return { ok: false, error: '这个部署没有权限服务（`ctx.permissionPresets`）。' }
		const wanted = String(value ?? '').trim()
		if (!wanted) return { ok: false, error: '权限级别不能为空。' }
		const option = catalog().find((item) => item.value === wanted)
		try {
			service().set(session, wanted)
		} catch (error) {
			logger?.warn?.('切换权限预设失败', { value: wanted, error: String(error) })
			return { ok: false, error: `切换失败：${String(error?.message ?? error)}` }
		}
		logger?.info?.('已切换权限预设', { value: wanted })
		return { ok: true, value: wanted, name: option?.name ?? wanted, description: option?.description ?? '' }
	}

	/** 人话描述一份预设（回执与卡片正文共用）。 */
	function describe(value) {
		const option = catalog().find((item) => item.value === value)
		if (!option) return value || '未知'
		return option.description ? `**${option.name}**（${option.description}）` : `**${option.name}**`
	}

	return { available, catalog, current, resolveToken, set, describe }
}
