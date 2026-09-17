package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

const testMemoryKey = "test-global-memory-storage-key"
const testUserMemoryKey = "test-user-memory-storage-key"

func TestMemoryConfigurationDefaultsAndIndependentOverrides(t *testing.T) {
	dir, _ := isolate(t)
	t.Setenv("HERDR_AGENT_MEMORY_API_KEY", "ignored-environment-memory-key")
	defaults, err := Load(dir)
	if err != nil || defaults.Memory.Provider != "file" || defaults.Memory.APIKey != "" || defaults.Memory.Timeout != DefaultMemoryTimeout {
		t.Fatalf("default memory configuration: %v", err)
	}
	writeFile(t, filepath.Join(dir, ConfigFileName), `
[memory]
provider = "http"
base_url = "https://storage.example/api"
api_key = "`+testMemoryKey+`"
timeout = "20s"
[memory.users."ou_local"]
provider = "file"
[memory.users."ou_remote"]
provider = "http"
base_url = "http://127.0.0.1:9010/prefix"
`)
	cfg, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.validateMemory(); err != nil {
		t.Fatal(err)
	}
	global := cfg.Memory.ForUser("ou_default")
	if global.Provider != "http" || global.BaseURL != "https://storage.example/api" || global.APIKey != testMemoryKey || global.Timeout != 20*time.Second {
		t.Fatal("global memory configuration was not preserved")
	}
	local := cfg.Memory.ForUser("ou_local")
	if local.Provider != "file" || local.BaseURL != "" || local.APIKey != "" || local.Timeout != DefaultMemoryTimeout {
		t.Fatal("user override inherited global provider settings or lost defaults")
	}
	remote := cfg.Memory.ForUser("ou_remote")
	if remote.Provider != "http" || remote.BaseURL != "http://127.0.0.1:9010/prefix" || remote.APIKey != "" || remote.Timeout != DefaultMemoryTimeout {
		t.Fatal("independent user HTTP configuration was not loaded")
	}
	if defaults := Default().Memory.ForUser("any"); defaults.Provider != "file" || defaults.Timeout != DefaultMemoryTimeout || defaults.APIKey != "" {
		t.Fatal("file provider defaults changed")
	}
}

func TestMemoryConfigurationValidation(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*Memory)
		want   error
	}{
		{"file", func(*Memory) {}, nil},
		{"unknown provider", func(m *Memory) { m.Provider = "openai" }, ErrMemoryProvider},
		{"valid remote", func(m *Memory) { m.Provider, m.BaseURL, m.APIKey = "http", "https://store.example/api", testMemoryKey }, nil},
		{"missing remote key", func(m *Memory) { m.Provider, m.BaseURL = "http", "https://store.example/api" }, ErrMemoryAPIKey},
		{"insecure remote", func(m *Memory) { m.Provider, m.BaseURL, m.APIKey = "http", "http://store.example/api", testMemoryKey }, ErrMemoryBaseURL},
		{"loopback no key", func(m *Memory) { m.Provider, m.BaseURL = "http", "http://127.0.0.1:8123/api" }, nil},
		{"ipv6 loopback", func(m *Memory) { m.Provider, m.BaseURL = "http", "http://[::1]:8123/api" }, nil},
		{"url credentials", func(m *Memory) { m.Provider, m.BaseURL = "http", "https://user:secret@store.example/api" }, ErrMemoryBaseURL},
		{"url query", func(m *Memory) { m.Provider, m.BaseURL = "http", "http://localhost/api?key=foo" }, ErrMemoryBaseURL},
		{"empty query", func(m *Memory) { m.Provider, m.BaseURL = "http", "http://localhost/api?" }, ErrMemoryBaseURL},
		{"url fragment", func(m *Memory) { m.Provider, m.BaseURL = "http", "http://localhost/api#" }, ErrMemoryBaseURL},
		{"zero timeout", func(m *Memory) { m.Provider, m.BaseURL, m.Timeout = "http", "http://localhost", 0 }, ErrMemoryTimeout},
		{"excess timeout", func(m *Memory) {
			m.Provider, m.BaseURL, m.Timeout = "http", "http://localhost", 2*time.Minute+time.Second
		}, ErrMemoryTimeout},
		{"empty user", func(m *Memory) { m.Users = map[string]MemoryProvider{"": {Provider: "file"}} }, ErrMemoryUser},
		{"blank user", func(m *Memory) { m.Users = map[string]MemoryProvider{" ou_owner ": {Provider: "file"}} }, ErrMemoryUser},
		{"invalid user provider", func(m *Memory) { m.Users = map[string]MemoryProvider{"ou_owner": {Provider: "database"}} }, ErrMemoryProvider},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg := Default()
			test.mutate(&cfg.Memory)
			if err := cfg.validateMemory(); !errors.Is(err, test.want) {
				t.Fatalf("error=%v want=%v", err, test.want)
			}
		})
	}
}

func TestMemoryCredentialsAreRedactedAcrossConfigurationAndUsers(t *testing.T) {
	for _, key := range []string{testMemoryKey, `memory-"\<>` + testMemoryKey} {
		cfg := validConfig()
		plantSecret(reflect.ValueOf(&cfg).Elem(), key)
		cfg.Feishu.AppSecret = testSecret
		cfg.AI.APIKey = testAIAPIKey
		cfg.Memory.Users[key] = MemoryProvider{Provider: testUserMemoryKey, BaseURL: key, APIKey: testUserMemoryKey, Timeout: DefaultMemoryTimeout}
		cfg.Herdr.SocketPath = testUserMemoryKey
		renderings := []string{cfg.Redacted(), fmt.Sprintf("%+v", cfg), cfg.Memory.String(), cfg.Memory.ForUser(key).String()}
		for _, value := range []any{cfg, cfg.Memory} {
			data, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			renderings = append(renderings, string(data))
			for _, jsonLog := range []bool{false, true} {
				var log bytes.Buffer
				var handler slog.Handler = slog.NewTextHandler(&log, nil)
				if jsonLog {
					handler = slog.NewJSONHandler(&log, nil)
				}
				slog.New(handler).Info("config", "value", value)
				renderings = append(renderings, log.String())
			}
		}
		for _, rendering := range renderings {
			for _, secret := range []string{testUserMemoryKey, testSecret, testAIAPIKey} {
				encoded, _ := json.Marshal(secret)
				if strings.Contains(rendering, secret) || strings.Contains(rendering, string(encoded[1:len(encoded)-1])) {
					t.Fatal("rendering leaked a configured credential")
				}
			}
		}
		// Standalone user configuration cannot know the global credential. All
		// whole-config/memory renderers must scrub both keys across all users.
		encoded, _ := json.Marshal(key)
		for i, rendering := range renderings {
			if i == 3 {
				continue
			}
			if strings.Contains(rendering, key) || strings.Contains(rendering, string(encoded[1:len(encoded)-1])) {
				t.Fatal("whole memory/config rendering leaked global credentials")
			}
		}
		if cfg.Memory.APIKey != key || cfg.Memory.Users[key].APIKey != testUserMemoryKey || cfg.Herdr.SocketPath != testUserMemoryKey {
			t.Fatal("redaction mutated the active configuration")
		}
	}
}

func TestMemoryCredentialParserFailuresAreRedacted(t *testing.T) {
	for _, key := range []string{testMemoryKey, `quoted-"\` + testUserMemoryKey, "short"} {
		quoted := strconv.Quote(key)
		for _, body := range []string{
			"[memory]\ntimeout = " + quoted + "\napi_key = " + quoted + "\n",
			"[memory.users.ou_owner]\ntimeout = " + quoted + "\napi_key = " + quoted + "\n",
			"[memory.users." + quoted + "]\nunknown = true\napi_key = " + quoted + "\n",
			"[memory]\napi_key = [" + quoted + "]\n",
			"[memory.users.ou_owner]\napi_key = [" + quoted + "]\n",
			"[memory]\napi_key = " + quoted + "\napi_key = " + quoted + "\n",
		} {
			dir, _ := isolate(t)
			writeFile(t, filepath.Join(dir, ConfigFileName), body)
			_, err := Load(dir)
			if err == nil || strings.Contains(err.Error(), key) || strings.Contains(err.Error(), quoted[1:len(quoted)-1]) {
				t.Fatalf("TOML error exposed credential: %v", err)
			}
		}
	}
}

func TestMemoryShortCredentialPastedIntoOtherFields(t *testing.T) {
	cfg := validConfig()
	cfg.Memory.APIKey = "short"
	cfg.Herdr.SocketPath = "short"
	cfg.AI.Model = "short"
	cfg.Feishu.AppID = "short"
	cfg.Memory.Users = map[string]MemoryProvider{"short": {Provider: "short", BaseURL: "short", APIKey: "another-user-key"}}
	encoded, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, rendering := range []string{cfg.Redacted(), string(encoded)} {
		if strings.Contains(rendering, "short") {
			t.Fatal("short credential pasted into a whole field was exposed")
		}
	}
}

func TestMemoryProviderStandaloneLogging(t *testing.T) {
	for _, key := range []string{testMemoryKey, `storage-"\<>` + testMemoryKey, "short"} {
		provider := MemoryProvider{Provider: key, BaseURL: key, APIKey: key, Timeout: DefaultMemoryTimeout}
		encoded, err := json.Marshal(provider)
		if err != nil {
			t.Fatal(err)
		}
		var log bytes.Buffer
		slog.New(slog.NewJSONHandler(&log, nil)).Info("provider", "value", provider)
		escaped, _ := json.Marshal(key)
		for _, rendering := range []string{provider.String(), provider.LogValue().String(), string(encoded), log.String()} {
			if strings.Contains(rendering, key) || strings.Contains(rendering, string(escaped[1:len(escaped)-1])) {
				t.Fatal("standalone provider logging exposed its credential")
			}
		}
	}
}
