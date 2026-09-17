package lark

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/hewenyu/herdr-agent/internal/tasks"

	lark "github.com/larksuite/oapi-sdk-go/v3"
	"github.com/larksuite/oapi-sdk-go/v3/channel"
	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	larkws "github.com/larksuite/oapi-sdk-go/v3/ws"
)

// New builds a Bot on a Feishu long connection. It performs no I/O; nothing
// touches the network until Start.
//
// The construction order below is load-bearing — see the comment on the
// dispatcher (G13).
func New(appID, appSecret string, opts ...Option) (Bot, error) {
	if appID == "" {
		return nil, errors.New("lark: app id is empty")
	}
	if appSecret == "" {
		// Never echo the value, not even a prefix (S2 §3.1).
		return nil, errors.New("lark: app secret is empty")
	}

	var s settings
	for _, o := range opts {
		if o != nil {
			o(&s)
		}
	}

	// G13: WithEventHandler is NOT optional. ws.Client.handleDataFrame calls
	// c.eventHandler.Do() unconditionally, so a nil dispatcher panics on every
	// single inbound event; and channelImpl.ensureMessageHandler, finding
	// EventHandler() nil, skips registration while setting its "registered"
	// flag, so it never retries even once a dispatcher appears. The official
	// doc/channel.zh.md minimal example omits this line and is broken.
	// Measured consequence: the panicking event was redelivered by Feishu five
	// minutes later and acted on twice (G14).
	evt := dispatcher.NewEventDispatcher("", "")

	wsOpts := []larkws.ClientOption{
		larkws.WithEventHandler(evt),
		larkws.WithLogLevel(s.logLevel.sdk()),
	}
	ws := larkws.NewClient(appID, appSecret, wsOpts...)

	apiOpts := []lark.ClientOptionFunc{lark.WithLogLevel(s.logLevel.sdk())}
	if s.http != nil {
		apiOpts = append(apiOpts, lark.WithHttpClient(s.http))
	}
	api := lark.NewClient(appID, appSecret, apiOpts...)

	chOpts := []types.ChannelOption{
		types.WithSafetyConfig(singleMessageDispatch()),
		types.WithOutboundConfig(oneMessagePerSend()),
	}
	if s.taskChats {
		policy := types.DefaultChannelConfig().Policy
		requireMention := false
		policy.RequireMention = &requireMention
		chOpts = append(chOpts, types.WithPolicyConfig(policy))
	}
	ch := channel.NewChannel(api, ws, chOpts...)

	b := &bot{
		ws:        ws,
		api:       api,
		ch:        ch,
		appID:     appID,
		botOpenID: s.botOpenID,
		log:       s.log,
	}
	b.wire()
	evt.OnP2TaskUpdateUserAccessV2(b.handleTaskEvent)
	evt.OnP2ChatMemberBotDeletedV1(b.handleBotRemoved)
	return b, nil
}

// Feishu emits this event when the bot leaves a group, including task groups
// closed by this application. Acknowledge it without treating removal as user
// acceptance or replaying task cleanup; those have their own durable workflow.
func (b *bot) handleBotRemoved(ctx context.Context, event *larkim.P2ChatMemberBotDeletedV1) error {
	if event != nil && event.Event != nil && event.Event.ChatId != nil {
		b.logger().InfoContext(ctx, "lark: bot removed from chat", "chat_id", *event.Event.ChatId)
	}
	return nil
}

type connState int

const (
	stateNew connState = iota
	stateRunning
	stateStopped
)

type bot struct {
	ws  *larkws.Client
	api *lark.Client
	ch  types.Channel

	// appID is kept for one purpose: a failed call can print the console URL
	// for THIS app (see Failure.Advice). It is the id, never the secret.
	appID string

	log *slog.Logger

	mu        sync.RWMutex
	state     connState
	botOpenID string
	onMessage func(context.Context, Msg) error
	onAction  func(context.Context, Action) error
	onTask    func(context.Context, tasks.TaskEvent) error
	life      Lifecycle
}

var _ Bot = (*bot)(nil)

// logger is read-only after New, so it needs no lock.
func (b *bot) logger() *slog.Logger {
	if b.log != nil {
		return b.log
	}
	return slog.Default()
}

// wire registers with the SDK exactly once per hook.
//
// It has to be once: dispatcher.OnP2MessageReceiveV1 and OnP2CardActionTrigger
// PANIC on a second registration for the same event type, and channelImpl
// re-registers on every OnCardAction call. So the SDK-facing closures are
// installed here, at construction, and the Bot's own OnMessage/OnCardAction
// just swap the function they forward to. That also removes any ordering trap
// for the caller: registration cannot be "too late" to reach the dispatcher.
func (b *bot) wire() {
	b.ch.OnMessage(b.handleMessage)
	b.ch.OnCardAction(b.handleCardAction)

	b.ch.OnReady(func() {
		if h := b.lifecycle().OnReady; h != nil {
			h()
		}
	})
	b.ch.OnError(func(err error) {
		if h := b.lifecycle().OnError; h != nil {
			h(err)
		}
	})
	b.ch.OnReconnecting(func() {
		if h := b.lifecycle().OnReconnecting; h != nil {
			h()
		}
	})
	b.ch.OnReconnected(func() {
		if h := b.lifecycle().OnReconnected; h != nil {
			h()
		}
	})
	b.ch.OnDisconnected(func() {
		if h := b.lifecycle().OnDisconnected; h != nil {
			h()
		}
	})

	// OnReject completes the set S2 §3.2 lists. The SDK's policy gate drops a
	// message before our OnMessage ever sees it, and without this hook it
	// leaves no trace at all — the same silent-failure shape the spec keeps
	// warning about. Ids and the gate's reason only: the rejected body is
	// never logged.
	b.ch.OnReject(func(ctx context.Context, e *types.RejectEvent) error {
		if e == nil {
			return nil
		}
		b.logger().WarnContext(ctx, "lark: message rejected by the SDK policy gate",
			"reason", e.Reason,
			"chat_id", e.ChatID,
			"sender_id", e.SenderID,
			"message_id", e.MessageID,
		)
		return nil
	})
}

func (b *bot) lifecycle() Lifecycle {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.life
}

// OnMessage installs the inbound message handler.
//
// The error it returns does NOT cause Feishu to redeliver the event — the SDK
// discards it and the frame is acknowledged before the handler even starts.
// Failures are reported through Lifecycle.OnError instead. See handleMessage
// for the measurement; this note belongs on Bot.OnMessage in contract.go, but
// that file is frozen.
func (b *bot) OnMessage(h func(ctx context.Context, m Msg) error) {
	b.mu.Lock()
	b.onMessage = h
	b.mu.Unlock()
}

func (b *bot) OnCardAction(h func(ctx context.Context, a Action) error) {
	b.mu.Lock()
	b.onAction = h
	b.mu.Unlock()
}

func (b *bot) SetLifecycle(l Lifecycle) {
	b.mu.Lock()
	b.life = l
	b.mu.Unlock()
}

// handleMessage is what the dispatcher ends up calling for
// im.message.receive_v1.
//
// MESSAGE AND CARD ERRORS ARE NOT SYMMETRIC. It is tempting to assume that
// returning an error here leaves the event unacknowledged and lets Feishu
// redeliver it (G14), which would be the right outcome for something we
// genuinely failed to handle. Measured against v3.9.10, that is false:
//
//   - channelImpl's message closure calls `h(ctx, batch.Message)` and discards
//     the result, then returns nil unconditionally (channel.go:436-461);
//   - the call happens on a pipeline worker goroutine via
//     `cp.tasks <- func() { _ = handler(ctx, dispatch) }`
//     (pipeline/chat_pipeline.go:169-171), so ws.handleDataFrame has already
//     replied 200 before this function even starts.
//
// Probed on the real dispatcher: EventHandler().Do returned nil in ~0.8ms
// while the handler was still running. Card actions ARE propagated — they go
// through pipelineManager.Run, whose error reaches Do — which is why
// TestCardActionHandlerErrorPropagates passes and its message twin cannot.
//
// So a failed message is dropped with no retry, and S2 §3.3's "handler 返回
// error 时不写入 dedup，让飞书重投" is a no-op for this path. The error is
// still returned (it costs nothing and keeps the two handlers uniform), but
// the signal that actually reaches anyone is the Lifecycle.OnError call below:
// that is what lets the caller tell the user "你的指令没能执行" per S2 §3.8
// rather than leaving them waiting for a reply that will never come.
func (b *bot) handleMessage(ctx context.Context, n *types.NormalizedMessage) error {
	if n == nil {
		return nil
	}
	b.mu.RLock()
	h := b.onMessage
	b.mu.RUnlock()
	if h == nil {
		return nil
	}

	m := toMsg(n)

	// Self-echo: the bridge's own messages come back as events. Dropping them
	// here matters because a mirrored agent turn contains whatever the agent
	// said, and feeding that back into the router would be a loop that types
	// into a live pane.
	if id := b.BotOpenID(ctx); id != "" && m.UserID == id {
		return nil
	}

	if err := h(ctx, m); err != nil {
		err = fmt.Errorf("lark: message handler: %w", err)
		// The SDK will not act on this, so raise it ourselves. Ids only: the
		// message body may be anything the user typed.
		b.logger().ErrorContext(ctx, "lark: message handler failed; the event will NOT be redelivered",
			"event_id", m.EventID,
			"message_id", m.MessageID,
			"chat_id", m.ChatID,
			"err", err,
		)
		if oe := b.lifecycle().OnError; oe != nil {
			oe(err)
		}
		return err
	}
	return nil
}

// handleCardAction is what the dispatcher ends up calling for
// card.action.trigger. Unlike handleMessage, the error returned here DOES
// reach ws.handleDataFrame (via pipelineManager.Run), so a failed button press
// is left unacknowledged and Feishu redelivers it — which is what we want.
//
// No self-echo filter: a bot cannot press a button.
// Authorization on Operator is the caller's job (S2 §3.4) and deliberately not
// hidden in here.
func (b *bot) handleCardAction(ctx context.Context, e *types.CardActionEvent) error {
	if e == nil {
		return nil
	}
	b.mu.RLock()
	h := b.onAction
	b.mu.RUnlock()
	if h == nil {
		return nil
	}
	if err := h(ctx, toAction(e)); err != nil {
		return fmt.Errorf("lark: card action handler: %w", err)
	}
	return nil
}

// Start connects and blocks. It returns ctx.Err() when the context is
// cancelled, or a wrapped SDK error if the connection could not be
// established and could not be recovered by the SDK's own reconnect loop.
//
// Always ch.Start, never ws.Start directly: ch.Start is what installs the
// lifecycle callbacks on the ws client and resolves the bot identity on ready.
//
// A Bot is single-use. ws.Client.Start ends in `select {}` and never returns,
// so the goroutine below is parked forever once connected; Stop closes the
// socket but cannot unpark it. Restarting would leak a second one and
// re-enter channelImpl.Start, so a stopped Bot is refused rather than quietly
// half-working.
func (b *bot) Start(ctx context.Context) error {
	b.mu.Lock()
	switch b.state {
	case stateRunning:
		b.mu.Unlock()
		return errors.New("lark: bot already started")
	case stateStopped:
		b.mu.Unlock()
		return errors.New("lark: bot already stopped; build a new one")
	}
	b.state = stateRunning
	b.mu.Unlock()

	errCh := make(chan error, 1)
	go func() { errCh <- b.ch.Start(ctx) }()

	select {
	case <-ctx.Done():
		// Best effort: close the socket so this process leaves the app's
		// connection pool before it exits or retries. Feishu deals each event to
		// a randomly chosen open connection (G15), so a socket nobody reads any
		// more is not merely idle — it keeps being handed a share of the user's
		// events, and that share is lost.
		_ = b.Stop(context.WithoutCancel(ctx))
		return ctx.Err()
	case err := <-errCh:
		b.setState(stateStopped)
		if err != nil {
			return fmt.Errorf("lark: websocket channel stopped: %w", err)
		}
		return nil
	}
}

func (b *bot) Stop(ctx context.Context) error {
	b.mu.Lock()
	if b.state == stateStopped {
		b.mu.Unlock()
		return nil
	}
	b.state = stateStopped
	b.mu.Unlock()

	if err := b.ch.Stop(ctx); err != nil {
		return fmt.Errorf("lark: stop channel: %w", err)
	}
	return nil
}

func (b *bot) setState(s connState) {
	b.mu.Lock()
	b.state = s
	b.mu.Unlock()
}

func (b *bot) requireConnected() error {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.state != stateRunning {
		return ErrNotConnected
	}
	return nil
}

// Send posts one Out as exactly one Feishu message and returns its id.
//
// "Exactly one" is a contract, not an implementation detail: the returned id
// is what the caller binds in routes.json, and reply-to is the bridge's
// primary routing mechanism (S2 §3.5 path 2). A user replies to the bubble
// they can see — the LAST one — so if an Out became three bubbles and only the
// first were bound, replying would miss the route and fall through to
// bare-text routing, aimed at whichever agent the fallback picks.
//
// Two things keep that from happening. New raises the SDK's TextChunkLimit to
// Feishu's real 8000-character ceiling (see oneMessagePerSend), so the ~4000
// chunks internal/outbound produces pass through whole. And if the SDK splits
// anyway — an Out longer than the ceiling, i.e. a caller that skipped the
// splitter — the ErrSplit check below refuses to let it pass silently.
func (b *bot) Send(ctx context.Context, o Out) (string, error) {
	if err := b.requireConnected(); err != nil {
		return "", err
	}
	in, err := toSendInput(o)
	if err != nil {
		return "", err
	}

	res, err := b.ch.Send(ctx, in)
	if err != nil {
		return "", newFailure("send", b.appID, err)
	}
	if res == nil {
		return "", errors.New("lark: send returned no result")
	}
	if res.Error != nil {
		return res.MessageID, newFailure("send", b.appID, res.Error)
	}
	if len(res.ChunkIDs) > 1 {
		// The message went out; what is broken is the binding. Return the
		// first id anyway so the caller can still disarm or update something,
		// but make it impossible to mistake this for a clean send.
		return res.MessageID, fmt.Errorf("%w: feishu created %d messages, only %s can be bound for reply-routing",
			ErrSplit, len(res.ChunkIDs), res.MessageID)
	}
	return res.MessageID, nil
}

// ErrSplit reports that one Out became several Feishu messages, so the
// returned id no longer identifies the whole thing. Callers must treat the
// route binding as unreliable; see Send.
var ErrSplit = errors.New("lark: outbound message was split across several feishu messages")

// UpdateCard replaces a card in place — the mechanism that disarms an actioned
// card so a second press does nothing (G17).
//
// It goes straight to PATCH /open-apis/im/v1/messages/:message_id and does NOT
// use a stream controller: a controller only exists for a stream this process
// opened, and a card callback arrives with nothing but a message id. The
// endpoint is card-only by definition (its body is just `content`), which is
// the API-level spelling of "msg_type interactive".
func (b *bot) UpdateCard(ctx context.Context, messageID, cardJSON string) error {
	if err := b.requireConnected(); err != nil {
		return err
	}
	if messageID == "" {
		return fmt.Errorf("%w: no message id to update", ErrInvalidOut)
	}
	if !isJSONObject(cardJSON) {
		return fmt.Errorf("%w: replacement card is not a JSON object", ErrInvalidOut)
	}

	req := larkim.NewPatchMessageReqBuilder().
		MessageId(messageID).
		Body(larkim.NewPatchMessageReqBodyBuilder().
			Content(cardJSON).
			Build()).
		Build()

	op := "patch message " + messageID
	resp, err := b.api.Im.V1.Message.Patch(ctx, req)
	if err != nil {
		return newFailure(op, b.appID, err)
	}
	if !resp.Success() {
		return newFailure(op, b.appID, &larkcore.CodeError{Code: resp.Code, Msg: resp.Msg})
	}
	return nil
}

func (b *bot) Stream(ctx context.Context, o Out) (Stream, error) {
	if err := b.requireConnected(); err != nil {
		return nil, err
	}
	in, err := toSendInput(o)
	if err != nil {
		return nil, err
	}

	sc, err := b.ch.Stream(ctx, in)
	if err != nil {
		return nil, newFailure("open stream", b.appID, err)
	}
	if sc == nil {
		return nil, errors.New("lark: channel returned a nil stream controller")
	}
	return &streamAdapter{sc: sc, appID: b.appID}, nil
}

// BotOpenID returns the bot's own open_id, empty if it is not known.
//
// Empty is a real possibility: the lookup is a REST call that can fail, and
// the SDK reports failure by logging and returning nil. Callers must treat ""
// as "cannot tell" rather than as an id to compare against.
func (b *bot) BotOpenID(ctx context.Context) string {
	b.mu.RLock()
	id := b.botOpenID
	b.mu.RUnlock()
	if id != "" {
		return id
	}

	ident := b.ch.GetBotIdentity(ctx)
	if ident == nil || ident.OpenID == "" {
		return ""
	}
	b.mu.Lock()
	b.botOpenID = ident.OpenID
	b.mu.Unlock()
	return ident.OpenID
}
