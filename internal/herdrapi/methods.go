package herdrapi

import (
	"context"
	"fmt"
	"time"
)

// ---------- params ----------

type agentTargetParams struct {
	Target string `json:"target"`
}

type paneTargetParams struct {
	PaneID string `json:"pane_id"`
}

type agentReadParams struct {
	Target string     `json:"target"`
	Source ReadSource `json:"source"`
	Lines  *int       `json:"lines,omitempty"`
	// format is left out on purpose: it defaults to text server-side.
	// strip_ansi is left out because herdr accepts it and never applies it (G10).
}

type agentPromptParams struct {
	Target string      `json:"target"`
	Text   string      `json:"text"`
	Wait   *PromptWait `json:"wait,omitempty"`
}

type agentSendKeysParams struct {
	Target string   `json:"target"`
	Keys   []string `json:"keys"`
}

type notificationShowParams struct {
	Title string `json:"title"`
	Body  string `json:"body,omitempty"`
}

// ---------- results ----------
//
// herdr's result is internally tagged ({"type":"agent_list","agents":[...]}),
// so each result shape only needs its own payload field; the tag is ignored.

type agentListResult struct {
	Agents []AgentInfo `json:"agents"`
}

type agentInfoResult struct {
	Agent AgentInfo `json:"agent"`
}

type paneInfoResult struct {
	Pane PaneInfo `json:"pane"`
}

type paneReadResponse struct {
	Read paneReadResult `json:"read"`
}

type paneReadResult struct {
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
	// revision is deliberately not decoded: herdr hardcodes it to 0, so it
	// cannot be used for change detection (G10).
}

// ---------- methods ----------

func (c *socketClient) Ping(ctx context.Context) (PingResult, error) {
	var out PingResult
	if err := c.call(ctx, methodPing, nil, &out); err != nil {
		return PingResult{}, err
	}
	return out, nil
}

func (c *socketClient) AgentList(ctx context.Context) ([]AgentInfo, error) {
	var out agentListResult
	if err := c.call(ctx, methodAgentList, nil, &out); err != nil {
		return nil, err
	}
	return out.Agents, nil
}

func (c *socketClient) AgentGet(ctx context.Context, target string) (AgentInfo, error) {
	var out agentInfoResult
	if err := c.call(ctx, methodAgentGet, agentTargetParams{Target: target}, &out); err != nil {
		return AgentInfo{}, err
	}
	return out.Agent, nil
}

// AgentRead returns terminal text for target, discarding herdr's truncation
// flag. Use AgentReadFull (or ReadFull) when the caller can act on it.
func (c *socketClient) AgentRead(ctx context.Context, target string, src ReadSource, lines int) (string, error) {
	text, _, err := c.AgentReadFull(ctx, target, src, lines)
	return text, err
}

// AgentReadFull returns terminal text plus herdr's own truncated flag, which is
// the only signal that the buffer came back incomplete — S1 §3.3's Screen.Cropped
// covers our column cropping, not herdr-side truncation, so without this a
// half-captured dialog would be shown to the phone as if it were the whole thing.
//
// src is checked before anything is dialled: source=recent with lines beyond
// the viewport makes herdr synthesise real mouse-wheel events into the live
// pane for up to 15s, and the socket API gives no way to opt out (G9).
func (c *socketClient) AgentReadFull(ctx context.Context, target string, src ReadSource, lines int) (string, bool, error) {
	if err := checkReadSource(src); err != nil {
		return "", false, err
	}
	params := agentReadParams{Target: target, Source: src}
	if lines > 0 {
		params.Lines = &lines
	}
	var out paneReadResponse
	if err := c.call(ctx, methodAgentRead, params, &out); err != nil {
		return "", false, err
	}
	return out.Read.Text, out.Read.Truncated, nil
}

// ReadFull is AgentRead plus herdr's truncated flag for any Client that can
// report it; for one that cannot, truncated is false.
func ReadFull(ctx context.Context, c Client, target string, src ReadSource, lines int) (text string, truncated bool, err error) {
	type fullReader interface {
		AgentReadFull(ctx context.Context, target string, src ReadSource, lines int) (string, bool, error)
	}
	if fr, ok := c.(fullReader); ok {
		return fr.AgentReadFull(ctx, target, src, lines)
	}
	text, err = c.AgentRead(ctx, target, src, lines)
	return text, false, err
}

func checkReadSource(src ReadSource) error {
	switch src {
	case SourceVisible, SourceDetection:
		return nil
	default:
		return fmt.Errorf("%w (got %q)", ErrReadSourceForbidden, string(src))
	}
}

func (c *socketClient) PaneGet(ctx context.Context, paneID string) (PaneInfo, error) {
	var out paneInfoResult
	if err := c.call(ctx, methodPaneGet, paneTargetParams{PaneID: paneID}, &out); err != nil {
		return PaneInfo{}, err
	}
	return out.Pane, nil
}

// promptWaitHeadroom is added on top of the server-side wait window when
// sizing the read deadline for agent.prompt. herdr also sleeps
// AGENT_PROMPT_SUBMIT_DELAY (300ms) before writing Enter (G1) and is served by
// a single UI thread (G10), so the client deadline has to be the server's whole
// window plus slack.
const promptWaitHeadroom = 2 * time.Second

// defaultPromptEffectTimeout mirrors herdr's AGENT_PROMPT_EFFECT_TIMEOUT_MS,
// the window it uses when wait carries no timeout_ms (S1 §3.4.4).
const defaultPromptEffectTimeout = 5 * time.Second

// maxPromptWait caps the wait window we will believe. Past this, uint64
// milliseconds overflow time.Duration and the "deadline" lands in the past.
const maxPromptWait = 10 * time.Minute

// promptReadTimeout is the read deadline for one agent.prompt call.
//
// It must never be shorter than the time herdr will block before answering.
// Expiring early reports a transport failure for text that has *already* been
// pasted into the live agent, which is precisely the ambiguity the wait ack
// exists to remove (G3, S1 §3.4.3) — and herdr.call_timeout is a user-facing
// TOML knob validated only as non-negative, so base can be well under 8s.
func promptReadTimeout(base time.Duration, wait *PromptWait) time.Duration {
	if wait == nil {
		return base
	}
	server := defaultPromptEffectTimeout
	if wait.TimeoutMs != nil {
		if ms := *wait.TimeoutMs; ms > uint64(maxPromptWait/time.Millisecond) {
			server = maxPromptWait
		} else {
			server = time.Duration(ms) * time.Millisecond
		}
	}
	if want := server + promptWaitHeadroom; want > base {
		return want
	}
	return base
}

// AgentPrompt submits text to the agent.
//
// With a non-nil wait the call doubles as a delivery acknowledgement, and a
// agent_prompt_stalled reply means the text was NOT delivered — herdr's return
// value alone only says the bytes reached the PTY queue (G3). That case is
// reported as ErrPromptStalled, still carrying the *APIError.
func (c *socketClient) AgentPrompt(ctx context.Context, target, text string, wait *PromptWait) (AgentInfo, error) {
	var out agentInfoResult
	params := agentPromptParams{Target: target, Text: text, Wait: wait}
	err := c.callTimeout(ctx, methodAgentPrompt, params, &out, promptReadTimeout(c.timeout, wait))
	if err != nil {
		if IsCode(err, CodeAgentPromptStall) {
			return AgentInfo{}, fmt.Errorf("%w: %w", ErrPromptStalled, err)
		}
		return AgentInfo{}, err
	}
	return out.Agent, nil
}

func (c *socketClient) AgentSendKeys(ctx context.Context, target string, keys []string) error {
	if keys == nil {
		keys = []string{}
	}
	return c.call(ctx, methodAgentSendKeys, agentSendKeysParams{Target: target, Keys: keys}, nil)
}

func (c *socketClient) NotificationShow(ctx context.Context, title, body string) error {
	return c.call(ctx, methodNotificationShow, notificationShowParams{Title: title, Body: body}, nil)
}

// CheckProtocol pings the server and refuses anything older than MinProtocol.
//
// The PingResult is returned even on failure so the caller can print the
// version it actually found.
func CheckProtocol(ctx context.Context, c Client) (PingResult, error) {
	res, err := c.Ping(ctx)
	if err != nil {
		return PingResult{}, err
	}
	if res.Protocol < MinProtocol {
		return res, fmt.Errorf("%w: herdr %s speaks protocol %d, this bridge needs %d or newer",
			ErrProtocolTooOld, res.Version, res.Protocol, MinProtocol)
	}
	return res, nil
}
