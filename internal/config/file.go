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
// string on its own. Second, Feishu.AppID/AppSecret have no field here, so only
// the model API key can come from TOML; Feishu credentials retain their own
// setup/environment flow.
type fileConfig struct {
	Memory struct {
		Provider string                        `toml:"provider"`
		BaseURL  string                        `toml:"base_url"`
		APIKey   string                        `toml:"api_key"`
		Timeout  tomlDuration                  `toml:"timeout"`
		Users    map[string]fileMemoryProvider `toml:"users"`
	} `toml:"memory"`
	AI struct {
		Enabled       bool         `toml:"enabled"`
		Provider      string       `toml:"provider"`
		Model         string       `toml:"model"`
		BaseURL       string       `toml:"base_url"`
		APIKey        string       `toml:"api_key"`
		Timeout       tomlDuration `toml:"timeout"`
		ContextTokens int          `toml:"context_tokens"`
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
		ConfigListen   string       `toml:"config_listen"`
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

type fileMemoryProvider struct {
	Provider string       `toml:"provider"`
	BaseURL  string       `toml:"base_url"`
	APIKey   string       `toml:"api_key"`
	Timeout  tomlDuration `toml:"timeout"`
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

	// Parse once, then read the key before decoding durations or other fields.
	// Their diagnostics can echo an accidentally pasted key, even when that
	// field appears before api_key in the file.
	var raw toml.Primitive
	md, err := toml.Decode(string(data), &raw)
	var credentials struct {
		AI struct {
			APIKey string `toml:"api_key"`
		} `toml:"ai"`
		Memory struct {
			APIKey string `toml:"api_key"`
			Users  map[string]struct {
				APIKey string `toml:"api_key"`
			} `toml:"users"`
		} `toml:"memory"`
	}
	if err == nil {
		err = md.PrimitiveDecode(raw, &credentials)
	}
	if err != nil {
		// Invalid syntax or a non-string key prevents reliable extraction. Keep
		// the location, but not a parser message which may quote the credential.
		message := fmt.Sprintf("parse %s: invalid TOML; check syntax and use quoted strings for API keys (ai.api_key and memory.api_key)", path)
		var parseErr toml.ParseError
		if errors.As(err, &parseErr) {
			message = fmt.Sprintf("parse %s at line %d: invalid TOML; check syntax and use quoted strings for API keys (ai.api_key and memory.api_key)", path, parseErr.Position.Line)
		}
		return &redactedError{cause: err, text: message}
	}
	cfg.AI.APIKey = credentials.AI.APIKey
	cfg.Memory.APIKey = credentials.Memory.APIKey
	if credentials.Memory.Users != nil {
		cfg.Memory.Users = make(map[string]MemoryProvider, len(credentials.Memory.Users))
		for owner, credential := range credentials.Memory.Users {
			cfg.Memory.Users[owner] = MemoryProvider{APIKey: credential.APIKey}
		}
	}
	var fc fileConfig
	err = md.PrimitiveDecode(raw, &fc)
	if err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	if err := rejectUnknownKeys(path, md, cfg.scrub); err != nil {
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
	if fc.UI.ConfigListen != "" {
		u.ConfigListen = fc.UI.ConfigListen
	}
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
	if md.IsDefined("ai", "context_tokens") {
		cfg.AI.ContextTokens = fc.AI.ContextTokens
	}
	cfg.AI.Model = fc.AI.Model
	cfg.AI.BaseURL = fc.AI.BaseURL
	if md.IsDefined("memory", "provider") {
		cfg.Memory.Provider = fc.Memory.Provider
	}
	if md.IsDefined("memory", "timeout") {
		cfg.Memory.Timeout = time.Duration(fc.Memory.Timeout)
	}
	cfg.Memory.BaseURL = fc.Memory.BaseURL
	for owner, provider := range fc.Memory.Users {
		value := MemoryProvider{Provider: DefaultMemoryProvider, Timeout: DefaultMemoryTimeout, BaseURL: provider.BaseURL, APIKey: provider.APIKey}
		if md.IsDefined("memory", "users", owner, "provider") {
			value.Provider = provider.Provider
		}
		if md.IsDefined("memory", "users", owner, "timeout") {
			value.Timeout = time.Duration(provider.Timeout)
		}
		cfg.Memory.Users[owner] = value
	}
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
func rejectUnknownKeys(path string, md toml.MetaData, scrubValue func(string) string) error {
	undecoded := md.Undecoded()
	if len(undecoded) == 0 {
		return nil
	}
	keys := make([]string, 0, len(undecoded))
	credential := false
	for _, k := range undecoded {
		s := k.String()
		switch s {
		case "feishu.app_id", "feishu.app_secret":
			credential = true
		}
		redacted := append(toml.Key(nil), k...)
		for i, component := range redacted {
			redacted[i] = scrubValue(component)
		}
		keys = append(keys, redacted.String())
	}
	sort.Strings(keys)

	msg := fmt.Sprintf("%s: unknown key(s): %s", path, strings.Join(keys, ", "))
	if credential {
		msg += fmt.Sprintf("; Feishu credentials are read from %s / %s in the environment or .env only, never from %s",
			EnvAppID, EnvAppSecret, ConfigFileName)
	}
	return errors.New(msg)
}
