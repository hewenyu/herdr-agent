package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/tasks"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

const inventedStatus = "status done、completion_request true，已生成 pelican-bike.svg 11KB 和 index.html，Visual PASS，更新时间 2026-03-03，https://example.invalid/fake-task"

func unfinishedRecord(h *serviceHarness, directory string) {
	r := h.manager.records["owned"]
	r.Path, r.Directories = directory, []string{directory}
	r.Started, r.PromptSent = true, false
	r.Status, r.Detail, r.Error = tasks.Attention, "首条任务未确认送达", "agent 会话尚未就绪"
	r.Result = ""
	r.UpdatedAt = time.Date(2026, time.September, 16, 10, 0, 0, 0, time.UTC)
	h.manager.records[r.ID] = r
}

func assertRealUnfinished(t *testing.T, answer, directory string) {
	t.Helper()
	for _, want := range []string{"当前状态：需要处理", "初始任务要求尚未确认发送", "首条任务未确认送达", "暂无文件", directory, "2026-09-16T10:00:00Z"} {
		if !strings.Contains(answer, want) {
			t.Fatalf("missing real state %q in: %s", want, answer)
		}
	}
	for _, fake := range []string{"status done", "completion_request true", "pelican-bike.svg", "11KB", "Visual PASS", "2026-03-03", "example.invalid"} {
		if strings.Contains(answer, fake) {
			t.Fatalf("fabricated result %q reached the user: %s", fake, answer)
		}
	}
}

func TestProgressQueriesUseActualStateWithoutModelInPrivateAndGroup(t *testing.T) {
	for _, scope := range []string{"private", "group"} {
		t.Run(scope, func(t *testing.T) {
			h := newGroupServiceHarness(t)
			directory := t.TempDir()
			unfinishedRecord(h, directory)
			e := &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
				return inventedStatus, errors.New("progress should work even when the model is unavailable")
			}}
			in := serviceMessage("alice", "private-chat", "progress", "现在任务进度如何")
			if scope == "group" {
				in = groupMessage("progress", "请告诉我项目进度怎么样？")
			}
			answer := serviceReply(t, h.service(t, e), in)
			assertRealUnfinished(t, answer, directory)
			if len(e.calls()) != 0 || len(h.manager.created()) != 0 || len(h.manager.requests) != 0 || len(h.controller.texts) != 0 {
				t.Fatal("progress-only query reached the model or caused an effect")
			}
		})
	}
}

func TestModelCannotOverwriteToolResultsWithFabricatedArtifacts(t *testing.T) {
	for _, withTool := range []bool{false, true} {
		t.Run(map[bool]string{false: "no-tool", true: "after-tool"}[withTool], func(t *testing.T) {
			h := newGroupServiceHarness(t)
			directory := t.TempDir()
			unfinishedRecord(h, directory)
			e := &serviceTestEngine{run: func(ctx context.Context, history []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
				if !strings.Contains(history[0].Content, `"prompt_sent":false`) || !strings.Contains(history[0].Content, `"status":"attention"`) {
					return "", errors.New("latest true snapshot was not supplied")
				}
				if withTool {
					if _, err := call(ctx, "herdr_get", json.RawMessage(`{"task_id":"owned"}`)); err != nil {
						return "", err
					}
				}
				return inventedStatus, nil
			}}
			answer := serviceReply(t, h.service(t, e), serviceMessage("alice", "private-chat", "details", "请汇报这一项工作的具体执行情况"))
			assertRealUnfinished(t, answer, directory)
		})
	}
}

func TestFabricatedHistoricalAssistantReplyIsNotReusedAsEvidence(t *testing.T) {
	h := newGroupServiceHarness(t)
	directory := t.TempDir()
	unfinishedRecord(h, directory)
	in := serviceMessage("alice", "private-chat", "initial", "你好")
	serviceReply(t, h.service(t, &serviceTestEngine{}), in)
	path := onlySessionFile(t, h)
	state, err := readSession(path, "alice", "private-chat", "")
	if err != nil {
		t.Fatal(err)
	}
	state.Messages[len(state.Messages)-1].Content = inventedStatus
	if err := writeSession(path, state); err != nil {
		t.Fatal(err)
	}
	e := &serviceTestEngine{run: func(ctx context.Context, history []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
		for _, message := range history {
			if strings.Contains(message.Content, "Visual PASS") || strings.Contains(message.Content, "2026-03-03") {
				return "", errors.New("historical invented facts reached model context")
			}
		}
		_, err := call(ctx, "herdr_get", json.RawMessage(`{"task_id":"owned"}`))
		return inventedStatus, err
	}}
	answer := serviceReply(t, h.service(t, e), serviceMessage("alice", "private-chat", "next", "汇报刚才那项工作的执行细节"))
	assertRealUnfinished(t, answer, directory)
}

func TestProgressRecognitionDoesNotSwallowFeedbackOrAcceptance(t *testing.T) {
	for _, input := range []string{"进度显示不对，请修复", "查询进度后把按钮改成红色", "任务完成了吗？如果完成就关闭", "项目还没有完成，请继续", "不要关闭，验收没有通过", "验收通过，可以结单", "请新建一个查询任务进度的页面"} {
		if progressOnly(input, nil) {
			t.Fatalf("non-query work was treated as a status-only request: %s", input)
		}
	}
	for _, tc := range []struct{ answer, want string }{
		{"你好，可以在这里创建任务或查询进度。", "你好"},
		{"你希望在哪个项目创建任务？", "你希望使用哪个项目"},
		{"请提供需要修改的具体行为和预期结果。", "请补充这次需要完成的具体目标"},
	} {
		if got := groundedReply(nil, nil, tc.answer); !strings.Contains(got, tc.want) {
			t.Fatalf("ordinary greeting or clarification was discarded: %q => %q", tc.answer, got)
		}
	}
	for _, invented := range []string{"任务做完了，成品都在目录里", "你希望查看结果吗？工作全部结束，作品放在输出目录。", "已经为你处理妥当，可直接验收。"} {
		if got := groundedReply(nil, nil, invented); strings.Contains(got, "成品") || strings.Contains(got, "工作全部结束") || strings.Contains(got, "处理妥当") || got == invented {
			t.Fatalf("paraphrased no-tool completion claim escaped deterministic output: %s", got)
		}
	}
}

func TestAgentSelfReportDoesNotReplaceDirectoryObservation(t *testing.T) {
	r := tasktools.Task{ID: "task", Title: "draw picture", Status: tasks.Review, Started: true, PromptSent: true,
		LatestReply: "生成了 image.svg，测试通过", WorkingDirectories: []tasktools.Directory{{Path: "/actual/task", Available: true, Empty: true}}}
	answer := renderTasks([]tasktools.Task{r})
	if !strings.Contains(answer, "暂无文件") || !strings.Contains(answer, "agent 最近反馈（产物和测试结果未由任务助手独立验证）") || !strings.Contains(answer, "待验收") {
		t.Fatalf("agent self-report hid real empty directory or became completed status: %s", answer)
	}
}
