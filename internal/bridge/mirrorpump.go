package bridge

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/mirror"
	"github.com/hewenyu/herdr-agent/internal/outbound"
)

const (
	// mirrorRoleAssistant is the role whose turns are streamed into one edited
	// message. Everything else — in practice "user" — is posted as its own.
	mirrorRoleAssistant = "assistant"

	// mirrorTurnIdle is how long a pane's open message waits for more of the
	// same turn before it is closed.
	//
	// A turn is several transcript records, not one: claude writes a record per
	// content block, so a single answer arrives as text, then a tool call, then
	// more text after the tool returns (G8). Posting one Feishu message per
	// record is the flood S2 §3.9 rules out, hence one open message per pane —
	// but "open forever" is not a turn either, and the gap across a tool call is
	// the only end-of-turn signal a transcript gives us.
	mirrorTurnIdle = 10 * time.Second

	// mirrorSweep is how often the pump looks for a turn that has gone quiet.
	mirrorSweep = 2 * time.Second

	// mirrorCloseGrace bounds the final flush at shutdown.
	mirrorCloseGrace = 5 * time.Second

	// toolBullet prefixes a collapsed tool call. The summary itself is the
	// parser's — `Bash(touch x.txt)` — and is never re-formatted here: it may
	// contain backticks, and wrapping it in markup would break the line it is
	// supposed to make readable.
	toolBullet = "🔧 "
)

// NewPathResolver adapts the agent registry to what the mirror watcher needs.
//
// The two interfaces exist at different altitudes on purpose: agents keys
// everything on an Agent and knows nothing about chat, while mirror keys on a
// pane id and refuses to import the registry. This is the one place that knows
// both, so it is the one place that can turn a pane id into "which file, parsed
// by which parser".
//
// ok is false in two ordinary, non-error cases: herdr does not currently report
// an agent in that pane, or it does but the agent has published no session ref
// yet — for claude that gap lasts until its trust-this-directory prompt is
// accepted and SessionStart fires (G8). The watcher keeps asking, so both
// resolve themselves without anyone re-enabling anything.
//
// It is called from the watcher's tail loop while that loop holds its own lock,
// so it must not call back into the Watcher. Registry.Get and Resolve are both
// pure reads over state the registry poller owns.
func NewPathResolver(reg agents.Registry, res agents.TranscriptResolver) (mirror.PathResolver, error) {
	if reg == nil {
		return nil, fmt.Errorf("%w: NewPathResolver needs a Registry", ErrMissingDep)
	}
	if res == nil {
		return nil, fmt.Errorf("%w: NewPathResolver needs a TranscriptResolver", ErrMissingDep)
	}
	return paneResolver{reg: reg, res: res}, nil
}

type paneResolver struct {
	reg agents.Registry
	res agents.TranscriptResolver
}

var _ mirror.PathResolver = paneResolver{}

func (p paneResolver) Resolve(paneID string) (path, kind string, ok bool) {
	a, ok := p.reg.Get(paneID)
	if !ok {
		return "", "", false
	}
	path, ok = p.res.Resolve(a)
	if !ok {
		return "", "", false
	}
	// Kind comes from the same read as the path, so the parser can never be
	// chosen from a stale view of which agent is in the pane.
	return path, a.Kind, true
}

// mirrorStream is one Feishu message being edited as a pane keeps talking.
type mirrorStream struct {
	s lark.Stream
	// lastAt is when something was last appended, on the bridge's clock. It is
	// what decides that a turn has ended.
	lastAt time.Time
}

// pumpMirror turns mirrored transcript turns into chat messages until ctx ends
// or the watcher stops.
//
// Nothing in here may take the bridge down. The mirror is the cosmetic half of
// the product; the half that answers permission dialogs must keep working when
// a transcript is unreadable, a stream cannot be opened, or Feishu refuses a
// message (S2 §8). Every failure is logged and the next turn is still read.
//
// KNOWN LIMITATION, deliberate: a STREAMED assistant turn is not bound for
// reply-routing. S2 §3.9 asks for mirror output to be one edited message per
// turn via ch.Stream, and lark.Stream — a frozen contract, over an SDK
// controller that does not expose one either — reports no message id. S2 §3.5
// asks for every outbound message about an agent to be registered, and without
// an id there is nothing to register. Posting each record as its own message
// instead would bind them, at the cost of the flood §3.9 exists to prevent:
// claude writes a transcript record per content block, so one answer is several
// records.
//
// The consequence is visible only with two or more agents running, where a
// bare reply cannot fall back to "the only agent there is": replying to a
// mirrored turn resolves to ErrAmbiguous instead of the pane it came from. Both
// places the user meets that say so — the /mirror on confirmation and the
// ambiguity reply (inbound.go) — and the answer is /say <pane> <text>. Turns
// that go out through postTurn (a user turn, or one carrying a markdown table)
// ARE bound, because those have an id.
// The map of open streams is owned by this goroutine alone — no lock, and no
// other method may touch it.
func (b *bridge) pumpMirror(ctx context.Context) {
	turns := b.deps.Watcher.Turns()
	if turns == nil {
		b.log.Error("bridge: the mirror watcher offers no turn channel; nothing will be mirrored")
		return
	}
	if b.deps.NotifyChatID == "" {
		// Turns are still drained: the watcher drops them when its buffer fills
		// rather than blocking its tail loop, but leaving a channel unread for
		// the life of the process to rely on that is not a design.
		b.log.Warn("bridge: no notify_chat_id, so mirrored agent turns have nowhere to go")
	}

	streams := map[string]*mirrorStream{}
	defer b.closeAllMirrorStreams(ctx, streams)

	tick, stop := b.newTicker(mirrorSweep)
	defer stop()

	for {
		select {
		case <-ctx.Done():
			return

		case <-tick:
			b.sweepMirrorStreams(ctx, streams)

		case pt, ok := <-turns:
			if !ok {
				b.log.Warn("bridge: the mirror watcher stopped; agent transcripts are no longer mirrored")
				return
			}
			b.mirrorTurn(ctx, streams, pt)
		}
	}
}

// mirrorTurn publishes one turn.
func (b *bridge) mirrorTurn(ctx context.Context, streams map[string]*mirrorStream, pt mirror.PaneTurn) {
	if b.deps.NotifyChatID == "" {
		return
	}
	body := mirrorBody(pt.Turn)
	if body == "" {
		// A record that carried no conversation — a tool result, a metadata
		// line. The parsers drop most of those; this catches the rest.
		return
	}

	a := b.mirrorAgent(pt.PaneID)
	title := mirrorTitle(a, pt.Turn.Role)

	// Two things take a turn out of the pane's open message:
	//
	//   - the human spoke, which ends whatever the agent was saying;
	//   - the turn carries a markdown table, which makes the Feishu post
	//     renderer emit a BLANK bubble — delivered, empty, with nothing
	//     reporting a failure (S2 §3.8). A stream is always rendered as a post,
	//     so a table can only be shown by the send path, which downgrades the
	//     whole message to plain text.
	//
	// Both then produce a message id, so the message is bound to its pane and
	// replying to it in the chat routes straight back to that agent (S2 §3.5).
	// A streamed message cannot be bound: lark.Stream reports no id.
	if pt.Turn.Role != mirrorRoleAssistant || outbound.HasMarkdownTable(body) {
		b.closeMirrorStream(ctx, streams, pt.PaneID, "this turn goes out as its own message")
		b.postTurn(ctx, pt.PaneID, title, body)
		return
	}

	st, open := streams[pt.PaneID]
	if !open {
		s, err := b.deps.Bot.Stream(ctx, lark.Out{
			ChatID:   b.deps.NotifyChatID,
			Markdown: body,
			Title:    title,
		})
		if err != nil {
			// Post it instead of losing it. The send path is not the same code:
			// it retries the one failure class that cannot duplicate, downgrades
			// a payload Feishu will not render, and drops a dead reply target
			// (S2 §3.8) — none of which Bot.Stream does for the message it
			// opens with.
			b.log.Warn("bridge: could not open a mirror stream; posting this turn as one message",
				"pane", pt.PaneID, "err", err)
			b.postTurn(ctx, pt.PaneID, title, body)
			return
		}
		streams[pt.PaneID] = &mirrorStream{s: s, lastAt: b.now()}
		return
	}

	if err := st.s.Append(ctx, "\n\n"+body); err != nil {
		// Drop the stream rather than keep appending to something that is not
		// working: the next turn opens a fresh message, which loses the
		// grouping and keeps the content.
		b.log.Error("bridge: could not append to a mirror stream; starting a new message",
			"pane", pt.PaneID, "err", err)
		b.closeMirrorStream(ctx, streams, pt.PaneID, "an append failed")
		return
	}
	st.lastAt = b.now()
}

// postTurn mirrors one turn as a message of its own, bound to its pane.
func (b *bridge) postTurn(ctx context.Context, paneID, title, body string) {
	if _, err := b.send(ctx, outgoing{
		ChatID:   b.deps.NotifyChatID,
		Markdown: body,
		Title:    title,
		PaneID:   paneID,
	}); err != nil {
		b.log.Error("bridge: could not mirror a turn", "pane", paneID, "err", err)
	}
}

// sweepMirrorStreams closes the message of every pane that has gone quiet.
func (b *bridge) sweepMirrorStreams(ctx context.Context, streams map[string]*mirrorStream) {
	now := b.now()
	// Sorted so that a sweep closing several panes does it in the same order
	// every time; map order would make the log non-deterministic for no gain.
	for _, paneID := range slices.Sorted(maps.Keys(streams)) {
		if now.Sub(streams[paneID].lastAt) < mirrorTurnIdle {
			continue
		}
		b.closeMirrorStream(ctx, streams, paneID, "the turn went quiet")
	}
}

// closeAllMirrorStreams ends every open message on the way out.
func (b *bridge) closeAllMirrorStreams(ctx context.Context, streams map[string]*mirrorStream) {
	if len(streams) == 0 {
		return
	}
	// ctx is already finished by the time this runs — that is what ended the
	// pump — and Close is the call that flushes a stream's last buffered text.
	// Closing with a dead context would fail instantly and lose the tail of
	// whatever each agent was saying, so the flush gets its own short deadline.
	closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), mirrorCloseGrace)
	defer cancel()

	for _, paneID := range slices.Sorted(maps.Keys(streams)) {
		b.closeMirrorStream(closeCtx, streams, paneID, "the bridge is shutting down")
	}
}

// closeMirrorStream ends one pane's open message, if it has one.
//
// /mirror off does not come through here: it disables the watcher, and the
// pane's message is closed by the next sweep. A few seconds of an open message
// nobody is writing to is not worth a second path into this map, which only
// this goroutine may touch.
func (b *bridge) closeMirrorStream(ctx context.Context, streams map[string]*mirrorStream, paneID, why string) {
	st, ok := streams[paneID]
	if !ok {
		return
	}
	delete(streams, paneID)

	if err := st.s.Close(ctx); err != nil {
		// Close is what flushes the last chunk, so a failure here is content
		// the user never sees rather than a tidy-up problem (S2 §3.8: never
		// fail silently).
		b.log.Error("bridge: could not close a mirror stream; the end of that turn may be missing",
			"pane", paneID, "why", why, "err", err)
	}
}

// mirrorAgent describes the pane a turn came from, falling back to the bare
// pane id for an agent herdr has stopped reporting — the transcript outlives
// the process that wrote it, so a turn can arrive just after the pane went.
func (b *bridge) mirrorAgent(paneID string) agents.Agent {
	if a, ok := b.deps.Registry.Get(paneID); ok {
		return a
	}
	return agents.Agent{PaneID: paneID}
}

// mirrorTitle names the speaker.
//
// Every mirrored message comes from the same bot, so the role has to be in the
// content or the chat reads as one voice. The pane is in there too: a phone may
// be watching several agents in one chat (S2 §4.9).
func mirrorTitle(a agents.Agent, role string) string {
	if role == mirrorRoleAssistant {
		return "🤖 " + agentLabel(a)
	}
	return "🧑 you → " + agentLabel(a)
}

// mirrorBody renders one turn: what was said, then what was done.
//
// The text arrives already stripped of ANSI and box-drawing characters by the
// parser, which is what makes a transcript mirror readable where a screen
// capture is not (S2 §4.9). Tool calls arrive as the parser's collapsed
// one-liners and are passed through unchanged — a phone wants `Bash(touch
// x.txt)`, not the payload.
func mirrorBody(t mirror.Turn) string {
	parts := make([]string, 0, 2)
	if text := strings.TrimSpace(t.Text); text != "" {
		parts = append(parts, text)
	}

	lines := make([]string, 0, len(t.ToolCalls))
	for _, call := range t.ToolCalls {
		if c := strings.TrimSpace(call); c != "" {
			lines = append(lines, toolBullet+c)
		}
	}
	if len(lines) > 0 {
		parts = append(parts, strings.Join(lines, "\n"))
	}
	return strings.Join(parts, "\n\n")
}
