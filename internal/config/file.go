package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// fileConfig mirrors the TOML surface of Config.
//
// It exists for two reasons. First, durations are written as strings ("1s")
// while Config uses time.Duration, which is an int64 and cannot decode a
// string on its own. Second, Feishu.AppID/AppSecret and AI.APIKey have no field here,
// which makes it structurally impossible for config.toml to supply a
// credential — a `toml:"-"` tag would be a convention, this is a guarantee.
type fileConfig struct {
	AI struct {
		Enabled  bool         `toml:"enabled"`
		Provider string       `toml:"provider"`
		Model    string       `toml:"model"`
		BaseURL  string       `toml:"base_url"`
		Timeout  tomlDuration `toml:"timeout"`
	} `toml:"ai"`
	Feishu struct {
		AllowedOpenIDs []string `toml:"allowed_open_ids"`
		NotifyChatID   string   `toml:"notify_chat_id"`
	} `toml:"feishu"`
	Herdr struct {
		SocketPath   string       `toml:"socket_path"`
		PollInterval tomlDuration `toml:"poll_interval"`
		CallTimeout  tomlDuration `toml:"call_timeout"`
	} `toml:"herdr"`
	UI struct {
		MaxCols        int          `toml:"max_cols"`
		TailLines      int          `toml:"tail_lines"`
		NotifyCooldown tomlDuration `toml:"notify_cooldown"`
		QueueLimit     int          `toml:"queue_limit"`
	} `toml:"ui"`
	Mirror struct {
		DefaultOn bool `toml:"default_on"`
	} `toml:"mirror"`
	Tasks struct {
		Enabled        bool               `toml:"enabled"`
		Bypass         bool               `toml:"bypass"`
		DefaultProject string             `toml:"default_project"`
		PollInterval   tomlDuration       `toml:"poll_interval"`
		Projects       map[string]Project `toml:"projects"`
	} `toml:"tasks"`
}

// tomlDuration decodes `poll_interval = "1s"`. TOML has no duration type and
// time.Duration does not implement encoding.TextUnmarshaler.
type tomlDuration time.Duration

func (d *tomlDuration) UnmarshalText(text []byte) error {
	s := strings.TrimSpace(string(text))
	if s == "" {
		*d = 0
		return nil
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		// A bare number reaches us as its decimal string, so this is also the
		// error a reader of `poll_interval = 1` gets. Say what to write instead.
		return fmt.Errorf("invalid duration %q, write it as a string such as \"1s\" or \"250ms\": %w", s, err)
	}
	*d = tomlDuration(v)
	return nil
}

// applyFile overlays path onto cfg. A missing file leaves cfg untouched:
// defaults plus the environment is a valid configuration.
func applyFile(cfg *Config, path string) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}

	var fc fileConfig
	md, err := toml.Decode(string(data), &fc)
	if err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	if err := rejectUnknownKeys(path, md); err != nil {
		return err
	}

	// Zero means "unset" for every field documented as "0 => <default>", so a
	// zero here must not overwrite the default. Negative values survive on
	// purpose: Validate rejects them with a precise message.
	f := &cfg.Feishu
	if fc.Feishu.AllowedOpenIDs != nil {
		f.AllowedOpenIDs = fc.Feishu.AllowedOpenIDs
	}
	if fc.Feishu.NotifyChatID != "" {
		f.NotifyChatID = fc.Feishu.NotifyChatID
	}

	h := &cfg.Herdr
	if fc.Herdr.SocketPath != "" {
		h.SocketPath = expandTilde(fc.Herdr.SocketPath)
	}
	if fc.Herdr.PollInterval != 0 {
		h.PollInterval = time.Duration(fc.Herdr.PollInterval)
	}
	if fc.Herdr.CallTimeout != 0 {
		h.CallTimeout = time.Duration(fc.Herdr.CallTimeout)
	}

	u := &cfg.UI
	if fc.UI.MaxCols != 0 {
		u.MaxCols = fc.UI.MaxCols
	}
	if fc.UI.TailLines != 0 {
		u.TailLines = fc.UI.TailLines
	}
	if fc.UI.NotifyCooldown != 0 {
		u.NotifyCooldown = time.Duration(fc.UI.NotifyCooldown)
	}
	if fc.UI.QueueLimit != 0 {
		u.QueueLimit = fc.UI.QueueLimit
	}

	// A bool has no "unset" zero value, so presence decides.
	if md.IsDefined("mirror", "default_on") {
		cfg.Mirror.DefaultOn = fc.Mirror.DefaultOn
	}
	if md.IsDefined("tasks", "enabled") {
		cfg.Tasks.Enabled = fc.Tasks.Enabled
	}
	if md.IsDefined("tasks", "bypass") {
		cfg.Tasks.Bypass = fc.Tasks.Bypass
	}
	cfg.Tasks.DefaultProject = fc.Tasks.DefaultProject
	// Unlike legacy polling settings, an explicitly configured zero must be
	// rejected when tasks are enabled, rather than silently substituted.
	if md.IsDefined("tasks", "poll_interval") {
		cfg.Tasks.PollInterval = time.Duration(fc.Tasks.PollInterval)
	}
	if fc.Tasks.Projects != nil {
		cfg.Tasks.Projects = make(map[string]Project, len(fc.Tasks.Projects))
		for name, project := range fc.Tasks.Projects {
			project.Path = expandTilde(project.Path)
			for i, directory := range project.Directories {
				project.Directories[i] = expandTilde(directory)
			}
			if len(project.Directories) > 0 {
				project.Path = project.Directories[0]
			}
			if project.Agent == "" {
				project.Agent = DefaultTaskAgent
			}
			cfg.Tasks.Projects[name] = project
		}
	}
	if md.IsDefined("ai", "enabled") {
		cfg.AI.Enabled = fc.AI.Enabled
	}
	if md.IsDefined("ai", "provider") {
		cfg.AI.Provider = fc.AI.Provider
	}
	if md.IsDefined("ai", "timeout") {
		cfg.AI.Timeout = time.Duration(fc.AI.Timeout)
	}
	cfg.AI.Model = fc.AI.Model
	cfg.AI.BaseURL = fc.AI.BaseURL
	return nil
}

// expandTilde resolves a leading "~" against the home directory.
//
// TOML performs no shell expansion, so socket_path = "~/.config/herdr/herdr.sock"
// — the natural thing to type into a config file — would otherwise reach
// net.Dial as the literal relative path ./~/.config/... and fail with "no such
// file or directory" at the first herdr call, far away from the mistake.
//
// "~otheruser/..." is left alone: resolving another user's home is not portable
// and guessing would be worse than refusing. Validate rejects anything that
// still begins with "~" after this, including the case where home is unknown.
func expandTilde(path string) string {
	if path != "~" && !strings.HasPrefix(path, "~/") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return path
	}
	if path == "~" {
		return home
	}
	return filepath.Join(home, strings.TrimPrefix(path, "~/"))
}

// rejectUnknownKeys turns typos into startup errors. Silently ignoring
// `allowed_open_id` (singular) would leave the operator believing they are on
// the allowlist when they are not; silently ignoring an app_secret written
// here would leave them believing the bridge is configured when it is not.
func rejectUnknownKeys(path string, md toml.MetaData) error {
	undecoded := md.Undecoded()
	if len(undecoded) == 0 {
		return nil
	}
	keys := make([]string, 0, len(undecoded))
	credential := false
	for _, k := range undecoded {
		s := k.String()
		switch s {
		case "feishu.app_id", "feishu.app_secret", "ai.api_key":
			credential = true
		}
		keys = append(keys, s)
	}
	sort.Strings(keys)

	msg := fmt.Sprintf("%s: unknown key(s): %s", path, strings.Join(keys, ", "))
	if credential {
		msg += fmt.Sprintf("; credentials are read from %s / %s / %s in the environment or .env only, never from %s",
			EnvAppID, EnvAppSecret, EnvAIAPIKey, ConfigFileName)
	}
	return errors.New(msg)
}
