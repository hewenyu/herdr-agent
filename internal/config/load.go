package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
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

// Defaults for every field documented as "0 => ..." in contract.go.
const (
	DefaultPollInterval   = 1 * time.Second
	DefaultCallTimeout    = 10 * time.Second
	DefaultMaxCols        = screen.DefaultMaxCols
	DefaultTailLines      = 18
	DefaultNotifyCooldown = 30 * time.Second
	DefaultQueueLimit     = 5
)

// Validation failures, exported so callers can react to a specific one
// (doctor prints different advice for a missing credential than for an empty
// allowlist). Validate reports all problems at once via errors.Join, so use
// errors.Is rather than equality.
var (
	ErrMissingAppID     = errors.New("feishu app id is not set")
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
			MaxCols:        DefaultMaxCols,
			TailLines:      DefaultTailLines,
			NotifyCooldown: DefaultNotifyCooldown,
			QueueLimit:     DefaultQueueLimit,
		},
		Mirror: Mirror{DefaultOn: false},
	}
}

// Load reads <dir>/config.toml over Default() and takes the two credentials
// from the environment, falling back to .env files (see DotEnvFileName).
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

	if err := applyFile(&cfg, filepath.Join(dir, ConfigFileName)); err != nil {
		return Config{}, err
	}
	if err := applyCredentials(&cfg, dir); err != nil {
		return Config{}, err
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

// Validate reports every problem it finds, joined into one error.
func (c Config) Validate() error {
	var errs []error

	if c.Feishu.AppID == "" {
		errs = append(errs, fmt.Errorf("%w: export %s or put it in %s", ErrMissingAppID, EnvAppID, DotEnvFileName))
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
			ErrUnexpandedTilde, scrub(c.Herdr.SocketPath, c.Feishu.AppSecret), ConfigFileName))
	}

	errs = append(errs,
		nonNegativeDuration("herdr.poll_interval", c.Herdr.PollInterval),
		nonNegativeDuration("herdr.call_timeout", c.Herdr.CallTimeout),
		nonNegativeDuration("ui.notify_cooldown", c.UI.NotifyCooldown),
		nonNegativeInt("ui.max_cols", c.UI.MaxCols),
		nonNegativeInt("ui.tail_lines", c.UI.TailLines),
		nonNegativeInt("ui.queue_limit", c.UI.QueueLimit),
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
