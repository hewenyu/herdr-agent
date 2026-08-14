package setup

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/hewenyu/herdr-agent/internal/lark"
)

// stopGrace bounds the wait for the connection goroutine after Stop.
//
// It is short because that goroutine may never return at all: ws.Client.Start
// ends in `select {}`, so a connected client parks there forever and Stop
// closes the socket without unparking it (see internal/lark bot.Start). Setup
// exits right afterwards, which is the only reason that is acceptable here.
const stopGrace = 2 * time.Second

// eventBuffer keeps an inbound event from being dropped while the run is
// between waits — the card press can land before we have started waiting for it,
// and so can a message sent while the retry question is on screen.
const eventBuffer = 8

// inboundTimeout and cardTimeout are the contract's InboundTimeout and
// CardTimeout, behind variables for one reason: the retry loop cannot be tested
// through the context deadline, because the first wait always consumes whatever
// is left of it (see effectiveWait). A test that shortens these drives the same
// code the real waits do; a test that shortened them through the context would
// only ever get one wait.
var (
	inboundTimeout = InboundTimeout
	cardTimeout    = CardTimeout
)

// newBot builds the Feishu client used for verification. It is a variable so
// the whole flow can be exercised without a network.
var newBot = func(appID, appSecret string) (lark.Bot, error) {
	// LogWarn rather than the default: an ordinary connect line is noise in a
	// command whose entire output is a checklist, while a reconnect storm still
	// gets through. The SDK prints it to stdout regardless, which is why the
	// run holds a stdout capture open around this (see capture.go).
	return lark.New(appID, appSecret, lark.WithLogLevel(lark.LogWarn))
}

// verification is what the round trip established.
type verification struct {
	InboundOK bool
	CardOK    bool
	OpenID    string
	ChatID    string
	Steps     []Step
}

// verifyInput is what the round trip needs to know.
type verifyInput struct {
	creds credentials
	// app is the identity to put in front of the human: which bot to message,
	// and whether its capabilities were granted by a confirmation page during
	// this run (which decides how the card checklist hedges).
	app App
	// allowed is who may complete the verification. Empty means "the first
	// person to write" — only reachable on the repair path, where an existing
	// config.toml has no allowlist yet, and reported as a note when it happens.
	allowed []string
	console console
	// onInbound persists what the first accepted message taught us, BEFORE the
	// card half runs. Ordering: everything learned is written the moment it is
	// learned, so a failure later still leaves a usable configuration.
	onInbound func(openID, chatID string)
}

// verify proves the round trip, which is the only definition of success this
// command accepts.
//
// A message arriving from the registered user simultaneously proves the
// credentials, the bot capability, the event subscription, the delivery mode,
// that a version is published, that the scopes were granted and that the
// allowlist matches. Those are six separately invisible failure modes — each of
// which otherwise shows up as "the bridge is silent" — collapsed into one
// observation.
func (r *Runner) verify(ctx context.Context, rep *reporter, in verifyInput) verification {
	var out verification

	bot, err := newBot(in.creds.AppID, in.creds.AppSecret)
	if err != nil {
		rep.note("Could not build the Feishu client: %s", rep.errText(err))
		out.Steps = append(out.Steps, stepConnect(in.console, rep.errText(err)))
		return out
	}

	msgs := make(chan lark.Msg, eventBuffer)
	actions := make(chan lark.Action, eventBuffer)
	bot.OnMessage(func(_ context.Context, m lark.Msg) error {
		select {
		case msgs <- m:
		default: // never block the SDK's pipeline on a full buffer
		}
		return nil
	})
	bot.OnCardAction(func(_ context.Context, a lark.Action) error {
		select {
		case actions <- a:
		default:
		}
		return nil
	})
	bot.SetLifecycle(lark.Lifecycle{
		OnError: func(err error) { rep.note("Feishu connection error: %s", rep.errText(err)) },
		OnReconnecting: func() {
			rep.note("Reconnecting to Feishu…")
		},
	})

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// TRAP: Bot.Start BLOCKS — it runs the receive loop. Calling it inline is
	// how a probe hangs forever having proved nothing.
	conn := &connection{ended: make(chan struct{})}
	go func() {
		defer close(conn.ended)
		conn.err = bot.Start(runCtx)
	}()
	defer func() {
		cancel()
		// WithoutCancel: ctx may already be done, and Stop's whole job is to take
		// this process OUT of the app's connection pool. Long-connection delivery
		// is cluster mode — up to 50 connections per app, with each event dealt to
		// a randomly chosen one of them (G15) — so a socket nobody reads any more
		// is not merely idle: it keeps being handed a share of the user's events,
		// and that share is lost. Same reason the probe runs under the bridge's
		// single-instance lock (see acquireLock) instead of alongside a live one.
		_ = bot.Stop(context.WithoutCancel(ctx))
		select {
		case <-conn.ended:
		case <-time.After(stopGrace):
		}
	}()

	if !r.waitInbound(ctx, rep, in, msgs, conn, &out) {
		return out
	}
	r.waitCard(ctx, rep, in, bot, actions, conn, &out)
	return out
}

// connection is the Start goroutine's result.
//
// A closed channel rather than a value on one: both waits below and the
// teardown watch for the connection ending, and a value can only be received
// once — the first waiter would consume it and the next would wait out its
// whole timeout on a connection that had already died.
type connection struct {
	ended chan struct{}
	err   error // valid once ended is closed
}

// waitInbound blocks until an acceptable message arrives, the wait elapses, or
// the connection dies. It reports whether the card half is worth attempting.
//
// A timeout offers one more wait rather than ending the run (see
// offerAnotherWait): by this point everything that could be automated has been,
// and the only thing that failed is that a human was not looking at their
// phone. Making them re-run the whole command for that is how a working setup
// gets abandoned half way.
func (r *Runner) waitInbound(
	ctx context.Context,
	rep *reporter,
	in verifyInput,
	msgs <-chan lark.Msg,
	conn *connection,
	out *verification,
) bool {
	if len(in.allowed) == 0 {
		rep.note("No allowlist is configured yet, so the first person to message this bot will be " +
			"recorded as its owner. Do this now, from your own phone.")
	}

	sawEmpty := false
	wait := effectiveWait(ctx, inboundTimeout)
	rep.awaitMessage(in.app, wait)

	timer := time.NewTimer(wait)
	defer timer.Stop()

	for {
		select {
		case <-timer.C:
			what := "Nothing arrived"
			if sawEmpty {
				what = "No message with a readable body arrived"
			}
			if r.offerAnotherWait(ctx, rep, what, wait) {
				wait = effectiveWait(ctx, inboundTimeout)
				rep.awaitMessage(in.app, wait)
				timer.Reset(wait)
				continue
			}
			rep.note("%s in %s.", what, wait)
			out.Steps = append(out.Steps, inboundFailureSteps(in.console, wait, sawEmpty)...)
			return false

		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				rep.note("Ran out of time waiting for a message.")
				out.Steps = append(out.Steps, inboundFailureSteps(in.console, wait, sawEmpty)...)
			}
			return false

		case <-conn.ended:
			reason := connectionEnd(rep, conn.err)
			rep.note("The Feishu connection ended before anything arrived: %s", reason)
			out.Steps = append(out.Steps, stepConnect(in.console, reason))
			return false

		case m := <-msgs:
			if !accepts(in.allowed, m.UserID) {
				// Not a failure and not worth naming the sender: someone else
				// found the bot, and the allowlist did its job.
				rep.note("Ignoring a message from an id that is not the one this setup is for.")
				continue
			}
			if m.ChatType != lark.ChatP2P {
				// notify_chat_id is written from this message, and it is where
				// agent screens — including the command an agent is about to
				// run — get pushed. A group is not somewhere to send that by
				// accident.
				rep.note("That was a group chat. Send me a DIRECT message: the chat it arrives in " +
					"becomes notify_chat_id, and agent screens get pushed there.")
				continue
			}

			// Written to config.toml unconditionally — a chat learned from an
			// empty-bodied message is still the right chat to push to — but NOT
			// published on the Result until the message is accepted, because
			// contract.go promises Result.ChatID is empty when inbound
			// verification did not complete and a CLI is entitled to print
			// "notifications will go to <ChatID>" off that promise.
			in.onInbound(m.UserID, m.ChatID)

			if strings.TrimSpace(m.Text) == "" {
				// The event arrived, so delivery works; the CONTENT did not.
				// Left undetected this surfaces much later as a command-parser
				// error blaming the wrong layer entirely.
				sawEmpty = true
				rep.note("A message arrived from you but its body was empty. Send a plain TEXT message " +
					"(not a sticker or an image): an empty body is also what a missing " +
					"im:message.p2p_msg:readonly looks like.")
				continue
			}

			rep.note("Message received. Credentials, bot, event subscription, delivery mode, " +
				"publication, scopes and the allowlist are all confirmed by that one message.")
			out.OpenID, out.ChatID = m.UserID, m.ChatID
			out.InboundOK = true
			return true
		}
	}
}

// waitCard sends the one-button card and waits for the press.
func (r *Runner) waitCard(
	ctx context.Context,
	rep *reporter,
	in verifyInput,
	bot lark.Bot,
	actions <-chan lark.Action,
	conn *connection,
	out *verification,
) {
	nonce, err := newNonce()
	if err != nil {
		rep.note("Could not prepare the verification card: %s", rep.errText(err))
		return
	}
	card, err := buildVerifyCard(nonce, r.now())
	if err != nil {
		rep.note("Could not build the verification card: %s", rep.errText(err))
		return
	}

	messageID, err := bot.Send(ctx, lark.Out{ChatID: out.ChatID, Card: card})
	if err != nil && !errors.Is(err, lark.ErrSplit) {
		reason := rep.errText(err)
		rep.note("The verification card could not be sent: %s", reason)
		out.Steps = append(out.Steps, stepCardSendFailed(in.console, reason))
		return
	}

	wait := effectiveWait(ctx, cardTimeout)
	rep.awaitCard(wait)

	timer := time.NewTimer(wait)
	defer timer.Stop()

waiting:
	for {
		select {
		case <-timer.C:
			// Same offer as the inbound wait, and cheaper: the card is already
			// sitting in the chat and is still live, so another wait costs
			// nothing but the wait itself.
			if r.offerAnotherWait(ctx, rep, "No button press arrived", wait) {
				wait = effectiveWait(ctx, cardTimeout)
				rep.awaitCard(wait)
				timer.Reset(wait)
				continue
			}
			rep.note("No button press arrived in %s.", wait)
			out.Steps = append(out.Steps, stepCardTimeout(in.console, in.app.Origin, wait))
			break waiting

		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				out.Steps = append(out.Steps, stepCardTimeout(in.console, in.app.Origin, wait))
			}
			break waiting

		case <-conn.ended:
			reason := connectionEnd(rep, conn.err)
			rep.note("The Feishu connection ended while waiting for the button: %s", reason)
			out.Steps = append(out.Steps, stepConnect(in.console, reason))
			break waiting

		case a := <-actions:
			if !accepts(in.allowed, a.Operator) && a.Operator != out.OpenID {
				continue
			}
			if value(a, "n") != nonce {
				// An older card from a previous setup run, still sitting in the
				// chat. It proves nothing about this app's configuration.
				rep.note("Ignoring a press on a card from an earlier run.")
				continue
			}
			out.CardOK = true
			rep.note("Button press received. The card path works end to end.")
			break waiting
		}
	}

	// Disarm whatever happened, best effort: this card must not stay in chat
	// history looking pressable by a process that no longer exists (G17).
	if messageID == "" {
		return
	}
	text := "✅ Setup verified. This button is spent."
	if !out.CardOK {
		text = "⏱ Setup stopped waiting. This button no longer does anything — re-run `herdr-agent setup` if you need to verify again."
	}
	disarmed, err := buildDisarmedCard(text, r.now())
	if err != nil {
		return
	}
	if err := bot.UpdateCard(context.WithoutCancel(ctx), messageID, disarmed); err != nil {
		rep.note("Could not replace the verification card (it is inert either way): %s", rep.errText(err))
	}
}

// connectionEnd describes why the connection goroutine returned. A nil error
// is a real case — the SDK's channel can close cleanly — and "connection
// ended: " with nothing after it reads like a truncated log line.
func connectionEnd(rep *reporter, err error) string {
	if err == nil {
		return "it closed cleanly, which at this point means the socket went away"
	}
	return rep.errText(err)
}

// accepts reports whether id may drive this verification. An empty allowlist
// accepts anyone, which is only reachable on the repair path and is announced
// when it happens.
func accepts(allowed []string, id string) bool {
	if len(allowed) == 0 {
		return id != ""
	}
	return slices.Contains(allowed, id)
}

// value reads a string field out of a card action payload.
func value(a lark.Action, key string) string {
	if a.Value == nil {
		return ""
	}
	s, _ := a.Value[key].(string)
	return s
}

// effectiveWait is max, shortened by the caller's own deadline.
//
// It gives the caller one knob that means what it says: bounding the whole run
// with a context bounds each wait inside it, instead of a Ctrl-C being the only
// way out of a 150-second wait the caller never asked for.
func effectiveWait(ctx context.Context, max time.Duration) time.Duration {
	deadline, ok := ctx.Deadline()
	if !ok {
		return max
	}
	left := time.Until(deadline)
	if left <= 0 {
		return 0
	}
	if left < max {
		return left
	}
	return max
}
