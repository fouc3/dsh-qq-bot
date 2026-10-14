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
	// Quote 是用户引用的那条消息的文本（引用消息才有；QQ 的 message_type=103）。
	Quote string `json:"quote,omitempty"`
	// Attachments 是这条消息带的图片/文件/语音/视频（可能为空）。
	// 网关**只转发元数据**（含下载地址），下载与入库由 dsh 插件负责：
	// 插件那边正好要用字节去喂 dsh 的附件服务，没必要在 Go 侧再落地一份临时文件。
	Attachments []Attachment `json:"attachments,omitempty"`
	// Ark 是链接/小程序卡片的摘要（ark 消息才有）。
	Ark *Ark   `json:"ark,omitempty"`
	At  string `json:"at,omitempty"`
}

// 附件种类（SDK 的 content_type 归一化后的取值）。
const (
	AttachmentKindImage = "image"
	AttachmentKindFile  = "file"
	AttachmentKindVideo = "video"
	AttachmentKindVoice = "voice"
	// AttachmentKindUnknown 是认不出的 content_type（照样转发，插件按文件处理）。
	AttachmentKindUnknown = "unknown"
)

// Attachment 是消息里一个附件的元数据。
type Attachment struct {
	// Kind 是归一化后的种类：image / file / video / voice / unknown。
	Kind string `json:"kind"`
	// ContentType 是平台给的原始 content_type（如 image/png、voice、file）。
	ContentType string `json:"contentType,omitempty"`
	// Filename 是平台给的文件名（图片也可能为空）。
	Filename string `json:"filename,omitempty"`
	// Size 是字节数（平台可能给 0，表示未知）。
	Size int64 `json:"size,omitempty"`
	// URL 是下载地址（平台给的签名直链）。
	URL string `json:"url,omitempty"`
	// VoiceWavURL 是语音的 wav 版本地址（本项目默认不下载音频，仅留档）。
	VoiceWavURL string `json:"voiceWavUrl,omitempty"`
	// ASRText 是平台给这条语音做的转写文本；为空表示平台没有转写——
	// 插件侧会把它标成「无法识别」并拦住发送。
	ASRText string `json:"asrText,omitempty"`
}

// Ark 是 ark 卡片（链接分享、小程序分享）里我们关心的几个字段。
type Ark struct {
	// Kind 是平台给的 ark_type（如 tuwen、miniapp）。
	Kind string `json:"kind,omitempty"`
	// Name 是平台给的中文类型名（如「图文」）。
	Name string `json:"name,omitempty"`
	// Prompt 是卡片对用户展示的提示语。
	Prompt string `json:"prompt,omitempty"`
	// Title / Desc / URL 从 fields 里抽出来（键名见 SDK 的 ARKData 注释）。
	Title string `json:"title,omitempty"`
	Desc  string `json:"desc,omitempty"`
	URL   string `json:"url,omitempty"`
}

// attachmentKind 把平台的 content_type 归一化成我们的种类。
func attachmentKind(contentType string) string {
	switch strings.ToLower(strings.TrimSpace(contentType)) {
	case qqbotsdk.AttachmentContentTypeJPEG, qqbotsdk.AttachmentContentTypePNG, qqbotsdk.AttachmentContentTypeGIF:
		return AttachmentKindImage
	case qqbotsdk.AttachmentContentTypeMP4:
		return AttachmentKindVideo
	case qqbotsdk.AttachmentContentTypeVoice:
		return AttachmentKindVoice
	case qqbotsdk.AttachmentContentTypeFile:
		return AttachmentKindFile
	default:
		return AttachmentKindUnknown
	}
}

// attachmentsOf 把平台附件列表归一化；只有地址和内容类型都在的才转发
// （没有下载地址的附件对插件毫无用处，留着只会让投递端多一类分支）。
func attachmentsOf(raw []qqbotsdk.MessageAttachment) []Attachment {
	if len(raw) == 0 {
		return nil
	}
	out := make([]Attachment, 0, len(raw))
	for _, item := range raw {
		if strings.TrimSpace(item.URL) == "" {
			continue
		}
		out = append(out, Attachment{
			Kind:        attachmentKind(item.ContentType),
			ContentType: item.ContentType,
			Filename:    item.Filename,
			Size:        item.Size,
			URL:         item.URL,
			VoiceWavURL: item.VoiceWavURL,
			ASRText:     strings.TrimSpace(item.ASRReferText),
		})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// arkOf 把 ark 卡片抽成摘要；没有 ark_type 也没有任何字段时返回 nil。
func arkOf(data *qqbotsdk.ARKData) *Ark {
	if data == nil {
		return nil
	}
	field := func(keys ...string) string {
		for _, key := range keys {
			if data.Fields == nil {
				break
			}
			value, ok := data.Fields[key]
			if !ok {
				continue
			}
			if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
				return strings.TrimSpace(text)
			}
		}
		return ""
	}
	ark := &Ark{
		Kind:   strings.TrimSpace(data.ArkType),
		Name:   strings.TrimSpace(data.ArkName),
		Prompt: strings.TrimSpace(data.Prompt),
		Title:  field("title", "nickname"),
		Desc:   field("desc", "tag"),
		URL:    field("jump_url", "url"),
	}
	if ark.Kind == "" && ark.Name == "" && ark.Prompt == "" && ark.Title == "" && ark.Desc == "" && ark.URL == "" {
		return nil
	}
	return ark
}

// quotedText 取出引用消息里被引用的文本（不是引用消息、或引用的是图片等无文本内容时返回空串）。
func quotedText(data *qqbotsdk.C2CMessageCreateData) string {
	if data == nil || data.MessageType != qqbotsdk.EventMsgTypeQuote {
		return ""
	}
	// 文档把 MsgElements 描述为递归结构，这里按"取第一段非空文本"处理，限深防环。
	var walk func(elements []qqbotsdk.MsgElement, depth int) string
	walk = func(elements []qqbotsdk.MsgElement, depth int) string {
		if depth > 4 {
			return ""
		}
		for i := range elements {
			if text := strings.TrimSpace(elements[i].Content); text != "" {
				return text
			}
			if nested := walk(elements[i].MsgElements, depth+1); nested != "" {
				return nested
			}
		}
		return ""
	}
	return normalizeQuoted(walk(data.MsgElements, 0))
}

// normalizeQuoted 还原引用摘要里的转义。
//
// 引用一条 **markdown 消息**时，平台把 markdown 源码当摘要给出，换行写作字面量
// `\n`（客户端里也会显示成反斜杠N）。这里还原成真换行，让 AI 与日志看到正常文本。
// 取舍：被引用正文里本来就有反斜杠+n 的字面量（如 Windows 路径 C:\new）会被改写，
// 引用摘要场景下这个代价可以接受。
func normalizeQuoted(text string) string {
	if !strings.Contains(text, `\`) {
		return text
	}
	replacer := strings.NewReplacer(`\r\n`, "\n", `\n`, "\n", `\t`, "\t")
	return strings.TrimSpace(replacer.Replace(text))
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
	// 引用消息：被引用的内容在 MsgElements 里（message_type=103）。
	// 只引用不说话（text 空）也要转发，否则"引用某条回复"这种用法会失效。
	quote := quotedText(data)
	// 附件（图片/文件/语音/视频）与 ark 卡片：光有它们、没有文字也要转发，
	// 否则"发一张图给 AI 看"这种用法根本进不来。
	attachments := attachmentsOf(data.Attachments)
	ark := arkOf(data.ArkData)
	if text == "" && quote == "" && len(attachments) == 0 && ark == nil {
		if data.MessageType != qqbotsdk.EventMsgTypeText {
			return Decision{OpenID: openid, Reason: fmt.Sprintf("非文本消息且没有可读内容（message_type=%d, attachments=%d）", data.MessageType, len(data.Attachments))}
		}
		return Decision{OpenID: openid, Reason: "空文本"}
	}
	return Decision{
		Forward: true,
		OpenID:  openid,
		Event: Event{
			Kind:        KindC2CMessage,
			OpenID:      openid,
			Text:        text,
			Quote:       quote,
			MsgID:       data.ID,
			Attachments: attachments,
			Ark:         ark,
			At:          nowRFC3339(),
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
