package qq

import (
	"context"
	"errors"
	"strings"
	"testing"

	qqbotsdk "github.com/fouc3/qq-bot-sdk"
)

func TestSendPlainTextUsesTextType(t *testing.T) {
	api := &stubAPI{}
	c := newTestClient(api)

	if _, err := c.Send(context.Background(), Message{OpenID: "U1", Content: "你好"}); err != nil {
		t.Fatalf("发送失败：%v", err)
	}
	got := api.calls[0]
	if got.MsgType != qqbotsdk.MsgTypeText {
		t.Errorf("不带键盘且未开 md 时应发纯文本，msg_type=%d", got.MsgType)
	}
	if got.Content != "你好" || got.Markdown != nil {
		t.Errorf("纯文本消息应只填 content：%+v", got)
	}
}

func TestSendMarkdownFlagUsesMarkdownType(t *testing.T) {
	api := &stubAPI{}
	c := newTestClient(api)

	if _, err := c.Send(context.Background(), Message{OpenID: "U1", Content: "**粗体**", Markdown: true}); err != nil {
		t.Fatalf("发送失败：%v", err)
	}
	got := api.calls[0]
	if got.MsgType != qqbotsdk.MsgTypeMarkdown || got.Markdown == nil || got.Markdown.Content != "**粗体**" {
		t.Errorf("开了 md 开关应按 markdown 发送：%+v", got)
	}
}

// 出站 markdown 的换行要过 HardenMarkdown（QQ 把单换行渲染成空格，见 markdown.go）：
// markdown 消息补空行，纯文本消息原样不动。
func TestSendHardensMarkdownLineBreaks(t *testing.T) {
	api := &stubAPI{}
	c := newTestClient(api)

	if _, err := c.Send(context.Background(), Message{
		OpenID: "U1", Markdown: true,
		Content: "作用：把常用会话存成快捷入口\n用法：快捷 加 / 快捷 #2",
	}); err != nil {
		t.Fatalf("发送失败：%v", err)
	}
	got := api.calls[0]
	want := "作用：把常用会话存成快捷入口\n\n用法：快捷 加 / 快捷 #2"
	if got.Markdown == nil || got.Markdown.Content != want {
		t.Errorf("markdown 正文应补空行：\n得到 %q\n期望 %q", got.Markdown.Content, want)
	}

	// 纯文本（msg_type=0）不动：那边的换行行为没有文档保证，不能乱补空行
	if _, err := c.Send(context.Background(), Message{OpenID: "U1", Content: "第一行\n第二行"}); err != nil {
		t.Fatalf("发送失败：%v", err)
	}
	if text := api.calls[1].Content; text != "第一行\n第二行" {
		t.Errorf("纯文本不该被改写：%q", text)
	}

	// 带键盘的卡片会被强制 markdown：同样要补空行
	if _, err := c.Send(context.Background(), Message{
		OpenID: "U1", Content: "选一个\n> 第 1 页", Keyboard: MarkdownKeyboard("加当前会话", "", "qqb:sc:add"),
	}); err != nil {
		t.Fatalf("发送失败：%v", err)
	}
	if md := api.calls[2].Markdown; md == nil || md.Content != "选一个\n\n> 第 1 页" {
		t.Errorf("带键盘的卡片也要补空行：%+v", api.calls[2].Markdown)
	}
}

func TestSendKeyboardForcesMarkdown(t *testing.T) {
	api := &stubAPI{}
	c := newTestClient(api)

	// 平台只在 markdown 消息上承载键盘：挂到纯文本上会被静默丢掉按钮，
	// 所以哪怕调用方没开 md 开关，带键盘也必须走 markdown。
	kb := MarkdownKeyboard("我需要回复", "已触发", "qqb:needreply:session-1")
	resp, err := c.Send(context.Background(), Message{
		OpenID: "U1", Content: "session-1已结束", Keyboard: kb, ReplyToMsgID: "M1", MsgSeq: 1,
	})
	if err != nil {
		t.Fatalf("发送失败：%v", err)
	}
	if resp == nil || resp.ID == "" {
		t.Fatalf("应返回平台消息 id：%+v", resp)
	}
	got := api.calls[0]
	if got.MsgType != qqbotsdk.MsgTypeMarkdown {
		t.Errorf("带键盘必须用 markdown，msg_type=%d", got.MsgType)
	}
	if got.Content != "" {
		t.Errorf("markdown 消息不应同时填 content：%q", got.Content)
	}
	if got.Keyboard == nil || got.Keyboard.Content == nil || len(got.Keyboard.Content.Rows) != 1 {
		t.Fatalf("键盘未透传：%+v", got.Keyboard)
	}
	btn := got.Keyboard.Content.Rows[0].Buttons[0]
	if btn.Action.Type != qqbotsdk.ActionTypeCallback || btn.Action.Data != "qqb:needreply:session-1" {
		t.Errorf("按钮应为回调按钮并带上 data：%+v", btn.Action)
	}
	if btn.RenderData.Label != "我需要回复" || btn.RenderData.VisitedLabel != "已触发" {
		t.Errorf("按钮文案不对：%+v", btn.RenderData)
	}
	if btn.Action.Permission == nil || btn.Action.UnsupportTips == "" {
		t.Errorf("按钮必填项缺失（permission / unsupport_tips）：%+v", btn.Action)
	}
	if got.MsgID != "M1" || got.MsgSeq != 1 {
		t.Errorf("被动回复上下文丢失：msg_id=%q msg_seq=%d", got.MsgID, got.MsgSeq)
	}
}

func TestSendValidatesInput(t *testing.T) {
	api := &stubAPI{}
	c := newTestClient(api)

	if _, err := c.Send(context.Background(), Message{Content: "x"}); err == nil {
		t.Error("缺少 openid 应当报错")
	}
	if _, err := c.Send(context.Background(), Message{OpenID: "U1", Content: "   "}); err == nil {
		t.Error("空正文应当报错")
	}
	if len(api.calls) != 0 {
		t.Errorf("校验失败不该真的发请求，实际发了 %d 次", len(api.calls))
	}
}

func TestSendRetriesTransientFailure(t *testing.T) {
	attempts := 0
	api := &stubAPI{send: func(context.Context, string, *qqbotsdk.Message) (*qqbotsdk.MessageResponse, error) {
		attempts++
		if attempts < 3 {
			return nil, &qqbotsdk.OpenAPIError{StatusCode: 500, Message: "服务端抖动"}
		}
		return &qqbotsdk.MessageResponse{ID: "OK"}, nil
	}}
	c := newTestClient(api)

	resp, err := c.Send(context.Background(), Message{OpenID: "U1", Content: "hi"})
	if err != nil {
		t.Fatalf("重试后应成功：%v", err)
	}
	if resp.ID != "OK" || attempts != 3 {
		t.Errorf("应重试到第 3 次成功，实际 attempts=%d resp=%+v", attempts, resp)
	}
}

func TestSendDoesNotRetryBusinessError(t *testing.T) {
	attempts := 0
	api := &stubAPI{send: func(context.Context, string, *qqbotsdk.Message) (*qqbotsdk.MessageResponse, error) {
		attempts++
		return nil, &qqbotsdk.OpenAPIError{StatusCode: 200, Code: qqbotsdk.ErrMessageContentViolation, Message: "内容不合规"}
	}}
	c := newTestClient(api)

	if _, err := c.Send(context.Background(), Message{OpenID: "U1", Content: "hi"}); err == nil {
		t.Fatal("业务错误应返回失败")
	}
	if attempts != 1 {
		t.Errorf("业务错误不该重试，实际 attempts=%d", attempts)
	}
}

func TestSendFallsBackToActiveMessage(t *testing.T) {
	api := &stubAPI{}
	api.send = func(_ context.Context, _ string, msg *qqbotsdk.Message) (*qqbotsdk.MessageResponse, error) {
		if msg.MsgID != "" || msg.EventID != "" {
			return nil, &qqbotsdk.OpenAPIError{StatusCode: 200, Code: qqbotsdk.ErrPassiveReplyLimitExceeded, Message: "被动回复超限"}
		}
		return &qqbotsdk.MessageResponse{ID: "ACTIVE"}, nil
	}
	c := newTestClient(api)

	resp, err := c.Send(context.Background(), Message{OpenID: "U1", Content: "hi", ReplyToMsgID: "M1", MsgSeq: 4})
	if err != nil {
		t.Fatalf("被动上下文失效后应改发主动消息：%v", err)
	}
	if resp.ID != "ACTIVE" {
		t.Errorf("应拿到主动消息的 id：%+v", resp)
	}
	if len(api.calls) != 2 {
		t.Fatalf("应当先被动、再主动，共 2 次调用，实际 %d", len(api.calls))
	}
	if api.calls[0].MsgID != "M1" || api.calls[1].MsgID != "" || api.calls[1].EventID != "" || api.calls[1].MsgSeq != 0 {
		t.Errorf("降级后的消息应清空被动上下文：%+v", api.calls[1])
	}
}

func TestSendDoesNotFallBackOnUnrelatedFailure(t *testing.T) {
	api := &stubAPI{send: func(context.Context, string, *qqbotsdk.Message) (*qqbotsdk.MessageResponse, error) {
		return nil, &qqbotsdk.OpenAPIError{StatusCode: 401, Message: "认证失败"}
	}}
	c := newTestClient(api)

	if _, err := c.Send(context.Background(), Message{OpenID: "U1", Content: "hi", ReplyToMsgID: "M1", MsgSeq: 1}); err == nil {
		t.Fatal("认证失败不该被当成被动上下文失效")
	}
	if len(api.calls) != 1 {
		t.Errorf("认证失败应立即失败，实际调用 %d 次", len(api.calls))
	}
}

func TestRetryable(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"限频", &qqbotsdk.OpenAPIError{StatusCode: 429}, true},
		{"服务端错误", &qqbotsdk.OpenAPIError{StatusCode: 500}, true},
		{"认证失败", &qqbotsdk.OpenAPIError{StatusCode: 401}, false},
		{"未找到", &qqbotsdk.OpenAPIError{StatusCode: 404}, false},
		{"业务错误码", &qqbotsdk.OpenAPIError{StatusCode: 200, Code: qqbotsdk.ErrMsgTypeMismatch}, false},
		{"传输层错误", errors.New("connection refused"), true},
		{"上下文取消", context.Canceled, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Retryable(tc.err); got != tc.want {
				t.Errorf("Retryable(%v) = %v，期望 %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestRedactOpenID(t *testing.T) {
	if got := RedactOpenID("ABCDEF1234567890"); !strings.HasPrefix(got, "ABCDEF") || strings.Contains(got, "1234567890") {
		t.Errorf("应遮蔽后半段：%q", got)
	}
	if got := RedactOpenID("AB"); got != "AB…" {
		t.Errorf("短 openid：%q", got)
	}
}
