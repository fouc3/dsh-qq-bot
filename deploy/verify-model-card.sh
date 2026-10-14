#!/usr/bin/env bash
# 重启后的真机验证：等通道回来 → 注入模型卡片探针 → 把网关日志里的结果整理成一段报告。
#
# 为什么要单独一个脚本/临时守护进程：这一步要"等"，而等不该占着会话。
# 用法（外包给临时单元，立刻返回）：
#   systemd-run --user --unit=dsh-qq-verify-model --collect \
#     deploy/verify-model-card.sh /tmp/dsh-qq-bot-verify.log
# 之后读 /tmp/dsh-qq-bot-verify.log 即可（结尾有 "=== 验证完成 ==="）。
#
# 判读方法：网关只在**失败**时打 WARN（"出站命令执行失败"）。所以
#   - 没有 WARN → 这几张卡片（含长 label 按钮）平台都收下了；
#   - 有 WARN → 里面带 QQ 的 err_code，按码判断是 label 还是别的问题。
set -u -o pipefail

LOG="${1:-/tmp/dsh-qq-bot-verify.log}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export SOCKET="$HOME/.dsh/dsh-qq-bot/bridge.sock"

log() { printf '%s %s\n' "$(date '+%H:%M:%S')" "$*" >>"$LOG"; }

: >"$LOG"
log "=== 模型卡片真机验证开始（脚本 $ROOT/deploy/verify-model-card.sh）==="

# 1) 等通道回来（重启后 socket 会短暂消失）
for _ in $(seq 1 120); do
	if [ -S "$SOCKET" ]; then break; fi
	sleep 1
done
if [ ! -S "$SOCKET" ]; then
	log "!! 120 秒内没等到通道，放弃"
	exit 1
fi
log "通道已就绪"

# 2) openid 从网关配置里取（白名单里第一个；**必须跳过注释行** —— 模板注释里的
#    `#     - openid: "<日志里的 openid>"` 会先被 grep 命中，这里踩过一次：探针打在一个
#    假 openid 上，事件被插件当"非白名单"丢掉，于是"零失败"变成了空转）
OPENID="$(grep -vE '^[[:space:]]*#' "$ROOT/config.yaml" | grep -m1 -oE 'openid:[[:space:]]*"[^"]+"' | sed -E 's/.*"([^"]+)".*/\1/')"
if ! printf '%s' "$OPENID" | grep -qE '^[A-Za-z0-9_-]{16,}$'; then
	log "!! 从 config.yaml 取到的 openid 不像 openid（长度 ${#OPENID}）：$OPENID"
	log "!! 中止：探针必须打在真白名单账号上，否则事件会被插件丢掉、验证等于空转"
	exit 1
fi
log "探针目标：openid ${OPENID:0:6}…（省略）"

# 3) 记录起始时间，之后只筛这段时间的网关日志
START="$(date '+%Y-%m-%d %H:%M:%S')"
sleep 1

# 4) 注入探针（真发几张卡片到 QQ；不改变任何会话的模型）
log "--- 探针输出 ---"
node "$ROOT/deploy/probe-model-card.mjs" --openid "$OPENID" >>"$LOG" 2>&1
probe_status=$?
log "探针退出码：$probe_status"

# 5) 等网关把出站队列跑完，再收日志
sleep 12
log "--- 网关日志（$START 之后，只看发送/互动相关的行）---"
journalctl --user -u dsh-qq-bot --since "$START" --no-pager 2>/dev/null \
	| grep -E "出站命令执行失败|出站命令缺少 id|互动|interaction|发送失败|降级|主动消息|panic" \
	>>"$LOG" 2>&1
failures="$(journalctl --user -u dsh-qq-bot --since "$START" --no-pager 2>/dev/null | grep -c "出站命令执行失败" || true)"
log "出站命令执行失败次数：$failures"
log "（探针自己的正向证据在上面「探针输出」里：必须同时看到 pendingModel 写入/清除 与 lastCard 拿到 messageId）"

if [ "$failures" = "0" ] && [ "$probe_status" = "0" ]; then
	log "结论：这几张卡片（含 >10 显示宽度的 label）平台都收下了 → 我们自己设的宽度上限可以继续放宽"
else
	log "结论：有失败，按上面的 err_code 判断（40034xxx 里 label 相关才是 label 问题）"
fi

log "=== 验证完成 ==="
