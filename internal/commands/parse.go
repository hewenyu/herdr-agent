package commands

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// helpHint closes every error message. A user who is told what went wrong but
// not where to look types their intent as prose instead, and prose aimed at a
// blocked agent is an approval (G1).
const helpHint = "/help lists the commands."

// commandPrefixes open a command.
//
// Only the ASCII "/" is a command marker per contract.go; the rest are
// deliberate additions, because the failure they prevent is asymmetric.
// Reading "／stop w1:p1" as prose sends that line to the agent, and if the
// agent is sitting on a permission dialog the trailing Enter selects the
// highlighted "1. Yes" (G1). Refusing a legitimate message that happens to
// open with one of these costs the user one retry; missing one costs an
// unintended approval.
//
//   - U+FF0F FULLWIDTH SOLIDUS: what a Chinese IME gives you for "/".
//   - U+2044 FRACTION SLASH, U+2215 DIVISION SLASH: visually identical to "/"
//     in most fonts, and reachable from phone symbol pickers and from text
//     pasted out of a document.
var commandPrefixes = []string{"/", "／", "⁄", "∕"}

// maxEchoRunes bounds how much of the user's own input an error message quotes
// back at them.
//
// Reason is user-facing output and outbound.Split cuts at 4000 runes with no
// cap on the number of chunks, so echoing an unbounded token turns one pasted
// whitespace-free blob (a long URL path, a base64 line) into hundreds of
// Feishu messages and burns the rate limit.
const maxEchoRunes = 40

// ellipsize shortens a token for quoting back in an error.
func ellipsize(s string) string {
	r := []rune(s)
	if len(r) <= maxEchoRunes {
		return s
	}
	return string(r[:maxEchoRunes]) + "…"
}

// trimLeadingNoise strips whitespace and invisible format characters from the
// front of a line.
//
// strings.TrimSpace uses unicode.White_Space, which does not cover category Cf
// — so a zero-width space, a BOM, a zero-width joiner or a direction override
// in front of the marker (all of which phones, IMEs and copy-paste produce, and
// none of which the user can see) would make "<invisible>/stop w1:p1" fail the
// prefix test and come back as prose aimed at the agent (G1). unicode.Cf
// includes U+FEFF, so the BOM needs no special case.
func trimLeadingNoise(s string) string {
	return strings.TrimLeftFunc(s, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.Is(unicode.Cf, r)
	})
}

// Parse turns one chat message into a Command. It is pure: no I/O, no clock,
// no state, and it never panics.
//
// The property that outranks every convenience here: input that looks like a
// command NEVER comes back as KindProse. When the parser cannot make sense of
// a slash line it says so (KindUnknown / KindBadArgs) and the caller replies
// with the error. It does not fall back to "send it to the agent" — that
// fallback is what turns "/stpo w1:p1" into an approval (G1).
func Parse(s string) Command {
	// The marker test runs on the noise-stripped line; Text keeps the
	// space-trimmed original. What we route on is our business, what we hand to
	// an agent is what the user typed.
	trimmed := strings.TrimSpace(s)
	visible := trimLeadingNoise(trimmed)
	if visible == "" {
		// Empty, whitespace, or nothing but invisible characters. Prose is the
		// wrong answer even for the last one: a message with no visible content
		// pasted at a blocked agent still ends in the Enter that approves the
		// dialog (G1).
		return Command{Kind: KindBadArgs, Raw: s, Reason: "empty message. " + helpHint}
	}

	body, isCommand := stripCommandPrefix(visible)
	if !isCommand {
		return Command{Kind: KindProse, Text: trimmed, Raw: s}
	}

	// cutToken skips whitespace, so "/ stop w1:p1" is read as "/stop w1:p1".
	// A stray space after the marker is a phone typo, not a different
	// intention, and the alternative reading — free text beginning with a
	// slash — is the one that must never happen (G1).
	name, rest := cutToken(body)
	name = strings.ToLower(name)
	if name == "" {
		// A lone slash. Prose is not an option: the user was reaching for a
		// command and their next keystroke is unknown to us.
		return Command{Kind: KindUnknown, Raw: s, Reason: "that is just a slash. " + helpHint}
	}

	sp, ok := lookup(name)
	if !ok {
		return Command{Kind: KindUnknown, Raw: s, Reason: unknownReason(name)}
	}
	return sp.parse(sp, rest, s)
}

// Help renders the command table.
//
// Deliberately NOT a markdown table: Feishu's post renderer turns a
// GitHub-style table into a blank bubble, so the one message whose whole job
// is to tell the user what they can type would arrive empty (S2 §3.8).
func Help() string {
	width := 0
	for _, sp := range table {
		if n := utf8.RuneCountInString(sp.usage()); n > width {
			width = n
		}
	}

	var b strings.Builder
	b.WriteString("Commands. Anything that does not start with / is sent to an agent as text.\n")
	for _, sp := range table {
		u := sp.usage()
		b.WriteString("  ")
		b.WriteString(u)
		b.WriteString(strings.Repeat(" ", width-utf8.RuneCountInString(u)+2))
		b.WriteString(sp.summary)
		b.WriteString("\n")
	}
	b.WriteString("\n")
	b.WriteString(paneHint + ".\n")
	b.WriteString("Reply to one of my messages to aim at that agent without naming a pane.\n")
	return b.String()
}

// stripCommandPrefix reports whether s opens a command and returns what
// follows the marker.
func stripCommandPrefix(s string) (string, bool) {
	for _, p := range commandPrefixes {
		if strings.HasPrefix(s, p) {
			return s[len(p):], true
		}
	}
	return s, false
}

// cutToken splits off the first whitespace-delimited token and returns the
// remainder with its internal layout intact — a /say body may contain
// newlines and they belong to the user's message.
//
// unicode.IsSpace, not " ": phone keyboards emit NBSP (U+00A0) and the
// ideographic space (U+3000), and a pane token followed by one of those must
// still parse as a pane rather than as an unknown blob.
func cutToken(s string) (token, rest string) {
	s = strings.TrimLeftFunc(s, unicode.IsSpace)
	i := strings.IndexFunc(s, unicode.IsSpace)
	if i < 0 {
		return s, ""
	}
	return s[:i], strings.TrimLeftFunc(s[i:], unicode.IsSpace)
}

// parseNoArgs handles the commands that take nothing.
//
// Trailing words are ignored rather than rejected: none of them can change
// what the command does, so "/ls now" should list agents, not raise an error.
func parseNoArgs(sp spec, _, raw string) Command {
	return Command{Kind: sp.kind, Raw: raw}
}

// parsePane handles "/card <pane>" and "/stop <pane>".
//
// Extra words after the pane are ignored for the same reason as parseNoArgs,
// and with one extra argument for /stop specifically: it is the escape hatch
// that gets a human out of a permission dialog safely (G2). Refusing to run
// it because the user appended "now" is a worse outcome than ignoring a word.
func parsePane(sp spec, rest, raw string) Command {
	tok, _ := cutToken(rest)
	if tok == "" {
		return badArgs(sp, raw, "which pane?")
	}
	pane, ok := normalizePane(tok)
	if !ok {
		return badArgs(sp, raw, fmt.Sprintf("%q is not a pane id; %s", ellipsize(tok), paneHint))
	}
	return Command{Kind: sp.kind, Pane: pane, Raw: raw}
}

// parseSay handles "/say <pane> <text...>".
func parseSay(sp spec, rest, raw string) Command {
	tok, body := cutToken(rest)
	if tok == "" {
		return badArgs(sp, raw, "which pane, and what should I say?")
	}
	pane, ok := normalizePane(tok)
	if !ok {
		// Note what does NOT happen here: the line is not re-read as prose
		// with the bad token as its first word. "/say stpo w1:p1" is a
		// mistake, and delivering a mistake to an agent is how G1 happens.
		return badArgs(sp, raw, fmt.Sprintf("%q is not a pane id; %s", ellipsize(tok), paneHint))
	}
	text := strings.TrimSpace(body)
	if text == "" {
		return badArgs(sp, raw, "there is no text to send")
	}
	return Command{Kind: sp.kind, Pane: pane, Text: text, Raw: raw}
}

// parseMirror handles "/mirror <pane> on|off".
//
// Unlike /card and /stop this one rejects trailing junk: the third token
// carries meaning, so a fourth means we did not understand the line. Guessing
// would be silent — the user would believe mirroring is on when it is off.
func parseMirror(sp spec, rest, raw string) Command {
	tok, rest2 := cutToken(rest)
	if tok == "" {
		return badArgs(sp, raw, "which pane, on or off?")
	}
	pane, ok := normalizePane(tok)
	if !ok {
		return badArgs(sp, raw, fmt.Sprintf("%q is not a pane id; %s", ellipsize(tok), paneHint))
	}
	state, extra := cutToken(rest2)
	if state == "" {
		return badArgs(sp, raw, "say whether you want it on or off")
	}
	if extra != "" {
		return badArgs(sp, raw, fmt.Sprintf("I did not understand %q after the on/off", ellipsize(extra)))
	}
	switch strings.ToLower(state) {
	case "on":
		return Command{Kind: sp.kind, Pane: pane, On: true, Raw: raw}
	case "off":
		return Command{Kind: sp.kind, Pane: pane, On: false, Raw: raw}
	default:
		return badArgs(sp, raw, fmt.Sprintf("%q is neither on nor off", ellipsize(state)))
	}
}

// badArgs reports a recognised command we could not act on.
//
// Pane and Text are left empty even when part of the line did parse: a caller
// that reads them off a KindBadArgs command would be acting on a line the
// parser refused to understand.
func badArgs(sp spec, raw, why string) Command {
	return Command{
		Kind:   KindBadArgs,
		Raw:    raw,
		Reason: fmt.Sprintf("%s: %s. usage: %s", "/"+sp.name, why, sp.usage()),
	}
}

// unknownReason explains an unrecognised slash command, naming the nearest
// known one when there is a plausible candidate.
//
// Every branch ends by naming /say. The user who typed an unrecognised slash
// line wanted *something* to reach the agent; if the error does not tell them
// the safe way to send text they will retype the line as prose, and prose to a
// blocked agent is an approval (G1). That includes the deliberate
// false-positive of treating "／" as a marker — a Chinese message opening with
// a fullwidth solidus is refused here, so it has to be told how to get through.
func unknownReason(name string) string {
	const sayHint = "To send that line to an agent as text, use /say <pane> <text>."
	short := ellipsize(name)

	if isDialogAnswer(name) {
		// Not a typo for anything: the user is answering a permission dialog
		// in the chat window. Point them at the two things that actually work
		// — the card's buttons (G16) and esc (G2) — not at a spelling guess.
		return fmt.Sprintf(
			"/%s looks like an answer to a dialog — press the button on the card, "+
				"or use /stop <pane> to send esc. %s",
			short, helpHint)
	}
	if s, ok := closest(name); ok {
		return fmt.Sprintf("unknown command /%s — did you mean /%s? %s %s", short, s, helpHint, sayHint)
	}
	return fmt.Sprintf("unknown command /%s. %s %s", short, helpHint, sayHint)
}
