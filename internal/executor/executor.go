// Package executor 执行 dsh 插件下发的出站命令，并把结果 ack 回插件。
package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	qqbotsdk "github.com/fouc3/qq-bot-sdk"

	"github.com/fouc3/dsh-qq-bot/internal/bridge"
	"github.com/fouc3/dsh-qq-bot/internal/qq"
)

// Acker 把命令结果回报给插件。
type Acker interface {
	Ack(ctx context.Context, a bridge.Ack) error
}

// Executor 执行出站命令（docs/protocol.md 第 4 节）。
type Executor struct {
	qq     *qq.Client
	acker  Acker
	dedupe *Dedupe
	media  qq.MediaConfig
	log    *slog.Logger
}

// New 构造执行器。
func New(client *qq.Client, acker Acker, dedupe *Dedupe, media qq.MediaConfig, log *slog.Logger) *Executor {
	if log == nil {
		log = slog.Default()
	}
	if dedupe == nil {
		dedupe = &Dedupe{limit: 512, seen: map[string]struct{}{}}
	}
	return &Executor{qq: client, acker: acker, dedupe: dedupe, media: media, log: log}
}

// Run 处理一批命令：逐条执行并逐条 ack。
func (e *Executor) Run(ctx context.Context, cmds []bridge.Command) {
	for _, cmd := range cmds {
		e.runOne(ctx, cmd)
	}
}

// PublishPanel 转发面板定义到 QQ（供启动与重连时调用）。
func (e *Executor) PublishPanel(ctx context.Context, def qq.PanelDefinition) error {
	return e.qq.PublishPanel(ctx, def)
}

func (e *Executor) runOne(ctx context.Context, cmd bridge.Command) {
	if cmd.ID == "" {
		e.log.Warn("出站命令缺少 id，跳过", "kind", cmd.Kind)
		return
	}
	if e.dedupe.Seen(cmd.ID) {
		// 重投但已经成功执行过：补一个 ack 让队列消费掉它。
		e.log.Debug("命令已执行过，仅补 ack", "id", cmd.ID, "kind", cmd.Kind)
		e.ack(ctx, bridge.Ack{ID: cmd.ID, OK: true})
		return
	}

	messageID, err := e.execute(ctx, cmd)
	if err != nil {
		e.log.Warn("出站命令执行失败", "id", cmd.ID, "kind", cmd.Kind, "err", err)
		// ok:false 不消费命令：插件会重新下发，作为一次重试机会。
		e.ack(ctx, bridge.Ack{ID: cmd.ID, OK: false, Error: err.Error(), ErrorCode: platformCode(err)})
		return
	}
	if err := e.dedupe.Mark(cmd.ID); err != nil {
		e.log.Warn("记录已执行命令失败（进程重启后可能重复发送一次）", "id", cmd.ID, "err", err)
	}
	e.ack(ctx, bridge.Ack{ID: cmd.ID, OK: true, MessageID: messageID})
}

func (e *Executor) execute(ctx context.Context, cmd bridge.Command) (string, error) {
	switch cmd.Kind {
	case "send_c2c":
		return e.sendC2C(ctx, cmd.Args)
	case "send_media":
		return e.sendMedia(ctx, cmd.Args)
	case "recall_c2c":
		return "", e.recall(ctx, cmd.Args)
	case "respond_interaction":
		return "", e.respond(ctx, cmd.Args)
	case "publish_panel":
		return "", e.publishPanel(ctx, cmd.Args)
	default:
		return "", fmt.Errorf("未知出站命令类型 %q", cmd.Kind)
	}
}

type sendArgs struct {
	OpenID         string          `json:"openid"`
	Markdown       bool            `json:"markdown"`
	Content        string          `json:"content"`
	Keyboard       json.RawMessage `json:"keyboard,omitempty"`
	ReplyToMsgID   string          `json:"replyToMsgId"`
	ReplyToEventID string          `json:"replyToEventId"`
	MsgSeq         int             `json:"msgSeq"`
}

func (e *Executor) sendC2C(ctx context.Context, raw json.RawMessage) (string, error) {
	var args sendArgs
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	keyboard, err := decodeKeyboard(args.Keyboard)
	if err != nil {
		return "", err
	}
	resp, err := e.qq.Send(ctx, qq.Message{
		OpenID:         args.OpenID,
		Content:        args.Content,
		Markdown:       args.Markdown,
		Keyboard:       keyboard,
		ReplyToMsgID:   args.ReplyToMsgID,
		ReplyToEventID: args.ReplyToEventID,
		MsgSeq:         args.MsgSeq,
	})
	if err != nil {
		return "", err
	}
	return messageIDOf(resp), nil
}

type mediaArgs struct {
	OpenID         string `json:"openid"`
	Kind           string `json:"kind"`
	Path           string `json:"path"`
	URL            string `json:"url"`
	Name           string `json:"name"`
	ReplyToMsgID   string `json:"replyToMsgId"`
	ReplyToEventID string `json:"replyToEventId"`
	MsgSeq         int    `json:"msgSeq"`
}

func (e *Executor) sendMedia(ctx context.Context, raw json.RawMessage) (string, error) {
	var args mediaArgs
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	resp, err := e.qq.SendMedia(ctx, qq.MediaRequest{
		OpenID:         args.OpenID,
		Kind:           qq.MediaKind(args.Kind),
		Path:           args.Path,
		URL:            args.URL,
		Name:           args.Name,
		ReplyToMsgID:   args.ReplyToMsgID,
		ReplyToEventID: args.ReplyToEventID,
		MsgSeq:         args.MsgSeq,
	}, e.media)
	if err != nil {
		return "", err
	}
	return messageIDOf(resp), nil
}

type recallArgs struct {
	OpenID    string `json:"openid"`
	MessageID string `json:"messageId"`
}

func (e *Executor) recall(ctx context.Context, raw json.RawMessage) error {
	var args recallArgs
	if err := decodeArgs(raw, &args); err != nil {
		return err
	}
	if err := e.qq.Recall(ctx, args.OpenID, args.MessageID); err != nil {
		// 撤回是尽力而为：超时/无权/已删除都只记 WARN，不算命令失败。
		e.log.Warn("撤回消息失败，跳过", "openid", qq.RedactOpenID(args.OpenID), "message_id", args.MessageID, "err", err)
	}
	return nil
}

type interactionArgs struct {
	InteractionID string `json:"interactionId"`
	Code          int    `json:"code"`
}

func (e *Executor) respond(ctx context.Context, raw json.RawMessage) error {
	var args interactionArgs
	if err := decodeArgs(raw, &args); err != nil {
		return err
	}
	code := qqbotsdk.InteractionCode(args.Code)
	if err := code.Validate(); err != nil {
		return fmt.Errorf("互动回应码非法：%w", err)
	}
	return e.qq.Respond(ctx, args.InteractionID, code)
}

type panelArgs struct {
	Remark      string         `json:"remark"`
	Enabled     bool           `json:"enabled"`
	MenuEnabled bool           `json:"menuEnabled"`
	Items       []qq.PanelItem `json:"items"`
	MenuItems   []qq.MenuItem  `json:"menuItems"`
	UserOpenIDs []string       `json:"userOpenIds"`
}

func (e *Executor) publishPanel(ctx context.Context, raw json.RawMessage) error {
	var args panelArgs
	if err := decodeArgs(raw, &args); err != nil {
		return err
	}
	return e.qq.PublishPanel(ctx, qq.PanelDefinition{
		Enabled:     args.Enabled,
		Remark:      args.Remark,
		MenuEnabled: args.MenuEnabled,
		UserOpenIDs: args.UserOpenIDs,
		Items:       args.Items,
		MenuItems:   args.MenuItems,
	})
}

func (e *Executor) ack(ctx context.Context, a bridge.Ack) {
	if e.acker == nil {
		return
	}
	ackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err := e.acker.Ack(ackCtx, a); err != nil {
		e.log.Warn("回报命令结果失败（命令会被重投）", "id", a.ID, "err", err)
	}
}

func decodeArgs(raw json.RawMessage, out any) error {
	if len(raw) == 0 {
		return errors.New("出站命令缺少参数")
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("解析出站命令参数失败：%w", err)
	}
	return nil
}

// decodeKeyboard 把插件下发的键盘 JSON 原样解成 SDK 结构。
func decodeKeyboard(raw json.RawMessage) (*qqbotsdk.Keyboard, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var kb qqbotsdk.Keyboard
	if err := json.Unmarshal(raw, &kb); err != nil {
		return nil, fmt.Errorf("解析键盘失败：%w", err)
	}
	if kb.ID == "" && kb.Content == nil {
		return nil, errors.New("键盘既没有模板 id 也没有 content")
	}
	return &kb, nil
}

func messageIDOf(resp *qqbotsdk.MessageResponse) string {
	if resp == nil {
		return ""
	}
	return resp.ID
}

func platformCode(err error) int {
	var oae *qqbotsdk.OpenAPIError
	if errors.As(err, &oae) {
		return int(oae.Code)
	}
	return 0
}
