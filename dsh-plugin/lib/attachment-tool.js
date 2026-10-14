/**
 * `qq_fetch_attachment`：把 QQ 消息里**没有自动下载**的附件拉下来。
 *
 * 为什么需要它：QQ 单聊里超大附件（超过自动下载上限）如果一律下载，会把宿主机内存/磁盘吃掉；
 * 所以默认只登记不下载，让模型**按需**调用这个工具去拉。平台的签名直链会过期，
 * 拉不到就如实回报失败，不要假装成功。
 *
 * 只读语义：下载结果落在 dsh 附件服务里（只读副本），不会改动用户的消息或输入态。
 */

/** 工具名（注册与测试共用）。 */
export const ATTACHMENT_TOOL_NAME = 'qq_fetch_attachment'

function text(value) {
	return [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * @param {object} deps
 * @param {object} deps.inbox 输入态/附件管理器
 * @param {object} [deps.logger]
 * @param {{sessionId: string}} deps.target
 */
export function buildAttachmentTool({ inbox, logger, target }) {
	return {
		name: ATTACHMENT_TOOL_NAME,
		description:
			'把用户这条 QQ 消息里「未自动下载」的附件（标记为未下载/过大/下载失败的）拉下来，返回它的只读副本路径。' +
			'附件 id 来自这条消息里给出的附件列表；只在当次消息内有效，过期的 id 会回报失败。',

		parameters: {
			type: 'object',
			properties: {
				id: {
					type: 'string',
					description: '附件 id（形如 A3），取自媒体里给的那份附件列表。',
				},
			},
			required: ['id'],
			additionalProperties: false,
		},

		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					id: { type: 'string' },
					kind: { type: 'string' },
					name: { type: 'string' },
					path: { type: 'string' },
					error: { type: 'string' },
				},
				required: ['ok', 'id'],
				additionalProperties: false,
			},
			render: (_args, value) => text(value),
		},

		async execute(args) {
			const id = typeof args?.id === 'string' ? args.id.trim() : ''
			if (!id) return { ok: false, id, error: '缺少附件 id' }
			const result = await inbox.fetchForModel({ sessionId: target.sessionId, itemId: id })
			if (!result.ok) {
				logger?.warn?.('附件按需下载失败', { sessionId: target.sessionId, id, error: result.error })
				return { ok: false, id, error: result.error }
			}
			const item = result.item ?? {}
			return {
				ok: true,
				id,
				kind: item.kind ?? '',
				name: item.filename ?? '',
				path: result.hostPath ?? '',
				...(result.hostPath ? {} : { error: '已保存进附件服务，但当前执行环境拿不到可读路径' }),
			}
		},
	}
}
