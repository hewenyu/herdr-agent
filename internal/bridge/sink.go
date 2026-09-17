package bridge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/cards"
	"github.com/hewenyu/herdr-agent/internal/screen"
	"github.com/hewenyu/herdr-agent/internal/tasks"
)

// nonceBytes is the size of a card's single-use token. It is not a secret —
// the guard, not the nonce, is what refuses a stale press (G17) — but it must
// not collide with another card's, because a collision would silently disarm a
// card the user never touched.
const nonceBytes = 16

// PushBlocked posts the actionable card for an agent that is waiting for a
// human.
//
// The options come off the screen rather than from a table of what Claude
// "usually" shows, because that count varies by agent and by version; when none
// parse, BuildBlocked degrades to Esc plus an instruction to reply in prose.
// Nothing here focuses a pane: agent.focus would yank the desktop user's UI to
// this tab and clear `done` back to `idle`, destroying the very signal the
// notifier depends on (G10).
func (b *bridge) PushBlocked(ctx context.Context, a agents.Agent, dialog screen.Screen) error {
	b.taskObserve(a, tasks.Blocked, dialog.Text(), "")
	// This card IS the reply to whatever the user last typed at this agent: the
	// agent stopped, and it stopped to ask them something. So it closes the burst
	// (see bursts.close) — the next message they send is acknowledged again.
	b.acks.close(a.PaneID)

	chatID := b.notifyChat(a.PaneID)
	if chatID == "" {
		if b.tasks != nil {
			if r, bound := b.tasks.ByPane(a.PaneID); bound && (!b.tasks.OwnerAllowed(r.OwnerID) || r.ChatDeleted || r.Status == tasks.Destroying || r.Status == tasks.Destroyed) {
				return nil
			}
			// The registry can see the new agent before the task manager saves
			// its pane binding. Reporting success would consume the notifier's
			// only blocked transition, leaving a startup trust dialog stranded.
			// Keep it retryable until the task's notification route is available.
		}
		return fmt.Errorf("%w: cannot tell you that %s is waiting", ErrNoNotifyTarget, a.PaneID)
	}
	// Unprompted, so it goes to the configured chat and replies to nothing.
	return b.pushBlockedTo(ctx, cardTarget{ChatID: chatID}, a, dialog)
}

// cardTarget is where a blocked card goes.
//
// The notifier's cards arrive unasked in the configured notify chat. A card the
// user provoked — today that is /card, and it was also the card that replaced a
// message the bridge had been holding for an agent that went back to waiting,
// before it stopped holding any (see deliver) — answers them where they typed, so
// the question and whatever prompted it stay in one thread.
type cardTarget struct {
	ChatID  string
	ReplyTo string
}

// pushBlockedTo builds the card and delivers it to one target.
func (b *bridge) pushBlockedTo(ctx context.Context, to cardTarget, a agents.Agent, dialog screen.Screen) error {
	nonce, err := b.newNonce()
	if err != nil {
		return fmt.Errorf("bridge: mint card nonce for %s: %w", a.PaneID, err)
	}

	// The card is built against the agent as the notifier saw it, so the
	// Decision inside every button carries THAT StateSeq. When the button is
	// pressed later, S1's Guard compares it with the agent's sequence at press
	// time and refuses the keystroke if the agent has moved on (G17).
	card, err := cards.BuildBlocked(a, dialog, cards.ParseOptions(dialog), nonce, b.now())
	if err != nil {
		b.log.Error("bridge: could not build the blocked card", "pane", a.PaneID, "err", err)
		return b.blockedFallback(ctx, to, a, dialog, "the card could not be built")
	}

	if _, err := b.send(ctx, outgoing{
		ChatID:  to.ChatID,
		ReplyTo: to.ReplyTo,
		Card:    card,
		PaneID:  a.PaneID,
	}); err != nil {
		// An undelivered "this agent needs you" is the one failure that strands
		// both ends: the agent waits forever and the user is never asked. Say it
		// in the plainest form Feishu can render, and keep the reply route, so
		// the user can still answer in prose.
		b.log.Error("bridge: blocked card was not delivered; falling back to plain text",
			"pane", a.PaneID, "err", err)
		return b.blockedFallback(ctx, to, a, dialog, "the card could not be delivered")
	}
	return nil
}

// blockedFallback tells the user in plain text what the card would have said.
//
// It deliberately does not offer buttons — there are none to offer — and points
// at the safe path instead: prose goes through Controller.Say, which escapes a
// pending dialog first, so it cannot become an approval (G1).
func (b *bridge) blockedFallback(ctx context.Context, to cardTarget, a agents.Agent, dialog screen.Screen, why string) error {
	text := strings.Join([]string{
		fmt.Sprintf("⚠️ %s is waiting for an answer (%s).", agentLabel(a), why),
		dialogOrNote(dialog),
		"Reply to this message in plain words to answer it. Prose always goes through the safe " +
			"path — the bridge presses Esc first — so it cannot turn into an approval.",
	}, "\n\n")

	if _, err := b.send(ctx, outgoing{
		ChatID:  to.ChatID,
		ReplyTo: to.ReplyTo,
		Text:    text,
		PaneID:  a.PaneID,
	}); err != nil {
		return fmt.Errorf("bridge: push blocked %s: %w", a.PaneID, err)
	}
	return nil
}

// PushDone reports an agent that finished while nobody was looking.
//
// `done` is idle-and-unseen, derived by herdr itself rather than by matching
// English strings on a screen, which makes it the most reliable trigger the
// bridge has (G11). WHAT it shows is the agent's own last message, read from
// the transcript — not a picture of the terminal. The tail this used to post
// was eighteen lines of scrollback (three previous turns, two "Ran 1 shell
// command", the empty prompt box, the status bar) around one line of answer,
// which is a screenshot rather than a notification.
//
// That is G8's division of labour applied to the half that had not followed it:
// CONTENT comes from the transcript, which has roles, turn boundaries and no
// TUI furniture; a pending DIALOG can only come from the screen, because a
// transcript has no permission record at all — so PushBlocked reads the screen
// and must keep doing so. The screen is still one tap away here, behind the
// card's Screen button, which is where the detail belongs.
func (b *bridge) PushDone(ctx context.Context, a agents.Agent, tail screen.Screen) error {
	delivery := b.paneDelivery(a.PaneID)
	delivery.mu.Lock()
	defer delivery.mu.Unlock()
	// The settle reply. A burst of messages produces exactly one of these — the
	// agent goes working once and finishes once, and the notifier coalesces
	// anything closer together than its cooldown — which is why the deliveries
	// themselves stay quiet (reportDelivery). It closes the burst, so the next
	// thing typed is acknowledged again.
	b.acks.close(a.PaneID)

	if b.notifyChat(a.PaneID) == "" {
		if b.tasks != nil {
			return nil
		}
		return fmt.Errorf("%w: cannot tell you that %s finished", ErrNoNotifyTarget, a.PaneID)
	}

	// Resolved once and kept: every way this can fail from here on still owes
	// the user the answer, and re-reading the transcript to say so would sample
	// a file the agent may already have moved on in.
	ans, record := b.doneAnswerRecord(a, tail)
	result := ans.Text
	if b.taskDeliveryEnabled(a) {
		result = ""
	}
	if record != nil {
		result = record.Text
	}
	b.taskObserve(a, tasks.Review, tasks.ReviewDetail, result)
	if b.taskDeliveryEnabled(a) {
		// A screen tail or a tool-only record is not a final answer. The task
		// notification owns lifecycle facts when no assistant text is available.
		if record == nil || strings.TrimSpace(record.Text) == "" {
			return nil
		}
		id, coordinated := b.deliveryID(a, *record)
		markDelivered := func() error {
			if err := b.tasks.MarkResultDelivered(a.PaneID, record.Text); err != nil {
				return err
			}
			return b.recordDeliveredResult(ctx, a, record.Text, id, coordinated)
		}
		if stream, mirrored := delivery.lookup(id); coordinated && mirrored {
			if stream == nil {
				if err := delivery.confirm(id); err != nil {
					return err
				}
				return markDelivered()
			}
			// Append can buffer its last chunk. Confirm the answer reached the
			// existing message before suppressing the completion fallback.
			flushErr := stream.s.Flush(ctx)
			persistErr := delivery.finishStream(stream, flushErr == nil)
			if flushErr == nil {
				if persistErr != nil {
					return persistErr
				}
				return markDelivered()
			}
			b.log.Warn("bridge: mirror flush failed; sending completion fallback", "pane", a.PaneID, "err", flushErr)
		}
		if err := b.postTaskRecord(ctx, a, *record, id, coordinated); err != nil {
			return err
		}
		return markDelivered()
	}

	// No nonce is minted. Both of this card's buttons are inert — Select aims
	// the chat at the agent, Screen re-reads it, neither can put a byte into the
	// pane — so BuildDone ignores the argument and DecodeDecision refuses an
	// inert value that carries one. Minting a nonce here would add a way for the
	// notification to fail in exchange for nothing.
	card, err := cards.BuildDone(a, ans, "", b.now())
	if err != nil {
		b.log.Error("bridge: could not build the finished card", "pane", a.PaneID, "err", err)
		return b.donePost(ctx, a, ans, tail, "")
	}

	if _, err := b.send(ctx, outgoing{
		ChatID: b.notifyChat(a.PaneID),
		Card:   card,
		PaneID: a.PaneID,
	}); err != nil {
		// A card is a rendering choice; the notification is the product. Feishu
		// rejecting the card's format is not retried and not downgraded by
		// sendOne (its body is JSON, not prose), so without this the user simply
		// never learns the agent finished — and `done` produces no second
		// transition to try again on.
		b.log.Error("bridge: finished card was not delivered; falling back to plain text",
			"pane", a.PaneID, "err", err)
		return b.donePost(ctx, a, ans, tail, "the card could not be delivered")
	}
	return nil
}

// donePost is the finished notification without the card, and it carries the
// SAME answer the card would have shown.
//
// It used to post the screen tail here, which put the complaint this wave
// exists to fix back on a reachable path. A card is the one outgoing kind
// sendOne cannot downgrade — its body is JSON, not prose — and `done` produces
// no second transition to retry on, so every format rejection, rate limit or
// revoked target lands in this function. Throwing away an answer that is
// already in hand, on the one path where the rich rendering has already failed
// the reader once, is precisely the eighteen lines of scrollback the wave
// removed.
//
// The tail appears only when the answer IS the screen — no transcript, which
// doneAnswer marks with FromScreen — because then there is nothing else to
// show, and it keeps the sentence that stops a reader taking terminal furniture
// for the agent's own words (G4).
func (b *bridge) donePost(ctx context.Context, a agents.Agent, ans cards.Answer, tail screen.Screen, why string) error {
	head := fmt.Sprintf("**✅ %s finished**", agentLabel(a))
	if why != "" {
		head += fmt.Sprintf(" (%s)", why)
	}
	body := []string{head}
	if t := strings.TrimSpace(a.Title); t != "" {
		body = append(body, t)
	}
	if p := oneLine(ans.Prompt); p != "" {
		q, _ := truncateCells(p, postPromptCells)
		body = append(body, fmt.Sprintf("**You asked** “%s”", q))
	}

	switch text := strings.TrimSpace(ans.Text); {
	case ans.FromScreen:
		// The full tail rather than ans.Text: this is the one body that is a
		// character grid, fencedBlock keeps its alignment, and the cell budget
		// doneAnswer applied was about fitting a card, not this message — which
		// sendOne can still split.
		body = append(body, dialogOrNote(tail),
			"_This is the pane's screen, not the agent's own words — no transcript was available._")
	case text == "":
		// Still worth sending: that the agent finished is the fact the user
		// cannot see from a phone, and an empty message would read as a bug.
		body = append(body, "_The agent finished, but there is no final message to show._")
	default:
		body = append(body, ans.Text)
	}
	if ans.Truncated && !ans.FromScreen {
		// Not on the screen branch: that body is the whole tail, not the cut
		// copy of it doneAnswer measured for the card.
		body = append(body, "_This is not the whole answer — it was cut to fit._")
	}
	if tools := toolBullets(ans.Tools); tools != "" {
		body = append(body, tools)
	}
	body = append(body, fmt.Sprintf("_Reply to this message to send `%s` something new._", a.PaneID))

	if _, err := b.send(ctx, outgoing{
		ChatID:   b.notifyChat(a.PaneID),
		Markdown: strings.Join(body, "\n\n"),
		Title:    agentLabel(a) + " finished",
		PaneID:   a.PaneID,
	}); err != nil {
		return fmt.Errorf("bridge: push done %s: %w", a.PaneID, err)
	}
	return nil
}

// PushGone reports that an agent's pane disappeared.
//
// Plain text, and deliberately NOT bound for reply-routing: the pane is gone,
// so a reply to this message could only produce an error. Leaving it unbound
// lets the reply fall through to the normal routing rules, which will pick the
// remaining agent or ask which one was meant.
func (b *bridge) PushGone(ctx context.Context, a agents.Agent) error {
	b.taskObserve(a, tasks.Attention, "agent 已退出或窗口已关闭", "")
	// Forget the pane's burst state too: nothing about that agent is true any
	// more, and this is the last message that will ever mention it.
	b.acks.close(a.PaneID)

	if b.notifyChat(a.PaneID) == "" {
		if b.tasks != nil {
			return nil
		}
		return fmt.Errorf("%w: cannot tell you that %s is gone", ErrNoNotifyTarget, a.PaneID)
	}

	// It no longer says "anything still queued has been dropped", because the
	// bridge queues nothing: every message the user typed was delivered when they
	// typed it, into the agent that has now exited (see deliver). Claiming a drop
	// would be describing a queue that does not exist.
	text := fmt.Sprintf("👋 %s is gone — the pane was closed or the agent exited.", agentLabel(a))

	if _, err := b.send(ctx, outgoing{
		ChatID: b.notifyChat(a.PaneID),
		Text:   text,
	}); err != nil {
		return fmt.Errorf("bridge: push gone %s: %w", a.PaneID, err)
	}
	return nil
}

// agentLabel names an agent the way a phone notification should: what it is,
// where it is working, and the pane id that every command takes.
func agentLabel(a agents.Agent) string {
	parts := make([]string, 0, 3)
	if k := strings.TrimSpace(a.Kind); k != "" {
		parts = append(parts, k)
	} else {
		parts = append(parts, "agent")
	}
	if base := cwdBase(a.Cwd); base != "" {
		parts = append(parts, base)
	}
	if a.PaneID != "" {
		parts = append(parts, a.PaneID)
	}
	return strings.Join(parts, " · ")
}

func cwdBase(cwd string) string {
	if strings.TrimSpace(cwd) == "" {
		return ""
	}
	base := filepath.Base(filepath.Clean(cwd))
	if base == "." || base == string(filepath.Separator) {
		return ""
	}
	return base
}

// postPromptCells bounds the context line of a plain-text finished post, in
// display cells (see displayWidth). Same budget as the card's promptLine, for
// the same reason: enough of the request to recognise which one this answers,
// not so much that it pushes the answer itself out of the phone's preview.
const postPromptCells = 80

// postToolLines is how many tool summaries a plain-text post lists before the
// rest are counted. The reader asked for the answer; a tool list that outgrows
// its subject is the scrollback this notification stopped sending.
const postToolLines = 5

// oneLine collapses a request onto one line.
//
// A prompt can be several paragraphs, and this is a line of CONTEXT, not a
// re-run of the request: keeping its newlines would push the answer down a
// message whose whole job is to put the answer first.
func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// toolBullets renders the answering turn's tool calls, one per line.
//
// The summaries are the parser's — `Bash(touch x.txt)` — and are emitted
// unwrapped for the reason mirrorpump gives at toolBullet: they may contain
// backticks, and markup that closes early breaks the line it was meant to make
// readable. Blank entries are dropped without being counted, so the overflow
// count never promises something that is not there.
func toolBullets(tools []string) string {
	lines := make([]string, 0, postToolLines+1)
	extra := 0
	for _, t := range tools {
		t = oneLine(t)
		if t == "" {
			continue
		}
		if len(lines) >= postToolLines {
			extra++
			continue
		}
		lines = append(lines, toolBullet+t)
	}
	if len(lines) == 0 {
		return ""
	}
	if extra > 0 {
		lines = append(lines, fmt.Sprintf("_+%d more_", extra))
	}
	return strings.Join(lines, "\n")
}

// dialogOrNote renders screen content as a code block, or says there was none.
// An empty block would read as "the agent is showing nothing", which is never
// why one of these messages exists.
func dialogOrNote(s screen.Screen) string {
	text := strings.TrimRight(s.Text(), "\n")
	if strings.TrimSpace(text) == "" {
		return "_(herdr returned no screen content for this pane)_"
	}
	return fencedBlock(text)
}

// fencedBlock wraps text in a fence long enough to survive backticks inside it.
// The text is emitted exactly as the screen package produced it: cropped to
// phone width, never re-wrapped, because re-wrapping a TUI destroys the column
// alignment that makes it legible (G5).
func fencedBlock(text string) string {
	longest, run := 0, 0
	for _, r := range text {
		if r != '`' {
			run = 0
			continue
		}
		run++
		if run > longest {
			longest = run
		}
	}
	n := 3
	if longest >= n {
		n = longest + 1
	}
	fence := strings.Repeat("`", n)
	return fence + "\n" + text + "\n" + fence
}

// randomNonce mints a card's single-use token.
func randomNonce() (string, error) {
	buf := make([]byte, nonceBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("bridge: read random bytes: %w", err)
	}
	return hex.EncodeToString(buf), nil
}
