package qq

import (
	"context"
	"errors"
	"fmt"
	"strings"

	qqbotsdk "github.com/fouc3/qq-bot-sdk"
)

// PanelItem 是指令面板里的一条命令。
//
// 名称与描述的唯一来源在 dsh 插件侧（dsh-plugin/lib/commands.js），
// 网关只负责把它发布到平台，避免两种语言各写一份命令表。
type PanelItem struct {
	Name string `json:"name"`
	Desc string `json:"desc"`
}

// MenuItem 是单聊窗口底部自定义菜单的一项。
//
// Type 为空表示 send_message（点击把 SendMessage 填进输入框）；
// Type 为 "menu" 时表示**可折叠的二级菜单**，内容在 Children 里，
// 平台限制：顶层最多 10 项、二级最多 5 项。
type MenuItem struct {
	Name        string     `json:"name"`
	SendMessage string     `json:"sendMessage,omitempty"`
	Type        string     `json:"type,omitempty"`
	Children    []MenuItem `json:"children,omitempty"`
}

// PanelDefinition 是插件下发的面板与菜单定义。
type PanelDefinition struct {
	Enabled     bool
	Remark      string
	MenuEnabled bool
	UserOpenIDs []string
	Items       []PanelItem
	MenuItems   []MenuItem
}

// maxPanelPages 是查找面板时最多翻页的页数（每页 20 条）。
const maxPanelPages = 10

// 平台对指令面板条目的显示宽度限制：一个中文字符算 2。
//
// 超出时平台只回一个笼统的 40030013「超出数量限制」，很难排查，
// 所以网关在发布前自己按宽度截断（措辞的权威仍在插件侧）。
const (
	maxPanelItemNameWidth = 14
	maxPanelItemDescWidth = 30
	// 自定义菜单：顶层按钮名 ≤10，二级菜单项名 ≤14（中文都按 2 计）。
	maxMenuItemNameWidth    = 10
	maxSubMenuItemNameWidth = 14
)

// displayWidth 返回按"中文算 2"计的显示宽度。
func displayWidth(s string) int {
	width := 0
	for _, r := range s {
		if r > 0x7F {
			width += 2
			continue
		}
		width++
	}
	return width
}

// clipDisplay 把字符串压到显示宽度上限内，超出部分以 … 结尾。
func clipDisplay(s string, limit int) string {
	if displayWidth(s) <= limit {
		return s
	}
	const ellipsis = "…" // 省略号也是全角，占 2 宽
	budget := limit - displayWidth(ellipsis)
	if budget < 0 {
		budget = 0
	}
	width := 0
	var b strings.Builder
	for _, r := range s {
		runeWidth := 1
		if r > 0x7F {
			runeWidth = 2
		}
		if width+runeWidth > budget {
			break
		}
		b.WriteRune(r)
		width += runeWidth
	}
	return b.String() + ellipsis
}

// DescribePanels 列出平台侧现有的 c2c 指令面板（排查"找不到 remark / 数量超限"时用）。
//
// 返回的人类可读文本行；没有面板时返回空切片。
func (c *Client) DescribePanels(ctx context.Context) ([]string, error) {
	list, err := c.api.ListPanels(ctx, qqbotsdk.PanelScopeC2C, "", qqbotsdk.MaxPanelPageSize)
	if err != nil {
		return nil, fmt.Errorf("查询指令面板失败：%w", err)
	}
	if list == nil || len(list.Records) == 0 {
		return nil, nil
	}
	out := make([]string, 0, len(list.Records))
	for i := range list.Records {
		rec := list.Records[i]
		if rec.Panel == nil {
			out = append(out, fmt.Sprintf("panel_id=%s（空面板）", rec.PanelID))
			continue
		}
		targets := ""
		if detail, err := c.api.GetPanel(ctx, rec.PanelID); err == nil && detail != nil {
			targets = strings.Join(detail.UserOpenIDs, ",")
		}
		out = append(out, fmt.Sprintf("panel_id=%s remark=%q items=%d version=%d targets=[%s]",
			rec.PanelID, rec.Panel.Remark, len(rec.Panel.Items), rec.Panel.Version, targets))
	}
	return out, nil
}

// PublishPanel 发布指令面板与自定义菜单。
//
// 定位方式：**用 remark 找面板**，而不是把 panel_id 存到本地 ——
// 换机器、重装、清状态后仍然复用同一个面板，不会留下孤儿面板。
func (c *Client) PublishPanel(ctx context.Context, def PanelDefinition) error {
	if !def.Enabled {
		c.log.Info("指令面板已停用，跳过发布")
		return nil
	}
	if def.Remark == "" {
		return errors.New("qq: 面板 remark 不能为空（用于定位已有面板）")
	}

	items := make([]qqbotsdk.PanelItem, 0, len(def.Items))
	for _, it := range def.Items {
		items = append(items, qqbotsdk.PanelItem{
			Type: qqbotsdk.PanelItemCommand,
			Name: clipDisplay(it.Name, maxPanelItemNameWidth),
			Desc: clipDisplay(it.Desc, maxPanelItemDescWidth),
		})
	}
	panel := &qqbotsdk.Panel{Items: items, Remark: def.Remark}
	if err := panel.Validate(); err != nil {
		return fmt.Errorf("面板定义不合法：%w", err)
	}

	record, err := c.findPanelByRemark(ctx, def.Remark)
	if err != nil {
		return err
	}

	switch {
	case record == nil:
		id, err := c.api.CreatePanel(ctx, &qqbotsdk.PanelCreateRequest{
			Scope:       qqbotsdk.PanelScopeC2C,
			TargetType:  qqbotsdk.PanelTargetSpecific,
			UserOpenIDs: def.UserOpenIDs,
			Panel:       panel,
		})
		if err != nil {
			return fmt.Errorf("创建指令面板失败：%w", err)
		}
		c.log.Info("已创建指令面板", "panel_id", id, "items", len(items), "targets", len(def.UserOpenIDs))
	default:
		// 更新要带上当前版本号（平台做乐观并发）。
		panel.Version = record.Panel.Version
		if _, err := c.api.UpdatePanel(ctx, record.PanelID, panel); err != nil {
			return fmt.Errorf("更新指令面板失败：%w", err)
		}
		if err := c.syncPanelTargets(ctx, record.PanelID, def.UserOpenIDs); err != nil {
			return err
		}
		c.log.Info("已复用并更新指令面板", "panel_id", record.PanelID, "items", len(items))
	}

	if def.MenuEnabled {
		if err := c.publishMenu(ctx, def.MenuItems); err != nil {
			// 菜单只是入口，失败不该拖垮收发。
			c.log.Warn("发布自定义菜单失败", "err", err)
		}
	}
	return nil
}

// findPanelByRemark 游标翻页查找 remark 匹配的面板；找不到返回 (nil, nil)。
func (c *Client) findPanelByRemark(ctx context.Context, remark string) (*qqbotsdk.PanelRecord, error) {
	cursor := ""
	for page := 0; page < maxPanelPages; page++ {
		list, err := c.api.ListPanels(ctx, qqbotsdk.PanelScopeC2C, cursor, qqbotsdk.DefaultPanelPageSize)
		if err != nil {
			return nil, fmt.Errorf("查询指令面板失败：%w", err)
		}
		if list == nil {
			return nil, nil
		}
		for i := range list.Records {
			rec := list.Records[i]
			if rec.Panel != nil && rec.Panel.Remark == remark {
				return &rec, nil
			}
		}
		if list.IsEnd || list.NextCursor == "" {
			return nil, nil
		}
		cursor = list.NextCursor
	}
	c.log.Warn("查找指令面板翻页到上限仍未结束", "remark", remark, "pages", maxPanelPages)
	return nil, nil
}

// syncPanelTargets 把面板关联的私聊差量同步到期望状态。
func (c *Client) syncPanelTargets(ctx context.Context, panelID string, want []string) error {
	if len(want) == 0 {
		c.log.Warn("面板目标名单为空，保持平台侧已有绑定不动（避免清空白名单时误删）", "panel_id", panelID)
		return nil
	}
	detail, err := c.api.GetPanel(ctx, panelID)
	if err != nil {
		return fmt.Errorf("读取面板关联对象失败：%w", err)
	}
	current := map[string]struct{}{}
	if detail != nil {
		for _, id := range detail.UserOpenIDs {
			current[id] = struct{}{}
		}
	}
	wanted := map[string]struct{}{}
	var toAdd []string
	for _, id := range want {
		if id == "" {
			continue
		}
		wanted[id] = struct{}{}
		if _, ok := current[id]; !ok {
			toAdd = append(toAdd, id)
		}
	}
	var toDel []string
	for id := range current {
		if _, ok := wanted[id]; !ok {
			toDel = append(toDel, id)
		}
	}

	for _, batch := range batchStrings(toAdd, 20) {
		if err := c.api.UpdatePanelTargets(ctx, panelID, &qqbotsdk.PanelTargetRequest{
			Op:          qqbotsdk.PanelTargetOpAdd,
			UserOpenIDs: batch,
		}); err != nil {
			return fmt.Errorf("新增面板关联对象失败：%w", err)
		}
		c.log.Info("面板已绑定私聊", "panel_id", panelID, "count", len(batch))
	}
	for _, batch := range batchStrings(toDel, 20) {
		if err := c.api.UpdatePanelTargets(ctx, panelID, &qqbotsdk.PanelTargetRequest{
			Op:          qqbotsdk.PanelTargetOpDel,
			UserOpenIDs: batch,
		}); err != nil {
			return fmt.Errorf("移除面板关联对象失败：%w", err)
		}
		c.log.Info("面板已解绑私聊", "panel_id", panelID, "count", len(batch))
	}
	return nil
}

// publishMenu 发布单聊窗口底部的自定义菜单（整体覆盖）。
// 已经是目标状态时跳过，避免每次重启都无谓地顶掉版本号。
// toSDKMenuItem 把插件的菜单项转成 SDK 结构（支持一层二级菜单）。
func toSDKMenuItem(it MenuItem) qqbotsdk.MenuItem {
	if it.Type == "menu" && len(it.Children) > 0 {
		children := make([]qqbotsdk.SubMenuItem, 0, len(it.Children))
		for _, child := range it.Children {
			children = append(children, qqbotsdk.SubMenuItem{
				Type:        qqbotsdk.SubMenuTypeSendMessage,
				Name:        clipDisplay(child.Name, maxSubMenuItemNameWidth),
				SendMessage: child.SendMessage,
			})
		}
		return qqbotsdk.MenuItem{
			Type:         qqbotsdk.MenuTypeMenu,
			Name:         clipDisplay(it.Name, maxMenuItemNameWidth),
			SubMenuItems: children,
		}
	}
	return qqbotsdk.MenuItem{
		Type:        qqbotsdk.MenuTypeSendMessage,
		Name:        clipDisplay(it.Name, maxMenuItemNameWidth),
		SendMessage: it.SendMessage,
	}
}

func (c *Client) publishMenu(ctx context.Context, items []MenuItem) error {
	if len(items) == 0 {
		return nil
	}
	menuItems := make([]qqbotsdk.MenuItem, 0, len(items))
	for _, it := range items {
		menuItems = append(menuItems, toSDKMenuItem(it))
	}
	target := &qqbotsdk.Menu{Items: menuItems}
	if err := target.Validate(); err != nil {
		return fmt.Errorf("菜单定义不合法：%w", err)
	}

	current, err := c.api.GetMenu(ctx)
	if err == nil && current != nil && sameMenu(current.Menu, target) {
		c.log.Debug("自定义菜单已是目标状态，跳过发布")
		return nil
	}
	if _, err := c.api.SetMenu(ctx, target); err != nil {
		return fmt.Errorf("发布自定义菜单失败：%w", err)
	}
	c.log.Info("已发布自定义菜单", "items", len(menuItems))
	return nil
}

func sameMenu(a, b *qqbotsdk.Menu) bool {
	if a == nil || b == nil {
		return false
	}
	if len(a.Items) != len(b.Items) {
		return false
	}
	for i := range a.Items {
		if a.Items[i].Type != b.Items[i].Type ||
			a.Items[i].Name != b.Items[i].Name ||
			a.Items[i].SendMessage != b.Items[i].SendMessage {
			return false
		}
		// 二级菜单也要比：只比顶层会把"子项变了"误判成已到位。
		if !sameSubMenu(a.Items[i].SubMenuItems, b.Items[i].SubMenuItems) {
			return false
		}
	}
	return true
}

// sameSubMenu 比较两个二级菜单项列表。
func sameSubMenu(a, b []qqbotsdk.SubMenuItem) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Type != b[i].Type || a[i].Name != b[i].Name || a[i].SendMessage != b[i].SendMessage {
			return false
		}
	}
	return true
}

func batchStrings(items []string, size int) [][]string {
	if len(items) == 0 {
		return nil
	}
	var out [][]string
	for start := 0; start < len(items); start += size {
		end := start + size
		if end > len(items) {
			end = len(items)
		}
		out = append(out, items[start:end])
	}
	return out
}
