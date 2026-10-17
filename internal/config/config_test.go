package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// examplePath 指向仓库根目录的示例配置（本包位于 internal/config）。
const examplePath = "../../config.example.yaml"

func TestLoadExampleConfig(t *testing.T) {
	// 示例配置必须能在"不设置任何环境变量"的前提下加载成功，
	// 否则运维照着模板抄一份就会启动失败。
	cfg, err := Load(examplePath)
	if err != nil {
		t.Fatalf("加载示例配置失败：%v", err)
	}
	if cfg.Path() != examplePath {
		t.Errorf("Path() = %q，期望 %q", cfg.Path(), examplePath)
	}
	if cfg.Log.Level != "info" || cfg.Log.Format != "text" {
		t.Errorf("日志默认值不对：%+v", cfg.Log)
	}
	if cfg.Bridge.DialTimeoutSeconds != 10 || cfg.Bridge.PollWaitSeconds != 25 || cfg.Bridge.ReconnectMaxSeconds != 30 {
		t.Errorf("bridge 超时默认值不对：%+v", cfg.Bridge)
	}
	if cfg.Media.MaxUploadBytes != MaxUploadBytesHardLimit {
		t.Errorf("media 上限默认值不对：%d", cfg.Media.MaxUploadBytes)
	}
	if !cfg.IsPanelEnabled() || !cfg.IsMenuEnabled() {
		t.Error("面板/菜单缺省应启用")
	}
	if cfg.Panel.Remark != DefaultPanelRemark {
		t.Errorf("remark 默认值不对：%q", cfg.Panel.Remark)
	}
	if cfg.CredentialsConfigured() {
		t.Error("示例配置不应自带凭据")
	}
	if !strings.HasSuffix(cfg.SocketPath(), "/.dsh/dsh-qq-bot/bridge.sock") {
		t.Errorf("socket 路径展开不对：%q", cfg.SocketPath())
	}
	if filepath.IsAbs(cfg.SocketPath()) == false {
		t.Errorf("socket 路径应为绝对路径：%q", cfg.SocketPath())
	}
}

func TestUnknownKeyFails(t *testing.T) {
	path := writeTemp(t, `
qq:
  appdid: "typo"
`)
	_, err := Load(path)
	if err == nil {
		t.Fatal("拼错的键名应当加载失败")
	}
	if !strings.Contains(err.Error(), "appdid") {
		t.Errorf("错误信息应指出拼错的键名，实际：%v", err)
	}
}

func TestEnvExpansion(t *testing.T) {
	t.Setenv("DSHQQ_TEST_SOCKET", "/tmp/x/bridge.sock")
	path := writeTemp(t, `
bridge:
  socket: "${DSHQQ_TEST_SOCKET}"
qq:
  access_token: "${DSHQQ_TEST_TOKEN}"
`)
	// 引用了未设置的变量：必须报错，而不是当成空串
	if _, err := Load(path); err == nil || !strings.Contains(err.Error(), "DSHQQ_TEST_TOKEN") {
		t.Fatalf("未设置的环境变量应当报错，实际：%v", err)
	}

	t.Setenv("DSHQQ_TEST_TOKEN", "tok-123")
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("环境变量齐备后应加载成功：%v", err)
	}
	if cfg.Bridge.Socket != "/tmp/x/bridge.sock" {
		t.Errorf("socket 未展开：%q", cfg.Bridge.Socket)
	}
	if cfg.QQ.AccessToken != "tok-123" {
		t.Errorf("token 未展开：%q", cfg.QQ.AccessToken)
	}
}

func TestEnvExpansionSkipsComments(t *testing.T) {
	// 注释里的 ${未设置变量} 不应该让加载失败（按值展开，而不是按文本展开）。
	path := writeTemp(t, `
# 这一行的 ${NOT_SET_ANYWHERE} 只是注释
bridge:
  socket: "/tmp/y/bridge.sock"
`)
	if _, err := Load(path); err != nil {
		t.Fatalf("注释里的 ${} 不应影响加载：%v", err)
	}
}

func TestValidateRejectsBadValues(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"空 socket", "bridge:\n  socket: \"\"\n", "bridge.socket"},
		{"凭据只填一半", "bridge:\n  socket: \"/tmp/a.sock\"\nqq:\n  appid: \"1\"\n", "成对设置"},
		{"日志级别非法", "bridge:\n  socket: \"/tmp/a.sock\"\nlog:\n  level: \"verbose\"\n", "log.level"},
		{"日志格式非法", "bridge:\n  socket: \"/tmp/a.sock\"\nlog:\n  format: \"xml\"\n", "log.format"},
		{"白名单缺 openid", "bridge:\n  socket: \"/tmp/a.sock\"\nwhitelist:\n  users:\n    - note: \"x\"\n", "openid 不能为空"},
		{"白名单重复", "bridge:\n  socket: \"/tmp/a.sock\"\nwhitelist:\n  users:\n    - openid: \"A\"\n    - openid: \"A\"\n", "重复"},
		{"富媒体上限越界", "bridge:\n  socket: \"/tmp/a.sock\"\nmedia:\n  max_upload_bytes: 999999999999\n", "media.max_upload_bytes"},
		{"base_url 非法", "bridge:\n  socket: \"/tmp/a.sock\"\nqq:\n  base_url: \"ftp://x\"\n", "qq.base_url"},
		{"轮询等待越界", "bridge:\n  socket: \"/tmp/a.sock\"\n  poll_wait_seconds: 9999\n", "poll_wait_seconds"},
		{"通道地址缺管道名", "bridge:\n  socket: \"pipe:\"\n", "缺少管道名"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load(writeTemp(t, tc.body))
			if err == nil {
				t.Fatalf("应当报错")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("错误信息应包含 %q，实际：%v", tc.want, err)
			}
		})
	}
}

func TestWhitelistHelpers(t *testing.T) {
	path := writeTemp(t, `
bridge:
  socket: "/tmp/a.sock"
whitelist:
  users:
    - openid: "OPENID-A"
      note: "运维者"
      panel: true
    - openid: "OPENID-B"
`)
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Allowed("OPENID-A") || !cfg.Allowed("OPENID-B") {
		t.Error("白名单内用户应被放行")
	}
	if cfg.Allowed("OPENID-C") || cfg.Allowed("") {
		t.Error("白名单外用户不应被放行")
	}
	got := cfg.PanelOpenIDs()
	if len(got) != 1 || got[0] != "OPENID-A" {
		t.Errorf("面板绑定名单不对：%v", got)
	}
}

func TestSummaryNeverLeaksSecrets(t *testing.T) {
	path := writeTemp(t, `
qq:
  appid: "1234567890"
  client_secret: "SECRET-MUST-NOT-APPEAR"
bridge:
  socket: "/tmp/a.sock"
  token: "TOKEN-MUST-NOT-APPEAR"
whitelist:
  users:
    - openid: "OPENID-MUST-GO-HIDDEN"
      panel: true
`)
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	summary := cfg.Summary()
	for _, secret := range []string{"SECRET-MUST-NOT-APPEAR", "TOKEN-MUST-NOT-APPEAR", "OPENID-MUST-GO-HIDDEN"} {
		if strings.Contains(summary, secret) {
			t.Errorf("摘要泄露了 %s：\n%s", secret, summary)
		}
	}
	if !strings.Contains(summary, "已设置") {
		t.Errorf("摘要应报告密钥已设置：\n%s", summary)
	}
}

func writeTemp(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestSocketPathSchemes 确认带方案的地址不会被 filepath.Abs 搅成相对路径。
func TestSocketPathSchemes(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"管道原样保留", "pipe:dsh-qq-bot-bridge", "pipe:dsh-qq-bot-bridge"},
		{"unix 方案去掉前缀", "unix:/tmp/x/bridge.sock", "/tmp/x/bridge.sock"},
		{"裸路径照旧转绝对", "/tmp/y/bridge.sock", "/tmp/y/bridge.sock"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &Config{Bridge: Bridge{Socket: tc.raw}}
			if got := cfg.SocketPath(); got != tc.want {
				t.Fatalf("SocketPath() = %q，期望 %q", got, tc.want)
			}
		})
	}
}

// TestValidatePipeChannel 覆盖命名管道的两条启动期检查：
// 非 Windows 上直接拒绝；Windows 上必须配 token（那边没有 socket 权限位可依）。
func TestValidatePipeChannel(t *testing.T) {
	base := func(token string) *Config {
		cfg := &Config{Bridge: Bridge{Socket: "pipe:demo", Token: token}}
		cfg.applyDefaults()
		return cfg
	}
	if runtime.GOOS == "windows" {
		if err := base("tk").Validate(); err != nil {
			t.Fatalf("Windows 上带 token 的管道配置不该报错：%v", err)
		}
		err := base("").Validate()
		if err == nil || !strings.Contains(err.Error(), "bridge.token 必须设置") {
			t.Fatalf("Windows 上缺 token 应当报错，实际：%v", err)
		}
		return
	}
	err := base("tk").Validate()
	if err == nil || !strings.Contains(err.Error(), "只在 Windows 上可用") {
		t.Fatalf("非 Windows 上配管道应当报错，实际：%v", err)
	}
}
