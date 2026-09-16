package bridge

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/notify"
	"github.com/hewenyu/herdr-agent/internal/selection"
	"github.com/hewenyu/herdr-agent/internal/tasks"
)

var (
	// ErrMissingDep reports a nil interface in Deps. Every one of them is
	// reachable from an inbound event, so a nil is a panic waiting for the
	// first message rather than a degraded mode.
	ErrMissingDep = errors.New("bridge: missing dependency")

	// ErrEmptyAllowlist refuses to start without an allowlist. Defaulting an
	// empty list to allow-all would hand shell access to anyone who finds the
	// bot: driving an agent is driving a terminal, and the herdr socket has no
	// authentication of its own (G10).
	ErrEmptyAllowlist = errors.New("bridge: no allowed open_ids; default deny")

	// ErrBlankOpenID rejects an empty allowlist entry, which would match an
	// event whose operator open_id is missing and quietly mean allow-anonymous.
	ErrBlankOpenID = errors.New("bridge: blank open_id in allowlist")

	// ErrRunOnce rejects a second Run. The lark Bot is single-use and the
	// notifier keeps per-pane state; two loops would race over both.
	ErrRunOnce = errors.New("bridge: Run may be called only once")

	// ErrNoNotifyTarget is returned by the Push* methods when no chat is
	// configured to receive proactive notifications. It is deliberately not a
	// startup error: config.Validate does not require notify_chat_id, and a
	// bridge that only answers messages is a usable, if reduced, product.
	ErrNoNotifyTarget = errors.New("bridge: no notify chat configured")
)

// bridge is the orchestrator. It owns no state of its own beyond wiring: every
// durable decision lives in the stores, and every agent fact comes from the
// registry.
type bridge struct {
	deps      Deps
	tasks     *tasks.Manager
	assistant Assistant
	log       *slog.Logger

	// notifier turns registry transitions into Push* calls on this same object.
	notifier notify.Notifier

	// sel remembers which agent each chat is talking to, so that plain typing
	// reaches it. Optional: nil means the bridge routes exactly as it did before
	// the selection existed (reply-to, then the single agent). Every read goes
	// through the helpers in selection.go, which are nil-safe.
	sel selection.Store

	// acks remembers which panes have already been told "your typing is getting
	// through", so a run of messages to one agent costs one line instead of one
	// per message. It replaced the per-pane prose queue, which existed only
	// because Say used to refuse a working agent (see deliver and burst.go).
	acks *bursts

	// pickers remembers which message holds each chat's picker card, so a
	// selection change re-renders that card instead of posting another one. A
	// cache in front of selection.Target.CardMessageID, never a source of truth
	// — see pickerIndex.
	pickers *pickerIndex

	// newNonce mints the single-use token a card's buttons carry (G17). A field
	// so tests can make a card's identity predictable.
	newNonce func() (string, error)

	// sleep paces send retries. A field so tests never wait for a real backoff.
	sleep func(context.Context, time.Duration) error

	// newTicker paces the mirror pump's end-of-turn sweep. A field so tests can
	// drive the sweep instead of waiting for one.
	newTicker func(time.Duration) (<-chan time.Time, func())

	started atomic.Bool

	// firstEvent guards the one line that says Feishu is actually delivering.
	// See noteFirstEvent.
	firstEvent atomic.Bool
}

var _ Bridge = (*bridge)(nil)

// New builds a Bridge. See contract.go for the ordering rules it enforces.
//
// Its signature is fixed by the contract, so the optional selection store goes
// through NewWith (options.go). A bridge built here routes as it did before the
// selection existed: reply-to, then the single agent.
func New(d Deps) (Bridge, error) {
	return NewWith(d)
}

// newBridge is New with the concrete type, so package tests can reach the
// seams (logger, clock, nonce, sleep) without exporting knobs nobody else
// needs.
func newBridge(d Deps, opts ...Option) (*bridge, error) {
	if err := validateDeps(d); err != nil {
		return nil, err
	}
	d = withDefaults(d)

	b := &bridge{
		deps:      d,
		log:       slog.Default(),
		newNonce:  randomNonce,
		sleep:     realSleep,
		newTicker: realTicker,
		acks:      newBursts(),
		pickers:   newPickerIndex(),
	}
	// Options before the notifier, so that anything they set is in place by the
	// time a subscription can deliver the first transition.
	for _, opt := range opts {
		opt(b)
	}
	// The notifier calls back into this object as its Sink, which is why it is
	// built here rather than passed in: the two halves are the same component
	// seen from either side.
	notifyOpts := []notify.Option{notify.WithClock(d.Now)}
	if d.TailLines > 0 {
		notifyOpts = append(notifyOpts, notify.WithTailLines(d.TailLines))
	}
	b.notifier = notify.New(d.Registry, d.Extractor, b, notifyOpts...)

	if d.NotifyChatID == "" && b.tasks == nil {
		b.log.Warn("bridge: no notify_chat_id configured; nothing will be pushed to the phone " +
			"when an agent blocks or finishes")
	}
	if b.sel == nil {
		b.log.Warn("bridge: no selection store; plain typing routes only when exactly one agent is " +
			"running, and the picker card cannot remember what a chat selected")
	}
	return b, nil
}

func validateDeps(d Deps) error {
	var errs []error

	for _, dep := range []struct {
		name  string
		isNil bool
	}{
		{"Bot", d.Bot == nil},
		{"Registry", d.Registry == nil},
		{"Controller", d.Controller == nil},
		{"Extractor", d.Extractor == nil},
		{"Resolver", d.Resolver == nil},
		{"Dedup", d.Dedup == nil},
		{"Routes", d.Routes == nil},
		{"Watcher", d.Watcher == nil},
	} {
		if dep.isNil {
			errs = append(errs, fmt.Errorf("%w: Deps.%s", ErrMissingDep, dep.name))
		}
	}

	if len(d.AllowedOpenIDs) == 0 {
		errs = append(errs, fmt.Errorf("%w: list your own open_id in config", ErrEmptyAllowlist))
	}
	for i, id := range d.AllowedOpenIDs {
		if strings.TrimSpace(id) == "" {
			errs = append(errs, fmt.Errorf("%w: entry %d", ErrBlankOpenID, i))
		}
	}

	return errors.Join(errs...)
}

// withDefaults fills the optional Deps fields once, so that every later reader
// of Deps sees the effective value instead of re-deriving it.
func withDefaults(d Deps) Deps {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.QueueLimit <= 0 {
		// Defaulted but unused: nothing in the bridge queues prose any more (see
		// deliver). The field is still filled in so that a caller reading Deps back
		// sees the effective value of every knob it set, rather than a zero that
		// looks like a wiring mistake — cmd passes ui.queue_limit through, and that
		// config key outlives this wave.
		d.QueueLimit = DefaultQueueLimit
	}
	if d.TailLines < 0 {
		d.TailLines = 0
	}
	if d.MaxCols < 0 {
		d.MaxCols = 0
	}
	// AllowedOpenIDs is copied: Deps is a value, but the slice it carries is
	// not, and the allowlist is the security boundary of the product. A caller
	// that reuses its slice must not be able to widen it after New returned.
	d.AllowedOpenIDs = append([]string(nil), d.AllowedOpenIDs...)
	for i, id := range d.AllowedOpenIDs {
		// Trimming the CONFIGURED value forgives a stray space in config.toml.
		// The incoming open_id is never trimmed: normalising that side could
		// only widen what matches, and validateDeps has already refused an
		// entry that is nothing but whitespace.
		d.AllowedOpenIDs[i] = strings.TrimSpace(id)
	}
	return d
}

func (b *bridge) now() time.Time { return b.deps.Now() }

// Run installs the handlers, starts the notifier, and blocks until ctx is
// cancelled or the Feishu connection dies for good.
//
// Handler registration happens before Bot.Start and on this goroutine, because
// the lark contract requires it: a message that arrives before OnMessage is set
// is dropped, and the WebSocket delivers the backlog immediately on connect.
// That ordering is why Run owns Bot.Start rather than leaving it to the caller.
func (b *bridge) Run(ctx context.Context) error {
	if !b.started.CompareAndSwap(false, true) {
		return ErrRunOnce
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	b.deps.Bot.SetLifecycle(b.lifecycle())
	b.installHandlers()
	if b.tasks != nil {
		if src, ok := b.deps.Bot.(tasks.EventSource); ok {
			src.OnTaskEvent(b.tasks.Event)
		}
	}

	var (
		wg        sync.WaitGroup
		notifyErr error
	)
	if b.tasks != nil {
		wg.Add(1)
		go func() { defer wg.Done(); _ = b.tasks.Run(ctx) }()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		// Started immediately, not on OnReady. The registry announces every
		// agent it sees for the first time, so a subscription taken a few
		// seconds late would miss an agent that was ALREADY blocked when the
		// bridge started — and a pane sitting at a dialog produces no further
		// transition to catch up on. A push that lands before the socket is up
		// fails as ErrNotConnected, which send() treats as retryable.
		err := b.notifier.Run(ctx)
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			notifyErr = err
			b.log.Error("bridge: notifier stopped; nothing will be pushed to the phone", "err", err)
			// A bridge that cannot notify is half a product, and the half that
			// is left cannot tell the user it is missing. Bring the whole thing
			// down so the supervisor restarts it.
			cancel()
		}
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		// The mirror is the cosmetic half of the product and must never take
		// the interactive half down with it (S2 §8), so unlike the notifier
		// this one reports nothing back: pumpMirror logs its failures and keeps
		// reading. It returns when ctx ends or the watcher stops.
		//
		// The Watcher's own Run belongs to whoever built it, exactly as the
		// Registry's does; this consumes what it publishes.
		b.pumpMirror(ctx)
	}()

	// There is no third goroutine any more. The bridge used to take its own
	// registry subscription to drain prose it had parked for a working agent; a
	// working agent takes prose directly (G19/M1), so nothing is parked and there
	// is nothing to wake up for. The notifier remains the only subscriber, and
	// what it pushes on `done` / `blocked` is the reply to whatever the user typed
	// (see reportDelivery).
	startErr := b.deps.Bot.Start(ctx)
	cancel()
	wg.Wait()

	switch {
	case notifyErr != nil:
		return notifyErr
	case startErr == nil:
		return nil
	case errors.Is(startErr, context.Canceled), errors.Is(startErr, context.DeadlineExceeded):
		return startErr
	default:
		return fmt.Errorf("bridge: feishu channel stopped: %w", startErr)
	}
}

// installHandlers wires both inbound entry points through the same guard, so
// neither can be written in a way that forgets to authorize or to deduplicate.
func (b *bridge) installHandlers() {
	b.deps.Bot.OnMessage(func(ctx context.Context, m lark.Msg) error {
		b.noteFirstEvent("message")
		err := b.guard(ctx, messageEvent(m), func(ctx context.Context) error {
			if handled, err := b.assistantMessage(ctx, m); handled {
				return err
			}
			if handled, err := b.taskMessage(ctx, m); handled {
				return err
			}
			return b.handleMessage(ctx, m)
		})
		return silenceUnauthorized(err)
	})

	b.deps.Bot.OnCardAction(func(ctx context.Context, a lark.Action) error {
		b.noteFirstEvent("card action")
		err := b.guard(ctx, actionEvent(a), func(ctx context.Context) error {
			if b.tasks != nil {
				if r, ok := b.tasks.ByChat(a.ChatID); ok {
					if r.OwnerID != a.Operator || r.Status == tasks.Destroyed || r.Status == tasks.Destroying || r.Status == tasks.Completed {
						return ErrUnauthorized
					}
					if pane, _ := a.Value["pane"].(string); pane != r.PaneID {
						return ErrUnauthorized
					}
				}
			}
			return b.handleCardAction(ctx, a)
		})
		return silenceUnauthorized(err)
	})
}

// noteFirstEvent logs exactly once that Feishu is delivering events to this
// process. It is the line OnReady is careful not to be.
//
// Once, because it answers a question that is only asked at startup — "is this
// thing actually receiving?" — and a line per event would be a log of the user's
// entire conversation.
//
// Before the guard on purpose: the fact being reported is that the subscription,
// the delivery mode and the published version work, and an event from a stranger
// proves that exactly as well as one from the owner. Firing it only for
// authorized events would stay silent in the one case where the allowlist is
// what is misconfigured — which is the case that looks identical to a dead
// subscription from the outside.
func (b *bridge) noteFirstEvent(kind string) {
	if !b.firstEvent.CompareAndSwap(false, true) {
		return
	}
	b.log.Info("bridge: first feishu event delivered; the event subscription, the delivery mode and a "+
		"published version are now all confirmed working", "kind", kind)
}

// silenceUnauthorized keeps a rejected sender from being reported as a handler
// failure. A card action that returns an error is left unacknowledged and
// Feishu redelivers it (measured; see lark.handleCardAction), so returning one
// here would ask Feishu to keep re-sending an event we will keep refusing.
func silenceUnauthorized(err error) error {
	if errors.Is(err, ErrUnauthorized) {
		return nil
	}
	return err
}

// lifecycle logs the connection's own story: dial failures, reconnect churn, and
// the one line that means events are actually arriving.
//
// What it cannot report is whether this process is alone on its app_id. Long
// connections are a cluster — up to 50 per app, each event dealt to a randomly
// chosen one (G15) — so a second instance produces no error, no disconnect and
// no reconnect here: both bridges log a perfectly healthy connection while each
// sees about half the events. No amount of lifecycle logging can surface that,
// which is why AcquireInstanceLock runs before any of it.
func (b *bridge) lifecycle() lark.Lifecycle {
	return lark.Lifecycle{
		// Deliberately NOT "connected", full stop. A socket that comes up proves
		// the credentials and nothing else: if the app has no event subscribed,
		// is not on long-connection delivery, or has no published version, this
		// line still appears and then nothing ever arrives. That silence is the
		// single most expensive failure mode in this product, and an operator
		// reading "feishu connected" concludes the bridge works. The line that
		// means it works is the one noteFirstEvent writes.
		OnReady: func() {
			b.log.Info("bridge: feishu long connection up. This proves the credentials only, NOT that " +
				"events will arrive; wait for the first delivered event below")
		},
		OnError:        func(err error) { b.log.Error("bridge: feishu error", "err", err) },
		OnReconnecting: func() { b.log.Warn("bridge: feishu reconnecting") },
		OnReconnected:  func() { b.log.Info("bridge: feishu reconnected") },
		OnDisconnected: func() { b.log.Warn("bridge: feishu disconnected") },
	}
}

// realTicker is the production pacing for the mirror pump's sweep.
func realTicker(d time.Duration) (<-chan time.Time, func()) {
	t := time.NewTicker(d)
	return t.C, t.Stop
}

// realSleep waits, or gives up early when the context is done.
func realSleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
