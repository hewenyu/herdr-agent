package tasks

import (
	"fmt"
	"sort"
	"strings"
)

func sortStrings(s []string) { sort.Strings(s) }

// Description is intentionally ordinary, structured text in the public task
// resource. Both humans and Feishu assistants can read the same state without
// access to local JSON, terminal transcripts, or a custom card renderer.
func Description(r Record) string {
	var b strings.Builder
	fmt.Fprintf(&b, "项目：%s\n执行者：%s\n当前状态：%s\n更新时间：%s\n追踪编号：%s\n", clip(r.Project, 120), r.Agent, r.Status.Label(), r.UpdatedAt.Format("2006-01-02 15:04:05 -07:00"), r.ID)
	if r.ChatID != "" && r.Status != Destroyed {
		fmt.Fprintf(&b, "任务会话：%s\n", ChatURL(r.ChatID))
	}
	fmt.Fprintf(&b, "\n任务要求：%s\n当前进展：%s\n", clip(r.Title, 700), clip(r.Detail, 500))
	if r.Error != "" {
		fmt.Fprintf(&b, "需要处理：%s\n", clip(r.Error, 400))
	}
	if r.Status == Review {
		b.WriteString("\n本轮回复结束不代表任务已经完成。请在任务群内继续反馈或确认验收；在飞书任务中勾选完成也会关闭对应 Agent 并解散任务群。\n")
	}
	if r.CloseRequested && r.Status != Destroyed {
		b.WriteString("结单请求：用户已确认验收，确认飞书完成状态并保存结果后关闭执行会话与临时群。\n")
	}
	if r.Result != "" {
		b.WriteString("\n最近交付 / 回复：\n")
		remaining := 3000 - len([]rune(b.String())) - 35
		if remaining > 0 {
			b.WriteString(clip(r.Result, remaining))
			if len([]rune(r.Result)) > remaining {
				b.WriteString("\n（回复已截取，完整内容见执行会话。）")
			}
		}
	}
	// Feishu validates the entire description at 3000 UTF-8 characters.
	return clip(b.String(), 2999)
}
func ChatURL(id string) string { return "https://applink.feishu.cn/client/chat/open?openChatId=" + id }
func Summary(records []Record) string {
	if len(records) == 0 {
		return "目前没有正在追踪的任务。用“新建任务：任务内容”在默认项目开始，或 /new <项目> <任务内容>。"
	}
	lines := []string{fmt.Sprintf("共 %d 个任务：", len(records))}
	for _, r := range records {
		line := fmt.Sprintf("\n%s · %s\n项目：%s · %s\n进展：%s\n编号：%s", r.Status.Label(), r.Title, r.Project, r.Agent, r.Detail, r.ID)
		if r.URL != "" {
			line += "\n任务：" + r.URL
		}
		if r.ChatID != "" && r.Status != Destroyed {
			line += "\n会话：" + ChatURL(r.ChatID)
		}
		if r.Error != "" {
			line += "\n需要处理：" + r.Error
		}
		if r.SyncError != "" {
			line += "\n飞书同步暂未成功：" + r.SyncError
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

const Help = `/projects — 查看配置的项目和默认 agent
/new <项目> [codex|claude] <任务内容> — 新建任务
新建任务：<任务内容> — 使用默认项目和 agent
/tasks [all] — 查看进行中的任务（all 包括已完成）
/task close|complete|reopen|destroy|retry [任务编号] — 验收结单、仅标记完成、重开、销毁会话或重试
在任务群内可省略任务编号。销毁会话会关闭执行窗口并解散群，群聊天记录不保留；代码和飞书任务保留。`

const GroupCloseHint = "关闭当前任务：发送 /关闭项目，查看说明后回复“确认关闭”；也可在飞书任务面板勾选完成。系统会关闭对应 Agent 并自动解散本群。"

// GroupCloseCommand recognizes explicit group controls, not substrings in
// feedback, quotes, negations, or conditional acceptance. Confirmation itself
// is an explicit instruction for this group's one trusted task binding.
func GroupCloseCommand(text string) (Command, bool) {
	text = strings.TrimSpace(text)
	text = strings.TrimRight(text, "。！!")
	text = strings.ReplaceAll(text, "，", ",")
	text = strings.TrimPrefix(text, "／")
	text = strings.TrimPrefix(text, "/")
	switch text {
	case "关闭项目", "关闭本项目", "已完成,关闭本项目", "已完成本项目,关闭本项目", "已经完成了本项目,关闭本项目":
		return Command{Kind: "close_prompt"}, true
	case "确认关闭", "确认关闭本项目":
		return Command{Kind: "action", Action: "close"}, true
	default:
		return Command{}, false
	}
}

type Command struct {
	Kind, Project, Agent, Text, ID, Action string
	All                                    bool
	Error                                  string
}

func Parse(text string) (Command, bool) {
	text = strings.TrimSpace(text)
	text = strings.Replace(text, "／", "/", 1)
	for _, q := range []string{"有哪些任务正在进行", "目前有哪些任务", "列出进行中的任务", "总结一下正在进行的任务", "帮我总结一下正在进行的任务", "总结进行中的任务", "正在进行哪些任务", "现在有哪些任务在进行", "现在有哪些任务在进行？", "正在进行哪些任务？", "有哪些任务在进行", "任务进度", "查看任务", "查看进行中的任务", "现在进行中的任务"} {
		if strings.TrimRight(text, "？?。") == strings.TrimRight(q, "？?。") {
			return Command{Kind: "list"}, true
		}
	}
	natural := text
	for _, prefix := range []string{"请", "帮我"} {
		natural = strings.TrimSpace(strings.TrimPrefix(natural, prefix))
	}
	if strings.HasPrefix(natural, "新建一个任务") {
		natural = "新建任务" + strings.TrimPrefix(natural, "新建一个任务")
	}
	if natural == "新建任务" {
		return Command{Kind: "new", Error: "请补充任务内容，例如：新建任务：修复登录问题"}, true
	}
	if strings.HasPrefix(natural, "新建任务") {
		rest := strings.TrimPrefix(natural, "新建任务")
		if strings.HasPrefix(rest, "：") || strings.HasPrefix(rest, ":") || strings.HasPrefix(rest, "，") || strings.HasPrefix(rest, ",") || strings.HasPrefix(rest, " ") || strings.HasPrefix(rest, "\n") {
			body := strings.TrimSpace(strings.TrimLeft(rest, "：:,， \t\n"))
			return Command{Kind: "new", Text: body}, true
		}
	}
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return Command{}, false
	}
	switch fields[0] {
	case "/projects":
		c := Command{Kind: "projects"}
		if len(fields) != 1 {
			c.Error = "用法：/projects"
		}
		return c, true
	case "/tasks":
		c := Command{Kind: "list"}
		if len(fields) == 2 && fields[1] == "all" {
			c.All = true
		} else if len(fields) > 1 {
			c.Error = "用法：/tasks [all]"
		}
		return c, true
	case "/new":
		if len(fields) < 3 {
			return Command{Kind: "new", Error: "用法：/new <项目> [codex|claude] <任务内容>；或 新建任务：<内容>"}, true
		}
		c := Command{Kind: "new", Project: fields[1]}
		body := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(strings.TrimPrefix(text, fields[0])), fields[1]))
		if fields[2] == "codex" || fields[2] == "claude" {
			c.Agent = fields[2]
			body = strings.TrimSpace(strings.TrimPrefix(body, c.Agent))
		}
		c.Text = body
		return c, true
	case "/task":
		c := Command{Kind: "action"}
		if len(fields) < 2 || len(fields) > 3 {
			c.Error = "用法：/task close|complete|reopen|destroy|retry [任务编号]"
			return c, true
		}
		c.Action = fields[1]
		switch c.Action {
		case "close", "complete", "reopen", "destroy", "retry":
		default:
			c.Error = "未知任务操作；" + Help
		}
		if len(fields) == 3 {
			c.ID = fields[2]
		}
		return c, true
	case "新建任务":
		return Command{Kind: "new", Error: "请补充任务内容，例如：新建任务：修复登录问题"}, true
	}
	return Command{}, false
}

func noticePrefix(status Status) string { return "任务进展：" + status.Label() + "\n" }

// NotificationChat keeps execution updates in the surviving task group. Before
// group creation and after deletion, the entry chat receives lifecycle notices.
func NotificationChat(r Record) string {
	if r.ChatID != "" && !r.ChatDeleted {
		return r.ChatID
	}
	return r.EntryChatID
}

// Notice is a compact lifecycle/progress summary. The notifier separately
// mirrors full agent replies, so this message never repeats the transcript.
func Notice(r Record) string {
	if r.Status == Destroyed {
		return "会话清理结果：" + r.Title + "\n" + r.Detail + "\n" + r.Error + "\n代码和飞书任务记录保留。\n" + r.URL
	}
	if r.Error != "" {
		return "任务需要处理：" + r.Title + "\n" + r.Error + "\n编号：" + r.ID + "\n用 /tasks 查看进展。"
	}
	if r.SyncError != "" {
		return "任务同步失败：" + r.Title + "\n" + r.SyncError + "\n编号：" + r.ID + "\n系统将重试同步，可用 /tasks 查看状态。"
	}
	if r.ID == "" {
		return ""
	}
	detail := clip(r.Detail, 500)
	switch r.Status {
	case Queued:
		detail = "已收到任务，正在准备飞书任务和专属任务群。"
	case Review:
		detail += "\n请直接在本群继续反馈。" + GroupCloseHint
	case Blocked:
		if !r.PromptSent {
			detail += "\n请查看本群的启动确认卡片；若没有可选按钮，在本机 herdr 对应窗口完成首次目录信任。确认后会自动发送任务。"
		} else {
			detail += "\n请在本群查看 agent 的问题或审批卡片并处理。"
		}
	case Completed:
		if r.CloseRequested {
			detail = "已确认验收，正在保存结果并准备关闭任务会话。"
		} else {
			detail = "任务已完成。当前会话保留；可在本群要求重开，或明确结单关闭会话。"
		}
	}
	return noticePrefix(r.Status) + r.Title + "\n" + detail
}
