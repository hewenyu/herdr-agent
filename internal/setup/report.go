package setup

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// redacted replaces the app secret anywhere it might otherwise be printed. It
// is fixed-width for the reason internal/config gives: the length of a secret
// is information a log file should not outlive it with.
const redacted = "<redacted>"

// minScrubLen is the shortest secret worth pattern-matching for, mirroring
// internal/config. Scrubbing a short string out of a whole line would corrupt
// the line without protecting anything.
const minScrubLen = 8

// reporter is the only route from this package to Progress.
//
// It exists for three reasons, all of which have to hold on every single call:
// the stdout redirect has to be lifted around the callback (see
// stdoutCapture.direct), the app secret has to be scrubbed out of anything we
// interpolate, and the callbacks arrive from several goroutines — the
// registration poll loop, the SDK's message pipeline, the run itself — while a
// CLI's Progress implementation is entitled to assume it is called one at a
// time.
type reporter struct {
	mu       sync.Mutex
	progress Progress
	capture  *stdoutCapture
	// secrets is a list rather than one value because a run can hold two: the
	// two-app question resolves a name for EACH candidate, which means holding
	// each one's secret, and forgetting the first while the second is armed
	// would be a hole in the one guarantee this package cannot compromise.
	secrets []string
}

// useSecret arms the scrubber. It must be called before any Progress call that
// could carry the secret, i.e. the instant registration returns it.
func (r *reporter) useSecret(secret string) {
	if len(secret) < minScrubLen {
		// Scrubbing a short string out of a whole line would corrupt the line
		// without protecting anything (see minScrubLen).
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.secrets {
		if s == secret {
			return
		}
	}
	r.secrets = append(r.secrets, secret)
}

// clean removes every armed secret from s.
func (r *reporter) clean(s string) string {
	for _, secret := range r.secrets {
		s = strings.ReplaceAll(s, secret, redacted)
	}
	return s
}

func (r *reporter) call(f func(Progress)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.capture.direct(func() { f(r.progress) })
}

func (r *reporter) note(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	r.mu.Lock()
	msg = r.clean(msg)
	r.mu.Unlock()
	r.call(func(p Progress) { p.Note(msg) })
}

func (r *reporter) verification(url string, expiresIn int) {
	r.call(func(p Progress) { p.Verification(url, expiresIn) })
}

func (r *reporter) registered(appID, openID string) {
	r.call(func(p Progress) { p.Registered(appID, openID) })
}

// configured reports the app the run settled on, exactly once.
//
// A Narrator gets the whole App and renders it; a plain Progress gets
// Registered only when an app was demonstrably created, and sentences that
// claim nothing more than what happened otherwise. The old shape of this — one
// callback whose only rendering says "created" — is how a run came to announce
// the creation of an app that had existed since that morning.
func (r *reporter) configured(a App) {
	if n, ok := r.progress.(Narrator); ok {
		r.call(func(Progress) { n.Configured(a) })
		return
	}
	if a.Origin == OriginCreated {
		// The only path on which "created" is a fact: CreateOnly was set, so the
		// page could not have handed back an app that already existed.
		r.registered(a.ID, a.OpenID)
		return
	}
	for _, line := range configuredNotes(a) {
		r.note("%s", line)
	}
}

// awaitMessage asks for the direct message, naming the bot.
//
// Progress.AwaitInbound is not used, on any path. Its arguments carry no app, so
// its only possible rendering names the bot from something other than
// bot/v3/info — the one implementation that exists names it from the AppPreset
// we asked the confirmation page to pre-fill, and printed that guess one line
// above this package's Note giving the real name. Narrowing which origins reached
// it did not help: the primary path is a page-configured one, so the
// contradiction survived on exactly the run a new user makes. A plain Progress
// gets the whole request as Notes instead; a Narrator gets the App.
func (r *reporter) awaitMessage(a App, d time.Duration) {
	if n, ok := r.progress.(Narrator); ok {
		r.call(func(Progress) { n.AwaitMessage(a, d) })
		return
	}
	for _, line := range awaitMessageNotes(a, d) {
		r.note("%s", line)
	}
}

// waitSeconds renders a wait the way the human will count it. Rounding down
// would promise less time than there is; up is the honest direction for a
// deadline.
func waitSeconds(d time.Duration) int {
	if d <= 0 {
		return 0
	}
	return int((d + time.Second - 1) / time.Second)
}

// configuredNotes is the prose for a Progress that cannot receive an App. One
// entry per line, so a CLI that indents notes keeps its shape.
func configuredNotes(a App) []string {
	out := []string{configuredSentence(a)}
	switch a.Origin {
	case OriginRegistered, OriginCreated, OriginUpdated:
		out = append(out, fmt.Sprintf("Its secret was written to %s, mode 0600, and is printed nowhere: "+
			"not here, not in a log, not as a prefix and not as a length.", a.EnvPath))
	}
	if a.OpenID != "" {
		out = append(out, fmt.Sprintf("Confirming user: %s. Only ids in feishu.allowed_open_ids may drive "+
			"your agents, and driving an agent is equivalent to a shell on this machine.", a.OpenID))
	}
	return out
}

// configuredSentence says what is known about the app and nothing else.
//
// Every branch is written against one rule: the sentence must survive being read
// next to the truth. "created" appears once, on the one path where the platform
// could not have done anything else, and neither "confirmed" nor "you just"
// appears on a path where no confirmation page was opened at all.
func configuredSentence(a App) string {
	switch a.Origin {
	case OriginCreated:
		return fmt.Sprintf("App %s was created.", named(a))
	case OriginUpdated:
		return fmt.Sprintf("App %s is now configured: the confirmation page granted the scopes, events and "+
			"callbacks the bridge needs to that app, which already existed. No new app was made.", named(a))
	case OriginAdopted:
		return fmt.Sprintf("App %s was already set up on this machine — %s — so this run made no new app and "+
			"opened no confirmation page.", named(a), foundIn(a))
	case OriginReused:
		return fmt.Sprintf("App %s is already configured in %s, so this run made no new app, opened no "+
			"confirmation page and wrote nothing.", named(a), a.EnvPath)
	default:
		// OriginRegistered, and anything a future path forgets to classify: the
		// page ran without CreateOnly, so it may have created this app or
		// returned one the tenant already had, and the result is identical
		// either way.
		return fmt.Sprintf("App %s is now configured. That page may have created it, or you may have picked an "+
			"app you already had — either way it now carries the scopes, events and callbacks the bridge needs.",
			named(a))
	}
}

// awaitMessageNotes is the whole wait request for a Progress that cannot receive
// an App: which bot, what kind of message, how long, and what it proves.
//
// One entry per line, so a CLI that indents notes keeps its shape — the same
// reason configuredNotes is a slice. The countdown is in the first line because
// it is the one part of this the human is racing.
func awaitMessageNotes(a App, d time.Duration) []string {
	return []string{
		fmt.Sprintf("Message the bot in Feishu now. Waiting %ds.", waitSeconds(d)),
		whichBot(a),
		"Send it a DIRECT message from your own account — a group chat cannot finish this, because the chat " +
			"the message arrives in becomes notify_chat_id, and agent screens get pushed there.",
		"That one message proves the credentials, the bot, the event subscription, the delivery mode, the " +
			"published version, the scopes and the allowlist.",
	}
}

// whichBot names the bot to look for, or admits Feishu would not say.
//
// It never falls back to appName: that is what we asked the page to pre-fill,
// the human is free to change it there and did, and an id that cannot be found
// by searching is still better than a name that finds the wrong bot.
func whichBot(a App) string {
	if a.Name == "" {
		return fmt.Sprintf("Feishu did not tell us what this bot is called, so look for the app with id %s.", a.ID)
	}
	return fmt.Sprintf("The bot is called %q (app %s) — search Feishu for that name.", a.Name, a.ID)
}

// foundIn says where an adopted app's credentials were, naming BOTH files when
// they were in two files.
//
// "its credentials were in <file>" was measured to be false in the one case
// nobody reproduces by hand: an app id in <stateDir>/.env and a secret in the
// repository .env are one pair as far as the bridge is concerned
// (config.loadDotEnv merges key by key), and that sentence named the file which
// never held the secret while the file that did was never mentioned.
func foundIn(a App) string {
	switch {
	case a.From == "":
		return "its credentials were already on this machine"
	case a.FromSecret == "" || a.FromSecret == a.From:
		return "its credentials were in " + a.From
	default:
		return fmt.Sprintf("%s named it and %s held its secret", a.From, a.FromSecret)
	}
}

// named renders an app the way a human recognises one: the name if we know it,
// with the id, and never a name we did not observe.
func named(a App) string {
	if a.Name == "" {
		return a.ID + " (Feishu did not tell us its name)"
	}
	return fmt.Sprintf("%s (%s)", a.Name, a.ID)
}

func (r *reporter) awaitCard(d time.Duration) {
	r.call(func(p Progress) { p.AwaitCard(d) })
}

// errText renders an error for a human, with the secret removed.
//
// Errors from the SDK are not expected to carry the secret — the registration
// decode path reports offsets, not bodies — but "not expected to" is the wrong
// standard for the one string in this program that must never be printed.
func (r *reporter) errText(err error) string {
	if err == nil {
		return ""
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.clean(err.Error())
}
