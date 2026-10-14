// Package qq 封装 qq-bot-sdk：客户端构造、事件登记与门守、
// 统一发送收口、撤回、按钮互动回应、富媒体上传与指令面板发布。
package qq

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	qqbotsdk "github.com/fouc3/qq-bot-sdk"
)

// Options 是构造 SDK 客户端所需的凭据与地址。
type Options struct {
	AppID        string
	ClientSecret string
	AccessToken  string
	// BaseURL 为空表示使用 SDK 默认（官方生产地址）。
	BaseURL string
}

// API 是本网关用到的 SDK 方法子集。
//
// 收窄成接口是为了让发送退化、重试、去重这些编排逻辑可单测：
// 真实 SDK 客户端（*qqbotsdk.Client）天然满足它，测试里既能用它配合
// httptest 覆盖序列化与本地校验，也能用假实现覆盖异常分支。
type API interface {
	SendC2CMessage(ctx context.Context, userOpenID string, msg *qqbotsdk.Message) (*qqbotsdk.MessageResponse, error)
	RecallC2CMessage(ctx context.Context, userOpenID, messageID string) error
	RespondInteraction(ctx context.Context, interactionID string, code qqbotsdk.InteractionCode) error

	UploadC2CFile(ctx context.Context, userOpenID string, req *qqbotsdk.FileUploadRequest) (*qqbotsdk.FileUploadResponse, error)
	PrepareC2CUpload(ctx context.Context, userOpenID string, req *qqbotsdk.UploadPrepareRequest) (*qqbotsdk.UploadPrepareResponse, error)
	FinishC2CUploadPart(ctx context.Context, userOpenID string, req *qqbotsdk.UploadPartFinishRequest) error

	GetMenu(ctx context.Context) (*qqbotsdk.MenuConfig, error)
	SetMenu(ctx context.Context, menu *qqbotsdk.Menu) (*qqbotsdk.VersionResponse, error)
	ListPanels(ctx context.Context, scope, cursor string, limit int) (*qqbotsdk.PanelList, error)
	CreatePanel(ctx context.Context, req *qqbotsdk.PanelCreateRequest) (string, error)
	GetPanel(ctx context.Context, panelID string) (*qqbotsdk.PanelDetail, error)
	UpdatePanel(ctx context.Context, panelID string, panel *qqbotsdk.Panel) (*qqbotsdk.VersionResponse, error)
	UpdatePanelTargets(ctx context.Context, panelID string, req *qqbotsdk.PanelTargetRequest) error
}

// 编译期断言：真实 SDK 客户端满足本包需要的全部方法。
var _ API = (*qqbotsdk.Client)(nil)

// Client 是带日志、重试与降级策略的 QQ 网关客户端。
type Client struct {
	api API
	log *slog.Logger

	// MaxAttempts 是一次发送的最大尝试次数（含首次）。
	MaxAttempts int
	// RetryDelay 是首次重试前的等待，之后逐次翻倍。
	RetryDelay time.Duration
	// PutClient 用于富媒体分片上传的预签名 PUT。
	PutClient *http.Client
	// answered 记录已回应过的互动 id，避免重复回应（平台不报错，靠调用方自律）。
	answered *ringSet
}

// New 构造网关客户端。api 为 nil 时调用方应立即改用 NewSDKClient。
func New(api API, log *slog.Logger) *Client {
	if log == nil {
		log = slog.Default()
	}
	return &Client{
		api:         api,
		log:         log,
		MaxAttempts: 3,
		RetryDelay:  500 * time.Millisecond,
		PutClient:   &http.Client{Timeout: 60 * time.Second},
		answered:    newRingSet(1024),
	}
}

// NewSDKClient 按凭据构造真实 SDK 客户端。
//
// extra 用于测试注入（例如 WithBaseURL、WithHTTPClient 指向 httptest）。
func NewSDKClient(opts Options, extra ...qqbotsdk.Option) (*qqbotsdk.Client, error) {
	sdkCfg := qqbotsdk.Config{
		AppID:        opts.AppID,
		ClientSecret: opts.ClientSecret,
		AccessToken:  opts.AccessToken,
		BaseURL:      opts.BaseURL,
	}
	if err := sdkCfg.Validate(); err != nil {
		return nil, fmt.Errorf("QQ 凭据不完整：%w", err)
	}
	return qqbotsdk.NewClientFromConfig(sdkCfg, extra...)
}

// Intents 是本桥需要订阅的事件类别：单聊/群聊消息 + 按钮互动。
//
// 故意不订阅其它 intent：平台对未申请权限的 intent 会直接断连，
// 少订阅也能少收无关事件。
func Intents() qqbotsdk.Intent {
	return qqbotsdk.IntentsFor(
		qqbotsdk.IntentGroupAndC2CEvent,
		qqbotsdk.IntentInteraction,
	)
}

// StartTransport 取接入点并启动 WebSocket 长连接。
func StartTransport(ctx context.Context, client *qqbotsdk.Client) error {
	gateway, err := client.GetGateway(ctx)
	if err != nil {
		return fmt.Errorf("获取网关接入点失败：%w", err)
	}
	client.UseTransport(qqbotsdk.NewWebSocketTransport(
		gateway.URL,
		qqbotsdk.WithIntents(Intents()),
		qqbotsdk.WithShard(qqbotsdk.DefaultShard),
	))
	if err := client.Start(ctx); err != nil {
		return fmt.Errorf("启动 QQ 长连接失败：%w", err)
	}
	return nil
}

// ringSet 是一个固定容量的 id 记忆，用于"只做一次"的场景。
type ringSet struct {
	items []string
	index int
	seen  map[string]struct{}
}

func newRingSet(capacity int) *ringSet {
	return &ringSet{items: make([]string, 0, capacity), seen: make(map[string]struct{}, capacity)}
}

// add 记录一个 id，返回它是否是首次出现。
func (r *ringSet) add(id string) bool {
	if _, ok := r.seen[id]; ok {
		return false
	}
	if len(r.items) == cap(r.items) {
		oldest := r.items[r.index]
		delete(r.seen, oldest)
		r.items[r.index] = id
		r.index = (r.index + 1) % cap(r.items)
	} else {
		r.items = append(r.items, id)
	}
	r.seen[id] = struct{}{}
	return true
}
