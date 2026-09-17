package herdrapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync/atomic"
	"time"
)

// idPrefix labels our request ids so they are recognisable in herdr's log.
// The id must be a JSON string: herdr answers a numeric id with
// invalid_request, and does so with an empty id (G10).
const idPrefix = "ha-"

// maxResponseBytes caps how much of a response line we will buffer. herdr
// bounds the request side, not the response side, and agent.read of a wide
// pane is already tens of kilobytes.
const maxResponseBytes = 16 << 20

// wireMethod names, all of them. Anything not in allowedMethods cannot be sent
// by this package; see the forbidden list in the Client doc comment.
const (
	methodPing             = "ping"
	methodAgentList        = "agent.list"
	methodAgentGet         = "agent.get"
	methodAgentRead        = "agent.read"
	methodAgentPrompt      = "agent.prompt"
	methodAgentSendKeys    = "agent.send_keys"
	methodPaneGet          = "pane.get"
	methodNotificationShow = "notification.show"
	methodWorkspaceCreate  = "workspace.create"
	methodWorkspaceList    = "workspace.list"
	methodAgentStart       = "agent.start"
	methodPaneClose        = "pane.close"
)

// allowedMethods enforces the whitelist at the transport boundary rather than
// by convention, so a new caller cannot reach agent.focus by accident.
var allowedMethods = map[string]struct{}{
	methodPing:             {},
	methodAgentList:        {},
	methodAgentGet:         {},
	methodAgentRead:        {},
	methodAgentPrompt:      {},
	methodAgentSendKeys:    {},
	methodPaneGet:          {},
	methodNotificationShow: {},
}

// Lifecycle calls have a separate whitelist, so the ordinary control surface
// cannot accidentally issue a create/start/close through call().
var lifecycleMethods = map[string]struct{}{
	methodWorkspaceCreate: {},
	methodWorkspaceList:   {},
	methodAgentStart:      {},
	methodPaneClose:       {},
}

// ErrReadSourceForbidden rejects a read source this bridge refuses to use.
//
// source=recent makes herdr synthesise real mouse-wheel events into the user's
// live pane for up to 15s, and socket clients cannot opt out of that: the
// intent field is #[serde(skip)] and always Interactive (G9).
var ErrReadSourceForbidden = errors.New("herdr read source not allowed: only visible and detection")

// ErrPromptStalled means agent.prompt was submitted but herdr never observed
// the agent react, i.e. the text was NOT delivered. agent.prompt only
// guarantees bytes entered the PTY queue, not that the TUI took them (G3).
var ErrPromptStalled = errors.New("agent.prompt stalled: text not delivered")

// ErrRequestTooLarge means we refused to send an oversized request line.
// herdr's limit is 1 MiB and it enforces it by dropping the connection with no
// error line at all (G10), so failing here is the only way to say why.
var ErrRequestTooLarge = errors.New("herdr request line too large")

// socketClient is the one implementation of Client that talks to herdr.
type socketClient struct {
	socketPath string
	timeout    time.Duration
	seq        atomic.Uint64

	// dial is a field so tests can supply a connection that reports which
	// deadlines were set. Production always uses dialUnix.
	dial func(ctx context.Context, path string, timeout time.Duration) (net.Conn, error)
}

var _ Client = (*socketClient)(nil)
var _ LifecycleClient = (*socketClient)(nil)
var _ ConfiguredLifecycleClient = (*socketClient)(nil)

// New returns a Client for the herdr API socket.
//
// It performs no IO: the server may legitimately start after us, and every
// call dials on its own anyway. Use CheckProtocol for a startup handshake.
func New(opts Options) (Client, error) {
	path := opts.SocketPath
	if path == "" {
		resolved, err := ResolveSocketPath()
		if err != nil {
			return nil, err
		}
		path = resolved
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	return &socketClient{socketPath: path, timeout: timeout, dial: dialUnix}, nil
}

// SocketPathOf reports the socket c dials, or "" for a Client that does not
// know. doctor has to print the socket it is actually talking to (S1 §3.6), and
// calling ResolveSocketPath again there would report the wrong path whenever
// Options.SocketPath came from herdr.socket_path in config.toml.
func SocketPathOf(c Client) string {
	if p, ok := c.(interface{ SocketPath() string }); ok {
		return p.SocketPath()
	}
	return ""
}

// SocketPath reports the socket this client dials. Useful in doctor output.
func (c *socketClient) SocketPath() string { return c.socketPath }

// Close releases cached resources. There are none: herdr hangs on the second
// request of a reused connection (G10), so every call owns its connection and
// closes it. Kept for the Client contract and safe to call repeatedly.
func (c *socketClient) Close() error { return nil }

// dialUnix bounds connect() with the same budget as the rest of the call.
// Callers routinely pass context.Background(), and a connect can block: the
// accept backlog of a server whose single UI thread is wedged behind a modal
// dialog fills up, and so does a socket path on a hung mount (G10). Without
// this the deadline machinery below would simply never be reached.
func dialUnix(ctx context.Context, path string, timeout time.Duration) (net.Conn, error) {
	return unixDialer(timeout).DialContext(ctx, "unix", path)
}

// unixDialer is split out of dialUnix so a test can assert the call budget
// really reaches the dialer. A connect that hangs cannot be reproduced in
// process — on darwin a full accept backlog answers ECONNREFUSED rather than
// blocking — so the plumbing is the only part that can be checked.
func unixDialer(timeout time.Duration) *net.Dialer { return &net.Dialer{Timeout: timeout} }

type wireRequest struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type wireResponse struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *APIError       `json:"error"`
}

// call performs one request with the client's default read timeout.
func (c *socketClient) call(ctx context.Context, method string, params, out any) error {
	return c.callTimeout(ctx, method, params, out, c.timeout)
}

// callTimeout performs exactly one request on exactly one connection: dial,
// write one line, read one line, close. Connections are never reused — the
// second request on a connection hangs silently forever (G10).
//
// readTimeout is separate from c.timeout because some methods block herdr
// server-side for a duration the caller chose: see AgentPrompt.
func (c *socketClient) callTimeout(ctx context.Context, method string, params, out any, readTimeout time.Duration) error {
	return c.callWhitelisted(ctx, method, params, out, readTimeout, allowedMethods)
}

func (c *socketClient) callLifecycle(ctx context.Context, method string, params, out any) error {
	return c.callWhitelisted(ctx, method, params, out, c.timeout, lifecycleMethods)
}

func (c *socketClient) callWhitelisted(ctx context.Context, method string, params, out any, readTimeout time.Duration, whitelist map[string]struct{}) error {
	if _, ok := whitelist[method]; !ok {
		return fmt.Errorf("herdrapi: method %q is not whitelisted", method)
	}
	line, id, err := c.encode(method, params)
	if err != nil {
		return err
	}
	if len(line) > MaxRequestBytes {
		return fmt.Errorf("herdrapi: %s: %w: %d bytes exceeds %d; herdr would drop the connection without answering",
			method, ErrRequestTooLarge, len(line), MaxRequestBytes)
	}

	conn, err := c.dial(ctx, c.socketPath, c.timeout)
	if err != nil {
		// A caller that cancelled its own request must not be told the server is
		// down: that misclassification pushes the Registry into degraded, with
		// 5s backoff and a full reconciliation, for nothing (S1 §3.2).
		if ctx.Err() != nil {
			return fmt.Errorf("herdrapi: %s: dial: %w", method, withCtxErr(ctx, err))
		}
		return fmt.Errorf("%w at %s: %w", ErrServerUnavailable, c.socketPath, err)
	}
	defer conn.Close()
	// A blocked herdr UI thread never answers and never closes; the only way
	// out of a blocking read is to close the socket from underneath it.
	defer context.AfterFunc(ctx, func() { _ = conn.Close() })()

	if err := c.write(ctx, conn, method, line); err != nil {
		return err
	}
	data, err := c.readLine(ctx, conn, method, readTimeout)
	if err != nil {
		return err
	}
	return decodeResponse(method, id, data, out)
}

func (c *socketClient) encode(method string, params any) (line []byte, id string, err error) {
	// herdr's request schema marks params as required for every method,
	// including ping, so a nil params becomes {} rather than being omitted.
	raw := json.RawMessage("{}")
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return nil, "", fmt.Errorf("herdrapi: encode %s params: %w", method, err)
		}
		raw = b
	}
	id = idPrefix + strconv.FormatUint(c.seq.Add(1), 10)
	b, err := json.Marshal(wireRequest{ID: id, Method: method, Params: raw})
	if err != nil {
		return nil, "", fmt.Errorf("herdrapi: encode %s request: %w", method, err)
	}
	return append(b, '\n'), id, nil
}

func (c *socketClient) write(ctx context.Context, conn net.Conn, method string, line []byte) error {
	if err := conn.SetWriteDeadline(deadline(ctx, WriteDeadline)); err != nil {
		return fmt.Errorf("herdrapi: %s: set write deadline: %w", method, err)
	}
	if _, err := conn.Write(line); err != nil {
		return fmt.Errorf("herdrapi: %s: write request: %w", method, withCtxErr(ctx, err))
	}
	return nil
}

func (c *socketClient) readLine(ctx context.Context, conn net.Conn, method string, readTimeout time.Duration) ([]byte, error) {
	if err := conn.SetReadDeadline(deadline(ctx, readTimeout)); err != nil {
		return nil, fmt.Errorf("herdrapi: %s: set read deadline: %w", method, err)
	}
	r := bufio.NewReader(io.LimitReader(conn, maxResponseBytes))
	data, err := r.ReadBytes('\n')
	switch {
	case err == nil:
	case errors.Is(err, io.EOF) && len(data) > 0:
		// herdr may close right after the payload without a trailing newline.
	case errors.Is(err, io.EOF):
		return nil, fmt.Errorf("herdrapi: %s: server closed the connection without answering: %w", method, err)
	default:
		return nil, fmt.Errorf("herdrapi: %s: read response: %w", method, withCtxErr(ctx, err))
	}
	if len(data) >= maxResponseBytes {
		return nil, fmt.Errorf("herdrapi: %s: response exceeds %d bytes", method, maxResponseBytes)
	}
	return data, nil
}

func decodeResponse(method, id string, data []byte, out any) error {
	var resp wireResponse
	if err := json.Unmarshal(bytes.TrimSpace(data), &resp); err != nil {
		return fmt.Errorf("herdrapi: %s: decode response: %w", method, err)
	}
	if resp.Error != nil {
		// The id is deliberately NOT checked here: when herdr cannot parse the
		// request it answers with an empty id (G10).
		return fmt.Errorf("herdrapi: %s: %w", method, resp.Error)
	}
	if resp.ID != id {
		return fmt.Errorf("herdrapi: %s: response id %q does not match request id %q", method, resp.ID, id)
	}
	if len(resp.Result) == 0 {
		return fmt.Errorf("herdrapi: %s: response carried neither result nor error", method)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(resp.Result, out); err != nil {
		return fmt.Errorf("herdrapi: %s: decode result: %w", method, err)
	}
	return nil
}

// deadline is now+d, clamped by the caller's own deadline.
func deadline(ctx context.Context, d time.Duration) time.Time {
	t := time.Now().Add(d)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(t) {
		return ctxDeadline
	}
	return t
}

// withCtxErr surfaces cancellation as such: closing the conn from AfterFunc
// otherwise turns it into an opaque "use of closed network connection".
func withCtxErr(ctx context.Context, err error) error {
	if cerr := ctx.Err(); cerr != nil {
		return fmt.Errorf("%w: %w", cerr, err)
	}
	return err
}

// IsCode reports whether err is an *APIError with the given herdr error code.
func IsCode(err error, code string) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Code == code
}
