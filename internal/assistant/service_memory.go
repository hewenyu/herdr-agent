package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/hewenyu/herdr-agent/internal/bridge"
	"github.com/hewenyu/herdr-agent/internal/config"
	localmemory "github.com/hewenyu/herdr-agent/internal/memory"
	"github.com/hewenyu/herdr-agent/internal/statefile"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

type Option func(*Service) error

func WithContextTokens(tokens int) Option {
	return func(s *Service) error {
		if tokens == 0 {
			tokens = config.DefaultAIContextTokens
		}
		if tokens < config.MinAIContextTokens || tokens > config.MaxAIContextTokens {
			return errors.New("assistant: invalid context budget")
		}
		s.contextTokens = tokens
		return nil
	}
}

// WithMemoryProviders chooses storage using the authenticated sender, never a
// model argument. Each entry is a complete provider, with no credential fallback.
func WithMemoryProviders(defaultProvider localmemory.Provider, users map[string]localmemory.Provider) Option {
	return func(s *Service) error {
		if defaultProvider == nil {
			return errors.New("assistant: missing memory provider")
		}
		s.memoryProvider = defaultProvider
		s.memoryUsers = make(map[string]localmemory.Provider, len(users))
		for owner, provider := range users {
			if owner == "" || provider == nil {
				return errors.New("assistant: invalid user memory provider")
			}
			s.memoryUsers[owner] = provider
		}
		return nil
	}
}

var errMemoryProvider = errors.New("记忆服务暂时不可用；对话记录已保留，本轮未执行任务操作。请检查 memory 配置或服务，恢复后重新发送完整要求")

func (s *Service) prepareMemory(ctx context.Context, in bridge.AssistantMessage, prompt string, tools []tasktools.Tool, state *session) error {
	provider := s.memoryProvider
	if override := s.memoryUsers[in.OwnerID]; override != nil {
		provider = override
	}
	scope := localmemory.Scope{OwnerID: in.OwnerID, ChatID: in.ChatID, TaskID: in.TaskID}
	recalled, err := provider.Recall(ctx, scope)
	if err != nil {
		return errMemoryProvider
	}
	previous := state.Memory
	if state.Generation == 0 && previous.Summary == "" && len(state.Messages) == 1 && len(state.Receipts) == 0 && state.Pending == "" {
		previous = recalled
	}
	// The local checkpoint and deduplication receipts are committed together.
	// If a provider write succeeded but the checkpoint write did not, use the
	// checkpoint's summary and complete local history to recover consistently.
	fixedCost := EstimateContextTokens([]Message{{Role: "system", Content: prompt}}, tools)
	summary, recent, err := memoryPrepare(ctx, s.engine, previous.Summary, modelHistory(state.Messages), fixedCost, s.contextTokens)
	if err != nil {
		return err
	}
	entry := localmemory.Entry{Summary: summary}
	if summary != "" {
		entry.Revision = digest(summary)
	}
	cut := len(state.Messages) - len(recent)
	if cut > 0 {
		// Retain the source of a lossy summary for local inspection/recovery.
		// This archive is never injected automatically as current instructions.
		data, err := json.Marshal(struct {
			Scope    localmemory.Scope `json:"scope"`
			Previous localmemory.Entry `json:"previous_memory"`
			Messages []Message         `json:"messages"`
		}{scope, previous, state.Messages[:cut]})
		if err != nil {
			return errMemoryProvider
		}
		directory := filepath.Join(s.dir, "archive", digest(in.OwnerID+"\x00"+in.ChatID+"\x00"+in.TaskID))
		if err := os.MkdirAll(directory, 0700); err != nil {
			return errMemoryProvider
		}
		if _, err := statefile.Write(filepath.Join(directory, digest(string(data))+".json"), data, 0600); err != nil {
			return errMemoryProvider
		}
	}
	if entry != recalled {
		if err := provider.Store(ctx, scope, entry); err != nil {
			return errMemoryProvider
		}
	}
	state.Memory = entry
	// Keep the actual conversation alongside its summary for restart recovery.
	state.Messages = append([]Message(nil), state.Messages[len(state.Messages)-len(recent):]...)
	return nil
}
