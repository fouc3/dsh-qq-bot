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
	)
	flag.StringVar(&configPath, "config", config.DefaultPath, "配置文件路径")
	flag.BoolVar(&checkConfig, "check-config", false, "只校验配置并打印摘要（不连 QQ、不连 dsh）")
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

	socketPath := cfg.SocketPath()
	dedupe, err := executor.OpenDedupe(filepath.Join(filepath.Dir(socketPath), "qqbot-seen.json"), dedupeCapacity)
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

	// 本地通道：注册 + 面板发布（重试到成功）+ outbox 长轮询。
	go bridgeLoop(ctx, cfg, channel, exec, logger)

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

// bridgeLoop 维护与 dsh 插件的连接：
// 每次（重）连上前先 register + 发布面板，然后进入 outbox 长轮询。
func bridgeLoop(ctx context.Context, cfg *config.Config, channel *bridge.Client, exec *executor.Executor, logger *slog.Logger) {
	maxDelay := time.Duration(cfg.Bridge.ReconnectMaxSeconds) * time.Second
	delay := time.Second

	for ctx.Err() == nil {
		if err := ensureRegistered(ctx, cfg, channel, exec, logger); err != nil {
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
func ensureRegistered(ctx context.Context, cfg *config.Config, channel *bridge.Client, exec *executor.Executor, logger *slog.Logger) error {
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
		return fmt.Errorf("register 失败：%w", err)
	}

	var def qq.PanelDefinition
	if err := channel.Call(ctx, "panel", struct{}{}, &def); err != nil {
		return fmt.Errorf("读取面板定义失败：%w", err)
	}
	// 面板与菜单：失败只记 WARN —— 它们是发现入口，不该阻塞收发。
	if err := exec.PublishPanel(ctx, def); err != nil {
		logger.Warn("发布指令面板失败（不影响收发）", "err", err)
	}
	logger.Info("已向 dsh 插件注册并同步面板", "commands", len(def.Items), "targets", len(def.UserOpenIDs))
	return nil
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
