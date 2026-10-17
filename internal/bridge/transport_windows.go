//go:build windows

package bridge

import (
	"context"
	"fmt"
	"net"
	"time"

	"github.com/Microsoft/go-winio"
)

// dialEndpoint 是通道拨号的唯一入口：按网络类型分发，平台差异在编译期择一。
//
// Windows 上 Go 自己虽然支持 AF_UNIX（Win10 1803+），但 dsh 插件跑在 Node 里、
// 那边只能建命名管道，所以这里只认 pipe，unix 直接给一条明确的错。
func dialEndpoint(ctx context.Context, endpoint Endpoint, timeout time.Duration) (net.Conn, error) {
	if !endpoint.IsPipe() {
		return nil, ErrUnixUnsupported
	}
	// winio 按 ctx 超时；调用方已经用 DialTimeout 生成过 ctx。
	conn, err := winio.DialPipeContext(ctx, endpoint.Address)
	if err != nil {
		return nil, fmt.Errorf("连接命名管道失败（%s）：%w", endpoint.Address, err)
	}
	return conn, nil
}

// verifyEndpoint 在 Windows 上不做文件校验：命名管道没有 0600 这种权限位，
// 也不存在「属主是不是当前用户」的概念。这边的认证**只能靠 token 握手**，
// 所以插件配置里 token 在 Windows 上是必填项（见 README「Windows 兼容」）。
func verifyEndpoint(endpoint Endpoint) error {
	if endpoint.IsPipe() {
		return nil
	}
	return ErrUnixUnsupported
}
