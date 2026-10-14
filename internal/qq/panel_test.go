package qq

import (
	"context"
	"errors"
	"strings"
	"testing"

	qqbotsdk "github.com/fouc3/qq-bot-sdk"
)

// panelStub 覆写面板与菜单相关方法，并记录每一次调用。
type panelStub struct {
	API

	panels  []qqbotsdk.PanelRecord
	current []string
	menu    *qqbotsdk.Menu

	created     []*qqbotsdk.PanelCreateRequest
	updated     []panelUpdate
	targetCalls []qqbotsdk.PanelTargetRequest
	setMenus    []*qqbotsdk.Menu
}

type panelUpdate struct {
	ID    string
	Panel *qqbotsdk.Panel
}

func (s *panelStub) ListPanels(context.Context, string, string, int) (*qqbotsdk.PanelList, error) {
	return &qqbotsdk.PanelList{Records: s.panels, IsEnd: true}, nil
}

func (s *panelStub) CreatePanel(_ context.Context, req *qqbotsdk.PanelCreateRequest) (string, error) {
	s.created = append(s.created, req)
	return "PANEL-NEW", nil
}

func (s *panelStub) GetPanel(_ context.Context, _ string) (*qqbotsdk.PanelDetail, error) {
	d := &qqbotsdk.PanelDetail{}
	d.UserOpenIDs = append([]string(nil), s.current...)
	return d, nil
}

func (s *panelStub) UpdatePanel(_ context.Context, id string, panel *qqbotsdk.Panel) (*qqbotsdk.VersionResponse, error) {
	s.updated = append(s.updated, panelUpdate{ID: id, Panel: panel})
	return &qqbotsdk.VersionResponse{Version: panel.Version + 1}, nil
}

func (s *panelStub) UpdatePanelTargets(_ context.Context, _ string, req *qqbotsdk.PanelTargetRequest) error {
	s.targetCalls = append(s.targetCalls, *req)
	return nil
}

func (s *panelStub) GetMenu(context.Context) (*qqbotsdk.MenuConfig, error) {
	return &qqbotsdk.MenuConfig{Menu: s.menu}, nil
}

func (s *panelStub) SetMenu(_ context.Context, menu *qqbotsdk.Menu) (*qqbotsdk.VersionResponse, error) {
	s.setMenus = append(s.setMenus, menu)
	return &qqbotsdk.VersionResponse{Version: 2}, nil
}

const testRemark = "DSH-QQ-BOT 指令面板"

func testDef() PanelDefinition {
	return PanelDefinition{
		Enabled:     true,
		Remark:      testRemark,
		MenuEnabled: true,
		UserOpenIDs: []string{"OPENID-A"},
		Items: []PanelItem{
			{Name: "切换会话", Desc: "选择要接入的会话"},
			{Name: "停止", Desc: "停止当前轮次"},
		},
		MenuItems: []MenuItem{
			{Name: "切换会话", SendMessage: "切换会话"},
			{Name: "停止", SendMessage: "停止"},
		},
	}
}

func TestPublishPanelCreatesWhenAbsent(t *testing.T) {
	stub := &panelStub{}
	c := New(stub, nil)

	if err := c.PublishPanel(context.Background(), testDef()); err != nil {
		t.Fatalf("发布失败：%v", err)
	}
	if len(stub.created) != 1 {
		t.Fatalf("应创建 1 个面板，实际 %d", len(stub.created))
	}
	req := stub.created[0]
	if req.Scope != qqbotsdk.PanelScopeC2C || req.TargetType != qqbotsdk.PanelTargetSpecific {
		t.Errorf("面板场景/生效范围不对：scope=%q target=%q", req.Scope, req.TargetType)
	}
	if len(req.UserOpenIDs) != 1 || req.UserOpenIDs[0] != "OPENID-A" {
		t.Errorf("面板应只绑定配置里的私聊：%v", req.UserOpenIDs)
	}
	if req.Panel == nil || req.Panel.Remark != testRemark || len(req.Panel.Items) != 2 {
		t.Fatalf("面板内容不对：%+v", req.Panel)
	}
	if req.Panel.Items[0].Type != qqbotsdk.PanelItemCommand || req.Panel.Items[0].Name != "切换会话" {
		t.Errorf("命令项不对：%+v", req.Panel.Items[0])
	}
	if len(stub.updated) != 0 {
		t.Error("面板不存在时不该走更新")
	}
	if len(stub.setMenus) != 1 {
		t.Errorf("应发布自定义菜单，实际 %d 次", len(stub.setMenus))
	}
	if got := stub.setMenus[0].Items[0]; got.Type != qqbotsdk.MenuTypeSendMessage || got.SendMessage != "切换会话" {
		t.Errorf("菜单项应为填充输入框型：%+v", got)
	}
}

func TestPublishPanelReusesByRemarkAndSyncsTargets(t *testing.T) {
	stub := &panelStub{
		panels: []qqbotsdk.PanelRecord{{
			PanelID: "PANEL-OLD",
			Scope:   qqbotsdk.PanelScopeC2C,
			Panel:   &qqbotsdk.Panel{Remark: testRemark, Version: 7},
			Version: 7,
		}},
		current: []string{"OPENID-B", "OPENID-C"},
	}
	c := New(stub, nil)

	def := testDef()
	def.UserOpenIDs = []string{"OPENID-B", "OPENID-D"}
	if err := c.PublishPanel(context.Background(), def); err != nil {
		t.Fatalf("发布失败：%v", err)
	}
	if len(stub.created) != 0 {
		t.Error("remark 命中时不该新建面板（避免留下孤儿面板）")
	}
	if len(stub.updated) != 1 || stub.updated[0].ID != "PANEL-OLD" {
		t.Fatalf("应更新已存在的面板：%+v", stub.updated)
	}
	if got := stub.updated[0].Panel.Version; got != 7 {
		t.Errorf("更新应带上平台当前版本号（乐观并发），实际 %d", got)
	}

	var added, deleted []string
	for _, call := range stub.targetCalls {
		switch call.Op {
		case qqbotsdk.PanelTargetOpAdd:
			added = append(added, call.UserOpenIDs...)
		case qqbotsdk.PanelTargetOpDel:
			deleted = append(deleted, call.UserOpenIDs...)
		}
	}
	if len(added) != 1 || added[0] != "OPENID-D" {
		t.Errorf("应新增 OPENID-D，实际 %v", added)
	}
	if len(deleted) != 1 || deleted[0] != "OPENID-C" {
		t.Errorf("应移除 OPENID-C，实际 %v", deleted)
	}
}

func TestPublishPanelKeepsTargetsWhenWantedEmpty(t *testing.T) {
	stub := &panelStub{
		panels: []qqbotsdk.PanelRecord{{
			PanelID: "PANEL-OLD",
			Panel:   &qqbotsdk.Panel{Remark: testRemark, Version: 1},
			Version: 1,
		}},
		current: []string{"OPENID-B"},
	}
	c := New(stub, nil)

	def := testDef()
	def.UserOpenIDs = nil
	if err := c.PublishPanel(context.Background(), def); err != nil {
		t.Fatalf("发布失败：%v", err)
	}
	if len(stub.targetCalls) != 0 {
		t.Errorf("期望名单为空时应保持平台侧绑定不动，实际 %+v", stub.targetCalls)
	}
}

func TestPublishPanelSkipsMenuWhenUnchanged(t *testing.T) {
	existing := &qqbotsdk.Menu{Items: []qqbotsdk.MenuItem{
		{Type: qqbotsdk.MenuTypeSendMessage, Name: "切换会话", SendMessage: "切换会话"},
		{Type: qqbotsdk.MenuTypeSendMessage, Name: "停止", SendMessage: "停止"},
	}}
	stub := &panelStub{menu: existing}
	c := New(stub, nil)

	if err := c.PublishPanel(context.Background(), testDef()); err != nil {
		t.Fatalf("发布失败：%v", err)
	}
	if len(stub.setMenus) != 0 {
		t.Errorf("菜单已是目标状态时不该重复发布，实际 %d 次", len(stub.setMenus))
	}
}

func TestPublishPanelDisabledDoesNothing(t *testing.T) {
	stub := &panelStub{}
	c := New(stub, nil)

	def := testDef()
	def.Enabled = false
	if err := c.PublishPanel(context.Background(), def); err != nil {
		t.Fatalf("停用时不该报错：%v", err)
	}
	if len(stub.created)+len(stub.updated)+len(stub.setMenus) != 0 {
		t.Error("停用时不该产生任何平台调用")
	}
}

func TestPublishPanelRejectsInvalidDefinition(t *testing.T) {
	stub := &panelStub{}
	c := New(stub, nil)

	def := testDef()
	def.Items = []PanelItem{{Name: "", Desc: "缺名字"}}
	err := c.PublishPanel(context.Background(), def)
	if err == nil || !strings.Contains(err.Error(), "面板定义不合法") {
		t.Fatalf("非法定义应被本地拦下：%v", err)
	}
	if len(stub.created) != 0 {
		t.Error("本地校验失败不该发请求")
	}

	def = testDef()
	def.Remark = ""
	if err := c.PublishPanel(context.Background(), def); err == nil {
		t.Error("remark 为空应当报错")
	}
}

func TestPublishPanelBatchesTargets(t *testing.T) {
	stub := &panelStub{}
	c := New(stub, nil)

	def := testDef()
	def.UserOpenIDs = make([]string, 0, 21)
	for i := 0; i < 21; i++ {
		def.UserOpenIDs = append(def.UserOpenIDs, "OPENID-"+strings.Repeat("X", i+1))
	}
	if err := c.PublishPanel(context.Background(), def); err != nil {
		t.Fatalf("发布失败：%v", err)
	}
	// 新建路径由 CreatePanel 一次性带上全部对象；这里只校验请求没被拆坏。
	if len(stub.created) != 1 || len(stub.created[0].UserOpenIDs) != 21 {
		t.Fatalf("创建请求应带全部对象：%+v", stub.created)
	}
}

var errListFailed = errors.New("列表炸了")

func TestPublishPanelSurfacesListFailure(t *testing.T) {
	stub := &failingListStub{}
	c := New(stub, nil)
	if err := c.PublishPanel(context.Background(), testDef()); err == nil {
		t.Fatal("列表失败应当向上报错（否则会重复建面板）")
	}
}

type failingListStub struct {
	API
}

func (s *failingListStub) ListPanels(context.Context, string, string, int) (*qqbotsdk.PanelList, error) {
	return nil, errListFailed
}
