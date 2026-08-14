package herdrapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const pongLine = `{"id":"%s","result":{"type":"pong","version":"0.8.0","protocol":19}}`

// echoPong answers any request with a pong carrying the request's own id.
func echoPong(request string) (string, bool) {
	var req struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(request), &req); err != nil {
		return `{"id":"","error":{"code":"invalid_request","message":"bad json"}}`, true
	}
	return fmt.Sprintf(pongLine, req.ID), true
}

// G10: one connection, one request. A reused connection wedges on the second
// request, so every call must dial its own and close it.
func TestCallUsesOneConnectionPerRequest(t *testing.T) {
	srv := newFakeServer(t, echoPong)
	c := srv.client(t)

	for i := 0; i < 2; i++ {
		if _, err := c.Ping(context.Background()); err != nil {
			t.Fatalf("ping %d: %v", i, err)
		}
	}

	conns := waitForConns(t, srv, 2)
	if len(conns) != 2 {
		t.Fatalf("want 2 connections, got %d", len(conns))
	}
	for i, conn := range conns {
		if len(conn.lines) != 1 {
			t.Errorf("connection %d carried %d lines, want exactly 1: %q", i, len(conn.lines), conn.lines)
		}
		if !conn.sawEOF {
			t.Errorf("connection %d was not closed by the client after its single request", i)
		}
	}
}

// G10: the id must be a JSON string. A number is answered with
// invalid_request, so this is not a style preference.
func TestRequestIDIsAJSONString(t *testing.T) {
	srv := newFakeServer(t, echoPong)
	c := srv.client(t)

	for i := 0; i < 3; i++ {
		if _, err := c.Ping(context.Background()); err != nil {
			t.Fatalf("ping: %v", err)
		}
	}

	reqs := srv.requests()
	if len(reqs) != 3 {
		t.Fatalf("want 3 requests, got %d", len(reqs))
	}
	var previous uint64
	for i, line := range reqs {
		var raw map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			t.Fatalf("request %d is not JSON: %v", i, err)
		}
		id, ok := raw["id"]
		if !ok {
			t.Fatalf("request %d has no id: %s", i, line)
		}
		if len(id) == 0 || id[0] != '"' {
			t.Fatalf("request %d id is not a JSON string: %s", i, id)
		}
		var s string
		if err := json.Unmarshal(id, &s); err != nil {
			t.Fatalf("request %d id: %v", i, err)
		}
		if !strings.HasPrefix(s, idPrefix) {
			t.Errorf("request %d id %q lacks prefix %q", i, s, idPrefix)
		}
		var n uint64
		if _, err := fmt.Sscanf(s, idPrefix+"%d", &n); err != nil {
			t.Fatalf("request %d id %q is not %s<counter>: %v", i, s, idPrefix, err)
		}
		if n <= previous {
			t.Errorf("request %d id %q did not advance past %d", i, s, previous)
		}
		previous = n
		// herdr's schema marks params required for every method, ping included.
		if _, ok := raw["params"]; !ok {
			t.Errorf("request %d has no params object: %s", i, line)
		}
	}
}

// G10: herdr has no server-side timeout and is served by its single UI thread.
// A modal dialog on the desktop means we simply never get an answer.
//
// The call runs in a goroutine on purpose: asserting on elapsed time after it
// returns cannot fail if the deadline is dropped, it can only hang until the
// whole package's -timeout fires and dumps goroutines.
func TestReadTimeout(t *testing.T) {
	srv := newFakeServer(t, func(string) (string, bool) { return "", false })
	c := srv.client(t)
	c.timeout = 60 * time.Millisecond

	errc := make(chan error, 1)
	go func() {
		_, err := c.Ping(context.Background())
		errc <- err
	}()

	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("want a timeout error, got nil")
		}
		if !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("want os.ErrDeadlineExceeded, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Ping did not honour the read deadline")
	}
}

// G10: a connect can block just as a read can — a wedged UI thread stops
// accepting, and a socket on a hung mount never completes. Every method here is
// reachable with context.Background(), so the dial needs its own bound.
func TestDialIsBounded(t *testing.T) {
	var got time.Duration
	c := &socketClient{
		socketPath: "/nonexistent.sock",
		timeout:    1234 * time.Millisecond,
		dial: func(_ context.Context, _ string, timeout time.Duration) (net.Conn, error) {
			got = timeout
			return nil, errors.New("refused")
		},
	}

	if _, err := c.Ping(context.Background()); !errors.Is(err, ErrServerUnavailable) {
		t.Fatalf("want ErrServerUnavailable, got %v", err)
	}
	if got != c.timeout {
		t.Errorf("dial timeout = %s, want the call budget %s", got, c.timeout)
	}
}

// The production dialer must apply that budget and stay context-aware. Neither
// can be observed through a real connect: a hanging connect is not reproducible
// in process, and every reachable path answers immediately.
func TestDialUnixAppliesTheTimeout(t *testing.T) {
	if got := unixDialer(7 * time.Second).Timeout; got != 7*time.Second {
		t.Errorf("dialer timeout = %s, want 7s; the call budget is not reaching connect()", got)
	}

	srv := newFakeServer(t, echoPong)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := dialUnix(ctx, srv.path, time.Minute); !errors.Is(err, context.Canceled) {
		t.Errorf("dialUnix ignored the caller's cancellation: %v", err)
	}
}

func TestDeadlinesAreSet(t *testing.T) {
	conn := &scriptedConn{response: []byte(fmt.Sprintf(pongLine, "ha-1") + "\n")}
	c := &socketClient{
		socketPath: "/nonexistent.sock",
		timeout:    3 * time.Second,
		dial:       func(context.Context, string, time.Duration) (net.Conn, error) { return conn, nil },
	}

	before := time.Now()
	if _, err := c.Ping(context.Background()); err != nil {
		t.Fatalf("ping: %v", err)
	}

	wantWrite := before.Add(WriteDeadline)
	if d := conn.writeDeadline.Sub(wantWrite); d < -time.Second || d > time.Second {
		t.Errorf("write deadline %v is not ~now+%s", conn.writeDeadline, WriteDeadline)
	}
	wantRead := before.Add(3 * time.Second)
	if d := conn.readDeadline.Sub(wantRead); d < -time.Second || d > time.Second {
		t.Errorf("read deadline %v is not ~now+timeout", conn.readDeadline)
	}
	if conn.closes == 0 {
		t.Error("connection was not closed")
	}
}

func TestContextDeadlineClampsBothDeadlines(t *testing.T) {
	conn := &scriptedConn{response: []byte(fmt.Sprintf(pongLine, "ha-1") + "\n")}
	c := &socketClient{
		socketPath: "/nonexistent.sock",
		timeout:    time.Hour,
		dial:       func(context.Context, string, time.Duration) (net.Conn, error) { return conn, nil },
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	ctxDeadline, _ := ctx.Deadline()
	if _, err := c.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}
	if conn.readDeadline.After(ctxDeadline) {
		t.Errorf("read deadline %v exceeds the caller's %v", conn.readDeadline, ctxDeadline)
	}
	if conn.writeDeadline.After(ctxDeadline) {
		t.Errorf("write deadline %v exceeds the caller's %v", conn.writeDeadline, ctxDeadline)
	}
}

func TestErrorUnionDecoding(t *testing.T) {
	tests := []struct {
		name     string
		response func(string) (string, bool)
		wantCode string
		wantMsg  string
	}{
		{
			name: "not_found",
			response: func(req string) (string, bool) {
				return `{"id":"` + idOf(req) + `","error":{"code":"not_found","message":"agent target w9:p9 not found"}}`, true
			},
			wantCode: CodeNotFound,
			wantMsg:  "agent target w9:p9 not found",
		},
		{
			name: "agent_not_idle",
			response: func(req string) (string, bool) {
				return `{"id":"` + idOf(req) + `","error":{"code":"agent_not_idle","message":"agent is blocked"}}`, true
			},
			wantCode: CodeAgentNotIdle,
			wantMsg:  "agent is blocked",
		},
		{
			// G10: a request herdr cannot parse comes back with an EMPTY id.
			// Matching ids on the error branch would hide the real error.
			name: "invalid_request has an empty id",
			response: func(string) (string, bool) {
				return `{"id":"","error":{"code":"invalid_request","message":"invalid request: invalid type: integer"}}`, true
			},
			wantCode: CodeInvalidRequest,
			wantMsg:  "invalid request: invalid type: integer",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newFakeServer(t, tt.response)
			c := srv.client(t)

			_, err := c.AgentGet(context.Background(), "w1:p1")
			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Fatalf("want *APIError, got %#v", err)
			}
			if apiErr.Code != tt.wantCode {
				t.Errorf("code = %q, want %q", apiErr.Code, tt.wantCode)
			}
			if apiErr.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", apiErr.Message, tt.wantMsg)
			}
			if !IsCode(err, tt.wantCode) {
				t.Errorf("IsCode(%q) = false", tt.wantCode)
			}
		})
	}
}

func TestResponseIDMismatchOnSuccessIsRejected(t *testing.T) {
	srv := newFakeServer(t, func(string) (string, bool) {
		return fmt.Sprintf(pongLine, "somebody-elses-id"), true
	})
	c := srv.client(t)

	if _, err := c.Ping(context.Background()); err == nil {
		t.Fatal("want an id mismatch error, got nil")
	} else if !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("want an id mismatch error, got %v", err)
	}
}

func TestResponseWithNeitherResultNorError(t *testing.T) {
	srv := newFakeServer(t, func(req string) (string, bool) {
		return `{"id":"` + idOf(req) + `"}`, true
	})
	c := srv.client(t)

	if _, err := c.Ping(context.Background()); err == nil || !strings.Contains(err.Error(), "neither result nor error") {
		t.Fatalf("want a malformed-response error, got %v", err)
	}
}

func TestServerUnavailable(t *testing.T) {
	dir, err := os.MkdirTemp("", "hapi")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	c, err := New(Options{SocketPath: filepath.Join(dir, "nothing.sock")})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := c.Ping(context.Background()); !errors.Is(err, ErrServerUnavailable) {
		t.Fatalf("want ErrServerUnavailable, got %v", err)
	}
}

// G10: herdr drops a connection whose request line exceeds 1 MiB without
// writing an error, so refusing locally is the only way the caller learns why.
func TestOversizeRequestIsRefusedWithoutDialling(t *testing.T) {
	srv := newFakeServer(t, echoPong)
	c := srv.client(t)

	huge := strings.Repeat("x", MaxRequestBytes)
	_, err := c.AgentPrompt(context.Background(), "w1:p1", huge, nil)
	if !errors.Is(err, ErrRequestTooLarge) {
		t.Fatalf("want ErrRequestTooLarge, got %v", err)
	}
	if conns := srv.connections(); len(conns) != 0 {
		t.Fatalf("client dialled %d times for a request it should have refused", len(conns))
	}
}

func TestForbiddenMethodCannotBeSent(t *testing.T) {
	srv := newFakeServer(t, echoPong)
	c := srv.client(t)

	for _, method := range ForbiddenMethods {
		if _, ok := allowedMethods[method]; ok {
			t.Errorf("%q is both forbidden and whitelisted", method)
		}
		err := c.call(context.Background(), method, nil, nil)
		if err == nil || !strings.Contains(err.Error(), "not whitelisted") {
			t.Errorf("call(%q) = %v, want a whitelist rejection", method, err)
		}
	}
	if conns := srv.connections(); len(conns) != 0 {
		t.Fatalf("a forbidden method reached the socket (%d connections)", len(conns))
	}
}

// S1 §3.2: transport failures drive degraded + 5s backoff + a full
// reconciliation. A caller cancelling its own request is not a transport
// failure and must not be reported as one, on any step of the call.
func TestCancelledContextIsReported(t *testing.T) {
	tests := []struct {
		name string
		ctx  func(t *testing.T) context.Context
	}{
		{
			name: "cancelled before the dial",
			ctx: func(t *testing.T) context.Context {
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				return ctx
			},
		},
		{
			name: "cancelled while waiting for the answer",
			ctx: func(t *testing.T) context.Context {
				ctx, cancel := context.WithCancel(context.Background())
				t.Cleanup(cancel)
				go func() {
					time.Sleep(20 * time.Millisecond)
					cancel()
				}()
				return ctx
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := newFakeServer(t, func(string) (string, bool) { return "", false })
			c := srv.client(t)

			_, err := c.Ping(tt.ctx(t))
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("want context.Canceled, got %v", err)
			}
			if errors.Is(err, ErrServerUnavailable) {
				t.Errorf("a self-inflicted cancellation was reported as a dead server: %v", err)
			}
		})
	}
}

// S1 §3.6: doctor must print the socket it is dialling, and it only holds a
// Client. Re-resolving would print the wrong path whenever Options.SocketPath
// came from herdr.socket_path in config.toml.
func TestSocketPathOf(t *testing.T) {
	c, err := New(Options{SocketPath: "/tmp/configured.sock"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got := SocketPathOf(c); got != "/tmp/configured.sock" {
		t.Errorf("SocketPathOf(socketClient) = %q, want the configured path", got)
	}
	if got := SocketPathOf(&RecordingClient{}); got != RecordingSocketPath {
		t.Errorf("SocketPathOf(RecordingClient) = %q, want %q", got, RecordingSocketPath)
	}
	if got := SocketPathOf(pathlessClient{}); got != "" {
		t.Errorf("SocketPathOf(pathless) = %q, want an empty string", got)
	}
}

// pathlessClient is a Client with no SocketPath accessor.
type pathlessClient struct{ Client }

func TestCloseIsIdempotent(t *testing.T) {
	c, err := New(Options{SocketPath: "/tmp/whatever.sock"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("first close: %v", err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
}

func TestNewDefaults(t *testing.T) {
	c, err := New(Options{SocketPath: "/tmp/whatever.sock"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	sc := c.(*socketClient)
	if sc.timeout != DefaultTimeout {
		t.Errorf("timeout = %s, want %s", sc.timeout, DefaultTimeout)
	}
	if sc.SocketPath() != "/tmp/whatever.sock" {
		t.Errorf("socket path = %q", sc.SocketPath())
	}
}

// ---------- helpers ----------

// oneLine compacts JSON so a readable multi-line fixture can still be written
// as a single protocol line.
func oneLine(t *testing.T, s string) string {
	t.Helper()
	var buf bytes.Buffer
	if err := json.Compact(&buf, []byte(s)); err != nil {
		t.Fatalf("compact fixture: %v", err)
	}
	return buf.String()
}

func idOf(request string) string {
	var req struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal([]byte(request), &req)
	return req.ID
}

// waitForConns waits briefly for the server goroutines to observe EOF.
func waitForConns(t *testing.T, srv *fakeServer, want int) []connLog {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		conns := srv.connections()
		done := len(conns) >= want
		for _, c := range conns {
			if !c.sawEOF {
				done = false
			}
		}
		if done || time.Now().After(deadline) {
			return conns
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// scriptedConn is a net.Conn that records the deadlines set on it.
type scriptedConn struct {
	response      []byte
	read          int
	written       bytes.Buffer
	writeDeadline time.Time
	readDeadline  time.Time
	closes        int
}

func (c *scriptedConn) Read(p []byte) (int, error) {
	if c.read >= len(c.response) {
		return 0, errors.New("EOF")
	}
	n := copy(p, c.response[c.read:])
	c.read += n
	return n, nil
}

func (c *scriptedConn) Write(p []byte) (int, error) { return c.written.Write(p) }
func (c *scriptedConn) Close() error                { c.closes++; return nil }
func (c *scriptedConn) LocalAddr() net.Addr         { return fakeAddr{} }
func (c *scriptedConn) RemoteAddr() net.Addr        { return fakeAddr{} }
func (c *scriptedConn) SetDeadline(t time.Time) error {
	c.readDeadline, c.writeDeadline = t, t
	return nil
}
func (c *scriptedConn) SetReadDeadline(t time.Time) error  { c.readDeadline = t; return nil }
func (c *scriptedConn) SetWriteDeadline(t time.Time) error { c.writeDeadline = t; return nil }

type fakeAddr struct{}

func (fakeAddr) Network() string { return "unix" }
func (fakeAddr) String() string  { return "fake" }
