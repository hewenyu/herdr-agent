package memory

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/hewenyu/herdr-agent/internal/statefile"
)

type fileProvider struct{ directory string }

type fileEntry struct {
	Version int    `json:"version"`
	Scope   Scope  `json:"scope"`
	Entry   *Entry `json:"entry"`
}

// NewFile stores summaries in directory. The application normally passes
// <stateDir>/memory. Existing directory permissions are tightened to 0700.
func NewFile(directory string) (Provider, error) {
	if directory == "" {
		return nil, errConfiguration
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, errConfiguration
	}
	if err := os.Chmod(directory, 0700); err != nil {
		return nil, errConfiguration
	}
	return &fileProvider{directory: directory}, nil
}

func (p *fileProvider) path(scope Scope) string {
	data, _ := json.Marshal(scope)
	hash := sha256.Sum256(data)
	return filepath.Join(p.directory, hex.EncodeToString(hash[:])+".json")
}

func (p *fileProvider) Recall(ctx context.Context, scope Scope) (Entry, error) {
	if err := ctx.Err(); err != nil {
		return Entry{}, err
	}
	if !validScope(scope) {
		return Entry{}, errScope
	}
	f, err := os.Open(p.path(scope))
	if errors.Is(err, os.ErrNotExist) {
		return Entry{}, nil
	}
	if err != nil {
		return Entry{}, errRead
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxResponseBytes+1))
	if err != nil || len(data) > maxResponseBytes {
		return Entry{}, errRead
	}
	if err := ctx.Err(); err != nil {
		return Entry{}, err
	}
	var stored fileEntry
	if err := json.Unmarshal(data, &stored); err != nil || stored.Version != 1 || stored.Scope != scope || stored.Entry == nil || !validEntry(*stored.Entry) {
		return Entry{}, errRead
	}
	return *stored.Entry, nil
}

func (p *fileProvider) Store(ctx context.Context, scope Scope, entry Entry) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !validScope(scope) {
		return errScope
	}
	if !validEntry(entry) {
		return errEntry
	}
	data, err := json.Marshal(fileEntry{Version: 1, Scope: scope, Entry: &entry})
	if err != nil || len(data) > maxResponseBytes {
		return errWrite
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := statefile.Write(p.path(scope), data, 0600); err != nil {
		return errWrite
	}
	return nil
}

func (p *fileProvider) Forget(ctx context.Context, scope Scope) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !validScope(scope) {
		return errScope
	}
	if err := os.Remove(p.path(scope)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errForget
	}
	return nil
}
