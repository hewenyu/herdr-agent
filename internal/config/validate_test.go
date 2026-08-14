package config

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// validConfig is the smallest configuration that must pass.
func validConfig() Config {
	c := Default()
	c.Feishu.AppID = "cli_valid"
	c.Feishu.AppSecret = "secret-value-for-validate"
	c.Feishu.AllowedOpenIDs = []string{"ou_00000000000000000000000000000001"}
	return c
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(*Config)
		wantErr error
		wantSub string
	}{
		{
			name:   "valid",
			mutate: func(*Config) {},
		},
		{
			name:   "zero durations are the documented defaults, not errors",
			mutate: func(c *Config) { c.Herdr.PollInterval, c.Herdr.CallTimeout, c.UI.NotifyCooldown = 0, 0, 0 },
		},
		{
			name:    "missing app id",
			mutate:  func(c *Config) { c.Feishu.AppID = "" },
			wantErr: ErrMissingAppID,
			wantSub: EnvAppID,
		},
		{
			name:    "missing app secret",
			mutate:  func(c *Config) { c.Feishu.AppSecret = "" },
			wantErr: ErrMissingAppSecret,
			wantSub: EnvAppSecret,
		},
		{
			// G10: socket access is shell access, so allow-all is not a default
			// anyone gets by accident.
			name:    "empty allowlist is default deny",
			mutate:  func(c *Config) { c.Feishu.AllowedOpenIDs = nil },
			wantErr: ErrEmptyAllowlist,
			wantSub: "shell access",
		},
		{
			name:    "allowlist of one empty string would allow an operator with no open_id",
			mutate:  func(c *Config) { c.Feishu.AllowedOpenIDs = []string{""} },
			wantErr: ErrBlankOpenID,
		},
		{
			name:    "allowlist entry of blanks",
			mutate:  func(c *Config) { c.Feishu.AllowedOpenIDs = []string{"ou_ok", "  \t"} },
			wantErr: ErrBlankOpenID,
			wantSub: "entry 1",
		},
		{
			name:    "negative poll interval",
			mutate:  func(c *Config) { c.Herdr.PollInterval = -time.Millisecond },
			wantErr: ErrNegative,
			wantSub: "herdr.poll_interval",
		},
		{
			name:    "negative call timeout",
			mutate:  func(c *Config) { c.Herdr.CallTimeout = -time.Second },
			wantErr: ErrNegative,
			wantSub: "herdr.call_timeout",
		},
		{
			name:    "negative notify cooldown",
			mutate:  func(c *Config) { c.UI.NotifyCooldown = -time.Second },
			wantErr: ErrNegative,
			wantSub: "ui.notify_cooldown",
		},
		{
			name:    "negative max cols",
			mutate:  func(c *Config) { c.UI.MaxCols = -1 },
			wantErr: ErrNegative,
			wantSub: "ui.max_cols",
		},
		{
			name:    "negative tail lines",
			mutate:  func(c *Config) { c.UI.TailLines = -1 },
			wantErr: ErrNegative,
			wantSub: "ui.tail_lines",
		},
		{
			name:    "negative queue limit",
			mutate:  func(c *Config) { c.UI.QueueLimit = -1 },
			wantErr: ErrNegative,
			wantSub: "ui.queue_limit",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := validConfig()
			tt.mutate(&c)

			err := c.Validate()
			if tt.wantErr == nil {
				if err != nil {
					t.Fatalf("Validate = %v, want nil", err)
				}
				return
			}
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("Validate = %v, want errors.Is(..., %v)", err, tt.wantErr)
			}
			if tt.wantSub != "" && !strings.Contains(err.Error(), tt.wantSub) {
				t.Errorf("error %q does not mention %q", err, tt.wantSub)
			}
		})
	}
}

// Validate reports everything at once so a first run does not turn into three.
func TestValidateReportsEveryProblem(t *testing.T) {
	c := Default()
	c.Herdr.PollInterval = -time.Second

	err := c.Validate()
	for _, want := range []error{ErrMissingAppID, ErrMissingAppSecret, ErrEmptyAllowlist, ErrNegative} {
		if !errors.Is(err, want) {
			t.Errorf("Validate = %v, missing %v", err, want)
		}
	}
}
