package setup

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
)

var fixedNow = time.Date(2026, 8, 14, 10, 30, 0, 0, time.UTC)

// An editor's UTF-8 BOM must not hide an existing app from setup while serve
// reads it normally. Otherwise setup may replace a different app silently.
func TestBOMCredentialsCannotBypassExistingAppProtection(t *testing.T) {
	path := envFixture(t, "\ufeff"+config.EnvAppID+"=cli_existing\r\n"+config.EnvAppSecret+"=existing-secret\r\n")
	before := readFile(t, path)
	got, err := readCredentials(path)
	if err != nil || got.AppID != "cli_existing" {
		t.Errorf("existing app was not detected: %q, %v", got.AppID, err)
	}
	err = writeCredentials(path, credentials{AppID: testAppID, AppSecret: testSecret}, fixedNow, false)
	if !errors.Is(err, ErrCredentialsExist) {
		t.Errorf("writeCredentials = %v, want ErrCredentialsExist", err)
	}
	if after := readFile(t, path); after != before {
		t.Error("existing credentials changed without explicit app replacement")
	}
}

func envFixture(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, config.DotEnvFileName)
	if content != "" {
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
	}
	return path
}

// TestEnvMergePreservesEverythingElse. This file is the operator's, not ours:
// truncating it to the two keys we know about would delete configuration whose
// absence surfaces somewhere else entirely.
func TestEnvMergePreservesEverythingElse(t *testing.T) {
	path := envFixture(t, strings.Join([]string{
		"# my notes",
		"",
		"HTTPS_PROXY=http://127.0.0.1:7890",
		config.EnvAppID + "=cli_old",
		"# trailing comment",
		"HERDR_SOCKET_PATH=/tmp/herdr.sock",
	}, "\n")+"\n")

	if err := writeCredentials(path, credentials{AppID: testAppID, AppSecret: testSecret}, fixedNow, true); err != nil {
		t.Fatalf("writeCredentials: %v", err)
	}

	got := readFile(t, path)
	for _, want := range []string{
		"# my notes",
		"HTTPS_PROXY=http://127.0.0.1:7890",
		"# trailing comment",
		"HERDR_SOCKET_PATH=/tmp/herdr.sock",
		config.EnvAppID + "=" + testAppID,
		config.EnvAppSecret + "=" + testSecret,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("merged .env is missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "cli_old") {
		t.Error("the previous app id survived the merge")
	}
	// Position matters too: the replacement happened in place rather than by
	// appending, so the operator's ordering is intact.
	if idx := strings.Index(got, config.EnvAppID); idx > strings.Index(got, "HERDR_SOCKET_PATH") {
		t.Error("the app id moved to the end of the file instead of being replaced in place")
	}
}

// TestEnvMergeIsIdempotent: setup is re-runnable, and a file that grows every
// run is a file that eventually confuses whoever reads it.
func TestEnvMergeIsIdempotent(t *testing.T) {
	path := envFixture(t, "")
	c := credentials{AppID: testAppID, AppSecret: testSecret}

	if err := writeCredentials(path, c, fixedNow, false); err != nil {
		t.Fatalf("first write: %v", err)
	}
	first := readFile(t, path)
	if err := writeCredentials(path, c, fixedNow, false); err != nil {
		t.Fatalf("second write: %v", err)
	}
	if second := readFile(t, path); second != first {
		t.Errorf("a second write changed the file:\n--- first ---\n%s\n--- second ---\n%s", first, second)
	}
}

// TestEnvMergeDropsShadowingDuplicates. In the parser internal/config uses the
// LAST assignment wins, so a duplicate left below our write would silently undo
// it — and the bridge would authenticate with an app the user cannot see.
func TestEnvMergeDropsShadowingDuplicates(t *testing.T) {
	path := envFixture(t, config.EnvAppID+"=cli_first\nOTHER=x\n"+config.EnvAppID+"=cli_second\n")

	if err := writeCredentials(path, credentials{AppID: testAppID, AppSecret: testSecret}, fixedNow, true); err != nil {
		t.Fatalf("writeCredentials: %v", err)
	}
	got := readFile(t, path)
	if n := strings.Count(got, config.EnvAppID+"="); n != 1 {
		t.Errorf("%s is assigned %d times, want 1:\n%s", config.EnvAppID, n, got)
	}
	if strings.Contains(got, "cli_second") {
		t.Error("the shadowing duplicate survived")
	}
}

// TestEnvRefusesToReplaceADifferentApp without reregister: no deletion API
// exists for apps created this way, so overwriting the id strands the old app.
func TestEnvRefusesToReplaceADifferentApp(t *testing.T) {
	path := envFixture(t, config.EnvAppID+"=cli_existing\n"+config.EnvAppSecret+"=existing-secret\n")

	err := writeCredentials(path, credentials{AppID: testAppID, AppSecret: testSecret}, fixedNow, false)
	if !errors.Is(err, ErrCredentialsExist) {
		t.Fatalf("err = %v, want ErrCredentialsExist", err)
	}
	if got := readFile(t, path); !strings.Contains(got, "cli_existing") {
		t.Error("the file was modified despite the refusal")
	}
}

// TestEnvRewriteKeepsTheSameApp: re-running setup for the same app is a repair,
// not a second registration, so it needs no permission.
func TestEnvRewriteKeepsTheSameApp(t *testing.T) {
	path := envFixture(t, config.EnvAppID+"="+testAppID+"\n")

	if err := writeCredentials(path, credentials{AppID: testAppID, AppSecret: testSecret}, fixedNow, false); err != nil {
		t.Fatalf("writeCredentials: %v", err)
	}
	if got := readFile(t, path); !strings.Contains(got, testSecret) {
		t.Error("the secret was not written")
	}
}

func TestEnvRefusesIncompleteCredentials(t *testing.T) {
	path := envFixture(t, "")
	if err := writeCredentials(path, credentials{AppID: testAppID}, fixedNow, false); err == nil {
		t.Fatal("half a credential was accepted; the bridge would fail authentication and blame Feishu")
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Error("a file was created for a refused write")
	}
}

// TestEnvIsWrittenAt0600 even when it already existed with looser permissions.
func TestEnvIsWrittenAt0600(t *testing.T) {
	path := envFixture(t, "OTHER=x\n") // fixture is 0644
	if err := writeCredentials(path, credentials{AppID: testAppID, AppSecret: testSecret}, fixedNow, false); err != nil {
		t.Fatalf("writeCredentials: %v", err)
	}
	if mode := statMode(t, path); mode != 0o600 {
		t.Errorf("mode = %o, want 600 — this file owns the secret", mode)
	}
}

// TestEnvRoundTripsThroughConfigLoad pins the duplicated parser: what setup
// writes is exactly what the bridge reads, including a secret full of the
// punctuation a cleverer parser would eat.
func TestEnvRoundTripsThroughConfigLoad(t *testing.T) {
	clearCredEnv(t)
	dir := t.TempDir()
	awkward := `p@ss#word="with spaces"'and'quotes=and=equals`

	if err := writeCredentials(envPath(dir), credentials{AppID: testAppID, AppSecret: awkward}, fixedNow, false); err != nil {
		t.Fatalf("writeCredentials: %v", err)
	}
	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if cfg.Feishu.AppID != testAppID {
		t.Errorf("app id round trip: %q", cfg.Feishu.AppID)
	}
	if cfg.Feishu.AppSecret != awkward {
		t.Errorf("secret round trip changed the value (shown redacted): got %d chars, want %d",
			len(cfg.Feishu.AppSecret), len(awkward))
	}
}

// TestReadCredentialsOnAMissingFile is the first run, not an error.
func TestReadCredentialsOnAMissingFile(t *testing.T) {
	got, err := readCredentials(envPath(t.TempDir()))
	if err != nil {
		t.Fatalf("readCredentials: %v", err)
	}
	if got.complete() {
		t.Error("credentials appeared out of an empty directory")
	}
}
