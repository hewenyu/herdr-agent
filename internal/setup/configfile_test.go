package setup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/config"
)

// TestEmbeddedExampleMatchesDeploy. The embedded copy exists because go:embed
// cannot reach outside this directory and a downloaded binary has no repository
// beside it. This test is what keeps that copy from becoming a second, stale
// source of truth.
func TestEmbeddedExampleMatchesDeploy(t *testing.T) {
	onDisk, err := os.ReadFile(filepath.Join("..", "..", "deploy", "config.example.toml"))
	if err != nil {
		t.Fatalf("read deploy/config.example.toml: %v", err)
	}
	if string(onDisk) != string(exampleConfig) {
		t.Error("internal/setup/config.example.toml has drifted from deploy/config.example.toml; " +
			"copy the deploy file over it")
	}
}

// TestConfigIsCreatedFromTheExampleWithItsCommentsIntact.
//
// The example is ~100 lines of comments that ARE the documentation for this
// product's security model. BurntSushi/toml has no comment-preserving encoder,
// so a decode/encode round trip would silently delete every one of them and
// leave the operator with keys and no explanation of what allowed_open_ids
// costs them if they get it wrong.
func TestConfigIsCreatedFromTheExampleWithItsCommentsIntact(t *testing.T) {
	dir := t.TempDir()
	path := configPath(dir)

	if _, err := updateConfig(path, testOpenID, testChatID); err != nil {
		t.Fatalf("updateConfig: %v", err)
	}

	got := readFile(t, path)
	for _, comment := range []string{
		"# The authorization boundary of the entire product",
		"# Default deny, and an EMPTY list is a hard startup error BY DESIGN.",
		"[herdr]",
		"[mirror]",
	} {
		if !strings.Contains(got, comment) {
			t.Errorf("the written config.toml lost %q", comment)
		}
	}
	// Comment density is the real assertion: a struct round trip would keep the
	// keys and drop everything around them.
	if n := strings.Count(got, "\n#"); n < 50 {
		t.Errorf("only %d comment lines survived; the file is meant to be self-documenting", n)
	}

	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatalf("config.Load rejected what setup wrote: %v", err)
	}
	if len(cfg.Feishu.AllowedOpenIDs) != 1 || cfg.Feishu.AllowedOpenIDs[0] != testOpenID {
		t.Errorf("allowed_open_ids = %v", cfg.Feishu.AllowedOpenIDs)
	}
	if cfg.Feishu.NotifyChatID != testChatID {
		t.Errorf("notify_chat_id = %q", cfg.Feishu.NotifyChatID)
	}
	if mode := statMode(t, path); mode != 0o600 {
		t.Errorf("mode = %o, want 600", mode)
	}
}

// TestConfigNeverReceivesCredentials. config.rejectUnknownKeys turns
// feishu.app_secret into a startup error, so writing one here would convert a
// helpful write into a bridge that refuses to boot.
func TestConfigNeverReceivesCredentials(t *testing.T) {
	dir := t.TempDir()
	if _, err := updateConfig(configPath(dir), testOpenID, testChatID); err != nil {
		t.Fatalf("updateConfig: %v", err)
	}
	got := readFile(t, configPath(dir))
	for _, forbidden := range []string{"app_secret =", "app_id =", testSecret} {
		if strings.Contains(got, forbidden) {
			t.Errorf("config.toml contains %q", forbidden)
		}
	}
}

func TestConfigUpdateIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	path := configPath(dir)

	if _, err := updateConfig(path, testOpenID, testChatID); err != nil {
		t.Fatalf("first: %v", err)
	}
	first := readFile(t, path)
	if _, err := updateConfig(path, testOpenID, testChatID); err != nil {
		t.Fatalf("second: %v", err)
	}
	if second := readFile(t, path); second != first {
		t.Error("a second run changed config.toml; re-running setup must be a no-op here")
	}
}

// TestExistingAllowlistEntriesSurvive. This list is the authorization boundary
// (G10); dropping an entry locks somebody out of their own bridge.
func TestExistingAllowlistEntriesSurvive(t *testing.T) {
	dir := t.TempDir()
	path := configPath(dir)
	write(t, path, "[feishu]\nallowed_open_ids = [\"ou_someone_else\"]  # a colleague\nnotify_chat_id = \"\"\n")

	if _, err := updateConfig(path, testOpenID, ""); err != nil {
		t.Fatalf("updateConfig: %v", err)
	}
	got := readFile(t, path)
	if !strings.Contains(got, "ou_someone_else") || !strings.Contains(got, testOpenID) {
		t.Errorf("the allowlist lost an entry:\n%s", got)
	}
	if !strings.Contains(got, "# a colleague") {
		t.Errorf("the inline comment was dropped:\n%s", got)
	}
}

// TestABracketInACommentIsNotTheEndOfTheArray.
//
// Both shapes are ones an operator plausibly types, and the first is what the
// shipped example teaches: `#   allowed_open_ids = ["ou_REPLACE_..."]` sits two
// lines above the live key, so "uncomment it onto the end of the line" produces
// exactly this. Ending the array at the LAST ']' would delete the comment and
// promote the placeholder id into the live allowlist — the authorization
// boundary of the whole product (G10).
func TestABracketInACommentIsNotTheEndOfTheArray(t *testing.T) {
	cases := []struct {
		name, line  string
		wantSurvive []string
		wantAbsent  []string
	}{
		{
			name:        "an example id inside a comment stays inside it",
			line:        `allowed_open_ids = []  # e.g. ["ou_REPLACE_WITH_YOUR_OWN_OPEN_ID"]`,
			wantSurvive: []string{`# e.g. ["ou_REPLACE_WITH_YOUR_OWN_OPEN_ID"]`, testOpenID},
			wantAbsent:  []string{`"ou_REPLACE_WITH_YOUR_OWN_OPEN_ID", "` + testOpenID},
		},
		{
			name:        "a bracket in prose does not eat the comment",
			line:        `allowed_open_ids = ["ou_mate"] # see runbook step [3]`,
			wantSurvive: []string{"# see runbook step [3]", "ou_mate", testOpenID},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := configPath(dir)
			write(t, path, "[feishu]\n"+tc.line+"\n")

			untouched, err := updateConfig(path, testOpenID, "")
			if err != nil {
				t.Fatalf("updateConfig: %v", err)
			}
			if len(untouched) != 0 {
				t.Fatalf("untouched = %v; the line is editable", untouched)
			}
			got := readFile(t, path)
			for _, want := range tc.wantSurvive {
				if !strings.Contains(got, want) {
					t.Errorf("the rewrite lost %q:\n%s", want, got)
				}
			}
			for _, absent := range tc.wantAbsent {
				if strings.Contains(got, absent) {
					t.Errorf("an id from a comment was promoted into the allowlist:\n%s", got)
				}
			}
			cfg, err := config.Load(dir)
			if err != nil {
				t.Fatalf("config.Load rejected the rewrite: %v", err)
			}
			for _, id := range cfg.Feishu.AllowedOpenIDs {
				if strings.Contains(id, "REPLACE") {
					t.Errorf("allowed_open_ids = %v; a placeholder from a comment is now live",
						cfg.Feishu.AllowedOpenIDs)
				}
			}
		})
	}
}

// TestAnUnterminatedQuoteBeforeTheBracketIsRefused rather than guessed at: a
// line this package cannot read is one it must not rewrite.
func TestAnUnterminatedQuoteBeforeTheBracketIsRefused(t *testing.T) {
	dir := t.TempDir()
	path := configPath(dir)
	original := "[feishu]\nallowed_open_ids = [\"ou_oops]\n"
	write(t, path, original)

	untouched, err := updateConfig(path, testOpenID, "")
	if err != nil {
		t.Fatalf("updateConfig: %v", err)
	}
	if len(untouched) != 1 || untouched[0] != keyAllowedOpenIDs {
		t.Fatalf("untouched = %v, want [%s] so the caller prints a manual step", untouched, keyAllowedOpenIDs)
	}
	if got := readFile(t, path); !strings.Contains(got, original) {
		t.Errorf("the line was rewritten anyway:\n%s", got)
	}
}

// TestMultilineArraysAreRefusedRatherThanRewritten.
func TestMultilineArraysAreRefusedRatherThanRewritten(t *testing.T) {
	dir := t.TempDir()
	path := configPath(dir)
	original := "[feishu]\nallowed_open_ids = [\n  \"ou_someone_else\",\n]\n"
	write(t, path, original)

	untouched, err := updateConfig(path, testOpenID, "")
	if err != nil {
		t.Fatalf("updateConfig: %v", err)
	}
	if len(untouched) != 1 || untouched[0] != keyAllowedOpenIDs {
		t.Fatalf("untouched = %v, want [%s] so the caller can print a manual step", untouched, keyAllowedOpenIDs)
	}
	if got := readFile(t, path); !strings.Contains(got, original) {
		t.Errorf("the multi-line array was rewritten anyway:\n%s", got)
	}
}

// TestMissingKeysAreInsertedIntoTheFeishuTable, not appended at the end of the
// file where [mirror] would claim them and config.Load would reject them.
func TestMissingKeysAreInsertedIntoTheFeishuTable(t *testing.T) {
	dir := t.TempDir()
	path := configPath(dir)
	write(t, path, "[feishu]\n\n[mirror]\ndefault_on = true\n")

	if _, err := updateConfig(path, testOpenID, testChatID); err != nil {
		t.Fatalf("updateConfig: %v", err)
	}
	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if len(cfg.Feishu.AllowedOpenIDs) != 1 || cfg.Feishu.NotifyChatID != testChatID {
		t.Errorf("keys landed in the wrong table: %+v", cfg.Feishu)
	}
	if !cfg.Mirror.DefaultOn {
		t.Error("an unrelated table was disturbed")
	}
}

// TestAFileWithoutAFeishuTableGetsOne.
func TestAFileWithoutAFeishuTableGetsOne(t *testing.T) {
	dir := t.TempDir()
	path := configPath(dir)
	write(t, path, "[herdr]\npoll_interval = \"2s\"\n")

	if _, err := updateConfig(path, testOpenID, testChatID); err != nil {
		t.Fatalf("updateConfig: %v", err)
	}
	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if len(cfg.Feishu.AllowedOpenIDs) != 1 || cfg.Feishu.NotifyChatID != testChatID {
		t.Errorf("feishu keys were not added: %+v", cfg.Feishu)
	}
	if cfg.Herdr.PollInterval.String() != "2s" {
		t.Errorf("the existing table was damaged: poll_interval = %s", cfg.Herdr.PollInterval)
	}
}

// TestCommentedOutExampleIsNotMistakenForTheLiveKey. The shipped example shows
// `#   allowed_open_ids = [...]` two lines above the real assignment.
func TestCommentedOutExampleIsNotMistakenForTheLiveKey(t *testing.T) {
	lines := splitLines(string(exampleConfig))
	i := findKeyLine(lines, feishuSection, keyAllowedOpenIDs)
	if i < 0 {
		t.Fatal("the live allowed_open_ids line was not found at all")
	}
	if strings.HasPrefix(strings.TrimSpace(lines[i]), "#") {
		t.Errorf("line %d is a comment: %q", i, lines[i])
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
