package assistant

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"

	"github.com/hewenyu/herdr-agent/internal/bridge"
)

const (
	deliveryPrepared  = "prepared"
	deliverySending   = "sending"
	deliveryConfirmed = "delivered"
	deliveryUncertain = "uncertain"
	deliveryRetryable = "retryable"
)

func (s *Service) lockConversation(ctx context.Context, owner, chat string) (string, func(), error) {
	if owner == "" || chat == "" {
		return "", nil, errors.New("assistant: missing conversation identity")
	}
	key := digest(owner + "\x00" + chat)
	s.mu.Lock()
	lock, ok := s.turns[key]
	if !ok {
		lock = make(chan struct{}, 1)
		s.turns[key] = lock
	}
	s.mu.Unlock()
	select {
	case lock <- struct{}{}:
		return filepath.Join(s.dir, key+".json"), func() { <-lock }, nil
	case <-ctx.Done():
		return "", nil, ctx.Err()
	}
}

func validReplyDelivery(r turnReceipt) bool {
	switch r.Delivery {
	case "": // Old checkpoints predate delivery tracking; preserve their history.
		return len(r.DeliveryIDs) == 0
	case deliveryPrepared, deliverySending, deliveryRetryable:
		return r.Finished && !r.Failed && len(r.DeliveryIDs) == 0
	case deliveryConfirmed:
		return r.Finished && !r.Failed && len(r.DeliveryIDs) > 0 && !slices.Contains(r.DeliveryIDs, "")
	case deliveryUncertain:
		return r.Finished && !r.Failed
	default:
		return false
	}
}

// BeginReplyDelivery reserves one network attempt before any bytes are sent.
// A saved prepared/retryable answer can resume after restart without calling the
// model or tools again. Sending/uncertain answers cannot be automatically resent.
func (s *Service) BeginReplyDelivery(ctx context.Context, in bridge.AssistantMessage, answer string) (bool, error) {
	path, release, err := s.lockConversation(ctx, in.OwnerID, in.ChatID)
	if err != nil {
		return false, err
	}
	defer release()
	state, err := readSession(path, in.OwnerID, in.ChatID, in.TaskID)
	if err != nil {
		return false, err
	}
	r, ok := state.Receipts[in.MessageID]
	if !ok || !r.Finished || r.Failed || answer == "" || r.Reply != answer {
		return false, errors.New("assistant: reply does not match its durable receipt")
	}
	if r.Delivery != deliveryPrepared && r.Delivery != deliveryRetryable {
		return false, nil
	}
	r.Delivery = deliverySending
	state.Receipts[in.MessageID] = r
	if err := writeSession(path, state); err != nil {
		return false, err
	}
	return true, nil
}

// RecordReplyDelivery only marks a reply visible after the complete logical
// message has acknowledged IDs. Partial/unknown results keep its raw text out
// of model history. Outcome writes can be retried without another network send.
func (s *Service) RecordReplyDelivery(ctx context.Context, in bridge.AssistantMessage, answer string, outcome bridge.AssistantReplyDelivery) error {
	if outcome.Complete && (outcome.Retryable || len(outcome.MessageIDs) == 0 || slices.Contains(outcome.MessageIDs, "")) ||
		outcome.Retryable && len(outcome.MessageIDs) != 0 {
		return errors.New("assistant: invalid reply delivery acknowledgement")
	}
	path, release, err := s.lockConversation(ctx, in.OwnerID, in.ChatID)
	if err != nil {
		return err
	}
	defer release()
	state, err := readSession(path, in.OwnerID, in.ChatID, in.TaskID)
	if err != nil {
		return err
	}
	r, ok := state.Receipts[in.MessageID]
	if !ok || !r.Finished || r.Failed || answer == "" || r.Reply != answer {
		return errors.New("assistant: reply acknowledgement has no matching receipt")
	}
	if r.Delivery == deliveryConfirmed {
		if outcome.Complete && slices.Equal(r.DeliveryIDs, outcome.MessageIDs) {
			return nil
		}
		return errors.New("assistant: confirmed reply cannot be changed")
	}
	if r.Delivery != deliverySending && r.Delivery != deliveryUncertain && r.Delivery != deliveryRetryable {
		return errors.New("assistant: reply delivery was not started")
	}
	if r.Delivery == deliveryUncertain {
		if outcome.Retryable {
			return errors.New("assistant: uncertain delivery cannot become retryable")
		}
		if len(outcome.MessageIDs) < len(r.DeliveryIDs) || !slices.Equal(outcome.MessageIDs[:len(r.DeliveryIDs)], r.DeliveryIDs) {
			return errors.New("assistant: delivery acknowledgement lost confirmed chunks")
		}
	}
	r.DeliveryIDs = append([]string(nil), outcome.MessageIDs...)
	switch {
	case outcome.Complete:
		r.Delivery = deliveryConfirmed
		// The reply may have completed after later user turns or notifications.
		// Remove its pending placeholder and append the actual reply at the
		// point delivery became known. If compaction removed the placeholder,
		// the same append restores the now-visible text after that summary.
		kept := state.Messages[:0]
		for _, message := range state.Messages {
			if message.Role != "assistant" || message.TurnID != in.MessageID {
				kept = append(kept, message)
			}
		}
		state.Messages = append(kept, Message{Role: "assistant", Content: answer, Kind: "dialogue", TurnID: in.MessageID})
	case outcome.Retryable:
		r.Delivery = deliveryRetryable
	default:
		r.Delivery = deliveryUncertain
	}
	state.Receipts[in.MessageID] = r
	return writeSession(path, state)
}

// RecordDeliveredMessage records an independently delivered model notification
// in the same task conversation, so a short user reply has its actual referent.
// Its caller must only invoke this after all message chunks are acknowledged.
func (s *Service) RecordDeliveredMessage(ctx context.Context, in bridge.AssistantMessage) error {
	if in.MessageID == "" || strings.TrimSpace(in.Text) == "" {
		return errors.New("assistant: incomplete delivered message")
	}
	if in.TaskID != "" {
		if _, err := s.backend.ForTask(in.OwnerID, in.ChatID, in.TaskID); err != nil {
			return err
		}
	} else if _, err := s.backend.ForChat(in.OwnerID, in.ChatID); err != nil {
		return err
	}
	path, release, err := s.lockConversation(ctx, in.OwnerID, in.ChatID)
	if err != nil {
		return err
	}
	defer release()
	state, err := readSession(path, in.OwnerID, in.ChatID, in.TaskID)
	if err != nil {
		return err
	}
	if previous, ok := state.Receipts[in.MessageID]; ok {
		if previous.Finished && !previous.Failed && previous.Reply == in.Text && previous.Delivery == deliveryConfirmed {
			return nil
		}
		return errors.New("assistant: delivered message identity already used")
	}
	state.Messages = append(state.Messages, Message{Role: "assistant", Content: in.Text, Kind: "dialogue", TurnID: in.MessageID})
	state.Receipts[in.MessageID] = turnReceipt{Reply: in.Text, Finished: true, Delivery: deliveryConfirmed, DeliveryIDs: []string{in.MessageID}}
	return writeSession(path, state)
}
