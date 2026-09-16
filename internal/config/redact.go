package config

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Placeholders used by Redacted.
const (
	// RedactedSecret is fixed-width on purpose. A prefix, a suffix or even the
	// length of a secret is information an attacker reading a log file does not
	// otherwise have, and log files outlive secrets.
	RedactedSecret = "<redacted>"

	unsetValue = "<unset>"
	autoValue  = "<auto>"

	// minScrubLen is the shortest secret worth pattern-matching for. Scrubbing
	// a one- or two-character string out of the whole line would corrupt it.
	minScrubLen = 8
)

// Redacted is the one-line form of the configuration that is safe to log at
// startup. It never contains the app secret or AI API key.
func (c Config) Redacted() string {
	var b strings.Builder
	b.WriteString(c.Feishu.String())
	b.WriteString(" herdr.socket_path=")
	b.WriteString(orDefault(c.Herdr.SocketPath, autoValue))
	b.WriteString(" herdr.poll_interval=")
	b.WriteString(c.Herdr.PollInterval.String())
	b.WriteString(" herdr.call_timeout=")
	b.WriteString(c.Herdr.CallTimeout.String())
	b.WriteString(" ui.max_cols=")
	b.WriteString(strconv.Itoa(c.UI.MaxCols))
	b.WriteString(" ui.tail_lines=")
	b.WriteString(strconv.Itoa(c.UI.TailLines))
	b.WriteString(" ui.notify_cooldown=")
	b.WriteString(c.UI.NotifyCooldown.String())
	b.WriteString(" ui.queue_limit=")
	b.WriteString(strconv.Itoa(c.UI.QueueLimit))
	b.WriteString(" mirror.default_on=")
	b.WriteString(strconv.FormatBool(c.Mirror.DefaultOn))
	b.WriteString(" tasks.enabled=")
	b.WriteString(strconv.FormatBool(c.Tasks.Enabled))
	b.WriteString(" tasks.bypass=")
	b.WriteString(strconv.FormatBool(c.Tasks.Bypass))
	b.WriteString(" tasks.default_project=")
	b.WriteString(orDefault(c.Tasks.DefaultProject, unsetValue))
	b.WriteString(" tasks.poll_interval=")
	b.WriteString(c.Tasks.PollInterval.String())
	b.WriteByte(' ')
	b.WriteString(c.AI.String())
	names := make([]string, 0, len(c.Tasks.Projects))
	for name := range c.Tasks.Projects {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		project := c.Tasks.Projects[name]
		b.WriteString(" tasks.projects.")
		b.WriteString(strconv.Quote(c.scrub(name)))
		b.WriteString("={path:")
		b.WriteString(strconv.Quote(c.scrub(project.Path)))
		b.WriteString(",directories:[")
		for i, directory := range project.Directories {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(strconv.Quote(c.scrub(directory)))
		}
		b.WriteByte(']')
		b.WriteString(",agent:")
		b.WriteString(strconv.Quote(c.scrub(project.Agent)))
		b.WriteString("}")
	}

	return c.scrub(b.String())
}

// String makes the redacted form the default rendering, so that an ordinary
// log.Printf("%v", cfg) somewhere in the bridge cannot leak the secret.
func (c Config) String() string { return c.Redacted() }

// String redacts the secret for the same reason Config.String does; Feishu is
// the struct most likely to be logged on its own.
func (f Feishu) String() string {
	var b strings.Builder
	b.WriteString("feishu.app_id=")
	b.WriteString(orDefault(f.AppID, unsetValue))
	b.WriteString(" feishu.app_secret=")
	if f.AppSecret == "" {
		b.WriteString(unsetValue)
	} else {
		b.WriteString(RedactedSecret)
	}
	b.WriteString(" feishu.allowed_open_ids=[")
	b.WriteString(strings.Join(f.AllowedOpenIDs, ","))
	b.WriteString("] feishu.notify_chat_id=")
	b.WriteString(orDefault(f.NotifyChatID, unsetValue))

	return scrub(b.String(), f.AppSecret)
}

// String and MarshalJSON protect standalone AI configuration logging.
func (a AI) String() string {
	key := unsetValue
	if a.APIKey != "" {
		key = RedactedSecret
	}
	return scrub(fmt.Sprintf("ai.enabled=%t ai.provider=%s ai.model=%s ai.base_url=%s ai.timeout=%s ai.api_key=%s",
		a.Enabled, orDefault(a.Provider, unsetValue), orDefault(a.Model, unsetValue), orDefault(a.BaseURL, unsetValue), a.Timeout, key), a.APIKey)
}

func (a AI) MarshalJSON() ([]byte, error) {
	key := ""
	if a.APIKey != "" {
		key = RedactedSecret
	}
	return json.Marshal(struct {
		Enabled  bool   `json:"enabled"`
		Provider string `json:"provider"`
		Model    string `json:"model"`
		BaseURL  string `json:"base_url"`
		Timeout  string `json:"timeout"`
		APIKey   string `json:"api_key"`
	}{a.Enabled, scrub(a.Provider, a.APIKey), scrub(a.Model, a.APIKey), scrub(a.BaseURL, a.APIKey), a.Timeout.String(), key})
}

// MarshalJSON redacts the secret as well, because a structured logger reaches
// for encoding/json rather than String: slog.JSONHandler would otherwise write
// the secret out in full.
//
// Every field is scrubbed, not just the secret's own: Redacted() scrubs the
// whole line it builds, and the JSON path has to make the same promise, or the
// operator who pasted the secret into app_id is protected in the log line and
// leaked in the log record.
func (f Feishu) MarshalJSON() ([]byte, error) {
	secret := ""
	if f.AppSecret != "" {
		secret = RedactedSecret
	}
	// Scrubbing before encoding rather than over the encoded bytes: a secret
	// containing a character encoding/json escapes (a quote, a backslash, or
	// '<' under HTML escaping) would no longer match itself afterwards.
	ids := f.AllowedOpenIDs
	if len(ids) > 0 {
		// A fresh slice: the receiver's backing array is the caller's.
		ids = make([]string, len(f.AllowedOpenIDs))
		for i, id := range f.AllowedOpenIDs {
			ids[i] = scrub(id, f.AppSecret)
		}
	}
	return json.Marshal(struct {
		AppID          string   `json:"app_id"`
		AppSecret      string   `json:"app_secret"`
		AllowedOpenIDs []string `json:"allowed_open_ids"`
		NotifyChatID   string   `json:"notify_chat_id"`
	}{
		AppID:          scrub(f.AppID, f.AppSecret),
		AppSecret:      secret,
		AllowedOpenIDs: ids,
		NotifyChatID:   scrub(f.NotifyChatID, f.AppSecret),
	})
}

// MarshalJSON scrubs the fields that live outside Feishu, which is the only
// level that still knows the secret. Without it json.Marshal(cfg) and
// slog.JSONHandler emit herdr.socket_path verbatim while Redacted() scrubs it.
//
// Any string field added to Config outside Feishu must be listed here.
// TestJSONRedactsEveryStringField fails if one is not.
func (c Config) MarshalJSON() ([]byte, error) {
	// The alias sheds Config's method set; marshalling Config itself here
	// would recurse. Feishu keeps its own MarshalJSON, which is what we want.
	type alias Config
	redacted := alias(c)
	redacted.Feishu.AppID = c.scrub(c.Feishu.AppID)
	redacted.Feishu.NotifyChatID = c.scrub(c.Feishu.NotifyChatID)
	if c.Feishu.AllowedOpenIDs != nil {
		redacted.Feishu.AllowedOpenIDs = make([]string, len(c.Feishu.AllowedOpenIDs))
		for i, id := range c.Feishu.AllowedOpenIDs {
			redacted.Feishu.AllowedOpenIDs[i] = c.scrub(id)
		}
	}
	redacted.Herdr.SocketPath = c.scrub(c.Herdr.SocketPath)
	redacted.Tasks.DefaultProject = c.scrub(c.Tasks.DefaultProject)
	redacted.AI.Provider = c.scrub(c.AI.Provider)
	redacted.AI.Model = c.scrub(c.AI.Model)
	redacted.AI.BaseURL = c.scrub(c.AI.BaseURL)
	if c.Tasks.Projects != nil {
		redacted.Tasks.Projects = make(map[string]Project, len(c.Tasks.Projects))
		for name, project := range c.Tasks.Projects {
			project.Path = c.scrub(project.Path)
			project.Agent = c.scrub(project.Agent)
			if project.Directories != nil {
				project.Directories = append([]string(nil), project.Directories...)
				for i, directory := range project.Directories {
					project.Directories[i] = c.scrub(directory)
				}
			}
			redacted.Tasks.Projects[c.scrub(name)] = project
		}
	}

	b, err := json.Marshal(redacted)
	if err != nil {
		return nil, fmt.Errorf("marshal config: %w", err)
	}
	return b, nil
}

// scrub applies both credentials, including to fields where either was pasted
// accidentally. Replace the longer credential first when their contents overlap.
func (c Config) scrub(s string) string {
	first, second := c.Feishu.AppSecret, c.AI.APIKey
	if len(second) > len(first) {
		first, second = second, first
	}
	return scrub(scrub(s, first), second)
}

// Preserve errors.Is/As while keeping parser errors from echoing credentials.
type redactedError struct {
	cause error
	text  string
}

func (e *redactedError) Error() string { return e.text }
func (e *redactedError) Unwrap() error { return e.cause }

// scrub is the backstop for an operator who pasted the secret into the wrong
// field: notify_chat_id and the allowlist are printed verbatim, and a
// misconfiguration must not turn into a leak.
func scrub(s, secret string) string {
	if len(secret) < minScrubLen {
		return s
	}
	return strings.ReplaceAll(s, secret, RedactedSecret)
}

func orDefault(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}
