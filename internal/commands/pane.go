package commands

import (
	"regexp"
	"strings"
)

// paneHint is appended to every pane-shaped error so the user learns the
// accepted forms without having to ask for /help.
const paneHint = "panes look like w1:p1; herdr also takes w1-1, p_1_1 and a bare 1"

// paneForms are the shapes herdr tolerates for a pane id.
//
// The digit runs are capped: pane ids are small ordinals, so a 40-digit
// "number" is a typo, and rejecting it produces a clear error instead of a
// herdr round trip that fails with not_found.
var paneForms = []*regexp.Regexp{
	regexp.MustCompile(`^w[0-9]{1,6}:p[0-9]{1,6}$`),   // canonical, the only id stable across restarts (G10)
	regexp.MustCompile(`^w[0-9]{1,6}-[0-9]{1,6}$`),    // legacy dash form
	regexp.MustCompile(`^p_w?[0-9]{1,6}_[0-9]{1,6}$`), // legacy underscore form
	regexp.MustCompile(`^[0-9]{1,6}$`),                // bare pane index
}

// normalizePane validates a pane token and returns the value to hand to the
// herdr layer.
//
// The result is a herdr *target*, NOT necessarily a canonical pane_id. herdr's
// agent.* calls take a free-form target and resolve "w1-1", "p_1_1" and "3"
// themselves, but everything keyed on identity — the registry, the per-pane
// busy queue, the (pane_id, state_seq) notify idempotency key, mirror state —
// is keyed on the pane_id that agent.list reports. "/mirror 3 on" and
// "/mirror w1:p1 on" can therefore name one pane and produce two map keys.
// Callers must resolve this value to a canonical pane_id once (agent.get, or a
// registry snapshot match) and key their own state on that, never on this
// string.
//
// It case-folds and nothing else. herdr resolves the legacy shapes itself,
// and w<N>:p<M> is the only form measured to be stable across restarts (G10),
// so rewriting "1" into "w1:p1" here would mean guessing at a mapping nobody
// measured. Whether the pane actually exists is herdr's call, not ours; this
// function only rejects tokens that cannot be a pane id at all — which is the
// part that matters, because a token that is not a pane must not silently
// become the first word of a message to an agent.
func normalizePane(tok string) (string, bool) {
	s := strings.ToLower(strings.TrimSpace(tok))
	for _, re := range paneForms {
		if re.MatchString(s) {
			return s, true
		}
	}
	return "", false
}
