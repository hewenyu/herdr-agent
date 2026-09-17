// Package config loads bridge configuration.
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package config

import "time"

// Config is the whole bridge configuration.
type Config struct {
	Feishu Feishu `toml:"feishu"`
	Herdr  Herdr  `toml:"herdr"`
	UI     UI     `toml:"ui"`
	Mirror Mirror `toml:"mirror"`
	Tasks  Tasks  `toml:"tasks"`
	AI     AI     `toml:"ai"`
	Memory Memory `toml:"memory"`
}

type Feishu struct {
	// AppID and AppSecret come from the environment (.env), never from
	// config.toml, and must NEVER be logged — not even a prefix.
	AppID     string `toml:"-"`
	AppSecret string `toml:"-"`

	// AllowedOpenIDs is the authorization allowlist. Default deny: an empty
	// list means nobody may drive agents. herdr socket access is equivalent to
	// shell access (G10), so this is the security boundary of the product.
	AllowedOpenIDs []string `toml:"allowed_open_ids"`

	// NotifyChatID receives proactive notifications. Never taken from a
	// runtime message.
	NotifyChatID string `toml:"notify_chat_id"`
}

type Herdr struct {
	SocketPath   string        `toml:"socket_path"`   // empty => auto-resolve
	PollInterval time.Duration `toml:"poll_interval"` // 0 => 1s
	CallTimeout  time.Duration `toml:"call_timeout"`  // 0 => 10s
}

type UI struct {
	ConfigListen   string        `toml:"config_listen"`   // empty => 127.0.0.1:18790
	MaxCols        int           `toml:"max_cols"`        // 0 => screen.DefaultMaxCols
	TailLines      int           `toml:"tail_lines"`      // 0 => 18
	NotifyCooldown time.Duration `toml:"notify_cooldown"` // 0 => 30s
	QueueLimit     int           `toml:"queue_limit"`     // 0 => 5
}

type Mirror struct {
	// DefaultOn mirrors every agent without an explicit /mirror on.
	// Default false: a chatty agent would flood the chat.
	DefaultOn bool `toml:"default_on"`
}

// Tasks associates Feishu task projects with local directories. Disabled by
// default, so existing installations do not create tasks or workspaces.
type Tasks struct {
	Enabled        bool               `toml:"enabled"`
	Bypass         bool               `toml:"bypass"`
	DefaultProject string             `toml:"default_project"`
	PollInterval   time.Duration      `toml:"poll_interval"` // unset => 30s; must be positive when enabled
	Projects       map[string]Project `toml:"projects"`
}

// Project is an ordered set of existing directories and its agent. The first
// directory is the working directory. Path remains the legacy single-directory
// setting; when Directories is set it is authoritative and Path mirrors its first
// entry. Load expands ~/ and defaults an omitted Agent to codex.
type Project struct {
	Path        string   `toml:"path" json:"path"`
	Directories []string `toml:"directories" json:"directories"`
	Agent       string   `toml:"agent" json:"agent"`
}

// AI configures the model API used for natural-language dialogue in the bot's
// entry chat and task groups. The bridge supplies authorized task tools.
type AI struct {
	Enabled  bool          `toml:"enabled"`
	Provider string        `toml:"provider"`
	Model    string        `toml:"model"`
	BaseURL  string        `toml:"base_url"`
	Timeout  time.Duration `toml:"timeout"`
	// ContextTokens is the input context limit/compaction threshold (default
	// 50000, range 16384..1048576). Allow another 4096 output tokens within the
	// selected model's actual context window.
	ContextTokens int `toml:"context_tokens"`
	// APIKey is read only from [ai].api_key in config.toml and is always redacted.
	APIKey string `toml:"api_key"`
}

// Memory configures storage and recall of conversation summaries, independently
// of the model provider used for replies/summaries. Recent original dialogue,
// checkpoints, archives and operation/message receipts remain in local state.
type Memory struct {
	Provider string                    `toml:"provider"`
	BaseURL  string                    `toml:"base_url"`
	APIKey   string                    `toml:"api_key"`
	Timeout  time.Duration             `toml:"timeout"`
	Users    map[string]MemoryProvider `toml:"users"`
}

// MemoryProvider is a complete per-user storage configuration. Overrides do
// not inherit the global endpoint or credentials; omitted fields use defaults.
type MemoryProvider struct {
	Provider string        `toml:"provider"`
	BaseURL  string        `toml:"base_url"`
	APIKey   string        `toml:"api_key"`
	Timeout  time.Duration `toml:"timeout"`
}

// StateDir is where the bridge keeps dedup, routes and the pid file.
// Everything in it is mode 0600.
const StateDir = ".herdr-agent"

// Load reads config.toml from dir (falling back to defaults for every unset
// field), including the model API key. Feishu credentials come from the
// environment or .env.
//
// Implementations must also provide, in load.go, exactly:
//
//	func Load(dir string) (Config, error)
//	func Default() Config
//	func (c Config) Validate() error
//
// Validate must reject an empty AllowedOpenIDs with a clear message, because
// silently defaulting to allow-all would hand shell access to anyone who finds
// the bot.
type Loader interface {
	Load(dir string) (Config, error)
}
