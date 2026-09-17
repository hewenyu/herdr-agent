package bridge

import (
	"crypto/sha256"
	"encoding/json"
	"slices"
	"sync"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/mirror"
)

// Parser sequence numbers start at the beginning of each read, so LastTurns
// and the live watcher cannot compare them. A timestamp and the full record
// content identify the same answer across both readers; the transcript path
// keeps resumed/replaced sessions independent.
type deliveryID [sha256.Size]byte

type paneDelivery struct {
	mu      sync.Mutex
	records map[deliveryID]*mirrorStream // nil means successfully delivered
	order   []deliveryID
}

func (b *bridge) paneDelivery(pane string) *paneDelivery {
	state, _ := b.deliveries.LoadOrStore(pane, &paneDelivery{records: make(map[deliveryID]*mirrorStream)})
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

func (d *paneDelivery) finishStream(stream *mirrorStream, delivered bool) {
	for id, pending := range d.records {
		if pending != stream {
			continue
		}
		if delivered {
			d.records[id] = nil
		} else {
			delete(d.records, id)
			d.order = slices.DeleteFunc(d.order, func(known deliveryID) bool { return known == id })
		}
	}
}
