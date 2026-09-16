package tasks

import (
	"strings"
	"testing"
	"time"
)

func TestDescriptionExposesProgressAndResultAsReadableTaskText(t *testing.T) {
	r := Record{ID: "t_42", Project: "backend", Agent: "codex", Title: "修复登录问题", Status: Review, Detail: "修复已提交，登录测试通过，等待验收", Result: "修复了过期令牌重试；测试 8 项通过", Error: "还需确认线上回调地址", ChatID: "oc_task", UpdatedAt: time.Date(2026, 9, 16, 12, 34, 56, 0, time.UTC)}
	desc := Description(r)
	for _, want := range []string{r.Title, r.Project, r.Agent, r.Status.Label(), r.Detail, r.Result, r.Error, r.ID, "2026-09-16 12:34:56", ChatURL(r.ChatID), "验收", "勾选完成"} {
		if !strings.Contains(desc, want) {
			t.Errorf("public task description lacks %q: %s", want, desc)
		}
	}
	r.Status = Destroyed
	destroyed := Description(r)
	if strings.Contains(destroyed, ChatURL(r.ChatID)) {
		t.Error("destroyed task still advertises a deleted chat")
	}
	if !strings.Contains(destroyed, r.Result) || !strings.Contains(destroyed, r.Status.Label()) {
		t.Error("destroying a session lost the durable result or state")
	}
}

func TestTaskCommandsPreserveTaskTextAndRecognizeProgressQueries(t *testing.T) {
	tests := []struct {
		input string
		want  Command
	}{
		{"新建一个任务：修复登录问题", Command{Kind: "new", Text: "修复登录问题"}},
		{"新建任务: 为接口补充测试", Command{Kind: "new", Text: "为接口补充测试"}},
		{"/new backend claude 修复登录\n并验证退出登录", Command{Kind: "new", Project: "backend", Agent: "claude", Text: "修复登录\n并验证退出登录"}},
		{"/new backend 处理超时错误", Command{Kind: "new", Project: "backend", Text: "处理超时错误"}},
		{"飞书", Command{}},
		{"正在进行哪些任务", Command{Kind: "list"}},
		{"现在有哪些任务在进行？", Command{Kind: "list"}},
		{"/tasks all", Command{Kind: "list", All: true}},
		{"/task destroy t_42", Command{Kind: "action", Action: "destroy", ID: "t_42"}},
		{"/task complete", Command{Kind: "action", Action: "complete"}},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got, recognized := Parse(tt.input)
			if got != tt.want || recognized != (tt.want.Kind != "") {
				t.Fatalf("Parse = %+v, %v; want %+v", got, recognized, tt.want)
			}
		})
	}
	for _, input := range []string{"/new backend", "/task delete-all", "/tasks nonsense", "新建任务"} {
		if got, recognized := Parse(input); !recognized || got.Error == "" {
			t.Errorf("invalid command %q = %+v, %v", input, got, recognized)
		}
	}
}

func TestSummaryLetsUserIdentifyCurrentTasksAndSyncFailures(t *testing.T) {
	records := []Record{
		{ID: "t_1", Title: "修复登录", Project: "api", Agent: "codex", Status: Running, Detail: "正在验证重试逻辑", URL: "https://example.test/task/1", ChatID: "oc_1"},
		{ID: "t_2", Title: "排查构建", Project: "web", Agent: "claude", Status: Blocked, Detail: "等待审批", Error: "需要执行构建", SyncError: "temporary timeout"},
	}
	text := Summary(records)
	for _, want := range []string{"2", "修复登录", "执行中", "正在验证重试逻辑", "api", "codex", "t_1", records[0].URL, ChatURL("oc_1"), "排查构建", "等待你处理", "需要执行构建", "飞书同步暂未成功", "temporary timeout"} {
		if !strings.Contains(text, want) {
			t.Errorf("summary lacks %q: %s", want, text)
		}
	}
	if text := Summary(nil); !strings.Contains(text, "没有") || !strings.Contains(text, "新建任务") {
		t.Errorf("empty state = %s", text)
	}
}
