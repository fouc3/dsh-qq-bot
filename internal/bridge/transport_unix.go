//go:build !windows

package bridge

import (
	"context"
	"fmt"
	"net"
	"os"
	"syscall"
	"time"
)

// dialEndpoint 是通道拨号的唯一入口：按网络类型分发，平台差异在编译期择一。
func dialEndpoint(ctx context.Context, endpoint Endpoint, timeout time.Duration) (net.Conn, error) {
	if endpoint.IsPipe() {
		return nil, ErrPipeUnsupported
	}
	dialer := &net.Dialer{Timeout: timeout}
	return dialer.DialContext(ctx, "unix", endpoint.Address)
}

// verifyEndpoint 是连接前的地址校验：POSIX 上「权限即认证」——
// 目录 0700、socket 0600、属主必须是当前 uid，否则宁可拒连也不默默降级。
func verifyEndpoint(endpoint Endpoint) error {
	if endpoint.IsPipe() {
		return ErrPipeUnsupported
	}
	info, err := os.Lstat(endpoint.Address)
	if err != nil {
		return fmt.Errorf("本地通道不可用（%s）：%w", endpoint.Address, err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("本地通道路径不是 socket：%s", endpoint.Address)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Errorf("本地通道 socket 权限过宽（%04o，应为 0600）：%s", perm, endpoint.Address)
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		if uid := os.Getuid(); int(st.Uid) != uid {
			return fmt.Errorf("本地通道 socket 属主不是当前用户（uid=%d，期望 %d）：%s", st.Uid, uid, endpoint.Address)
		}
	}
	return nil
}
