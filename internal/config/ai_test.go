package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const testAIAPIKey = "api-Q9w4G7k3J5v8R2p6X1y0N4m7B8z5"

func TestAICredentialSources(t *testing.T) {
	for _, scenario := range []string{"absent", "repository", "state", "environment", "explicit empty environment"} {
		t.Run(scenario, func(t *testing.T) {
			dir, repo := isolate(t)
			want := ""
			if scenario != "absent" {
				writeFile(t, filepath.Join(repo, DotEnvFileName), EnvAIAPIKey+"=repository-key\n")
				want = "repository-key"
			}
			if scenario == "state" || strings.Contains(scenario, "environment") {
				writeFile(t, filepath.Join(dir, DotEnvFileName), EnvAIAPIKey+"=state-key\n")
				want = "state-key"
			}
			if strings.Contains(scenario, "environment") {
				want = testAIAPIKey
				if scenario == "explicit empty environment" {
					want = ""
				}
				t.Setenv(EnvAIAPIKey, want)
			}
			c, err := Load(dir)
			if err != nil {
				t.Fatal(err)
			}
			if c.AI.APIKey != want {
				t.Fatal("AI API key did not honor credential source precedence")
			}
			if c.AI.Enabled || c.AI.Provider != DefaultAIProvider || c.AI.Timeout != 2*time.Minute {
				t.Fatalf("unexpected AI defaults: %s", c.AI)
			}
		})
	}
}

func TestLoadAIConfiguration(t *testing.T) {
	dir, _ := isolate(t)
	t.Setenv(EnvAIAPIKey, testAIAPIKey)
	writeFile(t, filepath.Join(dir, ConfigFileName), `[ai]
enabled = true
provider = "anthropic-messages"
model = "test-model"
base_url = "https://models.example/v1"
timeout = "3m"
`)
	c, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !c.AI.Enabled || c.AI.Provider != "anthropic-messages" || c.AI.Model != "test-model" || c.AI.BaseURL != "https://models.example/v1" || c.AI.Timeout != 3*time.Minute || c.AI.APIKey != testAIAPIKey {
		t.Fatalf("AI configuration not loaded: %s", c.AI)
	}
}

func TestAICredentialCannotComeFromTOML(t *testing.T) {
	dir, _ := isolate(t)
	writeFile(t, filepath.Join(dir, ConfigFileName), "[ai]\napi_key = \""+testAIAPIKey+"\"\n")
	_, err := Load(dir)
	if err == nil || !strings.Contains(err.Error(), "ai.api_key") || !strings.Contains(err.Error(), EnvAIAPIKey) {
		t.Fatalf("expected credential source advice, got %v", err)
	}
	if strings.Contains(err.Error(), testAIAPIKey) {
		t.Fatal("TOML credential rejection leaked key")
	}
}

func TestAIValidation(t *testing.T) {
	repo := taskRepository(t, false)
	valid := func() Config {
		c := validConfig()
		c.Tasks.Enabled = true
		c.Tasks.DefaultProject = "repo"
		c.Tasks.Projects = map[string]Project{"repo": {Path: repo, Agent: "codex"}}
		c.AI = AI{Enabled: true, Provider: DefaultAIProvider, Model: "test-model", BaseURL: "https://models.example/v1", Timeout: DefaultAITimeout, APIKey: testAIAPIKey}
		return c
	}
	tests := []struct {
		name   string
		mutate func(*Config)
		want   error
	}{
		{"valid", func(*Config) {}, nil},
		{"disabled", func(c *Config) { c.AI = AI{}; c.Tasks = Tasks{} }, nil},
		{"tasks disabled", func(c *Config) { c.Tasks.Enabled = false }, ErrAITasks},
		{"anthropic provider", func(c *Config) { c.AI.Provider = "anthropic-messages" }, nil},
		{"unknown provider", func(c *Config) { c.AI.Provider = "unknown" }, ErrAIProvider},
		{"empty provider", func(c *Config) { c.AI.Provider = "" }, ErrAIProvider},
		{"empty model", func(c *Config) { c.AI.Model = "  " }, ErrAIModel},
		{"missing key", func(c *Config) { c.AI.APIKey = "" }, ErrAIAPIKey},
		{"blank key", func(c *Config) { c.AI.APIKey = " \t\n" }, ErrAIAPIKey},
		{"zero timeout", func(c *Config) { c.AI.Timeout = 0 }, ErrAITimeout},
		{"negative timeout", func(c *Config) { c.AI.Timeout = -time.Second }, ErrAITimeout},
		{"excess timeout", func(c *Config) { c.AI.Timeout = 10*time.Minute + time.Second }, ErrAITimeout},
		{"maximum timeout", func(c *Config) { c.AI.Timeout = 10 * time.Minute }, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := valid()
			tt.mutate(&c)
			if err := c.Validate(); !errors.Is(err, tt.want) {
				t.Fatalf("Validate() = %v, want %v", err, tt.want)
			}
		})
	}
	for _, baseURL := range []string{"https://api.example/v1", "http://127.0.0.1:8080/v1", "http://[::1]:8080", "http://localhost:8080"} {
		c := valid()
		c.AI.BaseURL = baseURL
		if err := c.Validate(); err != nil {
			t.Errorf("valid base URL %q refused: %v", baseURL, err)
		}
	}
	for _, baseURL := range []string{"", "/api/v1", "https://", "ftp://api.example", "http://api.example", "http://192.168.1.2:8080", "https://user:secret@api.example", "http://localhost.example", "http://0.0.0.0:8080", "http://[::]:8080", "%not-a-url", "https://api.example/v1?key=secret", "https://api.example/v1?", "https://api.example/v1#secret", "https://api.example/v1#"} {
		c := valid()
		c.AI.BaseURL = baseURL
		if err := c.Validate(); !errors.Is(err, ErrAIBaseURL) {
			t.Errorf("invalid base URL %q accepted: %v", baseURL, err)
		}
	}
}

func TestAIExplicitZeroTimeoutRemainsInvalid(t *testing.T) {
	dir, _ := isolate(t)
	writeFile(t, filepath.Join(dir, ConfigFileName), "[ai]\nenabled = true\ntimeout = \"0s\"\n")
	c, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !errors.Is(c.Validate(), ErrAITimeout) {
		t.Fatal("explicit zero timeout was silently defaulted")
	}
}

func TestAIAPIKeyRedactedAcrossConfiguration(t *testing.T) {
	for _, key := range []string{testAIAPIKey, `api-"\<>` + testAIAPIKey} {
		c := validConfig()
		plantSecret(reflect.ValueOf(&c).Elem(), key)
		c.Feishu.AppSecret = testSecret
		beforeIDs := append([]string(nil), c.Feishu.AllowedOpenIDs...)
		renderings := []string{c.Redacted(), fmt.Sprintf("%v", c), fmt.Sprintf("%+v", &c), c.AI.String()}
		for _, v := range []any{c, c.AI} {
			data, err := json.Marshal(v)
			if err != nil {
				t.Fatal(err)
			}
			renderings = append(renderings, string(data))
			var log bytes.Buffer
			slog.New(slog.NewJSONHandler(&log, nil)).Info("configuration", "config", v)
			renderings = append(renderings, log.String())
		}
		encoded, _ := json.Marshal(key)
		for _, out := range renderings {
			if strings.Contains(out, key) || strings.Contains(out, string(encoded[1:len(encoded)-1])) || strings.Contains(out, testSecret) {
				t.Fatal("configuration rendering leaked a credential")
			}
		}
		if c.AI.APIKey != key || !reflect.DeepEqual(c.Feishu.AllowedOpenIDs, beforeIDs) || c.Tasks.Projects[key].Path != key {
			t.Fatal("redaction mutated live configuration")
		}
	}
}

func TestAIAPIKeyRedactedFromConfigurationErrors(t *testing.T) {
	dir, _ := isolate(t)
	t.Setenv(EnvAIAPIKey, testAIAPIKey)
	writeFile(t, filepath.Join(dir, ConfigFileName), "[ai]\ntimeout = \""+testAIAPIKey+"\"\n")
	_, err := Load(dir)
	if err == nil || strings.Contains(err.Error(), testAIAPIKey) {
		t.Fatalf("parse failure did not redact key: %v", err)
	}
	c := validConfig()
	c.AI = AI{Enabled: true, Provider: testAIAPIKey, BaseURL: testAIAPIKey, APIKey: testAIAPIKey}
	c.Herdr.SocketPath = "~" + testAIAPIKey
	c.Tasks.Enabled = true
	c.Tasks.DefaultProject = testAIAPIKey
	c.Tasks.Projects = map[string]Project{testAIAPIKey: {Path: "/missing/" + testAIAPIKey, Agent: "codex"}}
	if err := c.Validate(); err == nil || strings.Contains(err.Error(), testAIAPIKey) {
		t.Fatalf("validation failure did not redact key: %v", err)
	}
}
