package outbound

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Split cuts s into messages of at most target runes. See contract.go.
func Split(s string, target int) []Chunk {
	if target <= 0 {
		target = SplitTarget
	}
	if target < minTarget {
		// Below this the indicator and a reopened fence eat the whole budget
		// and the splitter would shred "```go" one rune at a time. The target
		// comes from config; honouring a typo literally is worse than
		// ignoring it.
		target = minTarget
	}
	if target > MaxMessageRunes {
		target = MaxMessageRunes
	}

	r := []rune(s)
	if len(r) <= target {
		// Short enough to send verbatim. No indicator, no fence surgery: the
		// text goes out exactly as the caller wrote it.
		return []Chunk{{Text: s, Index: 1, Total: 1}}
	}

	m := scanMarkup(r)

	// The "(i/n)" indicator costs runes, and how many depends on n, which
	// depends on the indicator. The reserve is a step function of n's DIGIT
	// count, not of n, so iterating on the digit count terminates after at
	// most a handful of passes (1 -> 2 -> 3 -> 4 digits).
	digits := digitCount(len(r)/target + 1)
	var bodies []string
	for attempt := 0; ; attempt++ {
		bodies = splitPass(r, m, target, indicatorRunes(digits))
		d := digitCount(len(bodies))
		if d <= digits || attempt >= 8 {
			break
		}
		digits = d
	}

	total := len(bodies)
	out := make([]Chunk, total)
	for i, body := range bodies {
		text := body
		if total > 1 {
			text += indicator(i+1, total)
		}
		out[i] = Chunk{Text: text, Index: i + 1, Total: total}
	}
	return out
}

// splitPass cuts r into chunk bodies, reserving indicatorReserve runes in each
// for the "(i/n)" suffix the caller will append.
func splitPass(r []rune, m markup, target, indicatorReserve int) []string {
	// Room to close a fence we are cutting through — or one the cut itself
	// created: "\n" + the backtick run. Reserved up front, whenever the text
	// contains a run that could be a marker at all, so that the budget is known
	// before the cut point is chosen rather than after.
	closeReserve := 0
	fences := m.maxFence > 0
	if fences {
		closeReserve = 1 + m.maxFence
		if closeReserve+indicatorReserve > target/2 {
			// The marker run is so long that closing and reopening it would
			// leave every message mostly scaffolding. Split as if the text had
			// no fences: such a block renders badly either way, but this keeps
			// every chunk inside target instead of emitting one rune of payload
			// per message.
			fences, closeReserve = false, 0
		}
	}

	var out []string
	for pos := 0; pos < len(r); {
		var prefix string
		if open := m.fenceAt[pos]; fences && open != "" {
			prefix = reopenLine(open, target-indicatorReserve-closeReserve-1) + "\n"
		}

		budget := target - indicatorReserve - utf8.RuneCountInString(prefix) - closeReserve
		if budget < 1 {
			// Backstop. reopenLine and the closeReserve guard above keep this
			// unreachable; if some future reserve breaks that, make progress
			// rather than loop forever.
			budget = 1
		}

		cut := len(r)
		if len(r)-pos > budget {
			cut = findCut(r, m, pos, pos+budget)
		}

		var b strings.Builder
		b.WriteString(prefix)
		b.WriteString(string(r[pos:cut]))
		if cut < len(r) {
			if open := m.fenceAt[cut]; fences && open != "" {
				if !strings.HasSuffix(b.String(), "\n") {
					b.WriteByte('\n')
				}
				b.WriteString(fenceMarker(open))
			}
		}
		body := b.String()

		// Every chunk ends closed, except the last one, which mirrors a source
		// that itself ends inside a fence.
		mirrorsSource := cut == len(r) && m.fenceAt[len(r)] != ""
		if fences && !mirrorsSource {
			if got := openFenceAtEnd(body); got != "" {
				// findCut had no safe boundary anywhere in the window and had to
				// cut where a backtick run becomes a line-initial marker. The
				// trailing line renders as code, which is wrong, but leaving the
				// fence open swallows every message that follows it.
				if !strings.HasSuffix(body, "\n") {
					body += "\n"
				}
				body += fenceMarker(got)
			}
		}

		out = append(out, body)
		pos = cut
	}
	return out
}

// findCut picks a boundary in (lo, hi] to cut at: newline first, then space,
// then a hard cut. Boundaries the markup scan marked unsafe — inside an inline
// code span, inside a fence marker line, or between a backslash and the rune
// it escapes — are never returned unless nothing else is available.
func findCut(r []rune, m markup, lo, hi int) int {
	if hi > len(r) {
		hi = len(r)
	}

	// Bound how far back a nicer break may pull the cut, or one early newline
	// in a 4000-rune blob would produce a 5-rune message.
	lookback := (hi - lo) / 4
	if lookback < minLookback {
		lookback = minLookback
	}
	floor := hi - lookback
	if floor <= lo {
		floor = lo + 1
	}

	for c := hi; c >= floor; c-- {
		if r[c-1] == '\n' && !m.unsafe[c] {
			return c
		}
	}
	for c := hi; c >= floor; c-- {
		if (r[c-1] == ' ' || r[c-1] == '\t') && !m.unsafe[c] {
			return c
		}
	}
	// Hard cut. Still refuse to land inside an inline span: back up until the
	// boundary is safe.
	for c := hi; c > lo; c-- {
		if !m.unsafe[c] {
			return c
		}
	}
	return hi
}

const (
	// minLookback keeps the newline/space search useful at small targets,
	// where (hi-lo)/4 would be a couple of runes.
	minLookback = 32

	// minTarget is the smallest split point that can still carry an "(i/n)"
	// indicator and a reopened fence and leave room for actual text.
	minTarget = 64

	// maxInfoRunes bounds the language tag copied into a reopened fence. Real
	// tags are short ("go", "python", "diff"); anything longer is not a
	// language, and charging it to every chunk's budget would turn the message
	// into scaffolding.
	maxInfoRunes = 32
)

// reopenLine renders the fence line that reopens `open` at the top of a chunk,
// in at most room runes including the newline that will follow it.
//
// The backtick run is not negotiable — a shorter one would not reopen the same
// fence — but the info string is: a pathological tag is truncated, and dropped
// outright before it is allowed to push the chunk over target.
func reopenLine(open string, room int) string {
	marker := fenceMarker(open)
	info := open[len(marker):]
	if utf8.RuneCountInString(info) > maxInfoRunes {
		info = string([]rune(info)[:maxInfoRunes])
	}
	if utf8.RuneCountInString(marker)+utf8.RuneCountInString(info)+1 > room {
		return marker
	}
	return marker + info
}

// markup is per-boundary metadata over a rune slice. Index c refers to the
// boundary BEFORE rune c, so it ranges over [0, len(r)].
type markup struct {
	// fenceAt[c] is the opening fence line ("```go") of the code fence open at
	// boundary c, or "" if none is open. It is what must be re-emitted at the
	// start of the next chunk.
	fenceAt []string

	// unsafe[c] means a cut at boundary c would break something in half.
	unsafe []bool

	// maxFence is the longest backtick run in the text that is long enough to
	// be a fence marker, 0 if there is none.
	maxFence int
}

// fenceStep advances the fence state machine over one line that fenceLine has
// already recognised as a marker. It is the single definition of "does this
// line open or close a block", shared by the source scan and by the check on
// each assembled chunk.
func fenceStep(open string, openLen int, marker, info string) (string, int) {
	if open == "" {
		return marker + info, len(marker)
	}
	if len(marker) >= openLen && info == "" {
		// A closing fence is at least as long as its opener and carries no info
		// string; anything else is content inside the block.
		return "", 0
	}
	return open, openLen
}

// openFenceAtEnd returns the opening fence line still in effect at the end of
// an assembled chunk, "" if the chunk closes everything it opened.
func openFenceAtEnd(s string) string {
	open, openLen := "", 0
	for _, line := range strings.Split(s, "\n") {
		if marker, info, ok := fenceLine([]rune(line)); ok {
			open, openLen = fenceStep(open, openLen, marker, info)
		}
	}
	return open
}

func scanMarkup(r []rune) markup {
	n := len(r)
	m := markup{fenceAt: make([]string, n+1), unsafe: make([]bool, n+1)}

	// The longest backtick run in the text bounds what closing a fence can
	// cost. Runs that are not markers in the source count too: a cut can turn
	// one into a marker (see markCutMadeFences), and then it has to be closed.
	for i := 0; i < n; {
		if r[i] != '`' {
			i++
			continue
		}
		k := runLength(r, i, '`')
		if k >= 3 && k > m.maxFence {
			m.maxFence = k
		}
		i += k
	}

	open := ""   // active opening fence line, "" = not inside a fence
	openLen := 0 // backtick count of the active opener

	for pos := 0; pos < n; {
		lineEnd := pos
		for lineEnd < n && r[lineEnd] != '\n' {
			lineEnd++
		}
		next := lineEnd
		if next < n {
			next++ // consume the newline
		}

		// Boundaries within this line see the fence state as it was BEFORE the
		// line; a fence marker line only takes effect from the next line on.
		for c := pos; c < next; c++ {
			m.fenceAt[c] = open
		}

		if marker, info, isFence := fenceLine(r[pos:lineEnd]); isFence {
			open, openLen = fenceStep(open, openLen, marker, info)
			// Cutting inside the marker line would split "```go" itself.
			for c := pos + 1; c < next; c++ {
				m.unsafe[c] = true
			}
		} else {
			if open == "" {
				markInlineSpans(m.unsafe, r, pos, lineEnd)
			}
			markCutMadeFences(m.unsafe, r, pos, lineEnd)
		}

		pos = next
	}
	m.fenceAt[n] = open
	return m
}

// fenceLine reports whether the line opens or closes a triple-backtick fence,
// returning the backtick run and the info string ("go", "" for a bare fence).
func fenceLine(line []rune) (marker, info string, ok bool) {
	i := 0
	for i < len(line) && i < 3 && line[i] == ' ' {
		i++
	}
	j := i
	for j < len(line) && line[j] == '`' {
		j++
	}
	if j-i < 3 {
		return "", "", false
	}
	info = strings.TrimSpace(string(line[j:]))
	if strings.ContainsRune(info, '`') {
		// A backtick in the info string means this is not a fence, it is prose
		// containing backticks.
		return "", "", false
	}
	return string(line[i:j]), info, true
}

// fenceMarker extracts the closing marker from an opening fence line, e.g.
// "```go" -> "```". A closing fence carries no info string.
func fenceMarker(open string) string {
	i := 0
	for i < len(open) && open[i] == '`' {
		i++
	}
	return open[:i]
}

// markCutMadeFences marks the boundaries where cutting this line — which is NOT
// a fence marker line — would turn one of the halves into one.
//
// The cut gives each half a line of its own: a "```" that was prose in the
// middle of a sentence becomes line-initial in the next chunk, i.e. a fence
// OPENER that nothing ever closes, and the phone renders the whole rest of the
// message as a code block. The head side has the mirror problem: "```go `x`" is
// not a fence (the backtick in its info string disqualifies it), but "```go "
// is, so a cut after the tag manufactures one.
//
// This is computed from the line's shape rather than by trying fenceLine at
// every boundary: agent output contains 100k-rune single lines, and a per-
// boundary probe would rescan the rest of the line each time.
//
// A boundary the scan misses is not fatal — findCut falls back to a hard cut
// when a whole window is unsafe, exactly as it already does for an unterminated
// inline span — but it is the difference between a readable message and a
// screenful of code block.
func markCutMadeFences(unsafe []bool, r []rune, lo, hi int) {
	// Head half r[lo:c] is a fence iff the line opens with at most three spaces
	// and then a backtick run, the cut keeps at least three of those backticks,
	// and no later backtick has been taken in — a backtick in the info string
	// is exactly what stops the FULL line from being a fence.
	s := lo
	for s < hi && s-lo < 3 && r[s] == ' ' {
		s++
	}
	runEnd := s
	for runEnd < hi && r[runEnd] == '`' {
		runEnd++
	}
	if runEnd-s >= 3 {
		end := hi // first backtick after the opening run, or the line end
		for c := runEnd; c < hi; c++ {
			if r[c] == '`' {
				end = c
				break
			}
		}
		for c := s + 3; c <= end && c < hi; c++ {
			if c > lo {
				unsafe[c] = true
			}
		}
	}

	// Tail half: the next chunk starts at c and ENDS at the following cut, which
	// may fall before this line does. So the tail's first line is r[c:e] for an
	// e we do not get to choose, and e can always land right after a backtick
	// run — leaving an empty info string and a fence. Every run of three or
	// more backticks is therefore a hazard, not just the last one on the line.
	for c := lo; c < hi; {
		if r[c] != '`' {
			c++
			continue
		}
		k := runLength(r, c, '`')
		if k >= 3 {
			// Up to three spaces may precede the run and it is still a marker;
			// a cut inside the run still leaves one if three backticks remain.
			from := c
			for from > lo && c-from < 3 && r[from-1] == ' ' {
				from--
			}
			for x := from; x <= c+k-3; x++ {
				if x > lo {
					unsafe[x] = true
				}
			}
		}
		c += k
	}
}

// markInlineSpans marks every boundary that sits inside an inline code span on
// this line. Spans are treated as line-local: a stray backtick should not
// poison the rest of the message.
//
// Spans are matched by RUN LENGTH, the way markdown does it: “a `b` c“ is one
// span delimited by two double runs, not two spans. Counting single backticks
// would see an even number of them and call the interior safe, and the cut
// would put literal backticks on the phone — the exact failure this rule
// exists to prevent.
func markInlineSpans(unsafe []bool, r []rune, lo, hi int) {
	for c := lo; c < hi; {
		switch r[c] {
		case '\\':
			// Never cut between a backslash and what it escapes, and do not let
			// the escaped rune open a span.
			if c+1 < hi {
				unsafe[c+1] = true
				c += 2
				continue
			}
			c++

		case '`':
			k := runLength(r, c, '`')
			pair := findRunBefore(r, c+k, hi, k)
			if pair < 0 {
				// A run with no partner is not a delimiter — markdown renders
				// it as the literal backticks it is — so it constrains nothing.
				// Treating the rest of the line as span interior (what counting
				// odd backticks amounts to) is worse than useless here: it can
				// leave findCut with no safe boundary at all, and its hard-cut
				// fallback then lands exactly where the fence rules below were
				// trying to keep it out of.
				c += k
				continue
			}
			// One atom: the two delimiter runs and everything between them.
			for x := c + 1; x < pair+k; x++ {
				unsafe[x] = true
			}
			c = pair + k

		default:
			c++
		}
	}
}

// findRunBefore returns the index of the next run of exactly n backticks that
// starts at or after i and ends at or before hi, or -1. Unlike findRun it does
// not look past the end of the line.
func findRunBefore(r []rune, i, hi, n int) int {
	for j := i; j+n <= hi; j++ {
		if r[j] == '`' && runLength(r, j, '`') == n {
			return j
		}
	}
	return -1
}

// indicatorRunes is the worst-case rune cost of an "(i/n)" suffix when n has
// the given number of digits. i <= n, so i is never wider than n.
func indicatorRunes(digits int) int { return len("\n\n(/)") + 2*digits }

func indicator(i, n int) string { return fmt.Sprintf("\n\n(%d/%d)", i, n) }

func digitCount(n int) int {
	d := 1
	for n >= 10 {
		n /= 10
		d++
	}
	return d
}
