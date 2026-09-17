package config

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
)

func (m Memory) secrets() []string {
	secrets := []string{m.APIKey}
	for _, provider := range m.Users {
		secrets = append(secrets, provider.APIKey)
	}
	return secrets
}

func (m Memory) scrub(s string) string { return scrubSecrets(s, m.secrets()) }

func memoryKey(key string) string {
	if key == "" {
		return ""
	}
	return RedactedSecret
}

func (p MemoryProvider) scrubFields(scrubValue func(string) string) MemoryProvider {
	p.Provider = scrubValue(p.Provider)
	p.BaseURL = scrubValue(p.BaseURL)
	p.APIKey = memoryKey(p.APIKey)
	return p
}

func (m Memory) scrubFields(scrubValue func(string) string) Memory {
	m.Provider = scrubValue(m.Provider)
	m.BaseURL = scrubValue(m.BaseURL)
	m.APIKey = memoryKey(m.APIKey)
	if m.Users != nil {
		users := make(map[string]MemoryProvider, len(m.Users))
		for owner, provider := range m.Users {
			users[scrubValue(owner)] = provider.scrubFields(scrubValue)
		}
		m.Users = users
	}
	return m
}

func (p MemoryProvider) String() string {
	p = p.scrubFields(func(value string) string { return scrub(value, p.APIKey) })
	return fmt.Sprintf("provider=%s base_url=%s api_key=%s timeout=%s",
		orDefault(p.Provider, unsetValue), orDefault(p.BaseURL, unsetValue), orDefault(p.APIKey, unsetValue), p.Timeout)
}

func (m Memory) String() string {
	m = m.scrubFields(m.scrub)
	p := MemoryProvider{Provider: m.Provider, BaseURL: m.BaseURL, APIKey: m.APIKey, Timeout: m.Timeout}
	var b strings.Builder
	b.WriteString("memory={")
	b.WriteString(p.String())
	b.WriteByte('}')
	owners := make([]string, 0, len(m.Users))
	for owner := range m.Users {
		owners = append(owners, owner)
	}
	sort.Strings(owners)
	for _, owner := range owners {
		b.WriteString(" memory.users.")
		b.WriteString(strconv.Quote(owner))
		b.WriteString("={")
		b.WriteString(m.Users[owner].String())
		b.WriteByte('}')
	}
	return b.String()
}

type memoryProviderJSON struct {
	Provider string `json:"provider"`
	BaseURL  string `json:"base_url"`
	APIKey   string `json:"api_key"`
	Timeout  string `json:"timeout"`
}

func (p MemoryProvider) MarshalJSON() ([]byte, error) {
	p = p.scrubFields(func(value string) string { return scrub(value, p.APIKey) })
	return json.Marshal(memoryProviderJSON{p.Provider, p.BaseURL, p.APIKey, p.Timeout.String()})
}

func (m Memory) MarshalJSON() ([]byte, error) {
	m = m.scrubFields(m.scrub)
	return json.Marshal(struct {
		memoryProviderJSON
		Users map[string]MemoryProvider `json:"users,omitempty"`
	}{memoryProviderJSON{m.Provider, m.BaseURL, m.APIKey, m.Timeout.String()}, m.Users})
}

func (p MemoryProvider) LogValue() slog.Value { return slog.StringValue(p.String()) }
func (m Memory) LogValue() slog.Value         { return slog.StringValue(m.String()) }
