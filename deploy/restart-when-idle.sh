#!/usr/bin/env bash
# 等会话都空闲了再重启 dsh-web（临时单元用）——**绝不打断正在跑的轮次**。
#
# 为什么需要它：用户经常有跑几十分钟的会话（K-Vault 有跑 78 分钟的先例），
# 而 Host 插件改动必须重启 dsh-web 才生效。这个脚本先等到"没有会话在跑"，
# 再交给 deploy/restart-and-verify.sh 做重启 + 自检。
#
# 用法（不占会话，外包给临时单元）：
#   systemd-run --user --unit=dsh-qq-restart-idle --collect \
#     deploy/restart-when-idle.sh [最长等待分钟=180] [重启日志路径=/tmp/dsh-qq-bot-restart.log]
#
# 判定"在跑"：某会话日志**最近 15 分钟内有更新**，且它最后一条 turn 边界是 `turn/start`。
set -u -o pipefail

MAXMIN="${1:-180}"
LOG="${2:-/tmp/dsh-qq-bot-restart.log}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS="$HOME/.dsh/sessions"
WAIT_LOG="${LOG%.log}-wait.log"

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >>"$WAIT_LOG"; }

: >"$WAIT_LOG"
log "=== 等待所有会话空闲（最多 ${MAXMIN} 分钟）==="

running() {
	# 输出仍在跑的会话 id（可能为空）
	if [ ! -d "$SESSIONS" ]; then return 0; fi
	# 只看最近 15 分钟内动过的日志：跑着的会话一定在持续写
	while IFS= read -r file; do
		[ -n "$file" ] || continue
		last="$(zstd -dc "$file" 2>/dev/null | grep -oE '"type":"turn/(start|end)"' | tail -1 || true)"
		if [ "$last" = '"type":"turn/end"' ] || [ -z "$last" ]; then continue; fi
		basename "$(dirname "$file")"
	done < <(find "$SESSIONS" -maxdepth 3 -name 'session.v4.jsonl.zstd' -mmin -15 2>/dev/null)
}

deadline=$(( $(date +%s) + MAXMIN * 60 ))
while :; do
	busy="$(running | tr '\n' ' ')"
	if [ -z "${busy// /}" ]; then
		log "所有会话都空闲了 → 开始重启"
		break
	fi
	if [ "$(date +%s)" -ge "$deadline" ]; then
		log "等超时（还在跑：${busy}）→ **放弃重启**，什么都不做"
		exit 1
	fi
	log "还在跑：${busy}（20 秒后再看）"
	sleep 20
done

exec "$ROOT/deploy/restart-and-verify.sh" "$LOG"
