// Package bridge 实现与 dsh 插件之间的本地通道客户端：
// UNIX domain socket + 换行分隔 JSON（NDJSON），见 docs/protocol.md。
package bridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"sync/atomic"
	"syscall"
	"time"
)

// MaxFrameBytes 是单帧上限（与插件侧一致）。
const MaxFrameBytes = 1 << 20

// Command 是插件下发的出站命令。
type Command struct {
	ID   string          `json:"id"`
	Kind string          `json:"kind"`
	Args json.RawMessage `json:"args"`
}

// Ack 是一条命令的执行结果。
type Ack struct {
	ID        string `json:"id"`
	OK        bool   `json:"ok"`
	MessageID string `json:"messageId,omitempty"`
	ErrorCode int    `json:"errorCode,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Error 是插件按协议返回的错误。
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("本地通道错误 [%s]：%s", e.Code, e.Message) }

// IsCode 报告错误是否是指定协议错误码。
func IsCode(err error, code string) bool {
	var pe *Error
	return errors.As(err, &pe) && pe.Code == code
}

// Options 是通道客户端设置。
type Options struct {
	// Token 为空表示不做握手，仅靠 socket 文件权限（0600）认证。
	Token string
	// DialTimeout 是拨号与握手的超时。
	DialTimeout time.Duration
	// RequestTimeout 是单次请求的读写超时。
	RequestTimeout time.Duration
	// PollWait 是 outbox 长轮询的等待上限。
	PollWait time.Duration
}

// Client 是本地通道客户端。
//
// 约定：**每请求一条连接**（拨号 → 一帧请求 → 一帧响应 → 关闭），
// 只有 outbox 长轮询独占一条长连接。这样无需多路复用，也不会出现
// 一帧响应串到另一个请求上的问题。
type Client struct {
	path string
	opts Options
	log  *slog.Logger
	seq  atomic.Uint64
}

// New 构造通道客户端。
func New(path string, opts Options, log *slog.Logger) *Client {
	if log == nil {
		log = slog.Default()
	}
	if opts.DialTimeout <= 0 {
		opts.DialTimeout = 10 * time.Second
	}
	if opts.RequestTimeout <= 0 {
		opts.RequestTimeout = 60 * time.Second
	}
	if opts.PollWait <= 0 {
		opts.PollWait = 25 * time.Second
	}
	return &Client{path: path, opts: opts, log: log}
}

// Path 返回通道 socket 路径。
func (c *Client) Path() string { return c.path }

// VerifySocket 在拨号前校验 socket 的属主与权限位。
//
// 这是"仅限当前账户可访问"这一要求的客户端侧检查：如果 socket 被放宽权限，
// 我们宁可拒绝连接并明确报错，也不默默降级。
func (c *Client) VerifySocket() error {
	info, err := os.Lstat(c.path)
	if err != nil {
		return fmt.Errorf("本地通道不可用（%s）：%w", c.path, err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("本地通道路径不是 socket：%s", c.path)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Errorf("本地通道 socket 权限过宽（%04o，应为 0600）：%s", perm, c.path)
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		if uid := os.Getuid(); int(st.Uid) != uid {
			return fmt.Errorf("本地通道 socket 属主不是当前用户（uid=%d，期望 %d）：%s", st.Uid, uid, c.path)
		}
	}
	return nil
}

// Call 执行一次请求/响应。
func (c *Client) Call(ctx context.Context, op string, args any, out any) error {
	if err := c.VerifySocket(); err != nil {
		return err
	}
	conn, err := c.dial(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	deadline := time.Now().Add(c.opts.RequestTimeout)
	_ = conn.SetDeadline(deadline)

	reader := bufio.NewReaderSize(conn, 64*1024)
	if err := c.handshake(conn, reader); err != nil {
		return err
	}

	rawArgs, err := marshalArgs(args)
	if err != nil {
		return err
	}
	id := c.nextID()
	if err := writeFrame(conn, frame{ID: id, Op: op, Args: rawArgs}); err != nil {
		return fmt.Errorf("写入通道请求失败：%w", err)
	}
	value, err := readResponse(reader, id)
	if err != nil {
		return err
	}
	if out != nil && len(value) > 0 {
		if err := json.Unmarshal(value, out); err != nil {
			return fmt.Errorf("解析通道返回值失败：%w", err)
		}
	}
	return nil
}

// Ack 回报一条命令的执行结果。
func (c *Client) Ack(ctx context.Context, a Ack) error {
	return c.Call(ctx, "ack", a, nil)
}

// Health 读取插件侧健康状况。
func (c *Client) Health(ctx context.Context) (map[string]any, error) {
	var out map[string]any
	if err := c.Call(ctx, "health", struct{}{}, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Poll 用一条长连接持续长轮询 outbox，把每批命令交给 fn。
//
// fn 返回的错误只记日志：命令级的成败由各自的 ack 承载。
// 本方法在连接断开或 ctx 结束时返回，调用方负责退避重连。
func (c *Client) Poll(ctx context.Context, fn func(context.Context, []Command) error) error {
	if err := c.VerifySocket(); err != nil {
		return err
	}
	conn, err := c.dial(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	reader := bufio.NewReaderSize(conn, 64*1024)
	// 握手用较短的期限，之后改为「长轮询 + 余量」。
	_ = conn.SetDeadline(time.Now().Add(c.opts.DialTimeout))
	if err := c.handshake(conn, reader); err != nil {
		return err
	}

	waitSeconds := int(c.opts.PollWait / time.Second)
	if waitSeconds < 1 {
		waitSeconds = 1
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		_ = conn.SetDeadline(time.Now().Add(c.opts.PollWait + 20*time.Second))
		args, _ := json.Marshal(map[string]int{"waitSeconds": waitSeconds})
		id := c.nextID()
		if err := writeFrame(conn, frame{ID: id, Op: "outbox.poll", Args: args}); err != nil {
			return fmt.Errorf("写入长轮询请求失败：%w", err)
		}
		value, err := readResponse(reader, id)
		if err != nil {
			return err
		}
		var payload struct {
			Commands []Command `json:"commands"`
		}
		if len(value) > 0 {
			if err := json.Unmarshal(value, &payload); err != nil {
				return fmt.Errorf("解析出站命令失败：%w", err)
			}
		}
		if len(payload.Commands) == 0 {
			continue
		}
		if err := fn(ctx, payload.Commands); err != nil {
			c.log.Warn("处理出站命令时出错", "err", err)
		}
	}
}

func (c *Client) dial(ctx context.Context) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: c.opts.DialTimeout}
	conn, err := dialer.DialContext(ctx, "unix", c.path)
	if err != nil {
		return nil, fmt.Errorf("连接本地通道失败（%s）：%w", c.path, err)
	}
	return conn, nil
}

// handshake 在配置了 token 时发送握手帧。
func (c *Client) handshake(conn net.Conn, reader *bufio.Reader) error {
	if c.opts.Token == "" {
		return nil
	}
	if err := writeFrame(conn, map[string]string{"token": c.opts.Token}); err != nil {
		return fmt.Errorf("写入握手帧失败：%w", err)
	}
	line, err := readLine(reader)
	if err != nil {
		return fmt.Errorf("读取握手响应失败：%w", err)
	}
	var resp struct {
		OK    bool        `json:"ok"`
		Error *frameError `json:"error"`
	}
	if err := json.Unmarshal(line, &resp); err != nil {
		return fmt.Errorf("握手响应不是合法 JSON：%w", err)
	}
	if !resp.OK {
		if resp.Error != nil {
			return &Error{Code: resp.Error.Code, Message: resp.Error.Message}
		}
		return errors.New("本地通道握手被拒绝")
	}
	return nil
}

func (c *Client) nextID() string {
	return fmt.Sprintf("qqbot-%d", c.seq.Add(1))
}

// frame 是请求帧。
type frame struct {
	ID   string          `json:"id"`
	Op   string          `json:"op"`
	Args json.RawMessage `json:"args,omitempty"`
}

// frameError 是响应帧里的错误体。
type frameError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// response 是响应帧。
type response struct {
	ID    string          `json:"id"`
	OK    bool            `json:"ok"`
	Value json.RawMessage `json:"value,omitempty"`
	Error *frameError     `json:"error,omitempty"`
}

func marshalArgs(args any) (json.RawMessage, error) {
	switch v := args.(type) {
	case nil:
		return nil, nil
	case json.RawMessage:
		return v, nil
	case struct{}:
		return nil, nil
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			return nil, fmt.Errorf("序列化通道参数失败：%w", err)
		}
		return raw, nil
	}
}

func writeFrame(w io.Writer, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(raw) > MaxFrameBytes {
		return fmt.Errorf("帧超过 %d 字节上限（%d）", MaxFrameBytes, len(raw))
	}
	raw = append(raw, '\n')
	_, err = w.Write(raw)
	return err
}

// readLine 读一行并套用帧上限。
func readLine(reader *bufio.Reader) ([]byte, error) {
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	if len(line) > MaxFrameBytes {
		return nil, fmt.Errorf("应答帧超过 %d 字节上限", MaxFrameBytes)
	}
	return line, nil
}

// readResponse 读一帧响应并按协议解包（失败即返回 *Error）。
// id 仅用于诊断信息，协议只要求原样回显。
func readResponse(reader *bufio.Reader, id string) (json.RawMessage, error) {
	line, err := readLine(reader)
	if err != nil {
		return nil, fmt.Errorf("读取通道应答失败：%w", err)
	}
	var resp response
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, fmt.Errorf("通道应答不是合法 JSON：%w", err)
	}
	if resp.ID != "" && id != "" && resp.ID != id {
		return nil, fmt.Errorf("通道应答 id 不匹配（请求 %s，应答 %s）", id, resp.ID)
	}
	if !resp.OK {
		if resp.Error != nil {
			return nil, &Error{Code: resp.Error.Code, Message: resp.Error.Message}
		}
		return nil, errors.New("通道返回失败但没有错误信息")
	}
	return resp.Value, nil
}
