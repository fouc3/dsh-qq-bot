package qq

import (
	"context"
	"errors"
	"strings"
	"time"

	qqbotsdk "github.com/fouc3/qq-bot-sdk"
)

// Message 是一条待发送的 QQ 单聊消息。
type Message struct {
	// OpenID 是单聊对方的 user_openid。
	OpenID string
	// Content 是正文。
	Content string
	// Markdown 为真按 markdown 渲染（msg_type=2），为假按纯文本发送（msg_type=0）。
	//
	// 带键盘时**必须**是 markdown：平台只把按钮挂在 markdown 消息上，
	// 挂到纯文本消息上会被静默丢弃。所以有键盘时这里会被强制为真。
	Markdown bool
	// Keyboard 是内嵌键盘；nil 表示不带按钮。
	Keyboard *qqbotsdk.Keyboard
	// ReplyToMsgID 是被动回复的用户消息 id。
	ReplyToMsgID string
	// ReplyToEventID 是按钮互动事件 id；优先级高于 ReplyToMsgID。
	ReplyToEventID string
	// MsgSeq 是同一条被动回复的去重序号，从 1 开始递增。
	MsgSeq int
}

func (m Message) validate() error {
	if strings.TrimSpace(m.OpenID) == "" {
		return errors.New("qq: 缺少单聊 openid")
	}
	if strings.TrimSpace(m.Content) == "" {
		return errors.New("qq: 消息正文为空")
	}
	return nil
}

// Send 发送一条单聊消息，统一处理三件事：
//
//  1. 消息类型按 m.Markdown 选择；**带键盘时强制 markdown** —— 平台只在
//     markdown 消息上承载键盘，把键盘挂到纯文本消息上平台会静默丢掉按钮
//     （SDK 本地也会拦下这种组合）；
//  2. 可重试的失败退避重试（被动回复按 msg_id+msg_seq 去重，重试是安全的）；
//  3. 被动回复上下文失效（窗口过期、次数超限、msg_id/event_id 无效）时，
//     自动降级为主动消息，避免用户收不到。
func (c *Client) Send(ctx context.Context, m Message) (*qqbotsdk.MessageResponse, error) {
	if err := m.validate(); err != nil {
		return nil, err
	}
	msg := &qqbotsdk.Message{
		Content:  "",
		Keyboard: m.Keyboard,
		MsgID:    m.ReplyToMsgID,
		EventID:  m.ReplyToEventID,
		MsgSeq:   m.MsgSeq,
	}
	if m.Markdown || m.Keyboard != nil {
		msg.MsgType = qqbotsdk.MsgTypeMarkdown
		// QQ 的 markdown 把"单个换行"渲染成空格：出站正文统一补空行（见 HardenMarkdown）。
		msg.Markdown = &qqbotsdk.MessageMarkdown{Content: HardenMarkdown(m.Content)}
	} else {
		msg.MsgType = qqbotsdk.MsgTypeText
		msg.Content = m.Content
	}

	resp, err := c.sendWithFallback(ctx, m.OpenID, msg)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// sendWithFallback 发送一条已构造好的消息，并在被动回复上下文失效时降级为主动消息。
func (c *Client) sendWithFallback(ctx context.Context, openid string, msg *qqbotsdk.Message) (*qqbotsdk.MessageResponse, error) {
	resp, err := c.sendOnce(ctx, openid, msg)
	if err == nil {
		return resp, nil
	}
	if hasReplyContext(msg) && isReplyContextFailure(err) {
		c.log.Warn("被动回复上下文不可用，改发主动消息",
			"openid", RedactOpenID(openid), "err", err)
		msg.MsgID, msg.EventID, msg.MsgSeq = "", "", 0
		return c.sendOnce(ctx, openid, msg)
	}
	return nil, err
}

// sendOnce 带退避重试地发送一次构造好的消息。
func (c *Client) sendOnce(ctx context.Context, openid string, msg *qqbotsdk.Message) (*qqbotsdk.MessageResponse, error) {
	attempts := c.MaxAttempts
	if attempts < 1 {
		attempts = 1
	}
	delay := c.RetryDelay
	if delay <= 0 {
		delay = 500 * time.Millisecond
	}

	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		resp, err := c.api.SendC2CMessage(ctx, openid, msg)
		if err == nil {
			return resp, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			return nil, err
		}
		if attempt == attempts || !Retryable(err) {
			break
		}
		c.log.Debug("发送失败，稍后重试",
			"openid", openid, "attempt", attempt, "delay", delay, "err", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
		delay *= 2
	}
	return nil, lastErr
}

// Retryable 报告一次失败是否值得重试。
//
// 判断依据是平台错误码而非 message 文本：限频与服务端错误可重试，
// 认证/参数/业务错误重试没有意义。
func Retryable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var oae *qqbotsdk.OpenAPIError
	if errors.As(err, &oae) {
		switch {
		case oae.IsRateLimited(), oae.IsServerError(), oae.Retryable():
			return true
		case oae.IsAuthFailure(), oae.IsNotFound(), oae.IsMethodNotAllowed():
			return false
		}
		// 带业务错误码（body 里给了 err_code）说明是"这次请求本身不对"，
		// 重试无用；只有 HTTP 层失败（Code==0）才继续重试。
		return oae.Code == 0
	}
	// 传输层错误（连接被拒、TLS、超时等）：可重试。
	return true
}

func hasReplyContext(msg *qqbotsdk.Message) bool {
	return msg.MsgID != "" || msg.EventID != ""
}

// replyContextErrors 是"被动回复上下文不再可用"的错误码集合。
var replyContextErrors = []qqbotsdk.OpenAPIErrorCode{
	qqbotsdk.ErrPassiveReplyLimitExceeded,
	qqbotsdk.ErrReplyMsgIDExpired,
	qqbotsdk.ErrReplyMsgIDInvalid,
	qqbotsdk.ErrMessageIDExpiredCannotReply,
	qqbotsdk.ErrEventIDInvalid,
	qqbotsdk.ErrEventIDExpired,
	qqbotsdk.ErrEventNotRepliable,
}

func isReplyContextFailure(err error) bool {
	for _, code := range replyContextErrors {
		if qqbotsdk.IsOpenAPIError(err, code) {
			return true
		}
	}
	return false
}

// MarkdownKeyboard 用最简参数拼一个单行单按钮键盘。
//
// 平台要求：label ≤10 字符、permission 与 unsupport_tips 必填，
// 键盘只能挂在 markdown 消息上。
func MarkdownKeyboard(label, visitedLabel, data string) *qqbotsdk.Keyboard {
	button := qqbotsdk.Button{
		ID: "btn_1",
		RenderData: &qqbotsdk.RenderData{
			Label:        label,
			VisitedLabel: visitedLabel,
			Style:        qqbotsdk.KeyboardStyleBlue,
		},
		Action: &qqbotsdk.Action{
			Type:          qqbotsdk.ActionTypeCallback,
			Data:          data,
			Permission:    &qqbotsdk.Permission{Type: qqbotsdk.PermissionTypeEveryone},
			UnsupportTips: "请升级 QQ 客户端",
		},
	}
	return &qqbotsdk.Keyboard{Content: &qqbotsdk.KeyboardContent{
		Rows: []qqbotsdk.Row{{Buttons: []qqbotsdk.Button{button}}},
	}}
}

// RedactOpenID 用于日志：只留前 6 个字符。
func RedactOpenID(openid string) string {
	r := []rune(openid)
	if len(r) <= 6 {
		return string(r) + "…"
	}
	return string(r[:6]) + "…"
}
