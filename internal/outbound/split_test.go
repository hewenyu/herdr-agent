package outbound

import (
	"math/rand"
	"strings"
	"testing"
	"unicode/utf8"
)

// bodyOf strips the "(i/n)" indicator a chunk carries, leaving the text the
// splitter actually produced.
func bodyOf(t *testing.T, c Chunk) string {
	t.Helper()
	if c.Total == 1 {
		return c.Text
	}
	suffix := indicator(c.Index, c.Total)
	if !strings.HasSuffix(c.Text, suffix) {
		t.Fatalf("chunk %d/%d does not end with %q: %q", c.Index, c.Total, suffix, tail(c.Text, 40))
	}
	return strings.TrimSuffix(c.Text, suffix)
}

func tail(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return "..." + string(r[len(r)-n:])
}

func TestSplitSingleChunkIsVerbatimAndUnlabelled(t *testing.T) {
	for _, src := range []string{
		"",
		"one short line",
		"```go\nfmt.Println(1)\n```",
		strings.Repeat("a", SplitTarget),
	} {
		got := Split(src, SplitTarget)
		if len(got) != 1 {
			t.Fatalf("Split(%d runes) = %d chunks, want 1", utf8.RuneCountInString(src), len(got))
		}
		if got[0].Text != src {
			t.Errorf("single chunk was rewritten:\n got %q\nwant %q", got[0].Text, src)
		}
		if got[0].Index != 1 || got[0].Total != 1 {
			t.Errorf("Index/Total = %d/%d, want 1/1", got[0].Index, got[0].Total)
		}
		if strings.Contains(got[0].Text, "(1/1)") {
			t.Errorf("single chunk carries an indicator: %q", got[0].Text)
		}
	}
}

func TestSplitLabelsEveryChunkAndStaysUnderTarget(t *testing.T) {
	const target = 100
	src := strings.Repeat("alpha beta gamma delta epsilon\n", 40) // 1200 runes

	got := Split(src, target)
	if len(got) < 2 {
		t.Fatalf("got %d chunks, want several", len(got))
	}

	var rebuilt strings.Builder
	for i, c := range got {
		if c.Index != i+1 || c.Total != len(got) {
			t.Errorf("chunk %d: Index/Total = %d/%d, want %d/%d", i, c.Index, c.Total, i+1, len(got))
		}
		if n := utf8.RuneCountInString(c.Text); n > target {
			t.Errorf("chunk %d is %d runes, over the %d target", i, n, target)
		}
		if !strings.HasSuffix(c.Text, indicator(c.Index, c.Total)) {
			t.Errorf("chunk %d lacks its (i/n) indicator: %q", i, tail(c.Text, 40))
		}
		rebuilt.WriteString(bodyOf(t, c))
	}
	// Fence-free input, so the chunks must reassemble byte for byte.
	if rebuilt.String() != src {
		t.Error("reassembled chunks do not equal the source")
	}
}

func TestSplitCountsRunesNotBytes(t *testing.T) {
	const target = 100

	// 100 CJK runes is 300 bytes. A byte budget would cut this; a rune budget
	// must not.
	fits := strings.Repeat("你好世界啊", 20)
	if n := utf8.RuneCountInString(fits); n != target {
		t.Fatalf("fixture is %d runes, want %d", n, target)
	}
	if len(fits) <= target {
		t.Fatalf("fixture is %d bytes, the test proves nothing", len(fits))
	}
	if got := Split(fits, target); len(got) != 1 {
		t.Fatalf("Split of %d runes / %d bytes = %d chunks, want 1", target, len(fits), len(got))
	}

	long := strings.Repeat("你好世界啊", 80) // 400 runes
	got := Split(long, target)
	var rebuilt strings.Builder
	for _, c := range got {
		if n := utf8.RuneCountInString(c.Text); n > target {
			t.Errorf("chunk %d/%d is %d runes, over target", c.Index, c.Total, n)
		}
		if !utf8.ValidString(c.Text) {
			t.Errorf("chunk %d/%d cut a rune in half", c.Index, c.Total)
		}
		rebuilt.WriteString(bodyOf(t, c))
	}
	if rebuilt.String() != long {
		t.Error("CJK text did not survive the round trip")
	}
}

func TestSplitClosesAndReopensFence(t *testing.T) {
	const target = 120
	src := "here is the patch\n```go\n" + strings.Repeat("fmt.Println(1)\n", 20) + "```\nthat is all\n"

	got := Split(src, target)
	if len(got) < 3 {
		t.Fatalf("got %d chunks, want the fence to span at least three", len(got))
	}

	for i, c := range got {
		body := bodyOf(t, c)
		if n := utf8.RuneCountInString(c.Text); n > target {
			t.Errorf("chunk %d is %d runes, over the %d target", i, n, target)
		}
		if fenceRuns(body)%2 != 0 {
			t.Errorf("chunk %d leaves a fence open on the phone:\n%s", i, body)
		}
	}

	// The cut lands inside the block: chunk 0 must close it and chunk 1 must
	// reopen it with the same language tag.
	first := bodyOf(t, got[0])
	if !strings.HasSuffix(first, "\n```") {
		t.Errorf("chunk 0 does not close the fence it cut through:\n%s", tail(first, 60))
	}
	second := bodyOf(t, got[1])
	if !strings.HasPrefix(second, "```go\n") {
		t.Errorf("chunk 1 does not reopen the fence with its language tag: %q", head(second, 20))
	}

	// Nothing may be lost or duplicated. Compare the payload with all fence
	// marker lines removed.
	if want, gotAll := codePayload(src), codePayloadOfChunks(t, got); want != gotAll {
		t.Errorf("content changed across the split:\n want %q\n  got %q", want, gotAll)
	}
}

func TestSplitKeepsLanguageTagOfEachFence(t *testing.T) {
	src := "```python\n" + strings.Repeat("print(1)\n", 30) + "```\n"
	got := Split(src, 90)
	if len(got) < 2 {
		t.Fatalf("got %d chunks, want at least 2", len(got))
	}
	// Unconditional: the cut lands inside the block, so chunk 1 MUST reopen it
	// with the tag. Asserting this only for chunks that happen to start with a
	// fence would pass with the reopen logic deleted.
	if second := bodyOf(t, got[1]); !strings.HasPrefix(second, "```python\n") {
		t.Errorf("chunk 1 did not reopen the fence with its language tag: %q", head(second, 20))
	}
	for _, c := range got[1:] {
		body := bodyOf(t, c)
		if strings.HasPrefix(body, "```") && !strings.HasPrefix(body, "```python\n") {
			t.Errorf("chunk %d reopened the fence without its language tag: %q", c.Index, head(body, 20))
		}
	}
}

// The reopened fence is charged to every chunk's budget. A "language tag" long
// enough to fill a message must not be allowed to shrink the payload to
// nothing: 7.6k runes went out as 4551 messages, the largest 25% over target.
func TestSplitBoundsTheReopenedFenceLine(t *testing.T) {
	const target = 200
	src := "```" + strings.Repeat("z", 5000) + "\n" + strings.Repeat("body line\n", 100) + "```\n"

	got := Split(src, target)
	for _, c := range got {
		if n := utf8.RuneCountInString(c.Text); n > target {
			t.Fatalf("chunk %d/%d is %d runes, over the %d target", c.Index, c.Total, n, target)
		}
	}
	// Every chunk must still carry real payload; allow generous slack for the
	// scaffolding but not a flood.
	if lo := utf8.RuneCountInString(src) / target; len(got) > 3*lo {
		t.Errorf("got %d chunks for %d runes at target %d, want on the order of %d",
			len(got), utf8.RuneCountInString(src), target, lo)
	}
	// The marker line itself is longer than a whole message and cannot survive
	// intact, but the code it wraps must: this is the command the user is being
	// asked to approve.
	lines := 0
	for _, c := range got {
		lines += strings.Count(c.Text, "body line")
	}
	if lines != 100 {
		t.Errorf("got %d body lines across the chunks, want 100", lines)
	}
}

// A marker longer than the message it would have to fit in cannot be closed and
// reopened at all. The splitter degrades — a block like this renders badly
// whatever we do — but it must not answer with a flood of over-target messages.
func TestSplitSurvivesAFenceMarkerLongerThanTheTarget(t *testing.T) {
	marker := strings.Repeat("`", 200)
	src := marker + "\n" + strings.Repeat("payload line\n", 40) + marker + "\n"

	for _, target := range []int{minTarget, 100, 500} {
		got := Split(src, target)
		for _, c := range got {
			if n := utf8.RuneCountInString(c.Text); n > target {
				t.Errorf("target %d: chunk %d/%d is %d runes, over target",
					target, c.Index, c.Total, n)
			}
		}
		if lo := utf8.RuneCountInString(src) / target; len(got) > 3*lo+10 {
			t.Errorf("target %d: %d chunks for %d runes, want on the order of %d",
				target, len(got), utf8.RuneCountInString(src), lo)
		}
		lines := 0
		for _, c := range got {
			lines += strings.Count(c.Text, "payload line")
		}
		if lines != 40 {
			t.Errorf("target %d: got %d payload lines, want 40", target, lines)
		}
	}
}

// Sometimes there is no good boundary: here the whole line is one inline code
// span, so every cut inside it is already bad, and the one the splitter is
// forced into also promotes the leading run to a fence marker. The chunk still
// has to close what it opened — an open fence swallows every message after it,
// while a spurious closed one costs a few lines of monospace.
func TestSplitClosesAFenceItCouldNotAvoid(t *testing.T) {
	src := "```sh " + strings.Repeat("run the build ", 12) + " ``` " + strings.Repeat("after ", 20)
	if !fenceBalanced(src) {
		t.Fatalf("fixture is not fence-balanced, the test proves nothing")
	}

	for target := minTarget; target <= 400; target++ {
		for _, c := range Split(src, target) {
			body := bodyOf(t, c)
			if !fenceBalanced(body) {
				t.Fatalf("target %d: chunk %d/%d leaves a code fence open:\n%q",
					target, c.Index, c.Total, body)
			}
			if n := utf8.RuneCountInString(c.Text); n > target {
				t.Fatalf("target %d: chunk %d/%d is %d runes, over target",
					target, c.Index, c.Total, n)
			}
		}
	}
}

func TestSplitNeverCutsInsideInlineCodeSpan(t *testing.T) {
	tests := []struct {
		name string
		src  string
		want string // expected first body
	}{
		{
			// The spaces inside the span are exactly the tempting break points;
			// only the space before the span is safe.
			name: "single backtick",
			src:  strings.Repeat("x", 80) + " `alpha beta gamma delta` tail",
			want: strings.Repeat("x", 80) + " ",
		},
		{
			// Counting backticks instead of matching RUNS sees an even number
			// here and cuts straight through the span.
			name: "double backtick",
			src:  strings.Repeat("x", 80) + " ``alpha beta gamma delta`` tail",
			want: strings.Repeat("x", 80) + " ",
		},
		{
			name: "span containing a lone backtick",
			src:  strings.Repeat("x", 80) + " ``alpha `beta` gamma`` tail",
			want: strings.Repeat("x", 80) + " ",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if n := unmatchedRuns(tc.src); n != 0 {
				t.Fatalf("fixture itself has %d unmatched backtick runs", n)
			}
			got := Split(tc.src, 100)
			if len(got) < 2 {
				t.Fatalf("got %d chunks, want 2", len(got))
			}
			for i, c := range got {
				body := bodyOf(t, c)
				if n := unmatchedRuns(body); n != 0 {
					t.Errorf("chunk %d was cut inside an inline code span:\n%s", i, body)
				}
			}
			if body := bodyOf(t, got[0]); body != tc.want {
				t.Errorf("chunk 0 = %q, want the cut just before the span", body)
			}
		})
	}
}

// A cut does not only move text, it creates two new LINE STARTS. A run of
// backticks that was prose in the middle of a sentence becomes a line-initial
// fence marker in the next chunk — an opener nothing closes, so the phone
// renders everything after it as one code block.
func TestSplitNeverInventsAFence(t *testing.T) {
	tests := []struct {
		name string
		src  string
	}{
		{
			name: "mid-line run would open a fence in the next chunk",
			src: strings.Repeat("x", 33) + " I will wrap the command in ``` markers so it renders" +
				" as code on your phone, then continue with more prose after it.",
		},
		{
			// Not a fence: the backtick in the info string disqualifies the
			// line. Cut before that backtick and the head half loses it.
			name: "head half would become an opener with a tag",
			src:  "```sh " + strings.Repeat("run the build and wait for it ", 12) + "`x` then prose\n",
		},
		{
			// fenceLine tolerates up to three leading spaces, so an indented run
			// is a marker too.
			name: "indented head half",
			src:  "   ``` " + strings.Repeat("indented prose that keeps going ", 12) + "`y` then prose\n",
		},
		{
			name: "trailing run would close the block early",
			src:  "```\n" + strings.Repeat("cmd arg ", 20) + "```\n```\n",
		},
		{
			name: "run at the very end of a prose line",
			src:  strings.Repeat("w", 90) + " and then ```\nmore prose on the next line here\n",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if !fenceBalanced(tc.src) {
				t.Fatalf("fixture is not fence-balanced, the test proves nothing")
			}
			// Swept rather than sampled: whether a cut lands on the backtick run
			// depends on the exact budget arithmetic, and a handful of targets
			// would silently stop exercising the bug the day a reserve changes.
			for target := minTarget; target <= 220; target++ {
				got := Split(tc.src, target)
				for _, c := range got {
					body := bodyOf(t, c)
					if !fenceBalanced(body) {
						t.Errorf("target %d: chunk %d/%d leaves a code fence open:\n%q",
							target, c.Index, c.Total, body)
					}
					if n := utf8.RuneCountInString(c.Text); n > target {
						t.Errorf("target %d: chunk %d/%d is %d runes, over target",
							target, c.Index, c.Total, n)
					}
				}
				if want, gotAll := codePayload(tc.src), codePayloadOfChunks(t, got); want != gotAll {
					t.Errorf("target %d: content changed:\n want %q\n  got %q", target, want, gotAll)
				}
			}
		})
	}
}

func TestSplitPrefersNewlineThenSpaceThenHardCut(t *testing.T) {
	tests := []struct {
		name   string
		src    string
		target int
		// check runs over the bodies of every chunk but the last, which ends
		// where the text does and so proves nothing about cut choice.
		check func(t *testing.T, bodies []string, target int)
	}{
		{
			name:   "newline",
			src:    strings.Repeat("line of text\n", 40),
			target: 100,
			check: func(t *testing.T, bodies []string, _ int) {
				for i, b := range bodies {
					if !strings.HasSuffix(b, "\n") {
						t.Errorf("chunk %d does not end at a newline: %q", i+1, tail(b, 20))
					}
				}
			},
		},
		{
			name:   "space",
			src:    strings.Repeat("word ", 100),
			target: 100,
			check: func(t *testing.T, bodies []string, _ int) {
				for i, b := range bodies {
					if !strings.HasSuffix(b, " ") {
						t.Errorf("chunk %d does not end at a space: %q", i+1, tail(b, 20))
					}
				}
			},
		},
		{
			// No newline and no space anywhere, so the only way through is a
			// hard cut: every chunk comes out the same size and packed full.
			// Asserting a literal rune count here would only restate the
			// reserve arithmetic and break on any change to the indicator.
			name:   "hard cut",
			src:    strings.Repeat("a", 500),
			target: 100,
			check: func(t *testing.T, bodies []string, target int) {
				want := utf8.RuneCountInString(bodies[0])
				if want <= target*3/4 {
					t.Errorf("hard cut wasted the budget: %d runes of a %d target", want, target)
				}
				for i, b := range bodies {
					if n := utf8.RuneCountInString(b); n != want {
						t.Errorf("chunk %d is %d runes, want the same %d as chunk 1", i+1, n, want)
					}
					if strings.HasSuffix(b, " ") || strings.HasSuffix(b, "\n") {
						t.Errorf("chunk %d ended at a break, so this is not the hard-cut path: %q",
							i+1, tail(b, 20))
					}
				}
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Split(tc.src, tc.target)
			if len(got) < 2 {
				t.Fatalf("got %d chunks, want several", len(got))
			}
			bodies := make([]string, 0, len(got)-1)
			for _, c := range got[:len(got)-1] { // the last chunk ends where the text does
				bodies = append(bodies, bodyOf(t, c))
			}
			tc.check(t, bodies, tc.target)
		})
	}
}

// The table above covers the shapes we know about. This covers the ones we do
// not: pseudo-random backtick soup, which is where the "a cut makes its own
// fence" class of bug was found in the first place. Seeded, so a failure is
// reproducible.
func TestSplitFenceInvariantsOnAdversarialText(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	words := []string{
		"alpha", "beta", "gamma", "delta\n", "epsilon", "\n", " ", "a`b",
		"`", "``", "```", "````", "`x`", "``pair``", "```go", "   ```go",
		"```py `q`", "  ```  ",
	}

	for i := 0; i < 2000; i++ {
		var b strings.Builder
		for j := 20 + rng.Intn(120); j > 0; j-- {
			b.WriteString(words[rng.Intn(len(words))])
			b.WriteString(" ")
		}
		src := b.String()
		if !fenceBalanced(src) {
			src += "\n```\n"
		}
		if !fenceBalanced(src) {
			continue // generated an odd number of openers; not our subject
		}

		target := minTarget + rng.Intn(300)
		for _, c := range Split(src, target) {
			body := bodyOf(t, c)
			if !fenceBalanced(body) {
				t.Fatalf("case %d target %d: chunk %d/%d leaves a fence open:\n%q\nsource: %q",
					i, target, c.Index, c.Total, body, src)
			}
			if n := utf8.RuneCountInString(c.Text); n > target {
				t.Fatalf("case %d: chunk %d/%d is %d runes, over the %d target\nsource: %q",
					i, c.Index, c.Total, n, target, src)
			}
		}
	}
}

func TestSplitTargetBounds(t *testing.T) {
	src := strings.Repeat("a b c d e ", 2000) // 20000 runes

	t.Run("zero means SplitTarget", func(t *testing.T) {
		for _, c := range Split(src, 0) {
			if n := utf8.RuneCountInString(c.Text); n > SplitTarget {
				t.Fatalf("chunk %d is %d runes, over SplitTarget", c.Index, n)
			}
		}
	})

	t.Run("clamped to MaxMessageRunes", func(t *testing.T) {
		got := Split(src, 1_000_000)
		if len(got) < 2 {
			t.Fatalf("got %d chunks: the target was not clamped", len(got))
		}
		for _, c := range got {
			if n := utf8.RuneCountInString(c.Text); n > MaxMessageRunes {
				t.Fatalf("chunk %d is %d runes, over the Feishu hard limit", c.Index, n)
			}
		}
	})
}

func TestSplitIndicatorWidthDoesNotOverflowTarget(t *testing.T) {
	// Enough chunks that n needs three digits, so the reserve has to grow.
	const target = 64
	src := strings.Repeat("0123456789", 1000)

	got := Split(src, target)
	if len(got) < 100 {
		t.Fatalf("got %d chunks, want >= 100 so that n is three digits", len(got))
	}
	for _, c := range got {
		if n := utf8.RuneCountInString(c.Text); n > target {
			t.Fatalf("chunk %d/%d is %d runes, over target: the indicator reserve was too small",
				c.Index, c.Total, n)
		}
	}
}

// A target too small to hold the scaffolding is clamped rather than honoured.
// The target comes from config; a typo must produce usable messages, not a
// fence marker dribbled out one rune per message.
func TestSplitClampsUselesslySmallTarget(t *testing.T) {
	src := "```go\n" + strings.Repeat("ab ", 30) + "\n```\n"

	for _, target := range []int{1, 4, 32, minTarget - 1} {
		got := Split(src, target)
		if len(got) == 0 {
			t.Fatalf("target %d: Split returned nothing", target)
		}
		for _, c := range got {
			body := bodyOf(t, c)
			if utf8.RuneCountInString(body) < 4 {
				t.Fatalf("target %d: chunk %d/%d carries almost nothing: %q",
					target, c.Index, c.Total, body)
			}
			if n := utf8.RuneCountInString(c.Text); n > minTarget {
				t.Errorf("target %d: chunk %d is %d runes, over the clamped target",
					target, c.Index, n)
			}
			if fenceRuns(body)%2 != 0 {
				t.Errorf("target %d: chunk %d leaves a fence open:\n%s", target, c.Index, body)
			}
		}
		if want, gotAll := codePayload(src), codePayloadOfChunks(t, got); want != gotAll {
			t.Errorf("target %d: content changed:\n want %q\n  got %q", target, want, gotAll)
		}
	}
}

func head(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "..."
}

// fenceBalanced runs the fence state machine over s and reports whether it ends
// with nothing open — i.e. whether the phone stops rendering a code block at the
// end of this message.
func fenceBalanced(s string) bool {
	open, openLen := "", 0
	for _, line := range strings.Split(s, "\n") {
		marker, info, ok := fenceLine([]rune(line))
		if !ok {
			continue
		}
		if open == "" {
			open, openLen = marker+info, len(marker)
		} else if len(marker) >= openLen && info == "" {
			open, openLen = "", 0
		}
	}
	return open == ""
}

// unmatchedRuns counts the backtick runs that have no partner run of the same
// length on their line: the halves of an inline code span a cut went through,
// which render as literal backticks.
func unmatchedRuns(s string) int {
	n := 0
	for _, line := range strings.Split(s, "\n") {
		r := []rune(line)
		for i := 0; i < len(r); {
			if r[i] != '`' {
				i++
				continue
			}
			k := runLength(r, i, '`')
			j := findRun(r, i+k, '`', k)
			if j < 0 {
				n++
				i += k
				continue
			}
			i = j + k
		}
	}
	return n
}

// fenceRuns counts lines that open or close a code fence.
func fenceRuns(s string) int {
	n := 0
	for _, line := range strings.Split(s, "\n") {
		if _, _, ok := fenceLine([]rune(line)); ok {
			n++
		}
	}
	return n
}

// codePayload is everything except fence marker lines and newlines: the part
// that must survive a split unchanged.
func codePayload(s string) string {
	var b strings.Builder
	for _, line := range strings.Split(s, "\n") {
		if _, _, ok := fenceLine([]rune(line)); ok {
			continue
		}
		b.WriteString(line)
	}
	return b.String()
}

func codePayloadOfChunks(t *testing.T, chunks []Chunk) string {
	t.Helper()
	var b strings.Builder
	for _, c := range chunks {
		b.WriteString(codePayload(bodyOf(t, c)))
	}
	return b.String()
}
