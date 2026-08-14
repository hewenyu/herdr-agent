package mirror

import "strings"

// Both agents talk to themselves through the user channel: they wrap machine
// context in XML-ish elements and file it under role "user". A mirror that
// believes the role shows the human saying things nobody typed — and it is not
// hypothetical for either vendor, since a pane enabled before the agent created
// its transcript is read from byte 0 and therefore sees the session preamble.
//
// The test is an ALLOWLIST of the wrappers each vendor actually writes, not the
// shape "one XML element". Shape is not a safe proxy for provenance: a human
// asking "fix <div>this markup</div>" types exactly that shape, and dropping it
// leaves the assistant answering a question the chat never shows.

// codexInjectedTags are the wrappers Codex injects. Captured from the real
// rollout in testdata (environment_context, INSTRUCTIONS inside the AGENTS.md
// preamble, and the developer-role skills_instructions / multi_agent_mode that
// the role filter already catches, listed here because the role is not
// guaranteed).
var codexInjectedTags = map[string]bool{
	"environment_context": true,
	"user_instructions":   true,
	"skills_instructions": true,
	"multi_agent_mode":    true,
	"INSTRUCTIONS":        true,
}

// claudeInjectedTags are the wrappers Claude Code injects into user records.
// command-name/-message/-args carry a slash command (`/model`, `/clear`),
// local-command-stdout its output; both are captured in
// testdata/claude-commands.jsonl. system-reminder is the same family — Claude's
// own note to the model — and is listed for the same reason.
var claudeInjectedTags = map[string]bool{
	"command-name":         true,
	"command-message":      true,
	"command-args":         true,
	"local-command-stdout": true,
	"system-reminder":      true,
}

// isInjectedContext reports whether a Codex user-role block is machine-
// generated context rather than something the human typed.
func isInjectedContext(text string) bool {
	// The AGENTS.md preamble is prose with a heading, not an element.
	if strings.HasPrefix(text, "# AGENTS.md instructions") {
		return true
	}
	return wrappedInKnownTags(text, codexInjectedTags)
}

// isInjectedClaudeText reports whether a Claude user record is one of Claude's
// own wrappers rather than typed prose.
func isInjectedClaudeText(text string) bool {
	return wrappedInKnownTags(text, claudeInjectedTags)
}

// wrappedInKnownTags reports whether text consists ENTIRELY of elements whose
// tag names are in allow.
//
// "Entirely" is the load-bearing half: a record that mixes an injected wrapper
// with real prose keeps the prose (the wrapper is a separate block, and blocks
// are filtered one at a time). A slash command is several elements in a row —
// <command-name> then <command-message> then <command-args> — so this consumes
// as many as it finds and only reports true if nothing is left over.
func wrappedInKnownTags(text string, allow map[string]bool) bool {
	s := strings.TrimSpace(text)
	matched := false
	for s != "" {
		name, rest, ok := consumeElement(s)
		if !ok || !allow[name] {
			return false
		}
		matched = true
		s = strings.TrimSpace(rest)
	}
	return matched
}

// consumeElement peels one leading <tag>…</tag> off s, returning the tag name
// and whatever follows it. The first matching close tag ends the element: these
// wrappers do not nest inside themselves, and treating a stray close tag as the
// end can only make the caller keep MORE text than it drops.
func consumeElement(s string) (name, rest string, ok bool) {
	if !strings.HasPrefix(s, "<") {
		return "", "", false
	}
	open := strings.IndexByte(s, '>')
	if open < 2 {
		return "", "", false
	}
	name = s[1:open]
	closing := "</" + name + ">"
	i := strings.Index(s[open+1:], closing)
	if i < 0 {
		return "", "", false
	}
	return name, s[open+1+i+len(closing):], true
}
