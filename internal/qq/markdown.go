package qq

import (
	"strings"
)

// HardenMarkdown 把出站 markdown 里的"软换行"变成 QQ 真的会换的行。
//
// 为什么需要 —— QQ 机器人官方文档《Markdown 消息》里有一节就叫「换多行」：
//
//	### 换多行
//	第一行
//	（空行）
//	第二行
//	（空行）
//	（一行只放一个零宽空格 U+200B）
//	（同上，再一行 U+200B）
//	第三行
//
// 即：**正文里单独一个换行符会被渲染成空格**（标准 markdown 的 soft break），
// 要让两行分别显示，必须在它们之间放一个**空行**（文档还用 `\u200B` 演示了
// "连续空行"的写法，因为连着两个空行会被折叠）。我们的正文几乎全是"一行一条
// 信息"（命令帮助、状态卡片、AI 的回复），不处理在 QQ 里就是一大坨没有换行的
// 文字 —— 用户线上反馈："dsh 发送的消息没有换行只有空格"。
//
// 规则（只动换行，不动内容）：
//
//  1. 两个相邻的**非空**行之间补一个空行；
//  2. 相邻的**列表项**之间**不补**（`- x`／`* x`／`1. x`）：列表项本身就是块级
//     元素，单换行就能分开（官方「无序列表」示例就是单换行），补空行会变成松列表、
//     行距被撑得很大；嵌套列表同理；
//  3. 补的空行落在**块引用**里时也带 `>`（`>` 单独一行），否则空行会结束引用块；
//  4. ``` 围栏代码块内**原样**（插空行会改坏代码）；
//  5. 行尾空白去掉、CRLF 归一成 LF、连续空行折叠成一个。
//
// 只用于 markdown（msg_type=2）。纯文本（msg_type=0）不动：平台那边的换行行为
// 没有文档保证，乱补空行只会更糟（见 Message.Markdown 的说明）。
func HardenMarkdown(content string) string {
	if content == "" {
		return content
	}
	normalized := strings.ReplaceAll(strings.ReplaceAll(content, "\r\n", "\n"), "\r", "\n")
	out := make([]string, 0, 16)
	inFence := false
	prev := "" // 上一个已写出的**内容**行（空串 = 还没有；分隔行不算）
	for _, raw := range strings.Split(normalized, "\n") {
		line := strings.TrimRight(raw, " \t")
		if isFenceLine(line) {
			// 围栏**开**行：要跟上一行分开（QQ 单换行会连成一行）；
			// 围栏**闭**行不能补：那一行的前面属于代码块内部，补空行会往代码里塞空行。
			if !inFence && prev != "" && needsHardBreak(prev, line) {
				out = append(out, separator(prev, line))
			}
			inFence = !inFence
			out = append(out, line)
			prev = line
			continue
		}
		if inFence {
			out = append(out, line) // 围栏内（含空行）原样保留，绝不插分隔
			continue
		}
		// 空行、以及块引用里的空行（只有 `>`）都不直接写出：分隔行统一在"下一个内容行"
		// 那里按上一行/下一行生成，这样既不会出现连续空行，也不会让空行把引用块截断，
		// 而且处理过的正文再过一遍不会越补越多（幂等）。
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || trimmed == ">" {
			continue
		}
		if prev != "" && needsHardBreak(prev, line) {
			out = append(out, separator(prev, line))
		}
		out = append(out, line)
		prev = line
	}
	return strings.Join(out, "\n")
}

// needsHardBreak 判断 cur 这行要不要靠"前面加一个分隔行"才能跟 prev 分行。
func needsHardBreak(prev, cur string) bool {
	// 列表项接列表项：单换行就能分开，补了反而变松列表（含缩进的嵌套项）
	if isListItem(prev) && isListItem(cur) {
		return false
	}
	return true
}

// separator 生成两个内容行之间的分隔行：都在块引用里就写 `>`（不带 `>` 的空行会
// 结束引用块），否则就是一个普通空行。
func separator(prev, cur string) string {
	if isQuoteLine(prev) && isQuoteLine(cur) {
		return ">"
	}
	return ""
}

// isQuoteLine 判断是不是块引用行。
func isQuoteLine(line string) bool {
	return strings.HasPrefix(strings.TrimLeft(line, " \t"), ">")
}

// isFenceLine 判断是不是 ``` 围栏行（允许 ```go 这种带语言的行）。
func isFenceLine(line string) bool {
	return strings.HasPrefix(strings.TrimSpace(line), "```")
}

// isListItem 判断是不是列表项（`- `、`* `、`+ ` 或 `1. `／`1) `），允许缩进。
func isListItem(line string) bool {
	trimmed := strings.TrimLeft(line, " \t")
	if trimmed == "" {
		return false
	}
	if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") || strings.HasPrefix(trimmed, "+ ") {
		return true
	}
	// 有序列表：数字 + `.`/`)` + 空格
	digits := 0
	for digits < len(trimmed) && trimmed[digits] >= '0' && trimmed[digits] <= '9' {
		digits++
	}
	if digits == 0 || digits+1 >= len(trimmed) {
		return false
	}
	marker := trimmed[digits]
	if marker != '.' && marker != ')' {
		return false
	}
	return trimmed[digits+1] == ' '
}
