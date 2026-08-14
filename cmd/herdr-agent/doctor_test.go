package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

// Keywords identifying each check in doctor's output.
const (
	checkKeyServer   = "herdr server + protocol"
	checkKeyEnv      = "environment is clean"
	checkKeyClaude   = "claude integration"
	checkKeyCodex    = "codex integration"
	checkKeyWidth    = "wider than"
	checkKeyManifest = "manifests pinned"
)

// doctorStatuses maps each check to its verdict by parsing the report the
// operator actually reads, rather than an internal structure they never see.
func doctorStatuses(t *testing.T, out string) map[string]checkStatus {
	t.Helper()
	found := map[string]checkStatus{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.SplitN(line, "  ", 2)
		if len(fields) != 2 {
			continue
		}
		status := checkStatus(strings.TrimSpace(fields[0]))
		switch status {
		case checkPass, checkFail, checkWarn, checkUnknown:
		default:
			continue
		}
		name := strings.TrimSpace(fields[1])
		for _, key := range []string{checkKeyServer, checkKeyEnv, checkKeyClaude, checkKeyCodex, checkKeyWidth, checkKeyManifest} {
			if strings.Contains(name, key) {
				found[key] = status
			}
		}
	}
	if len(found) != 6 {
		t.Fatalf("parsed %d checks out of doctor output, want 6:\n%s", len(found), out)
	}
	return found
}

// healthyDoctor wires a machine where everything is as it should be.
func healthyDoctor(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t)
	writeFile(t, filepath.Join(h.d.Home, ".claude", "hooks", "herdr-agent-state.sh"), "#!/bin/sh\n")
	writeFile(t, filepath.Join(h.d.Home, ".codex", "hooks.json"), "{}\n")
	writeFile(t, filepath.Join(h.d.HerdrConfigDir, "config.toml"), "[update]\nmanifest_check = false\n")
	h.rc.OnPing = func(context.Context) (herdrapi.PingResult, error) {
		return herdrapi.PingResult{Protocol: herdrapi.MinProtocol, Version: "0.8.0"}, nil
	}
	h.rc.OnAgentList = func(context.Context) ([]herdrapi.AgentInfo, error) {
		return []herdrapi.AgentInfo{agentInfo("w1:p1", "claude", "idle", 20)}, nil
	}
	h.d.Extractor = &fakeExtractor{tail: map[string]screen.Screen{
		"w1:p1": {Lines: []string{"❯ hi"}, Cols: 173, Rows: 49},
	}}
	return h
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestDoctorGreenMachine(t *testing.T) {
	h := healthyDoctor(t)
	if err := dispatch(context.Background(), h.d, []string{"doctor"}); err != nil {
		t.Fatalf("doctor on a healthy machine: %v", err)
	}
	for key, status := range doctorStatuses(t, h.stdout()) {
		if status != checkPass {
			t.Errorf("check %q = %s, want PASS:\n%s", key, status, h.stdout())
		}
	}
	// S1 §3.6 asks for the number, not just a verdict.
	if !strings.Contains(h.stdout(), fmt.Sprintf("protocol %d", herdrapi.MinProtocol)) {
		t.Errorf("doctor did not print the protocol version it found:\n%s", h.stdout())
	}
}

func TestDoctorServerChecks(t *testing.T) {
	tests := []struct {
		name       string
		ping       func(context.Context) (herdrapi.PingResult, error)
		wantServer checkStatus
		wantWidth  checkStatus
		wantText   []string
	}{
		{
			name: "protocol too old",
			ping: func(context.Context) (herdrapi.PingResult, error) {
				return herdrapi.PingResult{Protocol: 18, Version: "0.7.0"}, nil
			},
			wantServer: checkFail,
			wantWidth:  checkPass, // the socket still answers, so panes can be measured
			wantText:   []string{"protocol 18", fmt.Sprintf("protocol %d or newer", herdrapi.MinProtocol)},
		},
		{
			name: "server down",
			ping: func(context.Context) (herdrapi.PingResult, error) {
				return herdrapi.PingResult{}, fmt.Errorf("%w at /tmp/herdr.sock: connect: no such file",
					herdrapi.ErrServerUnavailable)
			},
			wantServer: checkFail,
			// Nothing was measured, so nothing may be claimed.
			wantWidth: checkUnknown,
			wantText:  []string{"cannot reach herdr", "env -i", "inherited by every pane"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := healthyDoctor(t)
			h.rc.OnPing = tc.ping
			err := dispatch(context.Background(), h.d, []string{"doctor"})
			if !errors.Is(err, errChecksFailed) {
				t.Fatalf("err = %v, want errChecksFailed", err)
			}
			got := doctorStatuses(t, h.stdout())
			if got[checkKeyServer] != tc.wantServer {
				t.Errorf("server check = %s, want %s", got[checkKeyServer], tc.wantServer)
			}
			if got[checkKeyWidth] != tc.wantWidth {
				t.Errorf("pane width check = %s, want %s", got[checkKeyWidth], tc.wantWidth)
			}
			for _, want := range tc.wantText {
				if !strings.Contains(h.stdout(), want) {
					t.Errorf("output does not contain %q:\n%s", want, h.stdout())
				}
			}
		})
	}
}

func TestDoctorServerEnvironment(t *testing.T) {
	// G7: a herdr server started from inside a claude session passes
	// CLAUDE_CODE_CHILD_SESSION to every pane, claude switches transcript saving
	// off, and the whole L2 mirror silently mirrors nothing.
	tests := []struct {
		name     string
		probe    ServerEnvFunc
		want     checkStatus
		wantText string
	}{
		{
			name: "clean",
			probe: func(context.Context) ([]ProcEnv, error) {
				return []ProcEnv{{PID: 1, Vars: []string{"PATH=/bin", "TERM=xterm"}, Readable: true}}, nil
			},
			want:     checkPass,
			wantText: "none of them CLAUDE_CODE",
		},
		{
			name: "inherited claude marker",
			probe: func(context.Context) ([]ProcEnv, error) {
				return []ProcEnv{{PID: 19111, Vars: []string{"PATH=/bin", "CLAUDE_CODE_CHILD_SESSION=1"}, Readable: true}}, nil
			},
			want:     checkFail,
			wantText: "CLAUDE_CODE_CHILD_SESSION",
		},
		{
			name: "claudecode marker",
			probe: func(context.Context) ([]ProcEnv, error) {
				return []ProcEnv{{PID: 19111, Vars: []string{"CLAUDECODE=1"}, Readable: true}}, nil
			},
			want:     checkFail,
			wantText: "CLAUDECODE",
		},
		{
			// "I could not look" is not "it is fine": the marker would still be
			// inherited by every pane.
			name: "environment not readable",
			probe: func(context.Context) ([]ProcEnv, error) {
				return []ProcEnv{{PID: 19111, Readable: false}}, nil
			},
			want:     checkUnknown,
			wantText: "not readable",
		},
		{
			name:     "no server process",
			probe:    func(context.Context) ([]ProcEnv, error) { return nil, ErrNoServerProcess },
			want:     checkUnknown,
			wantText: "pgrep found no",
		},
		{
			name:     "probe failed",
			probe:    func(context.Context) ([]ProcEnv, error) { return nil, errors.New("ps: command not found") },
			want:     checkUnknown,
			wantText: "ps: command not found",
		},
		{
			name:     "no probe wired",
			probe:    nil,
			want:     checkUnknown,
			wantText: "no way to read process environments",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := healthyDoctor(t)
			h.d.ServerEnv = tc.probe
			err := dispatch(context.Background(), h.d, []string{"doctor"})
			if (tc.want == checkFail) != errors.Is(err, errChecksFailed) {
				t.Errorf("err = %v for a %s check", err, tc.want)
			}
			if got := doctorStatuses(t, h.stdout())[checkKeyEnv]; got != tc.want {
				t.Errorf("env check = %s, want %s:\n%s", got, tc.want, h.stdout())
			}
			if !strings.Contains(h.stdout(), tc.wantText) {
				t.Errorf("output does not contain %q:\n%s", tc.wantText, h.stdout())
			}
		})
	}
}

func TestDoctorIntegrationHooks(t *testing.T) {
	tests := []struct {
		name     string
		remove   string
		key      string
		wantText []string
	}{
		{
			name:   "claude hook missing",
			remove: filepath.Join(".claude", "hooks", "herdr-agent-state.sh"),
			key:    checkKeyClaude,
			// G8: no hook, no session id, no transcript, no mirror.
			wantText: []string{"herdr integration install claude", "herdr-agent-state.sh"},
		},
		{
			name:   "codex hook missing",
			remove: filepath.Join(".codex", "hooks.json"),
			key:    checkKeyCodex,
			// G8: installing is not enough — the hook must be trusted by hand.
			wantText: []string{"herdr integration install codex", "press t inside codex"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := healthyDoctor(t)
			if err := os.Remove(filepath.Join(h.d.Home, tc.remove)); err != nil {
				t.Fatal(err)
			}
			err := dispatch(context.Background(), h.d, []string{"doctor"})
			if !errors.Is(err, errChecksFailed) {
				t.Fatalf("err = %v, want errChecksFailed", err)
			}
			if got := doctorStatuses(t, h.stdout())[tc.key]; got != checkFail {
				t.Errorf("%s = %s, want FAIL", tc.key, got)
			}
			for _, want := range tc.wantText {
				if !strings.Contains(h.stdout(), want) {
					t.Errorf("output does not contain the fix %q:\n%s", want, h.stdout())
				}
			}
		})
	}
}

func TestDoctorNamesNarrowPanes(t *testing.T) {
	// G5: a pane no client ever attached is 53x23. G11: at that width Claude's
	// detection strings wrap, stop matching, and herdr reports idle instead of
	// blocked — with no error anywhere.
	h := healthyDoctor(t)
	h.rc.OnAgentList = func(context.Context) ([]herdrapi.AgentInfo, error) {
		return []herdrapi.AgentInfo{
			agentInfo("w1:p1", "claude", "idle", 1),
			agentInfo("w1:p4", "codex", "idle", 2),
		}, nil
	}
	h.d.Extractor = &fakeExtractor{tail: map[string]screen.Screen{
		"w1:p1": {Lines: []string{"❯ hi"}, Cols: 173, Rows: 49},
		"w1:p4": {Lines: []string{"❯ hi"}, Cols: 53, Rows: 23, Narrow: true},
	}}

	err := dispatch(context.Background(), h.d, []string{"doctor"})
	if !errors.Is(err, errChecksFailed) {
		t.Fatalf("err = %v, want errChecksFailed", err)
	}
	if got := doctorStatuses(t, h.stdout())[checkKeyWidth]; got != checkFail {
		t.Errorf("width check = %s, want FAIL", got)
	}
	out := h.stdout()
	if !strings.Contains(out, "w1:p4") || !strings.Contains(out, "53 cols") {
		t.Errorf("the narrow pane is not named with its width:\n%s", out)
	}
	if !strings.Contains(out, "silently") {
		t.Errorf("the explanation does not say the failure is silent:\n%s", out)
	}
	if strings.Contains(out, "w1:p1  <- never attached?") {
		t.Errorf("a wide pane was flagged:\n%s", out)
	}
}

func TestDoctorPaneWidthUnreadable(t *testing.T) {
	h := healthyDoctor(t)
	h.d.Extractor = &fakeExtractor{err: errors.New("read failed")}
	if err := dispatch(context.Background(), h.d, []string{"doctor"}); err != nil {
		t.Fatalf("an unreadable pane is not a failure: %v", err)
	}
	if got := doctorStatuses(t, h.stdout())[checkKeyWidth]; got != checkUnknown {
		t.Errorf("width check = %s, want UNKNOWN", got)
	}
}

// TestDoctorPaneWithAnEmptyScreenIsNotCalledNarrow covers the pane that read
// back as nothing at all.
//
// screen.Cols is the widest CONTENT line and screen sets Narrow for Cols == 0
// too (screen/clean.go), so a launching agent, a cleared pane or one whose
// agent just exited would otherwise be indicted as "never attached", FAIL the
// check and make doctor exit 1 on a machine that is fine — against S1 §4 item 1
// (doctor all green). Nothing was measured, so nothing may be claimed.
func TestDoctorPaneWithAnEmptyScreenIsNotCalledNarrow(t *testing.T) {
	h := healthyDoctor(t)
	h.d.Extractor = &fakeExtractor{tail: map[string]screen.Screen{
		"w1:p1": {Cols: 0, Narrow: true}, // exactly what screen.Clean("") returns
	}}

	if err := dispatch(context.Background(), h.d, []string{"doctor"}); err != nil {
		t.Fatalf("an empty pane read is not a failure: %v", err)
	}
	if got := doctorStatuses(t, h.stdout())[checkKeyWidth]; got != checkUnknown {
		t.Errorf("width check = %s, want UNKNOWN:\n%s", got, h.stdout())
	}
	if strings.Contains(h.stdout(), "never attached") {
		t.Errorf("an unmeasurable pane was accused of never having been attached:\n%s", h.stdout())
	}
}

// TestDoctorWithoutAHomeDirectory: with no home, the hook paths would be
// RELATIVE, and doctor would answer questions about the directory it happens to
// have been run from. A stray .claude there must never read as an installed
// integration (G8) — this repository has one, which is how easy the collision
// is.
func TestDoctorWithoutAHomeDirectory(t *testing.T) {
	h := healthyDoctor(t)
	h.d.Home = ""
	h.d.HerdrConfigDir = ""

	if err := dispatch(context.Background(), h.d, []string{"doctor"}); err != nil {
		t.Fatalf("a machine with no home directory is not a doctor failure: %v", err)
	}
	got := doctorStatuses(t, h.stdout())
	for _, key := range []string{checkKeyClaude, checkKeyCodex, checkKeyManifest} {
		if got[key] != checkUnknown {
			t.Errorf("check %q = %s with no home directory, want UNKNOWN:\n%s", key, got[key], h.stdout())
		}
	}
}

// manifestCases are the five states herdr's config.toml can be in, plus what
// doctor must say about each. appendOK records whether the copy-pasteable
// `>> config.toml` fix is legal for that state — it is legal exactly when the
// file has no [update] table, because TOML rejects a duplicate one.
var manifestCases = []struct {
	name     string
	content  *string
	want     checkStatus
	text     string
	appendOK bool
}{
	{name: "pinned", content: strptr("[update]\nmanifest_check = false\n"), want: checkPass, text: "manifest_check = false"},
	{name: "not pinned", content: strptr("[update]\nmanifest_check = true\n"), want: checkWarn, text: "manifest_check = true"},
	{name: "key absent", content: strptr("[ui]\ntheme = \"dark\"\n"), want: checkWarn, text: "has no [update] manifest_check", appendOK: true},
	{name: "update table without the key", content: strptr("[update]\ncheck_on_start = false\n"), want: checkWarn, text: "has an [update] table but no manifest_check"},
	{name: "file absent", content: nil, want: checkWarn, text: "no ", appendOK: true},
	{name: "unparseable", content: strptr("[update\n"), want: checkWarn, text: "cannot read"},
}

func TestDoctorManifestPinning(t *testing.T) {
	// G10: herdr hot-updates its detection manifests from herdr.dev at startup,
	// so classification can change with no local change at all.
	for _, tc := range manifestCases {
		t.Run(tc.name, func(t *testing.T) {
			h := healthyDoctor(t)
			path := filepath.Join(h.d.HerdrConfigDir, "config.toml")
			if tc.content == nil {
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			} else {
				writeFile(t, path, *tc.content)
			}
			// A warning is not a failure: nothing is broken, it is merely not
			// pinned, and doctor must stay usable as a pre-flight check.
			if err := dispatch(context.Background(), h.d, []string{"doctor"}); err != nil && tc.want == checkWarn {
				t.Fatalf("a WARN must not fail doctor: %v", err)
			}
			if got := doctorStatuses(t, h.stdout())[checkKeyManifest]; got != tc.want {
				t.Errorf("manifest check = %s, want %s:\n%s", got, tc.want, h.stdout())
			}
			if !strings.Contains(h.stdout(), tc.text) {
				t.Errorf("output does not contain %q:\n%s", tc.text, h.stdout())
			}
		})
	}
}

// TestDoctorManifestFixIsSafeToPaste executes doctor's own advice.
//
// The append form (`printf '[update]\n…' >> config.toml`) is only legal when
// the file has no [update] table: TOML forbids a duplicate table, so pasting it
// into a config that already sets manifest_check = true — precisely the case
// the warning exists for — would leave herdr with a file it cannot read,
// instead of pinned manifests (G10). This test therefore runs the fix doctor
// printed against the file doctor looked at, and asserts the result parses and
// is pinned.
func TestDoctorManifestFixIsSafeToPaste(t *testing.T) {
	const appended = "[update]\nmanifest_check = false\n"

	for _, tc := range manifestCases {
		if tc.want == checkPass {
			continue // nothing to fix
		}
		t.Run(tc.name, func(t *testing.T) {
			h := healthyDoctor(t)
			path := filepath.Join(h.d.HerdrConfigDir, "config.toml")
			if tc.content == nil {
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			} else {
				writeFile(t, path, *tc.content)
			}
			if err := dispatch(context.Background(), h.d, []string{"doctor"}); err != nil {
				t.Fatalf("doctor: %v", err)
			}

			offersAppend := strings.Contains(h.stdout(), ">> "+shellQuote(path))
			if offersAppend != tc.appendOK {
				t.Fatalf("doctor offers the append fix = %t, want %t:\n%s", offersAppend, tc.appendOK, h.stdout())
			}

			// What the operator's shell would end up with.
			existing := ""
			if tc.content != nil {
				existing = *tc.content
			}
			var cfg herdrFileConfig
			_, err := toml.Decode(existing+appended, &cfg)
			if offersAppend {
				if err != nil {
					t.Fatalf("pasting doctor's fix produced invalid TOML: %v", err)
				}
				if cfg.Update == nil || cfg.Update.ManifestCheck == nil || *cfg.Update.ManifestCheck {
					t.Fatalf("pasting doctor's fix did not pin the manifests: %+v", cfg.Update)
				}
				return
			}
			// The append was withheld. Show why: either it would break the file,
			// or the file is already broken and no blind edit can be offered.
			if err == nil && tc.name != "unparseable" {
				t.Fatalf("doctor withheld the one-line append for a file where it would have worked:\n%s", h.stdout())
			}
			if !strings.Contains(h.stdout(), "fix: edit") && !strings.Contains(h.stdout(), "fix: repair") {
				t.Errorf("doctor gave no usable advice for %s:\n%s", tc.name, h.stdout())
			}
		})
	}
}

func TestShellQuote(t *testing.T) {
	// doctor's fixes are meant to be pasted, and a home directory with a space
	// in it is entirely ordinary on macOS.
	tests := map[string]string{
		"/Users/x/.config/herdr":             "/Users/x/.config/herdr",
		"/Users/My Laptop/.config/herdr":     "'/Users/My Laptop/.config/herdr'",
		"/tmp/it's here":                     `'/tmp/it'\''s here'`,
		"/tmp/$(rm -rf ~)":                   "'/tmp/$(rm -rf ~)'",
		"":                                   "''",
		"/Users/x/Library/Application Suppo": "'/Users/x/Library/Application Suppo'",
	}
	for in, want := range tests {
		if got := shellQuote(in); got != want {
			t.Errorf("shellQuote(%q) = %s, want %s", in, got, want)
		}
	}
}
