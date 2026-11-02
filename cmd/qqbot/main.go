// Command qqbot 是 DSH-QQ-Bot 的 QQ 侧网关：
// 用 qq-bot-sdk 收发 QQ 私聊消息，通过 UNIX domain socket 与 dsh 插件对话。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/fouc3/dsh-qq-bot/internal/bridge"
	"github.com/fouc3/dsh-qq-bot/internal/config"
	"github.com/fouc3/dsh-qq-bot/internal/executor"
	"github.com/fouc3/dsh-qq-bot/internal/logging"
	"github.com/fouc3/dsh-qq-bot/internal/qq"
)

const (
	// bridgeRequestTimeout 是单次通道请求的读写超时。
	bridgeRequestTimeout = 60 * time.Second
	// eventForwardTimeout 限制"把 QQ 事件交给插件"这一跳的耗时：
	// 事件回调里绝不长等插件，否则会把 QQ 的事件分发拖慢。
	eventForwardTimeout = 10 * time.Second
	// shutdownTimeout 是停机时等待 SDK 收尾的时间。
	shutdownTimeout = 15 * time.Second
	// dedupeCapacity 是命令去重环的容量。
	dedupeCapacity = 512
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "qqbot: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		configPath  string
		checkConfig bool
		listPanels  bool
	)
	flag.StringVar(&configPath, "config", config.DefaultPath, "配置文件路径")
	flag.BoolVar(&checkConfig, "check-config", false, "只校验配置并打印摘要（不连 QQ、不连 dsh）")
	flag.BoolVar(&listPanels, "list-panels", false, "列出平台侧现有指令面板后退出（排查 remark 匹配与数量上限）")
	flag.Parse()

	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	logger, _, err := logging.New(logging.Options{Level: cfg.Log.Level, Format: cfg.Log.Format})
	if err != nil {
		return err
	}

	if checkConfig {
		fmt.Fprint(os.Stdout, cfg.Summary())
		return nil
	}
	if !cfg.CredentialsConfigured() {
		return errors.New("未配置 QQ 凭据：请在配置里填 qq.appid+qq.client_secret，或 qq.access_token")
	}
	slog.SetDefault(logger)

	sdkClient, err := qq.NewSDKClient(qq.Options{
		AppID:        cfg.QQ.AppID,
		ClientSecret: cfg.QQ.ClientSecret,
		AccessToken:  cfg.QQ.AccessToken,
		BaseURL:      cfg.ResolvedBaseURL(),
	})
	if err != nil {
		return err
	}
	qqClient := qq.New(sdkClient, logger)

	if listPanels {
		lines, err := qqClient.DescribePanels(context.Background())
		if err != nil {
			return err
		}
		if len(lines) == 0 {
			fmt.Println("平台侧没有 c2c 指令面板")
			return nil
		}
		for _, line := range lines {
			fmt.Println(line)
		}
		return nil
	}

	socketPath := cfg.SocketPath()
	dedupe, err := executor.OpenDedupe(dedupePath(socketPath), dedupeCapacity)
	if err != nil {
		return err
	}

	channel := bridge.New(socketPath, bridge.Options{
		Token:          cfg.Bridge.Token,
		DialTimeout:    time.Duration(cfg.Bridge.DialTimeoutSeconds) * time.Second,
		RequestTimeout: bridgeRequestTimeout,
		PollWait:       time.Duration(cfg.Bridge.PollWaitSeconds) * time.Second,
	}, logger)

	exec := executor.New(qqClient, channel, dedupe, qq.MediaConfig{
		MaxUploadBytes:    cfg.Media.MaxUploadBytes,
		AllowedRoots:      cfg.Media.AllowedRoots,
		UploadConcurrency: cfg.Media.UploadConcurrency,
	}, logger)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// 插件在"某个会话的 agent 刚被加载"之后会发 `resync_panel`：这里把它接到同一个
	// ensureRegistered 上 —— 面板定义/remark/开关的权威都在 Go 侧，插件只请求同步。
	exec.SetResync(func(resyncCtx context.Context) error {
		_, err := ensureRegistered(resyncCtx, cfg, channel, exec, logger, false)
		return err
	})

	// 本地通道：注册 + 面板发布（重试到成功）+ outbox 长轮询。
	go bridgeLoop(ctx, cfg, channel, exec, logger)
	go panelResyncLoop(ctx, cfg, channel, exec, logger)

	// QQ 事件 → 本地通道。emit 里带独立超时，且用 WithoutCancel：
	// 停机取消不该让"正在投递的这条事件"半途消失，但也绝不能无限等。
	emit := func(eventCtx context.Context, ev qq.Event) error {
		callCtx, cancel := context.WithTimeout(context.WithoutCancel(eventCtx), eventForwardTimeout)
		defer cancel()
		return channel.Call(callCtx, "event", ev, nil)
	}
	regs := qq.RegisterHandlers(sdkClient, qqClient, cfg.Allowed, emit, logger)

	if err := qq.StartTransport(ctx, sdkClient); err != nil {
		for _, reg := range regs {
			reg.Cancel()
		}
		return err
	}
	logger.Info("QQ 网关已启动", "socket", socketPath, "whitelist", len(cfg.Whitelist.Users))

	<-ctx.Done()
	logger.Info("收到退出信号，正在停机")
	stopCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := sdkClient.Stop(stopCtx); err != nil {
		logger.Warn("停止 QQ 长连接失败", "err", err)
	}
	return nil
}

// dedupePath 决定命令去重环落哪个文件。
//
// 以前直接取 socket 的目录：UNIX socket 时代没问题，但命名管道（Windows）的
// 地址是 `\\.\pipe\名字`，目录 `\\.\pipe` 不是能写文件的地方。所以现在：
//   - UNIX socket → 仍放在 socket 同目录（现有部署行为不变）；
//   - 命名管道 → 放到 `~/.dsh/dsh-qq-bot/`（与插件侧 state.json 同一个目录）。
func dedupePath(channelAddress string) string {
	if endpoint, err := bridge.ParseEndpoint(channelAddress); err == nil && !endpoint.IsPipe() {
		return filepath.Join(filepath.Dir(endpoint.Address), "qqbot-seen.json")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "qqbot-seen.json"
	}
	return filepath.Join(home, ".dsh", "dsh-qq-bot", "qqbot-seen.json")
}

// bridgeLoop 维护与 dsh 插件的连接：
// 每次（重）连上前先 register + 发布面板，然后进入 outbox 长轮询。
func bridgeLoop(ctx context.Context, cfg *config.Config, channel *bridge.Client, exec *executor.Executor, logger *slog.Logger) {
	maxDelay := time.Duration(cfg.Bridge.ReconnectMaxSeconds) * time.Second
	delay := time.Second

	for ctx.Err() == nil {
		if _, err := ensureRegistered(ctx, cfg, channel, exec, logger, true); err != nil {
			if ctx.Err() != nil {
				return
			}
			logger.Warn("向 dsh 插件注册失败，稍后重试", "err", err, "delay", delay)
			if !sleepCtx(ctx, delay) {
				return
			}
			delay = minDuration(delay*2, maxDelay)
			continue
		}
		delay = time.Second

		err := channel.Poll(ctx, func(pollCtx context.Context, cmds []bridge.Command) error {
			exec.Run(pollCtx, cmds)
			return nil
		})
		if ctx.Err() != nil {
			return
		}
		logger.Warn("本地通道中断，稍后重连", "err", err, "delay", delay)
		if !sleepCtx(ctx, delay) {
			return
		}
		delay = minDuration(delay*2, maxDelay)
	}
}

// ensureRegistered 上报白名单快照并发布指令面板/菜单。
//
// verbose 只影响日志级别：首次注册打 INFO，周期性重同步打 DEBUG。
//
// 返回值 dshReady：本次同步时菜单里**是否已带上 dsh 命令二级菜单**。网关刚起来时
// 可能还没有活会话、枚举不到 dsh 内置命令，这时菜单会缺「dsh 命令」子菜单；
// 调用方可据此走"快速重试"，不必干等满一个重同步周期。
func ensureRegistered(ctx context.Context, cfg *config.Config, channel *bridge.Client, exec *executor.Executor, logger *slog.Logger, verbose bool) (dshReady bool, err error) {
	openids := make([]map[string]string, 0, len(cfg.Whitelist.Users))
	for _, u := range cfg.Whitelist.Users {
		openids = append(openids, map[string]string{"openid": u.OpenID, "note": u.Note})
	}
	payload := map[string]any{
		"openids": openids,
		"panel": map[string]any{
			"enabled": cfg.IsPanelEnabled(),
			"users":   cfg.PanelOpenIDs(),
		},
		"menu":    map[string]any{"enabled": cfg.IsMenuEnabled()},
		"version": 1,
	}
	if err := channel.Call(ctx, "register", payload, nil); err != nil {
		return false, fmt.Errorf("register 失败：%w", err)
	}

	// 插件回包兼容两种形状：扁平的 menuItems（新）与嵌套的 menu.items（旧）。
	// 之所以要兼容：Host 插件的 ESM 模块按 URL 缓存，改代码后光重启网关不会
	// 换到新代码（要 dsh web 重启），兼容解码保证两种版本都能发布菜单。
	var panelPayload struct {
		qq.PanelDefinition
		Menu struct {
			Items []qq.MenuItem `json:"items"`
		} `json:"menu"`
	}
	if err := channel.Call(ctx, "panel", struct{}{}, &panelPayload); err != nil {
		return false, fmt.Errorf("读取面板定义失败：%w", err)
	}
	def := panelPayload.PanelDefinition
	if len(def.MenuItems) == 0 {
		def.MenuItems = panelPayload.Menu.Items
	}
	// 是否发布、面板 remark、是否发布菜单，一律以本机 config.yaml 为准 ——
	// 插件只提供"内容"（命令表 / 菜单项 / 目标私聊），不决定本机要不要发。
	def.Enabled = cfg.IsPanelEnabled()
	def.Remark = cfg.Panel.Remark
	def.MenuEnabled = cfg.IsMenuEnabled()
	// 面板与菜单：失败只记 WARN —— 它们是发现入口，不该阻塞收发。
	if err := exec.PublishPanel(ctx, def); err != nil {
		logger.Warn("发布指令面板失败（不影响收发）", "err", err)
	}
	if verbose {
		logger.Info("已向 dsh 插件注册并同步面板", "commands", len(def.Items), "menu", len(def.MenuItems), "targets", len(def.UserOpenIDs))
	} else {
		logger.Debug("已重同步面板", "menu", len(def.MenuItems))
	}
	// dsh 内置命令的二级菜单是否已经补齐：网关刚起来时可能还没有活会话，
	// 枚举不到 dsh 命令 ⇒ 菜单里缺「dsh 命令」子菜单。调用方据此决定要不要"快速重试"。
	return menuHasDshCommands(def.MenuItems), nil
}

// menuHasDshCommands 判断菜单里是否已经带上了 dsh 命令的二级菜单。
//
// 判据：存在一个可折叠二级菜单，且它至少有一个子项的 SendMessage 以 "/" 开头。
// 插件把 dsh 内置命令收进这种二级菜单（子项 sendMessage 是 `/compact`、`/model` 这类斜杠命令）；
// 桥自己的二级菜单（如「管理」）子项是普通命令名（`停止`/`归档`…），不含 "/"，
// 所以不会被误判。
func menuHasDshCommands(items []qq.MenuItem) bool {
	for _, it := range items {
		if it.Type != "menu" {
			continue
		}
		for _, child := range it.Children {
			if strings.HasPrefix(strings.TrimSpace(child.SendMessage), "/") {
				return true
			}
		}
	}
	return false
}

// panelResyncInterval 是面板/菜单的**常规**重同步间隔。
//
// 为什么需要重同步：菜单里的 dsh 内置命令是按 **agent 作用域** 枚举的，
// 网关启动那一刻可能还没有活会话，二级菜单就是空的；等用户开始用之后再同步
// 一次就能补齐。发布本身是幂等的（面板按 remark 复用、菜单内容相同则跳过），
// 所以这里的代价只是一次通道查询（外加面板的一次幂等更新）。
const panelResyncInterval = 5 * time.Minute

// panelResyncFastInterval 是**快速重试**间隔。
//
// 场景（2026-11-02 线上）：网关重启那一刻还没有活 agent ⇒ 枚举不到 dsh 命令 ⇒
// 菜单里缺「dsh 命令」子菜单，按老逻辑要干等满 5 分钟才补。用户当场发现子菜单"消失"。
// 现在：只要这一轮同步后仍然**没有** dsh 命令子菜单，就按这个短间隔快速重试，
// 直到补齐（或达到快速重试上限），免得让人对着残缺菜单等好几分钟。
const panelResyncFastInterval = 10 * time.Second

// panelResyncFastMaxTries 是"缺 dsh 命令子菜单"时连续快速重试的最大次数（≈1 分钟）。
// 超过就退回常规间隔，避免长时间高频查询通道。
const panelResyncFastMaxTries = 6

// panelResyncLoop 周期性重同步面板与菜单；缺 dsh 命令子菜单时快速重试补齐。
//
// 关键点：**开机第一拍要等短间隔**。网关刚启动时几乎必然还没有活会话、枚举不到
// dsh 命令，若第一拍就等满 5 分钟，用户会对着缺「dsh 命令」子菜单的面板干等好几分钟。
// 所以引入 fastTries 状态：只要还缺 dsh 命令子菜单就把等待降到 10 秒快速重试
// （最多连续 panelResyncFastMaxTries 次），补齐后回到常规 5 分钟周期。
func panelResyncLoop(ctx context.Context, cfg *config.Config, channel *bridge.Client, exec *executor.Executor, logger *slog.Logger) {
	// 初始按"缺 dsh 命令"对待：第一拍就走快速间隔，尽快把子菜单补齐。
	fastTries := 1
	for {
		wait := panelResyncInterval
		if fastTries > 0 && fastTries <= panelResyncFastMaxTries {
			wait = panelResyncFastInterval
		}
		if !sleepCtx(ctx, wait) {
			return
		}
		dshReady, err := ensureRegistered(ctx, cfg, channel, exec, logger, false)
		if err != nil {
			if ctx.Err() == nil {
				logger.Debug("周期性重同步面板失败（不影响收发）", "err", err)
			}
			// 出错也保持快速重试计数（不越界），下一拍继续尝试补齐。
			if fastTries < panelResyncFastMaxTries {
				fastTries++
			}
			continue
		}
		// 已补齐 → 清零，回到常规周期；仍缺 → 递增快速重试计数（用满后回到常规周期）。
		if dshReady {
			if fastTries > 1 {
				logger.Info("dsh 命令子菜单已补齐")
			}
			fastTries = 0
			continue
		}
		if fastTries < panelResyncFastMaxTries {
			fastTries++
			logger.Debug("菜单暂缺 dsh 命令子菜单，快速重试", "next", panelResyncFastInterval.String(), "try", fastTries)
		}
	}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
