package cards

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/hewenyu/herdr-agent/internal/agents"
)

// Budgets for the finished card, in DISPLAY CELLS rather than runes.
//
// Runes would be the wrong unit twice over on this bridge: it carries Chinese,
// where one rune is two cells, so a "80 rune" line is 160 cells on the phone
// that has to read it — and the same budget would then mean two different
// widths depending on the language of the answer. screen crops in cells for
// exactly this reason (S1 §3.3, G5); see width.go.
const (
	// maxPromptCells bounds the context line: enough of the question to
	// recognise which one this answers, not so much that it pushes the answer
	// itself below the fold.
	maxPromptCells = 80
	// maxToolCells bounds one collapsed tool summary. `Bash(...)` around a
	// command with two absolute paths in it is longer than a phone's line.
	maxToolCells = 72
	// maxAnswerCells bounds the body. The answer is the payload and is meant to
	// be shown in full, so this is generous — it exists so that a runaway text
	// (a mirror that handed us a whole session, a screen fallback on a 49-row
	// pane) still produces a card Feishu accepts and a human can scroll. Past
	// it the card says so and points at the screen button.
	maxAnswerCells = 2000
	// maxAnswerRunes is the second half of that guarantee, and the one that is
	// actually about DELIVERY rather than about reading.
	//
	// Cells measure how wide text renders, so they bound nothing that renders
	// wide-less: a newline, a combining mark and a zero-width joiner all cost
	// zero, and a body of 200k newlines measures eight cells. Feishu's ceiling
	// is counted in characters, not in cells (8000, S2 §3.8,
	// outbound.MaxMessageRunes), and a card is sent whole — nothing downstream
	// splits it — so an oversize body does not arrive truncated, it does not
	// arrive at all, and the "agent finished" notification is lost entirely.
	// 4000 leaves the notes, the buttons and the JSON wrapper their room.
	maxAnswerRunes = 4000
)

// maxToolLines is how many tool summaries reach the card before the remainder
// collapse into "+N more".
//
// Five is what fits above the answer without burying it. The reader asked for
// the answer; the tool list is context, and context that outgrows its subject
// is the terminal scrollback this card exists to replace.
const maxToolLines = 5

// BuildDone renders the card posted when an agent finishes.
//
// It shows WHAT THE AGENT SAID. The screen tail it replaces was eighteen lines
// of scrollback — three previous turns, two "Ran 1 shell command", a spinner
// line, the empty prompt box, the status bar — around one line of answer. That
// is not a notification, it is a screenshot of a terminal, and the answer was
// the least prominent thing in it.
//
// It is also the division of labour G8 already established. A transcript has
// roles, turn boundaries and no TUI furniture, so CONTENT comes from there; a
// transcript has no pending-permission record at all, so BLOCKED comes from the
// screen. BuildBlocked reads the screen for that reason and must keep doing it.
// This card is the other half: the screen stays exactly one tap away, behind
// ActScreen, for the reader who wants the furniture after all.
//
// Both buttons are inert — nothing here can put a byte into the pane — so the
// nonce is deliberately unused. There is no single use to enforce when nothing
// can be sent, DecodeDecision refuses an inert value that carries a nonce, and
// writing one in would let a tap on this card spend a nonce a live blocked card
// still depends on. Refusing to build for want of a nonce would be worse still:
// it would drop the notification entirely to protect a button that cannot fire.
func BuildDone(a agents.Agent, answer Answer, nonce string, now time.Time) (string, error) {
	if a.PaneID == "" {
		// Same rule as BuildBlocked: the pane id is the address a press comes
		// back with (G16) and DecodeDecision requires it, so a card without one
		// is two buttons that must later be refused.
		return "", fmt.Errorf("%w: no pane id", errUnbuildable)
	}
	_ = nonce // inert card; see the note above.

	elements := make([]any, 0, 8)
	if line := promptLine(answer.Prompt); line != "" {
		elements = append(elements, newMarkdown("%s", line))
	}
	if lines := toolLines(answer.Tools); lines != "" {
		elements = append(elements, newMarkdown("%s", lines))
	}

	body, cut := answerBody(answer)
	if answer.FromScreen {
		// BEFORE the body, not after it. The body can run to maxAnswerCells of
		// fenced terminal — earlier turns, tool output, and the input box whose
		// completions nobody typed (G4) — and a reader who meets all that first
		// has already read it as the agent speaking by the time the disclaimer
		// arrives. A warning that comes after the thing it warns about is
		// decoration.
		elements = append(elements, newMarkdown("%s", fromScreenNote))
	}
	elements = append(elements, newMarkdown("%s", body))
	if answer.Truncated || cut {
		// This one belongs after: it is about where the text STOPPED.
		elements = append(elements, newMarkdown("%s", truncatedNote))
	}

	elements = append(elements,
		newColumnSet([]buttonElement{
			newButton(selectAndTypeText, btnNeutral, inertDecision(a, ActSelect, now)),
			newButton(screenText, btnNeutral, inertDecision(a, ActScreen, now)),
		}),
		newMarkdown("pane `%s` · seq %d · as of %s", a.PaneID, a.StateSeq, now.Format(stampLayout)),
	)

	return render(card{
		Schema: schemaVersion,
		Config: cardConfig{
			UpdateMulti: true,
			Summary:     &cardSummary{Content: doneSummary(a, answer)},
		},
		Header: newHeader(headline(a), doneSubtitle(a), templateDone),
		Body:   cardBody{Elements: elements},
	}, "done")
}

// truncatedNote is the one line that admits the body is not all of it.
const truncatedNote = "_This is not the whole answer — it was cut to fit. " +
	"Tap **Screen** to see the pane itself._"

// fromScreenNote is the fallback's disclaimer, and it has to be blunt.
//
// When no transcript is available the body is the terminal, not the agent: it
// carries earlier turns, tool output and the input box, and the input box in
// particular shows completions nobody ever typed (G4). A reader who takes that
// for the agent speaking would be reading text no agent produced.
const fromScreenNote = "⚠️ **No transcript was available, so the text above is the raw screen** — " +
	"the terminal as it stands, not the agent's own words. Earlier turns, tool output and the " +
	"input box can all be in it, and that box shows suggestions nobody typed. Read it as a " +
	"screenshot, not as speech."

// noAnswerText is the body when there is nothing to show.
//
// An empty card would read as a bug in the bridge. This one is still a useful
// notification — the agent finished, which is the fact worth pushing — and it
// names the one tap that can still show something.
const noAnswerText = "**The agent finished, but there is no final message to show.** " +
	"Tap **Screen** to see what the pane is showing now."

// promptLine is the question, quoted, on one line.
//
// It is collapsed first because a prompt may be several lines and this is a
// context line, not a re-run of the request: a newline here would push the
// answer down the card for no information gained.
func promptLine(prompt string) string {
	p := collapse(prompt)
	if p == "" {
		return ""
	}
	return "**You asked** “" + truncateCells(p, maxPromptCells) + "”"
}

// toolLines is what the agent did on the way to the answer, one summary per
// line, with the overflow counted rather than listed.
//
// Blank entries are dropped without being counted: they carry nothing, so
// reporting them as "+1 more" would promise the reader something to go and look
// at that does not exist.
func toolLines(tools []string) string {
	shown := make([]string, 0, maxToolLines+1)
	extra := 0
	for _, t := range tools {
		t = collapse(t)
		if t == "" {
			continue
		}
		if len(shown) >= maxToolLines {
			extra++
			continue
		}
		shown = append(shown, inlineCode(truncateCells(t, maxToolCells)))
	}
	if len(shown) == 0 {
		return ""
	}
	if extra > 0 {
		shown = append(shown, fmt.Sprintf("_+%d more_", extra))
	}
	return strings.Join(shown, "\n")
}

// inlineCode marks one tool summary as machine text, unless it already contains
// a backtick — in which case the fence would close early and leave the rest of
// the line rendering as markdown, which is worse than no monospace at all.
func inlineCode(s string) string {
	if strings.Contains(s, "`") {
		return s
	}
	return "`" + s + "`"
}

// answerBody renders Answer.Text and reports whether it had to be cut.
//
// The default is PROSE. A code block on a phone does not wrap, so every
// ordinary sentence longer than the card becomes a horizontal scroll — and the
// answer to "现在几点了" is a sentence, not a program. Monospace is therefore
// something the text has to earn, by already carrying a fence or by reading as
// commands; see looksLikeCode.
//
// The screen fallback earns it by construction: it is a rendered character
// grid, cropped to phone width rather than wrapped precisely so that its column
// alignment survives (screen.DefaultMaxCols). Re-flowing that as markdown turns
// box drawing into gibberish.
func answerBody(answer Answer) (body string, cut bool) {
	text := trimBlankLines(answer.Text)
	if strings.TrimSpace(text) == "" {
		return noAnswerText, false
	}
	if displayWidth(text) > maxAnswerCells {
		text = closeFence(truncateCells(text, maxAnswerCells))
		cut = true
	}
	// Cells bound how much there is to READ; runes bound whether Feishu accepts
	// the card at all. Both are needed: text that is mostly newlines or
	// zero-width runes passes the cell budget at any size.
	if utf8.RuneCountInString(text) > maxAnswerRunes {
		text = closeFence(truncate(text, maxAnswerRunes))
		cut = true
	}
	if answer.FromScreen || looksLikeCode(text) {
		return codeBlock(text), cut
	}
	return text, cut
}

// closeFence re-closes a code fence the cut landed inside.
//
// An unbalanced ``` swallows every line after it, starting with the note that
// explains the answer was cut. Counting the markers is enough here: the text
// ends immediately after, so the only question is whether the last fence opened
// something that never closes — the same rule S2 §3.8 applies when a long
// message is split across bubbles.
func closeFence(text string) string {
	if strings.Count(text, "```")%2 == 0 {
		return text
	}
	return text + "\n```"
}

// looksLikeCode reports whether the whole body should be monospaced.
//
// Text that already carries a fence is left alone: the fenced part renders as
// code and the prose around it as prose, which is exactly right, and wrapping
// the lot would show the inner fence as literal backticks.
//
// Otherwise this is a majority vote of the lines, and the bias is deliberate.
// Prose in a code block scrolls sideways on a phone, which is the complaint
// this card exists to fix; code rendered as prose loses its alignment, which is
// merely ugly. So a line must show positive evidence of being a command before
// it votes, and the majority must be strict.
func looksLikeCode(text string) bool {
	if strings.Contains(text, "```") {
		return false
	}
	commands, total := 0, 0
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		total++
		if looksLikeCommand(line) {
			commands++
		}
	}
	return total > 0 && commands*2 > total
}

// commandWord matches the first field of a shell line: a bare program name or
// a path to one. A capital letter is enough to disqualify it, which is what
// keeps "The file is at /tmp/x" out — English sentences start with one.
//
// It is necessary but not sufficient: see the letter test in looksLikeCommand,
// which is what keeps list markers out.
var commandWord = regexp.MustCompile(`^[a-z0-9._/~-]+$`)

// commonCommands is the small set of program names that make a line credible as
// a command even when it carries no flags and no paths ("npm install", "make
// build"). It is short on purpose: every entry is also an English word waiting
// to be misread, and the majority rule in looksLikeCode is what limits the
// damage of one bad vote.
var commonCommands = []string{
	"brew", "cargo", "cat", "cd", "curl", "docker", "git", "go", "gofmt", "grep",
	"just", "kubectl", "ls", "make", "mkdir", "mv", "node", "npm", "pip", "pnpm",
	"python", "python3", "rm", "ssh", "tar", "touch", "yarn",
}

// maxCommandFields is where a line stops being a command and starts being a
// sentence. Real commands are short; a dozen words separated by spaces with no
// punctuation at all is prose that happens to lack a full stop.
const maxCommandFields = 12

// maxCommandFieldsWithPath is the tighter bound that applies when the only
// evidence is shell SYNTAX — a flag, a path, a pipe, a redirect — rather than a
// program name this build recognises.
//
// Naming a file is the weakest signal there is, because it is what an agent's
// final message does constantly: "see the log at /tmp/build.log for details" is
// a sentence, and without a length bound it is judged by the same rule as
// `go build ./...`. Real commands whose evidence is a path are short; a
// seven-word line that mentions one is prose about a file.
const maxCommandFieldsWithPath = 6

// looksLikeCommand reports whether one line reads as something you would type
// at a shell.
//
// The tests it applies, in order of how cheaply they settle the question:
// an explicit prompt marker settles it; CJK settles it the other way (no shell
// in this product is driven in Chinese, so a wide rune means the line is prose
// about a command at most); sentence punctuation settles it; and what is left
// must open with a plausible program name — a word that at minimum contains a
// letter, so that a list marker cannot pass as one — followed by a name from
// commonCommands, or, if the line is short enough for it to mean anything, by
// shell syntax.
func looksLikeCommand(line string) bool {
	s := strings.TrimSpace(line)
	switch {
	case strings.HasPrefix(s, "$ "), strings.HasPrefix(s, "% "):
		// Someone already marked this as a shell line.
		return true
	case hasWideRune(s), strings.Contains(s, ", "), endsSentence(s):
		return false
	}
	fields := strings.Fields(s)
	if len(fields) < 2 || len(fields) > maxCommandFields {
		// A lone word is not evidence of anything: "done" is an answer.
		return false
	}
	// A program name has to contain a letter. Without that test commandWord
	// accepts the two markers an agent's final message is most likely to start
	// a line with — "-" and "1." — and the path rule below then votes "command"
	// for every list item that names a file, which is the single most common
	// shape of a coding agent's answer. Fencing that list is exactly the
	// non-wrapping horizontal scroll this card exists to remove.
	if !commandWord.MatchString(fields[0]) || !strings.ContainsFunc(fields[0], unicode.IsLetter) {
		return false
	}
	if slices.Contains(commonCommands, fields[0]) {
		return true
	}
	if len(fields) > maxCommandFieldsWithPath {
		// Too long for shell syntax alone to carry it; see the constant.
		return false
	}
	// Shell syntax: a flag, a path, a pipe or a redirect.
	if strings.ContainsAny(s, "|><") {
		return true
	}
	for _, f := range fields[1:] {
		if strings.HasPrefix(f, "-") || strings.Contains(f, "/") {
			return true
		}
	}
	return false
}

// endsSentence reports whether s ends the way a sentence does: closing
// punctuation preceded by a letter.
//
// The preceding-letter test is what separates "Done." from "go test ./...",
// whose trailing dot belongs to a path rather than to a sentence.
func endsSentence(s string) bool {
	r := []rune(strings.TrimSpace(s))
	if len(r) < 2 {
		return false
	}
	if !strings.ContainsRune(".!?:;", r[len(r)-1]) {
		return false
	}
	return unicode.IsLetter(r[len(r)-2])
}

// trimBlankLines drops leading and trailing blank lines while leaving the
// indentation of real ones alone — a screen tail's first line may be indented
// because the pane draws a box, and trimming that would shift the grid.
func trimBlankLines(s string) string {
	lines := strings.Split(s, "\n")
	i, j := 0, len(lines)
	for i < j && strings.TrimSpace(lines[i]) == "" {
		i++
	}
	for j > i && strings.TrimSpace(lines[j-1]) == "" {
		j--
	}
	return strings.Join(lines[i:j], "\n")
}

// doneSubtitle is the line under the header: what the agent was doing, when it
// says something more useful than its own directory (G8).
func doneSubtitle(a agents.Agent) string {
	if t := taskTitle(a); t != "" {
		return t
	}
	return "finished"
}

// doneSummary is the notification banner, where the card is not rendered at all
// and one line has to be worth unlocking a phone for. So it leads with the
// answer rather than with the fact that something finished.
//
// The screen fallback deliberately does not: the first line of a terminal tail
// is whatever furniture happens to be at the top of the crop, and putting that
// in the banner would spend the only line the reader sees on a box corner.
func doneSummary(a agents.Agent, answer Answer) string {
	kind := fallback(a.Kind, "agent")
	if line := firstLine(answer.Text); line != "" && !answer.FromScreen {
		// Bounded twice, for the reason answerBody is: cells are what the banner
		// RENDERS as, runes are what Feishu carries. A first line of zero-width
		// runes measures nothing in cells and would otherwise reach the card
		// whole — 200k runes of banner on a card that then arrives nowhere.
		// On decomposed text (a base letter plus its combining mark) the rune
		// bound cuts earlier than the cell bound would; a shorter preview is a
		// small price for a card that is always deliverable.
		return truncate(truncateCells(kind+" · "+unmark(line), maxSummary), maxSummary)
	}
	return kind + " finished"
}

// unmark strips inline emphasis for the banner.
//
// config.summary.content is rendered as PLAIN TEXT, so markdown does not become
// formatting there, it becomes literal punctuation: an answer that names a file
// as `a.md` spends four of the sixty cells a locked phone shows on backticks.
// Only the banner is stripped — the card body is markdown and must keep its
// marks.
var unmarkReplacer = strings.NewReplacer("`", "", "**", "", "__", "")

func unmark(s string) string { return unmarkReplacer.Replace(s) }

// firstLine is the first line of text with anything on it, collapsed.
func firstLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		if l := collapse(line); l != "" {
			return l
		}
	}
	return ""
}
