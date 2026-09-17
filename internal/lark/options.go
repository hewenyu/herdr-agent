package lark

import (
	"log/slog"
	"net/http"

	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
)

// LogLevel controls how chatty the Feishu SDK is. The zero value is LogInfo,
// which is what the bridge runs with: the ws client logs one line per
// connect/disconnect, which is exactly the signal needed to see a reconnect
// storm, and nothing per event.
//
// This is our own enum rather than larkcore.LogLevel so that a caller can pick
// a level without importing the SDK — the whole point of this package.
type LogLevel int

const (
	LogInfo LogLevel = iota
	LogDebug
	LogWarn
	LogError
)

// sdk maps to the SDK's level. Note that LogDebug makes the ws client print
// every inbound event payload; it never prints the app secret (the bootstrap
// request body is not logged), and the API client only logs method+path
// because we never enable larkcore's LogReqAtDebug — that one WOULD dump the
// tenant_access_token request, which carries the secret (S2 §3.1).
func (l LogLevel) sdk() larkcore.LogLevel {
	switch l {
	case LogDebug:
		return larkcore.LogLevelDebug
	case LogWarn:
		return larkcore.LogLevelWarn
	case LogError:
		return larkcore.LogLevelError
	default:
		return larkcore.LogLevelInfo
	}
}

// HTTPDoer is the subset of *http.Client the SDK's REST calls need. It is
// declared here, in net/http terms, so that supplying one does not drag the
// SDK into the caller's imports.
type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// Option configures the Bot built by New.
type Option func(*settings)

type settings struct {
	logLevel  LogLevel
	botOpenID string
	http      larkcore.HttpClient
	log       *slog.Logger
	taskChats bool
}

// WithTaskChats permits unmentioned group messages to reach the bridge. The
// bridge must restrict those messages to task chats bound to their owner;
// enabling this option alone does not authorize any sender or chat.
func WithTaskChats(enabled bool) Option {
	return func(s *settings) { s.taskChats = enabled }
}

// WithLogLevel sets the SDK log level for both the ws client and the REST
// client.
func WithLogLevel(l LogLevel) Option {
	return func(s *settings) { s.logLevel = l }
}

// WithBotOpenID supplies the bot's own open_id instead of letting the SDK
// resolve it from /open-apis/bot/v3/info.
//
// It matters for self-echo suppression: without an open_id the bridge cannot
// tell its own messages from the user's, and the identity lookup is a network
// call that fails silently (the SDK logs and returns nil). Pinning the value
// from config makes that filter deterministic — and lets the mapping be tested
// without a Feishu app.
func WithBotOpenID(openID string) Option {
	return func(s *settings) { s.botOpenID = openID }
}

// WithHTTPClient replaces the http client used for REST calls (send, patch,
// bot identity). Use it to impose a timeout, or to point the REST surface at a
// stub in tests. It does NOT affect the WebSocket connection, which the SDK
// dials itself.
func WithHTTPClient(d HTTPDoer) Option {
	return func(s *settings) {
		if d != nil {
			s.http = d
		}
	}
}

// WithLogger sets the logger used for the events that have no other way out:
// a message handler that failed (the SDK discards its error, see
// bot.handleMessage) and a message the SDK's policy gate rejected. Both are
// otherwise invisible, which is the silent-failure shape S2 warns about
// throughout. Defaults to slog.Default().
//
// Nothing logged here contains message content or the app secret (S2 §3.1) —
// only ids, and ids are what a postmortem needs.
func WithLogger(l *slog.Logger) Option {
	return func(s *settings) {
		if l != nil {
			s.log = l
		}
	}
}
