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
 * 正向证据（比"日志里没有报错"强得多）：
 *   1. 第 ④ 步之后插件状态文件里的 `pendingModel[openid]` 必须出现，
 *      第 ⑤ 步之后必须消失 —— 证明插件**认领**了这些事件（openid 在白名单里）；
 *   2. `lastCard[openid]` 必须被写上一个真 messageId —— 插件的 sendCard 是
 *      `expectMessageId` 的，只有网关 ack 里带了 messageId 才会写进去，
 *      所以它存在 = QQ 真的收下了那张卡片。
 *
 * 用法：
 *   node deploy/probe-model-card.mjs --openid <QQ私聊openid> [--provider <id>] [--model <id>] [--state <路径>]
 * 只给 --openid 时用默认的 ymyun / gpt-5.6-sol（本项目部署配置里的第一对）。
 * 注入的 event 不带 msgId → 插件按**主动消息**发（网关侧本来就有被动→主动降级）。
 */
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'

function parseArgs(argv) {
	const out = {
		socket: `${process.env.HOME}/.dsh/dsh-qq-bot/bridge.sock`,
		state: `${process.env.HOME}/.dsh/dsh-qq-bot/state.json`,
	}
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
const STATE = options.state

if (!OPENID) {
	console.error('用法：node deploy/probe-model-card.mjs --openid <openid> [--provider <id>] [--model <id>]')
	process.exit(2)
}

const mask = (id) => `${String(id).slice(0, 6)}…`
const readState = () => {
	try {
		return JSON.parse(readFileSync(STATE, 'utf8'))
	} catch {
		return null
	}
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
const model = 'qqb:mod'
const interaction = (action, extra, n) =>
	rpc('event', {
		kind: 'interaction',
		openid: OPENID,
		buttonData: `${model}:${action}:${extra}`,
		eventId: `PROBE-INTERACTION-${n}`,
		msgId: '',
	})

const health = await rpc('health')
console.log('health:', JSON.stringify(health.value))

// ① 提供商卡片（label 上限 24 显示宽度）
console.log('① 注入 `模型` →', JSON.stringify(await rpc('event', { kind: 'c2c_message', openid: OPENID, text: '模型' })))
await sleep(2500)

// ② 该提供商的模型列表（label 上限 60：本项目里的名字有 18~21 个字符宽，旧代码会被砍）
console.log(`② 注入 enter:${PROVIDER} →`, JSON.stringify(await interaction('enter', PROVIDER, 1)))
await sleep(2500)

// ③ 点一个模型 → 确认卡片（三个交互按钮，label 都超过旧的 10 显示宽度）
console.log(`③ 注入 pick:${PROVIDER}:${MODEL} →`, JSON.stringify(await interaction('pick', `${PROVIDER}:${MODEL}`, 2)))
await sleep(2500)

// ④ 「切到其他会话」→ 提示卡片（会进入"等会话id"状态）
console.log(`④ 注入 other:${PROVIDER}:${MODEL} →`, JSON.stringify(await interaction('other', `${PROVIDER}:${MODEL}`, 3)))
await sleep(2000)

const afterOther = readState()
const pending = afterOther?.pendingModel?.[OPENID]
const lastCardAfterOther = afterOther?.lastCard?.[OPENID]
console.log(
	`④ 后状态：pendingModel=${pending ? `${pending.provider}/${pending.model}` : '（没有）'}`,
	`| lastCard=${lastCardAfterOther ? mask(lastCardAfterOther) : '（没有）'}`,
)

// ⑤ 「取消」→ 清掉等待状态 + 回到确认卡片（**不切任何模型**）
console.log(`⑤ 注入 cancel:${PROVIDER}:${MODEL} →`, JSON.stringify(await interaction('cancel', `${PROVIDER}:${MODEL}`, 4)))
await sleep(2500)

const afterCancel = readState()
const pendingLeft = afterCancel?.pendingModel?.[OPENID]
const lastCard = afterCancel?.lastCard?.[OPENID]
console.log(
	`⑤ 后状态：pendingModel=${pendingLeft ? '（还在！）' : '（已清）'}`,
	`| lastCard=${lastCard ? mask(lastCard) : '（没有）'}`,
)

const after = await rpc('health')
console.log('health after:', JSON.stringify(after.value))

const problems = []
if (!pending) problems.push('第 ④ 步没有写进 pendingModel —— 插件可能没认领这些事件（openid 不在白名单？）')
if (pendingLeft) problems.push('第 ⑤ 步没有清掉 pendingModel —— 插件状态不对')
if (!lastCard) problems.push('lastCard 一直是空的 —— 没有任何一张卡片拿到 QQ 的 ack（没发出去？）')

if (problems.length > 0) {
	console.error(`探针失败：\n- ${problems.join('\n- ')}`)
	process.exit(1)
}
console.log('探针完成：插件已认领事件、卡片拿到了 QQ 的 ack，且全程未调用 selectModel（不改任何会话的模型）')
