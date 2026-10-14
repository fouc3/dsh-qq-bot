package qq

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	qqbotsdk "github.com/fouc3/qq-bot-sdk"
)

// allowOne 是"只放行 OPENID-A"的门守，多个用例共用。
func allowOne(openid string) bool { return openid == "OPENID-A" }

func TestDecideC2C(t *testing.T) {

	cases := []struct {
		name        string
		data        *qqbotsdk.C2CMessageCreateData
		allowed     func(string) bool
		wantForward bool
		wantReason  string
	}{
		{
			name:       "空事件体",
			data:       nil,
			wantReason: "事件体为空",
		},
		{
			name:       "缺少作者",
			data:       &qqbotsdk.C2CMessageCreateData{ID: "M1", Content: "hi"},
			wantReason: "缺少单聊 openid",
		},
		{
			name: "非白名单用户",
			data: &qqbotsdk.C2CMessageCreateData{
				ID: "M1", Content: "hi",
				Author: &qqbotsdk.User{UserOpenID: "OPENID-X"},
			},
			allowed:     allowOne,
			wantForward: false,
			wantReason:  "非白名单用户",
		},
		{
			name: "白名单内正常文本",
			data: &qqbotsdk.C2CMessageCreateData{
				ID: "M9", Content: "  你好  ", MessageType: qqbotsdk.EventMsgTypeText,
				Author: &qqbotsdk.User{UserOpenID: "OPENID-A"},
			},
			allowed:     allowOne,
			wantForward: true,
		},
		{
			name: "纯文本但内容为空",
			data: &qqbotsdk.C2CMessageCreateData{
				ID: "M2", Content: "   ", MessageType: qqbotsdk.EventMsgTypeText,
				Author: &qqbotsdk.User{UserOpenID: "OPENID-A"},
			},
			allowed:     allowOne,
			wantForward: false,
			wantReason:  "空文本",
		},
		{
			name: "非文本消息且没有可读内容（空 ark 卡片）",
			data: &qqbotsdk.C2CMessageCreateData{
				ID: "M3", Content: "", MessageType: 3,
				Author: &qqbotsdk.User{UserOpenID: "OPENID-A"},
			},
			allowed:     allowOne,
			wantForward: false,
			wantReason:  "非文本消息且没有可读内容",
		},
		{
			name: "不配置白名单时不做门守（供单测/灰度）",
			data: &qqbotsdk.C2CMessageCreateData{
				ID: "M4", Content: "hi", MessageType: qqbotsdk.EventMsgTypeText,
				Author: &qqbotsdk.User{UserOpenID: "OPENID-Z"},
			},
			allowed:     nil,
			wantForward: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DecideC2C(tc.data, tc.allowed)
			if got.Forward != tc.wantForward {
				t.Fatalf("Forward = %v，期望 %v（reason=%q）", got.Forward, tc.wantForward, got.Reason)
			}
			if tc.wantReason != "" && !strings.Contains(got.Reason, tc.wantReason) {
				t.Errorf("Reason = %q，应包含 %q", got.Reason, tc.wantReason)
			}
			if tc.wantForward {
				if got.Event.Kind != KindC2CMessage {
					t.Errorf("Kind = %q", got.Event.Kind)
				}
				if got.Event.Text != strings.TrimSpace(tc.data.Content) {
					t.Errorf("Text = %q，应去掉首尾空白", got.Event.Text)
				}
				if got.Event.MsgID != tc.data.ID {
					t.Errorf("MsgID = %q，期望 %q", got.Event.MsgID, tc.data.ID)
				}
				if got.Event.At == "" {
					t.Error("At 应带上时间戳")
				}
			}
		})
	}

	t.Run("转发时保留原始正文的语义", func(t *testing.T) {
		got := DecideC2C(&qqbotsdk.C2CMessageCreateData{
			ID: "M1", Content: "第一行\n第二行", MessageType: qqbotsdk.EventMsgTypeText,
			Author: &qqbotsdk.User{UserOpenID: "OPENID-A"},
		}, allowOne)
		if got.Event.Text != "第一行\n第二行" {
			t.Errorf("内部换行不该被压掉：%q", got.Event.Text)
		}
	})
}

// 附件与 ark 卡片必须能被转发：以前只认文字，"发张图给 AI 看"根本进不来。
func TestDecideC2CForwardsAttachments(t *testing.T) {
	author := &qqbotsdk.User{UserOpenID: "OPENID-A"}

	t.Run("图片消息：没有文字也要转发，并归一化成 image", func(t *testing.T) {
		got := DecideC2C(&qqbotsdk.C2CMessageCreateData{
			ID: "M-IMG", Content: "", MessageType: 7,
			Author: author,
			Attachments: []qqbotsdk.MessageAttachment{{
				URL: "https://multimedia.nt.qq.com.cn/download?fileid=abc", Filename: "cat.png",
				Size: 2048, ContentType: qqbotsdk.AttachmentContentTypePNG,
			}},
		}, allowOne)
		if !got.Forward {
			t.Fatalf("图片消息应转发，reason=%q", got.Reason)
		}
		if len(got.Event.Attachments) != 1 {
			t.Fatalf("Attachments = %d，期望 1", len(got.Event.Attachments))
		}
		item := got.Event.Attachments[0]
		if item.Kind != AttachmentKindImage || item.Filename != "cat.png" || item.Size != 2048 {
			t.Errorf("附件归一化不对：%+v", item)
		}
		if !strings.Contains(item.URL, "fileid=abc") {
			t.Errorf("下载地址应原样带着：%q", item.URL)
		}
	})

	t.Run("语音：平台转写跟着走；没有转写时 asrText 为空（插件侧要拦住发送）", func(t *testing.T) {
		got := DecideC2C(&qqbotsdk.C2CMessageCreateData{
			ID: "M-VOICE", MessageType: 7, Author: author,
			Attachments: []qqbotsdk.MessageAttachment{
				{URL: "https://x/voice.silk", ContentType: qqbotsdk.AttachmentContentTypeVoice, ASRReferText: "帮我看看这个 bug"},
				{URL: "https://x/voice2.silk", ContentType: qqbotsdk.AttachmentContentTypeVoice, VoiceWavURL: "https://x/voice2.wav"},
			},
		}, allowOne)
		if !got.Forward || len(got.Event.Attachments) != 2 {
			t.Fatalf("Forward=%v len=%d", got.Forward, len(got.Event.Attachments))
		}
		if got.Event.Attachments[0].Kind != AttachmentKindVoice {
			t.Errorf("Kind = %q", got.Event.Attachments[0].Kind)
		}
		if got.Event.Attachments[0].ASRText != "帮我看看这个 bug" {
			t.Errorf("转写文本要原样带上：%q", got.Event.Attachments[0].ASRText)
		}
		if got.Event.Attachments[1].ASRText != "" {
			t.Errorf("没有转写就该是空的：%q", got.Event.Attachments[1].ASRText)
		}
		if got.Event.Attachments[1].VoiceWavURL != "https://x/voice2.wav" {
			t.Errorf("wav 地址要留档：%q", got.Event.Attachments[1].VoiceWavURL)
		}
	})

	t.Run("视频与未知类型分别归一化", func(t *testing.T) {
		got := DecideC2C(&qqbotsdk.C2CMessageCreateData{
			ID: "M-MEDIA", MessageType: 7, Author: author,
			Attachments: []qqbotsdk.MessageAttachment{
				{URL: "https://x/a.mp4", ContentType: qqbotsdk.AttachmentContentTypeMP4},
				{URL: "https://x/b.bin", ContentType: "application/octet-stream"},
			},
		}, allowOne)
		if got.Event.Attachments[0].Kind != AttachmentKindVideo {
			t.Errorf("Kind = %q，期望 video", got.Event.Attachments[0].Kind)
		}
		if got.Event.Attachments[1].Kind != AttachmentKindUnknown {
			t.Errorf("Kind = %q，期望 unknown", got.Event.Attachments[1].Kind)
		}
	})

	t.Run("没有下载地址的附件被丢掉，不产生空条目", func(t *testing.T) {
		got := DecideC2C(&qqbotsdk.C2CMessageCreateData{
			ID: "M-NOURL", Content: "", MessageType: 7, Author: author,
			Attachments: []qqbotsdk.MessageAttachment{{ContentType: qqbotsdk.AttachmentContentTypePNG}},
		}, allowOne)
		if got.Forward {
			t.Fatal("没有可下载内容的附件消息不该转发")
		}
		if !strings.Contains(got.Reason, "没有可读内容") {
			t.Errorf("Reason = %q", got.Reason)
		}
	})

	t.Run("文字 + 附件混发：两样都带上", func(t *testing.T) {
		got := DecideC2C(&qqbotsdk.C2CMessageCreateData{
			ID: "M-MIX", Content: " 看看这张图 ", MessageType: 7, Author: author,
			Attachments: []qqbotsdk.MessageAttachment{{URL: "https://x/1.jpg", ContentType: qqbotsdk.AttachmentContentTypeJPEG}},
		}, allowOne)
		if !got.Forward || got.Event.Text != "看看这张图" || len(got.Event.Attachments) != 1 {
			t.Fatalf("混发应同时带上文字与附件：%+v", got.Event)
		}
	})

	t.Run("ark 卡片：抽标题/描述/跳转链接，没有文字也能转发", func(t *testing.T) {
		got := DecideC2C(&qqbotsdk.C2CMessageCreateData{
			ID: "M-ARK", Content: "", MessageType: qqbotsdk.EventMsgTypeArk, Author: author,
			ArkData: &qqbotsdk.ARKData{
				ArkType: qqbotsdk.ARKTypeTuwen, ArkName: "图文", Prompt: "[QQ小程序]",
				Fields: map[string]any{"title": "某篇文章", "desc": "摘要文字", "jump_url": "https://example.com/a"},
			},
		}, allowOne)
		if !got.Forward {
			t.Fatalf("带内容的 ark 卡片应转发，reason=%q", got.Reason)
		}
		if got.Event.Ark == nil || got.Event.Ark.Title != "某篇文章" || got.Event.Ark.Desc != "摘要文字" || got.Event.Ark.URL != "https://example.com/a" {
			t.Fatalf("ark 摘要不对：%+v", got.Event.Ark)
		}
		if got.Event.Text != "" {
			t.Errorf("ark 卡片的文字不该被伪造：%q", got.Event.Text)
		}
	})
}

func TestDecideInteraction(t *testing.T) {
	allowOne := func(openid string) bool { return openid == "OPENID-A" }

	cases := []struct {
		name          string
		data          *qqbotsdk.InteractionCreateData
		wantForward   bool
		wantRespond   *qqbotsdk.InteractionCode
		wantReason    string
		wantButton    string
		wantMessageID string
	}{
		{
			name:       "空事件体",
			data:       nil,
			wantReason: "事件体为空",
		},
		{
			name:       "无需回应的互动类型",
			data:       &qqbotsdk.InteractionCreateData{ID: "I1", Type: 14, UserOpenID: "OPENID-A"},
			wantReason: "无需回应的互动类型",
		},
		{
			name:       "缺少 openid",
			data:       &qqbotsdk.InteractionCreateData{ID: "I2", Type: qqbotsdk.InteractionInlineKeyboard},
			wantReason: "互动事件缺少 openid",
		},
		{
			name: "非白名单用户：回拒绝码",
			data: &qqbotsdk.InteractionCreateData{
				ID: "I3", Type: qqbotsdk.InteractionInlineKeyboard, UserOpenID: "OPENID-X",
				Data: &qqbotsdk.InteractionData{Resolved: &qqbotsdk.InteractionResolved{ButtonData: "qqb:dir:/x"}},
			},
			wantForward: false,
			wantReason:  "非白名单用户点击按钮",
		},
		{
			name: "白名单内按钮点击",
			data: &qqbotsdk.InteractionCreateData{
				ID: "I4", Type: qqbotsdk.InteractionInlineKeyboard, UserOpenID: "OPENID-A",
				Data: &qqbotsdk.InteractionData{Resolved: &qqbotsdk.InteractionResolved{
					ButtonData: "qqb:needreply:session-42",
					MessageID:  "MSG-9",
				}},
			},
			wantForward:   true,
			wantButton:    "qqb:needreply:session-42",
			wantMessageID: "MSG-9",
		},
		{
			name: "openid 只在 resolved.user_id 时回退",
			data: &qqbotsdk.InteractionCreateData{
				ID: "I5", Type: qqbotsdk.InteractionInlineKeyboard,
				Data: &qqbotsdk.InteractionData{Resolved: &qqbotsdk.InteractionResolved{
					UserID:     "OPENID-A",
					ButtonData: "qqb:dir:/home",
				}},
			},
			wantForward: true,
			wantButton:  "qqb:dir:/home",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DecideInteraction(tc.data, allowOne)
			if got.Forward != tc.wantForward {
				t.Fatalf("Forward = %v，期望 %v（reason=%q）", got.Forward, tc.wantForward, got.Reason)
			}
			if tc.wantReason != "" && !strings.Contains(got.Reason, tc.wantReason) {
				t.Errorf("Reason = %q，应包含 %q", got.Reason, tc.wantReason)
			}
			if tc.name == "非白名单用户：回拒绝码" {
				if got.Respond == nil || *got.Respond != qqbotsdk.InteractionCodeNoPermission {
					t.Fatalf("应回应无权限码：%+v", got.Respond)
				}
			} else if got.Respond != nil {
				t.Errorf("不该回应互动码：%+v", got.Respond)
			}
			if tc.wantForward {
				if got.Event.Kind != KindInteraction {
					t.Errorf("Kind = %q", got.Event.Kind)
				}
				if got.Event.ButtonData != tc.wantButton {
					t.Errorf("ButtonData = %q，期望 %q", got.Event.ButtonData, tc.wantButton)
				}
				if got.Event.MsgID != tc.wantMessageID {
					t.Errorf("MsgID = %q，期望 %q", got.Event.MsgID, tc.wantMessageID)
				}
			}
		})
	}
}

func TestRegisterHandlersForwardsAllowedC2C(t *testing.T) {
	reg := newStubRegistrar()
	api := &stubAPI{}
	client := New(api, nil)

	var emitted []Event
	RegisterHandlers(reg, client, func(openid string) bool { return openid == "OPENID-A" }, newEmitter(&emitted), nil)

	handler, ok := reg.handlers[qqbotsdk.EventC2CMessageCreate]
	if !ok {
		t.Fatal("未登记单聊消息处理器")
	}

	if err := handler(context.Background(), c2cEvent(t, "OPENID-A", "在吗", "MSG-1", qqbotsdk.EventMsgTypeText)); err != nil {
		t.Fatalf("处理白名单消息失败：%v", err)
	}
	if len(emitted) != 1 {
		t.Fatalf("应转发 1 条事件，实际 %d", len(emitted))
	}
	if got := emitted[0]; got.Kind != KindC2CMessage || got.OpenID != "OPENID-A" || got.Text != "在吗" || got.MsgID != "MSG-1" {
		t.Errorf("转发内容不对：%+v", got)
	}

	if err := handler(context.Background(), c2cEvent(t, "OPENID-X", "在吗", "MSG-2", qqbotsdk.EventMsgTypeText)); err != nil {
		t.Fatalf("处理非白名单消息不该报错：%v", err)
	}
	if len(emitted) != 1 {
		t.Errorf("非白名单消息不该被转发，实际转发 %d 条", len(emitted))
	}
}

func TestRegisterHandlersDeniesUnlistedInteraction(t *testing.T) {
	reg := newStubRegistrar()
	api := &stubAPI{}
	client := New(api, nil)

	var emitted []Event
	RegisterHandlers(reg, client, func(openid string) bool { return openid == "OPENID-A" }, newEmitter(&emitted), nil)

	handler := reg.handlers[qqbotsdk.EventInteractionCreate]
	if handler == nil {
		t.Fatal("未登记互动处理器")
	}

	// 非白名单用户：回应「无权限」且不转发。
	denied := interactionEvent(t, "OPENID-X", "", "qqb:dir:/x", "MSG-9", "INT-1", qqbotsdk.InteractionInlineKeyboard)
	if err := handler(context.Background(), denied); err != nil {
		t.Fatalf("处理非白名单互动不该报错：%v", err)
	}
	if len(api.responses) != 1 {
		t.Fatalf("应回应一次互动，实际 %d", len(api.responses))
	}
	if got := api.responses[0]; got.Code != qqbotsdk.InteractionCodeNoPermission || got.ID != "INT-1" {
		t.Errorf("回应内容不对：%+v", got)
	}
	if len(emitted) != 0 {
		t.Errorf("非白名单互动不该转发，实际 %d 条", len(emitted))
	}

	// 白名单用户：转发，且不替业务回应（回应由插件决定语义）。
	allowed := interactionEvent(t, "OPENID-A", "", "qqb:needreply:session-42", "MSG-10", "INT-2", qqbotsdk.InteractionInlineKeyboard)
	if err := handler(context.Background(), allowed); err != nil {
		t.Fatalf("处理白名单互动失败：%v", err)
	}
	if len(emitted) != 1 {
		t.Fatalf("应转发 1 条互动事件，实际 %d", len(emitted))
	}
	if got := emitted[0]; got.ButtonData != "qqb:needreply:session-42" || got.EventID != "INT-2" || got.MsgID != "MSG-10" {
		t.Errorf("转发内容不对：%+v", got)
	}
	if len(api.responses) != 1 {
		t.Errorf("业务向互动不应在网关层回应，实际 %d 次", len(api.responses))
	}
}

func TestRespondIsIdempotent(t *testing.T) {
	api := &stubAPI{}
	client := New(api, nil)

	if err := client.Respond(context.Background(), "INT-9", qqbotsdk.InteractionCodeSuccess); err != nil {
		t.Fatal(err)
	}
	if err := client.Respond(context.Background(), "INT-9", qqbotsdk.InteractionCodeSuccess); err != nil {
		t.Fatal(err)
	}
	if len(api.responses) != 1 {
		t.Errorf("同一互动只应回应一次，实际 %d", len(api.responses))
	}
	if err := client.Respond(context.Background(), "", qqbotsdk.InteractionCodeSuccess); err == nil {
		t.Error("空 interaction id 应当报错")
	}
}

func TestRecallSurfacesTimeout(t *testing.T) {
	api := &stubAPI{
		recall: func(context.Context, string, string) error {
			return &qqbotsdk.OpenAPIError{StatusCode: 200, Code: qqbotsdk.ErrRecallTimeExceeded, Message: "超出撤回时限"}
		},
	}
	client := New(api, nil)

	err := client.Recall(context.Background(), "OPENID-A", "MSG-1")
	if err == nil || !strings.Contains(err.Error(), "超过撤回时限") {
		t.Fatalf("应把它识别为撤回超时：%v", err)
	}
	if err := client.Recall(context.Background(), "", ""); err == nil {
		t.Error("缺少参数应当报错")
	}
}

// 通道短暂不可用时（网关/插件重启窗口）不能把用户消息丢掉：
// 先失败几次、通道回来后必须投出去；窗口过完才允许放弃。
func TestEmitWithRetryKeepsEventThroughRestartWindow(t *testing.T) {
	oldWindow, oldBase, oldCap := emitRetryWindow, emitRetryBase, emitRetryCap
	t.Cleanup(func() { emitRetryWindow, emitRetryBase, emitRetryCap = oldWindow, oldBase, oldCap })
	emitRetryWindow, emitRetryBase, emitRetryCap = 500*time.Millisecond, time.Millisecond, 5*time.Millisecond

	calls := 0
	emit := func(context.Context, Event) error {
		calls++
		if calls < 3 {
			return errors.New("本地通道不可用（bridge.sock）：no such file or directory")
		}
		return nil
	}
	ev := Event{Kind: KindC2CMessage, OpenID: "U1", Text: "重启窗口里发的消息"}
	if err := emitWithRetry(context.Background(), emit, ev, nil); err != nil {
		t.Fatalf("通道恢复后应投递成功，却返回 %v", err)
	}
	if calls != 3 {
		t.Fatalf("应当在第 3 次成功，实际调用 %d 次", calls)
	}
}

func TestEmitWithRetryGivesUpAfterWindow(t *testing.T) {
	oldWindow, oldBase, oldCap := emitRetryWindow, emitRetryBase, emitRetryCap
	t.Cleanup(func() { emitRetryWindow, emitRetryBase, emitRetryCap = oldWindow, oldBase, oldCap })
	emitRetryWindow, emitRetryBase, emitRetryCap = 20*time.Millisecond, time.Millisecond, 5*time.Millisecond

	calls := 0
	emit := func(context.Context, Event) error {
		calls++
		return errors.New("本地通道不可用")
	}
	err := emitWithRetry(context.Background(), emit, Event{Kind: KindC2CMessage}, nil)
	if err == nil {
		t.Fatal("超窗口后必须如实报错")
	}
	if !strings.Contains(err.Error(), "重试") || !strings.Contains(err.Error(), "本地通道不可用") {
		t.Fatalf("错误里要能看出是重试后放弃：%v", err)
	}
	if calls < 2 {
		t.Fatalf("应当重试过，实际调用 %d 次", calls)
	}
}

func TestEmitWithRetryStopsOnCancel(t *testing.T) {
	oldWindow, oldBase, oldCap := emitRetryWindow, emitRetryBase, emitRetryCap
	t.Cleanup(func() { emitRetryWindow, emitRetryBase, emitRetryCap = oldWindow, oldBase, oldCap })
	emitRetryWindow, emitRetryBase, emitRetryCap = time.Minute, time.Hour, time.Hour

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := emitWithRetry(ctx, func(context.Context, Event) error { return errors.New("通道不可用") }, Event{Kind: KindC2CMessage}, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("取消后应立刻返回 context.Canceled，实际 %v", err)
	}
}
