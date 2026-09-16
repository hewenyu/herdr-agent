package tasktools

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// An intent is durable before any effect. An interrupted call is never replayed:
// the terminal may have received input even if its acknowledgement was lost.
type operation struct {
	Fingerprint string          `json:"fingerprint"`
	Done        bool            `json:"done"`
	Result      json.RawMessage `json:"result,omitempty"`
	Error       string          `json:"error,omitempty"`
}

type journal struct {
	path string
	ops  map[string]operation
}

func openJournal(path string) (*journal, error) {
	if path == "" {
		return nil, errors.New("assistant: operation state path is required")
	}
	j := &journal{path: path, ops: make(map[string]operation)}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return j, nil
	}
	if err != nil {
		return nil, err
	}
	var disk struct {
		Version int                  `json:"version"`
		Ops     map[string]operation `json:"operations"`
	}
	if err := json.Unmarshal(b, &disk); err != nil || disk.Version != 1 || disk.Ops == nil {
		return nil, errors.New("assistant: corrupt or unsupported operation state")
	}
	for key, op := range disk.Ops {
		if key == "" || len(op.Fingerprint) != 64 || (op.Done && len(op.Result) == 0 && op.Error == "") {
			return nil, errors.New("assistant: incomplete operation state")
		}
	}
	j.ops = disk.Ops
	return j, nil
}

// The service's mutation lock covers both this journal and the effect.
func (j *journal) put(key string, op operation) error {
	next := make(map[string]operation, len(j.ops)+1)
	for k, v := range j.ops {
		next[k] = v
	}
	next[key] = op
	b, err := json.Marshal(struct {
		Version int                  `json:"version"`
		Ops     map[string]operation `json:"operations"`
	}{1, next})
	if err != nil {
		return err
	}
	dir := filepath.Dir(j.path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".assistant-operations-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(f.Name(), j.path); err != nil {
		return err
	}
	// Once rename succeeds, fail closed in memory even if directory sync fails.
	j.ops = next
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("assistant: sync operation directory: %w", err)
	}
	return nil
}
