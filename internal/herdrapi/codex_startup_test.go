package herdrapi

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

const codexDirectoryTrustScreen = `
  ,*=*.~**+"|*~:"~*=_
  Welcome to Codex, OpenAI's command-line coding agent

> You are in /home/yueban/herder-agent-code/pelican-bike

  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.
  Trusting the directory allows project-local config, hooks, and exec policies to load.

› 1. Yes, continue
  2. No, quit

  Press enter to continue
`

// Existing startup protocol tests still assert every control request, while
// explicitly allowing the new visible, uncapped read that cannot send keys.
func startupControlRequests(t *testing.T, srv *fakeServer) []string {
	t.Helper()
	var control []string
	for _, line := range srv.requests() {
		var request wireRequest
		if err := json.Unmarshal([]byte(line), &request); err != nil {
			t.Fatal(err)
		}
		if request.Method == "agent.read" {
			assertLifecycleRequest(t, line, "agent.read", map[string]any{"target": "w8:p1", "source": "visible"})
			continue
		}
		control = append(control, line)
	}
	return control
}

func TestCodexStartupTrustStateMatchesAcrossListAndGet(t *testing.T) {
	for _, tc := range []struct {
		name, screen, kind, status, wantStatus string
		truncated, readError, established      bool
		wantRead                               bool
	}{
		{name: "native trust despite foreground config directory", screen: codexDirectoryTrustScreen, wantStatus: "blocked", wantRead: true},
		{name: "no selected", screen: strings.ReplaceAll(strings.ReplaceAll(codexDirectoryTrustScreen, "› 1.", "1."), "  2. No", "› 2. No"), wantStatus: "blocked", wantRead: true},
		{name: "incomplete menu", screen: strings.ReplaceAll(codexDirectoryTrustScreen, "  2. No, quit\n", ""), wantStatus: "idle", wantRead: true},
		{name: "missing footer", screen: strings.ReplaceAll(codexDirectoryTrustScreen, "  Press enter to continue\n", ""), wantStatus: "idle", wantRead: true},
		{name: "composer after old trust prompt", screen: codexDirectoryTrustScreen + "\n› Ask Codex anything\n", wantStatus: "idle", wantRead: true},
		{name: "quoted example", screen: "Here is the trust screen:\n" + codexDirectoryTrustScreen, wantStatus: "idle", wantRead: true},
		{name: "normal composer", screen: "› Implement the requested feature\n? for shortcuts", wantStatus: "idle", wantRead: true},
		{name: "truncated native screen", screen: codexDirectoryTrustScreen, truncated: true, wantStatus: "idle", wantRead: true},
		{name: "viewport read unavailable", readError: true, wantStatus: "idle", wantRead: true},
		{name: "working agent", screen: codexDirectoryTrustScreen, status: "working", wantStatus: "working"},
		{name: "established session", screen: codexDirectoryTrustScreen, established: true, wantStatus: "idle"},
		{name: "other agent", screen: codexDirectoryTrustScreen, kind: "claude", wantStatus: "idle"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			kind, status := tc.kind, tc.status
			if kind == "" {
				kind = "codex"
			}
			if status == "" {
				status = "idle"
			}
			primary, foreground := "/home/yueban/herder-agent-code/pelican-bike", "/home/yueban/.codex"
			original := AgentInfo{PaneID: "w8:p1", WorkspaceID: "w8", TerminalID: "term-1", Agent: &kind, AgentStatus: status, Cwd: &primary, ForegroundCwd: &foreground, InteractiveReady: true, StateChangeSeq: 42}
			if tc.established {
				original.AgentSession = &SessionRef{Agent: kind, Kind: "id", Value: "native-session"}
			}
			wireAgent, err := json.Marshal(original)
			if err != nil {
				t.Fatal(err)
			}
			srv := newFakeServer(t, func(line string) (string, bool) {
				var request wireRequest
				if err := json.Unmarshal([]byte(line), &request); err != nil {
					t.Error(err)
				}
				var result string
				switch request.Method {
				case "agent.get":
					result = fmt.Sprintf(`{"agent":%s}`, wireAgent)
				case "agent.list":
					result = fmt.Sprintf(`{"agents":[%s]}`, wireAgent)
				case "agent.read":
					if tc.readError {
						return fmt.Sprintf(`{"id":%q,"error":{"code":"agent_not_found","message":"viewport unavailable"}}`, request.ID), true
					}
					result = fmt.Sprintf(`{"read":{"text":%q,"truncated":%t}}`, tc.screen, tc.truncated)
				default:
					t.Errorf("state discovery must not send prompts or approval keys: %s", request.Method)
					result = `{}`
				}
				return fmt.Sprintf(`{"id":%q,"result":%s}`, request.ID, result), true
			})
			client := srv.client(t)
			got, err := client.AgentGet(context.Background(), original.PaneID)
			if err != nil {
				t.Fatal(err)
			}
			listed, err := client.AgentList(context.Background())
			if err != nil || len(listed) != 1 {
				t.Fatalf("list = %+v, %v", listed, err)
			}
			want := original
			want.AgentStatus = tc.wantStatus
			if !reflect.DeepEqual(got, want) || !reflect.DeepEqual(listed[0], want) {
				t.Fatalf("get/list normalization disagree or changed identity: get=%+v list=%+v want=%+v", got, listed[0], want)
			}
			control := startupControlRequests(t, srv)
			if len(control) != 2 {
				t.Fatalf("unexpected control input: %v", control)
			}
			wantCount := 2
			if tc.wantRead {
				wantCount += 2
			}
			if len(srv.requests()) != wantCount {
				t.Fatalf("unexpected viewport reads: %v", srv.requests())
			}
		})
	}
}

func TestAgentStartRecognizesDirectoryTrustWithoutAnsweringIt(t *testing.T) {
	srv := newFakeServer(t, func(line string) (string, bool) {
		var request wireRequest
		if err := json.Unmarshal([]byte(line), &request); err != nil {
			t.Error(err)
		}
		var result string
		switch request.Method {
		case "agent.start":
			result = `{"type":"agent_started","agent":{"pane_id":"w8:p1","terminal_id":"term-1","name":"task-42","agent":"codex","agent_status":"idle","interactive_ready":true,"foreground_cwd":"/home/yueban/.codex","cwd":"/home/yueban/herder-agent-code/pelican-bike"}}`
		case "agent.read":
			result = fmt.Sprintf(`{"read":{"text":%q,"truncated":false}}`, codexDirectoryTrustScreen)
		default:
			t.Errorf("startup must return the trust decision to the user without polling or sending keys: %s", request.Method)
			result = `{}`
		}
		return fmt.Sprintf(`{"id":%q,"result":%s}`, request.ID, result), true
	})
	agent, err := srv.client(t).AgentStart(context.Background(), "w8:p1", "codex", "task-42")
	if err != nil || agent.AgentStatus != "blocked" || agent.ForegroundCwd == nil || *agent.ForegroundCwd != "/home/yueban/.codex" {
		t.Fatalf("startup must wait for trust despite foreground cwd: agent=%+v err=%v", agent, err)
	}
	if len(startupControlRequests(t, srv)) != 1 || len(srv.requests()) != 2 {
		t.Fatalf("trust detection unexpectedly submitted input: %v", srv.requests())
	}
}
