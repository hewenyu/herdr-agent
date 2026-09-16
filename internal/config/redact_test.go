package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

const testSecret = "sTHm9Zq3XvL8pR2wYd6KcN4bTf7Jg1Hx"

// The secret must not survive in any form: not whole, not as a prefix or
// suffix, and not as its length. Log files outlive secrets.
func TestRedactedNeverContainsSecret(t *testing.T) {
	c := validConfig()
	c.Feishu.AppSecret = testSecret

	renderings := map[string]string{
		"Redacted":        c.Redacted(),
		"Config.String":   c.String(),
		"Feishu.String":   c.Feishu.String(),
		"fmt %v":          fmt.Sprintf("%v", c),
		"fmt %+v":         fmt.Sprintf("%+v", c),
		"fmt %s":          fmt.Sprintf("%s", c),
		"fmt %v feishu":   fmt.Sprintf("%v", c.Feishu),
		"fmt %+v feishu":  fmt.Sprintf("%+v", c.Feishu),
		"fmt %v pointer":  fmt.Sprintf("%v", &c),
		"fmt %+v pointer": fmt.Sprintf("%+v", &c),
	}

	for name, out := range renderings {
		if strings.Contains(out, testSecret) {
			t.Errorf("%s leaks the whole secret: %s", name, out)
		}
		for n := 4; n <= len(testSecret); n++ {
			if strings.Contains(out, testSecret[:n]) {
				t.Errorf("%s leaks a %d-character prefix of the secret: %s", name, n, out)
			}
			if strings.Contains(out, testSecret[len(testSecret)-n:]) {
				t.Errorf("%s leaks a %d-character suffix of the secret: %s", name, n, out)
			}
		}
		if strings.Contains(out, strconv.Itoa(len(testSecret))+" ") {
			t.Errorf("%s looks like it prints the secret length: %s", name, out)
		}
		if !strings.Contains(out, RedactedSecret) {
			t.Errorf("%s does not say the secret was redacted: %s", name, out)
		}
	}
}

// A structured logger marshals rather than stringifies, so that path needs its
// own guarantee. The cases mirror TestRedactedScrubsSecretPastedElsewhere: the
// two paths must protect the same fields, or the operator is safe in the log
// line and leaked in the log record.
func TestJSONNeverContainsSecret(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{"secret in its own field only", func(*Config) {}},
		{"in notify_chat_id", func(c *Config) { c.Feishu.NotifyChatID = testSecret }},
		{"in the allowlist", func(c *Config) { c.Feishu.AllowedOpenIDs = []string{testSecret} }},
		{"in the socket path", func(c *Config) { c.Herdr.SocketPath = "/tmp/" + testSecret + ".sock" }},
		{"in app_id", func(c *Config) { c.Feishu.AppID = testSecret }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := validConfig()
			c.Feishu.AppSecret = testSecret
			tt.mutate(&c)

			blob, err := json.Marshal(c)
			if err != nil {
				t.Fatalf("json.Marshal: %v", err)
			}
			if strings.Contains(string(blob), testSecret) {
				t.Errorf("json.Marshal leaks the secret: %s", blob)
			}
			// json escapes the angle brackets of the placeholder, so compare
			// decoded.
			var back struct {
				Feishu struct {
					AppSecret string `json:"app_secret"`
				}
			}
			if err := json.Unmarshal(blob, &back); err != nil {
				t.Fatalf("json.Unmarshal: %v", err)
			}
			if back.Feishu.AppSecret != RedactedSecret {
				t.Errorf("app_secret = %q, want %q", back.Feishu.AppSecret, RedactedSecret)
			}

			var buf bytes.Buffer
			slog.New(slog.NewJSONHandler(&buf, nil)).Info("startup", "config", c)
			if strings.Contains(buf.String(), testSecret) {
				t.Errorf("slog JSON handler leaks the secret: %s", buf.String())
			}
		})
	}
}

// Feishu is the struct most likely to be logged on its own, and Config's
// MarshalJSON cannot help it there: its own scrubbing has to be complete.
func TestFeishuJSONNeverContainsSecret(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Feishu)
	}{
		{"in notify_chat_id", func(f *Feishu) { f.NotifyChatID = testSecret }},
		{"in the allowlist", func(f *Feishu) { f.AllowedOpenIDs = []string{"ou_ok", testSecret} }},
		{"in app_id", func(f *Feishu) { f.AppID = testSecret }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := validConfig().Feishu
			f.AppSecret = testSecret
			tt.mutate(&f)
			before := append([]string(nil), f.AllowedOpenIDs...)

			blob, err := json.Marshal(f)
			if err != nil {
				t.Fatalf("json.Marshal: %v", err)
			}
			if strings.Contains(string(blob), testSecret) {
				t.Errorf("json.Marshal(Feishu) leaks the secret: %s", blob)
			}
			// Redaction is a rendering, not an edit: the authorization
			// allowlist must still say what it said.
			for i, want := range before {
				if f.AllowedOpenIDs[i] != want {
					t.Errorf("MarshalJSON mutated the allowlist: entry %d = %q, want %q", i, f.AllowedOpenIDs[i], want)
				}
			}
		})
	}
}

// A field added to Config later is a field nobody remembers to scrub. This
// plants the secret in every string reachable from Config and asserts the JSON
// path holds regardless, so the guard does not have to be re-derived by hand.
func TestJSONRedactsEveryStringField(t *testing.T) {
	c := validConfig()
	plantSecret(reflect.ValueOf(&c).Elem(), testSecret)

	// Without this the walk could silently reach nothing and the assertion
	// below would hold vacuously.
	for name, got := range map[string]string{
		"feishu.app_secret":     c.Feishu.AppSecret,
		"feishu.notify_chat_id": c.Feishu.NotifyChatID,
		"herdr.socket_path":     c.Herdr.SocketPath,
		"tasks.default_project": c.Tasks.DefaultProject,
		"tasks.projects.path":   c.Tasks.Projects[testSecret].Path,
		"tasks.projects.agent":  c.Tasks.Projects[testSecret].Agent,
	} {
		if got != testSecret {
			t.Fatalf("plantSecret did not reach %s (= %q); the walk is broken", name, got)
		}
	}
	if len(c.Feishu.AllowedOpenIDs) != 1 || c.Feishu.AllowedOpenIDs[0] != testSecret {
		t.Fatalf("plantSecret did not reach feishu.allowed_open_ids (= %v)", c.Feishu.AllowedOpenIDs)
	}

	blob, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	if strings.Contains(string(blob), testSecret) {
		t.Errorf("json.Marshal leaks the secret from a field nothing scrubs: %s", blob)
	}
}

// plantSecret sets every exported string, and every exported slice of strings,
// reachable from v to secret. Non-string fields cannot carry a credential.
func plantSecret(v reflect.Value, secret string) {
	switch v.Kind() {
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).IsExported() {
				plantSecret(v.Field(i), secret)
			}
		}
	case reflect.String:
		v.SetString(secret)
	case reflect.Slice:
		if v.Type().Elem().Kind() == reflect.String {
			s := reflect.MakeSlice(v.Type(), 1, 1)
			plantSecret(s.Index(0), secret)
			v.Set(s)
		}
	case reflect.Map:
		if v.Type().Key().Kind() == reflect.String {
			m := reflect.MakeMap(v.Type())
			elem := reflect.New(v.Type().Elem()).Elem()
			plantSecret(elem, secret)
			m.SetMapIndex(reflect.ValueOf(secret), elem)
			v.Set(m)
		}
	}
}

// An operator who pastes the secret into the wrong field must not have it
// logged either.
func TestRedactedScrubsSecretPastedElsewhere(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{"in notify_chat_id", func(c *Config) { c.Feishu.NotifyChatID = testSecret }},
		{"in the allowlist", func(c *Config) { c.Feishu.AllowedOpenIDs = []string{testSecret} }},
		{"in the socket path", func(c *Config) { c.Herdr.SocketPath = "/tmp/" + testSecret + ".sock" }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := validConfig()
			c.Feishu.AppSecret = testSecret
			tt.mutate(&c)

			if out := c.Redacted(); strings.Contains(out, testSecret) {
				t.Errorf("Redacted leaks the secret: %s", out)
			}
		})
	}
}

func TestRedactedKeepsWhatOperationsNeeds(t *testing.T) {
	c := validConfig()
	c.Feishu.NotifyChatID = "oc_notify"
	c.Herdr.SocketPath = "/tmp/herdr.sock"

	out := c.Redacted()
	for _, want := range []string{
		"feishu.app_id=cli_valid",
		"feishu.app_secret=" + RedactedSecret,
		"feishu.allowed_open_ids=[ou_00000000000000000000000000000001]",
		"feishu.notify_chat_id=oc_notify",
		"herdr.socket_path=/tmp/herdr.sock",
		"herdr.poll_interval=1s",
		"herdr.call_timeout=10s",
		"ui.max_cols=56",
		"ui.tail_lines=18",
		"ui.notify_cooldown=30s",
		"ui.queue_limit=5",
		"mirror.default_on=false",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("Redacted() = %s\nmissing %q", out, want)
		}
	}
	if strings.Contains(out, "\n") {
		t.Error("Redacted() spans several lines; it is meant to be one log line")
	}
}

func TestRedactedUnsetFields(t *testing.T) {
	out := Default().Redacted()
	for _, want := range []string{
		"feishu.app_id=" + unsetValue,
		"feishu.app_secret=" + unsetValue,
		"feishu.allowed_open_ids=[]",
		"herdr.socket_path=" + autoValue,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("Redacted() = %s\nmissing %q", out, want)
		}
	}
}

// A short secret is below minScrubLen, so the scrub backstop is a no-op here
// and this exercises the placeholder on its own. Without it, the tests above
// could pass on the strength of the backstop alone.
func TestShortSecretIsStillNotPrinted(t *testing.T) {
	c := validConfig()
	c.Feishu.AppSecret = "abc"

	for name, out := range map[string]string{"Redacted": c.Redacted(), "Feishu.String": c.Feishu.String()} {
		if strings.Contains(out, "abc") {
			t.Errorf("%s leaks a short secret: %s", name, out)
		}
		if !strings.Contains(out, RedactedSecret) {
			t.Errorf("%s does not say the secret was redacted: %s", name, out)
		}
	}
}
