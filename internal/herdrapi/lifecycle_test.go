package herdrapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"
)

func TestLifecycleWorkspaceProtocol(t *testing.T) {
	srv := newFakeServer(t, func(req string) (string, bool) {
		var request wireRequest
		if err := json.Unmarshal([]byte(req), &request); err != nil {
			t.Error(err)
		}
		var result string
		switch request.Method {
		case "workspace.create":
			result = `{"type":"workspace_created","workspace":{"workspace_id":"w8","label":"task-42","worktree":{"checkout_path":"/repo"}},"root_pane":{"pane_id":"w8:p1","workspace_id":"w8","cwd":"/repo/project"}}`
		case "workspace.list":
			result = `{"type":"workspace_list","workspaces":[{"workspace_id":"w8","label":"task-42","worktree":{"checkout_path":"/repo"}},{"workspace_id":"w9","label":"non-git"}]}`
		case "pane.close":
			result = `{"type":"ok"}`
		default:
			t.Errorf("unexpected method %s", request.Method)
		}
		return fmt.Sprintf(`{"id":%q,"result":%s}`, request.ID, result), true
	})
	c := srv.client(t)
	workspace, err := c.WorkspaceCreate(context.Background(), "/repo/project", "task-42")
	if err != nil {
		t.Fatal(err)
	}
	if want := (WorkspaceInfo{ID: "w8", Label: "task-42", Cwd: "/repo/project", PaneID: "w8:p1"}); workspace != want {
		t.Fatalf("workspace = %+v, want %+v", workspace, want)
	}
	workspaces, err := c.WorkspaceList(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if want := []WorkspaceInfo{{ID: "w8", Label: "task-42", Cwd: "/repo"}, {ID: "w9", Label: "non-git"}}; !reflect.DeepEqual(workspaces, want) {
		t.Fatalf("workspace list = %+v, want %+v; list must not invent root panes", workspaces, want)
	}
	if err := c.PaneClose(context.Background(), workspace.PaneID); err != nil {
		t.Fatal(err)
	}
	reqs := srv.requests()
	if len(reqs) != 3 {
		t.Fatalf("requests = %v", reqs)
	}
	assertLifecycleRequest(t, reqs[0], "workspace.create", map[string]any{"cwd": "/repo/project", "label": "task-42", "focus": false})
	assertLifecycleRequest(t, reqs[1], "workspace.list", map[string]any{})
	assertLifecycleRequest(t, reqs[2], "pane.close", map[string]any{"pane_id": "w8:p1"})
}

func TestWorkspaceCreatePreservesIDOnMalformedResponse(t *testing.T) {
	srv := newFakeServer(t, func(req string) (string, bool) {
		return fmt.Sprintf(`{"id":%q,"result":{"type":"workspace_created","workspace":{"workspace_id":"w8","label":"task-42"}}}`, idOf(req)), true
	})
	workspace, err := srv.client(t).WorkspaceCreate(context.Background(), "/repo", "task-42")
	if err == nil || workspace.ID != "w8" {
		t.Fatalf("create = %+v, %v; malformed reply must preserve recoverable ID", workspace, err)
	}
}

const pendingLifecycleAgent = `{"pane_id":"w8:p1","terminal_id":"term-1","name":"task-42","agent":"codex","agent_status":"unknown","launch_pending":true}`

func lifecycleAgentServer(t *testing.T, polledAgents ...string) *fakeServer {
	t.Helper()
	var polls atomic.Uint64
	return newFakeServer(t, func(req string) (string, bool) {
		var request wireRequest
		if err := json.Unmarshal([]byte(req), &request); err != nil {
			t.Error(err)
		}
		if request.Method == "agent.read" {
			return fmt.Sprintf(`{"id":%q,"result":{"type":"pane_read","read":{"text":"› Ask Codex anything","truncated":false}}}`, request.ID), true
		}
		agent := pendingLifecycleAgent
		resultType := "agent_started"
		if request.Method == "agent.get" {
			idx := min(int(polls.Add(1))-1, len(polledAgents)-1)
			agent = polledAgents[idx]
			resultType = "agent_info"
		} else if request.Method != "agent.start" {
			t.Errorf("startup must never send task text or approval keys; got %s", request.Method)
		}
		return fmt.Sprintf(`{"id":%q,"result":{"type":%q,"agent":%s}}`, request.ID, resultType, agent), true
	})
}

func TestAgentStartWaitsForInteractiveReadiness(t *testing.T) {
	srv := lifecycleAgentServer(t,
		`{"pane_id":"w8:p1","terminal_id":"term-1","name":"task-42","agent":"codex","agent_status":"idle","interactive_ready":false,"launch_pending":true}`,
		`{"pane_id":"w8:p1","terminal_id":"term-1","name":"task-42","agent":"codex","agent_status":"idle","interactive_ready":true,"launch_pending":false}`,
	)
	agent, err := srv.client(t).AgentStart(context.Background(), "w8:p1", "codex", "task-42")
	if err != nil || !agent.InteractiveReady || agent.LaunchPending {
		t.Fatalf("start = %+v, %v", agent, err)
	}
	reqs := startupControlRequests(t, srv)
	if len(reqs) != 3 {
		t.Fatalf("requests = %v; must wait past merely idle startup", reqs)
	}
	assertLifecycleRequest(t, reqs[0], "agent.start", map[string]any{"pane_id": "w8:p1", "kind": "codex", "name": "task-42", "timeout_ms": float64(30000)})
	for _, request := range reqs[1:] {
		assertLifecycleRequest(t, request, "agent.get", map[string]any{"target": "w8:p1"})
	}
}

func TestAgentStartWithOptionsPassesNativeArguments(t *testing.T) {
	base := t.TempDir()
	directories := []string{filepath.Join(base, "frontend files"), filepath.Join(base, "user's backend;$literal`name`")}
	for _, directory := range directories {
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, kind := range []string{"codex", "claude"} {
		for _, bypass := range []bool{false, true} {
			for _, withDirectories := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/bypass=%v/directories=%v", kind, bypass, withDirectories), func(t *testing.T) {
					opts := AgentStartOptions{Bypass: bypass}
					var wantArgs []string
					if bypass {
						flag := "--dangerously-bypass-approvals-and-sandbox"
						if kind == "claude" {
							flag = "--dangerously-skip-permissions"
						}
						wantArgs = append(wantArgs, flag)
					}
					if withDirectories {
						opts.Directories = directories
						wantArgs = append(wantArgs, "--add-dir", directories[0], "--add-dir", directories[1])
					}
					srv := newFakeServer(t, func(line string) (string, bool) {
						var request wireRequest
						if err := json.Unmarshal([]byte(line), &request); err != nil {
							t.Error(err)
						}
						if request.Method == "agent.read" {
							return fmt.Sprintf(`{"id":%q,"result":{"type":"pane_read","read":{"text":"› Ask Codex anything","truncated":false}}}`, request.ID), true
						}
						argv, err := json.Marshal(append([]string{kind}, wantArgs...))
						if err != nil {
							t.Error(err)
						}
						return fmt.Sprintf(`{"id":%q,"result":{"type":"agent_started","argv":%s,"agent":{"pane_id":"w8:p1","terminal_id":"term-1","name":"task-42","agent":%q,"agent_status":"idle","interactive_ready":true}}}`, idOf(line), argv, kind), true
					})
					agent, err := srv.client(t).AgentStartWithOptions(context.Background(), "w8:p1", kind, "task-42", opts)
					if err != nil || !agent.InteractiveReady {
						t.Fatalf("start = %+v, %v", agent, err)
					}
					requests := startupControlRequests(t, srv)
					if len(requests) != 1 {
						t.Fatalf("requests = %v; startup must not send prompt or approval keys", requests)
					}
					wantParams := map[string]any{"pane_id": "w8:p1", "kind": kind, "name": "task-42", "timeout_ms": float64(30000)}
					if len(wantArgs) > 0 {
						wireArgs := make([]any, len(wantArgs))
						for i, value := range wantArgs {
							wireArgs[i] = value
						}
						wantParams["args"] = wireArgs
					}
					assertLifecycleRequest(t, requests[0], "agent.start", wantParams)
				})
			}
		}
	}
}

func TestAgentStartWithOptionsRejectsInvalidPathsBeforeStarting(t *testing.T) {
	base := t.TempDir()
	file := filepath.Join(base, "not-a-directory")
	if err := os.WriteFile(file, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{"", "relative", "--dangerously-skip-permissions", filepath.Join(base, "missing"), file, filepath.Join(base, "line\nbreak"), filepath.Join(base, "invalid\xff")} {
		t.Run(directory, func(t *testing.T) {
			srv := newFakeServer(t, echoPong)
			_, err := srv.client(t).AgentStartWithOptions(context.Background(), "w8:p1", "codex", "task-42", AgentStartOptions{Directories: []string{base, directory}})
			if !IsCode(err, CodeInvalidParams) || len(srv.requests()) != 0 {
				t.Fatalf("invalid directory must fail before any request: err=%v, requests=%v", err, srv.requests())
			}
		})
	}
	for _, opts := range []AgentStartOptions{{Directories: []string{base}}, {Bypass: true}} {
		srv := newFakeServer(t, echoPong)
		_, err := srv.client(t).AgentStartWithOptions(context.Background(), "w8:p1", "unrecognized-agent", "task-42", opts)
		if !IsCode(err, CodeInvalidParams) || len(srv.requests()) != 0 {
			t.Fatalf("unknown agent flags must fail before any request: err=%v, requests=%v", err, srv.requests())
		}
	}
}

func TestAgentStartRequiredFieldsAreDefinitiveRefusal(t *testing.T) {
	for _, fields := range [][3]string{{"", "codex", "task-42"}, {"w8:p1", " ", "task-42"}, {"w8:p1", "codex", ""}} {
		srv := newFakeServer(t, echoPong)
		_, err := srv.client(t).AgentStart(context.Background(), fields[0], fields[1], fields[2])
		if !IsCode(err, CodeInvalidParams) || len(srv.requests()) != 0 {
			t.Fatalf("missing field must fail before any request: err=%v, requests=%v", err, srv.requests())
		}
	}
}

func TestAgentStartWithOptionsRequiresServerConfirmation(t *testing.T) {
	directory := t.TempDir()
	for _, tc := range []struct {
		name string
		argv []string
	}{
		{"missing argv", nil},
		{"ignored directory", []string{"codex", "--dangerously-bypass-approvals-and-sandbox"}},
		{"ignored bypass", []string{"codex", "--add-dir", directory}},
		{"changed directory", []string{"codex", "--dangerously-bypass-approvals-and-sandbox", "--add-dir", "/another/directory"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := newFakeServer(t, func(line string) (string, bool) {
				var request wireRequest
				if err := json.Unmarshal([]byte(line), &request); err != nil {
					t.Error(err)
				}
				if request.Method == "agent.read" {
					return fmt.Sprintf(`{"id":%q,"result":{"type":"pane_read","read":{"text":"","truncated":false}}}`, request.ID), true
				}
				argv, _ := json.Marshal(tc.argv)
				return fmt.Sprintf(`{"id":%q,"result":{"type":"agent_started","argv":%s,"agent":%s}}`, idOf(line), argv, pendingLifecycleAgent), true
			})
			agent, err := srv.client(t).AgentStartWithOptions(context.Background(), "w8:p1", "codex", "task-42", AgentStartOptions{Directories: []string{directory}, Bypass: true})
			if !IsCode(err, CodeAgentOptionsUnconfirmed) || agent.TerminalID != "term-1" {
				t.Fatalf("unconfirmed launch must preserve owned agent and error: agent=%+v, err=%v", agent, err)
			}
			if len(startupControlRequests(t, srv)) != 1 {
				t.Fatalf("unconfirmed launch must not be retried or receive input: %v", srv.requests())
			}
		})
	}
}

func TestAgentStartReturnsBlockedForApprovalWithoutSubmittingTask(t *testing.T) {
	srv := lifecycleAgentServer(t,
		`{"pane_id":"w8:p1","terminal_id":"term-1","name":"task-42","agent":"codex","agent_status":"blocked","interactive_ready":false,"launch_pending":true}`,
	)
	agent, err := srv.client(t).AgentStart(context.Background(), "w8:p1", "codex", "task-42")
	if err != nil || agent.AgentStatus != "blocked" {
		t.Fatalf("start = %+v, %v", agent, err)
	}
	if len(startupControlRequests(t, srv)) != 2 {
		t.Fatalf("blocked startup must stop polling and send no approval: %v", srv.requests())
	}
}

func TestAgentStartDetectsLostOwnershipOrExitedAgent(t *testing.T) {
	tests := []struct {
		name, agent, code string
	}{
		{"terminal replaced", `{"pane_id":"w8:p1","terminal_id":"term-other","name":"task-42","agent":"codex","agent_status":"idle","interactive_ready":true}`, "agent_name_not_found"},
		{"pane changed", `{"pane_id":"w9:p1","terminal_id":"term-1","name":"task-42","agent":"codex","agent_status":"idle","interactive_ready":true}`, "agent_name_not_found"},
		{"name lost", `{"pane_id":"w8:p1","terminal_id":"term-1","agent":"codex","agent_status":"idle","interactive_ready":true}`, "agent_name_not_found"},
		{"wrong agent", `{"pane_id":"w8:p1","terminal_id":"term-1","name":"task-42","agent":"claude","agent_status":"idle","interactive_ready":true}`, "agent_kind_mismatch"},
		{"exited", `{"pane_id":"w8:p1","terminal_id":"term-1","name":"task-42","agent":"codex","agent_status":"idle","interactive_ready":false,"launch_pending":false}`, "agent_start_failed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := lifecycleAgentServer(t, tt.agent)
			agent, err := srv.client(t).AgentStart(context.Background(), "w8:p1", "codex", "task-42")
			if !IsCode(err, tt.code) || agent.TerminalID == "" {
				t.Fatalf("start = %+v, %v; want recoverable state and %s", agent, err, tt.code)
			}
		})
	}
}

func TestAgentStartWaitHonorsCallerDeadline(t *testing.T) {
	srv := lifecycleAgentServer(t, pendingLifecycleAgent)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	agent, err := srv.client(t).AgentStart(ctx, "w8:p1", "codex", "task-42")
	if !errors.Is(err, context.DeadlineExceeded) || !IsCode(err, CodeTimeout) || agent.PaneID != "w8:p1" {
		t.Fatalf("start = %+v, %v; want recoverable state and deadline error", agent, err)
	}
}

func TestAgentStartWaitsForNewWorkspaceShell(t *testing.T) {
	var starts atomic.Int32
	srv := newFakeServer(t, func(line string) (string, bool) {
		var req wireRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			t.Error(err)
		}
		switch req.Method {
		case "agent.start":
			if starts.Add(1) == 1 {
				return fmt.Sprintf(`{"id":%q,"error":{"code":"agent_pane_busy","message":"shell is starting"}}`, req.ID), true
			}
			return fmt.Sprintf(`{"id":%q,"result":{"type":"agent_started","agent":{"pane_id":"w8:p1","terminal_id":"term-1","name":"task-42","agent":"codex","agent_status":"idle","interactive_ready":true}}}`, req.ID), true
		case "pane.get":
			return fmt.Sprintf(`{"id":%q,"result":{"type":"pane_info","pane":{"pane_id":"w8:p1","terminal_id":"term-1"}}}`, req.ID), true
		case "agent.read":
			return fmt.Sprintf(`{"id":%q,"result":{"type":"pane_read","read":{"text":"› Ask Codex anything","truncated":false}}}`, req.ID), true
		default:
			t.Errorf("unexpected method while waiting for shell: %s", req.Method)
			return "", false
		}
	})
	agent, err := srv.client(t).AgentStart(context.Background(), "w8:p1", "codex", "task-42")
	if err != nil || !agent.InteractiveReady || starts.Load() != 2 {
		t.Fatalf("start = %+v, %v; calls = %v", agent, err, srv.requests())
	}
}

func TestAgentStartDoesNotRetryOccupiedOrReplacedPane(t *testing.T) {
	for _, tc := range []struct{ name, first, later string }{
		{name: "existing agent", first: `"terminal_id":"term-1","agent":"claude"`},
		{name: "agent appeared", first: `"terminal_id":"term-1"`, later: `"terminal_id":"term-1","agent":"claude"`},
		{name: "terminal replaced", first: `"terminal_id":"term-1"`, later: `"terminal_id":"term-2"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var starts, reads atomic.Int32
			srv := newFakeServer(t, func(line string) (string, bool) {
				var req wireRequest
				if err := json.Unmarshal([]byte(line), &req); err != nil {
					t.Error(err)
				}
				if req.Method == "agent.start" {
					starts.Add(1)
					return fmt.Sprintf(`{"id":%q,"error":{"code":"agent_pane_busy","message":"not an available shell"}}`, req.ID), true
				}
				if req.Method != "pane.get" {
					t.Errorf("unexpected method: %s", req.Method)
				}
				fields := tc.first
				if reads.Add(1) > 1 {
					fields = tc.later
				}
				return fmt.Sprintf(`{"id":%q,"result":{"type":"pane_info","pane":{"pane_id":"w8:p1",%s}}}`, req.ID, fields), true
			})
			_, err := srv.client(t).AgentStart(context.Background(), "w8:p1", "codex", "task-42")
			if !IsCode(err, CodeAgentPaneBusy) || starts.Load() != 1 {
				t.Fatalf("start = %v; unsafe retry count = %d", err, starts.Load())
			}
		})
	}
}

func TestAgentStartDoesNotReplayLostResponseEvenAfterBusyRefusal(t *testing.T) {
	for _, busyFirst := range []bool{false, true} {
		t.Run(fmt.Sprint(busyFirst), func(t *testing.T) {
			var starts atomic.Int32
			srv := newFakeServer(t, func(line string) (string, bool) {
				var req wireRequest
				if err := json.Unmarshal([]byte(line), &req); err != nil {
					t.Error(err)
				}
				if req.Method == "pane.get" {
					return fmt.Sprintf(`{"id":%q,"result":{"type":"pane_info","pane":{"pane_id":"w8:p1","terminal_id":"term-1"}}}`, req.ID), true
				}
				if req.Method != "agent.start" {
					t.Errorf("unexpected method: %s", req.Method)
				}
				if starts.Add(1) == 1 && busyFirst {
					return fmt.Sprintf(`{"id":%q,"error":{"code":"agent_pane_busy","message":"shell is starting"}}`, req.ID), true
				}
				return "", false // The start may have been accepted; its response was lost.
			})
			client := srv.client(t)
			client.timeout = 40 * time.Millisecond
			_, err := client.AgentStart(context.Background(), "w8:p1", "codex", "task-42")
			want := int32(1)
			if busyFirst {
				want++
			}
			if err == nil || IsCode(err, CodeAgentPaneBusy) || starts.Load() != want {
				t.Fatalf("lost start response was replayed or called definitive: %v; starts=%d", err, starts.Load())
			}
		})
	}
}

func TestAgentStartShellWaitDeadlinePreservesExplicitRefusal(t *testing.T) {
	srv := newFakeServer(t, func(line string) (string, bool) {
		var req wireRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			t.Error(err)
		}
		if req.Method == "pane.get" {
			return fmt.Sprintf(`{"id":%q,"result":{"type":"pane_info","pane":{"pane_id":"w8:p1","terminal_id":"term-1"}}}`, req.ID), true
		}
		return fmt.Sprintf(`{"id":%q,"error":{"code":"agent_pane_busy","message":"shell is starting"}}`, req.ID), true
	})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := srv.client(t).AgentStart(ctx, "w8:p1", "codex", "task-42")
	if !IsCode(err, CodeAgentPaneBusy) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shell wait did not preserve known refusal and deadline: %v", err)
	}
}

func TestLifecycleBoundaryKeepsOrdinaryClientUnchanged(t *testing.T) {
	ordinary := reflect.TypeOf((*Client)(nil)).Elem()
	for _, method := range []string{"WorkspaceCreate", "WorkspaceList", "AgentStart", "AgentStartWithOptions", "PaneClose"} {
		if _, ok := ordinary.MethodByName(method); ok {
			t.Errorf("ordinary Client unexpectedly exposes %s", method)
		}
	}
	srv := newFakeServer(t, echoPong)
	c := srv.client(t)
	for _, method := range []string{"agent.focus", "pane.focus", "server.stop", "workspace.close", "tab.close", "tab.create", "pane.split", "agent.prompt", "agent.send_keys"} {
		if err := c.callLifecycle(context.Background(), method, nil, nil); err == nil {
			t.Errorf("lifecycle allowed unrelated method %s", method)
		}
	}
	if len(srv.requests()) != 0 {
		t.Fatal("forbidden call reached server")
	}
}

func assertLifecycleRequest(t *testing.T, line, method string, params map[string]any) {
	t.Helper()
	var request struct {
		ID     string         `json:"id"`
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal([]byte(line), &request); err != nil {
		t.Fatal(err)
	}
	if request.ID == "" || request.Method != method || !reflect.DeepEqual(request.Params, params) {
		t.Fatalf("request = %s; want method %s and params %#v", line, method, params)
	}
}
