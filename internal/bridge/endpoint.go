package bridge

import (
	"errors"
	"fmt"
	"strings"
)

// 通道的网络类型。
//
// POSIX 上用 UNIX domain socket（目录 0700 / socket 0600，权限即认证）；
// Windows 上 Node 只能建命名管道（libuv 的 pipe 就是 NPFS 管道，建不出 AF_UNIX），
// 所以那边走 pipe。平台差异全在 transport_unix.go / transport_windows.go 里，
// 上层只看见 dialEndpoint / verifyEndpoint 这两个函数。
const (
	// NetworkUnix 表示 UNIX domain socket（Linux / macOS）。
	NetworkUnix = "unix"
	// NetworkPipe 表示 Windows 命名管道。
	NetworkPipe = "pipe"
)

// pipePrefix 是 Windows 命名管道的固定前缀。
const pipePrefix = `\\.\pipe\`

// 平台不支持时返回的错误：两条实现共用同一句话，避免话术漂移。
var (
	// ErrPipeUnsupported 表示当前平台建不了命名管道。
	ErrPipeUnsupported = errors.New("命名管道（pipe:）只在 Windows 上可用")
	// ErrUnixUnsupported 表示当前平台建不了 UNIX domain socket。
	ErrUnixUnsupported = errors.New(
		`Windows 上不能用 UNIX domain socket 通道（dsh 插件在 Windows 只能建命名管道），` +
			`请把 bridge.socket 配成 pipe:<名字>`,
	)
)

// Endpoint 是本地通道地址：网络类型 + 具体名字。
type Endpoint struct {
	// Network 取 NetworkUnix / NetworkPipe。
	Network string
	// Address 是 POSIX 的 socket 路径，或 Windows 的 `\\.\pipe\<名字>`。
	Address string
}

// IsPipe 报告是否是命名管道。
func (e Endpoint) IsPipe() bool { return e.Network == NetworkPipe }

// String 返回日志与报错用的写法：管道只写名字，不写 `\\.\pipe\` 前缀。
func (e Endpoint) String() string {
	if e.IsPipe() {
		return "pipe:" + pipeName(e.Address)
	}
	return e.Address
}

// ParseEndpoint 解析通道地址。支持两种写法：
//
//	unix:/path/to/bridge.sock   （直接写路径等价，默认就是它）
//	pipe:名字                    （等价于 \\.\pipe\名字；已带前缀也认）
//
// 只认这两个短方案：Windows 盘符（`C:\…`）冒号前是单个字母，不会被当成方案，
// 仍按 unix 路径处理（在 Windows 上会被 verify/dial 明确拒绝，而不是静默连不上）。
func ParseEndpoint(raw string) (Endpoint, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return Endpoint{}, errors.New("通道地址不能为空")
	}
	if scheme, rest, ok := splitScheme(value); ok {
		switch scheme {
		case NetworkPipe:
			name := strings.TrimSpace(rest)
			if name == "" {
				return Endpoint{}, fmt.Errorf("通道地址 %q 缺少管道名（应为 pipe:<名字>）", raw)
			}
			return Endpoint{Network: NetworkPipe, Address: namedPipePath(name)}, nil
		default:
			path := strings.TrimSpace(rest)
			if path == "" {
				return Endpoint{}, fmt.Errorf("通道地址 %q 缺少路径（应为 unix:<路径>）", raw)
			}
			return Endpoint{Network: NetworkUnix, Address: path}, nil
		}
	}
	return Endpoint{Network: NetworkUnix, Address: value}, nil
}

// splitScheme 只认 unix: / pipe: 两个短方案（大小写不敏感）。
//
// 冒号前最多 4 个字符是为了排除 `C:\…` 这类盘符路径。
func splitScheme(value string) (scheme, rest string, ok bool) {
	index := strings.IndexByte(value, ':')
	if index <= 0 || index > 4 {
		return "", "", false
	}
	name := strings.ToLower(value[:index])
	if name != NetworkUnix && name != NetworkPipe {
		return "", "", false
	}
	return name, value[index+1:], true
}

// namedPipePath 把管道名补成完整的 `\\.\pipe\<名字>`（已带前缀的原样返回）。
func namedPipePath(name string) string {
	if hasPipePrefix(name) {
		return pipePrefix + name[len(pipePrefix):]
	}
	return pipePrefix + name
}

// pipeName 取掉 `\\.\pipe\` 前缀，只留名字。
func pipeName(address string) string {
	if hasPipePrefix(address) {
		return address[len(pipePrefix):]
	}
	return address
}

// hasPipePrefix 判断是否已带前缀（Windows 的路径不区分大小写）。
func hasPipePrefix(value string) bool {
	return len(value) >= len(pipePrefix) && strings.EqualFold(value[:len(pipePrefix)], pipePrefix)
}
