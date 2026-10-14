#!/usr/bin/env bash
# 轮次结束通知自检：注入一条 QQ 消息 → 等这一轮跑完 → 看插件有没有把通知发出去。
#
# 背景：线上出现过"完成提示不发了"。这条链路（投递 → 认领轮次 → turn/end 或 whenIdle
# 兜底 → 发通知）只有真机能验，所以做成可反复跑的自检，并且**外包给临时单元**（不要占会话）：
#   systemd-run --user --unit=dsh-qq-notice-verify --collect \
#     deploy/verify-round-notice.sh /tmp/dsh-qq-notice-verify.log [延迟秒数]
# 延迟用于让当前正在跑的轮次先结束（不然会把人家打断）。
#
# 判读：日志结尾必须有 "结论：" 一行，并且上面能看到插件小日志（state.json 的 notes）里的
#   `轮次开始` → `认领轮次` → `收尾：… reason=completed` → `通知已入队：已结束`。
set -u -o pipefail

LOG="${1:-/tmp/dsh-qq-notice-verify.log}"
DELAY="${2:-0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.dsh/dsh-qq-bot/state.json"
export SOCKET="$HOME/.dsh/dsh-qq-bot/bridge.sock"

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >>"$LOG"; }
dump_notes() { node -e "
const s=require(process.env.STATE);
for (const line of (s.notes ?? []).slice(-14)) console.log('   ', line);
" >>"$LOG" 2>&1; }
export STATE

: >"$LOG"
log "=== 轮次通知自检开始 ==="

if [ "$DELAY" -gt 0 ]; then
	log "先等 ${DELAY}s，让当前正在跑的轮次结束（避免把它打断）"
	sleep "$DELAY"
fi

for _ in $(seq 1 60); do
	if [ -S "$SOCKET" ]; then break; fi
	sleep 1
done
if [ ! -S "$SOCKET" ]; then
	log "!! 60 秒内没等到通道，放弃"
	exit 1
fi

# openid 取白名单第一个（跳过注释行——模板注释里的假 openid 会先被 grep 命中，踩过）
OPENID="$(grep -vE '^[[:space:]]*#' "$ROOT/config.yaml" | grep -m1 -oE 'openid:[[:space:]]*"[^"]+"' | sed -E 's/.*"([^"]+)".*/\1/')"
if ! printf '%s' "$OPENID" | grep -qE '^[A-Za-z0-9_-]{16,}$'; then
	log "!! 取到的 openid 不像 openid（长度 ${#OPENID}）：$OPENID"
	exit 1
fi
log "目标：openid ${OPENID:0:6}…"

before_notes="$(node -e "const s=require(process.env.STATE);console.log((s.notes??[]).length)" 2>/dev/null || echo 0)"
before_notices="$(node -e "const s=require(process.env.STATE);console.log(Object.keys(s.notices??{}).length)" 2>/dev/null || echo 0)"

log "--- 注入一条真实 QQ 消息 ---"
node "$ROOT/deploy/probe-qq-message.mjs" --openid "$OPENID" --text '【自检】只回一句 ok，别做别的' >>"$LOG" 2>&1

# 等这一轮跑完 + 通知入队：最多 5 分钟（模型要起一轮）
verdict="timeout"
for _ in $(seq 1 100); do
	sleep 3
	if node -e "
const s=require(process.env.STATE);
const notes=s.notes??[];
process.exit(notes.some((l)=>/通知已入队：已结束/.test(l))?0:1);
" 2>/dev/null; then
		verdict="ok"
		break
	fi
	if node -e "
const s=require(process.env.STATE);
const notes=s.notes??[];
process.exit(notes.some((l)=>/通知已入队：被打断/.test(l))?0:1);
" 2>/dev/null; then
		verdict="interrupted"
		break
	fi
done

after_notes="$(node -e "const s=require(process.env.STATE);console.log((s.notes??[]).length)" 2>/dev/null || echo 0)"
after_notices="$(node -e "const s=require(process.env.STATE);console.log(Object.keys(s.notices??{}).length)" 2>/dev/null || echo 0)"
log "notes 条数：$before_notes → $after_notes ；notices 条数：$before_notices → $after_notices"
log "--- 插件小日志（最近 14 条）---"
dump_notes

case "$verdict" in
	ok) log "结论：✅ 这一轮结束后「已结束」通知已入队（事件或 whenIdle 兜底任一路径）" ;;
	interrupted) log "结论：⚠️ 这一轮被判成「被打断」并已入队——说明有别的消息把这一轮顶掉了，重跑一次再判" ;;
	*) log "结论：❌ 5 分钟内没看到任何「通知已入队」——上面小日志会指明卡在哪一步（缩略：轮次开始/认领/收尾/收到会话事件）" ;;
esac

log "=== 自检结束 ==="
