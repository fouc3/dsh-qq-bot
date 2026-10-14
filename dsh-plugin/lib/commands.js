/**
 * 命令表与命令执行。
 *
 * 这里是命令名的**唯一来源**：解析、用法回复、QQ 指令面板条目、自定义菜单条目
 * 全部由这张表派生，避免 Go 侧再抄一份。
 *
 * 通用规则：需要参数却没给参数的命令，回复"作用 + 用法"。
 */

/** 命令表。selection 为真的命令在无参时进入"会话选择"语义而不是回用法。 */
export const COMMANDS = [
	{
		name: '切换会话',
		desc: '选择/切换要接入的会话',
		selection: true,
		argHint: '<会话id> | <目录> <会话id> | none',
	},
	{
		name: '新建会话',
		desc: '在指定目录新建会话并切换',
		purpose: '在指定目录新建一个 dsh 会话，并默认切换到它；不带参数时用卡片逐层选目录。',
		usage: '新建会话 <目录>',
		usageAlt: '新建会话                 # 不带参数：用卡片选目录',
	},
	{
		name: '进度',
		desc: '看当前进展（只读不打断）',
		purpose: '只读地看一眼某会话现在在干什么（状态/轮次/耗时/最近动作），**不会打断**正在跑的 AI。',
		usage: '进度',
		usageAlt: '进度 <会话id>                 # 看指定会话',
	},
	{
		name: '发送',
		desc: '进输入态（带会话=指定目标）',
		purpose:
			'发 `发送` = 进入**当前会话的输入态**，发 `发送 <会话id>` = 进入**那个会话的输入态**：' +
			'之后你发的文字与附件都先攒着（机器人回一张预览卡片，每个附件可单独删除），点卡片上的「发送」才把正文 + 附件一起交给 AI；' +
			'`发送 <会话id> <内容>` 仍是单次投递（不打断，忙则排队），此形式**不支持附件**。',
		usage: '发送',
		usageAlt: '发送 <会话id>                   # 进那个会话的输入态',
		usageAlt2: '发送 <会话id> <内容>          # 单次投递（不带附件）',
	},
	{
		name: '停止',
		desc: '停止当前轮次（无参=当前会话）',
		purpose: '停止指定会话正在进行的这一轮；不带参数时作用于当前会话。',
	},
	{
		name: '归档',
		desc: '归档会话（无参=当前会话）',
		purpose: '归档指定会话（dsh 持久归档，并停止其剩余工作）；不带参数时作用于当前会话。',
	},
	{
		name: '延迟发送',
		desc: '进输入态（本轮结束后投递）',
		purpose:
			'和 `发送` **共用同一套输入态面板**，区别只有投递时机：**不打断**当前轮次，等它**正常结束后**再投递' +
			'（被停止/被顶替/出错都不投）。`延迟发送 <会话id> <内容>` 是直接登记（覆盖该会话原有待发消息）。',
		usage: '延迟发送',
		usageAlt: '延迟发送 <会话id>                # 进那个会话的延迟输入态',
		usageAlt2: '延迟发送 <会话id> <内容>         # 直接登记（不带附件）',
	},
	{
		name: '权限',
		desc: '看/切会话权限（卡片或直接设定）',
		purpose:
			'管理**当前会话**的权限级别（就是 dsh Web 里那个「仅可查看 / 工作区内修改 / 完全权限 / Auto review」选择器）：' +
			'发 `权限`（不带参数）回一张卡片，每行两个按钮，点一下就切；也可以 `权限 <级别>` 直接设定' +
			'（级别认中文名、英文 key、或卡片上的序号）。',
		usage: '权限',
		usageAlt: '权限 <级别>                   # 直接设定，如 `权限 完全权限`、`权限 read-only`、`权限 2`',
	},
	{
		name: '模型',
		desc: '看/切模型（提供商/模型）',
		purpose:
			'管理**当前会话**要用的模型（就是 dsh Web 里那个模型选择器）：' +
			'发 `模型`（不带参数）回一张卡片——先列**提供商**（每行最多 2 个，可翻页），' +
			'点一个提供商进去才是它的**模型**（每行最多 1 个，可翻页），点一下就切；' +
			'也可以 `模型 <提供商>/<模型名字>` 直接切（提供商与模型都认 id 或显示名），' +
			'末尾还能再跟一个**会话id**，把模型切给别的会话（不跟就是当前会话）。',
		usage: '模型',
		usageAlt: '模型 <提供商>/<模型名字>             # 直接切（默认当前会话）',
		usageAlt2: '模型 <提供商>/<模型名字> <会话id>    # 切给指定会话',
	},
]

const BY_NAME = new Map(COMMANDS.map((cmd) => [cmd.name, cmd]))

/**
 * 解析一条消息是不是命令。
 *
 * 允许一个可选的前导 `/`（QQ 自定义菜单与指令按钮填过来的文本可能带或不带）。
 *
 * @param {string} text
 * @returns {{name:string, tokens:string[], rest:string}|null}
 */
export function parseCommand(text) {
	const trimmed = String(text ?? '').trim()
	if (!trimmed) return null
	const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1).trim() : trimmed
	if (!withoutSlash) return null
	const tokens = withoutSlash.split(/\s+/)
	if (!BY_NAME.has(tokens[0])) return null
	return { name: tokens[0], tokens: tokens.slice(1), rest: tokens.slice(1).join(' ') }
}

/** 该命令是否需要参数（用于"无参回用法"）。 */
export function requiresArgs(name) {
	return Boolean(BY_NAME.get(name)?.requiresArgs)
}

/** 命令的用法说明（markdown）。 */
export function usageText(name) {
	const cmd = BY_NAME.get(name)
	if (!cmd) return ''
	const lines = [`**${cmd.name}**`]
	if (cmd.purpose) lines.push(`> 作用：${cmd.purpose}`)
	// usage / usageAlt / usageAlt2 是同一份数据里的几种写法，统一渲染成"用法：A 或 B 或 C"。
	const usages = [cmd.usage, cmd.usageAlt, cmd.usageAlt2].filter(Boolean)
	if (usages.length > 0) lines.push(`用法：${usages.map((item) => `\`${item}\``).join(' 或 ')}`)
	if (cmd.selection) lines.push(`用法：\`${cmd.name}\`（不带参数进入会话选择）或 \`${cmd.name} ${cmd.argHint}\``)
	return lines.join('\n')
}

/** QQ 指令面板的命令项。 */
export function panelItems() {
	return COMMANDS.map((cmd) => ({ name: cmd.name, desc: cmd.desc }))
}

/**
 * 自定义菜单的版式（顶层顺序 + 哪些命令收进二级菜单）。
 *
 * 为什么要有这份版式：QQ 平台**顶层最多 10 项**（二级每组 ≤5），而顶层还要留给
 * dsh 内置命令的二级菜单。命令表长到 9 条时，8 个平铺顶层 + 2 个 dsh 二级菜单
 * 就是 10 项上限——再加一条会挤掉 dsh 命令。所以把不常点的
 * 「停止 / 归档 / 权限」收进一个「管理」二级菜单：顶层 6 平铺 + 1 个二级菜单 = 7，
 * 给 dsh 命令留出 3 个顶层位（实际 2 个：「dsh 命令1」「dsh 命令2」）。
 *
 * 只影响**自定义菜单**：指令面板（panelItems）仍是完整平铺的 9 条命令。
 */
const MENU_LAYOUT = [
	'切换会话',
	'新建会话',
	'发送',
	'延迟发送',
	'模型',
	'进度',
	{ name: '管理', children: ['停止', '归档', '权限'] },
]

/**
 * 单聊窗口底部自定义菜单项（send_message 型 = 点击把命令填进输入框；
 * type='menu' 型是一层二级菜单，内容在 children 里）。
 *
 * 版式里没提到的命令会被兜底平铺在末尾——保证"命令表加了新命令"绝不会从菜单里消失。
 */
export function menuItems() {
	const mentioned = new Set()
	const items = MENU_LAYOUT.map((entry) => {
		if (typeof entry === 'string') {
			mentioned.add(entry)
			return { name: entry, sendMessage: entry }
		}
		const children = entry.children
			.filter((name) => {
				mentioned.add(name)
				return BY_NAME.has(name)
			})
			.map((name) => ({ name, sendMessage: name }))
		if (children.length === 0) return null
		return { name: entry.name, type: 'menu', children }
	}).filter(Boolean)

	for (const cmd of COMMANDS) {
		if (!mentioned.has(cmd.name)) items.push({ name: cmd.name, sendMessage: cmd.name })
	}
	return items
}

/**
 * 创建命令执行器。
 *
 * deps 由 index.js 注入，全部是"动作"而不是"实现"，因此这里可以被单测直接驱动：
 *   @param {object} deps
 *   @param {object} deps.sessions  会话索引（resolveRef/describe/currentDir/listDirs/sessionsInDir）
 *   @param {object} deps.state     状态容器（绑定、待发消息）
 *   @param {(req:object)=>Promise<void>} deps.reply 回一条 QQ 文本
 *   @param {(req:object)=>Promise<void>} deps.showSessionCard 发/刷新会话选择卡片
 *   @param {(req:object)=>Promise<void>} deps.deliver 向会话投递消息（不打断）
 *   @param {(sessionId:string)=>Promise<{ok:boolean, reason?:string}>} deps.stopSession
 *   @param {(sessionId:string)=>Promise<{ok:boolean, reason?:string}>} deps.archiveSession
 *   @param {(req:object)=>Promise<void>} deps.showModelCard 发/刷新模型选择卡片（提供商列表）
 *   @param {(req:object)=>Promise<{ok:boolean, text?:string, error?:string}|null>} deps.setModel 切某个会话的模型
 */
export function createCommandRunner(deps) {
	const { sessions, state, logger } = deps

	/** 解析目标：返回 {sessionId, cwd, content} 或 {error}。 */
	function takeTarget(tokens, { allowCurrent = true } = {}) {
		if (tokens.length === 0) {
			return allowCurrent ? { sessionId: 'current' } : { error: 'missing-target' }
		}
		const resolved = sessions.resolveRef(tokens)
		if (resolved?.error) return { error: resolved.error }
		if (!resolved) return { error: 'missing-content' }
		return resolved
	}

	async function run(context, parsed) {
		switch (parsed.name) {
			case '切换会话':
				return switchSession(context, parsed)
			case '新建会话':
				return newSession(context, parsed)
			case '进度':
				return showProgress(context, parsed)
			case '发送':
				return sendOnce(context, parsed)
			case '停止':
				return stopSession(context, parsed)
			case '归档':
				return archiveSession(context, parsed)
			case '延迟发送':
				return delaySend(context, parsed)
			case '权限':
				return permissionMode(context, parsed)
			case '模型':
				return modelMode(context, parsed)
			default:
				return { handled: false }
		}
	}

	/**
	 * 新建会话。
	 *
	 * 不带参数：发"选目录"卡片（逐层进入，最后点「在这里新建」）。
	 * 带参数：直接在目标目录新建。两条路径都在新建后**默认切换到它**。
	 */
	async function newSession({ openid, replyContext }, parsed) {
		if (parsed.tokens.length === 0) {
			await deps.showNewSessionCard({ openid, replyContext })
			return { handled: true }
		}
		const cwd = parsed.tokens.join(' ').trim()
		if (!cwd) {
			await deps.reply({ openid, content: usageText('新建会话'), replyContext })
			return { handled: true }
		}
		const result = await deps.createSession({ openid, cwd })
		await deps.reply({
			openid,
			content: result.ok
				? `已在 \`${result.cwd}\` 新建并切换到 **${result.label}**\n\n${result.hint ?? '直接发消息就能开始用。'}`
				: `${result.error}\n\n${usageText('新建会话')}`,
			markdown: true,
			replyContext,
		})
		return { handled: true }
	}

	/**
	 * 进度：只读快照，**不打断**正在跑的 AI。
	 *
	 * 无参 = 当前绑定会话；带参 = 指定会话（`<会话id>` 或 `<目录> <会话id>`）。
	 */
	async function showProgress({ openid, replyContext }, parsed) {
		let sessionId = ''
		if (parsed.tokens.length === 0) {
			const bound = state.bindingOf(openid)
			if (!bound || bound === 'none') {
				await deps.reply({
					openid,
					content: '当前没有绑定会话。用 `进度 <会话id>` 可以直接看某个会话。',
					markdown: true,
					replyContext,
				})
				return { handled: true }
			}
			sessionId = bound
		} else {
			const target = sessions.resolveRef(parsed.tokens)
			if (target?.error) {
				await deps.reply({ openid, content: `${target.error}\n\n${usageText('进度')}`, replyContext })
				return { handled: true }
			}
			if (!target) {
				await deps.reply({ openid, content: usageText('进度'), replyContext })
				return { handled: true }
			}
			sessionId = target.sessionId
		}

		const result = await deps.progress({ sessionId })
		await deps.reply({ openid, content: result.content, markdown: true, replyContext })
		return { handled: true }
	}

	async function switchSession({ openid, replyContext }, parsed) {		if (parsed.tokens.length === 0) {
			// 不带参数 = 会话选择命令
			await deps.showSessionCard({ openid, replyContext })
			return { handled: true }
		}
		const target = sessions.resolveRef(parsed.tokens)
		if (target?.error) {
			await deps.reply({ openid, content: `${target.error}\n\n${usageText('切换会话')}`, replyContext })
			return { handled: true }
		}
		if (!target) {
			await deps.reply({ openid, content: usageText('切换会话'), replyContext })
			return { handled: true }
		}

		if (target.sessionId === 'none') {
			state.setBinding(openid, null)
			state.setLastCard(openid, null)
			await deps.reply({
				openid,
				content: '已解除绑定（`none`）。此后普通消息不会再投递，只能用 `发送` / `延迟发送` 指定会话。',
				markdown: true,
				replyContext,
			})
			return { handled: true }
		}

		const session = sessions.get(target.sessionId)
		if (!session) {
			await deps.reply({ openid, content: `没找到会话 \`${target.sessionId}\`，发 \`切换会话\` 看列表。`, markdown: true, replyContext })
			return { handled: true }
		}
		if (sessions.isArchived(target.sessionId)) {
			await deps.reply({ openid, content: `会话 \`${target.sessionId}\` 已归档，不能接入；发 \`切换会话\` 重新选择。`, markdown: true, replyContext })
			return { handled: true }
		}
		state.setBinding(openid, target.sessionId)
		state.setLastCard(openid, null)
		await deps.reply({
			openid,
			content: `已接入 **${sessions.describe(target.sessionId)}**\n> 直接发消息就会进这个会话；会话在跑时会先打断。`,
			markdown: true,
			replyContext,
		})
		return { handled: true }
	}

	/**
	 * 把"引用的消息"拼在正文前面。
	 *
	 * 普通消息路径就是这么带的（`[引用的消息] <原文>` 单独一段），命令路径以前把
	 * `event.quote` 丢了 —— 用户带引用发 `发送 <会话id> <正文>` 时，AI 完全看不到被引用的那条。
	 */
	function withQuote(text, quote) {
		const body = String(text ?? '').trim()
		const cited = String(quote ?? '').trim()
		if (!cited) return body
		return body ? `[引用的消息] ${cited}\n\n${body}` : `[引用的消息] ${cited}`
	}

	async function sendOnce({ openid, replyContext, quote = '' }, parsed) {
		// 裸发 `发送`：进入**当前会话**的输入态（不打断正在跑的 AI）。
		if (parsed.tokens.length === 0) {
			const sessionId = currentSessionId(openid)
			if (!sessionId || sessionId === 'none') {
				await deps.reply({
					openid,
					content:
						'当前没有绑定会话，没法进入输入态。先 `切换会话`，或用 `发送 <会话id>` 进那个会话的输入态，' +
						'或用 `发送 <会话id> <内容>` 单次投递。',
					markdown: true,
					replyContext,
				})
				return { handled: true }
			}
			await deps.beginInput?.({ openid, sessionId, replyContext })
			return { handled: true }
		}
		const target = sessions.resolveRef(parsed.tokens)
		if (target?.error) {
			await deps.reply({ openid, content: `${target.error}\n\n${usageText('发送')}`, replyContext })
			return { handled: true }
		}
		if (!target || target.sessionId === 'none') {
			await deps.reply({ openid, content: usageText('发送'), replyContext })
			return { handled: true }
		}
		const session = sessions.get(target.sessionId)
		if (!session) {
			await deps.reply({ openid, content: `没找到会话 \`${target.sessionId}\`。`, markdown: true, replyContext })
			return { handled: true }
		}
		// 只给了目标、没给内容：进入**那个会话**的输入态（而不是回用法）。
		if (!target.content) {
			await deps.beginInput?.({ openid, sessionId: target.sessionId, replyContext })
			return { handled: true }
		}
		// 单次投递和输入态的「发送」同义：**打断**目标会话正在跑的轮次，立刻投过去。
		// 不想打断就用 `延迟发送`（本轮正常结束后才投）。带引用时把被引用的那条一起带上。
		await deps.deliver({
			sessionId: target.sessionId,
			openid,
			text: withQuote(target.content, quote),
			interrupt: true,
			origin: 'qq',
		})
		await deps.reply({
			openid,
			content: `已投递到 ${sessions.describe(target.sessionId)}（会打断正在跑的轮次；不想打断就用 \`延迟发送\`。这种单次投递不带附件，附件请走输入态）。`,
			markdown: true,
			replyContext,
		})
		return { handled: true }
	}

	async function stopSession({ openid, replyContext }, parsed) {
		const target = parsed.tokens.length > 0 ? takeTarget(parsed.tokens) : { sessionId: 'current' }
		const sessionId = target.sessionId === 'current' ? currentSessionId(openid) : target.sessionId
		if (!sessionId || sessionId === 'none') {
			await deps.reply({ openid, content: '当前没有绑定会话。用法：`停止`（当前会话）或 `停止 <会话id>`。', markdown: true, replyContext })
			return { handled: true }
		}
		const result = await deps.stopSession(sessionId)
		await deps.reply({
			openid,
			content: result.ok
				? `已请求停止 ${sessions.describe(sessionId)} 当前轮次。`
				: `没停成：${result.reason ?? '未知原因'}（${sessions.describe(sessionId)}）`,
			markdown: true,
			replyContext,
		})
		return { handled: true }
	}

	async function archiveSession({ openid, replyContext }, parsed) {
		const target = parsed.tokens.length > 0 ? takeTarget(parsed.tokens) : { sessionId: 'current' }
		const sessionId = target.sessionId === 'current' ? currentSessionId(openid) : target.sessionId
		if (!sessionId || sessionId === 'none') {
			await deps.reply({ openid, content: '当前没有绑定会话。用法：`归档`（当前会话）或 `归档 <会话id>`。', markdown: true, replyContext })
			return { handled: true }
		}
		const result = await deps.archiveSession(sessionId)
		if (result.ok) {
			// 归档后不能再用：清掉指向它的绑定。
			for (const [who, bound] of Object.entries(state.get().bindings)) {
				if (bound === sessionId) state.setBinding(who, null)
			}
		}
		await deps.reply({
			openid,
			content: result.ok
				? `已归档 ${sessions.describe(sessionId)}（已从卡片移除，并解除相关绑定）。`
				: `没归档成：${result.reason ?? '未知原因'}（${sessions.describe(sessionId)}）`,
			markdown: true,
			replyContext,
		})
		return { handled: true }
	}

	/**
	 * 权限：不带参数发卡片，带参数直接设定。
	 *
	 * 作用对象是**当前绑定会话**（dsh 的权限预设是 per-session 的）。
	 */
	async function permissionMode({ openid, replyContext }, parsed) {
		const sessionId = currentSessionId(openid)
		if (!sessionId || sessionId === 'none') {
			await deps.reply({
				openid,
				content: '当前没有绑定会话。先 `切换会话`，再发 `权限` 看这台的权限卡片。',
				markdown: true,
				replyContext,
			})
			return { handled: true }
		}
		if (parsed.tokens.length === 0) {
			await deps.showPermissionCard?.({ openid, sessionId, replyContext })
			return { handled: true }
		}
		// 带参数：直接设定（认中文名/英文 key/序号）
		const result = await deps.setPermission?.({ openid, sessionId, tokens: parsed.tokens })
		if (!result) {
			await deps.reply({ openid, content: usageText('权限'), replyContext })
			return { handled: true }
		}
		await deps.reply({
			openid,
			content: result.ok
				? `已把 **${sessions.describe(sessionId)}** 的权限切成 ${result.text}。`
				: `${result.error}\n\n${usageText('权限')}`,
			markdown: true,
			replyContext,
		})
		return { handled: true }
	}

	/**
	 * 模型：不带参数发卡片（提供商 → 模型两级），带参数直接切。
	 *
	 * 作用对象**默认是当前绑定会话**；末尾可以再跟一个可选的**会话id**，
	 * 把模型切给别的会话（`模型 deepseek/deepseek-chat session-xxxx`）。
	 */
	async function modelMode({ openid, replyContext }, parsed) {
		if (parsed.tokens.length === 0) {
			const sessionId = currentSessionId(openid)
			if (!sessionId || sessionId === 'none') {
				await deps.reply({
					openid,
					content: '当前没有绑定会话。先 `切换会话`，再发 `模型` 看模型卡片；也可以 `模型 <提供商>/<模型名字> <会话id>` 直接切给某个会话。',
					markdown: true,
					replyContext,
				})
				return { handled: true }
			}
			await deps.showModelCard?.({ openid, sessionId, replyContext })
			return { handled: true }
		}

		// 末尾可选会话id：只有"最后一个 token 能当成会话引用"时才切出来，
		// 这样带空格的模型显示名（`模型 openai/GPT 5.2`）不会被误当成会话。
		let specTokens = parsed.tokens
		let target = ''
		if (parsed.tokens.length >= 2) {
			const tail = parsed.tokens[parsed.tokens.length - 1]
			const ref = sessions.resolveRef([tail])
			if (ref?.error) {
				await deps.reply({ openid, content: `${ref.error}\n\n${usageText('模型')}`, replyContext })
				return { handled: true }
			}
			if (ref?.sessionId && ref.sessionId !== 'none') {
				target = ref.sessionId
				specTokens = parsed.tokens.slice(0, -1)
			}
		}
		const sessionId = target || currentSessionId(openid)
		if (!sessionId || sessionId === 'none') {
			await deps.reply({
				openid,
				content: `当前没有绑定会话。用法：\`模型\` 看卡片，或 \`模型 <提供商>/<模型名字> <会话id>\` 切给某个会话。`,
				markdown: true,
				replyContext,
			})
			return { handled: true }
		}

		const result = await deps.setModel?.({ openid, sessionId, spec: specTokens.join(' ') })
		if (!result) {
			await deps.reply({ openid, content: usageText('模型'), replyContext })
			return { handled: true }
		}
		await deps.reply({
			openid,
			content: result.ok
				? `已把 **${sessions.describe(sessionId)}** 的模型切成 ${result.text}。`
				: `${result.error}\n\n${usageText('模型')}`,
			markdown: true,
			replyContext,
		})
		return { handled: true }
	}

	async function delaySend({ openid, replyContext, quote = '' }, parsed) {
		// 裸发 `延迟发送` / 只给目标：和 `发送` **共用同一套输入态面板**，
		// 区别只是投递时机（本轮正常结束后），所以这里同样进输入态，只是 mode=delay。
		if (parsed.tokens.length === 0) {
			const sessionId = currentSessionId(openid)
			if (!sessionId || sessionId === 'none') {
				await deps.reply({
					openid,
					content:
						'当前没有绑定会话，没法进入输入态。先 `切换会话`，或用 `延迟发送 <会话id>` 进那个会话的输入态，' +
						'或用 `延迟发送 <会话id> <内容>` 直接登记。',
					markdown: true,
					replyContext,
				})
				return { handled: true }
			}
			await deps.beginInput?.({ openid, sessionId, replyContext, mode: 'delay' })
			return { handled: true }
		}
		const target = sessions.resolveRef(parsed.tokens)
		if (target?.error) {
			await deps.reply({ openid, content: `${target.error}\n\n${usageText('延迟发送')}`, replyContext })
			return { handled: true }
		}
		if (!target || target.sessionId === 'none') {
			await deps.reply({ openid, content: usageText('延迟发送'), replyContext })
			return { handled: true }
		}
		const session = sessions.get(target.sessionId)
		if (!session) {
			await deps.reply({ openid, content: `没找到会话 \`${target.sessionId}\`。`, markdown: true, replyContext })
			return { handled: true }
		}
		if (!target.content) {
			// 只给了目标：进那个会话的**延迟**输入态（和 `发送 <会话id>` 对称）。
			await deps.beginInput?.({ openid, sessionId: target.sessionId, replyContext, mode: 'delay' })
			return { handled: true }
		}
		state.setDelayed(target.sessionId, {
			content: withQuote(target.content, quote),
			openid,
			at: new Date().toISOString(),
		})
		state.flush()
		logger?.info?.('已登记待发消息', { sessionId: target.sessionId })
		await deps.reply({
			openid,
			content: `已登记：**${sessions.describe(target.sessionId)}** 本轮正常结束后投递（覆盖该会话原有待发消息）。`,
			markdown: true,
			replyContext,
		})
		return { handled: true }
	}

	function currentSessionId(openid) {
		const bound = state.bindingOf(openid)
		return bound ?? 'none'
	}

	return { run, currentSessionId }
}
