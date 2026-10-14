package qq

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	qqbotsdk "github.com/fouc3/qq-bot-sdk"
)

// stubAPI 只覆写被测代码真正调到的方法。
//
// 嵌入 API 接口后，未覆写的方法保持 nil：一旦代码路径碰到了它们，
// 测试会直接 panic —— 这正是我们要的"失败得响亮"，而不是静默通过。
type stubAPI struct {
	API

	send    func(ctx context.Context, openid string, msg *qqbotsdk.Message) (*qqbotsdk.MessageResponse, error)
	respond func(ctx context.Context, interactionID string, code qqbotsdk.InteractionCode) error
	recall  func(ctx context.Context, openid, messageID string) error

	calls     []*qqbotsdk.Message
	openids   []string
	responses []interactionResponse
	recalls   []string
}

type interactionResponse struct {
	ID   string
	Code qqbotsdk.InteractionCode
}

func (s *stubAPI) SendC2CMessage(ctx context.Context, openid string, msg *qqbotsdk.Message) (*qqbotsdk.MessageResponse, error) {
	// 记一份浅拷贝：降级路径会在原地改 msg（清空被动上下文），
	// 若存指针，第一次调用的快照会被后来的修改污染。
	snapshot := *msg
	s.calls = append(s.calls, &snapshot)
	s.openids = append(s.openids, openid)
	if s.send == nil {
		return &qqbotsdk.MessageResponse{ID: "MSG"}, nil
	}
	return s.send(ctx, openid, msg)
}

func (s *stubAPI) RespondInteraction(ctx context.Context, interactionID string, code qqbotsdk.InteractionCode) error {
	s.responses = append(s.responses, interactionResponse{ID: interactionID, Code: code})
	if s.respond == nil {
		return nil
	}
	return s.respond(ctx, interactionID, code)
}

func (s *stubAPI) RecallC2CMessage(ctx context.Context, openid, messageID string) error {
	s.recalls = append(s.recalls, openid+"/"+messageID)
	if s.recall == nil {
		return nil
	}
	return s.recall(ctx, openid, messageID)
}

func newTestClient(api API) *Client {
	c := New(api, nil)
	c.RetryDelay = time.Millisecond
	return c
}

// c2cEvent 造一条真实的单聊事件（Payload → Decode 走 SDK 自己的解码路径）。
func c2cEvent(t *testing.T, openid, content, msgID string, msgType int) *qqbotsdk.Event {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"id":           msgID,
		"author":       map[string]any{"user_openid": openid},
		"content":      content,
		"message_type": msgType,
	})
	if err != nil {
		t.Fatal(err)
	}
	return qqbotsdk.NewEvent(&qqbotsdk.Payload{
		ID:   "EVT-" + msgID,
		Op:   qqbotsdk.OpDispatch,
		Type: qqbotsdk.EventC2CMessageCreate,
		Data: body,
	}, "test")
}

// interactionEvent 造一条按钮互动事件。
func interactionEvent(t *testing.T, openid, userID, buttonData, messageID, interactionID string, typ int) *qqbotsdk.Event {
	t.Helper()
	resolved := map[string]any{
		"button_data": buttonData,
		"message_id":  messageID,
	}
	if userID != "" {
		resolved["user_id"] = userID
	}
	payload := map[string]any{
		"id":   interactionID,
		"type": typ,
		"data": map[string]any{"type": typ, "resolved": resolved},
	}
	if openid != "" {
		payload["user_openid"] = openid
	}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return qqbotsdk.NewEvent(&qqbotsdk.Payload{
		ID:   "EVT-" + interactionID,
		Op:   qqbotsdk.OpDispatch,
		Type: qqbotsdk.EventInteractionCreate,
		Data: body,
	}, "test")
}

// stubRegistrar 用一个真 Dispatcher 承接登记，用来拿到处理器并安全地取消。
type stubRegistrar struct {
	dispatcher *qqbotsdk.Dispatcher
	handlers   map[string]func(context.Context, *qqbotsdk.Event) error
}

func newStubRegistrar() *stubRegistrar {
	return &stubRegistrar{
		dispatcher: qqbotsdk.NewDispatcher(),
		handlers:   map[string]func(context.Context, *qqbotsdk.Event) error{},
	}
}

func (s *stubRegistrar) RegisterFunc(eventType string, handler func(context.Context, *qqbotsdk.Event) error) *qqbotsdk.Registration {
	s.handlers[eventType] = handler
	return s.dispatcher.Register(eventType, qqbotsdk.EventHandlerFunc(handler))
}

// newEmitter 返回一个把事件收集到 sink 的 Emitter。
func newEmitter(sink *[]Event) Emitter {
	return func(_ context.Context, ev Event) error {
		*sink = append(*sink, ev)
		return nil
	}
}
