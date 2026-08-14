package bridge

import (
	"strings"
	"unicode"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/cards"
	"github.com/hewenyu/herdr-agent/internal/mirror"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

const (
	// mirrorRoleUser is mirror.Turn's role for a human turn. Its sibling
	// mirrorRoleAssistant lives in mirrorpump.go.
	mirrorRoleUser = "user"

	// doneTurns is how much of the transcript a finished notification samples.
	//
	// The window has to span a whole exchange, because the card wants both ends
	// of one: the last thing the agent SAID, and the request it answers. Claude
	// writes one record per content block (G8), so an ordinary coding exchange —
	// a request, three tool calls, a final message — is already five turns, and
	// a window of four opens after the request. The card then loses the "You
	// asked" line, which is what makes a notification recognisable on a lock
	// screen (see promptBefore). Twelve covers the tool records a real exchange
	// puts between the two halves.
	//
	// Its cost is a slice bound, not parsing: mirror.LastTurns parses the whole
	// TailBytes window whatever n is and then keeps the last n
	// (mirror/lastturns.go), so a wider sample reads no more transcript, it
	// copies a few more turns. Nor can it attach a stale question — the sampled
	// turns are contiguous, so the nearest user turn before the answer is the
	// request that preceded it; a newer request would sit after it, where
	// promptBefore does not look.
	doneTurns = 12

	// doneAnswerCells is the phone-sized budget for the body of the card,
	// measured in display cells rather than runes (see displayWidth).
	//
	// Roughly twenty lines at the width screen crops to, which is about as much
	// as a phone shows before the reader is scrolling rather than reading. It
	// is a READABILITY bound and deliberately tighter than the two bounds
	// cards.BuildDone applies, which are about the card being deliverable at
	// all. Past it the card says so and points at the Screen button, which is
	// where the whole of it has always been.
	doneAnswerCells = 1200
)

// doneAnswer decides what the finished card shows, and says honestly where it
// came from.
//
// The transcript is the source for CONTENT: it has roles and turn boundaries,
// so the agent's last message can be lifted out of it whole. The screen is the
// source for a pending DIALOG, because a transcript holds no permission record
// at all — that is G8's division of labour, and PushBlocked keeps the other
// half of it.
//
// Every path that cannot reach the transcript falls back to the screen tail the
// notifier already read, and marks the result FromScreen so the card disclaims
// it: a terminal tail carries earlier turns, tool output and an input box that
// shows completions nobody typed (G4), and a reader who took that for the
// agent's own words would be reading text no agent produced.
func (b *bridge) doneAnswer(a agents.Agent, tail screen.Screen) cards.Answer {
	path, ok := b.deps.Resolver.Resolve(a)
	if !ok {
		// Normal, not a failure: claude publishes a session id only once its
		// trust-this-directory prompt has been accepted and SessionStart has
		// fired, and codex needs its hook trusted with `t` first (G8). Every
		// session spends its first minutes here, so this is not a warning.
		b.log.Debug("bridge: finished agent has no transcript yet; showing the screen instead",
			"pane", a.PaneID, "kind", a.Kind)
		return screenAnswer(tail)
	}

	turns, err := mirror.LastTurns(path, a.Kind, doneTurns)
	if err != nil {
		// Worth a warning, unlike the case above: a kind with no parser or a
		// transcript that cannot be read does not fix itself, and the user would
		// otherwise only see that their cards permanently show a terminal.
		b.log.Warn("bridge: could not read a finished agent's transcript; showing the screen instead",
			"pane", a.PaneID, "kind", a.Kind, "path", path, "err", err)
		return screenAnswer(tail)
	}

	i := lastAssistantTurn(turns)
	if i < 0 {
		// A transcript that exists but whose sampled tail holds no assistant
		// turn: a session that has only just started, or a window that landed
		// entirely inside metadata records. There is nothing to quote.
		b.log.Debug("bridge: no assistant turn in the sampled transcript; showing the screen instead",
			"pane", a.PaneID, "path", path, "turns", len(turns))
		return screenAnswer(tail)
	}

	text, truncated := truncateCells(turns[i].Text, doneAnswerCells)
	if truncated {
		text = closeFence(text)
	}
	return cards.Answer{
		Prompt: promptBefore(turns, i),
		Text:   text,
		// The answering turn's own tool calls, and no others. Tool chatter is
		// the bulk of what made the old screen tail unreadable ("Ran 1 shell
		// command", twice, around one line of answer); the calls that belong to
		// earlier records of the same exchange stay behind the Screen button
		// with the rest of the detail.
		Tools:     turns[i].ToolCalls,
		Truncated: truncated,
	}
}

// closeFence re-closes a code fence that the cut landed inside.
//
// A coding agent's final message carrying a ``` block is the normal case, and
// the card renders a transcript answer as MARKDOWN — cards.answerBody only
// fences a body that is a screen tail or reads as commands. An odd number of
// markers therefore leaves a block open, and everything after it renders at the
// mercy of Feishu's handling of an unterminated fence. cards closes the fences
// IT cuts; this cut happens first, at a tighter budget, so it has to close its
// own.
func closeFence(text string) string {
	if strings.Count(text, "```")%2 == 0 {
		return text
	}
	return text + "\n```"
}

// screenAnswer is the fallback body: the tail PushDone was handed, marked as
// what it is.
//
// The same cell budget applies. The notifier's default tail is small enough
// that it never bites, but TailLines is configurable and a card that arrives
// nowhere is worse than one that is cut short.
//
// Deliberately NOT closeFence'd, unlike the transcript answer above. A screen
// tail is never rendered as markdown: cards.codeBlock wraps it whole, and both
// it and fencedBlock pick a fence longer than the longest run of backticks
// inside the text, so an unbalanced ``` in a terminal grid is already inert.
// Appending one would draw a line of backticks into the character grid that the
// crop exists to keep aligned (G5).
func screenAnswer(tail screen.Screen) cards.Answer {
	text, truncated := truncateCells(tail.Text(), doneAnswerCells)
	return cards.Answer{Text: text, Truncated: truncated, FromScreen: true}
}

// lastAssistantTurn returns the index of the turn to quote, or -1.
//
// It prefers the last assistant turn that actually SAID something. Claude
// writes one record per content block, so an exchange commonly ends with a
// record that is nothing but a tool call (G8); quoting that would produce a
// card announcing that the agent finished and has no final message, while the
// sentence the reader wants sits one record above it.
func lastAssistantTurn(turns []mirror.Turn) int {
	last := -1
	for i := len(turns) - 1; i >= 0; i-- {
		if turns[i].Role != mirrorRoleAssistant {
			continue
		}
		if strings.TrimSpace(turns[i].Text) != "" {
			return i
		}
		if last < 0 {
			// Remembered, not returned: a tool-only turn is still an assistant
			// turn, and showing its calls beats falling back to the terminal.
			last = i
		}
	}
	return last
}

// promptBefore returns the request the quoted turn answers.
//
// One line of context is what makes a notification recognisable on a lock
// screen — a bare "It is 01:23" answers a question the reader may have asked an
// hour ago. Only turns BEFORE the answer count: a user turn after it belongs to
// whatever the agent is doing next.
func promptBefore(turns []mirror.Turn, i int) string {
	for j := i - 1; j >= 0; j-- {
		if turns[j].Role == mirrorRoleUser && strings.TrimSpace(turns[j].Text) != "" {
			return turns[j].Text
		}
	}
	return ""
}

// ---------- display width ----------

// truncateCells cuts s to at most limit display cells and reports whether it
// had to. The ellipsis is charged one cell, so the result never exceeds the
// budget, and the cut always lands on a rune boundary — a rune that would
// overshoot ends the text a cell short instead of being split in half.
func truncateCells(s string, limit int) (string, bool) {
	if limit < 2 || displayWidth(s) <= limit {
		return s, false
	}
	used, cut := 0, len(s)
	for i, r := range s {
		w := runeWidth(r)
		if used+w > limit-1 {
			cut = i
			break
		}
		used += w
	}
	return s[:cut] + "…", true
}

// displayWidth reports how many terminal cells s occupies.
//
// This is a COPY of the rule in screen/width.go and cards/width.go, kept for
// the reason both of those state: one CJK rune is two cells, and this bridge
// carries Chinese, so a budget counted in runes would mean one width for
// English answers and half of it for Chinese ones. It is copied rather than
// imported because both owners keep it unexported behind a frozen contract
// file. Keep the table below identical to theirs: if one moves, move all.
func displayWidth(s string) int {
	w := 0
	for _, r := range s {
		w += runeWidth(r)
	}
	return w
}

// runeWidth is a deliberately small, dependency-free approximation of UAX #11:
// East Asian Wide and Fullwidth are two cells, combining marks and format
// characters are zero, everything else is one.
//
// Known imprecision, all in the direction of over-estimating width (which cuts
// slightly early — the safe direction for a phone): a few narrow characters
// inside the big CJK block count as two, and an emoji ZWJ sequence counts each
// pictograph rather than the single glyph a terminal may compose.
func runeWidth(r rune) int {
	switch {
	case r < 0x20 || r == 0x7F:
		// C0 controls occupy no cell. A newline inside a body therefore costs
		// nothing against a budget that is about how wide the text renders.
		return 0
	case r < 0x7F:
		// Fast path: printable ASCII is the bulk of any answer.
		return 1
	case unicode.Is(unicode.Mn, r), unicode.Is(unicode.Me, r), unicode.Is(unicode.Cf, r):
		// Combining marks compose onto the preceding cell; format characters
		// (ZWJ, ZWSP, bidi marks, the emoji variation selector U+FE0F) are not
		// drawn at all.
		return 0
	case isWideRune(r):
		return 2
	}
	return 1
}

// wideRanges are the East Asian Wide/Fullwidth blocks, in ascending order.
var wideRanges = [...]struct{ lo, hi rune }{
	{0x1100, 0x115F},   // Hangul Jamo initial consonants
	{0x2E80, 0xA4CF},   // CJK radicals through Yi: kana, ideographs, CJK punctuation
	{0xAC00, 0xD7A3},   // Hangul syllables
	{0xF900, 0xFAFF},   // CJK compatibility ideographs
	{0xFE30, 0xFE6F},   // CJK compatibility forms, small form variants
	{0xFF00, 0xFF60},   // fullwidth ASCII forms
	{0xFFE0, 0xFFE6},   // fullwidth currency and bar signs
	{0x1F300, 0x1F64F}, // pictographs and emoticons
	{0x1F680, 0x1F6FF}, // transport and map symbols
	{0x1F900, 0x1F9FF}, // supplemental pictographs
	{0x20000, 0x3FFFD}, // CJK extension B and beyond
}

func isWideRune(r rune) bool {
	for _, rg := range wideRanges {
		if r < rg.lo {
			// Table is ascending, so nothing further can match.
			return false
		}
		if r <= rg.hi {
			return true
		}
	}
	return false
}
