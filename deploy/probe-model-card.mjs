/**
 * 真机卡片探针：往本机桥（UNIX socket + NDJSON）里注入一串事件，
 * 让插件真的往 QQ 发几张**模型卡片**——用来验证"平台能不能吃下长 label 的按钮"。
 *
 * 为什么需要它：`clipLabel` 的宽度上限是我们自己定的（旧文档说 10 character，
 * 但当前平台文档只写"按钮上的文字"）。本地测试只能证明我们**构造**了这些按钮，
 * 平台收不收、渲染成什么样只有真机能回答。这个是"改了看日志"里的"看日志"那一步。
 *
 * 行为：只点**不会改变任何会话状态**的路径 —— 提供商 → 模型列表 → 确认卡片 →
 * 「切到其他会话」提示卡片 → 「取消」回到确认卡片。全程不调用 selectModel。
 *
 * 用法：
 *   node deploy/probe-model-card.mjs --openid <QQ私聊openid> --provider <提供商id> --model <模型id>
 * 只给 --openid 时用默认的 ymyun / gpt-5.6-sol（本项目部署配置里的第一对）。
 * 注入的 event 不带 msgId → 插件按**主动消息**发（网关侧本来就有被动→主动降级）。
 */
import { connect } from 'node:net'

function parseArgs(argv) {
	const out = { socket: `${process.env.HOME}/.dsh/dsh-qq-bot/bridge.sock` }
	for (let i = 0; i < argv.length; i += 1) {
		const key = argv[i]
		if (!key.startsWith('--')) continue
		out[key.slice(2)] = argv[i + 1]
		i += 1
	}
	return out
}

const options = parseArgs(process.argv.slice(2))
const OPENID = options.openid
const PROVIDER = options.provider ?? 'ymyun'
const MODEL = options.model ?? 'gpt-5.6-sol'
const SOCKET = options.socket

if (!OPENID) {
	console.error('用法：node deploy/probe-model-card.mjs --openid <openid> [--provider <id>] [--model <id>]')
	process.exit(2)
}

let seq = 0
function rpc(op, args = {}) {
	return new Promise((resolve, reject) => {
		const socket = connect(SOCKET)
		let buffer = ''
		const id = `probe${(seq += 1)}`
		const timer = setTimeout(() => {
			socket.destroy()
			reject(new Error(`RPC 超时：${op}`))
		}, 8000)
		socket.on('connect', () => socket.write(`${JSON.stringify({ id, op, args })}\n`))
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8')
			const index = buffer.indexOf('\n')
			if (index < 0) return
			clearTimeout(timer)
			const frame = JSON.parse(buffer.slice(0, index))
			socket.destroy()
			resolve(frame)
		})
		socket.on('error', (error) => {
			clearTimeout(timer)
			reject(error)
		})
	})
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const model = `qqb:mod`

const health = await rpc('health')
console.log('health:', JSON.stringify(health.value))

// ① 提供商卡片（label 上限 24 显示宽度）
console.log('① 注入 `模型` →', JSON.stringify(await rpc('event', { kind: 'c2c_message', openid: OPENID, text: '模型' })))
await sleep(2500)

// ② 该提供商的模型列表（label 上限 60：这里的名字有 18~21 个字符宽，旧代码会被砍）
console.log(
	`② 注入 enter:${PROVIDER} →`,
	JSON.stringify(
		await rpc('event', {
			kind: 'interaction',
			openid: OPENID,
			buttonData: `${model}:enter:${PROVIDER}`,
			eventId: 'PROBE-INTERACTION-1',
			msgId: '',
		}),
	),
)
await sleep(2500)

// ③ 点一个模型 → 确认卡片（三个交互按钮，label 都超过旧的 10 显示宽度）
console.log(
	`③ 注入 pick:${PROVIDER}:${MODEL} →`,
	JSON.stringify(
		await rpc('event', {
			kind: 'interaction',
			openid: OPENID,
			buttonData: `${model}:pick:${PROVIDER}:${MODEL}`,
			eventId: 'PROBE-INTERACTION-2',
			msgId: '',
		}),
	),
)
await sleep(2500)

// ④ 「切到其他会话」→ 提示卡片（会进入"等会话id"状态）
console.log(
	`④ 注入 other:${PROVIDER}:${MODEL} →`,
	JSON.stringify(
		await rpc('event', {
			kind: 'interaction',
			openid: OPENID,
			buttonData: `${model}:other:${PROVIDER}:${MODEL}`,
			eventId: 'PROBE-INTERACTION-3',
			msgId: '',
		}),
	),
)
await sleep(2500)

// ⑤ 「取消」→ 清掉等待状态 + 回到确认卡片（**不切任何模型**）
console.log(
	`⑤ 注入 cancel:${PROVIDER}:${MODEL} →`,
	JSON.stringify(
		await rpc('event', {
			kind: 'interaction',
			openid: OPENID,
			buttonData: `${model}:cancel:${PROVIDER}:${MODEL}`,
			eventId: 'PROBE-INTERACTION-4',
			msgId: '',
		}),
	),
)
await sleep(2500)

const after = await rpc('health')
console.log('health after:', JSON.stringify(after.value))
console.log('探针完成（全程未调用 selectModel，不改变任何会话的模型）')
