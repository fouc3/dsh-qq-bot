package bridge

import (
	"errors"
	"runtime"
	"strings"
	"testing"
)

func TestParseEndpoint(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		network string
		address string
		errPart string
	}{
		{name: "裸路径就是 unix", raw: "/run/dsh/bridge.sock", network: NetworkUnix, address: "/run/dsh/bridge.sock"},
		{name: "unix 方案", raw: "unix:/run/dsh/bridge.sock", network: NetworkUnix, address: "/run/dsh/bridge.sock"},
		{name: "方案大小写不敏感", raw: "UNIX:/run/x.sock", network: NetworkUnix, address: "/run/x.sock"},
		{name: "pipe 补上 \\\\.\\pipe\\ 前缀", raw: "pipe:dsh-qq-bot-bridge", network: NetworkPipe, address: `\\.\pipe\dsh-qq-bot-bridge`},
		{name: "pipe 已带前缀不重复加", raw: `pipe:\\.\pipe\ab`, network: NetworkPipe, address: `\\.\pipe\ab`},
		{name: "pipe 名字两端空白清掉", raw: "  pipe: name  ", network: NetworkPipe, address: `\\.\pipe\name`},
		{name: "Windows 盘符不算方案", raw: `C:\Users\me\bridge.sock`, network: NetworkUnix, address: `C:\Users\me\bridge.sock`},
		{name: "空地址", raw: "   ", errPart: "不能为空"},
		{name: "pipe 缺名字", raw: "pipe:", errPart: "缺少管道名"},
		{name: "unix 缺路径", raw: "unix:", errPart: "缺少路径"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			endpoint, err := ParseEndpoint(tc.raw)
			if tc.errPart != "" {
				if err == nil || !strings.Contains(err.Error(), tc.errPart) {
					t.Fatalf("期望报错含 %q，实际 endpoint=%+v err=%v", tc.errPart, endpoint, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("不该报错：%v", err)
			}
			if endpoint.Network != tc.network || endpoint.Address != tc.address {
				t.Fatalf("解析结果不对：得到 %+v，期望 %s / %s", endpoint, tc.network, tc.address)
			}
		})
	}
}

func TestEndpointString(t *testing.T) {
	pipe := Endpoint{Network: NetworkPipe, Address: `\\.\pipe\demo`}
	if got := pipe.String(); got != "pipe:demo" {
		t.Fatalf("管道的写法应只留名字，得到 %q", got)
	}
	unix := Endpoint{Network: NetworkUnix, Address: "/run/x.sock"}
	if got := unix.String(); got != "/run/x.sock" {
		t.Fatalf("unix 应原样输出，得到 %q", got)
	}
}

// TestVerifySocketRejectsPipeOnPOSIX 确认非 Windows 上配了 pipe: 会得到一句明确的错，
// 而不是"连不上"这种没法排查的报错。
func TestVerifySocketRejectsPipeOnPOSIX(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 上命名管道是正常用法")
	}
	err := New("pipe:demo", Options{}, nil).VerifySocket()
	if !errors.Is(err, ErrPipeUnsupported) {
		t.Fatalf("期望 ErrPipeUnsupported，得到 %v", err)
	}
}

// TestNewKeepsAddressError 确认地址解析错误不会在构造时静默丢掉。
func TestNewKeepsAddressError(t *testing.T) {
	err := New("pipe:", Options{}, nil).VerifySocket()
	if err == nil || !strings.Contains(err.Error(), "缺少管道名") {
		t.Fatalf("期望构造里留下的解析错误，得到 %v", err)
	}
}
