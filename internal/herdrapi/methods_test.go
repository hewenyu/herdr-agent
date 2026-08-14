package herdrapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// TestWireShapes pins the exact request every whitelisted method puts on the
// socket, against herdr's protocol 19 schema (params is required for every
// method, targets are "target" except pane.get which is "pane_id").
func TestWireShapes(t *testing.T) {
	tests := []struct {
		name       string
		call       func(c Client) error
		result     string
		wantMethod string
		wantParams map[string]any
	}{
		{
			name:       "ping",
			call:       func(c Client) error { _, err := c.Ping(context.Background()); return err },
			result:     `{"type":"pong","version":"0.8.0","protocol":19}`,
			wantMethod: "ping",
			wantParams: map[string]any{},
		},
		{
			name:       "agent.list",
			call:       func(c Client) error { _, err := c.AgentList(context.Background()); return err },
			result:     `{"type":"agent_list","agents":[]}`,
			wantMethod: "agent.list",
			wantParams: map[string]any{},
		},
		{
			name:       "agent.get",
			call:       func(c Client) error { _, err := c.AgentGet(context.Background(), "w1:p1"); return err },
			result:     `{"type":"agent_info","agent":{"pane_id":"w1:p1"}}`,
			wantMethod: "agent.get",
			wantParams: map[string]any{"target": "w1:p1"},
		},
		{
			name: "agent.read visible with a line cap",
			call: func(c Client) error {
				_, err := c.AgentRead(context.Background(), "w1:p1", SourceVisible, 30)
				return err
			},
			result:     `{"type":"pane_read","read":{"text":"hi","truncated":false}}`,
			wantMethod: "agent.read",
			wantParams: map[string]any{"target": "w1:p1", "source": "visible", "lines": float64(30)},
		},
		{
			name: "agent.read detection omits lines",
			call: func(c Client) error {
				_, err := c.AgentRead(context.Background(), "w1:p1", SourceDetection, 0)
				return err
			},
			result:     `{"type":"pane_read","read":{"text":"hi","truncated":false}}`,
			wantMethod: "agent.read",
			wantParams: map[string]any{"target": "w1:p1", "source": "detection"},
		},
		{
			name:       "pane.get uses pane_id",
			call:       func(c Client) error { _, err := c.PaneGet(context.Background(), "w1:p1"); return err },
			result:     `{"type":"pane_info","pane":{"pane_id":"w1:p1"}}`,
			wantMethod: "pane.get",
			wantParams: map[string]any{"pane_id": "w1:p1"},
		},
		{
			name: "agent.prompt without wait",
			call: func(c Client) error {
				_, err := c.AgentPrompt(context.Background(), "w1:p1", "hello", nil)
				return err
			},
			result:     `{"type":"agent_prompted","agent":{"pane_id":"w1:p1"}}`,
			wantMethod: "agent.prompt",
			wantParams: map[string]any{"target": "w1:p1", "text": "hello"},
		},
		{
			name: "agent.prompt with wait",
			call: func(c Client) error {
				timeout := uint64(8000)
				_, err := c.AgentPrompt(context.Background(), "w1:p1", "hello", &PromptWait{
					Until:     []string{"idle", "done"},
					TimeoutMs: &timeout,
				})
				return err
			},
			result:     `{"type":"agent_prompted","agent":{"pane_id":"w1:p1"}}`,
			wantMethod: "agent.prompt",
			wantParams: map[string]any{
				"target": "w1:p1",
				"text":   "hello",
				"wait":   map[string]any{"until": []any{"idle", "done"}, "timeout_ms": float64(8000)},
			},
		},
		{
			name:       "agent.send_keys",
			call:       func(c Client) error { return c.AgentSendKeys(context.Background(), "w1:p1", []string{"esc"}) },
			result:     `{"type":"ok"}`,
			wantMethod: "agent.send_keys",
			wantParams: map[string]any{"target": "w1:p1", "keys": []any{"esc"}},
		},
		{
			name:       "notification.show",
			call:       func(c Client) error { return c.NotificationShow(context.Background(), "title", "body") },
			result:     `{"type":"notification_show","shown":true,"reason":"shown"}`,
			wantMethod: "notification.show",
			wantParams: map[string]any{"title": "title", "body": "body"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newFakeServer(t, func(req string) (string, bool) {
				return fmt.Sprintf(`{"id":%q,"result":%s}`, idOf(req), tt.result), true
			})
			c := srv.client(t)

			if err := tt.call(c); err != nil {
				t.Fatalf("call: %v", err)
			}
			reqs := srv.requests()
			if len(reqs) != 1 {
				t.Fatalf("want 1 request, got %d", len(reqs))
			}
			var got struct {
				ID     string         `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if err := json.Unmarshal([]byte(reqs[0]), &got); err != nil {
				t.Fatalf("decode request: %v", err)
			}
			if got.Method != tt.wantMethod {
				t.Errorf("method = %q, want %q", got.Method, tt.wantMethod)
			}
			if got.Params == nil {
				t.Fatalf("params missing from %s", reqs[0])
			}
			// DeepEqual, not fmt.Sprint: the schema types lines and
			// timeout_ms as ["integer","null"], and herdr answers a wrong
			// JSON type with invalid_request (G10). encoding/json gives
			// float64 for numbers and string for strings, so only a typed
			// comparison can see that regression — fmt.Sprint renders
			// float64(30) and "30" identically.
			if !reflect.DeepEqual(got.Params, tt.wantParams) {
				t.Errorf("params = %#v, want %#v", got.Params, tt.wantParams)
			}
		})
	}
}

// G9: source=recent makes herdr synthesise real mouse-wheel events into the
// user's live pane for up to 15s and clients cannot opt out, so the source is
// rejected before anything is dialled.
func TestAgentReadRejectsForbiddenSourceWithoutDialling(t *testing.T) {
	tests := []struct {
		name   string
		source ReadSource
		wantOK bool
	}{
		{name: "visible", source: SourceVisible, wantOK: true},
		{name: "detection", source: SourceDetection, wantOK: true},
		{name: "recent", source: ReadSource("recent")},
		{name: "recent_unwrapped", source: ReadSource("recent_unwrapped")},
		{name: "empty", source: ReadSource("")},
		{name: "nonsense", source: ReadSource("Visible")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newFakeServer(t, func(req string) (string, bool) {
				return fmt.Sprintf(`{"id":%q,"result":{"type":"pane_read","read":{"text":"ok"}}}`, idOf(req)), true
			})
			c := srv.client(t)

			text, err := c.AgentRead(context.Background(), "w1:p1", tt.source, 20)
			if tt.wantOK {
				if err != nil {
					t.Fatalf("AgentRead(%q): %v", tt.source, err)
				}
				if text != "ok" {
					t.Errorf("text = %q, want %q", text, "ok")
				}
				return
			}
			if !errors.Is(err, ErrReadSourceForbidden) {
				t.Fatalf("AgentRead(%q) = %v, want ErrReadSourceForbidden", tt.source, err)
			}
			if !strings.Contains(err.Error(), string(tt.source)) {
				t.Errorf("error %q does not name the rejected source", err)
			}
			if conns := srv.connections(); len(conns) != 0 {
				t.Fatalf("AgentRead(%q) dialled %d times; it must not touch the socket", tt.source, len(conns))
			}
		})
	}
}

// G3: agent.prompt's success return only means bytes entered the PTY queue.
// With wait, agent_prompt_stalled is herdr telling us the text never landed;
// callers must be able to tell that apart from every other failure.
func TestAgentPromptStallIsDistinguishable(t *testing.T) {
	tests := []struct {
		name      string
		code      string
		wantStall bool
	}{
		{name: "stalled", code: CodeAgentPromptStall, wantStall: true},
		{name: "not ready", code: CodeAgentNotReady},
		{name: "empty prompt", code: CodeEmptyAgentPrompt},
		{name: "timeout", code: CodeTimeout},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newFakeServer(t, func(req string) (string, bool) {
				return fmt.Sprintf(`{"id":%q,"error":{"code":%q,"message":"nope"}}`, idOf(req), tt.code), true
			})
			c := srv.client(t)

			timeout := uint64(8000)
			_, err := c.AgentPrompt(context.Background(), "w1:p1", "hi", &PromptWait{
				Until:     []string{"working", "blocked", "idle", "done"},
				TimeoutMs: &timeout,
			})
			if got := errors.Is(err, ErrPromptStalled); got != tt.wantStall {
				t.Fatalf("errors.Is(err, ErrPromptStalled) = %v, want %v (err = %v)", got, tt.wantStall, err)
			}
			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Fatalf("the *APIError must survive wrapping, got %#v", err)
			}
			if apiErr.Code != tt.code {
				t.Errorf("code = %q, want %q", apiErr.Code, tt.code)
			}
		})
	}
}

// G3 + G10: herdr blocks server-side for the whole wait window and only then
// answers, on its single UI thread. If the read deadline were the plain call
// budget, a prompt that herdr HAD already pasted into the live agent would come
// back as os.ErrDeadlineExceeded — reported to the caller as "not delivered"
// when it was delivered. herdr.call_timeout is a user-settable TOML knob
// validated only as non-negative, so the budget really can be under 8s.
func TestAgentPromptReadDeadlineCoversTheWaitWindow(t *testing.T) {
	const (
		serverDelay   = 60 * time.Millisecond // herdr thinking, i.e. waiting
		clientTimeout = 20 * time.Millisecond // an aggressive herdr.call_timeout
	)
	shortWait := uint64(1)

	tests := []struct {
		name    string
		wait    *PromptWait
		wantErr bool
	}{
		{name: "wait with timeout_ms raises the deadline", wait: &PromptWait{Until: []string{"idle"}, TimeoutMs: &shortWait}},
		{name: "wait without timeout_ms uses herdr's own window", wait: &PromptWait{Until: []string{"idle"}}},
		{name: "no wait keeps the call budget", wait: nil, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newFakeServer(t, func(req string) (string, bool) {
				time.Sleep(serverDelay)
				return fmt.Sprintf(`{"id":%q,"result":{"type":"agent_prompted","agent":{"pane_id":"w1:p1"}}}`, idOf(req)), true
			})
			c := srv.client(t)
			c.timeout = clientTimeout

			agent, err := c.AgentPrompt(context.Background(), "w1:p1", "hello", tt.wait)
			if tt.wantErr {
				if !errors.Is(err, os.ErrDeadlineExceeded) {
					t.Fatalf("want os.ErrDeadlineExceeded, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("AgentPrompt: %v", err)
			}
			if agent.PaneID != "w1:p1" {
				t.Errorf("agent = %+v", agent)
			}
		})
	}
}

func TestPromptReadTimeout(t *testing.T) {
	ms := func(n uint64) *uint64 { return &n }

	tests := []struct {
		name string
		base time.Duration
		wait *PromptWait
		want time.Duration
	}{
		{name: "no wait uses the base budget", base: 10 * time.Second, want: 10 * time.Second},
		// S1 §3.4.3 prescribes exactly this wait; DefaultTimeout must not clip it.
		{name: "S1's 8s wait", base: DefaultTimeout, wait: &PromptWait{TimeoutMs: ms(8000)}, want: 8*time.Second + promptWaitHeadroom},
		{name: "a generous base wins", base: time.Minute, wait: &PromptWait{TimeoutMs: ms(8000)}, want: time.Minute},
		{name: "an aggressive call_timeout is overridden", base: 5 * time.Second, wait: &PromptWait{TimeoutMs: ms(8000)}, want: 8*time.Second + promptWaitHeadroom},
		{name: "nil timeout_ms falls back to herdr's own window", base: time.Second, wait: &PromptWait{}, want: defaultPromptEffectTimeout + promptWaitHeadroom},
		// A deadline computed from an overflowing uint64 would land in the past.
		{name: "absurd timeout_ms is capped", base: time.Second, wait: &PromptWait{TimeoutMs: ms(1 << 62)}, want: maxPromptWait + promptWaitHeadroom},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := promptReadTimeout(tt.base, tt.wait)
			if got != tt.want {
				t.Errorf("promptReadTimeout(%s, %+v) = %s, want %s", tt.base, tt.wait, got, tt.want)
			}
			if got <= 0 {
				t.Errorf("read timeout %s is not in the future", got)
			}
		})
	}
}

// herdr's protocol 19 marks PaneReadResult.truncated required, and it is the
// only signal that the buffer came back incomplete. S1 §3.3's Screen.Cropped
// describes our own column cropping, not this.
func TestAgentReadFullReportsTruncation(t *testing.T) {
	for _, truncated := range []bool{false, true} {
		t.Run(fmt.Sprintf("truncated=%v", truncated), func(t *testing.T) {
			srv := newFakeServer(t, func(req string) (string, bool) {
				return fmt.Sprintf(`{"id":%q,"result":{"type":"pane_read","read":{"text":"hi","truncated":%v,"revision":0}}}`,
					idOf(req), truncated), true
			})
			c := srv.client(t)

			text, gotTrunc, err := c.AgentReadFull(context.Background(), "w1:p1", SourceDetection, 0)
			if err != nil {
				t.Fatalf("AgentReadFull: %v", err)
			}
			if text != "hi" || gotTrunc != truncated {
				t.Errorf("= %q, %v; want %q, %v", text, gotTrunc, "hi", truncated)
			}
			// ReadFull reaches the same signal through the Client interface.
			text, gotTrunc, err = ReadFull(context.Background(), c, "w1:p1", SourceDetection, 0)
			if err != nil || text != "hi" || gotTrunc != truncated {
				t.Errorf("ReadFull = %q, %v, %v", text, gotTrunc, err)
			}
		})
	}
}

func TestResultDecoding(t *testing.T) {
	const agentJSON = `{
	  "pane_id":"w1:p1","workspace_id":"w1","tab_id":"t1","terminal_id":"term-7",
	  "agent":"claude","agent_status":"blocked","cwd":"/tmp/x",
	  "terminal_title_stripped":"Create hello.txt with touch",
	  "agent_session":{"source":"herdr:claude","agent":"claude","kind":"id","value":"cf67e552"},
	  "state_change_seq":42,"interactive_ready":true,"launch_pending":false,
	  "focused":false,"revision":9
	}`

	srv := newFakeServer(t, func(req string) (string, bool) {
		return oneLine(t, fmt.Sprintf(`{"id":%q,"result":{"type":"agent_list","agents":[%s]}}`, idOf(req), agentJSON)), true
	})
	c := srv.client(t)

	agents, err := c.AgentList(context.Background())
	if err != nil {
		t.Fatalf("AgentList: %v", err)
	}
	if len(agents) != 1 {
		t.Fatalf("want 1 agent, got %d", len(agents))
	}
	a := agents[0]
	if a.PaneID != "w1:p1" || a.AgentStatus != "blocked" || a.StateChangeSeq != 42 {
		t.Errorf("agent decoded wrong: %+v", a)
	}
	if a.Agent == nil || *a.Agent != "claude" {
		t.Errorf("agent kind = %v", a.Agent)
	}
	if a.AgentSession == nil || a.AgentSession.Kind != "id" || a.AgentSession.Value != "cf67e552" {
		t.Errorf("session ref = %+v", a.AgentSession)
	}
	if !a.InteractiveReady {
		t.Error("interactive_ready lost")
	}
}

func TestPaneGetDecodesScroll(t *testing.T) {
	srv := newFakeServer(t, func(req string) (string, bool) {
		return fmt.Sprintf(`{"id":%q,"result":{"type":"pane_info","pane":{"pane_id":"w1:p1","workspace_id":"w1","tab_id":"t1","terminal_id":"term-7","agent_status":"idle","scroll":{"offset_from_bottom":0,"max_offset_from_bottom":120,"viewport_rows":49}}}}`, idOf(req)), true
	})
	c := srv.client(t)

	pane, err := c.PaneGet(context.Background(), "w1:p1")
	if err != nil {
		t.Fatalf("PaneGet: %v", err)
	}
	if pane.Scroll == nil || pane.Scroll.ViewportRows != 49 {
		t.Fatalf("scroll = %+v", pane.Scroll)
	}
}

func TestCheckProtocol(t *testing.T) {
	tests := []struct {
		name     string
		protocol int
		wantErr  bool
	}{
		{name: "exactly MinProtocol", protocol: MinProtocol},
		{name: "newer", protocol: MinProtocol + 1},
		{name: "older", protocol: MinProtocol - 1, wantErr: true},
		{name: "ancient", protocol: 1, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newFakeServer(t, func(req string) (string, bool) {
				return fmt.Sprintf(`{"id":%q,"result":{"type":"pong","version":"0.8.0","protocol":%d}}`, idOf(req), tt.protocol), true
			})
			c := srv.client(t)

			res, err := CheckProtocol(context.Background(), c)
			if tt.wantErr {
				if !errors.Is(err, ErrProtocolTooOld) {
					t.Fatalf("want ErrProtocolTooOld, got %v", err)
				}
				// S1 3.1: the caller has to be able to print what it found.
				if res.Protocol != tt.protocol {
					t.Errorf("protocol = %d, want the measured %d", res.Protocol, tt.protocol)
				}
				if !strings.Contains(err.Error(), "0.8.0") {
					t.Errorf("error %q does not carry the server version", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("CheckProtocol: %v", err)
			}
			if res.Protocol != tt.protocol || res.Version != "0.8.0" {
				t.Errorf("ping result = %+v", res)
			}
		})
	}
}

func TestCheckProtocolPropagatesDialFailure(t *testing.T) {
	c, err := New(Options{SocketPath: "/nonexistent/herdr.sock"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := CheckProtocol(context.Background(), c); !errors.Is(err, ErrServerUnavailable) {
		t.Fatalf("want ErrServerUnavailable, got %v", err)
	}
}

func TestAgentSendKeysNeverSendsNullKeys(t *testing.T) {
	srv := newFakeServer(t, func(req string) (string, bool) {
		return fmt.Sprintf(`{"id":%q,"result":{"type":"ok"}}`, idOf(req)), true
	})
	c := srv.client(t)

	if err := c.AgentSendKeys(context.Background(), "w1:p1", nil); err != nil {
		t.Fatalf("AgentSendKeys: %v", err)
	}
	reqs := srv.requests()
	if len(reqs) != 1 {
		t.Fatalf("want 1 request, got %d", len(reqs))
	}
	if !strings.Contains(reqs[0], `"keys":[]`) {
		t.Errorf("want an empty array, got %s", reqs[0])
	}
}

func TestNotificationShowOmitsEmptyBody(t *testing.T) {
	srv := newFakeServer(t, func(req string) (string, bool) {
		return fmt.Sprintf(`{"id":%q,"result":{"type":"notification_show","shown":true,"reason":"shown"}}`, idOf(req)), true
	})
	c := srv.client(t)

	if err := c.NotificationShow(context.Background(), "title", ""); err != nil {
		t.Fatalf("NotificationShow: %v", err)
	}
	if strings.Contains(srv.requests()[0], `"body"`) {
		t.Errorf("empty body must be omitted, got %s", srv.requests()[0])
	}
}
