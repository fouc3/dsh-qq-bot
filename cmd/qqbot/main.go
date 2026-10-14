// Command qqbot 是 DSH-QQ-Bot 的 QQ 侧网关：
// 用 qq-bot-sdk 收发 QQ 私聊消息，通过 UNIX domain socket 与 dsh 插件对话。
package main

import (
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"

	"github.com/fouc3/dsh-qq-bot/internal/config"
	"github.com/fouc3/dsh-qq-bot/internal/logging"
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

	_ = logger
	return errors.New("收发链路尚未接入（当前仅支持 -check-config）")
}

var _ = slog.LevelInfo
