package herdrapi

import (
	"context"
	"sync"
)

// ForbiddenMethods are the herdr methods this bridge must never send.
//
// agent.focus / pane.focus clear `done` and yank the desktop user's UI (G10);
// the rest are irreversible or out of scope. The list is enforced in two
// places, neither of them here: structurally, because Client has no method that
// can express them, and at the transport boundary by allowedMethods in call().
// The list itself is a named regression guard for those two.
//
// RecordingClient is therefore not what makes S1 §4 item 8 true — it exists so
// higher layers can assert *which whitelisted* calls they made: that no
// agent.send_keys went out for a stale Guard (G17), and no agent.prompt went
// out while status == blocked (G1).
var ForbiddenMethods = []string{
	"agent.focus",
	"pane.focus",
	"server.stop",
	"pane.close",
	"workspace.close",
	"workspace.create",
	"tab.close",
	"tab.create",
	"pane.split",
	"agent.start",
}

// RecordedCall is one Client call, captured by RecordingClient.
//
// Method is the herdr wire method name ("agent.send_keys"), so tests can
// intersect it with ForbiddenMethods directly.
type RecordedCall struct {
	Method string
	Target string     // pane id or agent target, empty when not applicable
	Text   string     // agent.prompt text, notification.show title
	Body   string     // notification.show body
	Keys   []string   // agent.send_keys
	Source ReadSource // agent.read
	Lines  int        // agent.read
	Wait   *PromptWait
}

// RecordingClient is a Client that records every call and answers from
// optional hooks. It lives outside _test.go so packages above this one can
// assert what the bridge sent to herdr — above all, that it never sent a
// keystroke it should not have.
//
// A nil hook returns the zero value and a nil error. The zero RecordingClient
// is usable. It is safe for concurrent use.
type RecordingClient struct {
	OnPing             func(ctx context.Context) (PingResult, error)
	OnAgentList        func(ctx context.Context) ([]AgentInfo, error)
	OnAgentGet         func(ctx context.Context, target string) (AgentInfo, error)
	OnAgentRead        func(ctx context.Context, target string, src ReadSource, lines int) (string, error)
	OnAgentReadFull    func(ctx context.Context, target string, src ReadSource, lines int) (string, bool, error)
	OnPaneGet          func(ctx context.Context, paneID string) (PaneInfo, error)
	OnAgentPrompt      func(ctx context.Context, target, text string, wait *PromptWait) (AgentInfo, error)
	OnAgentSendKeys    func(ctx context.Context, target string, keys []string) error
	OnNotificationShow func(ctx context.Context, title, body string) error

	mu      sync.Mutex
	calls   []RecordedCall
	closes  int
	skipped []RecordedCall
}

var _ Client = (*RecordingClient)(nil)

// RecordingSocketPath is what a RecordingClient reports as its socket, so
// doctor-level tests can exercise SocketPathOf without a real socket.
const RecordingSocketPath = "/fake/herdr.sock"

// SocketPath satisfies the accessor SocketPathOf looks for.
func (r *RecordingClient) SocketPath() string { return RecordingSocketPath }

func (r *RecordingClient) record(c RecordedCall) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, c)
}

// Calls returns every recorded call, in order.
func (r *RecordingClient) Calls() []RecordedCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]RecordedCall, len(r.calls))
	copy(out, r.calls)
	return out
}

// Methods returns the wire method name of every recorded call, in order.
func (r *RecordingClient) Methods() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.calls))
	for i, c := range r.calls {
		out[i] = c.Method
	}
	return out
}

// Count returns how many times method was called.
func (r *RecordingClient) Count(method string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, c := range r.calls {
		if c.Method == method {
			n++
		}
	}
	return n
}

// Rejected returns the calls this client refused to make on the bridge's
// behalf, currently only agent.read with a forbidden source. They are not in
// Calls(): nothing was sent.
func (r *RecordingClient) Rejected() []RecordedCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]RecordedCall, len(r.skipped))
	copy(out, r.skipped)
	return out
}

// CloseCount reports how many times Close was called.
func (r *RecordingClient) CloseCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.closes
}

// Reset drops all recorded calls.
func (r *RecordingClient) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = nil
	r.skipped = nil
	r.closes = 0
}

func (r *RecordingClient) Ping(ctx context.Context) (PingResult, error) {
	r.record(RecordedCall{Method: methodPing})
	if r.OnPing == nil {
		return PingResult{Protocol: MinProtocol, Version: "fake"}, nil
	}
	return r.OnPing(ctx)
}

func (r *RecordingClient) AgentList(ctx context.Context) ([]AgentInfo, error) {
	r.record(RecordedCall{Method: methodAgentList})
	if r.OnAgentList == nil {
		return nil, nil
	}
	return r.OnAgentList(ctx)
}

func (r *RecordingClient) AgentGet(ctx context.Context, target string) (AgentInfo, error) {
	r.record(RecordedCall{Method: methodAgentGet, Target: target})
	if r.OnAgentGet == nil {
		return AgentInfo{}, nil
	}
	return r.OnAgentGet(ctx, target)
}

// AgentRead mirrors the real client: it delegates to AgentReadFull and drops
// the truncated flag, so both record exactly one call.
func (r *RecordingClient) AgentRead(ctx context.Context, target string, src ReadSource, lines int) (string, error) {
	text, _, err := r.AgentReadFull(ctx, target, src, lines)
	return text, err
}

// AgentReadFull enforces the same source rule as the real client, so a higher
// layer that asks for source=recent fails in tests instead of in the user's
// live pane (G9). The attempt is visible via Rejected().
//
// OnAgentReadFull answers when set; otherwise OnAgentRead answers and truncated
// is false.
func (r *RecordingClient) AgentReadFull(ctx context.Context, target string, src ReadSource, lines int) (string, bool, error) {
	call := RecordedCall{Method: methodAgentRead, Target: target, Source: src, Lines: lines}
	if err := checkReadSource(src); err != nil {
		r.mu.Lock()
		r.skipped = append(r.skipped, call)
		r.mu.Unlock()
		return "", false, err
	}
	r.record(call)
	if r.OnAgentReadFull != nil {
		return r.OnAgentReadFull(ctx, target, src, lines)
	}
	if r.OnAgentRead == nil {
		return "", false, nil
	}
	text, err := r.OnAgentRead(ctx, target, src, lines)
	return text, false, err
}

func (r *RecordingClient) PaneGet(ctx context.Context, paneID string) (PaneInfo, error) {
	r.record(RecordedCall{Method: methodPaneGet, Target: paneID})
	if r.OnPaneGet == nil {
		return PaneInfo{}, nil
	}
	return r.OnPaneGet(ctx, paneID)
}

func (r *RecordingClient) AgentPrompt(ctx context.Context, target, text string, wait *PromptWait) (AgentInfo, error) {
	r.record(RecordedCall{Method: methodAgentPrompt, Target: target, Text: text, Wait: wait})
	if r.OnAgentPrompt == nil {
		return AgentInfo{}, nil
	}
	return r.OnAgentPrompt(ctx, target, text, wait)
}

func (r *RecordingClient) AgentSendKeys(ctx context.Context, target string, keys []string) error {
	r.record(RecordedCall{Method: methodAgentSendKeys, Target: target, Keys: append([]string(nil), keys...)})
	if r.OnAgentSendKeys == nil {
		return nil
	}
	return r.OnAgentSendKeys(ctx, target, keys)
}

func (r *RecordingClient) NotificationShow(ctx context.Context, title, body string) error {
	r.record(RecordedCall{Method: methodNotificationShow, Text: title, Body: body})
	if r.OnNotificationShow == nil {
		return nil
	}
	return r.OnNotificationShow(ctx, title, body)
}

func (r *RecordingClient) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closes++
	return nil
}
