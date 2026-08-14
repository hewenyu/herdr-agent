package bridge

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/cards"
	"github.com/hewenyu/herdr-agent/internal/commands"
	"github.com/hewenyu/herdr-agent/internal/lark"
)

// ---------- fixtures ----------

const (
	secondPane = "w2:p2"
	testMsgID  = "om_from_phone"
)

func idleAgent(paneID string) agents.Agent {
	return agents.Agent{
		PaneID:   paneID,
		Kind:     "claude",
		Status:   agents.StatusIdle,
		Cwd:      "/tmp/herdr-accept",
		Title:    "Create hello.txt with touch",
		StateSeq: 7,
	}
}

func workingAgent(paneID string) agents.Agent {
	a := idleAgent(paneID)
	a.Status = agents.StatusWorking
	a.StateSeq = 9
	return a
}

// inbound builds the message a phone sends.
func inbound(text string) lark.Msg {
	return lark.Msg{
		EventID:   "ev_1",
		MessageID: testMsgID,
		ChatID:    testChat,
		ChatType:  lark.ChatP2P,
		UserID:    testOwner,
		Text:      text,
	}
}

// ---------- fake helpers ----------
//
// The fakes themselves live in fakes_test.go; these are the accessors the
// dispatch tests need, kept here so that file stays the shared surface.

func (f *fakeRegistry) setAgents(list ...agents.Agent) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.agents = list
}

func (f *fakeController) setSay(d agents.Delivery, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sayResult, f.sayErr = d, err
}

func (f *fakeController) said() []sayCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sayCall(nil), f.says...)
}

// reset forgets what the controller has been asked to do, so a test can assert
// about one phase without counting the calls that set it up.
func (f *fakeController) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.says, f.keys, f.interrupts = nil, nil, nil
}

func (f *fakeController) interrupted() []agents.Guard {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]agents.Guard(nil), f.interrupts...)
}

// texts returns the plain-text bodies the bridge sent, in order.
func (f *fakeBot) texts() []string {
	out := []string{}
	for _, c := range f.sends() {
		if c.Out.Text != "" {
			out = append(out, c.Out.Text)
		}
		if c.Out.Markdown != "" {
			out = append(out, c.Out.Markdown)
		}
	}
	return out
}

func (f *fakeBot) cards() []string {
	out := []string{}
	for _, c := range f.sends() {
		if c.Out.Card != "" {
			out = append(out, c.Out.Card)
		}
	}
	return out
}

// lastText is the body of the final message, which is the one answering the
// user's command.
func lastText(t *testing.T, h *harness) string {
	t.Helper()
	texts := h.bot.texts()
	if len(texts) == 0 {
		t.Fatal("the bridge said nothing at all; the user is left waiting")
	}
	return texts[len(texts)-1]
}

// lastCard is the JSON of the final card, which for the picker is the whole
// answer: it is asserted as text because what matters is what the user can read
// and tap, not the element tree it is built from.
func lastCard(t *testing.T, h *harness) string {
	t.Helper()
	sent := h.bot.cards()
	if len(sent) == 0 {
		t.Fatal("the bridge sent no card; the picker is the primary interface")
	}
	return sent[len(sent)-1]
}

func wantContains(t *testing.T, got, want, why string) {
	t.Helper()
	if !strings.Contains(got, want) {
		t.Errorf("%s\nreply does not contain %q:\n%s", why, want, got)
	}
}

// assertNothingWasTyped is the assertion this whole package exists for: no key,
// no prose and no esc reached any agent.
func assertNothingWasTyped(t *testing.T, h *harness, why string) {
	t.Helper()
	if got := h.ctrl.said(); len(got) != 0 {
		t.Fatalf("%s: prose reached an agent: %+v", why, got)
	}
	if got := h.ctrl.sentKeys(); len(got) != 0 {
		t.Fatalf("%s: a key reached an agent: %+v", why, got)
	}
	if got := h.ctrl.interrupted(); len(got) != 0 {
		t.Fatalf("%s: esc reached an agent: %+v", why, got)
	}
}

// ---------- the rule that outranks everything else ----------

// TestAMalformedCommandNeverReachesTheProsePath is G1 at the routing layer.
//
// Measured: `herdr agent prompt w1:p1 "absolutely not, do NOT run this
// command"` against a Claude permission dialog CREATED the file it was
// refusing, because agent.prompt pastes text a menu discards and then presses
// Enter on the highlighted "1. Yes". So a slash line the parser could not
// understand must come back as an error. Demoting it to prose would type
// "/stpo w1:p1" at whatever dialog the agent is showing and approve it.
//
// The agent in the registry is BLOCKED on purpose: if any of these inputs found
// the prose path, that is exactly the pane it would land in.
func TestAMalformedCommandNeverReachesTheProsePath(t *testing.T) {
	malformed := []string{
		"/stpo w1:p1", // the acceptance script's deliberate typo (S2 §7)
		"/stop",       // recognised, no pane
		"/stop notapane",
		"/card",
		"/say",
		"/say w1:p1",      // pane, no text
		"/say stpo w1:p1", // the pane token is a typo, not a message
		"/mirror w1:p1",
		"/mirror w1:p1 maybe",
		"/mirror w1:p1 on off",
		"/",
		"／stpo w1:p1", // fullwidth solidus: what a Chinese IME gives you for "/"
		"/1",          // someone answering a dialog in the chat window
		"",
		"   ",
	}

	for _, text := range malformed {
		t.Run(text, func(t *testing.T) {
			h := newHarness(t)
			h.reg.setAgents(blockedAgent())

			if err := h.b.handleMessage(context.Background(), inbound(text)); err != nil {
				t.Fatalf("handleMessage: %v", err)
			}

			assertNothingWasTyped(t, h, "a command the parser refused")
			if got := len(h.bot.sends()); got != 1 {
				t.Fatalf("%d messages sent, want exactly one error reply", got)
			}
			reply := lastText(t, h)
			if reply == text {
				t.Fatal("the bridge echoed the input instead of explaining the refusal")
			}
			if want := commands.Parse(text).Reason; want != "" && !strings.Contains(reply, want) {
				t.Errorf("reply does not carry the parser's reason %q:\n%s", want, reply)
			}
		})
	}
}

// TestAnUnknownCommandGetsTheHelpTable: the user typed a slash and got nothing
// done. If the reply does not tell them the safe way to send text, they retype
// the line as prose — and prose at a blocked agent is an approval (G1).
func TestAnUnknownCommandGetsTheHelpTable(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(blockedAgent())

	if err := h.b.handleMessage(context.Background(), inbound("/stpo w1:p1")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	reply := lastText(t, h)
	wantContains(t, reply, commands.Help(), "an unknown command must come back with the command table")
	wantContains(t, reply, "/stop", "the reply should name the command they meant")
}

// ---------- the dispatch table ----------

func TestDispatchTable(t *testing.T) {
	tests := []struct {
		name  string
		text  string
		agent agents.Agent
		check func(t *testing.T, h *harness)
	}{
		{
			// /ls is the picker now, not a report. A plain-text list can only be
			// READ: aiming at an agent afterwards cost a long-press-and-reply or
			// typing "w1:p1" on a phone keyboard, and the common case is several
			// turns with ONE agent.
			name:  "ls answers with the picker card",
			text:  "/ls",
			agent: idleAgent(testPane),
			check: func(t *testing.T, h *harness) {
				assertNothingWasTyped(t, h, "/ls")
				card := lastCard(t, h)
				wantContains(t, card, testPane, "the picker must name the pane every other command takes")
				wantContains(t, card, "claude", "the picker must name the agent kind")
				wantContains(t, card, "herdr-accept", "the picker must say where the agent is working")
				wantContains(t, card, "Create hello.txt with touch", "the picker must show the task title")
				wantContains(t, card, cards.ActSelect, "every row must carry a select button")
				if got := h.bot.texts(); len(got) != 0 {
					t.Errorf("/ls also sent prose, which is a second bubble to scroll past: %v", got)
				}
			},
		},
		{
			name:  "help prints the table",
			text:  "/help",
			agent: idleAgent(testPane),
			check: func(t *testing.T, h *harness) {
				assertNothingWasTyped(t, h, "/help")
				if got := lastText(t, h); got != commands.Help() {
					t.Errorf("/help sent something other than the table:\n%s", got)
				}
			},
		},
		{
			name:  "doctor reports what the bridge can see",
			text:  "/doctor",
			agent: idleAgent(testPane),
			check: func(t *testing.T, h *harness) {
				assertNothingWasTyped(t, h, "/doctor")
				reply := lastText(t, h)
				wantContains(t, reply, "herdr", "/doctor must say whether herdr is answering")
				wantContains(t, reply, "herdr-agent doctor", "/doctor must point at the checks it cannot make from here")
			},
		},
		{
			name:  "say goes through the safe path",
			text:  "/say " + testPane + " please stop and explain",
			agent: idleAgent(testPane),
			check: func(t *testing.T, h *harness) {
				said := h.ctrl.said()
				if len(said) != 1 {
					t.Fatalf("%d Say calls, want 1", len(said))
				}
				if said[0].Text != "please stop and explain" {
					t.Errorf("Say text = %q", said[0].Text)
				}
				if said[0].Guard.PaneID != testPane || said[0].Guard.StateSeq != 7 {
					t.Errorf("guard = %+v, want the pane and state seq the user was looking at", said[0].Guard)
				}
			},
		},
		{
			name:  "stop sends esc and nothing else",
			text:  "/stop " + testPane,
			agent: blockedAgent(),
			check: func(t *testing.T, h *harness) {
				if got := h.ctrl.interrupted(); len(got) != 1 {
					t.Fatalf("%d Interrupt calls, want 1", len(got))
				}
				if got := h.ctrl.said(); len(got) != 0 {
					t.Fatalf("/stop also sent prose: %+v", got)
				}
				if got := h.ctrl.sentKeys(); len(got) != 0 {
					t.Fatalf("/stop sent a key through SendKey: %+v", got)
				}
			},
		},
		{
			name:  "mirror on enables the watcher",
			text:  "/mirror " + testPane + " on",
			agent: idleAgent(testPane),
			check: func(t *testing.T, h *harness) {
				if !h.watcher.Enabled(testPane) {
					t.Fatal("mirroring was not enabled")
				}
			},
		},
		{
			name:  "mirror off disables the watcher",
			text:  "/mirror " + testPane + " off",
			agent: idleAgent(testPane),
			check: func(t *testing.T, h *harness) {
				if h.watcher.Enabled(testPane) {
					t.Fatal("mirroring was not disabled")
				}
			},
		},
		{
			name:  "card pushes the screen",
			text:  "/card " + testPane,
			agent: blockedAgent(),
			check: func(t *testing.T, h *harness) {
				assertNothingWasTyped(t, h, "/card")
				if got := h.bot.cards(); len(got) != 1 {
					t.Fatalf("%d cards sent, want 1", len(got))
				}
			},
		},
		{
			name:  "prose reaches the only agent",
			text:  "just say hello",
			agent: idleAgent(testPane),
			check: func(t *testing.T, h *harness) {
				said := h.ctrl.said()
				if len(said) != 1 || said[0].Text != "just say hello" {
					t.Fatalf("Say calls = %+v", said)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.reg.setAgents(tt.agent)
			h.ex.dialog = permissionDialog()
			h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)
			if tt.text == "/mirror "+testPane+" off" {
				// Turning it off only proves something when it was on.
				if err := h.watcher.Enable(testPane); err != nil {
					t.Fatalf("Enable: %v", err)
				}
			}

			if err := h.b.handleMessage(context.Background(), inbound(tt.text)); err != nil {
				t.Fatalf("handleMessage: %v", err)
			}
			tt.check(t, h)
		})
	}
}

// TestCommandsAgainstAnUnknownPaneTypeNothing: a pane id that herdr does not
// know must produce an error and the agent list, never a keystroke somewhere
// else.
func TestCommandsAgainstAnUnknownPaneTypeNothing(t *testing.T) {
	for _, text := range []string{
		"/say w9:p9 hello",
		"/stop w9:p9",
		"/card w9:p9",
		"/mirror w9:p9 on",
	} {
		t.Run(text, func(t *testing.T) {
			h := newHarness(t)
			h.reg.setAgents(idleAgent(testPane)) // a different, live agent

			if err := h.b.handleMessage(context.Background(), inbound(text)); err != nil {
				t.Fatalf("handleMessage: %v", err)
			}
			assertNothingWasTyped(t, h, "a command naming a pane that does not exist")
			if h.watcher.Enabled("w9:p9") {
				t.Fatal("mirroring was enabled for a pane herdr does not know")
			}
			wantContains(t, lastText(t, h), "w9:p9", "the reply must name the pane that was not found")
		})
	}
}

// ---------- routing ----------

// TestProseRoutesToTheRepliedMessagesPane is the primary interaction model:
// reply-to-route lets one chat drive several agents without a /use command.
func TestProseRoutesToTheRepliedMessagesPane(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane), idleAgent(secondPane))
	h.routes.bindAbout("om_about_w2", idleAgent(secondPane))
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)

	m := inbound("carry on")
	m.ReplyToMessageID = "om_about_w2"

	if err := h.b.handleMessage(context.Background(), m); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	said := h.ctrl.said()
	if len(said) != 1 {
		t.Fatalf("%d Say calls, want 1", len(said))
	}
	if said[0].Guard.PaneID != secondPane {
		t.Fatalf("prose went to %s, want the pane the replied-to message was about (%s)",
			said[0].Guard.PaneID, secondPane)
	}
}

// TestProseFallsBackToTheOnlyAgent covers the reply-to miss: nothing bound, but
// there is no ambiguity to resolve.
func TestProseFallsBackToTheOnlyAgent(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)

	m := inbound("carry on")
	m.ReplyToMessageID = "om_long_forgotten"

	if err := h.b.handleMessage(context.Background(), m); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	said := h.ctrl.said()
	if len(said) != 1 || said[0].Guard.PaneID != testPane {
		t.Fatalf("Say calls = %+v, want one aimed at %s", said, testPane)
	}
}

// TestProseWithSeveralAgentsAsksWhichOne: guessing would type into a terminal
// the user was not looking at, and that terminal may be sitting at a permission
// dialog (G1).
func TestProseWithSeveralAgentsAsksWhichOne(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane), idleAgent(secondPane))

	if err := h.b.handleMessage(context.Background(), inbound("carry on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	assertNothingWasTyped(t, h, "prose with several candidate agents")

	wantContains(t, lastText(t, h), "nothing was sent",
		"a message that went nowhere must say so; silence reads as delivered")

	// The candidates arrive as the picker, so resolving the ambiguity is one tap
	// followed by typing again — not a long-press, and not a typed pane id.
	card := lastCard(t, h)
	wantContains(t, card, testPane, "the picker must offer both candidates")
	wantContains(t, card, secondPane, "the picker must offer both candidates")
	wantContains(t, card, cards.ActSelect, "the picker must offer a way to choose")
}

// TestReplyingToAnUnboundMessageExplainsItself.
//
// The user did resolve the ambiguity as far as they could see: they replied to
// a message. It carried no route, which in practice means they replied to a
// mirrored agent turn — those are streamed, and a streamed message has no id to
// register (S2 §3.5 vs §3.9, see pumpMirror). Answering "which agent did you
// mean?" with no explanation reads like the bridge ignored the reply, and the
// user has no way to find out that this particular message can never be routed.
func TestReplyingToAnUnboundMessageExplainsItself(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane), idleAgent(secondPane))

	m := inbound("carry on")
	m.ReplyToMessageID = "om_a_mirrored_turn" // never bound: streams report no id

	if err := h.b.handleMessage(context.Background(), m); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	assertNothingWasTyped(t, h, "a reply to a message that carries no route")

	reply := lastText(t, h)
	wantContains(t, reply, "not bound to an agent", "the reply must say why the reply-to did not resolve")
	wantContains(t, lastCard(t, h), cards.ActSelect, "the picker must offer the way that does work")

	// The same ambiguity WITHOUT a reply-to must not carry the explanation:
	// there is nothing to explain, and an unconditional paragraph about
	// streaming would be noise in the commonest error in the product.
	h2 := newHarness(t)
	h2.reg.setAgents(idleAgent(testPane), idleAgent(secondPane))
	if err := h2.b.handleMessage(context.Background(), inbound("carry on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if strings.Contains(lastText(t, h2), "not bound to an agent") {
		t.Error("the mirror caveat appeared for a message that was not a reply at all")
	}
}

// TestMirrorOnWarnsThatMirroredTurnsAreNotReplyRoutable is the same limitation
// stated where the user opts into it — but only when it can bite, which is with
// more than one agent running. With one agent a bare reply routes to it anyway.
func TestMirrorOnWarnsThatMirroredTurnsAreNotReplyRoutable(t *testing.T) {
	const caveat = "will not route back"

	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane), idleAgent(secondPane))
	if err := h.b.handleMessage(context.Background(), inbound("/mirror "+testPane+" on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	reply := lastText(t, h)
	wantContains(t, reply, caveat, "turning mirroring on must say replies to mirrored turns do not route")
	wantContains(t, reply, "/say "+testPane, "the caveat must name the command that does work")

	h1 := newHarness(t)
	h1.reg.setAgents(idleAgent(testPane))
	if err := h1.b.handleMessage(context.Background(), inbound("/mirror "+testPane+" on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if strings.Contains(lastText(t, h1), caveat) {
		t.Error("the caveat was shown for a single agent, where a bare reply routes to it anyway")
	}
}

// TestReplyingToAGoneAgentDoesNotRetarget: an explicit target that has
// disappeared is an error, not an invitation to pick the survivor. The user
// aimed at one terminal; typing into another is the failure this bridge exists
// to prevent.
func TestReplyingToAGoneAgentDoesNotRetarget(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane)) // the only agent left, and NOT the target
	h.routes.Bind("om_about_dead", "w9:p9")

	m := inbound("carry on")
	m.ReplyToMessageID = "om_about_dead"

	if err := h.b.handleMessage(context.Background(), m); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	assertNothingWasTyped(t, h, "a reply aimed at a pane that is gone")
	wantContains(t, lastText(t, h), "w9:p9", "the reply must name the agent that is gone")
}

func TestProseWithNoAgentsAtAll(t *testing.T) {
	h := newHarness(t)

	if err := h.b.handleMessage(context.Background(), inbound("hello?")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	assertNothingWasTyped(t, h, "prose with no agents running")
	wantContains(t, lastText(t, h), "no agent to route to", "the reply must say there is nothing to send to")
	wantContains(t, lastCard(t, h), "No agent is running right now",
		"the empty picker must say so and explain how to start one; the bridge does not start agents")
}

func TestTargetReturnsTheDocumentedSentinels(t *testing.T) {
	dead := idleAgent("w9:p9")

	tests := []struct {
		name  string
		list  []agents.Agent
		reply string
		want  error
	}{
		{"none", nil, "", ErrNoAgent},
		{"several", []agents.Agent{idleAgent(testPane), idleAgent(secondPane)}, "", ErrAmbiguous},
		// A recorded destination that is not there any more is NOT "no agent":
		// there is an agent, it is just not the one this message was about.
		{"bound to a dead pane", []agents.Agent{idleAgent(testPane)}, "om_about_dead", ErrTargetReplaced},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.reg.setAgents(tt.list...)
			h.routes.bindAbout("om_about_dead", dead)

			m := inbound("hi")
			m.ReplyToMessageID = tt.reply

			if _, err := h.b.target(m); !errors.Is(err, tt.want) {
				t.Fatalf("target = %v, want %v", err, tt.want)
			}
		})
	}
}

// ---------- delivery reporting (G3) ----------

// TestAnUnverifiedDeliveryIsNotReportedAsSuccess.
//
// agent.prompt returns success once the bytes reach the PTY queue; measured, a
// prompt sent just after a state change is swallowed and still reports success
// (G3). Acked-without-Verified therefore means "we do not know", and a user who
// is told "delivered" walks away from an agent that never heard them.
func TestAnUnverifiedDeliveryIsNotReportedAsSuccess(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: false, Attempts: 2, FinalStatus: agents.StatusIdle}, nil)

	if err := h.b.handleMessage(context.Background(), inbound("run the tests")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	reply := lastText(t, h)
	wantContains(t, reply, "not confirmed", "an unverified delivery must be described as unconfirmed")
	if strings.Contains(reply, "✅") || strings.Contains(reply, "Delivered") {
		t.Errorf("an unverified delivery was dressed up as success:\n%s", reply)
	}
	wantContains(t, reply, "2 attempts", "the retry count is what makes a stalled prompt diagnosable")
}

func TestAVerifiedDeliveryIsReportedAsSuccess(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, Attempts: 1, FinalStatus: agents.StatusWorking}, nil)

	if err := h.b.handleMessage(context.Background(), inbound("run the tests")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	reply := lastText(t, h)
	wantContains(t, reply, "Delivered", "a confirmed delivery should say so")
	if strings.Contains(reply, "not confirmed") {
		t.Errorf("a confirmed delivery was hedged:\n%s", reply)
	}
}

// TestProseToABlockedAgentSaysEscWasPressedFirst is acceptance item 5: the user
// must be told that the dialog they were looking at was cancelled rather than
// answered, because that is the difference between a refusal and an approval
// (G1, G2).
func TestProseToABlockedAgentSaysEscWasPressedFirst(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(blockedAgent())
	// Escaped is what a real Say reports after it dismissed the dialog. The
	// bridge must forward that, not re-derive it from a status it read before
	// the call — the agent can become blocked in between, and then the caller's
	// snapshot says "not blocked" while Say has already pressed esc.
	h.ctrl.setSay(agents.Delivery{
		Acked: true, Verified: true, Escaped: true, FinalStatus: agents.StatusWorking,
	}, nil)

	if err := h.b.handleMessage(context.Background(), inbound("no, do not run that")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	// The text goes through Say — the only path that escapes first — and never
	// through SendKey, which would answer the menu.
	said := h.ctrl.said()
	if len(said) != 1 {
		t.Fatalf("%d Say calls, want 1", len(said))
	}
	if got := h.ctrl.sentKeys(); len(got) != 0 {
		t.Fatalf("a key was sent to a blocked agent: %+v", got)
	}
	wantContains(t, lastText(t, h), "esc", "the user must be told the dialog was cancelled, not answered")
}

func TestAFailedDeliveryIsExplained(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{"still blocked after esc", agents.ErrCannotUnblock, "NOT sent"},
		{"pane gone", agents.ErrPaneGone, "gone"},
		{"agent replaced", agents.ErrAgentReplaced, "different agent"},
		{"guard stale", agents.ErrGuardStale, "too old"},
		{"anything else", errors.New("herdr socket closed"), "herdr socket closed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.reg.setAgents(blockedAgent())
			h.ctrl.setSay(agents.Delivery{FinalStatus: agents.StatusBlocked}, tt.err)

			if err := h.b.handleMessage(context.Background(), inbound("no, do not run that")); err != nil {
				t.Fatalf("handleMessage: %v", err)
			}
			wantContains(t, lastText(t, h), tt.want, "a failed delivery must be explained")
		})
	}
}

// TestRepliesAboutAnAgentAreBoundForRouting: without the binding, answering the
// bridge's own message would fall back to "the only agent", which is wrong the
// moment a second agent exists.
func TestRepliesAboutAnAgentAreBoundForRouting(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane), idleAgent(secondPane))
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)

	if err := h.b.handleMessage(context.Background(), inbound("/say "+testPane+" carry on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	bound := h.routes.boundPanes()
	if len(bound) != 1 || bound[0].PaneID != testPane {
		t.Fatalf("bindings = %+v, want the delivery report bound to %s", bound, testPane)
	}
}

// TestEveryReplyAnswersTheUsersOwnMessage keeps the thread readable on a phone:
// a bare message in a busy chat is impossible to attach to what was asked.
func TestEveryReplyAnswersTheUsersOwnMessage(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))

	if err := h.b.handleMessage(context.Background(), inbound("/ls")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	sends := h.bot.sends()
	if len(sends) != 1 {
		t.Fatalf("%d sends, want 1", len(sends))
	}
	if sends[0].Out.ReplyMessageID != testMsgID {
		t.Errorf("reply target = %q, want the inbound message id", sends[0].Out.ReplyMessageID)
	}
}

// TestDoctorWarnsAboutANarrowPane encodes G5 and G11 together: a pane that no
// terminal client ever attached to is 53 columns, claude's dialogs wrap at that
// width, herdr's detection then reports idle instead of blocked — and the user
// simply stops getting cards, with nothing anywhere reporting a failure.
func TestDoctorWarnsAboutANarrowPane(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	h.ex.dialog.Cols = 53
	h.ex.dialog.Narrow = true

	if err := h.b.handleMessage(context.Background(), inbound("/doctor")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	reply := lastText(t, h)
	wantContains(t, reply, "53 columns", "doctor must name the width it measured")
	wantContains(t, reply, "idle", "doctor must explain that detection degrades silently to idle")
}

func TestDoctorReportsADegradedHerdr(t *testing.T) {
	h := newHarness(t)
	h.reg.degraded = true

	if err := h.b.handleMessage(context.Background(), inbound("/doctor")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	wantContains(t, lastText(t, h), "not answering", "a degraded herdr is the first thing doctor must say")
}

// TestListSaysWhenTheViewIsStale: a list that looks live while herdr is down
// invites the user to act on a pane that may no longer be there.
func TestListSaysWhenTheViewIsStale(t *testing.T) {
	h := newHarness(t)
	h.reg.degraded = true
	h.reg.setAgents(idleAgent(testPane))

	if err := h.b.handleMessage(context.Background(), inbound("/ls")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	wantContains(t, lastText(t, h), "last view", "/ls must admit when it is showing a stale snapshot")
}

// TestMirrorOnWithoutATranscriptSaysSo covers the normal intermediate state of
// G8: claude publishes a session id only after its trust-this-directory prompt
// is accepted, so mirroring can be on and silent through no fault of anyone's.
func TestMirrorOnWithoutATranscriptSaysSo(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))

	if err := h.b.handleMessage(context.Background(), inbound("/mirror "+testPane+" on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if !h.watcher.Enabled(testPane) {
		t.Fatal("mirroring was not enabled")
	}
	wantContains(t, lastText(t, h), "no transcript yet", "the user must be told why nothing appears")
}

func TestCardForAnAgentThatIsNotWaitingSaysTheButtonsWillRefuse(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	h.ex.dialog = permissionDialog()

	if err := h.b.handleMessage(context.Background(), inbound("/card "+testPane)); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if got := h.bot.cards(); len(got) != 1 {
		t.Fatalf("%d cards sent, want 1", len(got))
	}
	wantContains(t, lastText(t, h), "refuse", "a card built off a dialog that is not there must say the buttons will not work")
}

// TestGuardCarriesTheStateSeqTheUserWasLookingAt (G17 at this layer): every
// input is pinned to the agent state that produced it, so a decision made
// against an old screen cannot be replayed into a pane that moved on.
func TestGuardCarriesTheStateSeqTheUserWasLookingAt(t *testing.T) {
	h := newHarness(t)
	a := workingAgent(testPane)
	a.Status = agents.StatusIdle
	h.reg.setAgents(a)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)

	if err := h.b.handleMessage(context.Background(), inbound("go on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	said := h.ctrl.said()
	if len(said) != 1 {
		t.Fatalf("%d Say calls, want 1", len(said))
	}
	g := said[0].Guard
	if g.PaneID != testPane || g.Kind != "claude" || g.StateSeq != a.StateSeq {
		t.Errorf("guard = %+v, want pane/kind/seq from the registry", g)
	}
	if !g.IssuedAt.Equal(epoch) {
		t.Errorf("guard issued at %s, want the bridge clock %s", g.IssuedAt, epoch)
	}
}

func TestStatusEmojiCoversEveryStatus(t *testing.T) {
	seen := map[string]agents.Status{}
	for _, s := range []agents.Status{
		agents.StatusIdle, agents.StatusWorking, agents.StatusBlocked,
		agents.StatusDone, agents.StatusGone, agents.StatusUnknown,
	} {
		e := statusEmoji(s)
		if e == "" {
			t.Fatalf("no emoji for %s", s)
		}
		if prev, ok := seen[e]; ok {
			t.Errorf("%s and %s share the glyph %s", prev, s, e)
		}
		seen[e] = s
	}
}

// TestReplyFailureIsReturned: guard() un-marks the event when the handler
// fails, so a send that never landed must surface rather than be swallowed.
func TestReplyFailureIsReturned(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	h.bot.failNext(failing(lark.ErrPermissionDenied))

	err := h.b.handleMessage(context.Background(), inbound("/help"))
	if err == nil {
		t.Fatal("a failed reply was reported as success")
	}
	if !errors.Is(err, lark.ErrPermissionDenied) {
		t.Fatalf("err = %v, want the send failure", err)
	}
}

// movingClock is a test clock the caller steps by hand, so cooldowns are
// exercised without a real sleep.
type movingClock struct{ at time.Time }

func (c *movingClock) now() time.Time      { return c.at }
func (c *movingClock) add(d time.Duration) { c.at = c.at.Add(d) }

// TestCommandFailuresAreReported: every command that touches the machine can
// fail, and a phone that is told nothing assumes the thing happened.
func TestCommandFailuresAreReported(t *testing.T) {
	boom := errors.New("herdr socket closed")

	tests := []struct {
		name  string
		text  string
		setup func(*harness)
		want  string
	}{
		{
			name:  "stop cannot deliver esc",
			text:  "/stop " + testPane,
			setup: func(h *harness) { h.ctrl.keyErr = boom },
			want:  "Could not send esc",
		},
		{
			name:  "card cannot read the screen",
			text:  "/card " + testPane,
			setup: func(h *harness) { h.ex.dialErr = boom },
			want:  "Could not read",
		},
		{
			name:  "mirror cannot be enabled",
			text:  "/mirror " + testPane + " on",
			setup: func(h *harness) { h.watcher.enableErr = boom },
			want:  "Could not mirror",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.reg.setAgents(blockedAgent())
			tt.setup(h)

			if err := h.b.handleMessage(context.Background(), inbound(tt.text)); err != nil {
				t.Fatalf("handleMessage: %v", err)
			}
			reply := lastText(t, h)
			wantContains(t, reply, tt.want, "a failed command must say so")
			wantContains(t, reply, boom.Error(), "the reason belongs in the reply, not only in the log")
		})
	}
}

// TestADeliveryThatWasNeverAcknowledged: Say returned no error but nothing was
// acknowledged either. Reporting that as success would be the same lie as
// reporting an unverified one (G3).
func TestADeliveryThatWasNeverAcknowledged(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	h.ctrl.setSay(agents.Delivery{FinalStatus: agents.StatusIdle}, nil)

	if err := h.b.handleMessage(context.Background(), inbound("go")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	reply := lastText(t, h)
	wantContains(t, reply, "not sent", "an unacknowledged delivery must be described as not sent")
	if strings.Contains(reply, "✅") {
		t.Errorf("an unacknowledged delivery was dressed up as success:\n%s", reply)
	}
}

// TestListNamesAnAgentHerdrHasNotIdentifiedYet: detection can lag behind the
// pane, and an empty column is something the user has to guess at.
func TestListNamesAnAgentHerdrHasNotIdentifiedYet(t *testing.T) {
	h := newHarness(t)
	a := idleAgent(testPane)
	a.Kind = ""
	a.Cwd = ""
	a.Title = ""
	h.reg.setAgents(a)

	if err := h.b.handleMessage(context.Background(), inbound("/ls")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	wantContains(t, lastCard(t, h), "**agent**",
		"an unidentified agent must still get a readable row; an empty name is something to guess at")
}
