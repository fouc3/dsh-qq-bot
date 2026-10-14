package bridge

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// testReq 是测试服务端看到的一条请求。
type testReq struct {
	ID   string          `json:"id"`
	Op   string          `json:"op"`
	Args json.RawMessage `json:"args"`
}

// testServer 是一个真实的 UNIX socket 服务端，行为由 handle 决定。
type testServer struct {
	t      *testing.T
	path   string
	token  string
	ln     net.Listener
	count  atomic.Int64
	mu     sync.Mutex
	seen   []testReq
	closed bool
}

// startTestServer 起服务端；handle 返回 (value, errFrame)。
func startTestServer(
	t *testing.T,
	token string,
	handle func(req testReq, n int) (any, *frameError),
) *testServer {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "bridge.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("监听失败：%v", err)
	}
	// net.Listen 建的 socket 默认权限偏宽，这里显式收紧到 0600。
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}

	s := &testServer{t: t, path: path, token: token, ln: ln}
	go s.serve(handle)
	t.Cleanup(func() { _ = ln.Close() })
	return s
}

func (s *testServer) serve(handle func(testReq, int) (any, *frameError)) {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		go func(conn net.Conn) {
			defer conn.Close()
			reader := bufio.NewReaderSize(conn, 64*1024)

			if s.token != "" {
				line, err := reader.ReadBytes('\n')
				if err != nil {
					return
				}
				var hs struct {
					Token string `json:"token"`
				}
				if err := json.Unmarshal(line, &hs); err != nil || hs.Token != s.token {
					_, _ = fmt.Fprintf(conn, "{\"ok\":false,\"error\":{\"code\":\"unauthorized\",\"message\":\"token 不匹配\"}}\n")
					return
				}
				_, _ = conn.Write([]byte("{\"ok\":true}\n"))
			}

			for {
				line, err := reader.ReadBytes('\n')
				if err != nil {
					return
				}
				var req testReq
				if err := json.Unmarshal(line, &req); err != nil {
					return
				}
				n := int(s.count.Add(1))
				s.mu.Lock()
				s.seen = append(s.seen, req)
				s.mu.Unlock()

				value, errFrame := handle(req, n)
				resp := map[string]any{"id": req.ID, "ok": errFrame == nil}
				if errFrame != nil {
					resp["error"] = errFrame
				} else if value != nil {
					resp["value"] = value
				}
				raw, err := json.Marshal(resp)
				if err != nil {
					return
				}
				if _, err := conn.Write([]byte(string(raw) + "\n")); err != nil {
					return
				}
			}
		}(conn)
	}
}

func (s *testServer) requests() []testReq {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]testReq(nil), s.seen...)
}

func newTestClient(path, token string) *Client {
	return New(path, Options{Token: token, DialTimeout: 2 * time.Second, RequestTimeout: 5 * time.Second, PollWait: time.Second}, nil)
}

func TestCallRoundTrip(t *testing.T) {
	var got testReq
	srv := startTestServer(t, "", func(req testReq, _ int) (any, *frameError) {
		got = req
		return map[string]any{"ok": true, "accepted": true}, nil
	})

	c := newTestClient(srv.path, "")
	var out struct {
		OK       bool `json:"ok"`
		Accepted bool `json:"accepted"`
	}
	if err := c.Call(context.Background(), "register", map[string]any{"version": 1}, &out); err != nil {
		t.Fatalf("调用失败：%v", err)
	}
	if got.Op != "register" || !strings.Contains(string(got.Args), `"version":1`) {
		t.Errorf("请求未正确送达：op=%q args=%s", got.Op, got.Args)
	}
	if !out.OK || !out.Accepted {
		t.Errorf("返回值未解析：%+v", out)
	}
	if got.ID == "" {
		t.Error("请求应带 id")
	}
}

func TestCallSurfacesErrorFrame(t *testing.T) {
	srv := startTestServer(t, "", func(testReq, int) (any, *frameError) {
		return nil, &frameError{Code: "bad-request", Message: "缺少 op"}
	})
	c := newTestClient(srv.path, "")

	err := c.Call(context.Background(), "event", struct{}{}, nil)
	if err == nil {
		t.Fatal("错误帧应变成错误")
	}
	if !IsCode(err, "bad-request") {
		t.Errorf("应识别协议错误码：%v", err)
	}
}

func TestVerifySocketRejectsLoosePermissions(t *testing.T) {
	srv := startTestServer(t, "", func(testReq, int) (any, *frameError) { return nil, nil })
	if err := os.Chmod(srv.path, 0o666); err != nil {
		t.Fatal(err)
	}

	c := newTestClient(srv.path, "")
	err := c.Call(context.Background(), "health", struct{}{}, nil)
	if err == nil || !strings.Contains(err.Error(), "权限过宽") {
		t.Fatalf("权限过宽时应明确拒绝连接，实际：%v", err)
	}
}

func TestVerifySocketRejectsMissingPath(t *testing.T) {
	c := newTestClient(filepath.Join(t.TempDir(), "nope.sock"), "")
	if err := c.Call(context.Background(), "health", struct{}{}, nil); err == nil {
		t.Fatal("路径不存在时应报错")
	}
}

func TestHandshakeToken(t *testing.T) {
	srv := startTestServer(t, "s3cret", func(testReq, int) (any, *frameError) {
		return map[string]any{"ok": true}, nil
	})

	good := newTestClient(srv.path, "s3cret")
	if err := good.Call(context.Background(), "health", struct{}{}, nil); err != nil {
		t.Fatalf("正确 token 应通过：%v", err)
	}

	bad := newTestClient(srv.path, "wrong")
	err := bad.Call(context.Background(), "health", struct{}{}, nil)
	if err == nil {
		t.Fatal("错误 token 应失败")
	}
	if !IsCode(err, "unauthorized") {
		t.Errorf("应是 unauthorized：%v", err)
	}
}

func TestPollDeliversCommands(t *testing.T) {
	srv := startTestServer(t, "", func(req testReq, n int) (any, *frameError) {
		if req.Op != "outbox.poll" {
			return nil, &frameError{Code: "unknown-op", Message: req.Op}
		}
		if n == 1 {
			return map[string]any{"commands": []map[string]any{
				{"id": "c-1", "kind": "send_c2c", "args": map[string]any{"content": "hi"}},
			}}, nil
		}
		return map[string]any{"commands": []map[string]any{}}, nil
	})

	c := newTestClient(srv.path, "")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	var got []Command
	err := c.Poll(ctx, func(_ context.Context, cmds []Command) error {
		got = append(got, cmds...)
		if len(got) == 1 {
			cancel() // 收到一批就收工
		}
		return nil
	})
	if err == nil {
		t.Log("Poll 因 ctx 结束而返回，符合预期")
	}
	if len(got) != 1 || got[0].ID != "c-1" || got[0].Kind != "send_c2c" {
		t.Fatalf("未拿到出站命令：%+v", got)
	}
	if !strings.Contains(string(got[0].Args), `"content":"hi"`) {
		t.Errorf("命令参数未透传：%s", got[0].Args)
	}
}

func TestReadRejectsOversizedFrame(t *testing.T) {
	srv := startTestServer(t, "", func(req testReq, _ int) (any, *frameError) {
		return strings.Repeat("x", MaxFrameBytes+16), nil
	})
	c := newTestClient(srv.path, "")
	err := c.Call(context.Background(), "health", struct{}{}, nil)
	if err == nil || !strings.Contains(err.Error(), "上限") {
		t.Fatalf("超大帧应被拒：%v", err)
	}
}

func TestAckSendsAckOp(t *testing.T) {
	srv := startTestServer(t, "", func(testReq, int) (any, *frameError) {
		return map[string]any{"ok": true}, nil
	})
	c := newTestClient(srv.path, "")

	if err := c.Ack(context.Background(), Ack{ID: "c-1", OK: true, MessageID: "M-1"}); err != nil {
		t.Fatalf("ack 失败：%v", err)
	}
	reqs := srv.requests()
	if len(reqs) != 1 || reqs[0].Op != "ack" {
		t.Fatalf("应发一条 ack：%+v", reqs)
	}
	args := string(reqs[0].Args)
	for _, want := range []string{`"id":"c-1"`, `"ok":true`, `"messageId":"M-1"`} {
		if !strings.Contains(args, want) {
			t.Errorf("ack 参数缺少 %s：%s", want, args)
		}
	}
}
