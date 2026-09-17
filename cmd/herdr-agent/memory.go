package main

import (
	"fmt"
	"path/filepath"

	"github.com/hewenyu/herdr-agent/internal/assistant"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/memory"
)

func conversationMemoryOptions(stateDir string, cfg config.Memory) (assistant.Option, error) {
	create := func(provider config.MemoryProvider) (memory.Provider, error) {
		switch provider.Provider {
		case "file":
			return memory.NewFile(filepath.Join(stateDir, "memory"))
		case "http":
			return memory.NewHTTP(provider.BaseURL, provider.APIKey, provider.Timeout)
		default:
			return nil, fmt.Errorf("unknown memory provider")
		}
	}
	base, err := create(cfg.ForUser(""))
	if err != nil {
		return nil, err
	}
	users := make(map[string]memory.Provider, len(cfg.Users))
	for owner := range cfg.Users {
		provider, err := create(cfg.ForUser(owner))
		if err != nil {
			return nil, err
		}
		users[owner] = provider
	}
	return assistant.WithMemoryProviders(base, users), nil
}
