package screen

import (
	"strings"
	"unicode/utf8"
)

// minRuleDashes is how many consecutive box-drawing dashes make a line a
// horizontal rule. Ten is high enough that a decorative `───` inside transcript
// text is not mistaken for a box edge, and far below the width of any real
// input box, even on a 53-column never-attached pane (G5).
const minRuleDashes = 10

// fallbackTailLines is how much of the bottom of the screen is treated as the
// input box when the screen has no rule pair to anchor on.
const fallbackTailLines = 5

// maxLinesBelowBox is how many non-blank lines may sit under the lowest
// horizontal rule before we stop believing that rule is the composer's bottom
// edge. Claude puts one status hint under its box (`⏵⏵ accept edits on …`),
// codex a couple; eight leaves room for a context warning or two on top of
// that, and is still far less than the distance from a boxed welcome banner at
// the top of a transcript to the bottom of the screen.
const maxLinesBelowBox = 8

// composerGlyphs are the leading glyphs an agent with an UNBORDERED composer
// puts in front of the line you type on.
//
// codex 0.147 is the measured case (G21): it draws `› ` at the left margin and
// no box at all, so the rule pair this file looks for first does not exist on
// its screens — except for the first few turns of a session, when the only box
// on screen is the welcome banner.
//
// Deliberately one glyph. `>` and `❯` are NOT here: claude draws `>` inside its
// bordered box (behind a `│`, so it never starts a line) and `❯` in front of the
// highlighted option of a permission dialog, and admitting either would let a
// menu be mistaken for a composer on any screen whose rules are missing.
const composerGlyphs = "›"

// InputBoxRange locates the agent's input box and returns the half-open line
// range [start, end) it occupies, borders included.
//
// Scanning upward from the bottom, the first horizontal rule is the box's lower
// edge and the next one above it is the upper edge. Pairing bottom-up matters:
// Claude fences its permission dialog with rules too, so anchoring on the
// topmost rule instead would swallow the "Do you want to proceed?" block — the
// one part of the screen a caller most needs to keep.
//
// The returned range is exactly the box: it begins at the upper rule and ends
// one past the lower rule. Content below the box is NOT excluded — the status
// hint Claude prints there is its own chrome, never an echo of what the user
// typed, so excluding it would hide real screen content and buy nothing. Only
// the fallback below runs to the end of the slice.
//
// Three situations do not use the pair:
//
//   - No pair exists, but the screen has an unbordered composer (codex, G21):
//     the range runs from the composer's glyph line to the end of the input.
//   - A pair exists with a composer glyph line BELOW it: the pair is a box in
//     the transcript that happens to be the only one on screen — measured on a
//     fresh codex session, where the welcome banner is boxed and the composer
//     is not (G21). The composer wins; keeping the banner would leave the
//     bottom of the screen unexcluded.
//   - Neither exists: the range degrades to the last fallbackTailLines
//     non-blank lines through the end of the input. That fallback is blunt on
//     purpose and errs towards covering too much, which is why it must not be
//     reached for a TUI we can actually locate the composer on: it swallows the
//     tail of the TRANSCRIPT too, and the transcript is where a delivery to a
//     settled agent is proven.
//
// A pair whose lower rule has more than maxLinesBelowBox non-blank lines under
// it is not a composer either — it is something in the transcript, a welcome
// banner or a boxed diff — and no pair is reported at all.
//
// ok is false only when there is nothing non-blank to point at.
//
// Callers verifying that a prompt was delivered must exclude this range
// entirely: Claude renders ghost completion suggestions inside the input box,
// so text can appear there that the user never sent (G4). Every choice above is
// made so that the range covers wherever typed text can land, even at the cost
// of covering more: a false "not delivered" costs a retry, a false "delivered"
// loses the user's message.
func InputBoxRange(lines []string) (start, end int, ok bool) {
	composer, hasComposer := composerLine(lines)
	if top, bottom, found := rulePair(lines); found {
		// The composer sitting below the pair is what tells a welcome banner
		// from a composer: nothing is ever typed above the box you type in.
		if !hasComposer || composer < bottom {
			return top, bottom, true
		}
	}
	if hasComposer {
		return composer, len(lines), true
	}
	return fallbackRange(lines)
}

// rulePair finds the bordered composer: the lowest pair of horizontal rules
// whose lower edge is near enough to the bottom of the screen to be a composer.
func rulePair(lines []string) (top, bottom int, ok bool) {
	low := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if !isRule(lines[i]) {
			continue
		}
		if low < 0 {
			if nonBlankAfter(lines, i) > maxLinesBelowBox {
				// The lowest rule on the screen is nowhere near the bottom, so
				// there is no composer to pair up; anything typed lives in the
				// unruled text below it. Every rule above this one is farther
				// from the bottom still, so there is nothing left to find.
				break
			}
			low = i
			continue
		}
		return i, low + 1, true
	}
	return 0, 0, false
}

// composerLine returns the line an unbordered composer begins on: the lowest
// line starting with a composer glyph, provided it is near enough to the bottom
// to be the composer and not one of the user's earlier messages quoted in the
// transcript — codex prefixes those with the same glyph.
//
// The first line is enough to anchor on because it is the only one that carries
// the glyph: a draft that wraps, and a draft with real newlines in it, both
// continue on indented lines with no glyph (G21). So everything typed lies
// between this line and the end of the input.
func composerLine(lines []string) (int, bool) {
	for i := len(lines) - 1; i >= 0; i-- {
		if !startsWithComposerGlyph(lines[i]) {
			continue
		}
		if nonBlankAfter(lines, i) > maxLinesBelowBox {
			// The lowest glyph on the screen is far above the bottom, so it is
			// transcript and there is no composer to find. Anything higher is
			// farther still.
			return 0, false
		}
		return i, true
	}
	return 0, false
}

func startsWithComposerGlyph(line string) bool {
	line = strings.TrimSpace(line)
	if line == "" {
		return false
	}
	r, _ := utf8.DecodeRuneInString(line)
	return strings.ContainsRune(composerGlyphs, r)
}

// nonBlankAfter counts the non-blank lines strictly below i, stopping once the
// answer can no longer change the caller's decision.
func nonBlankAfter(lines []string, i int) int {
	n := 0
	for j := i + 1; j < len(lines); j++ {
		if strings.TrimSpace(lines[j]) == "" {
			continue
		}
		n++
		if n > maxLinesBelowBox {
			break
		}
	}
	return n
}

func fallbackRange(lines []string) (start, end int, ok bool) {
	start = -1
	seen := 0
	for i := len(lines) - 1; i >= 0 && seen < fallbackTailLines; i-- {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		seen++
		start = i
	}
	if start < 0 {
		return 0, 0, false
	}
	return start, len(lines), true
}

// isRule reports whether a line is a horizontal rule: nothing but box-drawing
// characters, containing a run of at least minRuleDashes dashes. Corner and
// junction glyphs are allowed so that a boxed edge such as `╭────────────╮`
// counts, and a cropped one such as `╭─────` still counts after Clean has cut
// it to phone width.
//
// ASCII '-' and '=' are deliberately not dashes here. Markdown rules and
// `------` separators are everywhere in agent output, and treating them as box
// edges would invent an input box in the middle of the transcript.
func isRule(line string) bool {
	line = strings.TrimSpace(line)
	if line == "" {
		return false
	}
	run, longest := 0, 0
	for _, r := range line {
		if !isBoxDrawing(r) {
			return false
		}
		if isBoxDash(r) {
			run++
			if run > longest {
				longest = run
			}
			continue
		}
		run = 0
	}
	return longest >= minRuleDashes
}

// isBoxDrawing reports whether r is in the Box Drawing block. Verticals live in
// that block too, but a column of `│` has no dash run and so never passes
// isRule.
func isBoxDrawing(r rune) bool { return r >= 0x2500 && r <= 0x257F }

// isBoxDash covers the horizontal members of the Box Drawing block: light,
// heavy, the dashed variants and the double rule.
func isBoxDash(r rune) bool {
	switch r {
	case '─', '━', '┄', '┅', '┈', '┉', '╌', '╍', '═':
		return true
	}
	return false
}
