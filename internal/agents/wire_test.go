package agents

import (
	"testing"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

func strp(s string) *string { return &s }

func TestStatusFromWire(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want Status
	}{
		{"idle", "idle", StatusIdle},
		{"working", "working", StatusWorking},
		{"blocked", "blocked", StatusBlocked},
		{"done", "done", StatusDone},
		{"unknown", "unknown", StatusUnknown},
		// G11: herdr already degrades a failed blocked-match to `idle`. A
		// status string we do not recognise must not be guessed as idle on top
		// of that, or a waiting agent becomes invisible.
		{"future status is not guessed as idle", "awaiting_input", StatusUnknown},
		{"wrong case is not guessed as idle", "Blocked", StatusUnknown},
		{"empty", "", StatusUnknown},
		// gone is ours, synthesised when an agent leaves agent.list.
		{"gone is never accepted from the wire", "gone", StatusUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := statusFromWire(tt.in); got != tt.want {
				t.Fatalf("statusFromWire(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestStatusSettled(t *testing.T) {
	// idle and done are the same agent condition: waiting for instructions.
	// They differ only in whether the desktop UI has looked (G11).
	tests := []struct {
		s    Status
		want bool
	}{
		{StatusIdle, true},
		{StatusDone, true},
		{StatusWorking, false},
		{StatusBlocked, false},
		{StatusUnknown, false},
		{StatusGone, false},
	}
	for _, tt := range tests {
		if got := tt.s.Settled(); got != tt.want {
			t.Errorf("%q.Settled() = %v, want %v", tt.s, got, tt.want)
		}
	}
}

func TestFromWire(t *testing.T) {
	ref := herdrapi.SessionRef{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: "cf67e552"}

	tests := []struct {
		name string
		in   herdrapi.AgentInfo
		want Agent
	}{
		{
			name: "full record",
			in: herdrapi.AgentInfo{
				PaneID:                "w1:p1",
				WorkspaceID:           "w1",
				TabID:                 "t1",
				TerminalID:            "term-7",
				Agent:                 strp("claude"),
				AgentStatus:           "blocked",
				Cwd:                   strp("/tmp/proj"),
				ForegroundCwd:         strp("/tmp/other"),
				Name:                  strp("pane name"),
				TerminalTitle:         strp("✳ Create hello.txt"),
				TerminalTitleStripped: strp("Create hello.txt with touch"),
				Title:                 strp("title"),
				AgentSession:          &ref,
				StateChangeSeq:        42,
				InteractiveReady:      true,
				LaunchPending:         true,
				Focused:               true,
				Revision:              9,
			},
			want: Agent{
				PaneID:      "w1:p1",
				WorkspaceID: "w1",
				TabID:       "t1",
				Kind:        "claude",
				Status:      StatusBlocked,
				Cwd:         "/tmp/proj",
				Title:       "Create hello.txt with touch",
				SessionRef:  &ref,
				StateSeq:    42,
				Interactive: true,
				LaunchPend:  true,
			},
		},
		{
			name: "every nullable absent",
			in: herdrapi.AgentInfo{
				PaneID:      "w2:p3",
				AgentStatus: "idle",
			},
			want: Agent{PaneID: "w2:p3", Status: StatusIdle},
		},
		{
			name: "cwd falls back to foreground_cwd",
			in: herdrapi.AgentInfo{
				PaneID:        "w1:p1",
				AgentStatus:   "working",
				ForegroundCwd: strp("/tmp/fg"),
			},
			want: Agent{PaneID: "w1:p1", Status: StatusWorking, Cwd: "/tmp/fg"},
		},
		{
			name: "title falls back past the stripped title",
			in: herdrapi.AgentInfo{
				PaneID:      "w1:p1",
				AgentStatus: "done",
				Name:        strp("shell"),
			},
			want: Agent{PaneID: "w1:p1", Status: StatusDone, Title: "shell"},
		},
		{
			name: "agent not yet detected leaves kind empty",
			in: herdrapi.AgentInfo{
				PaneID:      "w1:p1",
				AgentStatus: "unknown",
			},
			want: Agent{PaneID: "w1:p1", Status: StatusUnknown},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := fromWire(tt.in)
			if !got.SeenAt.IsZero() {
				t.Errorf("SeenAt = %v, want zero: fromWire has no clock", got.SeenAt)
			}
			if got.PaneID != tt.want.PaneID || got.WorkspaceID != tt.want.WorkspaceID || got.TabID != tt.want.TabID {
				t.Errorf("ids = %q/%q/%q, want %q/%q/%q",
					got.PaneID, got.WorkspaceID, got.TabID, tt.want.PaneID, tt.want.WorkspaceID, tt.want.TabID)
			}
			if got.Kind != tt.want.Kind || got.Status != tt.want.Status {
				t.Errorf("kind/status = %q/%q, want %q/%q", got.Kind, got.Status, tt.want.Kind, tt.want.Status)
			}
			if got.Cwd != tt.want.Cwd || got.Title != tt.want.Title {
				t.Errorf("cwd/title = %q/%q, want %q/%q", got.Cwd, got.Title, tt.want.Cwd, tt.want.Title)
			}
			if got.StateSeq != tt.want.StateSeq || got.Interactive != tt.want.Interactive || got.LaunchPend != tt.want.LaunchPend {
				t.Errorf("seq/interactive/launchPending = %d/%v/%v, want %d/%v/%v",
					got.StateSeq, got.Interactive, got.LaunchPend,
					tt.want.StateSeq, tt.want.Interactive, tt.want.LaunchPend)
			}
			switch {
			case tt.want.SessionRef == nil && got.SessionRef != nil:
				t.Errorf("SessionRef = %+v, want nil", *got.SessionRef)
			case tt.want.SessionRef != nil && got.SessionRef == nil:
				t.Error("SessionRef = nil, want a value")
			case tt.want.SessionRef != nil:
				if *got.SessionRef != *tt.want.SessionRef {
					t.Errorf("SessionRef = %+v, want %+v", *got.SessionRef, *tt.want.SessionRef)
				}
				if got.SessionRef == tt.in.AgentSession {
					t.Error("SessionRef aliases the wire struct; it must be copied")
				}
			}
		})
	}
}

func TestCloneDoesNotShareSessionRef(t *testing.T) {
	a := Agent{PaneID: "w1:p1", SessionRef: &herdrapi.SessionRef{Value: "one"}}
	c := a.clone()
	c.SessionRef.Value = "two"
	if a.SessionRef.Value != "one" {
		t.Fatalf("clone shares its SessionRef: original became %q", a.SessionRef.Value)
	}
}
