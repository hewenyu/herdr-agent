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
	secret   string
}

// useSecret arms the scrubber. It must be called before any Progress call that
// could carry the secret, i.e. the instant registration returns it.
func (r *reporter) useSecret(secret string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.secret = secret
}

// clean removes the secret from s.
func (r *reporter) clean(s string) string {
	if len(r.secret) < minScrubLen {
		return s
	}
	return strings.ReplaceAll(s, r.secret, redacted)
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

func (r *reporter) awaitInbound(d time.Duration) {
	r.call(func(p Progress) { p.AwaitInbound(d) })
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
