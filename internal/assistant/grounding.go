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

const failedDialogueContext = "（本轮助手回复失败，没有给出可供确认的新项目名或方案，也未调用任务工具。不能将这一轮当作已经提出建议；若后续短答没有明确指代，请先澄清。）"

func modelHistory(messages []Message) []Message {
	out := append([]Message(nil), messages...)
	for i := range out {
		if out[i].Role == "assistant" {
			if out[i].Kind == "failure" {
				// Never invent a visible proposal from an API error or a partial
				// response. This marker also survives compaction and restart.
				out[i].Content = failedDialogueContext
				continue
			}
			if out[i].Kind == "receipt" && out[i].Dialogue != "" && conversationalReply(out[i].Dialogue) != "" {
				out[i].Content = out[i].Dialogue
				continue
			}
			// Keep questions and suggestions: short replies such as "use that
			// name" depend on what the user actually saw in the previous turn.
			// Receipts are historical facts, replaced by the fresh snapshot.
			if out[i].Kind != "receipt" && conversationalReply(out[i].Content) != "" {
				continue
			}
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
	compact := make([]tasktools.Task, 0, len(recent))
	for _, record := range recent {
		// The snapshot is an index, not an unbounded directory listing. Full
		// records remain available through scoped tools and receipt rendering.
		r := tasktools.Task{ID: record.ID, Project: record.Project, Agent: record.Agent,
			Title: clip(record.Title, 120), Status: record.Status, StatusLabel: record.StatusLabel,
			Started: record.Started, PromptSent: record.PromptSent, Progress: clip(record.Progress, 150),
			LatestReply: clip(record.LatestReply, 150), Error: clip(record.Error, 150), SyncError: clip(record.SyncError, 150),
			PendingOperation: record.PendingOperation, CompletionRequest: record.CompletionRequest,
			CloseRequested: record.CloseRequested, UpdatedAt: record.UpdatedAt}
		candidate := append(compact, r)
		encoded, _ := json.Marshal(candidate)
		if len(encoded) > 6000 {
			break
		}
		compact = candidate
	}
	data, _ := json.Marshal(compact)
	return "\n本轮最新任务快照索引（JSON数据，仅包含可访问的近期记录；详情或未列出的任务请调用工具。latest_reply仅是agent自述，不代表产物已独立验证）：\n" + string(data)
}

func compactQuery(text string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || strings.ContainsRune("，。！？,.!?：:；;\"'“”‘’", r) {
			return -1
		}
		return unicode.ToLower(r)
	}, strings.TrimSpace(text))
}

// Listing history is a choice made by the user, not by an all=true argument
// invented by the model. Keep this separate from group-bound task details.
func taskHistoryRequested(text string) bool {
	query := compactQuery(text)
	for _, current := range []string{"未完成", "未结束", "进行中", "正在进行", "正在做"} {
		if strings.Contains(query, current) {
			return false
		}
	}
	for _, marker := range []string{"历史", "所有任务", "全部任务", "已完成", "已销毁", "已结束", "已关闭"} {
		if strings.Contains(query, marker) {
			for _, negative := range []string{"不要", "不含", "不包括", "排除"} {
				if strings.Contains(query, negative+marker) {
					return false
				}
			}
			return true
		}
	}
	return explicitAllQuery.MatchString(strings.ToLower(text))
}

var explicitAllQuery = regexp.MustCompile(`(^|[^a-z])all($|[^a-z])`)

func progressOnly(text string, records []tasktools.Task) bool {
	query := compactQuery(text)
	// Resolve a named task/project before recognizing a bounded status question.
	// Any remaining implementation request keeps the message on the AI path.
	_, query = matchingTaskReferences(query, records, true)
	_, query = matchingTaskReferences(query, records, false)
	query = strings.ReplaceAll(query, "\x00", "任务")
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
		"有哪些任务", "任务列表", "现在有哪些任务", "现在还有哪些任务", "目前有哪些任务", "目前还有哪些任务", "还有哪些任务", "正在进行哪些任务", "现在正在进行哪些任务", "有哪些任务正在进行", "目前正在做哪些任务", "正在做哪些任务", "有哪些进行中的任务",
		"历史任务", "历史任务列表", "任务历史", "所有任务", "所有任务列表", "全部任务", "全部任务列表", "有哪些历史任务", "有哪些已完成的任务", "有哪些已完成任务", "已完成任务", "已完成的任务", "已销毁任务", "已销毁的任务", "已结束任务", "已结束的任务", "已关闭任务", "已关闭的任务":
		return true
	default:
		return false
	}
}

func progressRecords(text string, records []tasktools.Task, group bool) []tasktools.Task {
	return progressRecordsFromSnapshot(text, records, records, group)
}

// Resolve references against the complete snapshot before applying the active
// task filter. An empty result for a named project must not become an overview
// of unrelated projects, including when a list tool returns only active tasks.
func progressRecordsFromSnapshot(text string, records, snapshot []tasktools.Task, group bool) []tasktools.Task {
	if group {
		return records
	}
	query := compactQuery(text)
	identified, _ := matchingTaskReferences(query, snapshot, true)
	// An explicit task ID asks about that one record, even after it has ended.
	// Ordinary overviews and project references still default to active tasks.
	explicitID := len(identified) > 0
	if !explicitID {
		identified, _ = matchingTaskReferences(query, snapshot, false)
	}
	history := explicitID || taskHistoryRequested(text)
	selected := make([]tasktools.Task, 0, len(records))
	for _, r := range records {
		if len(identified) > 0 && !identified[r.ID] {
			continue
		}
		if history || r.Status != tasks.Completed && r.Status != tasks.Destroyed {
			selected = append(selected, r)
		}
	}
	return selected
}

func matchingTaskReferences(query string, records []tasktools.Task, idsOnly bool) (map[string]bool, string) {
	names := map[string][]string{}
	for _, r := range records {
		references := []string{r.Project, r.Title}
		if idsOnly {
			references = []string{r.ID}
		}
		for _, reference := range references {
			name := compactQuery(reference)
			if len([]rune(name)) >= 2 && strings.Contains(query, name) {
				names[name] = append(names[name], r.ID)
			}
		}
	}
	ordered := make([]string, 0, len(names))
	for name := range names {
		ordered = append(ordered, name)
	}
	// Consume longer names first so "api-web" does not also select "api".
	// A separate mention of "api" still matches after consuming "api-web".
	sort.Slice(ordered, func(i, j int) bool {
		if len(ordered[i]) != len(ordered[j]) {
			return len(ordered[i]) > len(ordered[j])
		}
		return ordered[i] < ordered[j]
	})
	matched := map[string]bool{}
	for _, name := range ordered {
		if !strings.Contains(query, name) {
			continue
		}
		for _, id := range names[name] {
			matched[id] = true
		}
		query = strings.ReplaceAll(query, name, "\x00")
	}
	return matched, query
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
		if r.CloseRequested && r.Status != tasks.Destroyed {
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

// Creation in the entry chat is a handoff to the task group. Read-only tools
// used to select a project or verify creation do not turn that acknowledgment
// into another execution update. Explicit query-only turns keep their normal
// status rendering, as do group messages and other requested operations.
func groundedCreationReply(calls []observation, snapshot []tasktools.Task) (string, bool) {
	creating := false
	for _, call := range calls {
		switch call.name {
		case "herdr_create":
			creating = true
		case "herdr_projects", "herdr_list", "herdr_get":
		default:
			return "", false
		}
	}
	if !creating {
		return "", false
	}
	latest := map[string]tasktools.Task{}
	for _, r := range snapshot {
		latest[r.ID] = r
	}
	for _, call := range calls {
		if call.failed {
			continue
		}
		switch call.name {
		case "herdr_get":
			var r tasktools.Task
			if json.Unmarshal(call.result, &r) == nil && r.ID != "" {
				latest[r.ID] = r
			}
		case "herdr_list":
			var records []tasktools.Task
			if json.Unmarshal(call.result, &records) == nil {
				for _, r := range records {
					latest[r.ID] = r
				}
			}
		}
	}
	var lines []string
	seen := map[string]bool{}
	addLine := func(line string) {
		if !seen[line] {
			lines = append(lines, line)
			seen[line] = true
		}
	}
	for _, call := range calls {
		if call.failed {
			addLine("操作未确认：" + clip(call.problem, 350) + "。本轮未自动重发，请查询任务列表核对。")
			continue
		}
		if call.name != "herdr_create" {
			continue
		}
		var receipt struct {
			Outcome  string         `json:"outcome"`
			Replayed bool           `json:"replayed"`
			Task     tasktools.Task `json:"task"`
		}
		if json.Unmarshal(call.result, &receipt) != nil || receipt.Outcome != "accepted" || receipt.Task.ID == "" {
			addLine("任务创建结果尚未确认，请查询任务列表核对；本轮未自动重发。")
			continue
		}
		if receipt.Replayed {
			addLine("已读取此前操作回执，本次未重复创建。")
		}
		r := receipt.Task
		if current, ok := latest[r.ID]; ok {
			r = current
		}
		parts := []string{"任务已登记：" + clip(r.Title, 180), fmt.Sprintf("任务：%s · 项目：%s", r.ID, r.Project)}
		if r.TaskURL != "" {
			parts = append(parts, "飞书任务："+r.TaskURL)
		}
		if r.Status == tasks.Destroyed {
			parts = append(parts, "该任务的执行会话与任务群已关闭；本次未创建新任务。")
		} else if r.Status == tasks.Destroying {
			parts = append(parts, "该任务的执行会话与任务群正在关闭；本次未创建新任务。")
		} else if r.ChatURL != "" {
			parts = append(parts, "任务群已创建："+r.ChatURL, "后续进展、确认和验收请在任务群处理。")
		} else {
			parts = append(parts, "请留意本应用的建群通知，其中提供任务群入口。后续进展、确认和验收请在任务群处理。")
		}
		addLine(strings.Join(parts, "\n"))
	}
	return strings.Join(lines, "\n\n"), true
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

// Ordinary conversation is preserved verbatim. This check is a defensive
// heuristic for unsupported execution claims, not a classifier of every fact
// in natural language. Task operations and progress are rendered from receipts
// separately; filenames, Markdown and question prefixes are not allowlists.
func conversationalReply(generated string) string {
	text := strings.TrimSpace(generated)
	if text == "" || len([]rune(text)) > 12000 || unverifiedOperationClaim(text) {
		return ""
	}
	return text
}

func unverifiedOperationClaim(text string) bool {
	// Quoted labels and examples are discussion, not execution receipts.
	text = quotedDialogue.ReplaceAllString(text, "")
	for _, sentence := range dialogueSentences.FindAllString(text, -1) {
		match := unsupportedClaim.FindStringIndex(sentence)
		if match == nil {
			continue
		}
		if conditionalAfterClaim.MatchString(sentence[match[1]:]) {
			continue
		}
		if strings.HasSuffix(strings.TrimSpace(sentence), "?") || strings.HasSuffix(strings.TrimSpace(sentence), "？") || conditionalDialogue.MatchString(sentence[:match[0]]) {
			continue
		}
		return true
	}
	return false
}

var quotedDialogue = regexp.MustCompile("`[^`\\n]*`|“[^”\\n]*”|‘[^’\\n]*’|\"[^\"\\n]*\"")
var dialogueSentences = regexp.MustCompile(`[^。！？!?\n；;，,]+[。！？!?\n；;，,]?`)
var conditionalAfterClaim = regexp.MustCompile(`^\s*(?:(?:之后|以后|后)(?:再|才|就|可以|会|关闭)|再|才)`)
var conditionalDialogue = regexp.MustCompile(`(?:如果|假如|尚未|还没有|还没|不能确认|未确认|是否|有没有|完成后|验收后|确认后|通过后|后再|才会|将会|我会|建议|例如|示例)`)
var unsupportedClaim = regexp.MustCompile(`(?i)(\bstatus\s*[:=]?\s*(done|completed|running|queued|implementing)\b|\bcompletion_request\b|visual[ _-]*pass|tests? passed|\b(?:already|i have|we have)\s+(?:completed|created|generated|delivered)\b|已(?:经)?(?:为你)?(?:完成|创建|生成|发送|送达|实现|修复|通过|启动|登记|验收|销毁|关闭|处理妥当)|正在(?:执行|运行|实现|启动|处理|生成)|测试通过|验收通过|完成了|做完了|工作全部结束|(?:成品|作品).*(?:目录|输出)|(?:当前状态|状态|进度|任务群|飞书任务)[：:])`)

func clip(text string, limit int) string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return string(runes)
}
