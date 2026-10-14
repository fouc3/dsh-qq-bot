// Package logging 组装 slog 日志器。
//
// 级别用 *slog.LevelVar 持有，便于将来热改级别而不重建 handler。
package logging

import (
	"fmt"
	"log/slog"
	"os"
)

// Options 是日志设置。
type Options struct {
	// Level 取 debug/info/warn/error。
	Level string
	// Format 取 text/json。
	Format string
}

// New 返回日志器、级别开关与错误。
func New(opts Options) (*slog.Logger, *slog.LevelVar, error) {
	var level slog.Level
	switch opts.Level {
	case "debug":
		level = slog.LevelDebug
	case "info":
		level = slog.LevelInfo
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		return nil, nil, fmt.Errorf("logging: 未知日志级别 %q", opts.Level)
	}

	lv := new(slog.LevelVar)
	lv.Set(level)

	handlerOpts := &slog.HandlerOptions{Level: lv}
	var handler slog.Handler
	switch opts.Format {
	case "json":
		handler = slog.NewJSONHandler(os.Stderr, handlerOpts)
	case "text":
		handler = slog.NewTextHandler(os.Stderr, handlerOpts)
	default:
		return nil, nil, fmt.Errorf("logging: 未知日志格式 %q", opts.Format)
	}
	return slog.New(handler), lv, nil
}
