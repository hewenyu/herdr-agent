package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestAIContextBudgetTOML(t *testing.T) {
	for _, test := range []struct {
		name  string
		field string
		want  int
	}{
		{name: "omitted", want: DefaultAIContextTokens},
		{name: "configured", field: "context_tokens = 65536", want: 65536},
		{name: "explicit zero remains invalid", field: "context_tokens = 0", want: 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir, _ := isolate(t)
			writeFile(t, filepath.Join(dir, ConfigFileName), "[ai]\nenabled = true\n"+test.field+"\n")
			cfg, err := Load(dir)
			if err != nil || cfg.AI.ContextTokens != test.want {
				t.Fatalf("context budget=%d error=%v", cfg.AI.ContextTokens, err)
			}
			if errors.Is(cfg.Validate(), ErrAIContextTokens) != (test.want == 0) {
				t.Fatalf("unexpected budget validation: %v", cfg.Validate())
			}
		})
	}
}

func TestAIContextBudgetLoggingRetainsBudgetAndRedactsKey(t *testing.T) {
	cfg := Default()
	cfg.AI.APIKey = testAIAPIKey
	encoded, err := json.Marshal(cfg.AI)
	if err != nil {
		t.Fatal(err)
	}
	for _, rendering := range []string{cfg.Redacted(), cfg.AI.String(), string(encoded)} {
		if !strings.Contains(rendering, fmt.Sprint(DefaultAIContextTokens)) || strings.Contains(rendering, testAIAPIKey) {
			t.Error("rendering lost context budget or exposed credentials")
		}
	}
}
