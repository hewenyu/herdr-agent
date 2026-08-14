package lark

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
)

// streamAdapter narrows the SDK's StreamController to our Stream: append,
// flush, close. The controller's UpdateCard is deliberately not exposed —
// disarming a card goes through Bot.UpdateCard, which works from a card
// callback, where no controller exists (S2 §3.6).
type streamAdapter struct {
	sc types.StreamController

	mu     sync.Mutex
	closed bool
	// closeErr is the raw error from the one sc.Close that ran, nil if it
	// succeeded. It is what makes a failed Close survive being called twice.
	closeErr error
}

var _ Stream = (*streamAdapter)(nil)

func (s *streamAdapter) Append(ctx context.Context, chunk string) error {
	if err := s.alive(); err != nil {
		return err
	}
	if err := s.sc.Append(ctx, chunk); err != nil {
		return newFailure("stream append", err)
	}
	return nil
}

func (s *streamAdapter) Flush(ctx context.Context) error {
	if err := s.alive(); err != nil {
		return err
	}
	if err := s.sc.Flush(ctx); err != nil {
		return newFailure("stream flush", err)
	}
	return nil
}

// Close is idempotent, so the mirror can both defer it and call it at the end
// of a turn without the second call being reported as a failure.
//
// Idempotent must not mean "the second call always succeeds". A stream's Close
// is what flushes the controller's last buffered text, so a Close that failed
// means the tail of an agent turn never reached the user (S2 §3.9). If the
// first call returned the error and every later one returned nil, the caller
// that closes twice — which the mirror does by design — would see success and
// report nothing (S2 §3.8: 全部失败时不要静默). The outcome is recorded, so
// every call reports the same thing.
//
// The lock is held across sc.Close so two concurrent Closes cannot both reach
// the controller; Append and Flush block for the duration, which is correct —
// there is nothing sensible for them to do mid-close.
func (s *streamAdapter) Close(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.closed {
		s.closeErr = s.sc.Close(ctx)
		s.closed = true
	}
	if s.closeErr != nil {
		return newFailure("stream close", s.closeErr)
	}
	return nil
}

// alive rejects use after close. When the close itself failed it reports that
// instead of a bare "closed": the real reason is the actionable one.
func (s *streamAdapter) alive() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		return nil
	}
	if s.closeErr != nil {
		return fmt.Errorf("lark: stream is closed; its close failed: %w", s.closeErr)
	}
	return errors.New("lark: stream is closed")
}
