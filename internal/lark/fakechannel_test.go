package lark

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"sync"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
)

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func captureLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

// fakeChannel replaces the SDK channel for tests about Bot behaviour that has
// nothing to do with the wire format: start/stop, lifecycle fan-out, streams.
//
// It exists because the real ws client's Start never returns — it ends in
// `select {}` and, on a failed dial, drops into an infinite reconnect loop
// with multi-second sleeps that ignores the context. That is fine in
// production and impossible to assert against in a test.
type fakeChannel struct {
	mu sync.Mutex

	onMessage      func(context.Context, *types.NormalizedMessage) error
	onCardAction   func(context.Context, *types.CardActionEvent) error
	onReject       []func(context.Context, *types.RejectEvent) error
	onReady        []func()
	onError        []func(error)
	onReconnecting []func()
	onReconnected  []func()
	onDisconnected []func()

	startCalls int
	stopCalls  int
	startErr   error
	// startBlocks parks Start until release is closed, mimicking a live
	// connection. started is closed on the first Start so tests can wait
	// without polling.
	startBlocks bool
	release     chan struct{}
	started     chan struct{}
	startedOnce sync.Once

	sendInput  *types.SendInput
	sendResult *types.SendResult
	sendErr    error

	streamInput *types.SendInput
	stream      types.StreamController
	streamErr   error

	identity *types.BotIdentity
}

var _ types.Channel = (*fakeChannel)(nil)

func newFakeChannel() *fakeChannel {
	return &fakeChannel{
		release: make(chan struct{}),
		started: make(chan struct{}),
	}
}

// newFakeBot builds a Bot over the fake channel, wired exactly as New wires
// the real one.
func newFakeBot(fc *fakeChannel, botOpenID string) *bot {
	b := &bot{ch: fc, botOpenID: botOpenID, log: discardLogger()}
	b.wire()
	return b
}

func (f *fakeChannel) Start(ctx context.Context) error {
	f.mu.Lock()
	f.startCalls++
	blocks, err := f.startBlocks, f.startErr
	f.mu.Unlock()
	f.startedOnce.Do(func() { close(f.started) })
	if blocks {
		<-f.release
	}
	return err
}

func (f *fakeChannel) Stop(ctx context.Context) error {
	f.mu.Lock()
	f.stopCalls++
	f.mu.Unlock()
	return nil
}

func (f *fakeChannel) counts() (start, stop int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.startCalls, f.stopCalls
}

func (f *fakeChannel) Send(ctx context.Context, in *types.SendInput) (*types.SendResult, error) {
	f.mu.Lock()
	f.sendInput = in
	res, err := f.sendResult, f.sendErr
	f.mu.Unlock()
	return res, err
}

func (f *fakeChannel) Stream(ctx context.Context, in *types.SendInput) (types.StreamController, error) {
	f.mu.Lock()
	f.streamInput = in
	sc, err := f.stream, f.streamErr
	f.mu.Unlock()
	return sc, err
}

func (f *fakeChannel) OnMessage(h func(context.Context, *types.NormalizedMessage) error) {
	f.mu.Lock()
	f.onMessage = h
	f.mu.Unlock()
}

func (f *fakeChannel) OnCardAction(h func(context.Context, *types.CardActionEvent) error) {
	f.mu.Lock()
	f.onCardAction = h
	f.mu.Unlock()
}

func (f *fakeChannel) OnReady(h func()) { f.mu.Lock(); f.onReady = append(f.onReady, h); f.mu.Unlock() }
func (f *fakeChannel) OnError(h func(error)) {
	f.mu.Lock()
	f.onError = append(f.onError, h)
	f.mu.Unlock()
}
func (f *fakeChannel) OnReconnecting(h func()) {
	f.mu.Lock()
	f.onReconnecting = append(f.onReconnecting, h)
	f.mu.Unlock()
}
func (f *fakeChannel) OnReconnected(h func()) {
	f.mu.Lock()
	f.onReconnected = append(f.onReconnected, h)
	f.mu.Unlock()
}
func (f *fakeChannel) OnDisconnected(h func()) {
	f.mu.Lock()
	f.onDisconnected = append(f.onDisconnected, h)
	f.mu.Unlock()
}

func (f *fakeChannel) fire(hs []func()) {
	for _, h := range hs {
		h()
	}
}

func (f *fakeChannel) GetBotIdentity(ctx context.Context) *types.BotIdentity {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.identity
}

func (f *fakeChannel) OnReject(h func(context.Context, *types.RejectEvent) error) {
	f.mu.Lock()
	f.onReject = append(f.onReject, h)
	f.mu.Unlock()
}

// Unused by the bridge, present to satisfy types.Channel.
func (f *fakeChannel) OnReaction(func(context.Context, *types.ReactionEvent) error) {}
func (f *fakeChannel) OnComment(func(context.Context, *types.CommentEvent) error)   {}
func (f *fakeChannel) OnBotAdded(func(context.Context, *types.BotAddedEvent) error) {}
func (f *fakeChannel) UpdatePolicy(types.PolicyConfig)                              {}
func (f *fakeChannel) GetPolicy() types.PolicyConfig                                { return types.PolicyConfig{} }
func (f *fakeChannel) DownloadFile(context.Context, string, string) ([]byte, error) { return nil, nil }

// fakeStream records what a mirror would have pushed.
type fakeStream struct {
	mu        sync.Mutex
	appended  []string
	flushes   int
	closes    int
	appendErr error
	closeErr  error
}

var _ types.StreamController = (*fakeStream)(nil)

func (s *fakeStream) Append(ctx context.Context, text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.appendErr != nil {
		return s.appendErr
	}
	s.appended = append(s.appended, text)
	return nil
}

func (s *fakeStream) UpdateCard(ctx context.Context, card string) error { return nil }

func (s *fakeStream) Flush(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.flushes++
	return nil
}

func (s *fakeStream) Close(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closes++
	return s.closeErr
}

func (s *fakeStream) state() (appended []string, flushes, closes int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.appended...), s.flushes, s.closes
}
