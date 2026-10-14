/**
 * qq_reply 工具：把内容/附件发给 QQ 用户。
 *
 * **本文件不 import 任何 dsh 包**（bundle 必须自包含：profile 安装是软链，
 * 按 realpath 解析时 `/home/fouc3/Projects/...` 这条链上没有 `@deepseek-ai/*`）。
 * 所以这里直接给出注册表要的 ToolDefinition：原始 JSON Schema 的 `parameters`
 * 与 `output.schema`（defineTool 的 DSL 编译出来正是这个形状），加上 `execute`。
 */

export const REPLY_TOOL_NAME = 'qq_reply'

export const REPLY_TOOL_DESCRIPTION = [
	'把内容发送给 QQ 用户。消息类型可选：文本 / markdown（`markdown=true`）/ 图片 / 视频 / 语音 / 文件（`attachments`）。',
	'`attachments` 里 `path` 用本机文件（批量分片上传）、`url` 用公网可下载地址，两者二选一；`kind` 取 `image`/`video`/`voice`/`file`。',
	'完成时请尽可能详细地把结果回复给用户；过程中也可以随时调用本工具汇报当前进度。',
	'除非用户明确要求，否则只在你被 QQ 消息拉起时使用本工具。',
].join('\n')

/** 附件参数的可选类型。 */
const ATTACHMENT_KINDS = ['image', 'video', 'voice', 'file']

/**
 * 构造 qq_reply 的工具定义。
 *
 * @param {object} options
 * @param {object} options.outbox 出站队列
 * @param {object} options.config 插件配置（replyAckTimeoutMs / defaultMarkdown / replyHeader / replyHeaderTemplate）
 * @param {object} options.logger
 * @param {object} options.target 目标会话的实时视图：
 *        { openid: () => string|null, label: () => string, context: () => ({msgId,eventId}), nextSeq: () => number }
 */
export function buildReplyTool({ outbox, config, logger, target }) {
	function headerText() {
		if (!config.replyHeader) return ''
		const template = config.replyHeaderTemplate || '【{title}({id})】'
		const label = target.label()
		return `${template.replace('{title}', label.title).replace('{id}', label.id)}`
	}

	async function waitAck(acked) {
		const timeoutMs = Math.max(500, Number(config.replyAckTimeoutMs) || 8000)
		let timer = null
		const timeout = new Promise((resolve) => {
			timer = setTimeout(() => resolve({ ok: false, error: '等待送达确认超时（已排队，可能稍后送达）' }), timeoutMs)
			if (typeof timer.unref === 'function') timer.unref()
		})
		try {
			return await Promise.race([acked, timeout])
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	async function sendText({ content, markdown }) {
		const context = target.context()
		const result = await waitAck(
			outbox.enqueue(
				'send_c2c',
				{
					openid: target.openid(),
					markdown: Boolean(markdown),
					content,
					replyToMsgId: context.msgId ?? '',
					replyToEventId: context.eventId ?? '',
					msgSeq: target.nextSeq(),
				},
				{ expectAck: true },
			).acked,
		)
		return result
	}

	async function sendAttachment(attachment) {
		const context = target.context()
		const result = await waitAck(
			outbox.enqueue(
				'send_media',
				{
					openid: target.openid(),
					kind: attachment.kind,
					path: attachment.path ?? '',
					url: attachment.url ?? '',
					name: attachment.name ?? '',
					replyToMsgId: context.msgId ?? '',
					replyToEventId: context.eventId ?? '',
					msgSeq: target.nextSeq(),
				},
				{ expectAck: true },
			).acked,
		)
		return result
	}

	return {
		name: REPLY_TOOL_NAME,
		description: REPLY_TOOL_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				content: {
					type: 'string',
					description: '要发给 QQ 用户的正文（与 attachments 至少给一个）。markdown=true 时按 markdown 渲染。',
				},
				markdown: {
					type: 'boolean',
					description: `是否按 markdown 渲染（默认 ${config.defaultMarkdown ? 'true' : 'false'}）；带附件时正文也遵守这个开关。`,
				},
				attachments: {
					type: 'array',
					description: '富媒体附件，逐条作为独立的一条 QQ 消息发送。',
					items: {
						type: 'object',
						properties: {
							kind: {
								type: 'string',
								description: `附件类型：${ATTACHMENT_KINDS.join(' / ')}。`,
								enum: [...ATTACHMENT_KINDS],
							},
							path: { type: 'string', description: '本机文件的绝对路径（走分片上传）。与 url 二选一。' },
							url: { type: 'string', description: '公网可下载地址（平台自行下载）。与 path 二选一。' },
							name: { type: 'string', description: '展示用的文件名，可空。' },
						},
						required: ['kind'],
					},
				},
			},
			required: [],
			additionalProperties: false,
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					sent: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								kind: { type: 'string' },
								messageId: { type: 'string' },
							},
						},
					},
					failed: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								kind: { type: 'string' },
								error: { type: 'string' },
							},
						},
					},
				},
				required: ['ok'],
				additionalProperties: false,
			},
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
		},

		async execute(args) {
			const openid = target.openid()
			if (!openid) {
				return { ok: false, sent: [], failed: [{ error: '该会话当前没有绑定 QQ 私聊，无法回复' }] }
			}

			const content = typeof args?.content === 'string' ? args.content.trim() : ''
			const attachments = Array.isArray(args?.attachments) ? args.attachments : []
			if (!content && attachments.length === 0) {
				return { ok: false, sent: [], failed: [{ error: 'content 与 attachments 至少要给一个' }] }
			}

			const markdown = typeof args?.markdown === 'boolean' ? args.markdown : Boolean(config.defaultMarkdown)
			const head = headerText()
			const sent = []
			const failed = []

			if (content) {
				const body = head ? `${head}\n${content}` : content
				const result = await sendText({ content: body, markdown })
				if (result.ok) sent.push({ kind: 'text', messageId: result.messageId })
				else failed.push({ kind: 'text', error: result.error })
			}

			if (attachments.length > 0) {
				// 只发附件时也要能看出这条属于哪个会话：先补一条带来源标注的单行文本。
				if (!content && head) {
					const preface = await sendText({ content: head, markdown: false })
					if (preface.ok) sent.push({ kind: 'preface', messageId: preface.messageId })
					else failed.push({ kind: 'preface', error: preface.error })
				}
				for (const attachment of attachments) {
					const kind = String(attachment?.kind ?? '').toLowerCase()
					if (!ATTACHMENT_KINDS.includes(kind)) {
						failed.push({ kind: kind || '(空)', error: `kind 必须是 ${ATTACHMENT_KINDS.join('/')} 之一` })
						continue
					}
					if (!attachment.path && !attachment.url) {
						failed.push({ kind, error: 'path 与 url 至少要给一个' })
						continue
					}
					const result = await sendAttachment({ ...attachment, kind })
					if (result.ok) sent.push({ kind, messageId: result.messageId })
					else failed.push({ kind, error: result.error })
				}
			}

			if (failed.length > 0) {
				logger?.warn?.('qq_reply 部分或全部发送失败', { sessionId: target.sessionId, sent: sent.length, failed: failed.length })
			}
			return { ok: failed.length === 0, sent, failed }
		},
	}
}
