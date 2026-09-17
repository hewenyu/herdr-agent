package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/hewenyu/herdr-agent/internal/screen"
)

// File and environment names the bridge reads.
const (
	// ConfigFileName lives inside the state directory (StateDir).
	ConfigFileName = "config.toml"

	// DotEnvFileName is read from the state directory and from the repository
	// root. It carries credentials only; everything else belongs in
	// ConfigFileName.
	DotEnvFileName = ".env"

	EnvAppID     = "FEISHU_APP_ID"
	EnvAppSecret = "FEISHU_APP_SECRET"
)

// Defaults for unset fields. Legacy Herdr and UI settings also use these for
// explicit zero values; task polling requires a positive configured value.
const (
	DefaultPollInterval     = 1 * time.Second
	DefaultCallTimeout      = 10 * time.Second
	DefaultMaxCols          = screen.DefaultMaxCols
	DefaultTailLines        = 18
	DefaultNotifyCooldown   = 30 * time.Second
	DefaultQueueLimit       = 5
	DefaultConfigListen     = "127.0.0.1:18790"
	DefaultTaskPollInterval = 30 * time.Second
	DefaultTaskAgent        = "codex"
	DefaultAIProvider       = "openai-responses"
	DefaultAITimeout        = 2 * time.Minute
)

// Validation failures, exported so callers can react to a specific one
// (doctor prints different advice for a missing credential than for an empty
// allowlist). Validate reports all problems at once via errors.Join, so use
// errors.Is rather than equality.
var (
	ErrMissingAppID     = errors.New("feishu app id is not set")
	ErrMalformedAppID   = errors.New("feishu app id is malformed")
	ErrMissingAppSecret = errors.New("feishu app secret is not set")
	ErrEmptyAllowlist   = errors.New("feishu.allowed_open_ids is empty")
	ErrBlankOpenID      = errors.New("feishu.allowed_open_ids contains a blank entry")
	ErrNegative         = errors.New("value must not be negative")
	ErrUnexpandedTilde  = errors.New("path still starts with ~")
)

// Default returns the configuration used when config.toml is absent or a field
// is unset.
//
// Feishu.AllowedOpenIDs is deliberately empty: default deny. Everything else
// has a usable value, so defaults plus the two credentials from the
// environment is a complete configuration.
func Default() Config {
	return Config{
		Herdr: Herdr{
			SocketPath:   "", // empty => herdrapi resolves it
			PollInterval: DefaultPollInterval,
			CallTimeout:  DefaultCallTimeout,
		},
		UI: UI{
			ConfigListen:   DefaultConfigListen,
			MaxCols:        DefaultMaxCols,
			TailLines:      DefaultTailLines,
			NotifyCooldown: DefaultNotifyCooldown,
			QueueLimit:     DefaultQueueLimit,
		},
		Mirror: Mirror{DefaultOn: false},
		Tasks:  Tasks{PollInterval: DefaultTaskPollInterval, Bypass: true},
		AI:     AI{Provider: DefaultAIProvider, Timeout: DefaultAITimeout},
	}
}

// Load reads <dir>/config.toml over Default(), including ai.api_key. Feishu
// credentials come from the environment, falling back to .env files.
//
// A missing config.toml is not an error. The returned Config is not validated;
// call Validate.
func Load(dir string) (Config, error) {
	// Without this, Load("") would quietly read ./config.toml — whatever
	// directory the bridge happens to have been started from.
	if dir == "" {
		return Config{}, fmt.Errorf("config: no state directory given (use %s or DefaultDir)", StateDir)
	}

	cfg := Default()

	if err := applyCredentials(&cfg, dir); err != nil {
		return Config{}, err
	}
	if err := applyFile(&cfg, filepath.Join(dir, ConfigFileName)); err != nil {
		return Config{}, &redactedError{cause: err, text: cfg.scrub(err.Error())}
	}
	return cfg, nil
}

// DefaultDir is <home>/StateDir, where the bridge keeps its config and state.
func DefaultDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	return filepath.Join(home, StateDir), nil
}

// appIDShape is what every Feishu app id looks like. Used to reject a secret
// pasted into the app-id field before it can be echoed anywhere.
var appIDShape = regexp.MustCompile(`^cli_[A-Za-z0-9]+$`)

// Validate reports every problem it finds, joined into one error.
func (c Config) Validate() error {
	var errs []error

	switch {
	case c.Feishu.AppID == "":
		errs = append(errs, fmt.Errorf("%w: export %s or put it in %s", ErrMissingAppID, EnvAppID, DotEnvFileName))
	case !appIDShape.MatchString(c.Feishu.AppID):
		// The console lists App ID directly above App Secret, so pasting them
		// transposed is a normal mistake. Caught only by non-emptiness, the
		// secret then travels as an "app id" into log lines and console URLs
		// built from it — a leak produced by a typo. Fail here instead, and
		// never quote the offending value.
		errs = append(errs, fmt.Errorf("%w: %s does not look like an app id (expected cli_...); "+
			"check you did not swap it with the app secret", ErrMalformedAppID, EnvAppID))
	}
	if c.Feishu.AppSecret == "" {
		errs = append(errs, fmt.Errorf("%w: export %s or put it in %s (never in %s)",
			ErrMissingAppSecret, EnvAppSecret, DotEnvFileName, ConfigFileName))
	}

	// G10: reaching the herdr socket is equivalent to a shell on this machine,
	// so an unset allowlist must lock everyone out rather than let everyone in.
	if len(c.Feishu.AllowedOpenIDs) == 0 {
		errs = append(errs, fmt.Errorf(
			"%w: default deny — list your own open_id, because driving an agent is equivalent to shell access",
			ErrEmptyAllowlist))
	}
	for i, id := range c.Feishu.AllowedOpenIDs {
		// A blank entry would match an event whose operator open_id is missing
		// or empty, i.e. it silently becomes allow-anonymous.
		if isBlank(id) {
			errs = append(errs, fmt.Errorf("%w: entry %d", ErrBlankOpenID, i))
		}
	}

	// applyFile expands a leading "~/", so anything left here is either
	// "~otheruser/..." or a home directory we could not resolve. Both dial a
	// path that does not exist; say so now rather than at the first herdr call.
	// The value is scrubbed for the same reason Redacted() scrubs: an operator
	// who pasted the secret into the wrong field must not see it echoed back.
	if strings.HasPrefix(c.Herdr.SocketPath, "~") {
		errs = append(errs, fmt.Errorf("%w: herdr.socket_path = %q; %s does not expand it, write the absolute path",
			ErrUnexpandedTilde, c.scrub(c.Herdr.SocketPath), ConfigFileName))
	}

	errs = append(errs,
		nonNegativeDuration("herdr.poll_interval", c.Herdr.PollInterval),
		nonNegativeDuration("herdr.call_timeout", c.Herdr.CallTimeout),
		nonNegativeDuration("ui.notify_cooldown", c.UI.NotifyCooldown),
		nonNegativeInt("ui.max_cols", c.UI.MaxCols),
		nonNegativeInt("ui.tail_lines", c.UI.TailLines),
		nonNegativeInt("ui.queue_limit", c.UI.QueueLimit),
		c.validateTasks(),
		c.validateAI(),
	)

	return errors.Join(errs...)
}

func nonNegativeDuration(name string, d time.Duration) error {
	if d < 0 {
		return fmt.Errorf("%s = %s: %w", name, d, ErrNegative)
	}
	return nil
}

func nonNegativeInt(name string, v int) error {
	if v < 0 {
		return fmt.Errorf("%s = %d: %w", name, v, ErrNegative)
	}
	return nil
}

func isBlank(s string) bool {
	for _, r := range s {
		if r != ' ' && r != '\t' && r != '\n' && r != '\r' {
			return false
		}
	}
	return true
}
