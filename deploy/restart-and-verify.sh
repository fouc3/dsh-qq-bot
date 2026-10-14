#!/usr/bin/env bash
# 插件代码更新后的重启 + 自检。
#
# 为什么必须重启 dsh-web：Host 插件的 ESM 模块按 URL 缓存，重新激活插件行
# 仍会拿到旧模块实例；只有宿主进程重启才会重新导入。重启后本脚本会等通道
# 重新出现，再把网关拉起来（网关此前可能因为止血被停掉）。
#
# 两个"别丢东西"的保险：
#   1) 重启前先等网关把发件箱清空（outboxDepth=0）——别把还没发出去的回复吞掉；
#   2) 网关侧的事件投递已做退避重试（internal/qq 的 emitWithRetry），
#      重启窗口里到的用户消息**不会像以前那样被静默丢掉**（踩过：`/新建会话 /tmp`）。
#
# 用法：deploy/restart-and-verify.sh [日志文件]
set -u -o pipefail

LOG="${1:-/tmp/dsh-qq-bot-restart.log}"
export SOCKET="$HOME/.dsh/dsh-qq-bot/bridge.sock"

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >>"$LOG"; }

# 读一次通道 health 的 outboxDepth（读不到就打印空）。
probe_depth() {
	node --input-type=module -e "
import { connect } from 'node:net'
const call = (op) => new Promise((res, rej) => {
	const s = connect(process.env.SOCKET)
	let buf = ''
	s.on('connect', () => s.write(JSON.stringify({ id: op, op }) + '\n'))
	s.on('data', (c) => { buf += c; const i = buf.indexOf('\n'); if (i >= 0) { s.destroy(); res(JSON.parse(buf.slice(0, i))) } })
	s.on('error', rej)
	setTimeout(() => { s.destroy(); rej(new Error('超时')) }, 3000)
})
try { const h = await call('health'); console.log(h?.value?.outboxDepth ?? '') } catch { console.log('') }
" 2>/dev/null
}

: >"$LOG"

# 等发件箱清空：最多 60 秒；等不到也继续（网关侧还有重试兜底）。
depth=""
for _ in $(seq 1 60); do
	depth="$(probe_depth)"
	if [ "$depth" = "0" ] || [ -z "$depth" ]; then break; fi
	sleep 1
done
if [ -n "$depth" ] && [ "$depth" != "0" ]; then
	log "!! 发件箱仍有 $depth 条未送达，仍然继续重启"
else
	log "发件箱已清空（outboxDepth=${depth:-unknown}），开始重启"
fi

log "=== 重启开始（dsh-web → 等通道 → dsh-qq-bot）==="

systemctl --user restart dsh-web
log "dsh-web 已重启，等待通道出现：$SOCKET"

for _ in $(seq 1 60); do
	if [ -S "$SOCKET" ]; then break; fi
	sleep 1
done

if [ ! -S "$SOCKET" ]; then
	log "!! 60 秒内没等到通道，放弃（稍后可手工 systemctl --user restart dsh-qq-bot）"
	systemctl --user status dsh-web --no-pager | tail -5 >>"$LOG" 2>&1
	exit 1
fi
log "通道已就绪：$(stat -c '%A %n' "$SOCKET")"

# 必须用 restart：网关是独立服务，dsh-web 重启不会让它退出，
# 对 active 的服务调 start 是空操作 —— 会继续跑旧二进制（踩过：quote 字段没上线）。
systemctl --user restart dsh-qq-bot
log "网关已重启（加载最新二进制）"
sleep 8

log "--- 网关日志（末尾）---"
journalctl --user -u dsh-qq-bot -n 12 --no-pager >>"$LOG" 2>&1

log "--- 通道自检（health / panel）---"
node --input-type=module -e "
import { connect } from 'node:net'
const call = (op) => new Promise((res, rej) => {
	const s = connect(process.env.SOCKET)
	let buf = ''
	s.on('connect', () => s.write(JSON.stringify({ id: op, op }) + '\n'))
	s.on('data', (c) => { buf += c; const i = buf.indexOf('\n'); if (i >= 0) { s.destroy(); res(JSON.parse(buf.slice(0, i))) } })
	s.on('error', rej)
	setTimeout(() => { s.destroy(); rej(new Error('超时')) }, 5000)
})
const health = await call('health')
console.log('health:', JSON.stringify(health.value))
const panel = await call('panel')
const menu = panel.value.menuItems ?? []
const groups = menu.filter((m) => m.type === 'menu')
console.log('panel 命令数:', panel.value.items.length, '| 菜单顶层:', menu.length, '| 二级菜单:', groups.length, groups.map((g) => g.name + '(' + g.children.length + ')').join(','))
" >>"$LOG" 2>&1 || log "!! 自检失败（见上）"

log "=== 完成 ==="
