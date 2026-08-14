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

// StateDir is where the bridge keeps dedup, routes and the pid file.
// Everything in it is mode 0600.
const StateDir = ".herdr-agent"

// Load reads config.toml from dir (falling back to defaults for every unset
// field) and the two credentials from the environment.
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
