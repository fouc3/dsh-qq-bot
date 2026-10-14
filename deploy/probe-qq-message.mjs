/**
 * 通用探针：往桥里注入**一条 QQ 私聊消息**（当作出自那个白名单账号）。
 *
 * 用途：自发一轮真实的 QQ 轮次，用来验证"一轮结束后 QQ 到底会不会收到「已结束」卡片"
 * ——这条链路依赖 dsh 的 `turn/end`（或 whenIdle 兜底）+ 插件侧的轮次状态，
 * 本地单测只能证明判断逻辑，证明不了真机这一轮。
 *
 * 用法：
 *   node deploy/probe-qq-message.mjs --openid <openid> [--text "…"] [--socket 路径]
 */
import { connect } from 'node:net'

function parseArgs(argv) {
	const out = { socket: `${process.env.HOME}/.dsh/dsh-qq-bot/bridge.sock`, text: '【自检】只回一句 ok，别做别的' }
	for (let i = 0; i < argv.length; i += 1) {
		const key = argv[i]
		if (!key.startsWith('--')) continue
		out[key.slice(2)] = argv[i + 1]
		i += 1
	}
	return out
}

const options = parseArgs(process.argv.slice(2))
if (!options.openid) {
	console.error('用法：node deploy/probe-qq-message.mjs --openid <openid> [--text "…"]')
	process.exit(2)
}

const rpc = (op, args) =>
	new Promise((resolve, reject) => {
		const socket = connect(options.socket)
		let buffer = ''
		const timer = setTimeout(() => {
			socket.destroy()
			reject(new Error(`RPC 超时：${op}`))
		}, 8000)
		socket.on('connect', () => socket.write(`${JSON.stringify({ id: `probe-${op}`, op, args })}\n`))
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8')
			const index = buffer.indexOf('\n')
			if (index < 0) return
			clearTimeout(timer)
			socket.destroy()
			resolve(JSON.parse(buffer.slice(0, index)))
		})
		socket.on('error', (error) => {
			clearTimeout(timer)
			reject(error)
		})
	})

const health = await rpc('health')
console.log('health:', JSON.stringify(health.value))
console.log(`注入消息：${options.text}`)
console.log('结果：', JSON.stringify(await rpc('event', { kind: 'c2c_message', openid: options.openid, text: options.text })))
