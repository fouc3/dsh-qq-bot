package qq

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	qqbotsdk "github.com/fouc3/qq-bot-sdk"
)

// Event 是归一化后交给 dsh 插件的 QQ 事件（对应协议里的 event op）。
type Event struct {
	Kind       string `json:"kind"`
	OpenID     string `json:"openid,omitempty"`
	Text       string `json:"text,omitempty"`
	MsgID      string `json:"msgId,omitempty"`
	EventID    string `json:"eventId,omitempty"`
	ButtonData string `json:"buttonData,omitempty"`
	At         string `json:"at,omitempty"`
}

// Emitter 把归一化事件交给本地通道。
type Emitter func(ctx context.Context, ev Event) error

// Registrar 是登记事件处理器的能力（*qqbotsdk.Client 满足）。
type Registrar interface {
	RegisterFunc(eventType string, handler func(context.Context, *qqbotsdk.Event) error) *qqbotsdk.Registration
}

var _ Registrar = (*qqbotsdk.Client)(nil)

// 白名单拒绝的原因常量：日志层要用它们判断"是否该打完整 openid"。
const (
	// ReasonNotAllowed 是非白名单账号发来的私聊消息。
	ReasonNotAllowed = "非白名单用户"
	// ReasonNotAllowedTap 是非白名单账号点了按钮。
	ReasonNotAllowedTap = "非白名单用户点击按钮"
)

// EventKind 取值。
const (
	KindC2CMessage  = "c2c_message"
	KindInteraction = "interaction"
	KindReady       = "ready"
)

// Decision 是对一条 QQ 事件的处置决定。
//
// 把"解码 + 判断"从"登记处理器"里拆出来，是为了让门守逻辑能被单测覆盖：
// 处理器本身只剩转发与日志。
type Decision struct {
	// Forward 为真表示要转发给 dsh 插件。
	Forward bool
	// Event 是转发内容（Forward 为真时有效）。
	Event Event
	// Respond 非 nil 表示要先回应这个互动码（按钮互动被拒时用）。
	Respond *qqbotsdk.InteractionCode
	// OpenID 是事件来源（日志用，可能为空）。
	OpenID string
	// Reason 非空表示丢弃原因。
	Reason string
}

// DecideC2C 决定一条单聊消息的去向。
func DecideC2C(data *qqbotsdk.C2CMessageCreateData, allowed func(string) bool) Decision {
	if data == nil {
		return Decision{Reason: "事件体为空"}
	}
	openid := ""
	if data.Author != nil {
		// 单聊消息里官方给的就是 author.user_openid：SDK 的 User.UserOpenID
		// （api_message.go，json tag `user_openid`），已对照 SDK 源码确认。
		openid = data.Author.UserOpenID
	}
	if openid == "" {
		return Decision{Reason: "缺少单聊 openid"}
	}
	if allowed != nil && !allowed(openid) {
		return Decision{OpenID: openid, Reason: ReasonNotAllowed}
	}
	text := strings.TrimSpace(data.Content)
	if text == "" {
		if data.MessageType != qqbotsdk.EventMsgTypeText {
			return Decision{OpenID: openid, Reason: fmt.Sprintf("非纯文本消息（message_type=%d, attachments=%d）", data.MessageType, len(data.Attachments))}
		}
		return Decision{OpenID: openid, Reason: "空文本"}
	}
	return Decision{
		Forward: true,
		OpenID:  openid,
		Event: Event{
			Kind:   KindC2CMessage,
			OpenID: openid,
			Text:   text,
			MsgID:  data.ID,
			At:     nowRFC3339(),
		},
	}
}

// DecideInteraction 决定一次按钮互动的去向。
func DecideInteraction(data *qqbotsdk.InteractionCreateData, allowed func(string) bool) Decision {
	if data == nil {
		return Decision{Reason: "事件体为空"}
	}
	if !data.NeedsResponse() {
		return Decision{Reason: fmt.Sprintf("无需回应的互动类型（type=%d）", data.Type)}
	}

	openid := data.UserOpenID
	buttonData, messageID := "", ""
	if data.Data != nil && data.Data.Resolved != nil {
		// 单聊场景平台在顶层给 user_openid；为空时回退到 Resolved.user_id，
		// 并在日志里留痕，方便线上核对平台的字段填法
		// （SDK 仓库的本地 fixture 只覆盖了群场景）。
		if openid == "" {
			openid = data.Data.Resolved.UserID
		}
		buttonData = data.Data.Resolved.ButtonData
		messageID = data.Data.Resolved.MessageID
	}
	if openid == "" {
		return Decision{Reason: "互动事件缺少 openid（单聊字段为空）"}
	}
	if allowed != nil && !allowed(openid) {
		deny := qqbotsdk.InteractionCodeNoPermission
		return Decision{OpenID: openid, Respond: &deny, Reason: ReasonNotAllowedTap}
	}
	return Decision{
		Forward: true,
		OpenID:  openid,
		Event: Event{
			Kind:       KindInteraction,
			OpenID:     openid,
			ButtonData: buttonData,
			EventID:    data.ID,
			MsgID:      messageID,
			At:         nowRFC3339(),
		},
	}
}

// logDrop 记一条"丢弃"日志。
//
// 白名单拒绝时故意打**完整 openid**：这是引导用户把自己的 openid 填进
// config.yaml 的唯一途径（openid 只能从事件里拿）。其他原因仍保持脱敏。
func logDrop(log *slog.Logger, msg string, d Decision) {
	if d.Reason == ReasonNotAllowed || d.Reason == ReasonNotAllowedTap {
		log.Warn(msg,
			"reason", d.Reason,
			"openid", d.OpenID,
			"hint", "把上面的 openid 填进 config.yaml 的 whitelist.users[]（该条可加 panel: true 绑定指令面板），然后重启网关",
		)
		return
	}
	log.Warn(msg, "reason", d.Reason, "openid", RedactOpenID(d.OpenID))
}

// RegisterHandlers 登记单聊消息、按钮互动与就绪事件。
//
// 处理器只做三件事：解码、按 Decision 处置、交给 emit。
// **绝不在这里等待 dsh 插件**：QQ 的事件分发是并发的，等插件会把投递拖慢。
func RegisterHandlers(reg Registrar, client *Client, allowed func(string) bool, emit Emitter, log *slog.Logger) []*qqbotsdk.Registration {
	if log == nil {
		log = slog.Default()
	}

	onC2C := func(ctx context.Context, e *qqbotsdk.Event) error {
		value, err := e.Decode()
		if err != nil {
			return fmt.Errorf("解码单聊事件失败：%w", err)
		}
		data, ok := value.(*qqbotsdk.C2CMessageCreateData)
		if !ok {
			return fmt.Errorf("单聊事件体类型意外：%T", value)
		}
		d := DecideC2C(data, allowed)
		if !d.Forward {
			logDrop(log, "丢弃私聊消息（不在白名单）", d)
			return nil
		}
		return emit(ctx, d.Event)
	}

	onInteraction := func(ctx context.Context, e *qqbotsdk.Event) error {
		value, err := e.Decode()
		if err != nil {
			return fmt.Errorf("解码互动事件失败：%w", err)
		}
		data, ok := value.(*qqbotsdk.InteractionCreateData)
		if !ok {
			return fmt.Errorf("互动事件体类型意外：%T", value)
		}
		d := DecideInteraction(data, allowed)
		if d.Respond != nil {
			if err := client.Respond(ctx, data.ID, *d.Respond); err != nil {
				log.Warn("回应互动失败", "err", err, "interaction", data.ID)
			}
		}
		if !d.Forward {
			logDrop(log, "丢弃按钮互动", d)
			return nil
		}
		return emit(ctx, d.Event)
	}

	onReady := func(ctx context.Context, e *qqbotsdk.Event) error {
		log.Info("QQ 长连接就绪")
		return emit(ctx, Event{Kind: KindReady, At: nowRFC3339()})
	}

	return []*qqbotsdk.Registration{
		reg.RegisterFunc(qqbotsdk.EventC2CMessageCreate, onC2C),
		reg.RegisterFunc(qqbotsdk.EventInteractionCreate, onInteraction),
		reg.RegisterFunc(qqbotsdk.EventReady, onReady),
	}
}

func nowRFC3339() string { return time.Now().Format(time.RFC3339) }
