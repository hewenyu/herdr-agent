package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strings"
	"time"
)

var (
	ErrMemoryProvider = errors.New("memory provider must be file or http")
	ErrMemoryBaseURL  = errors.New("memory base_url must be an HTTP(S) URL without credentials, query or fragment; HTTP is allowed only on loopback hosts")
	ErrMemoryAPIKey   = errors.New("memory api_key is required for a remote HTTP provider")
	ErrMemoryTimeout  = errors.New("memory timeout must be positive and no longer than 2m")
	ErrMemoryUser     = errors.New("memory.users keys must be nonempty user identifiers without surrounding whitespace")
)

// ForUser selects the complete per-user override, otherwise the global store.
// In particular, a user's file provider never inherits global HTTP credentials.
func (m Memory) ForUser(openID string) MemoryProvider {
	if provider, ok := m.Users[openID]; ok {
		return provider
	}
	return MemoryProvider{Provider: m.Provider, BaseURL: m.BaseURL, APIKey: m.APIKey, Timeout: m.Timeout}
}

func (c Config) validateMemory() error {
	var errs []error
	if err := validateMemoryProvider(MemoryProvider{Provider: c.Memory.Provider, BaseURL: c.Memory.BaseURL, APIKey: c.Memory.APIKey, Timeout: c.Memory.Timeout}); err != nil {
		errs = append(errs, fmt.Errorf("memory: %w", err))
	}
	owners := make([]string, 0, len(c.Memory.Users))
	for owner := range c.Memory.Users {
		owners = append(owners, owner)
	}
	sort.Strings(owners)
	for _, owner := range owners {
		if strings.TrimSpace(owner) == "" || strings.TrimSpace(owner) != owner {
			errs = append(errs, ErrMemoryUser)
		}
		if err := validateMemoryProvider(c.Memory.Users[owner]); err != nil {
			errs = append(errs, fmt.Errorf("memory.users.%q: %w", c.scrub(owner), err))
		}
	}
	return errors.Join(errs...)
}

func validateMemoryProvider(provider MemoryProvider) error {
	if provider.Provider == "file" {
		return nil
	}
	if provider.Provider != "http" {
		return ErrMemoryProvider
	}
	var errs []error
	u, err := url.Parse(provider.BaseURL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || strings.Contains(provider.BaseURL, "#") || (u.Scheme != "https" && u.Scheme != "http") {
		errs = append(errs, ErrMemoryBaseURL)
	} else {
		ip := net.ParseIP(u.Hostname())
		loopback := strings.EqualFold(u.Hostname(), "localhost") || (ip != nil && ip.IsLoopback())
		if u.Scheme == "http" && !loopback {
			errs = append(errs, ErrMemoryBaseURL)
		}
		if !loopback && strings.TrimSpace(provider.APIKey) == "" {
			errs = append(errs, ErrMemoryAPIKey)
		}
	}
	if provider.Timeout <= 0 || provider.Timeout > 2*time.Minute {
		errs = append(errs, ErrMemoryTimeout)
	}
	return errors.Join(errs...)
}
