package config

import (
	"errors"
	"net"
	"net/url"
	"strings"
	"time"
)

var (
	ErrAITasks    = errors.New("ai.enabled requires tasks.enabled = true")
	ErrAIProvider = errors.New("ai.provider must be openai-responses or anthropic-messages")
	ErrAIModel    = errors.New("ai.model is required when AI is enabled")
	ErrAIBaseURL  = errors.New("ai.base_url must be an HTTP(S) URL without credentials, query or fragment; HTTP is allowed only on loopback hosts")
	ErrAITimeout  = errors.New("ai.timeout must be positive and no longer than 10m")
	ErrAIAPIKey   = errors.New("HERDR_AGENT_AI_API_KEY is required when AI is enabled")
)

func (c Config) validateAI() error {
	if !c.AI.Enabled {
		return nil
	}
	var errs []error
	if !c.Tasks.Enabled {
		errs = append(errs, ErrAITasks)
	}
	if c.AI.Provider != "openai-responses" && c.AI.Provider != "anthropic-messages" {
		errs = append(errs, ErrAIProvider)
	}
	if strings.TrimSpace(c.AI.Model) == "" {
		errs = append(errs, ErrAIModel)
	}
	u, err := url.Parse(c.AI.BaseURL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || strings.Contains(c.AI.BaseURL, "#") || (u.Scheme != "https" && u.Scheme != "http") {
		errs = append(errs, ErrAIBaseURL)
	} else if u.Scheme == "http" {
		ip := net.ParseIP(u.Hostname())
		if !strings.EqualFold(u.Hostname(), "localhost") && (ip == nil || !ip.IsLoopback()) {
			errs = append(errs, ErrAIBaseURL)
		}
	}
	if c.AI.Timeout <= 0 || c.AI.Timeout > 10*time.Minute {
		errs = append(errs, ErrAITimeout)
	}
	if strings.TrimSpace(c.AI.APIKey) == "" {
		errs = append(errs, ErrAIAPIKey)
	}
	return errors.Join(errs...)
}
