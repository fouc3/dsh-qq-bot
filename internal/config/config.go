// Package config 负责加载与校验 dsh-qq-bot 的配置文件。
//
// 三条与既有项目保持一致的约定：
//   - 未知键名直接失败（KnownFields），拼错键不会被静默忽略；
//   - 字符串值里的 ${VAR} 在加载期展开，**引用了未设置的变量即报错**；
//   - 密钥与令牌永不进入日志，Summary 只报告"是否已设置"。
package config

import (
	"bytes"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"

	"github.com/fouc3/dsh-qq-bot/internal/bridge"
	"gopkg.in/yaml.v3"
)

// 接口地址约定（与 QQ-Group-Management-Bot 一致）：base_url > sandbox > SDK 默认。
const (
	// ProductionBaseURL 是官方生产地址（SDK 默认值，留空即用它）。
	ProductionBaseURL = "https://api.bot.qq.com"
	// SandboxBaseURL 是沙箱请求地址。
	SandboxBaseURL = "https://sandbox.api.sgroup.qq.com"
)

// DefaultPath 是未指定 -config 时的默认配置路径。
const DefaultPath = "config.yaml"

const (
	// MaxUploadBytesHardLimit 是平台对单个富媒体文件的硬上限（200MB）。
	MaxUploadBytesHardLimit = 200 << 20
	// PanelRemarkMaxRunes 是指令面板备注的字符上限（平台限制）。
	PanelRemarkMaxRunes = 255
	// DefaultPanelRemark 是定位面板用的默认备注。
	DefaultPanelRemark = "DSH-QQ-BOT 指令面板"
)

// LogLevels 与 LogFormats 是允许的取值。
var (
	LogLevels  = []string{"debug", "info", "warn", "error"}
	LogFormats = []string{"text", "json"}
)

// Config 是整份配置。
type Config struct {
	QQ        QQ        `yaml:"qq"`
	Bridge    Bridge    `yaml:"bridge"`
	Whitelist Whitelist `yaml:"whitelist"`
	Panel     Panel     `yaml:"panel"`
	Media     Media     `yaml:"media"`
	Log       Log       `yaml:"log"`

	// path 记录实际加载的文件路径，仅供 Summary 显示。
	path string
}

// QQ 是 QQ 开放平台凭据与地址。
type QQ struct {
	AppID        string `yaml:"appid"`
	ClientSecret string `yaml:"client_secret"`
	AccessToken  string `yaml:"access_token"`
	BaseURL      string `yaml:"base_url"`
	Sandbox      bool   `yaml:"sandbox"`
}

// Bridge 是与 dsh 插件之间的本地通道。
type Bridge struct {
	// Socket 是通道地址：POSIX 写 socket 路径（可带 ~），Windows 写 pipe:名字。
	Socket string `yaml:"socket"`
	// Token 非空时要求握手帧；命名管道（Windows）上没有 socket 权限位可依，必须设置。
	Token               string `yaml:"token"`
	DialTimeoutSeconds  int    `yaml:"dial_timeout_seconds"`
	PollWaitSeconds     int    `yaml:"poll_wait_seconds"`
	ReconnectMaxSeconds int    `yaml:"reconnect_max_seconds"`
}

// Whitelist 是允许控制 bot 的 QQ 私聊名单。
type Whitelist struct {
	Users []WhitelistUser `yaml:"users"`
}

// WhitelistUser 是白名单里的一个私聊。
type WhitelistUser struct {
	OpenID string `yaml:"openid"`
	Note   string `yaml:"note"`
	Panel  bool   `yaml:"panel"`
}

// Panel 是指令面板与自定义菜单的开关。
// 用指针区分"没写"与"写了 false"：默认都是启用。
type Panel struct {
	Enabled     *bool  `yaml:"enabled"`
	Remark      string `yaml:"remark"`
	MenuEnabled *bool  `yaml:"menu_enabled"`
}

// Media 是富媒体发送策略。
type Media struct {
	AllowedRoots      []string `yaml:"allowed_roots"`
	MaxUploadBytes    int64    `yaml:"max_upload_bytes"`
	UploadConcurrency int      `yaml:"upload_concurrency"`
}

// Log 是日志设置。
type Log struct {
	Level  string `yaml:"level"`
	Format string `yaml:"format"`
}

// Load 读取、展开环境变量、填默认值并校验配置。
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取配置 %s：%w", path, err)
	}

	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)

	cfg := &Config{}
	if err := dec.Decode(cfg); err != nil {
		return nil, fmt.Errorf("解析配置 %s：%w", path, err)
	}
	cfg.path = path

	if err := expandEnvRefs(cfg); err != nil {
		return nil, err
	}
	cfg.applyDefaults()
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("配置 %s 不合法：%w", path, err)
	}
	return cfg, nil
}

// applyDefaults 只在字段为空时填默认值，不覆盖显式配置。
func (c *Config) applyDefaults() {
	if c.Log.Level == "" {
		c.Log.Level = "info"
	}
	if c.Log.Format == "" {
		c.Log.Format = "text"
	}
	if c.Bridge.DialTimeoutSeconds == 0 {
		c.Bridge.DialTimeoutSeconds = 10
	}
	if c.Bridge.PollWaitSeconds == 0 {
		c.Bridge.PollWaitSeconds = 25
	}
	if c.Bridge.ReconnectMaxSeconds == 0 {
		c.Bridge.ReconnectMaxSeconds = 30
	}
	if c.Panel.Remark == "" {
		c.Panel.Remark = DefaultPanelRemark
	}
	if c.Media.MaxUploadBytes == 0 {
		c.Media.MaxUploadBytes = MaxUploadBytesHardLimit
	}
}

// Validate 做结构与取值校验（凭据缺失不算错，只有"填了一半"才算）。
func (c *Config) Validate() error {
	if strings.TrimSpace(c.Bridge.Socket) == "" {
		return errors.New("bridge.socket 不能为空（必须与 dsh 插件的 socketPath 一致）")
	}
	// 通道地址：POSIX 写路径，Windows 写 pipe:名字（命名管道）。
	endpoint, err := bridge.ParseEndpoint(c.Bridge.Socket)
	if err != nil {
		return fmt.Errorf("bridge.socket 不合法：%w", err)
	}
	if endpoint.IsPipe() {
		if runtime.GOOS != "windows" {
			return fmt.Errorf(
				"bridge.socket 配的是命名管道（%s），但命名管道只在 Windows 上可用；"+
					"本机请写 UNIX domain socket 路径（如 ~/.dsh/dsh-qq-bot/bridge.sock）", endpoint)
		}
		if strings.TrimSpace(c.Bridge.Token) == "" {
			return errors.New("bridge.socket 用的是命名管道：Windows 上没有 socket 权限位可依赖，" +
				"bridge.token 必须设置（并与插件侧 token 一致），否则任何本机进程都能连上通道")
		}
	}
	if c.Bridge.DialTimeoutSeconds < 1 {
		return fmt.Errorf("bridge.dial_timeout_seconds 必须 ≥1，当前 %d", c.Bridge.DialTimeoutSeconds)
	}
	if c.Bridge.PollWaitSeconds < 1 || c.Bridge.PollWaitSeconds > 300 {
		return fmt.Errorf("bridge.poll_wait_seconds 必须在 1..300 之间，当前 %d", c.Bridge.PollWaitSeconds)
	}
	if c.Bridge.ReconnectMaxSeconds < 1 {
		return fmt.Errorf("bridge.reconnect_max_seconds 必须 ≥1，当前 %d", c.Bridge.ReconnectMaxSeconds)
	}

	if (c.QQ.AppID == "") != (c.QQ.ClientSecret == "") {
		return errors.New("qq.appid 与 qq.client_secret 必须成对设置（或改用 qq.access_token）")
	}
	if c.QQ.BaseURL != "" {
		u, err := url.Parse(c.QQ.BaseURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return fmt.Errorf("qq.base_url 必须是 http(s) 绝对地址，当前 %q", c.QQ.BaseURL)
		}
	}

	seen := make(map[string]struct{}, len(c.Whitelist.Users))
	for i, u := range c.Whitelist.Users {
		if strings.TrimSpace(u.OpenID) == "" {
			return fmt.Errorf("whitelist.users[%d].openid 不能为空", i)
		}
		if _, dup := seen[u.OpenID]; dup {
			return fmt.Errorf("whitelist.users[%d].openid 重复：%s", i, u.OpenID)
		}
		seen[u.OpenID] = struct{}{}
	}

	if n := len([]rune(c.Panel.Remark)); n > PanelRemarkMaxRunes {
		return fmt.Errorf("panel.remark 不能超过 %d 个字符（当前 %d）", PanelRemarkMaxRunes, n)
	}

	if c.Media.MaxUploadBytes <= 0 || c.Media.MaxUploadBytes > MaxUploadBytesHardLimit {
		return fmt.Errorf("media.max_upload_bytes 必须在 1..%d 之间，当前 %d", MaxUploadBytesHardLimit, c.Media.MaxUploadBytes)
	}
	if c.Media.UploadConcurrency < 0 {
		return fmt.Errorf("media.upload_concurrency 不能为负，当前 %d", c.Media.UploadConcurrency)
	}

	if !contains(LogLevels, c.Log.Level) {
		return fmt.Errorf("log.level 必须是 %s 之一，当前 %q", strings.Join(LogLevels, "/"), c.Log.Level)
	}
	if !contains(LogFormats, c.Log.Format) {
		return fmt.Errorf("log.format 必须是 %s 之一，当前 %q", strings.Join(LogFormats, "/"), c.Log.Format)
	}
	return nil
}

// CredentialsConfigured 报告是否配置了凭据（供启动期检查，不在 Validate 里强制）。
func (c *Config) CredentialsConfigured() bool {
	return c.QQ.AccessToken != "" || (c.QQ.AppID != "" && c.QQ.ClientSecret != "")
}

// ResolvedBaseURL 返回实际使用的接口地址：base_url 优先，其次 sandbox，最后空串（= SDK 默认）。
func (c *Config) ResolvedBaseURL() string {
	if c.QQ.BaseURL != "" {
		return c.QQ.BaseURL
	}
	if c.QQ.Sandbox {
		return SandboxBaseURL
	}
	return ""
}

// Allowed 报告某个 openid 是否在白名单里。
func (c *Config) Allowed(openid string) bool {
	for _, u := range c.Whitelist.Users {
		if u.OpenID == openid {
			return true
		}
	}
	return false
}

// PanelOpenIDs 返回要绑定指令面板的私聊 openid（按配置顺序）。
func (c *Config) PanelOpenIDs() []string {
	out := make([]string, 0, len(c.Whitelist.Users))
	for _, u := range c.Whitelist.Users {
		if u.Panel {
			out = append(out, u.OpenID)
		}
	}
	return out
}

// IsPanelEnabled 报告指令面板是否启用（缺省启用）。
func (c *Config) IsPanelEnabled() bool { return c.Panel.Enabled == nil || *c.Panel.Enabled }

// IsMenuEnabled 报告自定义菜单是否启用（缺省启用）。
func (c *Config) IsMenuEnabled() bool { return c.Panel.MenuEnabled == nil || *c.Panel.MenuEnabled }

// SocketPath 返回本地通道地址。
//
// 支持两种写法（解析见 internal/bridge 的 ParseEndpoint）：
//
//	/run/dsh/bridge.sock   或   unix:/run/dsh/bridge.sock   POSIX 的 UNIX domain socket
//	pipe:名字                                                Windows 的命名管道（＝\\.\pipe\名字）
//
// 不带方案前缀的路径会展开 ~ 并转成绝对路径；带前缀的原样返回——
// `pipe:名字` 绝不能被 filepath.Abs 变成 `/当前目录/pipe:名字`。
func (c *Config) SocketPath() string {
	raw := strings.TrimSpace(c.Bridge.Socket)
	if raw == "" {
		return ""
	}
	endpoint, err := bridge.ParseEndpoint(raw)
	if err != nil {
		// 解析失败时原样交给调用方：报错统一在启动阶段给。
		return raw
	}
	if endpoint.IsPipe() {
		return endpoint.String()
	}
	p := endpoint.Address
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			p = filepath.Join(home, strings.TrimPrefix(strings.TrimPrefix(p, "~"), "/"))
		}
	}
	if abs, err := filepath.Abs(p); err == nil {
		return abs
	}
	return p
}

// Path 返回实际加载的配置文件路径。
func (c *Config) Path() string { return c.path }

// Summary 返回可安全写入日志/终端的配置摘要：只报告密钥是否已设置，并遮蔽 openid。
func (c *Config) Summary() string {
	var b strings.Builder
	fmt.Fprintf(&b, "配置摘要（%s）\n", c.Path())

	if c.QQ.AccessToken != "" {
		fmt.Fprintf(&b, "  QQ 凭据        : access_token 已设置\n")
	} else if c.CredentialsConfigured() {
		fmt.Fprintf(&b, "  QQ 凭据        : appid 已设置 / client_secret 已设置\n")
	} else {
		fmt.Fprintf(&b, "  QQ 凭据        : 未设置（启动前请填 qq.appid+qq.client_secret 或 qq.access_token）\n")
	}
	if c.QQ.BaseURL != "" {
		fmt.Fprintf(&b, "  QQ 接口        : %s\n", c.QQ.BaseURL)
	} else if c.QQ.Sandbox {
		fmt.Fprintf(&b, "  QQ 接口        : 沙箱\n")
	} else {
		fmt.Fprintf(&b, "  QQ 接口        : 官方默认\n")
	}

	tokenState := "未设置（仅靠 socket 权限）"
	channelKind := "UNIX socket"
	if endpoint, err := bridge.ParseEndpoint(c.SocketPath()); err == nil && endpoint.IsPipe() {
		channelKind = "命名管道"
		if c.Bridge.Token == "" {
			// 命名管道没有权限位，token 是唯一认证：这里如实提示，别让人误以为安全。
			tokenState = "未设置（⚠️ 命名管道必须设置 token）"
		}
	}
	if c.Bridge.Token != "" {
		tokenState = "已设置"
	}
	fmt.Fprintf(&b, "  本地通道       : %s（%s，token %s）\n", c.SocketPath(), channelKind, tokenState)
	fmt.Fprintf(&b, "  通道超时       : dial=%ds poll=%ds reconnect_max=%ds\n",
		c.Bridge.DialTimeoutSeconds, c.Bridge.PollWaitSeconds, c.Bridge.ReconnectMaxSeconds)

	panelBound := len(c.PanelOpenIDs())
	fmt.Fprintf(&b, "  白名单         : %d 个私聊（其中 %d 个绑定指令面板）\n", len(c.Whitelist.Users), panelBound)
	for _, u := range c.Whitelist.Users {
		note := u.Note
		if note == "" {
			note = "-"
		}
		fmt.Fprintf(&b, "    - %s  note=%s panel=%t\n", maskOpenID(u.OpenID), note, u.Panel)
	}

	fmt.Fprintf(&b, "  指令面板       : %s（remark=%q）\n", enabledText(c.IsPanelEnabled()), c.Panel.Remark)
	fmt.Fprintf(&b, "  自定义菜单     : %s\n", enabledText(c.IsMenuEnabled()))

	roots := "不限制"
	if len(c.Media.AllowedRoots) > 0 {
		roots = strings.Join(c.Media.AllowedRoots, ", ")
	}
	conc := "平台默认"
	if c.Media.UploadConcurrency > 0 {
		conc = fmt.Sprintf("%d", c.Media.UploadConcurrency)
	}
	fmt.Fprintf(&b, "  富媒体         : max=%d bytes, roots=%s, concurrency=%s\n", c.Media.MaxUploadBytes, roots, conc)
	fmt.Fprintf(&b, "  日志           : level=%s format=%s\n", c.Log.Level, c.Log.Format)
	return b.String()
}

func enabledText(v bool) string {
	if v {
		return "启用"
	}
	return "停用"
}

// maskOpenID 只保留前 6 个字符，避免日志里出现完整 openid。
func maskOpenID(s string) string {
	r := []rune(s)
	if len(r) <= 6 {
		return string(r) + "…"
	}
	return string(r[:6]) + "…"
}

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

// envRef 匹配 ${NAME}（只接受 POSIX 变量名形态）。
var envRef = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

// expandEnvRefs 遍历配置里的所有字符串字段，展开 ${VAR}。
func expandEnvRefs(cfg *Config) error {
	return expandValue(reflect.ValueOf(cfg).Elem())
}

func expandValue(rv reflect.Value) error {
	switch rv.Kind() {
	case reflect.Struct:
		t := rv.Type()
		for i := 0; i < rv.NumField(); i++ {
			if !t.Field(i).IsExported() {
				continue
			}
			if err := expandValue(rv.Field(i)); err != nil {
				return err
			}
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < rv.Len(); i++ {
			if err := expandValue(rv.Index(i)); err != nil {
				return err
			}
		}
	case reflect.Pointer:
		if rv.IsNil() {
			return nil
		}
		return expandValue(rv.Elem())
	case reflect.String:
		s, err := expandString(rv.String())
		if err != nil {
			return err
		}
		if rv.CanSet() {
			rv.SetString(s)
		}
	case reflect.Bool, reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Float32, reflect.Float64:
		// 非字符串字段无需展开
	case reflect.Map, reflect.Interface, reflect.Chan, reflect.Func:
		return fmt.Errorf("config: 出现未支持的字段类型 %s（${ENV} 展开不会覆盖它）", rv.Type())
	default:
		return fmt.Errorf("config: 出现未支持的字段类型 %s", rv.Type())
	}
	return nil
}

// expandString 展开单个字符串；引用未设置的变量是错误，而不是空串。
func expandString(s string) (string, error) {
	if !strings.Contains(s, "${") {
		return s, nil
	}
	var firstErr error
	out := envRef.ReplaceAllStringFunc(s, func(match string) string {
		name := envRef.FindStringSubmatch(match)[1]
		val, ok := os.LookupEnv(name)
		if !ok {
			if firstErr == nil {
				firstErr = fmt.Errorf("config: 引用了未设置的环境变量 %s（写 ${%s} 就必须设置它；不用环境变量时请留空字符串）", name, name)
			}
			return match
		}
		return val
	})
	return out, firstErr
}
