package cards

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// maxSelectableOption is the highest menu number a card may offer.
//
// It is 9 because agents.AllowedKeys stops at "9": a two-digit answer is two
// keystrokes, and the menu acts on the first one before the second arrives. An
// option we cannot answer must never become a button — the dialog text in the
// card body still shows it, and the user can reply in prose instead.
const maxSelectableOption = 9

// maxContinuationLines caps how many wrapped lines are folded into one label.
//
// A never-attached pane is 53 columns wide (G5), so a long option such as
// "Yes, and don't ask again for touch commands in /tmp/herdr-accept" arrives
// as three lines. Four is enough for that and small enough that a paragraph of
// prose below the menu cannot be swallowed whole.
const maxContinuationLines = 4

// minMenuOptions is the size at which a run of numbers is credible as a menu.
//
// A dialog never asks a question with one answer: Claude's trust prompt has
// two, its Bash prompt three, codex two. A lone "1. …" is far more likely to be
// something echoed into the input box, which sits BELOW the dialog — Claude
// puts text there that nobody typed (G4), and a stray "❯ 1" landed there after
// an old card was pressed (G17). See parseOptions for what that costs.
const minMenuOptions = 2

// optionLine matches one numbered choice.
//
// The leading class absorbs the selection marker and any box edge: Claude
// draws the highlighted entry as "❯ 1. Yes" and leaves the others at "  2. No",
// its trust prompt renders inside a rounded box, and codex uses its own glyph.
// The marker is therefore optional and its exact shape is never relied on.
//
// A separator after the number is required, as is whitespace after that, so
// "1.5 seconds" and "2024. A year" are not menu entries. The label must start
// with a non-space so a bare "1." (an empty entry) does not become a button.
var optionLine = regexp.MustCompile(`^[ \t]*(?:[│|>❯›»▸▶◆•*+-][ \t]*)*([0-9]{1,2})[.)][ \t]+(\S.*)$`)

// borderRunes are the characters a TUI puts to the left of real content: the
// pane's box edge and padding. They are skipped when measuring indentation so
// that a wrapped label inside a box still reads as indented.
const borderRunes = " \t│|"

// parseOptions returns the choices of the menu the agent is currently showing.
//
// It scans for runs of consecutive numbers starting at 1 and prefers the LAST
// credible run. The live menu is the bottom-most numbered list in a dialog
// region, while a numbered list further up is the agent's own prose — and
// offering buttons for prose would put keys on the card that answer a menu the
// user is not looking at.
//
// "Credible" is what keeps the bottom-most rule from backfiring, because the
// input box sits below the dialog and the input box lies: Claude renders ghost
// completions there that nobody typed (G4), and a pressed card left a stray
// "❯ 1" in it (G17). A composer line reading "1. no thanks" under a live
// "1. Yes / 2. No" would otherwise become the whole menu — one button labelled
// "no thanks" that sends key 1, i.e. Yes. A run shorter than minMenuOptions
// therefore never displaces a run that reached it; the worst case degrades to
// the menu above rather than to a button whose label contradicts its key.
//
// Anything not understood yields no options at all; callers then offer Esc plus
// "reply in prose" rather than guessing (G1).
func parseOptions(lines []string) []Option {
	var best, cur []Option
	// labelCol is the column the current run's numbers start at, and cont
	// counts the wrapped lines already folded into the last label.
	labelCol, cont := 0, 0
	// broke records that one line the menu does not explain has just gone by.
	// The run survives it only if the very next line resumes the numbering.
	broke := false

	// end closes the run under construction; see the credibility rule above.
	end := func() {
		if len(cur) > 0 && (len(cur) >= minMenuOptions || len(best) < minMenuOptions) {
			best = cur
		}
		cur, labelCol, cont, broke = nil, 0, 0, false
	}

	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			// A menu is contiguous. Blank lines are already gone from a
			// screen.Screen, but a caller passing raw text gets the
			// conservative reading rather than a run stitched across a gap.
			end()
			continue
		}

		if m := optionLine.FindStringSubmatchIndex(line); m != nil {
			n, err := strconv.Atoi(line[m[2]:m[3]])
			switch {
			case err != nil || n > maxSelectableOption:
				// A tenth entry ends the run; the first nine survive as best.
				end()
			case n == 1:
				// A second "1." starts a new menu rather than extending the
				// old one: that is what the screen is saying.
				end()
				cur = []Option{{Key: "1", Label: label(line[m[4]:m[5]])}}
				labelCol, cont = utf8.RuneCountInString(line[:m[2]]), 0
			case n == len(cur)+1:
				cur = append(cur, Option{Key: strconv.Itoa(n), Label: label(line[m[4]:m[5]])})
				labelCol, cont, broke = utf8.RuneCountInString(line[:m[2]]), 0, false
			default:
				// Out of order: this is not the menu we were reading.
				end()
			}
			continue
		}

		switch {
		case broke:
			// Two lines running that the menu does not explain. Whatever this
			// is, we are no longer inside a menu.
			end()
		case len(cur) == 0:
			// No run open: this is the prose above the dialog. Only reset.
			end()
		case !isContinuation(line, labelCol):
			// One unexplained line is survivable: a rule drawn between entries,
			// or a wrapped tail the pane did not indent past the number (a 53
			// column pane wraps a lot, G5). Dropping the run here would silently
			// lose every option BELOW the line, so the card would show a subset
			// of the menu the user is reading. Wait one line for the numbering
			// to resume instead.
			broke = true
		case cont < maxContinuationLines:
			cont++
			last := &cur[len(cur)-1]
			last.Label = label(last.Label + " " + strings.TrimSpace(line))
		default:
			// Past the fold cap the line is dropped, not treated as a break: an
			// option too long to quote in full must not cost us the options
			// under it. The full dialog is in the card body either way.
		}
	}
	end()
	return best
}

// isContinuation reports whether line is the wrapped tail of the option above
// it: indented past the number and carrying actual words. The indent test is
// what keeps the separator rule and the status bar under a dialog out of the
// label.
//
// It cannot tell a wrapped tail from a footer hint that happens to be indented
// deeper than the number ("     Press esc to cancel" folds into the label of
// the option above it). That is cosmetic — the key the button sends is still
// the key its number names — and the alternative, matching known hint wording,
// would fold real option text such as "3. No, and tell Claude what to do
// differently (esc)" the moment a version reworded either one.
func isContinuation(line string, labelCol int) bool {
	if contentCol(line) <= labelCol {
		return false
	}
	// Box chrome and rules carry no words; only text continues a label.
	return strings.ContainsFunc(line, func(r rune) bool {
		return unicode.IsLetter(r) || unicode.IsDigit(r)
	})
}

// contentCol is the column, in runes, where a line's real content starts.
func contentCol(line string) int {
	n := 0
	for _, r := range line {
		if !strings.ContainsRune(borderRunes, r) {
			break
		}
		n++
	}
	return n
}

// label normalises one choice for display: the box edge a TUI draws on the
// right is dropped, and runs of whitespace collapse to one space.
//
// Collapsing is safe because the exact original text is still on the card, in
// the fenced code block; what a button needs is a phrase, not the pane's
// column alignment.
func label(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, borderRunes)
	return strings.Join(strings.Fields(s), " ")
}
