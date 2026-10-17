package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDedupePath 覆盖去重文件落点：
// UNIX socket 沿用「socket 同目录」（现有部署行为不变），
// 命名管道没有目录可用，改放 ~/.dsh/dsh-qq-bot/（与插件侧 state.json 同处）。
func TestDedupePath(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("读不到 home：%v", err)
	}

	got := dedupePath("/run/dsh/bridge.sock")
	if want := filepath.Join("/run/dsh", "qqbot-seen.json"); got != want {
		t.Fatalf("UNIX socket 的去重文件应在 socket 同目录：得到 %q，期望 %q", got, want)
	}

	got = dedupePath("pipe:dsh-qq-bot-bridge")
	if want := filepath.Join(home, ".dsh", "dsh-qq-bot", "qqbot-seen.json"); got != want {
		t.Fatalf("命名管道的去重文件应在 ~/.dsh/dsh-qq-bot/：得到 %q，期望 %q", got, want)
	}
	if strings.Contains(got, `\\.\pipe`) {
		t.Fatalf("命名管道的地址不能当目录用：%q", got)
	}
}
