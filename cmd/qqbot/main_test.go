package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fouc3/dsh-qq-bot/internal/qq"
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

// TestMenuHasDshCommands 覆盖"菜单里是否已带上 dsh 命令子菜单"的判定：
// 判据是"存在一个二级菜单，且子项 sendMessage 以 / 开头"。
// 桥自己的「管理」二级菜单子项是普通命令名（没有 /），不能误判成 dsh 命令。
func TestMenuHasDshCommands(t *testing.T) {
	// 只有桥命令 + 「管理」二级菜单：还没有 dsh 命令 → false
	withoutDsh := []qq.MenuItem{
		{Name: "切换会话", SendMessage: "切换会话"},
		{Name: "管理", Type: "menu", Children: []qq.MenuItem{
			{Name: "停止", SendMessage: "停止"},
			{Name: "归档", SendMessage: "归档"},
		}},
	}
	if menuHasDshCommands(withoutDsh) {
		t.Fatalf("没有以 / 开头的子项时不该判定为已有 dsh 命令")
	}

	// 多了一组 dsh 命令二级菜单（子项是 /compact 这类斜杠命令）→ true
	withDsh := append(withoutDsh, qq.MenuItem{
		Name: "dsh 命令1", Type: "menu", Children: []qq.MenuItem{
			{Name: "compact", SendMessage: "/compact"},
			{Name: "model", SendMessage: "/model"},
		},
	})
	if !menuHasDshCommands(withDsh) {
		t.Fatalf("有 / 开头子项的二级菜单时应判定为已有 dsh 命令")
	}

	if menuHasDshCommands(nil) {
		t.Fatalf("空菜单不该判定为已有 dsh 命令")
	}
}
