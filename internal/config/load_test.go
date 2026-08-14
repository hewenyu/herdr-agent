package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/screen"
)

// isolate puts the test in a fake repository checkout with a clean
// environment, so that neither the developer's shell nor the real repository
// .env can influence the result.
func isolate(t *testing.T) (dir string, repoRoot string) {
	t.Helper()

	base := t.TempDir()
	repoRoot = filepath.Join(base, "repo")
	work := filepath.Join(repoRoot, "sub", "work")
	dir = filepath.Join(base, "state")
	for _, d := range []string{work, dir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}
	// findRepoRoot stops at the first marker above the working directory.
	writeFile(t, filepath.Join(repoRoot, "go.mod"), "module fake\n")
	t.Chdir(work)
	unsetEnv(t, EnvAppID, EnvAppSecret)
	return dir, repoRoot
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func unsetEnv(t *testing.T, keys ...string) {
	t.Helper()
	for _, k := range keys {
		if old, ok := os.LookupEnv(k); ok {
			t.Cleanup(func() { os.Setenv(k, old) })
		} else {
			t.Cleanup(func() { os.Unsetenv(k) })
		}
		if err := os.Unsetenv(k); err != nil {
			t.Fatalf("unset %s: %v", k, err)
		}
	}
}

func TestDefault(t *testing.T) {
	got := Default()

	if got.Herdr.SocketPath != "" {
		t.Errorf("SocketPath = %q, want empty (auto-resolve)", got.Herdr.SocketPath)
	}
	if got.Herdr.PollInterval != time.Second {
		t.Errorf("PollInterval = %s, want 1s", got.Herdr.PollInterval)
	}
	if got.Herdr.CallTimeout != 10*time.Second {
		t.Errorf("CallTimeout = %s, want 10s", got.Herdr.CallTimeout)
	}
	if got.UI.MaxCols != screen.DefaultMaxCols {
		t.Errorf("MaxCols = %d, want screen.DefaultMaxCols (%d)", got.UI.MaxCols, screen.DefaultMaxCols)
	}
	if got.UI.TailLines != 18 {
		t.Errorf("TailLines = %d, want 18", got.UI.TailLines)
	}
	if got.UI.NotifyCooldown != 30*time.Second {
		t.Errorf("NotifyCooldown = %s, want 30s", got.UI.NotifyCooldown)
	}
	if got.UI.QueueLimit != 5 {
		t.Errorf("QueueLimit = %d, want 5", got.UI.QueueLimit)
	}
	if got.Mirror.DefaultOn {
		t.Error("Mirror.DefaultOn = true, want false: a chatty agent would flood the chat")
	}
	// G10: no allowlist means nobody, not everybody.
	if len(got.Feishu.AllowedOpenIDs) != 0 {
		t.Errorf("AllowedOpenIDs = %v, want empty (default deny)", got.Feishu.AllowedOpenIDs)
	}
	if err := got.Validate(); !errors.Is(err, ErrEmptyAllowlist) {
		t.Errorf("Default().Validate() = %v, want ErrEmptyAllowlist", err)
	}
}

func TestLoadMissingConfigFileIsNotAnError(t *testing.T) {
	dir, _ := isolate(t)
	os.Setenv(EnvAppID, "cli_missingfile")
	os.Setenv(EnvAppSecret, "s3cr3t-missingfile")

	got, err := Load(dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	want := Default()
	want.Feishu.AppID = "cli_missingfile"
	want.Feishu.AppSecret = "s3cr3t-missingfile"
	if got.Redacted() != want.Redacted() {
		t.Errorf("Load without config.toml =\n%s\nwant\n%s", got.Redacted(), want.Redacted())
	}
	if got.Feishu.AppSecret != want.Feishu.AppSecret {
		t.Errorf("AppSecret not loaded from the environment")
	}
}

func TestLoadOverlaysFileOntoDefaults(t *testing.T) {
	tests := []struct {
		name  string
		body  string
		check func(t *testing.T, c Config)
	}{
		{
			name: "everything set",
			body: `
[feishu]
allowed_open_ids = ["ou_00000000000000000000000000000001", "ou_second"]
notify_chat_id = "oc_chat"

[herdr]
socket_path = "/tmp/herdr.sock"
poll_interval = "250ms"
call_timeout = "30s"

[ui]
max_cols = 40
tail_lines = 9
notify_cooldown = "1m"
queue_limit = 2

[mirror]
default_on = true
`,
			check: func(t *testing.T, c Config) {
				want := []string{"ou_00000000000000000000000000000001", "ou_second"}
				if strings.Join(c.Feishu.AllowedOpenIDs, ",") != strings.Join(want, ",") {
					t.Errorf("AllowedOpenIDs = %v, want %v", c.Feishu.AllowedOpenIDs, want)
				}
				if c.Feishu.NotifyChatID != "oc_chat" {
					t.Errorf("NotifyChatID = %q", c.Feishu.NotifyChatID)
				}
				if c.Herdr.SocketPath != "/tmp/herdr.sock" {
					t.Errorf("SocketPath = %q", c.Herdr.SocketPath)
				}
				if c.Herdr.PollInterval != 250*time.Millisecond {
					t.Errorf("PollInterval = %s, want 250ms", c.Herdr.PollInterval)
				}
				if c.Herdr.CallTimeout != 30*time.Second {
					t.Errorf("CallTimeout = %s, want 30s", c.Herdr.CallTimeout)
				}
				if c.UI.MaxCols != 40 || c.UI.TailLines != 9 || c.UI.QueueLimit != 2 {
					t.Errorf("UI = %+v", c.UI)
				}
				if c.UI.NotifyCooldown != time.Minute {
					t.Errorf("NotifyCooldown = %s, want 1m", c.UI.NotifyCooldown)
				}
				if !c.Mirror.DefaultOn {
					t.Error("Mirror.DefaultOn = false, want true")
				}
			},
		},
		{
			name: "one field set, the rest defaulted",
			body: "[ui]\ntail_lines = 3\n",
			check: func(t *testing.T, c Config) {
				if c.UI.TailLines != 3 {
					t.Errorf("TailLines = %d, want 3", c.UI.TailLines)
				}
				if c.UI.MaxCols != DefaultMaxCols || c.UI.QueueLimit != DefaultQueueLimit {
					t.Errorf("unset UI fields lost their defaults: %+v", c.UI)
				}
				if c.Herdr.PollInterval != DefaultPollInterval || c.Herdr.CallTimeout != DefaultCallTimeout {
					t.Errorf("unset herdr fields lost their defaults: %+v", c.Herdr)
				}
			},
		},
		{
			name: "explicit zero means the documented default",
			body: "[herdr]\npoll_interval = \"0s\"\ncall_timeout = \"0\"\n\n[ui]\nmax_cols = 0\ntail_lines = 0\nqueue_limit = 0\nnotify_cooldown = \"0s\"\n",
			check: func(t *testing.T, c Config) {
				if c.Herdr.PollInterval != DefaultPollInterval {
					t.Errorf("PollInterval = %s, want the default %s", c.Herdr.PollInterval, DefaultPollInterval)
				}
				if c.Herdr.CallTimeout != DefaultCallTimeout {
					t.Errorf("CallTimeout = %s, want the default %s", c.Herdr.CallTimeout, DefaultCallTimeout)
				}
				if c.UI.MaxCols != DefaultMaxCols || c.UI.TailLines != DefaultTailLines ||
					c.UI.QueueLimit != DefaultQueueLimit || c.UI.NotifyCooldown != DefaultNotifyCooldown {
					t.Errorf("UI = %+v, want defaults", c.UI)
				}
			},
		},
		{
			name: "negative duration survives so Validate can reject it",
			body: "[herdr]\npoll_interval = \"-1s\"\n",
			check: func(t *testing.T, c Config) {
				if c.Herdr.PollInterval != -time.Second {
					t.Fatalf("PollInterval = %s, want -1s", c.Herdr.PollInterval)
				}
				c.Feishu.AppID, c.Feishu.AppSecret = "cli_x", "secret-value-x"
				c.Feishu.AllowedOpenIDs = []string{"ou_x"}
				if err := c.Validate(); !errors.Is(err, ErrNegative) {
					t.Errorf("Validate = %v, want ErrNegative", err)
				}
			},
		},
		{
			name: "an empty duration string means the default",
			body: "[herdr]\npoll_interval = \"\"\n",
			check: func(t *testing.T, c Config) {
				if c.Herdr.PollInterval != DefaultPollInterval {
					t.Errorf("PollInterval = %s, want the default %s", c.Herdr.PollInterval, DefaultPollInterval)
				}
			},
		},
		{
			name: "empty allowlist in the file stays empty",
			body: "[feishu]\nallowed_open_ids = []\n",
			check: func(t *testing.T, c Config) {
				if len(c.Feishu.AllowedOpenIDs) != 0 {
					t.Errorf("AllowedOpenIDs = %v, want empty", c.Feishu.AllowedOpenIDs)
				}
			},
		},
		{
			name: "mirror default_on = false is honoured",
			body: "[mirror]\ndefault_on = false\n",
			check: func(t *testing.T, c Config) {
				if c.Mirror.DefaultOn {
					t.Error("DefaultOn = true, want false")
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir, _ := isolate(t)
			writeFile(t, filepath.Join(dir, ConfigFileName), tt.body)

			got, err := Load(dir)
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			tt.check(t, got)
		})
	}
}

// TOML does not expand "~", so a socket_path written the way an operator would
// type it must either be expanded here or refused with an explanation. Silently
// keeping the literal produces a relative ./~/... path and a "no such file or
// directory" at the first herdr call, far away from the mistake.
func TestSocketPathTilde(t *testing.T) {
	tests := []struct {
		name     string
		home     string // "" => leave HOME unset
		body     string
		want     func(home string) string
		wantErrs bool
	}{
		{
			name: "a leading ~/ is expanded against home",
			home: "set",
			body: "[herdr]\nsocket_path = \"~/.config/herdr/herdr.sock\"\n",
			want: func(home string) string { return filepath.Join(home, ".config", "herdr", "herdr.sock") },
		},
		{
			name: "a bare ~ is the home directory",
			home: "set",
			body: "[herdr]\nsocket_path = \"~\"\n",
			want: func(home string) string { return home },
		},
		{
			name: "an absolute path is untouched",
			home: "set",
			body: "[herdr]\nsocket_path = \"/tmp/herdr.sock\"\n",
			want: func(string) string { return "/tmp/herdr.sock" },
		},
		{
			// Resolving another user's home is not portable, so refuse rather
			// than guess.
			name:     "~otheruser is not expanded and Validate rejects it",
			home:     "set",
			body:     "[herdr]\nsocket_path = \"~someone/herdr.sock\"\n",
			want:     func(string) string { return "~someone/herdr.sock" },
			wantErrs: true,
		},
		{
			name:     "an unresolvable home leaves the literal, which Validate rejects",
			body:     "[herdr]\nsocket_path = \"~/herdr.sock\"\n",
			want:     func(string) string { return "~/herdr.sock" },
			wantErrs: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir, _ := isolate(t)
			home := filepath.Join(t.TempDir(), "home")
			if tt.home == "" {
				home = ""
			}
			// os.UserHomeDir reads HOME on the platforms this bridge runs on;
			// an empty value makes it fail, which is the branch we need.
			t.Setenv("HOME", home)
			writeFile(t, filepath.Join(dir, ConfigFileName), tt.body)

			got, err := Load(dir)
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if want := tt.want(home); got.Herdr.SocketPath != want {
				t.Errorf("SocketPath = %q, want %q", got.Herdr.SocketPath, want)
			}

			got.Feishu.AppID, got.Feishu.AppSecret = "cli_x", "secret-value-x"
			got.Feishu.AllowedOpenIDs = []string{"ou_x"}
			err = got.Validate()
			if tt.wantErrs {
				if !errors.Is(err, ErrUnexpandedTilde) {
					t.Fatalf("Validate = %v, want ErrUnexpandedTilde", err)
				}
				for _, sub := range []string{"herdr.socket_path", ConfigFileName} {
					if !strings.Contains(err.Error(), sub) {
						t.Errorf("error %q does not mention %q", err, sub)
					}
				}
				return
			}
			if err != nil {
				t.Errorf("Validate = %v, want nil", err)
			}
		})
	}
}

// The tilde message echoes the path back, so it needs the same backstop every
// other operator-visible rendering has.
func TestValidateDoesNotEchoSecretInSocketPath(t *testing.T) {
	c := validConfig()
	c.Feishu.AppSecret = testSecret
	c.Herdr.SocketPath = "~someone/" + testSecret + ".sock"

	err := c.Validate()
	if !errors.Is(err, ErrUnexpandedTilde) {
		t.Fatalf("Validate = %v, want ErrUnexpandedTilde", err)
	}
	if strings.Contains(err.Error(), testSecret) {
		t.Errorf("Validate leaks the secret: %v", err)
	}
}

func TestLoadRejectsBadFiles(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		wantSubs []string
	}{
		{
			name:     "bare integer duration",
			body:     "[herdr]\npoll_interval = 1\n",
			wantSubs: []string{"poll_interval", `"1s"`},
		},
		{
			name:     "unparseable duration",
			body:     "[herdr]\ncall_timeout = \"banana\"\n",
			wantSubs: []string{"call_timeout", "banana"},
		},
		{
			name:     "typo in a security-relevant key",
			body:     "[feishu]\nallowed_open_id = [\"ou_x\"]\n",
			wantSubs: []string{"unknown key", "feishu.allowed_open_id"},
		},
		{
			name:     "credentials in config.toml",
			body:     "[feishu]\napp_id = \"cli_from_file\"\napp_secret = \"leaked-into-config\"\n",
			wantSubs: []string{"feishu.app_secret", EnvAppSecret},
		},
		{
			name:     "not toml at all",
			body:     "this is not toml\n",
			wantSubs: []string{ConfigFileName},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir, _ := isolate(t)
			writeFile(t, filepath.Join(dir, ConfigFileName), tt.body)

			_, err := Load(dir)
			if err == nil {
				t.Fatal("Load succeeded, want an error")
			}
			for _, sub := range tt.wantSubs {
				if !strings.Contains(err.Error(), sub) {
					t.Errorf("error %q does not mention %q", err, sub)
				}
			}
		})
	}
}

// An unreadable file is a real error: silently continuing would start the
// bridge with the wrong allowlist or no credentials.
func TestLoadReportsUnreadableFiles(t *testing.T) {
	for _, name := range []string{ConfigFileName, DotEnvFileName} {
		t.Run(name, func(t *testing.T) {
			dir, _ := isolate(t)
			// A directory where a file is expected fails the read on every OS
			// we care about.
			if err := os.Mkdir(filepath.Join(dir, name), 0o700); err != nil {
				t.Fatalf("mkdir: %v", err)
			}
			if _, err := Load(dir); err == nil {
				t.Errorf("Load succeeded with an unreadable %s", name)
			}
		})
	}
}

func TestDefaultDir(t *testing.T) {
	got, err := DefaultDir()
	if err != nil {
		t.Fatalf("DefaultDir: %v", err)
	}
	if filepath.Base(got) != StateDir {
		t.Errorf("DefaultDir = %q, want it to end in %q", got, StateDir)
	}
	if !filepath.IsAbs(got) {
		t.Errorf("DefaultDir = %q, want an absolute path", got)
	}
}

func TestLoadRequiresADirectory(t *testing.T) {
	isolate(t)
	writeFile(t, ConfigFileName, "[ui]\ntail_lines = 3\n") // a stray file in the cwd

	if _, err := Load(""); err == nil {
		t.Error("Load(\"\") succeeded; it must not fall back to the working directory")
	}
}

// A credential written into config.toml must never reach the Config, whatever
// else happens: config.toml is committed far more often than .env is.
func TestConfigFileCannotSupplyCredentials(t *testing.T) {
	dir, _ := isolate(t)
	writeFile(t, filepath.Join(dir, ConfigFileName), "[feishu]\napp_secret = \"leaked-into-config\"\n")

	cfg, err := Load(dir)
	if err == nil {
		t.Error("Load accepted a credential in config.toml, want an error")
	}
	if cfg.Feishu.AppSecret != "" {
		t.Errorf("AppSecret = %q, want empty: config.toml must not be able to set it", cfg.Feishu.AppSecret)
	}
}
