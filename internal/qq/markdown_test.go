package qq

import (
	"strings"
	"testing"
)

// QQ 的 markdown 把"单个换行"渲染成空格（官方文档《Markdown 消息》→「换多行」），
// 所以出站正文里凡是要分行的相邻行，都得在中间补一个空行。
func TestHardenMarkdownAddsBlankLines(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "两行普通文字之间补空行（用户反馈的核心场景）",
			in:   "作用：把常用会话存成快捷入口\n用法：快捷 加 / 快捷 #2",
			want: "作用：把常用会话存成快捷入口\n\n用法：快捷 加 / 快捷 #2",
		},
		{
			name: "已经是空行的不再补",
			in:   "第一段\n\n第二段",
			want: "第一段\n\n第二段",
		},
		{
			name: "连续空行折叠成一个",
			in:   "第一段\n\n\n\n第二段",
			want: "第一段\n\n第二段",
		},
		{
			name: "列表项之间保持单换行（补了会变松列表）",
			in:   "- 加当前会话\n- 列出\n- 删 #2",
			want: "- 加当前会话\n- 列出\n- 删 #2",
		},
		{
			name: "有序列表同理",
			in:   "1. 第一步\n2. 第二步",
			want: "1. 第一步\n2. 第二步",
		},
		{
			name: "列表前的普通文字要空行隔开（官方嵌套列表的说明）",
			in:   "看这些：\n- 加当前会话\n- 列出",
			want: "看这些：\n\n- 加当前会话\n- 列出",
		},
		{
			name: "列表项后面的普通文字也要空行（否则会被当成上一项的续行）",
			in:   "- 加当前会话\n就这些",
			want: "- 加当前会话\n\n就这些",
		},
		{
			name: "块引用里的空行要带 >（否则空行会结束引用块）",
			in:   "> 会话：proj-a(session-1)\n> 状态：运行中",
			want: "> 会话：proj-a(session-1)\n>\n> 状态：运行中",
		},
		{
			name: "引用块后面接正文：不补 > 空行",
			in:   "> 这是引用\n这是正文",
			want: "> 这是引用\n\n这是正文",
		},
		{
			name: "标题与正文之间补空行（多一个空行无害）",
			in:   "**状态**\n> 会话：x",
			want: "**状态**\n\n> 会话：x",
		},
		{
			name: "围栏代码块内原样（插空行会改坏代码）",
			in:   "看代码：\n```go\nif a {\n\nb()\n}\n```\n结束",
			want: "看代码：\n\n```go\nif a {\n\nb()\n}\n```\n\n结束",
		},
		{
			name: "CRLF 与行尾空白归一",
			in:   "第一行  \r\n第二行\t\r\n",
			want: "第一行\n\n第二行",
		},
		{
			name: "单行内容原样",
			in:   "已接入 proj-a(session-1)",
			want: "已接入 proj-a(session-1)",
		},
		{
			name: "空内容原样",
			in:   "",
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := HardenMarkdown(tc.in); got != tc.want {
				t.Errorf("HardenMarkdown:\n输入 %q\n得到 %q\n期望 %q", tc.in, got, tc.want)
			}
		})
	}
}

// 幂等：处理过的正文再过一遍不再变化（重试、转发、二次处理都不会越补越多空行）。
func TestHardenMarkdownIsIdempotent(t *testing.T) {
	inputs := []string{
		"作用：x\n用法：y",
		"> a\n> b",
		"- a\n- b",
		"**标题**\n正文\n\n> 引用\n> 第二行",
		"```\ncode\n```\n尾巴",
	}
	for _, in := range inputs {
		once := HardenMarkdown(in)
		twice := HardenMarkdown(once)
		if once != twice {
			t.Errorf("不幂等：\n输入 %q\n一次 %q\n二次 %q", in, once, twice)
		}
	}
}

// 状态卡片这种真实形状：抬头四行 + 动作列表 + 两段引用，全都要各自成行。
func TestHardenMarkdownRealisticStatusCard(t *testing.T) {
	in := strings.Join([]string{
		"**状态**",
		"> 会话：proj-a(session-1)",
		"> 模型：deepseek / deepseek-reasoner",
		"> 状态：运行中（第 3 轮，已跑 5 分 2 秒）",
		"",
		"**最近动作**（从新到旧）",
		"- bash：pnpm test（2 秒前）",
		"- write：/tmp/a.ts（9 秒前）",
		"",
		"**最近一段正文（第 4 步，就是最新一步）**",
		"> 正在跑测试",
	}, "\n")
	got := HardenMarkdown(in)
	// 抬头每一行都必须自成一行：任意两行之间要么隔着分隔行（空行，或引用块里的 `>`），
	// 要么两者都是列表项
	lines := strings.Split(got, "\n")
	isSep := func(s string) bool { return s == "" || s == ">" }
	for i := 1; i < len(lines); i++ {
		prev, cur := strings.TrimSpace(lines[i-1]), strings.TrimSpace(lines[i])
		if isSep(prev) || isSep(cur) {
			continue
		}
		if isListItem(prev) && isListItem(cur) {
			continue
		}
		t.Errorf("第 %d/%d 行之间没有分隔行：%q 紧跟 %q\n完整输出：\n%s", i, i+1, prev, cur, got)
	}
	if !strings.Contains(got, "> 会话：proj-a(session-1)\n>\n> 模型：deepseek / deepseek-reasoner") {
		t.Errorf("引用块里的空行要带 >，实际：\n%s", got)
	}
}
