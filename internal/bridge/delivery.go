package bridge

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"slices"
	"sync"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/mirror"
)

type deliveredResultRecorder interface {
	RecordDeliveredMessage(context.Context, AssistantMessage) error
}

func (b *bridge) recordDeliveredResult(ctx context.Context, a agents.Agent, text string, id deliveryID, coordinated bool) error {
	recorder, ok := b.assistant.(deliveredResultRecorder)
	if !ok {
		return nil
	}
	r, bound := b.tasks.ByPane(a.PaneID)
	if !bound || !b.tasks.OwnerAllowed(r.OwnerID) || r.ChatID != b.notifyChat(a.PaneID) {
		return nil
	}
	key := "agent-result:" + id.String()
	if !coordinated {
		key = fmt.Sprintf("agent-result:%s:%d", a.PaneID, a.StateSeq)
	}
	return recorder.RecordDeliveredMessage(ctx, AssistantMessage{
		OwnerID: r.OwnerID, ChatID: r.ChatID, TaskID: r.ID, MessageID: key, Text: text,
	})
}

// Parser sequence numbers start at the beginning of each read, so LastTurns
// and the live watcher cannot compare them. A timestamp and the full record
// content identify the same answer across both readers; the transcript path
// keeps resumed/replaced sessions independent.
type deliveryID [sha256.Size]byte

type paneDelivery struct {
	mu      sync.Mutex
	records map[deliveryID]*mirrorStream // nil means successfully delivered
	pending map[deliveryID]*mirrorStream // active stream records cannot be evicted
	order   []deliveryID
	store   *DeliveryStore
}

func (b *bridge) paneDelivery(pane string) *paneDelivery {
	state, _ := b.deliveries.LoadOrStore(pane, &paneDelivery{records: make(map[deliveryID]*mirrorStream), pending: make(map[deliveryID]*mirrorStream), store: b.deliveryStore})
	return state.(*paneDelivery)
}

func (b *bridge) taskDeliveryEnabled(a agents.Agent) bool {
	if b.tasks == nil {
		return false
	}
	r, bound := b.tasks.ByPane(a.PaneID)
	return bound && r.ChatID != "" && r.ChatID == b.notifyChat(a.PaneID)
}

func (b *bridge) deliveryID(a agents.Agent, turn mirror.Turn) (deliveryID, bool) {
	// A task group itself provides reply routing. In general chats the done
	// card is still needed because streamed messages have no routable ID.
	// Without a timestamp repeated words could belong to a new execution.
	path, ok := b.deps.Resolver.Resolve(a)
	if !b.taskDeliveryEnabled(a) || !ok || turn.At.IsZero() {
		return deliveryID{}, false
	}
	data, _ := json.Marshal(struct {
		Path   string
		Kind   string
		ChatID string
		Turn   mirror.Turn
	}{path, a.Kind, b.notifyChat(a.PaneID), mirror.Turn{Role: turn.Role, Text: turn.Text, ToolCalls: turn.ToolCalls, At: turn.At}})
	return sha256.Sum256(data), true
}

func (d *paneDelivery) remember(id deliveryID, stream *mirrorStream) {
	if stream != nil {
		if stream.records == nil {
			stream.records = make(map[deliveryID]struct{})
		}
		stream.records[id] = struct{}{}
		d.pending[id] = stream
	}
	if _, exists := d.records[id]; !exists {
		// Only recent records can race a completion notification. Bound the
		// cache even for sessions that keep running for days.
		const maxRecords = 256
		if len(d.order) == maxRecords {
			delete(d.records, d.order[0])
			d.order = d.order[1:]
		}
		d.order = append(d.order, id)
	}
	d.records[id] = stream
}

func (id deliveryID) String() string { return fmt.Sprintf("%x", id[:]) }

func (d *paneDelivery) lookup(id deliveryID) (*mirrorStream, bool) {
	if d.store.receipt(id.String()).Complete {
		return nil, true
	}
	if stream, ok := d.pending[id]; ok {
		return stream, true
	}
	stream, ok := d.records[id]
	return stream, ok
}

func (d *paneDelivery) confirm(id deliveryID) error {
	d.remember(id, nil)
	return d.store.acknowledge(id.String(), deliveryReceipt{Complete: true})
}

func (d *paneDelivery) finishStream(stream *mirrorStream, delivered bool) error {
	confirmed := make(map[string]deliveryReceipt)
	for id := range stream.records {
		delete(d.pending, id)
		if delivered {
			d.remember(id, nil)
			confirmed[id.String()] = deliveryReceipt{Complete: true}
		} else {
			delete(d.records, id)
			d.order = slices.DeleteFunc(d.order, func(known deliveryID) bool { return known == id })
		}
	}
	clear(stream.records)
	if len(confirmed) != 0 {
		return d.store.acknowledgeAll(confirmed)
	}
	return nil
}
