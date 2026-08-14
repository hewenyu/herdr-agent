package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunWiresRealImplementations(t *testing.T) {
	// A socket path that cannot exist: wire() does no IO, and the first call
	// fails as "server unavailable" rather than panicking on a nil dependency.
	socket := filepath.Join(t.TempDir(), "herdr.sock")
	stateDir := t.TempDir()

	tests := []struct {
		name     string
		argv     []string
		wantCode int
		wantOut  string
		wantErr  string
	}{
		{
			name: "no arguments prints usage", argv: nil,
			wantCode: exitUsage, wantErr: "usage: herdr-agent",
		},
		{
			name: "help goes to stdout and succeeds", argv: []string{"help"},
			wantCode: exitOK, wantOut: "usage: herdr-agent",
		},
		{
			name: "unknown command", argv: []string{"-state-dir", stateDir, "hlep"},
			wantCode: exitUsage, wantErr: `unknown command "hlep"`,
		},
		{
			// The whole point of wiring: a dead socket surfaces as a clean
			// failure, because herdr may legitimately not be running yet.
			name: "no server", argv: []string{"-socket", socket, "-state-dir", stateDir, "ls"},
			wantCode: exitFail, wantErr: "herdr server not running",
		},
		{
			name: "doctor still runs without a server", argv: []string{"-socket", socket, "-state-dir", stateDir, "doctor"},
			wantCode: exitFail, wantOut: "cannot reach herdr",
		},
		{
			name: "unparseable global flag", argv: []string{"-nope", "ls"},
			wantCode: exitUsage,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var out, errb bytes.Buffer
			code := run(context.Background(), tc.argv, &out, &errb)
			if code != tc.wantCode {
				t.Errorf("exit = %d, want %d\nstdout: %s\nstderr: %s", code, tc.wantCode, out.String(), errb.String())
			}
			if tc.wantOut != "" && !strings.Contains(out.String(), tc.wantOut) {
				t.Errorf("stdout %q does not contain %q", out.String(), tc.wantOut)
			}
			if tc.wantErr != "" && !strings.Contains(errb.String(), tc.wantErr) {
				t.Errorf("stderr %q does not contain %q", errb.String(), tc.wantErr)
			}
		})
	}
}

func TestLoadConfigTakesTheBridgeKnobsAndNotTheFeishuOnes(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "config.toml"), `
[herdr]
poll_interval = "250ms"
call_timeout = "3s"

[ui]
max_cols = 40
tail_lines = 7
`)
	cfg, err := loadConfig(dir)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.Herdr.PollInterval != 250*time.Millisecond {
		t.Errorf("poll_interval = %s, want 250ms", cfg.Herdr.PollInterval)
	}
	if cfg.Herdr.CallTimeout != 3*time.Second {
		t.Errorf("call_timeout = %s, want 3s", cfg.Herdr.CallTimeout)
	}
	if cfg.UI.MaxCols != 40 || cfg.UI.TailLines != 7 {
		t.Errorf("ui = %+v, want max_cols 40 and tail_lines 7", cfg.UI)
	}
	// Validate is deliberately not called: it demands Feishu credentials and a
	// non-empty open_id allowlist, and doctor — the tool you reach for when the
	// bridge will not start — must not refuse to run for the same reason.
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected Validate to reject this config; if it stopped doing so, the comment in loadConfig is stale")
	}
}

func TestLoadConfigReportsABrokenFile(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "config.toml"), "[herdr\n")
	if _, err := loadConfig(dir); err == nil {
		t.Fatal("a malformed config.toml must be reported, not silently defaulted")
	}
}

func TestHerdrConfigDirFollowsHerdrsOwnRules(t *testing.T) {
	// doctor must inspect the config.toml the server actually read.
	xdg := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", xdg)
	if got, want := herdrConfigDir(), filepath.Join(xdg, "herdr"); got != want {
		t.Errorf("herdrConfigDir() = %q, want %q", got, want)
	}

	t.Setenv("XDG_CONFIG_HOME", "")
	home, err := homeDirForTest()
	if err != nil {
		t.Skip("no home directory on this machine")
	}
	if got, want := herdrConfigDir(), filepath.Join(home, ".config", "herdr"); got != want {
		t.Errorf("herdrConfigDir() = %q, want %q", got, want)
	}
}

func homeDirForTest() (string, error) { return os.UserHomeDir() }
