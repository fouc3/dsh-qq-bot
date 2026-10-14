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
		desc: '把一条消息单次投递到指定会话',
		requiresArgs: true,
		purpose: '把一条消息单次投递到指定会话，不改绑定、不打断（忙则排队）。',
		usage: '发送 <会话id> <内容>',
		usageAlt: '发送 <目录> <会话id> <内容>',
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
		desc: '本轮正常结束后投递',
		requiresArgs: true,
		purpose: '为指定会话登记一条待发消息，等该会话当前这一轮 AI 正常结束后再投递；每个会话同时只有一条（重复登记会覆盖）。',
		usage: '延迟发送 <会话id> <内容>',
		usageAlt: '延迟发送 <目录> <会话id> <内容>',
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
	if (cmd.usage) {
		lines.push(`用法：\`${cmd.usage}\`` + (cmd.usageAlt ? ` 或 \`${cmd.usageAlt}\`` : ''))
	}
	if (cmd.selection) lines.push(`用法：\`${cmd.name}\`（不带参数进入会话选择）或 \`${cmd.name} ${cmd.argHint}\``)
	return lines.join('\n')
}

/** QQ 指令面板的命令项。 */
export function panelItems() {
	return COMMANDS.map((cmd) => ({ name: cmd.name, desc: cmd.desc }))
}

/** 单聊窗口底部自定义菜单项（send_message 型 = 点击把命令填进输入框）。 */
export function menuItems() {
	return COMMANDS.map((cmd) => ({ name: cmd.name, sendMessage: cmd.name }))
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

	async function sendOnce({ openid, replyContext }, parsed) {
		const target = sessions.resolveRef(parsed.tokens)
		if (target?.error) {
			await deps.reply({ openid, content: `${target.error}\n\n${usageText('发送')}`, replyContext })
			return { handled: true }
		}
		if (!target || target.sessionId === 'none') {
			await deps.reply({ openid, content: usageText('发送'), replyContext })
			return { handled: true }
		}
		if (!target.content) {
			await deps.reply({ openid, content: usageText('发送'), replyContext })
			return { handled: true }
		}
		const session = sessions.get(target.sessionId)
		if (!session) {
			await deps.reply({ openid, content: `没找到会话 \`${target.sessionId}\`。`, markdown: true, replyContext })
			return { handled: true }
		}
		await deps.deliver({
			sessionId: target.sessionId,
			openid,
			text: target.content,
			interrupt: false,
		})
		await deps.reply({
			openid,
			content: `已投递到 ${sessions.describe(target.sessionId)}（不打断，忙则排队）。`,
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

	async function delaySend({ openid, replyContext }, parsed) {
		const target = sessions.resolveRef(parsed.tokens)
		if (target?.error) {
			await deps.reply({ openid, content: `${target.error}\n\n${usageText('延迟发送')}`, replyContext })
			return { handled: true }
		}
		if (!target || target.sessionId === 'none' || !target.content) {
			await deps.reply({ openid, content: usageText('延迟发送'), replyContext })
			return { handled: true }
		}
		const session = sessions.get(target.sessionId)
		if (!session) {
			await deps.reply({ openid, content: `没找到会话 \`${target.sessionId}\`。`, markdown: true, replyContext })
			return { handled: true }
		}
		state.setDelayed(target.sessionId, {
			content: target.content,
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
