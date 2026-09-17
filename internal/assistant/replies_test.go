package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/tasks"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

func TestProgressQueriesReachModelAndUseSelectedTool(t *testing.T) {
	for _, group := range []bool{false, true} {
		t.Run(fmt.Sprintf("group=%v", group), func(t *testing.T) {
			h := newGroupServiceHarness(t)
			const answer = "agent 反馈首条任务尚未送达，我会在得到新的执行记录后再说明产物情况。"
			e := &serviceTestEngine{run: func(ctx context.Context, history []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
				if strings.Contains(history[0].Content, "alice-private-task") || strings.Contains(history[0].Content, `"status":"running"`) {
					t.Fatal("service injected a task snapshot before the model selected a query")
				}
				h.manager.mu.Lock()
				r := h.manager.records["owned"]
				r.Status, r.Detail, r.PromptSent = tasks.Attention, "首条任务尚未送达", false
				h.manager.records[r.ID] = r
				h.manager.mu.Unlock()
				result, err := call(ctx, "herdr_get", json.RawMessage(`{"task_id":"owned"}`))
				if err != nil {
					return "", err
				}
				current := result.(tasktools.Task)
				if current.Status != tasks.Attention || current.PromptSent || current.Progress != r.Detail {
					t.Fatalf("selected tool returned stale state: %+v", current)
				}
				return answer, nil
			}}
			in := serviceMessage("alice", "entry", "progress", "现在任务进度如何")
			if group {
				in = groupMessage("progress", in.Text)
			}
			if got := serviceReply(t, h.service(t, e), in); got != answer || len(e.calls()) != 1 {
				t.Fatalf("model progress reply was bypassed or rewritten: %q", got)
			}
			if len(h.manager.created()) != 0 || len(h.manager.requests) != 0 || len(h.controller.texts) != 0 {
				t.Fatal("read-only tool selection caused an unrelated operation")
			}
		})
	}
}

func TestModelReplyIsPreservedWithAndWithoutToolCalls(t *testing.T) {
	for _, tool := range []string{"", "herdr_projects", "herdr_get", "herdr_create"} {
		t.Run(tool, func(t *testing.T) {
			h := newServiceHarness(t)
			// Words that previously activated deterministic claim filtering are
			// intentional here: this verifies transport, not model factuality.
			const answer = "  **任务已登记**，当前状态：执行中。\n下一步请在任务群反馈 SVG 文件。\n"
			e := &serviceTestEngine{run: func(ctx context.Context, _ []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
				if tool != "" {
					args := `{}`
					if tool == "herdr_get" {
						args = `{"task_id":"owned"}`
					} else if tool == "herdr_create" {
						args = `{"project":"project","text":"draw SVG"}`
					}
					if _, err := call(ctx, tool, json.RawMessage(args)); err != nil {
						return "", err
					}
				}
				return answer, nil
			}}
			in := serviceMessage("alice", "entry", "reply", "创建一个动画任务")
			if got := serviceReply(t, h.service(t, e), in); got != answer {
				t.Fatalf("model reply changed: %q", got)
			}
			state, err := readSession(onlySessionFile(t, h), "alice", "entry", "")
			if err != nil || state.Messages[len(state.Messages)-1].Content != answer {
				t.Fatalf("saved dialogue differs from visible answer: %+v, %v", state.Messages, err)
			}
			afterRestart := &serviceTestEngine{}
			if got := serviceReply(t, h.service(t, afterRestart), in); got != answer || len(afterRestart.calls()) != 0 {
				t.Fatal("durable reply replay changed model output or reran the model")
			}
		})
	}
}

func TestModelFailureDoesNotReturnOldTaskAsFallback(t *testing.T) {
	for _, text := range []string{"现在任务进度如何", "创建一个宇宙飞船动画的新项目"} {
		t.Run(text, func(t *testing.T) {
			h := newServiceHarness(t)
			e := &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
				return "未发送的模型片段", errModelCall
			}}
			answer, err := h.service(t, e).Reply(context.Background(), serviceMessage("alice", "entry", "failed", text))
			if !errors.Is(err, errModelCall) || answer != "" || len(e.calls()) != 1 {
				t.Fatalf("model failure produced a task fallback: answer=%q err=%v", answer, err)
			}
			if len(h.manager.created()) != 0 {
				t.Fatal("model failure created a task")
			}
		})
	}
}

// A local project adapter keeps this service regression isolated from the real
// user home and external agents, while exercising herdr_create's new_project flow.
type serviceProjectCatalog struct {
	root string
	cfg  config.Tasks
}

func (c *serviceProjectCatalog) Snapshot() config.Tasks { return c.cfg }
func (c *serviceProjectCatalog) Create(_ context.Context, name, agent string, _ bool) (config.Project, error) {
	p := config.Project{Path: filepath.Join(c.root, name), Agent: agent}
	if err := os.Mkdir(p.Path, 0700); err != nil {
		return config.Project{}, err
	}
	c.cfg.Projects[name] = p
	return p, nil
}

func TestSecondNewProjectRequestCreatesSpaceshipAlongsidePelican(t *testing.T) {
	h := newServiceHarness(t)
	delete(h.manager.records, "owned")
	catalog := &serviceProjectCatalog{root: t.TempDir(), cfg: config.Tasks{Projects: map[string]config.Project{}}}
	backend, err := tasktools.New(tasktools.Options{OwnerID: "alice", EntryChatID: "entry", StatePath: h.operations,
		Projects: catalog, Manager: h.manager, Registry: serviceTestRegistry{}, Controller: h.controller})
	if err != nil {
		t.Fatal(err)
	}
	requests := []struct{ project, text, answer string }{
		{"pelican-bike", "创建一个新项目，使用codex，创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，不用进行测试", "已登记鹈鹕骑车动画，项目名采用 pelican-bike。"},
		{"spaceship", "创建一个新项目，使用codex，创建一个HTML，内容是SVG绘制一个宇宙飞船的2D动画，不用进行测试", "宇宙飞船动画已登记为独立项目 spaceship，可在新任务群查看进度。"},
	}
	var turn int
	e := &serviceTestEngine{run: func(ctx context.Context, history []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
		request := requests[turn]
		if history[len(history)-1].Content != request.text {
			t.Fatal("new request did not reach the model intact")
		}
		if turn == 1 {
			if len(history) != 4 || history[2].Content != requests[0].answer {
				t.Fatalf("second project lost the preceding visible dialogue: %+v", history)
			}
			result, err := call(ctx, "herdr_list", json.RawMessage(`{}`))
			if err != nil {
				return "", err
			}
			if list := result.([]tasktools.Task); len(list) != 1 || list[0].Project != "pelican-bike" {
				t.Fatalf("regression setup did not retain the first active task: %+v", list)
			}
		}
		args, _ := json.Marshal(map[string]any{"project": request.project, "agent": "codex", "new_project": true, "text": request.text})
		if _, err := call(ctx, "herdr_create", args); err != nil {
			return "", err
		}
		turn++
		return request.answer, nil
	}}
	for i, request := range requests {
		// Recreate Service between messages to exercise persisted conversation
		// context as well as keeping two project operations independent.
		s, err := New(e, backend, h.dir, 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if got := serviceReply(t, s, serviceMessage("alice", "entry", fmt.Sprintf("create-%d", i), request.text)); got != request.answer {
			t.Fatalf("creation response replaced with previous task state: %q", got)
		}
	}
	if len(e.calls()) != 2 || len(h.manager.created()) != 2 || len(catalog.cfg.Projects) != 2 {
		t.Fatal("second explicit project request was swallowed or reused the first project")
	}
	for i, request := range requests {
		r, ok := h.manager.Get(fmt.Sprintf("created-%d", i+1))
		if !ok || r.Project != request.project || r.Title != request.text || r.Agent != "codex" {
			t.Fatalf("new task lost project, agent or original constraints: %+v", r)
		}
		if info, err := os.Stat(filepath.Join(catalog.root, request.project)); err != nil || !info.IsDir() {
			t.Fatalf("new project adapter did not create a separate directory: %v", err)
		}
	}
}
