package qq

import (
	"testing"

	qqbotsdk "github.com/fouc3/qq-bot-sdk"
)

// 引用消息（message_type=103）：被引用的文本要从 MsgElements 里带出来，
// 否则 AI 看不到用户在说哪一条（线上就是引用了却看不到）。
func TestDecideC2CExtractsQuote(t *testing.T) {
	allowAll := func(string) bool { return true }

	quoted := &qqbotsdk.C2CMessageCreateData{
		ID:          "MSG-QUOTE",
		MessageType: qqbotsdk.EventMsgTypeQuote,
		Content:     "这条渲染不对",
		Author:      &qqbotsdk.User{UserOpenID: "U1"},
		MsgElements: []qqbotsdk.MsgElement{
			// 第一层是空的，真内容在嵌套里（文档把 MsgElements 描述为递归结构）
			{MessageType: qqbotsdk.EventMsgTypeText, Content: "   ", MsgElements: []qqbotsdk.MsgElement{
				{MessageType: qqbotsdk.EventMsgTypeText, Content: "上一条 AI 回复的原文"},
			}},
		},
	}
	d := DecideC2C(quoted, allowAll)
	if !d.Forward {
		t.Fatalf("引用消息应转发，实际被丢弃：%s", d.Reason)
	}
	if d.Event.Quote != "上一条 AI 回复的原文" {
		t.Errorf("引用文本提取错误：%q", d.Event.Quote)
	}
	if d.Event.Text != "这条渲染不对" {
		t.Errorf("用户自己的文本应保留：%q", d.Event.Text)
	}

	// 只引用、不说话：也必须转发（否则"引用某条"这种用法直接失效）
	silent := *quoted
	silent.Content = ""
	d2 := DecideC2C(&silent, nil)
	if !d2.Forward || d2.Event.Text != "" || d2.Event.Quote == "" {
		t.Errorf("只引用不说话应转发且带引用：forward=%v text=%q quote=%q", d2.Forward, d2.Event.Text, d2.Event.Quote)
	}

	// 普通文本消息不该凭空多出引用
	plain := &qqbotsdk.C2CMessageCreateData{
		ID:          "MSG-PLAIN",
		MessageType: qqbotsdk.EventMsgTypeText,
		Content:     "hi",
		Author:      &qqbotsdk.User{UserOpenID: "U1"},
	}
	if got := DecideC2C(plain, nil); got.Event.Quote != "" {
		t.Errorf("普通消息不该有引用：%q", got.Event.Quote)
	}

	// 引用的是图片（无文本）时退回"非纯文本"丢弃，而不是造一条空消息
	image := &qqbotsdk.C2CMessageCreateData{
		ID:          "MSG-IMG",
		MessageType: qqbotsdk.EventMsgTypeQuote,
		Author:      &qqbotsdk.User{UserOpenID: "U1"},
		MsgElements: []qqbotsdk.MsgElement{{MessageType: qqbotsdk.EventMsgTypeParallel}},
	}
	if got := DecideC2C(image, nil); got.Forward {
		t.Errorf("没有文本可用的引用应丢弃：%+v", got.Event)
	}
}
