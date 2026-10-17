//go:build !windows

package bridge

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestWindowsCrossBuild 是「理论 Windows 兼容」的编译阀门。
//
// 用 GOOS=windows 把整个模块编译一遍：任何只存在于 POSIX 的符号
// （syscall.Stat_t、os.Getuid 之类）都会在这里立刻暴露，
// 而不是等真机才发现编不过。`-short` 时跳过（交叉编译要几秒）。
func TestWindowsCrossBuild(t *testing.T) {
	if testing.Short() {
		t.Skip("交叉编译较慢，-short 跳过")
	}
	goTool, err := exec.LookPath("go")
	if err != nil {
		t.Skipf("找不到 go 工具链：%v", err)
	}
	// 测试的工作目录是 internal/bridge，模块根在上两级。
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	for _, goarch := range []string{"amd64", "arm64"} {
		t.Run("windows/"+goarch, func(t *testing.T) {
			cmd := exec.Command(goTool, "build", "-o", t.TempDir()+string(filepath.Separator), "./...")
			cmd.Dir = root
			cmd.Env = append(os.Environ(), "GOOS=windows", "GOARCH="+goarch, "CGO_ENABLED=0")
			if output, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("GOOS=windows GOARCH=%s 编译失败：%v\n%s", goarch, err, output)
			}
		})
	}
}
