package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseDotEnv(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want map[string]string
	}{
		{
			name: "the real file shape",
			in:   "# Feishu self-built app\n\nFEISHU_APP_ID=cli_abc\nFEISHU_APP_SECRET=Sh0rtS3cret\n",
			want: map[string]string{"FEISHU_APP_ID": "cli_abc", "FEISHU_APP_SECRET": "Sh0rtS3cret"},
		},
		{
			name: "surrounding whitespace and a trailing newline-less line",
			in:   "  FEISHU_APP_ID = cli_abc  ",
			want: map[string]string{"FEISHU_APP_ID": "cli_abc"},
		},
		{
			name: "crlf line endings do not end up inside the secret",
			in:   "FEISHU_APP_ID=cli_abc\r\nFEISHU_APP_SECRET=abc123\r\n",
			want: map[string]string{"FEISHU_APP_ID": "cli_abc", "FEISHU_APP_SECRET": "abc123"},
		},
		{
			name: "byte order mark before the first key",
			in:   "\ufeffFEISHU_APP_ID=cli_abc\n",
			want: map[string]string{"FEISHU_APP_ID": "cli_abc"},
		},
		{
			name: "# is only a comment at the start of a line",
			in:   "# comment\nK=a#b\n   # indented comment\n",
			want: map[string]string{"K": "a#b"},
		},
		{
			// The commonest real .env edit is commenting out the old credential.
			// Reading it back would make the bridge authenticate with a revoked
			// secret and fail at the WebSocket handshake, far from the cause.
			name: "a commented-out credential must not be picked up",
			in:   "#FEISHU_APP_SECRET=old-secret\n   #FEISHU_APP_ID=old-id\n",
			want: map[string]string{},
		},
		{
			name: "value may contain =",
			in:   "K=a=b=c\n",
			want: map[string]string{"K": "a=b=c"},
		},
		{
			name: "lines without = and empty keys are skipped",
			in:   "JUSTAWORD\n=novalue\n\nK=v\n",
			want: map[string]string{"K": "v"},
		},
		{
			name: "export is not supported and must not look like it worked",
			in:   "export FEISHU_APP_ID=cli_abc\n",
			want: map[string]string{},
		},
		{
			name: "quotes are part of the value, the format has none",
			in:   "K=\"v\"\n",
			want: map[string]string{"K": "\"v\""},
		},
		{
			name: "empty value",
			in:   "K=\n",
			want: map[string]string{"K": ""},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseDotEnv(tt.in)
			if len(got) != len(tt.want) {
				t.Fatalf("parseDotEnv(%q) = %v, want %v", tt.in, got, tt.want)
			}
			for k, want := range tt.want {
				if got[k] != want {
					t.Errorf("key %q = %q, want %q", k, got[k], want)
				}
			}
		})
	}
}

func TestCredentialSources(t *testing.T) {
	const (
		envID     = "cli_from_process_env"
		envSecret = "secret-from-process-env"
	)

	tests := []struct {
		name       string
		realEnv    map[string]string
		dirEnv     string
		repoEnv    string
		wantID     string
		wantSecret string
	}{
		{
			name:       "process environment only",
			realEnv:    map[string]string{EnvAppID: envID, EnvAppSecret: envSecret},
			wantID:     envID,
			wantSecret: envSecret,
		},
		{
			name:       "state directory .env",
			dirEnv:     "FEISHU_APP_ID=cli_from_dir\nFEISHU_APP_SECRET=secret-from-dir\n",
			wantID:     "cli_from_dir",
			wantSecret: "secret-from-dir",
		},
		{
			name:       "repository root .env",
			repoEnv:    "FEISHU_APP_ID=cli_from_repo\nFEISHU_APP_SECRET=secret-from-repo\n",
			wantID:     "cli_from_repo",
			wantSecret: "secret-from-repo",
		},
		{
			name:       "state directory wins over repository root",
			dirEnv:     "FEISHU_APP_ID=cli_from_dir\nFEISHU_APP_SECRET=secret-from-dir\n",
			repoEnv:    "FEISHU_APP_ID=cli_from_repo\nFEISHU_APP_SECRET=secret-from-repo\n",
			wantID:     "cli_from_dir",
			wantSecret: "secret-from-dir",
		},
		{
			name:       "the real environment wins over both .env files",
			realEnv:    map[string]string{EnvAppID: envID, EnvAppSecret: envSecret},
			dirEnv:     "FEISHU_APP_ID=cli_from_dir\nFEISHU_APP_SECRET=secret-from-dir\n",
			repoEnv:    "FEISHU_APP_ID=cli_from_repo\nFEISHU_APP_SECRET=secret-from-repo\n",
			wantID:     envID,
			wantSecret: envSecret,
		},
		{
			name:       "a .env may supply only one of the two",
			realEnv:    map[string]string{EnvAppID: envID},
			dirEnv:     "FEISHU_APP_SECRET=secret-from-dir\n",
			wantID:     envID,
			wantSecret: "secret-from-dir",
		},
		{
			name:       "nothing anywhere",
			wantID:     "",
			wantSecret: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir, repoRoot := isolate(t)
			for k, v := range tt.realEnv {
				os.Setenv(k, v)
			}
			if tt.dirEnv != "" {
				writeFile(t, filepath.Join(dir, DotEnvFileName), tt.dirEnv)
			}
			if tt.repoEnv != "" {
				writeFile(t, filepath.Join(repoRoot, DotEnvFileName), tt.repoEnv)
			}

			got, err := Load(dir)
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if got.Feishu.AppID != tt.wantID {
				t.Errorf("AppID = %q, want %q", got.Feishu.AppID, tt.wantID)
			}
			if got.Feishu.AppSecret != tt.wantSecret {
				t.Errorf("AppSecret = %q, want %q", got.Feishu.AppSecret, tt.wantSecret)
			}
		})
	}
}

// A variable that is present but empty still counts as set: an operator who
// exported an empty value gets the clear "not set" verdict from Validate
// rather than a .env quietly taking over.
func TestEmptyProcessEnvIsStillSet(t *testing.T) {
	dir, _ := isolate(t)
	os.Setenv(EnvAppSecret, "")
	writeFile(t, filepath.Join(dir, DotEnvFileName), "FEISHU_APP_SECRET=secret-from-dir\n")

	got, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.Feishu.AppSecret != "" {
		t.Errorf("AppSecret = %q, want empty", got.Feishu.AppSecret)
	}
}

func TestFindRepoRoot(t *testing.T) {
	base := t.TempDir()
	gitRepo := filepath.Join(base, "gitrepo")
	nested := filepath.Join(gitRepo, "a", "b")
	if err := os.MkdirAll(filepath.Join(gitRepo, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}

	got, ok := findRepoRoot(nested)
	if !ok || got != gitRepo {
		t.Errorf("findRepoRoot(%q) = %q, %v; want %q, true", nested, got, ok, gitRepo)
	}

	// The walk terminates at the filesystem root even when there is no marker.
	if _, ok := findRepoRoot(string(filepath.Separator)); ok {
		t.Log("filesystem root itself carries a marker; nothing to assert")
	}
}
