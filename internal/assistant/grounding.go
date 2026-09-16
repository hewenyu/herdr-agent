package assistant

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/hewenyu/herdr-agent/internal/tasks"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

// The model selects operations and asks clarifying questions. Facts shown after
// those operations come from their receipts, never from generated final prose.
type observation struct {
	name    string
	result  json.RawMessage
	failed  bool
	problem string
}

func modelHistory(messages []Message) []Message {
	out := append([]Message(nil), messages...)
	for i := range out {
		if out[i].Role == "assistant" {
			out[i].Content = "（历史助手回复已省略，不能作为任务状态或操作结果的证据；任务指代请结合用户历史和本轮真实任务快照。若上一轮中断，操作可能已登记，请查询实际状态。）"
		}
	}
	return out
}

func snapshotContext(records []tasktools.Task) string {
	// Keep recent known task IDs and group links available for references such
	// as "刚才那个任务", without letting old generated text invent those facts.
	recent := append([]tasktools.Task(nil), records...)
	sort.SliceStable(recent, func(i, j int) bool { return recent[i].UpdatedAt.After(recent[j].UpdatedAt) })
	if len(recent) > 30 {
		recent = recent[:30]
	}
	for i := range recent {
		recent[i].Title = clip(recent[i].Title, 500)
		recent[i].LatestReply = clip(recent[i].LatestReply, 1200)
		recent[i].Progress = clip(recent[i].Progress, 500)
	}
	data, _ := json.Marshal(recent)
	return "\n本轮最新任务快照（JSON数据，仅包含已验证身份可访问的任务；状态来自工具，latest_reply仅是agent自述，不代表产物已独立验证）：\n" + string(data)
}

func compactQuery(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || strings.ContainsRune("，。！？,.!?：:；;\"'“”‘’", r) {
			return -1
		}
		return unicode.ToLower(r)
	}, strings.TrimSpace(text))
}

func progressOnly(text string, records []tasktools.Task) bool {
	query := compactQuery(text)
	// Resolve a named task/project before recognizing a bounded status question.
	// Any remaining implementation request keeps the message on the AI path.
	for _, record := range records {
		for _, name := range []string{record.ID, record.Project, record.Title} {
			if len([]rune(name)) >= 2 {
				query = strings.ReplaceAll(query, compactQuery(name), "任务")
			}
		}
	}
	for _, prefix := range []string{"麻烦你", "麻烦", "请你", "请", "帮我", "帮忙", "你能", "能不能"} {
		query = strings.TrimPrefix(query, prefix)
	}
	for _, prefix := range []string{"告诉我", "查看一下", "查询一下", "看一下", "看下", "查看", "查询", "看看"} {
		query = strings.TrimPrefix(query, prefix)
	}
	for _, suffix := range []string{"谢谢", "呢", "呀"} {
		query = strings.TrimSuffix(query, suffix)
	}
	query = strings.ReplaceAll(query, "任务任务", "任务")
	switch query {
	case "进度", "进展", "状态", "任务进度", "项目进度", "任务状态", "项目状态", "任务的进度", "项目的进度", "当前任务", "当前进度", "目前进度", "现在进度", "当前任务进度", "目前任务进度", "现在任务进度", "最新进度", "任务最新进度",
		"进度如何", "进度怎么样", "进度怎样", "进展如何", "进展怎么样", "任务进度如何", "项目进度如何", "任务进度怎么样", "项目进度怎么样", "任务的进度怎么样", "项目的进度怎么样", "现在任务进度如何", "现在项目进度如何", "现在任务进度怎么样", "现在项目进度怎么样", "当前任务进度如何", "目前任务进度如何", "任务现在什么进度", "项目现在什么进度", "任务现在进度如何", "任务现在进度怎么样", "现在什么进度", "目前什么进度", "现在进度如何", "现在进度怎么样",
		"任务状态如何", "项目状态如何", "任务状态怎么样", "现在任务状态", "现在任务状态如何", "任务进行到哪一步了", "进行到哪一步了", "现在进行到哪了", "现在做得怎么样", "现在做得怎么样了", "做得怎么样了", "任务做得怎么样了", "任务完成了吗", "项目完成了吗", "这个任务完成了吗", "完成了吗", "做完了吗", "现在怎么样了",
		"有哪些任务", "任务列表", "现在有哪些任务", "目前有哪些任务", "正在进行哪些任务", "现在正在进行哪些任务", "有哪些任务正在进行", "目前正在做哪些任务", "正在做哪些任务", "有哪些进行中的任务":
		return true
	default:
		return false
	}
}

func progressRecords(text string, records []tasktools.Task, group bool) []tasktools.Task {
	if group {
		return records
	}
	var named, active []tasktools.Task
	query := compactQuery(text)
	for _, r := range records {
		for _, name := range []string{r.ID, r.Project, r.Title} {
			if len([]rune(name)) >= 2 && strings.Contains(query, compactQuery(name)) {
				named = append(named, r)
				break
			}
		}
		if r.Status != tasks.Completed && r.Status != tasks.Destroyed {
			active = append(active, r)
		}
	}
	if len(named) > 0 {
		return named
	}
	return active
}

func renderTasks(records []tasktools.Task) string {
	if len(records) == 0 {
		return "目前没有正在进行的任务。"
	}
	var lines []string
	for i, r := range records {
		if i == 15 {
			lines = append(lines, fmt.Sprintf("另有 %d 项任务未展开，可指定项目或任务查询。", len(records)-i))
			break
		}
		title := clip(strings.TrimSpace(r.Title), 180)
		if title == "" {
			title = r.ID
		}
		lines = append(lines, fmt.Sprintf("%s\n任务：%s · 项目：%s\n当前状态：%s", title, r.ID, r.Project, r.Status.Label()))
		if !r.Started {
			lines = append(lines, "执行会话尚未启动，不能确认任务已执行或生成产物。")
		} else if !r.PromptSent {
			lines = append(lines, "初始任务要求尚未确认发送，不能确认任务已执行或生成产物。")
		}
		if r.Status == tasks.Blocked && !r.PromptSent {
			lines = append(lines, "请处理任务群中的启动确认卡片；若没有可选按钮，在本机 herdr 对应窗口完成首次目录信任，随后会自动发送任务。")
		}
		if r.Progress != "" {
			lines = append(lines, "当前进展："+clip(r.Progress, 500))
		}
		if r.Error != "" {
			lines = append(lines, "需要处理："+clip(r.Error, 500))
		}
		if r.PendingOperation != "" {
			lines = append(lines, "结果待确认的操作："+r.PendingOperation)
		}
		if r.CompletionRequest != "" {
			lines = append(lines, "等待飞书确认的状态操作："+r.CompletionRequest)
		}
		if r.CloseRequested {
			lines = append(lines, "结单已登记，正在同步完成并关闭会话。")
		}
		if r.SyncError != "" {
			lines = append(lines, "飞书同步问题："+clip(r.SyncError, 500))
		}
		for _, directory := range r.WorkingDirectories {
			lines = append(lines, "本地工作目录："+directory.Path)
			switch {
			case !directory.Available:
				lines = append(lines, "目录现况："+directory.Problem+"，无法核实落盘产物。")
			case directory.Empty:
				lines = append(lines, "目录现况：暂无文件或子目录（不含 .git），没有可见的落盘产物。")
			default:
				entries := strings.Join(directory.Entries, "、")
				if directory.Truncated {
					entries += "（仅展示前 20 项）"
				}
				lines = append(lines, "目录顶层条目："+entries+"。这些现有条目不能证明由本任务生成。")
			}
		}
		if len(r.WorkingDirectories) == 0 && r.WorkingDirectory != "" {
			lines = append(lines, "本地工作目录："+r.WorkingDirectory)
		}
		if r.Started && r.PromptSent && r.LatestReply != "" {
			lines = append(lines, "agent 最近反馈（产物和测试结果未由任务助手独立验证）：\n"+clip(r.LatestReply, 1200))
		}
		if !r.UpdatedAt.IsZero() {
			lines = append(lines, "状态更新时间："+r.UpdatedAt.Format(time.RFC3339))
		}
		if r.TaskURL != "" {
			lines = append(lines, "飞书任务："+r.TaskURL)
		}
		if r.ChatURL != "" {
			lines = append(lines, "任务群："+r.ChatURL)
		}
		lines = append(lines, "")
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func groundedReply(calls []observation, fallback []tasktools.Task, generated string) string {
	if len(calls) == 0 {
		if reply := conversationalReply(generated); reply != "" {
			return reply
		}
		return "本轮未执行新的任务操作，以下是系统实际记录的状态：\n\n" + renderTasks(fallback)
	}
	var lines []string
	var records []tasktools.Task
	seenTasks := map[string]int{}
	addTask := func(r tasktools.Task) {
		if r.ID == "" {
			return
		}
		if i, ok := seenTasks[r.ID]; ok {
			records[i] = r
		} else {
			seenTasks[r.ID] = len(records)
			records = append(records, r)
		}
	}
	seenLines := map[string]bool{}
	addLine := func(line string) {
		if line != "" && !seenLines[line] {
			lines = append(lines, line)
			seenLines[line] = true
		}
	}
	queriedTasks := false
	mutated := false
	failed := false
	for _, call := range calls {
		if call.failed {
			failed = true
			addLine("操作未确认：" + clip(call.problem, 350) + "。本轮未自动重发，请以实际任务状态为准。")
			continue
		}
		switch call.name {
		case "herdr_projects":
			var projects []struct {
				Name           string `json:"name"`
				Agent          string `json:"default_agent"`
				Default        bool   `json:"default"`
				DirectoryCount int    `json:"directory_count"`
			}
			if json.Unmarshal(call.result, &projects) == nil {
				if len(projects) == 0 {
					addLine("尚未配置项目，可先在本地配置页面关联项目目录。")
				}
				for _, p := range projects {
					mark := ""
					if p.Default {
						mark = "（默认）"
					}
					addLine(fmt.Sprintf("可用项目：%s%s · %s · %d 个目录", p.Name, mark, p.Agent, p.DirectoryCount))
				}
			}
		case "herdr_list":
			var listed []tasktools.Task
			if json.Unmarshal(call.result, &listed) == nil {
				queriedTasks = true
				for _, r := range listed {
					addTask(r)
				}
			}
		case "herdr_get":
			var r tasktools.Task
			if json.Unmarshal(call.result, &r) == nil {
				queriedTasks = true
				addTask(r)
			}
		default:
			mutated = true
			var receipt struct {
				Outcome  string         `json:"outcome"`
				Replayed bool           `json:"replayed"`
				Task     tasktools.Task `json:"task"`
				Delivery *struct {
					Queued                bool `json:"queued"`
					CancelledDialog       bool `json:"cancelled_dialog"`
					MayHaveAnsweredDialog bool `json:"may_have_answered_dialog"`
				} `json:"delivery"`
			}
			if json.Unmarshal(call.result, &receipt) != nil || receipt.Task.ID == "" {
				continue
			}
			addTask(receipt.Task)
			if receipt.Replayed {
				addLine("已读取此前操作回执，本次未重复执行。")
			}
			switch call.name {
			case "herdr_create":
				addLine("任务已登记，系统将创建飞书任务和专属任务群并启动 agent。后续实现讨论、进度查询和验收均可在任务群内进行。")
			case "herdr_send":
				if receipt.Outcome == "delivered" {
					if receipt.Delivery != nil && receipt.Delivery.Queued {
						addLine("后续要求已投递并排队，agent 将稍后读取。")
					} else {
						addLine("后续要求已送达当前任务的 agent。")
					}
				} else {
					addLine("后续要求的投递尚未确认，未自动重发；请检查任务会话。")
				}
				if receipt.Delivery != nil && (receipt.Delivery.CancelledDialog || receipt.Delivery.MayHaveAnsweredDialog) {
					addLine("此次输入可能取消或回答了终端中的对话，请核对 agent 会话。")
				}
			case "herdr_close":
				addLine("结单请求已登记；确认飞书任务完成后，将关闭执行会话并解散本群，代码和任务结果摘要保留。")
			case "herdr_complete":
				addLine("验收完成请求已登记，正在等待飞书同步；任务群与执行会话保留。")
			case "herdr_reopen":
				addLine("重新打开任务的请求已登记。")
			case "herdr_retry":
				addLine("任务重试请求已登记。")
			case "herdr_destroy":
				if receipt.Outcome == "already_destroyed" {
					addLine("执行会话已销毁，本次未重复操作。")
				} else {
					addLine("销毁执行会话的请求已登记，将关闭任务窗口并解散私有群；这不会自动标记任务完成。")
				}
			}
		}
	}
	// Project discovery may legitimately end with a question about missing task
	// details. Keep that question when no state-changing operation was reported.
	if !mutated {
		addLine(conversationalReply(generated))
	}
	if len(records) != 0 || queriedTasks {
		lines = append(lines, renderTasks(records))
	} else if failed {
		lines = append(lines, "系统当前任务记录：\n"+renderTasks(fallback))
	} else if len(lines) == 0 {
		lines = append(lines, "尚未取得可确认的操作结果。", renderTasks(fallback))
	}
	return strings.Join(lines, "\n\n")
}

// No generated factual prose is displayed without a receipt. For ordinary
// greetings and clarification the model may select only a fixed, nonfactual
// response, so paraphrasing "done" cannot evade a keyword filter.
func conversationalReply(generated string) string {
	text := strings.TrimSpace(generated)
	if len([]rune(text)) > 600 || unsupportedClaim.MatchString(text) {
		return ""
	}
	for _, greeting := range []string{"你好", "您好", "Hello", "hello", "Hi", "hi"} {
		if strings.HasPrefix(text, greeting) {
			return "你好，可以在主应用创建任务，或在任务群继续讨论、查询进度和验收。"
		}
	}
	question := false
	for _, prefix := range []string{"请问", "请提供", "请说明", "请告诉我", "请补充", "你希望", "您希望", "你想", "您想", "能否提供", "可以提供", "需要我", "你指的是", "您指的是"} {
		question = question || strings.HasPrefix(text, prefix)
	}
	if !question {
		return ""
	}
	switch {
	case strings.Contains(text, "项目"):
		return "你希望使用哪个项目？请提供已配置的项目名称；若要创建新项目，请明确说明。"
	case strings.Contains(text, "哪项任务") || strings.Contains(text, "哪个任务") || strings.Contains(text, "任务编号"):
		return "你指的是哪项任务？请提供任务名称或编号。"
	case strings.Contains(strings.ToLower(text), "codex") || strings.Contains(strings.ToLower(text), "claude"):
		return "这次希望使用 Codex 还是 Claude Code？"
	default:
		return "请补充这次需要完成的具体目标，或需要修改的行为与预期结果。"
	}
}

var unsupportedClaim = regexp.MustCompile(`(?i)(https?://|applink\.|\b(status|completion_request|implementing|done|completed|generated|created|delivered|running|queued)\b|visual[ _-]*pass|tests? passed|[12][0-9]{3}-[01][0-9]-[0-3][0-9]|\b[0-9]+(?:\.[0-9]+)?\s*(kb|mb|bytes?)\b|[[:alnum:]_-]+\.(svg|html?|png|jpe?g|go|js|tsx?|py|json)\b|已(?:经)?(?:完成|创建|生成|发送|送达|实现|修复|通过|启动|登记|验收|销毁|关闭)|正在(?:执行|运行|实现|启动|处理|生成)|测试通过|验收通过|完成了|状态[：:]|进度[：:])`)

func clip(text string, limit int) string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return string(runes)
}
