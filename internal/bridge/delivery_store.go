package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/hewenyu/herdr-agent/internal/statefile"
)

// DeliveryStore keeps acknowledgements of delivered task results and post
// chunks. Pending sends are never written here. Each update is written through
// atomically; no shutdown flush is required.
// Unlike the 256-record live cache, these small durable receipts are retained
// across task lifetimes so eviction cannot reannounce an old completed result.
type DeliveryStore struct {
	mu       sync.Mutex
	path     string
	receipts map[string]deliveryReceipt
}

type deliveryReceipt struct {
	Complete bool `json:"complete,omitempty"`
	Chunks   int  `json:"chunks,omitempty"`
}

func OpenDeliveryStore(path string) (*DeliveryStore, error) {
	if path == "" {
		return nil, errors.New("bridge: empty delivery store path")
	}
	s := &DeliveryStore{path: path, receipts: make(map[string]deliveryReceipt)}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	var disk struct {
		Version  int                        `json:"version"`
		Receipts map[string]deliveryReceipt `json:"receipts"`
	}
	if err := json.Unmarshal(data, &disk); err != nil {
		return nil, fmt.Errorf("bridge: corrupt delivery store: %w", err)
	}
	if disk.Version != 1 || disk.Receipts == nil {
		return nil, errors.New("bridge: unsupported delivery store")
	}
	for key, receipt := range disk.Receipts {
		if key == "" || receipt.Chunks < 0 || (!receipt.Complete && receipt.Chunks == 0) {
			return nil, errors.New("bridge: invalid delivery acknowledgement")
		}
	}
	s.receipts = disk.Receipts
	return s, nil
}

func (s *DeliveryStore) receipt(key string) deliveryReceipt {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.receipts[key]
}

func (s *DeliveryStore) acknowledge(key string, receipt deliveryReceipt) error {
	return s.acknowledgeAll(map[string]deliveryReceipt{key: receipt})
}

func (s *DeliveryStore) acknowledgeAll(receipts map[string]deliveryReceipt) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, receipt := range receipts {
		old := s.receipts[key]
		receipt.Complete = receipt.Complete || old.Complete
		receipt.Chunks = max(receipt.Chunks, old.Chunks)
		s.receipts[key] = receipt
	}
	// These are confirmed external acknowledgements, even if writing the local
	// checkpoint fails. Retain them in memory to avoid resending in this process;
	// a later acknowledgement retries the durable write and returns its error.
	if s.path == "" {
		return nil
	}
	data, err := json.Marshal(struct {
		Version  int                        `json:"version"`
		Receipts map[string]deliveryReceipt `json:"receipts"`
	}{1, s.receipts})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	_, err = statefile.Write(s.path, data, 0600)
	return err
}
