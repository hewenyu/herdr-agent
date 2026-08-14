package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

func TestReportExitCodes(t *testing.T) {
	tests := []struct {
		name     string
		err      error
		want     int
		wantText string
	}{
		{"ok", nil, exitOK, ""},
		{"help", errUsageShown, exitOK, ""},
		{"usage", usagef("unknown command %q", "bogus"), exitUsage, `unknown command "bogus"`},
		{"usage already printed", &usageError{}, exitUsage, ""},
		// G3: acked but unverified is its own outcome, and it must not share an
		// exit code with success.
		{"unconfirmed", fmt.Errorf("say: %w", errUnconfirmed), exitUnconfirmed, "NOT confirmed"},
		// G17: a refused input is the protocol working, not a broken herdr, and
		// the acceptance script has to tell them apart.
		{"stale card", fmt.Errorf("guard: %w", agents.ErrNoLongerBlocked), exitRejected, "no longer waiting"},
		{"stale guard", fmt.Errorf("guard: %w", agents.ErrGuardStale), exitRejected, "too long ago"},
		{"pane gone", fmt.Errorf("guard: %w", agents.ErrPaneGone), exitRejected, "no longer exists"},
		{"bad key", fmt.Errorf("guard: %w", agents.ErrKeyNotAllowed), exitRejected, "allowlist"},
		{"agent replaced", fmt.Errorf("guard: %w", agents.ErrAgentReplaced), exitRejected, "different agent"},
		{"busy", fmt.Errorf("guard: %w", agents.ErrAgentBusy), exitRejected, "working"},
		{"doctor", fmt.Errorf("%w: 2 failed", errChecksFailed), exitFail, "doctor found problems"},
		{"other", errors.New("herdr exploded"), exitFail, "herdr exploded"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			if got := report(&buf, tc.err); got != tc.want {
				t.Errorf("exit code = %d, want %d", got, tc.want)
			}
			if tc.wantText == "" {
				if tc.name == "usage already printed" && buf.Len() != 0 {
					t.Errorf("flag already printed the message; report wrote it again: %q", buf.String())
				}
				return
			}
			if !strings.Contains(buf.String(), tc.wantText) {
				t.Errorf("output %q does not contain %q", buf.String(), tc.wantText)
			}
		})
	}
}

func TestDispatchUnknownCommandIsUsageError(t *testing.T) {
	h := newHarness(t)
	err := dispatch(context.Background(), h.d, []string{"stpo", "w1:p1"})
	var ue *usageError
	if !errors.As(err, &ue) {
		t.Fatalf("err = %v, want a usage error", err)
	}
	if report(&h.errb, err) != exitUsage {
		t.Error("an unknown command must exit 2, not run anything")
	}
}

func TestHelpListsEveryCommand(t *testing.T) {
	h := newHarness(t)
	if err := dispatch(context.Background(), h.d, []string{"help"}); err != nil {
		t.Fatalf("help: %v", err)
	}
	for _, c := range commandTable() {
		if !strings.Contains(h.stdout(), c.name) {
			t.Errorf("help does not mention %q", c.name)
		}
	}
}

func TestLsRendersEveryAgent(t *testing.T) {
	h := newHarness(t)
	h.rc.OnAgentList = func(context.Context) ([]herdrapi.AgentInfo, error) {
		return []herdrapi.AgentInfo{
			agentInfo("w1:p4", "codex", "blocked", 9),
			agentInfo("w1:p1", "claude", "idle", 20),
		}, nil
	}
	if err := dispatch(context.Background(), h.d, []string{"ls"}); err != nil {
		t.Fatalf("ls: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(h.stdout()), "\n")
	if len(lines) != 2 {
		t.Fatalf("stdout has %d lines, want one record per agent:\n%s", len(lines), h.stdout())
	}
	// Sorted by pane_id, the only identifier stable across a herdr restart (G10).
	if !strings.Contains(lines[0], "w1:p1") || !strings.Contains(lines[1], "w1:p4") {
		t.Errorf("agents are not sorted by pane id:\n%s", h.stdout())
	}
	if strings.Contains(h.stdout(), "term-not-stable") {
		t.Error("ls printed terminal_id, which is not stable across a herdr restart (G10)")
	}
	if !strings.Contains(lines[1], "blocked") || !strings.Contains(lines[1], statusEmoji(agents.StatusBlocked)) {
		t.Errorf("blocked agent is not marked: %q", lines[1])
	}
}

func TestLsMapsUnknownStatusToUnknownNotIdle(t *testing.T) {
	// G11: herdr already answers `idle` when its blocked-detection regexes miss,
	// so a status string we do not understand must never be shown as idle.
	h := newHarness(t)
	h.rc.OnAgentList = func(context.Context) ([]herdrapi.AgentInfo, error) {
		return []herdrapi.AgentInfo{agentInfo("w1:p1", "claude", "launching", 1)}, nil
	}
	if err := dispatch(context.Background(), h.d, []string{"ls"}); err != nil {
		t.Fatalf("ls: %v", err)
	}
	if !strings.Contains(h.stdout(), string(agents.StatusUnknown)) {
		t.Errorf("unrecognised status was not reported as unknown:\n%s", h.stdout())
	}
	if strings.Contains(h.stdout(), string(agents.StatusIdle)) {
		t.Errorf("unrecognised status was reported as idle:\n%s", h.stdout())
	}
}

func TestDialogPutsOnlyScreenTextOnStdout(t *testing.T) {
	// S1 §5.2 item 3 checks that every line of `dialog` fits the phone budget,
	// so the banner describing the crop must not be part of the payload.
	h := newHarness(t)
	h.d.Extractor = &fakeExtractor{dialog: map[string]screen.Screen{
		"w1:p1": {
			Lines:   []string{"Do you want to proceed?", "❯ 1. Yes", "  2. No"},
			Cropped: true,
			Rows:    49,
			Cols:    173,
		},
	}}
	if err := dispatch(context.Background(), h.d, []string{"dialog", "w1:p1"}); err != nil {
		t.Fatalf("dialog: %v", err)
	}
	if got, want := h.stdout(), "Do you want to proceed?\n❯ 1. Yes\n  2. No\n"; got != want {
		t.Errorf("stdout = %q, want exactly the screen lines %q", got, want)
	}
	for _, want := range []string{"detection buffer", "173 cols", "cropped"} {
		if !strings.Contains(h.stderr(), want) {
			t.Errorf("stderr %q does not mention %q", h.stderr(), want)
		}
	}
}

func TestScreenCommandsWarnAboutNeverAttachedPanes(t *testing.T) {
	// G5 + G11: 53 columns is a pane no client ever attached, where Claude's TUI
	// wraps and herdr's detection degrades to idle without saying so.
	narrow := screen.Screen{Lines: []string{"› Run /review"}, Cols: 53, Rows: 23, Narrow: true}
	tests := []struct {
		name string
		argv []string
		ex   *fakeExtractor
	}{
		{"dialog", []string{"dialog", "w1:p4"}, &fakeExtractor{dialog: map[string]screen.Screen{"w1:p4": narrow}}},
		{"tail", []string{"tail", "w1:p4"}, &fakeExtractor{tail: map[string]screen.Screen{"w1:p4": narrow}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.d.Extractor = tc.ex
			if err := dispatch(context.Background(), h.d, tc.argv); err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}
			if !strings.Contains(h.stderr(), "never-attached") {
				t.Errorf("no narrow-pane warning:\n%s", h.stderr())
			}
		})
	}
}

func TestTailFlagAndDefault(t *testing.T) {
	tests := []struct {
		name string
		argv []string
		want int
	}{
		{"default comes from config", []string{"tail", "w1:p1"}, 18},
		{"flag wins", []string{"tail", "-n", "5", "w1:p1"}, 5},
		{"zero means everything", []string{"tail", "-n", "0", "w1:p1"}, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			ex := &fakeExtractor{tail: map[string]screen.Screen{"w1:p1": {Lines: []string{"hi"}, Cols: 173}}}
			h.d.Extractor = ex
			if err := dispatch(context.Background(), h.d, tc.argv); err != nil {
				t.Fatalf("tail: %v", err)
			}
			if len(ex.tailN) != 1 || ex.tailN[0] != tc.want {
				t.Errorf("Tail called with n=%v, want %d", ex.tailN, tc.want)
			}
		})
	}
}

func TestPaneArgumentIsRequired(t *testing.T) {
	for _, argv := range [][]string{
		{"dialog"},
		{"tail"},
		{"transcript"},
		{"dialog", "w1:p1", "extra"},
		{"ls", "w1:p1"},
		{"watch", "w1:p1"},
		{"doctor", "please"},
	} {
		h := newHarness(t)
		err := dispatch(context.Background(), h.d, argv)
		var ue *usageError
		if !errors.As(err, &ue) {
			t.Errorf("%v: err = %v, want a usage error", argv, err)
		}
	}
}

func TestTranscriptPrintsPath(t *testing.T) {
	h := newHarness(t)
	h.rc.OnAgentGet = func(_ context.Context, target string) (herdrapi.AgentInfo, error) {
		in := agentInfo("w1:p1", "claude", "idle", 3)
		in.AgentSession = &herdrapi.SessionRef{
			Source: "herdr:claude", Agent: "claude", Kind: "id",
			Value: "cf67e552-abca-4b2a-8711-f37c328ed677",
		}
		return in, nil
	}
	h.d.Resolver = fakeResolver{path: "/Users/x/.claude/projects/-tmp-p/cf67.jsonl", ok: true}
	if err := dispatch(context.Background(), h.d, []string{"transcript", "w1:p1"}); err != nil {
		t.Fatalf("transcript: %v", err)
	}
	if got := strings.TrimSpace(h.stdout()); got != "/Users/x/.claude/projects/-tmp-p/cf67.jsonl" {
		t.Errorf("stdout = %q, want the bare path", got)
	}
}

func TestTranscriptExplainsTheTwoWaysItCanBeMissing(t *testing.T) {
	tests := []struct {
		name    string
		session *herdrapi.SessionRef
		want    string
	}{
		// G8: no agent_session at all is the normal intermediate state, and for
		// codex it stays that way until the hook is trusted by hand.
		{"no session ref yet", nil, "t inside codex"},
		{
			"session but no file",
			&herdrapi.SessionRef{Agent: "claude", Kind: "id", Value: "cf67e552"},
			"no matching file is on disk yet",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.rc.OnAgentGet = func(context.Context, string) (herdrapi.AgentInfo, error) {
				in := agentInfo("w1:p1", "claude", "idle", 3)
				in.AgentSession = tc.session
				return in, nil
			}
			h.d.Resolver = fakeResolver{ok: false}
			err := dispatch(context.Background(), h.d, []string{"transcript", "w1:p1"})
			if err == nil {
				t.Fatal("want an error when no transcript could be resolved")
			}
			if h.stdout() != "" {
				t.Errorf("stdout must stay empty when there is no path, got %q", h.stdout())
			}
			if !strings.Contains(h.stderr(), tc.want) {
				t.Errorf("stderr %q does not explain %q", h.stderr(), tc.want)
			}
		})
	}
}

// The help text promises "tail <pane> [-n 18]", but the stdlib flag package
// stops at the first positional, so without permute the CLI rejects its own
// documented usage.
func TestPermutePutsFlagsBeforePositionals(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want []string
	}{
		{"trailing value flag", []string{"w1:p1", "-n", "20"}, []string{"-n", "20", "--", "w1:p1"}},
		{"leading value flag", []string{"-n", "20", "w1:p1"}, []string{"-n", "20", "--", "w1:p1"}},
		{"inline value", []string{"w1:p1", "-n=20"}, []string{"-n=20", "--", "w1:p1"}},
		{"bool flag keeps its neighbour", []string{"w1:p1", "-v", "hello"}, []string{"-v", "--", "w1:p1", "hello"}},
		{"no flags", []string{"w1:p1", "hello"}, []string{"--", "w1:p1", "hello"}},
		// The terminator must not discard positionals seen before it, or the
		// command silently retargets at the first word after it.
		{"terminator keeps earlier positionals", []string{"w1:p1", "--", "-n", "x"}, []string{"--", "w1:p1", "-n", "x"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fs := flag.NewFlagSet("t", flag.ContinueOnError)
			fs.SetOutput(io.Discard)
			fs.Int("n", 0, "")
			fs.Bool("v", false, "")
			got := permute(fs, tt.args)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("permute(%q) = %q, want %q", tt.args, got, tt.want)
			}
		})
	}
}
