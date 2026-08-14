package bridge

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/mirror"
)

// ---------- fixtures ----------

func assistantTurn(text string, tools ...string) mirror.PaneTurn {
	return mirror.PaneTurn{
		PaneID: testPane,
		Turn:   mirror.Turn{Role: "assistant", Text: text, ToolCalls: tools, At: epoch},
	}
}

func userTurn(text string) mirror.PaneTurn {
	return mirror.PaneTurn{
		PaneID: testPane,
		Turn:   mirror.Turn{Role: "user", Text: text, At: epoch},
	}
}

// openStreams reads what the fake bot handed out. The pump owns these objects
// while it runs, so every caller either drives the pump synchronously or joins
// it first.
func (f *fakeBot) openStreams() []*fakeStream {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*fakeStream(nil), f.streams...)
}

// onlyStream is the single message a pane's turns were mirrored into.
func onlyStream(t *testing.T, h *harness) *fakeStream {
	t.Helper()
	ss := h.bot.openStreams()
	if len(ss) != 1 {
		t.Fatalf("%d streams opened, want 1: consecutive assistant records are one turn, not one message each", len(ss))
	}
	return ss[0]
}

// content is everything that message ended up holding: the body it was opened
// with, plus every append.
func (s *fakeStream) content() string {
	return s.out.Markdown + strings.Join(s.chunks, "")
}

// mirrorNow makes the bridge's clock movable, which is how the end-of-turn
// sweep is tested without waiting ten real seconds for it.
func mirrorNow(h *harness) func(time.Time) {
	at := epoch
	h.b.deps.Now = func() time.Time { return at }
	return func(t time.Time) { at = t }
}

// ---------- the resolver adapter ----------

// TestPathResolverJoinsTheRegistryToTheTranscript.
//
// The mirror keys on a pane id and refuses to import the registry; the agents
// package keys on an Agent and knows nothing about chat. This adapter is the
// only thing that knows both, so it is the only thing that can answer "which
// file, read by which parser" (G8).
func TestPathResolverJoinsTheRegistryToTheTranscript(t *testing.T) {
	claude := idleAgent(testPane)
	codex := idleAgent(secondPane)
	codex.Kind = "codex"

	reg := newFakeRegistry()
	reg.setAgents(claude, codex)
	res := &fakeResolver{paths: map[string]string{
		testPane: "/Users/x/.claude/projects/-tmp-herdr-accept/cf67e552.jsonl",
		// secondPane resolves to nothing: an agent herdr has detected but
		// which has published no session ref yet. Normal, not an error (G8).
	}}

	r, err := NewPathResolver(reg, res)
	if err != nil {
		t.Fatalf("NewPathResolver: %v", err)
	}

	tests := []struct {
		name     string
		pane     string
		wantPath string
		wantKind string
		wantOK   bool
	}{
		{"resolvable", testPane, "/Users/x/.claude/projects/-tmp-herdr-accept/cf67e552.jsonl", "claude", true},
		{"no session ref yet", secondPane, "", "", false},
		{"pane herdr does not know", "w9:p9", "", "", false},
		{"no pane at all", "", "", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path, kind, ok := r.Resolve(tt.pane)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if path != tt.wantPath || kind != tt.wantKind {
				t.Errorf("= (%q, %q), want (%q, %q)", path, kind, tt.wantPath, tt.wantKind)
			}
		})
	}
}

// TestPathResolverTakesTheKindFromTheSameReadAsThePath: the parser must never
// be chosen from a different view of the pane than the file was, or a codex
// rollout gets read by the claude parser after a swap.
func TestPathResolverTakesTheKindFromTheSameReadAsThePath(t *testing.T) {
	a := idleAgent(testPane)
	a.Kind = "codex"

	reg := newFakeRegistry()
	reg.setAgents(a)

	r, err := NewPathResolver(reg, &fakeResolver{paths: map[string]string{testPane: "/x/rollout.jsonl"}})
	if err != nil {
		t.Fatalf("NewPathResolver: %v", err)
	}
	if _, kind, _ := r.Resolve(testPane); kind != "codex" {
		t.Fatalf("kind = %q, want the agent's own %q", kind, "codex")
	}
}

func TestNewPathResolverRejectsNilDependencies(t *testing.T) {
	if _, err := NewPathResolver(nil, &fakeResolver{}); !errors.Is(err, ErrMissingDep) {
		t.Errorf("nil registry: err = %v, want ErrMissingDep", err)
	}
	if _, err := NewPathResolver(newFakeRegistry(), nil); !errors.Is(err, ErrMissingDep) {
		t.Errorf("nil transcript resolver: err = %v, want ErrMissingDep", err)
	}
}

// ---------- turns into messages ----------

// TestConsecutiveAssistantRecordsBecomeOneMessage.
//
// A logical answer is several transcript records — text, then a tool call, then
// more text once the tool returned (G8). One Feishu message per record is the
// flood S2 §3.9 rules out, so the pane's message is opened once and edited.
func TestConsecutiveAssistantRecordsBecomeOneMessage(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	streams := map[string]*mirrorStream{}
	ctx := context.Background()

	h.b.mirrorTurn(ctx, streams, assistantTurn("Looking at that now."))
	h.b.mirrorTurn(ctx, streams, assistantTurn("", "Bash(touch /tmp/herdr-accept/p1.txt)"))
	h.b.mirrorTurn(ctx, streams, assistantTurn("Done."))

	s := onlyStream(t, h)
	if s.closed {
		t.Error("the message was closed while the turn was still being written")
	}
	for _, want := range []string{"Looking at that now.", "Bash(touch /tmp/herdr-accept/p1.txt)", "Done."} {
		if !strings.Contains(s.content(), want) {
			t.Errorf("the message does not contain %q:\n%s", want, s.content())
		}
	}
	if len(s.chunks) != 2 {
		t.Errorf("%d appends, want 2 (the first record opened the message)", len(s.chunks))
	}
	if got := len(h.bot.sends()); got != 0 {
		t.Errorf("%d separate messages were posted alongside the stream", got)
	}
}

// TestToolCallsAreMirroredAsTheParsersOneLiners.
//
// The summary is the parser's — `Bash(touch x.txt)` — and is passed through
// verbatim: it is already truncated to phone width, and it can contain
// backticks, so wrapping it in markup would break the line it exists to make
// readable. S2 §4.9 asks for collapsed one-liners and no box drawing.
func TestToolCallsAreMirroredAsTheParsersOneLiners(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	streams := map[string]*mirrorStream{}

	calls := []string{"Bash(touch /tmp/herdr-accept/p1.txt)", "Read(/etc/hosts)"}
	h.b.mirrorTurn(context.Background(), streams, assistantTurn("Two things:", calls...))

	body := onlyStream(t, h).content()
	for _, call := range calls {
		if !strings.Contains(body, toolBullet+call) {
			t.Errorf("tool call %q is not on its own line:\n%s", call, body)
		}
	}
	if strings.Contains(body, "\n"+calls[0]+" "+calls[1]) {
		t.Errorf("tool calls were run together:\n%s", body)
	}
}

// TestAUserTurnEndsTheAgentsMessageAndIsRoutable.
//
// The human speaking ends the agent's turn, so the open message is closed
// rather than having the two voices interleave in one bubble. It is posted
// rather than streamed, which is also what gives it a message id: replying to
// it in the chat routes back to this pane (S2 §3.5).
func TestAUserTurnEndsTheAgentsMessageAndIsRoutable(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	streams := map[string]*mirrorStream{}
	ctx := context.Background()

	h.b.mirrorTurn(ctx, streams, assistantTurn("Ready when you are."))
	h.b.mirrorTurn(ctx, streams, userTurn("now do the other thing"))

	if !onlyStream(t, h).closed {
		t.Error("the agent's message was left open after the human spoke")
	}
	if len(streams) != 0 {
		t.Errorf("the closed stream is still in the pump's map: %+v", streams)
	}

	sends := h.bot.sends()
	if len(sends) != 1 {
		t.Fatalf("%d messages posted for the user turn, want 1", len(sends))
	}
	if !strings.Contains(sends[0].Out.Markdown, "now do the other thing") {
		t.Errorf("the user turn was not mirrored: %+v", sends[0].Out)
	}
	if !strings.Contains(sends[0].Out.Title, "you") {
		t.Errorf("title %q does not say who spoke; every mirrored message comes from the same bot", sends[0].Out.Title)
	}
	bound := h.routes.boundPanes()
	if len(bound) != 1 || bound[0].PaneID != testPane || bound[0].MessageID != sends[0].ID {
		t.Fatalf("bindings = %+v, want %s -> %s so a reply routes back", bound, sends[0].ID, testPane)
	}
}

// TestTheTitleNamesTheAgentAndThePane: a phone can be watching several agents
// in one chat, and every mirrored message is sent by the same bot, so the role
// and the pane have to be in the message itself (S2 §4.9).
func TestTheTitleNamesTheAgentAndThePane(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	streams := map[string]*mirrorStream{}

	h.b.mirrorTurn(context.Background(), streams, assistantTurn("hello"))

	title := onlyStream(t, h).out.Title
	for _, want := range []string{"claude", testPane} {
		if !strings.Contains(title, want) {
			t.Errorf("stream title %q does not name %q", title, want)
		}
	}
}

// TestATurnFromAPaneHerdrForgotIsStillMirrored: a transcript outlives the
// process that wrote it, so the last turn can arrive just after the pane went
// away. Dropping it would lose the end of the conversation.
func TestATurnFromAPaneHerdrForgotIsStillMirrored(t *testing.T) {
	h := newHarness(t) // registry is empty
	streams := map[string]*mirrorStream{}

	h.b.mirrorTurn(context.Background(), streams, assistantTurn("all done"))

	s := onlyStream(t, h)
	if !strings.Contains(s.out.Title, testPane) {
		t.Errorf("title %q does not fall back to the pane id", s.out.Title)
	}
	if !strings.Contains(s.content(), "all done") {
		t.Errorf("the turn was dropped: %q", s.content())
	}
}

// TestAMirroredTableIsPostedRatherThanStreamed.
//
// Measured (S2 §3.8): a GitHub-style table makes Feishu's post renderer emit a
// BLANK bubble — delivered, empty, nothing reporting a failure. A stream is
// always rendered as a post, so a turn carrying a table cannot be streamed at
// all; it goes down the send path, which downgrades it to plain text. Agents
// write tables constantly, so this is not a corner case.
func TestAMirroredTableIsPostedRatherThanStreamed(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	streams := map[string]*mirrorStream{}

	table := "Here is the plan:\n\n| step | what |\n|---|---|\n| 1 | build |\n| 2 | test |"
	h.b.mirrorTurn(context.Background(), streams, assistantTurn(table))

	if got := len(h.bot.openStreams()); got != 0 {
		t.Fatalf("%d streams opened for a table; it would render as an empty bubble", got)
	}
	sends := h.bot.sends()
	if len(sends) != 1 {
		t.Fatalf("%d messages sent, want 1", len(sends))
	}
	if sends[0].Out.Markdown != "" {
		t.Errorf("the table was sent as markdown, which renders blank: %+v", sends[0].Out)
	}
	if !strings.Contains(sends[0].Out.Text, "build") {
		t.Errorf("the content did not survive the downgrade: %q", sends[0].Out.Text)
	}
}

// TestATableEndsTheOpenMessageFirst keeps the two halves of one answer in
// order: the streamed part is closed before the posted part goes out.
func TestATableEndsTheOpenMessageFirst(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	streams := map[string]*mirrorStream{}
	ctx := context.Background()

	h.b.mirrorTurn(ctx, streams, assistantTurn("comparing them"))
	h.b.mirrorTurn(ctx, streams, assistantTurn("| a | b |\n|---|---|\n| 1 | 2 |"))

	if !onlyStream(t, h).closed {
		t.Error("the streamed half was left open behind the posted half")
	}
}

// TestATurnWithNothingToSayIsNotMirrored: a record that carried no
// conversation must not produce an empty bubble.
func TestATurnWithNothingToSayIsNotMirrored(t *testing.T) {
	h := newHarness(t)
	streams := map[string]*mirrorStream{}

	h.b.mirrorTurn(context.Background(), streams, assistantTurn("   "))
	h.b.mirrorTurn(context.Background(), streams, userTurn(""))

	if got := len(h.bot.openStreams()); got != 0 {
		t.Errorf("%d streams opened for empty turns", got)
	}
	if got := len(h.bot.sends()); got != 0 {
		t.Errorf("%d messages sent for empty turns", got)
	}
}

// TestMirroringWithoutANotifyChatDropsTurns: there is nowhere to put them, and
// buffering for a chat that does not exist would grow forever. New warns about
// the missing chat at startup.
func TestMirroringWithoutANotifyChatDropsTurns(t *testing.T) {
	h := newHarness(t, func(d *Deps) { d.NotifyChatID = "" })
	streams := map[string]*mirrorStream{}

	h.b.mirrorTurn(context.Background(), streams, assistantTurn("hello"))

	if got := len(h.bot.openStreams()) + len(h.bot.sends()); got != 0 {
		t.Fatalf("%d messages went somewhere with no notify chat configured", got)
	}
}

// ---------- end of turn ----------

// TestAQuietTurnIsClosed. The transcript gives no end-of-turn marker, so the
// gap is the signal: an agent that has written nothing for mirrorTurnIdle has
// finished this turn, and Close is what flushes the message's last chunk.
func TestAQuietTurnIsClosed(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	setNow := mirrorNow(h)
	streams := map[string]*mirrorStream{}
	ctx := context.Background()

	h.b.mirrorTurn(ctx, streams, assistantTurn("thinking about it"))
	s := onlyStream(t, h)

	setNow(epoch.Add(mirrorTurnIdle - time.Millisecond))
	h.b.sweepMirrorStreams(ctx, streams)
	if s.closed {
		t.Fatal("the message was closed while the turn was still within its idle window")
	}

	setNow(epoch.Add(mirrorTurnIdle))
	h.b.sweepMirrorStreams(ctx, streams)
	if !s.closed {
		t.Fatal("a turn that went quiet was left open forever")
	}
	if len(streams) != 0 {
		t.Errorf("the closed stream is still in the pump's map: %+v", streams)
	}
}

// TestAnAppendResetsTheIdleWindow: a long turn must not be cut in half just
// because it started a while ago.
func TestAnAppendResetsTheIdleWindow(t *testing.T) {
	h := newHarness(t)
	setNow := mirrorNow(h)
	streams := map[string]*mirrorStream{}
	ctx := context.Background()

	h.b.mirrorTurn(ctx, streams, assistantTurn("first"))
	setNow(epoch.Add(mirrorTurnIdle - time.Second))
	h.b.mirrorTurn(ctx, streams, assistantTurn("second"))

	setNow(epoch.Add(mirrorTurnIdle + time.Second))
	h.b.sweepMirrorStreams(ctx, streams)

	if onlyStream(t, h).closed {
		t.Fatal("the message was closed one idle window after it opened, not after its last append")
	}
}

// TestShutdownClosesEveryOpenMessage. Close is what flushes a stream's last
// buffered text, so skipping it on the way out loses the tail of whatever each
// agent was saying (S2 §3.8: never fail silently).
func TestShutdownClosesEveryOpenMessage(t *testing.T) {
	h := newHarness(t)
	streams := map[string]*mirrorStream{}

	ctx, cancel := context.WithCancel(context.Background())
	h.b.mirrorTurn(ctx, streams, assistantTurn("one"))
	h.b.mirrorTurn(ctx, streams, mirror.PaneTurn{
		PaneID: secondPane,
		Turn:   mirror.Turn{Role: "assistant", Text: "two"},
	})
	cancel() // the pump's context is always finished by the time it closes up

	h.b.closeAllMirrorStreams(ctx, streams)

	ss := h.bot.openStreams()
	if len(ss) != 2 {
		t.Fatalf("%d streams, want one per pane", len(ss))
	}
	for i, s := range ss {
		if !s.closed {
			t.Errorf("stream %d was left open at shutdown", i)
		}
	}
}

// ---------- failures must not stop the mirror ----------

// TestAStreamThatWillNotOpenFallsBackToOneMessage.
//
// Mirroring is the cosmetic half of the product and must survive Feishu saying
// no (S2 §8) — but the content is why the mirror exists, so a stream that
// cannot be opened becomes an ordinary post rather than a dropped turn. That
// path also has the retry and downgrade rules Bot.Stream does not (S2 §3.8).
func TestAStreamThatWillNotOpenFallsBackToOneMessage(t *testing.T) {
	h := newHarness(t)
	flaky := &flakyBot{fakeBot: h.bot, streamErr: errors.New("feishu said no")}
	h.b.deps.Bot = flaky
	streams := map[string]*mirrorStream{}
	ctx := context.Background()

	h.b.mirrorTurn(ctx, streams, assistantTurn("this one is posted instead"))
	if len(streams) != 0 {
		t.Fatalf("a stream that failed to open was recorded anyway: %+v", streams)
	}
	sends := h.bot.sends()
	if len(sends) != 1 || !strings.Contains(sends[0].Out.Markdown, "posted instead") {
		t.Fatalf("the turn was lost rather than posted: %+v", sends)
	}
	if bound := h.routes.boundPanes(); len(bound) != 1 || bound[0].PaneID != testPane {
		t.Errorf("the fallback message was not bound to its pane: %+v", bound)
	}

	flaky.streamErr = nil
	h.b.mirrorTurn(ctx, streams, assistantTurn("this one gets through"))

	if got := onlyStream(t, h).content(); !strings.Contains(got, "gets through") {
		t.Fatalf("the mirror stopped after one failure: %q", got)
	}
}

// brokenStream is a message Feishu will not accept edits to any more — deleted,
// or older than it keeps. Only Append fails; Close still records itself, which
// is what the assertions below need to see.
type brokenStream struct{ *fakeStream }

func (s *brokenStream) Append(context.Context, string) error {
	return errors.New("feishu: message not found")
}

// appendFailingBot hands out those streams.
type appendFailingBot struct{ *fakeBot }

func (f *appendFailingBot) Stream(ctx context.Context, o lark.Out) (lark.Stream, error) {
	s, err := f.fakeBot.Stream(ctx, o)
	if err != nil {
		return nil, err
	}
	return &brokenStream{fakeStream: s.(*fakeStream)}, nil
}

// TestAFailedAppendStartsAFreshMessage: an append that fails takes the grouping
// with it, not the content.
func TestAFailedAppendStartsAFreshMessage(t *testing.T) {
	h := newHarness(t)
	h.b.deps.Bot = &appendFailingBot{fakeBot: h.bot}
	streams := map[string]*mirrorStream{}
	ctx := context.Background()

	h.b.mirrorTurn(ctx, streams, assistantTurn("first"))
	h.b.mirrorTurn(ctx, streams, assistantTurn("second")) // the append fails here
	h.b.mirrorTurn(ctx, streams, assistantTurn("third"))

	ss := h.bot.openStreams()
	if len(ss) != 2 {
		t.Fatalf("%d streams, want a fresh one after the append failed", len(ss))
	}
	if !ss[0].closed {
		t.Error("the broken stream was left open")
	}
	if !strings.Contains(ss[1].content(), "third") {
		t.Errorf("mirroring did not resume: %q", ss[1].content())
	}
}

// unclosableStream is a message that will not accept its final edit. It still
// records the Close so the assertions can see one was attempted.
type unclosableStream struct{ *fakeStream }

func (s *unclosableStream) Close(ctx context.Context) error {
	_ = s.fakeStream.Close(ctx)
	return errors.New("feishu: message not found")
}

type closeFailingBot struct{ *fakeBot }

func (f *closeFailingBot) Stream(ctx context.Context, o lark.Out) (lark.Stream, error) {
	s, err := f.fakeBot.Stream(ctx, o)
	if err != nil {
		return nil, err
	}
	return &unclosableStream{fakeStream: s.(*fakeStream)}, nil
}

// TestAStreamThatWillNotCloseIsStillLetGo: keeping it would send every later
// turn of that pane into a message Feishu has already refused to edit, and the
// mirror would go quiet without saying so.
func TestAStreamThatWillNotCloseIsStillLetGo(t *testing.T) {
	h := newHarness(t)
	h.b.deps.Bot = &closeFailingBot{fakeBot: h.bot}
	streams := map[string]*mirrorStream{}
	ctx := context.Background()

	h.b.mirrorTurn(ctx, streams, assistantTurn("one"))
	h.b.mirrorTurn(ctx, streams, userTurn("stop there")) // closes the stream

	if len(streams) != 0 {
		t.Fatalf("a stream that would not close was kept: %+v", streams)
	}

	h.b.mirrorTurn(ctx, streams, assistantTurn("two"))
	ss := h.bot.openStreams()
	if len(ss) != 2 {
		t.Fatalf("%d streams, want a fresh one for the next turn", len(ss))
	}
	if !strings.Contains(ss[1].content(), "two") {
		t.Errorf("mirroring did not resume: %q", ss[1].content())
	}
}

// TestAFailedSendDoesNotStopTheMirror: same rule for the posted half.
func TestAFailedSendDoesNotStopTheMirror(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(failing(errors.New("permanent")))
	streams := map[string]*mirrorStream{}
	ctx := context.Background()

	h.b.mirrorTurn(ctx, streams, userTurn("this one is lost"))
	h.b.mirrorTurn(ctx, streams, assistantTurn("this one gets through"))

	if got := onlyStream(t, h).content(); !strings.Contains(got, "gets through") {
		t.Fatalf("the mirror stopped after a failed send: %q", got)
	}
}

// ---------- the loop ----------

// TestThePumpDrainsAndClosesWhenTheWatcherStops.
//
// Closing the turn channel is the watcher's way of saying it has stopped. The
// channel's own ordering guarantees the queued turn is read first, so this
// exercises the loop end to end without a clock or a sleep.
func TestThePumpDrainsAndClosesWhenTheWatcherStops(t *testing.T) {
	h := newHarness(t)
	// A nil tick channel blocks forever, which takes the sweep out of a test
	// about draining.
	h.b.newTicker = func(time.Duration) (<-chan time.Time, func()) { return nil, func() {} }

	h.watcher.turns <- assistantTurn("mirrored from the loop")
	close(h.watcher.turns)

	done := make(chan struct{})
	go func() { defer close(done); h.b.pumpMirror(context.Background()) }()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("pumpMirror did not return when the watcher stopped")
	}

	s := onlyStream(t, h)
	if !strings.Contains(s.content(), "mirrored from the loop") {
		t.Errorf("the queued turn was not mirrored: %q", s.content())
	}
	if !s.closed {
		t.Error("the pump left a message open on the way out")
	}
}

// TestThePumpStopsWithItsContext.
func TestThePumpStopsWithItsContext(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() { defer close(done); h.b.pumpMirror(ctx) }()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("pumpMirror ignored a cancelled context")
	}
}

// TestRunStartsTheMirrorPump proves the wiring: a turn produced before the
// bridge is up is still mirrored, because the pump starts with Run rather than
// waiting for the WebSocket to be ready.
func TestRunStartsTheMirrorPump(t *testing.T) {
	h := newHarness(t)
	opened := make(chan struct{}, 1)
	h.b.deps.Bot = &flakyBot{fakeBot: h.bot, opened: opened}
	h.watcher.turns <- assistantTurn("hello from before the connection")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- h.b.Run(ctx) }()

	select {
	case <-opened:
	case err := <-done:
		t.Fatalf("Run returned before the mirror pump did anything: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("Run never started the mirror pump")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}
}

// TestMirrorCommandDrivesTheWatcher is the /mirror half of this file: the
// command is what arms and disarms a pane, and it is off by default so a
// chatty agent cannot flood the chat (S2 §3.9).
func TestMirrorCommandDrivesTheWatcher(t *testing.T) {
	h := newHarness(t)
	a := idleAgent(testPane)
	h.reg.setAgents(a)
	ctx := context.Background()

	if h.watcher.Enabled(testPane) {
		t.Fatal("mirroring was on before anyone asked for it")
	}
	if err := h.b.handleMessage(ctx, inbound("/mirror "+testPane+" on")); err != nil {
		t.Fatalf("/mirror on: %v", err)
	}
	if !h.watcher.Enabled(testPane) {
		t.Fatal("/mirror on did not enable the watcher")
	}
	if err := h.b.handleMessage(ctx, inbound("/mirror "+testPane+" off")); err != nil {
		t.Fatalf("/mirror off: %v", err)
	}
	if h.watcher.Enabled(testPane) {
		t.Fatal("/mirror off did not disable the watcher")
	}
}

// TestMirrorBodyRendersSaidThenDone is a table over the shapes a Turn arrives
// in, because the parsers produce all of them (G8).
func TestMirrorBodyRendersSaidThenDone(t *testing.T) {
	tests := []struct {
		name string
		turn mirror.Turn
		want string
	}{
		{"text only", mirror.Turn{Text: "hello"}, "hello"},
		{"tools only", mirror.Turn{ToolCalls: []string{"Bash(ls)"}}, toolBullet + "Bash(ls)"},
		{"both", mirror.Turn{Text: "running it", ToolCalls: []string{"Bash(ls)"}}, "running it\n\n" + toolBullet + "Bash(ls)"},
		{"two tools", mirror.Turn{ToolCalls: []string{"Bash(ls)", "Read(x)"}}, toolBullet + "Bash(ls)\n" + toolBullet + "Read(x)"},
		{"blank tool summary", mirror.Turn{Text: "hi", ToolCalls: []string{"  "}}, "hi"},
		{"nothing", mirror.Turn{}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := mirrorBody(tt.turn); got != tt.want {
				t.Errorf("mirrorBody = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestMirrorTitleNamesTheRole: the two roles must not read as one voice.
func TestMirrorTitleNamesTheRole(t *testing.T) {
	a := agents.Agent{PaneID: testPane, Kind: "claude", Cwd: "/tmp/herdr-accept"}
	assistant := mirrorTitle(a, "assistant")
	user := mirrorTitle(a, "user")

	if assistant == user {
		t.Fatalf("both roles render as %q", assistant)
	}
	for _, title := range []string{assistant, user} {
		if !strings.Contains(title, testPane) {
			t.Errorf("title %q does not name the pane", title)
		}
	}
}
