// Package lark wraps the Feishu SDK so that no other package imports it.
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package lark

import (
	"context"
	"errors"
)

// ChatType values.
const (
	ChatP2P   = "p2p"
	ChatGroup = "group"
)

// Msg is an inbound message, already normalised by the SDK's channel module.
type Msg struct {
	EventID   string // dedup key (G14)
	MessageID string
	ChatID    string
	ChatType  string
	UserID    string // sender open_id; the authorization subject
	Text      string
	// ReplyToMessageID is the message this one replies to, when the platform
	// tells us. Reply-to is the primary routing mechanism: it lets one chat
	// drive many agents without any /use switching command.
	ReplyToMessageID string
	MentionedBot     bool
}

// Action is an interactive card button press.
type Action struct {
	EventID   string
	MessageID string // the card's own message id; needed to update it
	ChatID    string
	Operator  string // open_id; the authorization subject
	Value     map[string]any
}

// Out is an outbound message. Exactly one of Text, Markdown or Card is set.
type Out struct {
	ChatID         string
	ReplyMessageID string
	Text           string
	Markdown       string
	Card           string // stringified card JSON
	Title          string // used as the post title when Markdown is set
}

// Stream incrementally edits one message. Used to mirror an agent turn as it
// is produced rather than posting a wall of text at the end.
type Stream interface {
	Append(ctx context.Context, chunk string) error
	Flush(ctx context.Context) error
	Close(ctx context.Context) error
}

// Lifecycle hooks. All optional.
type Lifecycle struct {
	OnReady        func()
	OnError        func(error)
	OnReconnecting func()
	OnReconnected  func()
	OnDisconnected func()
}

// Bot is the Feishu surface the rest of the bridge uses.
type Bot interface {
	// Start connects and blocks until ctx is cancelled or the connection dies
	// unrecoverably. Handlers must be registered before Start.
	Start(ctx context.Context) error
	Stop(ctx context.Context) error

	OnMessage(func(ctx context.Context, m Msg) error)
	OnCardAction(func(ctx context.Context, a Action) error)
	SetLifecycle(Lifecycle)

	// Send returns the created message id so the caller can bind it for
	// reply-routing and later update it.
	Send(ctx context.Context, o Out) (messageID string, err error)

	// UpdateCard replaces a card in place. This is how an actioned card is
	// disarmed (G17). It uses PATCH /open-apis/im/v1/messages/:id; note the
	// card stream controller cannot be used here because a card callback does
	// not own one.
	UpdateCard(ctx context.Context, messageID, cardJSON string) error

	Stream(ctx context.Context, o Out) (Stream, error)

	// BotOpenID is this bot's own open_id, used to ignore self-echo.
	BotOpenID(ctx context.Context) string
}

// ErrNotConnected is returned by Send/UpdateCard before Start or after Stop.
var ErrNotConnected = errors.New("lark bot not connected")

// New builds a Bot.
//
// Implementations MUST construct the ws client as:
//
//	evt := dispatcher.NewEventDispatcher("", "")
//	ws  := larkws.NewClient(appID, appSecret, larkws.WithEventHandler(evt), ...)
//	ch  := channel.NewChannel(lark.NewClient(appID, appSecret), ws)
//
// Omitting WithEventHandler makes every inbound event panic on a nil receiver
// inside ws.handleDataFrame, while channelImpl.ensureMessageHandler silently
// skips registration and never retries. The official doc/channel.zh.md minimal
// example omits it and is therefore broken (G13).
//
// A unit test must assert that the constructed ws client's EventHandler() is
// non-nil, so this cannot regress.
//
// Implementations must provide, in bot.go, exactly:
//
//	func New(appID, appSecret string, opts ...Option) (Bot, error)
type Factory interface {
	New(appID, appSecret string) (Bot, error)
}
