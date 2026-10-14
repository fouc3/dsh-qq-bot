package executor

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fouc3/dsh-qq-bot/internal/bridge"
	"github.com/fouc3/dsh-qq-bot/internal/qq"
)

// fakeAcker 收集执行器回报的结果。
type fakeAcker struct {
	mu   sync.Mutex
	acks []bridge.Ack
}

func (f *fakeAcker) Ack(_ context.Context, a bridge.Ack) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.acks = append(f.acks, a)
	return nil
}

func (f *fakeAcker) list() []bridge.Ack {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bridge.Ack(nil), f.acks...)
}

// recorder 记录假平台收到的请求。
type recorder struct {
	mu     sync.Mutex
	reqs   []recorded
	puts   []string
	bodies map[string][]byte
}

type recorded struct {
	Method string
	Path   string
	Body   []byte
}

func (r *recorder) add(req *http.Request, body []byte) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reqs = append(r.reqs, recorded{Method: req.Method, Path: req.URL.Path, Body: body})
	if r.bodies == nil {
		r.bodies = map[string][]byte{}
	}
	r.bodies[req.Method+" "+req.URL.Path] = body
	return len(r.reqs)
}

func (r *recorder) list() []recorded {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]recorded(nil), r.reqs...)
}

func (r *recorder) count(method, pathContains string) int {
	n := 0
	for _, req := range r.list() {
		if req.Method == method && strings.Contains(req.Path, pathContains) {
			n++
		}
	}
	return n
}

// setup 起一个假平台，并把执行器指向它（走真实 SDK 客户端，顺带覆盖序列化与本地校验）。
func setup(t *testing.T, handler http.HandlerFunc, media qq.MediaConfig) (*Executor, *fakeAcker, *recorder) {
	t.Helper()
	rec := &recorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rec.add(r, body)
		// 把 body 放回去：同一个 handler 里还要按内容断言。
		r.Body = io.NopCloser(bytes.NewReader(body))
		handler(w, r)
	}))
	t.Cleanup(srv.Close)

	sdk, err := qq.NewSDKClient(qq.Options{AccessToken: "test-token", BaseURL: srv.URL})
	if err != nil {
		t.Fatalf("构造 SDK 客户端失败：%v", err)
	}
	client := qq.New(sdk, nil)
	client.RetryDelay = time.Millisecond
	client.MaxAttempts = 2

	dedupe, err := OpenDedupe(filepath.Join(t.TempDir(), "seen.json"), 16)
	if err != nil {
		t.Fatalf("打开去重文件失败：%v", err)
	}
	acker := &fakeAcker{}
	return New(client, acker, dedupe, media, nil), acker, rec
}

func command(t *testing.T, id, kind string, args any) bridge.Command {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	return bridge.Command{ID: id, Kind: kind, Args: raw}
}

func TestSendC2CCommand(t *testing.T) {
	exec, acker, rec := setup(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"id":"MSG-1"}`))
	}, qq.MediaConfig{})

	exec.Run(context.Background(), []bridge.Command{command(t, "c-1", "send_c2c", map[string]any{
		"openid":         "OPENID-A",
		"markdown":       true,
		"content":        "【标题(session-1)】你好",
		"replyToMsgId":   "USER-MSG",
		"replyToEventId": "",
		"msgSeq":         1,
	})})

	reqs := rec.list()
	if len(reqs) != 1 {
		t.Fatalf("应只发一条消息，实际 %d 次请求：%+v", len(reqs), reqs)
	}
	if reqs[0].Method != http.MethodPost || !strings.Contains(reqs[0].Path, "/v2/users/OPENID-A/messages") {
		t.Errorf("请求不对：%s %s", reqs[0].Method, reqs[0].Path)
	}
	body := string(reqs[0].Body)
	for _, want := range []string{`"msg_type":2`, `"content":"【标题(session-1)】你好"`, `"msg_id":"USER-MSG"`, `"msg_seq":1`} {
		if !strings.Contains(body, want) {
			t.Errorf("请求体缺少 %s：%s", want, body)
		}
	}
	if strings.Contains(body, `"keyboard"`) {
		t.Errorf("没有键盘时不该带 keyboard 字段：%s", body)
	}

	acks := acker.list()
	if len(acks) != 1 || !acks[0].OK || acks[0].MessageID != "MSG-1" || acks[0].ID != "c-1" {
		t.Fatalf("ack 不对：%+v", acks)
	}
}

func TestKeyboardIsPassedThrough(t *testing.T) {
	exec, acker, rec := setup(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"id":"MSG-2"}`))
	}, qq.MediaConfig{})

	keyboard := map[string]any{"content": map[string]any{"rows": []any{
		map[string]any{"buttons": []any{map[string]any{
			"id":          "btn_1",
			"render_data": map[string]any{"label": "我需要回复", "visited_label": "已触发", "style": 1},
			"action": map[string]any{
				"type": 1, "data": "qqb:needreply:session-1",
				"permission":     map[string]any{"type": 2},
				"unsupport_tips": "请升级 QQ 客户端",
			},
		}}},
	}}}

	exec.Run(context.Background(), []bridge.Command{command(t, "c-2", "send_c2c", map[string]any{
		"openid":   "OPENID-A",
		"markdown": false, // 带键盘必须被强制成 markdown
		"content":  "session-1已结束",
		"keyboard": keyboard,
	})})

	if rec.count(http.MethodPost, "/messages") != 1 {
		t.Fatalf("应发出一条消息")
	}
	body := string(rec.list()[0].Body)
	for _, want := range []string{`"msg_type":2`, `"我需要回复"`, `"qqb:needreply:session-1"`, `"unsupport_tips"`} {
		if !strings.Contains(body, want) {
			t.Errorf("键盘未透传（缺 %s）：%s", want, body)
		}
	}
	if acks := acker.list(); len(acks) != 1 || !acks[0].OK {
		t.Fatalf("ack 不对：%+v", acks)
	}
}

func TestDuplicateCommandIsNotSentTwice(t *testing.T) {
	exec, acker, rec := setup(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"id":"MSG-3"}`))
	}, qq.MediaConfig{})

	cmd := command(t, "c-dup", "send_c2c", map[string]any{"openid": "OPENID-A", "content": "只发一次"})
	exec.Run(context.Background(), []bridge.Command{cmd})
	exec.Run(context.Background(), []bridge.Command{cmd}) // 通道重投

	if got := rec.count(http.MethodPost, "/messages"); got != 1 {
		t.Fatalf("重复投递只应发一次，实际 %d 次", got)
	}
	acks := acker.list()
	if len(acks) != 2 || !acks[0].OK || !acks[1].OK {
		t.Fatalf("两次都应回 ok:true（第二次是补 ack）：%+v", acks)
	}
}

func TestFailureAcksNotOKAndStaysRetryable(t *testing.T) {
	exec, acker, rec := setup(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"err_code":40034006,"message":"消息内容不合规","trace_id":"t1"}`))
	}, qq.MediaConfig{})

	cmd := command(t, "c-fail", "send_c2c", map[string]any{"openid": "OPENID-A", "content": "违规内容"})
	exec.Run(context.Background(), []bridge.Command{cmd})

	acks := acker.list()
	if len(acks) != 1 || acks[0].OK || acks[0].ErrorCode != 40034006 {
		t.Fatalf("失败应回 ok:false 并带上平台错误码：%+v", acks)
	}

	// 失败不写去重，重投时必须真的再试一次。
	exec.Run(context.Background(), []bridge.Command{cmd})
	if got := rec.count(http.MethodPost, "/messages"); got != 2 {
		t.Fatalf("失败的命令应可重试，实际请求 %d 次", got)
	}
}

func TestRecallIsBestEffort(t *testing.T) {
	exec, acker, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {
		// 超过 2 分钟，平台拒绝撤回
		_, _ = w.Write([]byte(`{"err_code":40064004,"message":"已超出消息撤回时限"}`))
	}, qq.MediaConfig{})

	exec.Run(context.Background(), []bridge.Command{command(t, "c-recall", "recall_c2c", map[string]any{
		"openid": "OPENID-A", "messageId": "CARD-1",
	})})

	acks := acker.list()
	if len(acks) != 1 || !acks[0].OK {
		t.Fatalf("撤回失败只记日志，仍应回 ok:true：%+v", acks)
	}
}

func TestRespondInteractionCommand(t *testing.T) {
	exec, acker, rec := setup(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}, qq.MediaConfig{})

	exec.Run(context.Background(), []bridge.Command{command(t, "c-int", "respond_interaction", map[string]any{
		"interactionId": "INT-1", "code": 0,
	})})
	acks := acker.list()
	if len(acks) != 1 || !acks[0].OK {
		t.Fatalf("回应互动应成功：%+v", acks)
	}
	if rec.count(http.MethodPut, "/interactions/INT-1") != 1 {
		t.Errorf("应调用回应互动接口：%+v", rec.list())
	}

	// 非法 code 在本地就该被拦下
	exec.Run(context.Background(), []bridge.Command{command(t, "c-int-bad", "respond_interaction", map[string]any{
		"interactionId": "INT-2", "code": 9,
	})})
	acks = acker.list()
	if len(acks) != 2 || acks[1].OK || !strings.Contains(acks[1].Error, "非法") {
		t.Fatalf("非法回应码应被拦下：%+v", acks)
	}
}

func TestUnknownKindIsRejected(t *testing.T) {
	exec, acker, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}, qq.MediaConfig{})

	exec.Run(context.Background(), []bridge.Command{command(t, "c-x", "no_such_kind", map[string]any{})})
	acks := acker.list()
	if len(acks) != 1 || acks[0].OK || !strings.Contains(acks[0].Error, "未知出站命令类型") {
		t.Fatalf("未知命令类型应回 ok:false：%+v", acks)
	}
}

func TestSendMediaByURL(t *testing.T) {
	exec, acker, rec := setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/files"):
			_, _ = w.Write([]byte(`{"file_uuid":"u1","file_info":"FI-1","ttl":60}`))
		case strings.HasSuffix(r.URL.Path, "/messages"):
			_, _ = w.Write([]byte(`{"id":"MSG-MEDIA"}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}, qq.MediaConfig{MaxUploadBytes: 200 << 20})

	exec.Run(context.Background(), []bridge.Command{command(t, "c-media-url", "send_media", map[string]any{
		"openid": "OPENID-A",
		"kind":   "image",
		"url":    "https://example.com/a.png",
		"name":   "a.png",
	})})

	for _, want := range []string{"file_type", "https://example.com/a.png"} {
		found := false
		for _, req := range rec.list() {
			if strings.Contains(string(req.Body), want) {
				found = true
			}
		}
		if !found {
			t.Errorf("上传请求应包含 %s：%+v", want, rec.list())
		}
	}
	// 媒体消息必须是 msg_type=7 且带 file_info
	var mediaBody string
	for _, req := range rec.list() {
		if strings.HasSuffix(req.Path, "/messages") {
			mediaBody = string(req.Body)
		}
	}
	if !strings.Contains(mediaBody, `"msg_type":7`) || !strings.Contains(mediaBody, `"file_info":"FI-1"`) {
		t.Errorf("媒体消息体不对：%s", mediaBody)
	}
	acks := acker.list()
	if len(acks) != 1 || !acks[0].OK || acks[0].MessageID != "MSG-MEDIA" {
		t.Fatalf("ack 不对：%+v", acks)
	}
}

func TestSendMediaLocalFileChunkedUpload(t *testing.T) {
	content := []byte("DSH-QQ-BOT 分片上传测试内容")
	dir := t.TempDir()
	filePath := filepath.Join(dir, "report.txt")
	if err := os.WriteFile(filePath, content, 0o600); err != nil {
		t.Fatal(err)
	}

	// 期望的校验和：平台会拿它们校验整文件与前 10MB
	full := md5.Sum(content)
	sha := sha1.Sum(content)
	head := md5.Sum(content)
	wantMD5 := hex.EncodeToString(full[:])
	wantSHA1 := hex.EncodeToString(sha[:])
	wantHeadMD5 := hex.EncodeToString(head[:])

	exec, acker, rec := setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/upload_prepare"):
			body, _ := io.ReadAll(r.Body)
			var req struct {
				FileType int    `json:"file_type"`
				FileSize string `json:"file_size"`
				FileName string `json:"file_name"`
				MD5      string `json:"md5"`
				SHA1     string `json:"sha1"`
				MD5Ten   string `json:"md5_10m"`
			}
			_ = json.Unmarshal(body, &req)
			if req.MD5 != wantMD5 || req.SHA1 != wantSHA1 || req.MD5Ten != wantHeadMD5 {
				t.Errorf("预上传校验和不对：%+v", req)
			}
			if req.FileType != 4 {
				t.Errorf("file 类型应是 4，实际 %d", req.FileType)
			}
			_, _ = fmt.Fprintf(w, `{"upload_id":"UP-1","block_size":%q,"parts":[{"index":0,"presigned_url":%q,"block_size":%q}],"upload_config":{"concurrency":1,"retry_timeout":5,"retry_delay":1}}`,
				fmt.Sprint(len(content)), "http://"+r.Host+"/put/0", fmt.Sprint(len(content)))
		case r.URL.Path == "/put/0":
			got, _ := io.ReadAll(r.Body)
			if string(got) != string(content) {
				t.Errorf("分片 PUT 内容不对：%q", got)
			}
			w.WriteHeader(http.StatusOK)
		case strings.HasSuffix(r.URL.Path, "/upload_part_finish"):
			_, _ = w.Write([]byte(`{}`))
		case strings.HasSuffix(r.URL.Path, "/files"):
			_, _ = w.Write([]byte(`{"file_uuid":"u2","file_info":"FI-LOCAL","ttl":60}`))
		case strings.HasSuffix(r.URL.Path, "/messages"):
			_, _ = w.Write([]byte(`{"id":"MSG-LOCAL"}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}, qq.MediaConfig{MaxUploadBytes: 200 << 20})

	exec.Run(context.Background(), []bridge.Command{command(t, "c-media-local", "send_media", map[string]any{
		"openid": "OPENID-A",
		"kind":   "file",
		"path":   filePath,
	})})

	acks := acker.list()
	if len(acks) != 1 || !acks[0].OK || acks[0].MessageID != "MSG-LOCAL" {
		t.Fatalf("本机文件分片上传应成功：%+v（请求：%+v）", acks, rec.list())
	}
	if rec.count(http.MethodPut, "/put/0") != 1 {
		t.Errorf("应有一次分片 PUT：%+v", rec.list())
	}
}

func TestSendMediaRejectsBadLocalFile(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "big.bin")
	if err := os.WriteFile(filePath, []byte("0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}

	exec, acker, rec := setup(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}, qq.MediaConfig{MaxUploadBytes: 4, AllowedRoots: []string{dir}})

	// 超过上限
	exec.Run(context.Background(), []bridge.Command{command(t, "c-big", "send_media", map[string]any{
		"openid": "OPENID-A", "kind": "file", "path": filePath,
	})})
	// 不在允许的根目录内
	exec.Run(context.Background(), []bridge.Command{command(t, "c-root", "send_media", map[string]any{
		"openid": "OPENID-A", "kind": "file", "path": "/etc/hostname",
	})})
	// path 与 url 都没给
	exec.Run(context.Background(), []bridge.Command{command(t, "c-none", "send_media", map[string]any{
		"openid": "OPENID-A", "kind": "file",
	})})

	acks := acker.list()
	if len(acks) != 3 {
		t.Fatalf("应有三次失败回执：%+v", acks)
	}
	for i, ack := range acks {
		if ack.OK {
			t.Errorf("第 %d 条应在本地被拦下：%+v", i+1, ack)
		}
	}
	if !strings.Contains(acks[0].Error, "上限") {
		t.Errorf("超限错误信息不明确：%s", acks[0].Error)
	}
	if !strings.Contains(acks[1].Error, "允许的根目录") {
		t.Errorf("路径限制错误信息不明确：%s", acks[1].Error)
	}
	if !strings.Contains(acks[2].Error, "path 或 url") {
		t.Errorf("缺参数错误信息不明确：%s", acks[2].Error)
	}
	// 本地校验失败不该产生任何平台请求
	if len(rec.list()) != 0 {
		t.Errorf("本地校验失败时不该发请求：%+v", rec.list())
	}
}

func TestPublishPanelCommand(t *testing.T) {
	exec, acker, rec := setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case sContains(r.URL.Path, "menu"):
			_, _ = w.Write([]byte(`{"version":1,"menu":{"items":[]}}`))
		case r.Method == http.MethodGet && sContains(r.URL.Path, "panels"):
			_, _ = w.Write([]byte(`{"records":[],"is_end":true}`))
		case r.Method == http.MethodPost && sContains(r.URL.Path, "panels"):
			_, _ = w.Write([]byte(`{"panel_id":"PANEL-1","version":1}`))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}, qq.MediaConfig{})

	exec.Run(context.Background(), []bridge.Command{command(t, "c-panel", "publish_panel", map[string]any{
		"enabled":     true,
		"remark":      "DSH-QQ-BOT 指令面板",
		"menuEnabled": true,
		"items": []map[string]string{
			{"name": "切换会话", "desc": "选择会话"},
		},
		"menuItems": []map[string]string{
			{"name": "切换会话", "sendMessage": "切换会话"},
		},
		"userOpenIds": []string{"OPENID-A"},
	})})

	acks := acker.list()
	if len(acks) != 1 || !acks[0].OK {
		t.Fatalf("发布面板应成功：%+v（请求 %+v）", acks, rec.list())
	}
	if rec.count(http.MethodPost, "panels") != 1 {
		t.Errorf("应创建面板：%+v", rec.list())
	}
	if rec.count(http.MethodPut, "menu") != 1 {
		t.Errorf("应发布菜单：%+v", rec.list())
	}
}

func sContains(s, sub string) bool { return strings.Contains(s, sub) }
