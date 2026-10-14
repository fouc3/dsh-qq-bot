package qq

import (
	"context"
	"testing"

	qqbotsdk "github.com/fouc3/qq-bot-sdk"
)

// 发布菜单时二级菜单必须真的落到平台请求的 sub_menu_items 上。
func TestPublishPanelSendsSubMenu(t *testing.T) {
	stub := &panelStub{}
	c := New(stub, nil)

	def := testDef()
	def.MenuItems = []MenuItem{
		{Name: "切换会话", SendMessage: "切换会话"},
		{
			Name: "dsh 命令",
			Type: "menu",
			Children: []MenuItem{
				{Name: "compact", SendMessage: "/compact"},
				{Name: "goal", SendMessage: "/goal"},
			},
		},
	}
	if err := c.PublishPanel(context.Background(), def); err != nil {
		t.Fatalf("发布失败：%v", err)
	}
	if len(stub.setMenus) != 1 {
		t.Fatalf("应发布 1 次菜单，实际 %d", len(stub.setMenus))
	}
	items := stub.setMenus[0].Items
	if len(items) != 2 {
		t.Fatalf("顶层菜单项 = %d，want 2", len(items))
	}
	if items[0].Type != qqbotsdk.MenuTypeSendMessage || items[0].SendMessage != "切换会话" {
		t.Errorf("第一条应是填充输入框型：%+v", items[0])
	}
	if items[1].Type != qqbotsdk.MenuTypeMenu {
		t.Fatalf("第二条应是可折叠菜单，得到 %q", items[1].Type)
	}
	if items[1].Name != "dsh 命令" || len(items[1].SubMenuItems) != 2 {
		t.Fatalf("二级菜单内容不对：%+v", items[1])
	}
	if items[1].SubMenuItems[0].SendMessage != "/compact" || items[1].SubMenuItems[1].Name != "goal" {
		t.Errorf("二级菜单项不对：%+v", items[1].SubMenuItems)
	}
}

func TestDisplayWidth(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"中文", 4},
		{"切换会话", 8},
		{"a中", 3},
	}
	for _, tc := range cases {
		if got := displayWidth(tc.in); got != tc.want {
			t.Errorf("displayWidth(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestClipDisplay(t *testing.T) {
	// 未超限：原样返回
	if got := clipDisplay("本轮正常结束后投递", maxPanelItemDescWidth); got != "本轮正常结束后投递" {
		t.Errorf("不该截断，得到 %q", got)
	}
	// 超限：截断后（含省略号）不超限，且以 … 结尾
	long := "登记一条待发消息，等该会话本轮正常结束后投递"
	got := clipDisplay(long, maxPanelItemDescWidth)
	if displayWidth(got) > maxPanelItemDescWidth {
		t.Errorf("截断后仍超宽：%q (%d)", got, displayWidth(got))
	}
	if len([]rune(got)) == 0 || string([]rune(got)[len([]rune(got))-1]) != "…" {
		t.Errorf("截断结果应以 … 结尾：%q", got)
	}
	// 极限：限宽 3 时只能放一个中文 + …
	if got := clipDisplay("中文", 3); displayWidth(got) > 3 {
		t.Errorf("限宽 3 被突破：%q (%d)", got, displayWidth(got))
	}
}

// 菜单项转换：一级是 send_message，二级菜单是 menu + sub_menu_items，
// 且两层名字都要压进平台宽度限制。
func TestToSDKMenuItem(t *testing.T) {
	plain := toSDKMenuItem(MenuItem{Name: "切换会话", SendMessage: "切换会话"})
	if plain.Type != qqbotsdk.MenuTypeSendMessage {
		t.Errorf("一级项应为 send_message，得到 %q", plain.Type)
	}
	if plain.SendMessage != "切换会话" || len(plain.SubMenuItems) != 0 {
		t.Errorf("一级项不该带子项：%+v", plain)
	}

	sub := toSDKMenuItem(MenuItem{
		Name: "dsh 命令",
		Type: "menu",
		Children: []MenuItem{
			{Name: "compact", SendMessage: "/compact"},
			{Name: "一二三四五六七八九十", SendMessage: "/long"}, // 超宽，应被截断
		},
	})
	if sub.Type != qqbotsdk.MenuTypeMenu {
		t.Fatalf("应为二级菜单，得到 %q", sub.Type)
	}
	if len(sub.SubMenuItems) != 2 {
		t.Fatalf("子项数 = %d，want 2", len(sub.SubMenuItems))
	}
	if sub.SubMenuItems[0].Type != qqbotsdk.SubMenuTypeSendMessage || sub.SubMenuItems[0].SendMessage != "/compact" {
		t.Errorf("子项应为 send_message 且带上命令行：%+v", sub.SubMenuItems[0])
	}
	if w := displayWidth(sub.SubMenuItems[1].Name); w > maxSubMenuItemNameWidth {
		t.Errorf("子项名未截断：%q (%d)", sub.SubMenuItems[1].Name, w)
	}
	if w := displayWidth(sub.Name); w > maxMenuItemNameWidth {
		t.Errorf("顶层名未截断：%q (%d)", sub.Name, w)
	}

	// 没有子项的 menu 类型退化成普通 send_message（平台不允许空菜单）
	empty := toSDKMenuItem(MenuItem{Name: "空", Type: "menu"})
	if empty.Type != qqbotsdk.MenuTypeSendMessage {
		t.Errorf("空二级菜单应降级为 send_message，得到 %q", empty.Type)
	}

	// 顶层名超宽
	wide := toSDKMenuItem(MenuItem{Name: "一二三四五六七八", SendMessage: "x"})
	if w := displayWidth(wide.Name); w > maxMenuItemNameWidth {
		t.Errorf("顶层名未截断：%q (%d)", wide.Name, w)
	}
}

// 子菜单内容变化必须被 sameMenu 发现，否则会漏发菜单更新。
func TestSameMenuDetectsSubMenuChange(t *testing.T) {
	menu := func(child string) *qqbotsdk.Menu {
		return &qqbotsdk.Menu{Items: []qqbotsdk.MenuItem{{
			Type:         qqbotsdk.MenuTypeMenu,
			Name:         "dsh 命令",
			SubMenuItems: []qqbotsdk.SubMenuItem{{Type: qqbotsdk.SubMenuTypeSendMessage, Name: child, SendMessage: "/" + child}},
		}}}
	}
	if sameMenu(menu("compact"), menu("goal")) {
		t.Error("子菜单不同却判定相同 → 会漏发更新")
	}
	if !sameMenu(menu("compact"), menu("compact")) {
		t.Error("相同的菜单被判为不同")
	}
	// 长度不同
	long := &qqbotsdk.Menu{Items: []qqbotsdk.MenuItem{{Type: qqbotsdk.MenuTypeMenu, Name: "dsh 命令"}}}
	if sameMenu(menu("compact"), long) {
		t.Error("子项数量不同却判定相同")
	}
}

// 面板条目必须压进平台限制：中文按 2 个宽度算，name ≤14、desc ≤30。
func TestPanelItemsFitPlatformLimit(t *testing.T) {
	items := []PanelItem{
		{Name: "切换会话", Desc: "选择/切换要接入的会话"},
		{Name: "发送", Desc: "把一条消息单次投递到指定会话"},
		{Name: "停止", Desc: "停止当前轮次（无参=当前会话）"},
		{Name: "归档", Desc: "归档会话（无参=当前会话）"},
		{Name: "延迟发送", Desc: "本轮正常结束后投递"},
	}
	for _, it := range items {
		if w := displayWidth(it.Name); w > maxPanelItemNameWidth {
			t.Errorf("条目名 %q 宽度 %d 超限 %d", it.Name, w, maxPanelItemNameWidth)
		}
		if w := displayWidth(it.Desc); w > maxPanelItemDescWidth {
			t.Errorf("条目描述 %q 宽度 %d 超限 %d", it.Desc, w, maxPanelItemDescWidth)
		}
	}
}
