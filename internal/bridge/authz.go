package bridge

// authorized reports whether openID may drive agents on this machine.
//
// Default deny, exact match, no normalisation of the incoming id. The herdr
// socket has no authentication of its own and reaching it is equivalent to a
// shell (G10), so this one comparison is the security boundary of the product:
// everything downstream of it types into a live terminal.
//
// An open_id is an identity, not a bearer token — an attacker cannot try
// candidate ids, they would have to BE the account — so a constant-time compare
// would defend against nothing. Exactness is what matters, and trimming or
// case-folding the incoming value could only ever widen the set that matches.
func (b *bridge) authorized(openID string) bool {
	if openID == "" {
		// An event with no operator is not "everyone", it is nobody. A blank
		// allowlist entry would otherwise turn this into allow-anonymous, which
		// is why New rejects those too.
		return false
	}
	for _, allowed := range b.deps.AllowedOpenIDs {
		if allowed == openID {
			return true
		}
	}
	return false
}

// denied records a rejected event and says nothing to its sender.
//
// No reply, ever (S2 §3.4). A reply — even "not authorized" — confirms that the
// bot exists, that it is online, and that an allowlist is in force, which is
// three facts more than a stranger who guessed the bot's name should get. The
// WARN is the only trace, and it carries the open_id so the owner can add
// themselves after mistyping their own.
func (b *bridge) denied(ev inboundEvent) {
	b.log.Warn("bridge: dropping event from an unauthorized sender; no reply was sent",
		"kind", ev.Kind,
		"open_id", ev.Actor,
		"event_id", ev.EventID,
		"chat_id", ev.ChatID,
	)
}
