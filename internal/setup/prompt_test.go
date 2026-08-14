package setup

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"strings"
	"testing"
)

func TestTerminalPrompterReadsOneLine(t *testing.T) {
	var out bytes.Buffer
	p := &terminalPrompter{out: &out, in: bufio.NewReader(strings.NewReader("  2  \nignored\n"))}

	answer, err := p.Ask(context.Background(), "Which should the bridge use?")
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if answer != "2" {
		t.Errorf("answer = %q, want the line trimmed", answer)
	}
	if !strings.Contains(out.String(), "Which should the bridge use?") {
		t.Errorf("the question was not written where the human can read it: %q", out.String())
	}
}

// TestTerminalPrompterReportsAnEndedInput. A closed stdin must be an error, not
// an empty answer: an empty answer means "the human pressed enter", and pressing
// enter is an answer to some of these questions.
func TestTerminalPrompterReportsAnEndedInput(t *testing.T) {
	p := &terminalPrompter{out: io.Discard, in: bufio.NewReader(strings.NewReader(""))}

	if _, err := p.Ask(context.Background(), "keep waiting?"); err == nil {
		t.Fatal("Ask returned no error on a closed input")
	}
}

// TestTerminalPrompterHonoursTheContext.
//
// A blocking read on a terminal cannot be interrupted, so without the goroutine
// inside Ask a Ctrl-C would be noticed only after the human pressed enter — on a
// run that is holding the bridge's single-instance lock.
func TestTerminalPrompterHonoursTheContext(t *testing.T) {
	pr, pw := io.Pipe()
	t.Cleanup(func() { _ = pw.Close() })
	p := &terminalPrompter{out: io.Discard, in: bufio.NewReader(pr)}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := p.Ask(ctx, "keep waiting?"); err == nil {
		t.Fatal("Ask blocked on a dead context instead of returning")
	}
}

// TestNoTerminalMeansNoPrompter: nil is what makes every question in this package
// degrade to an explicit refusal instead of an I/O error on a pipe.
func TestNoTerminalMeansNoPrompter(t *testing.T) {
	noTTY(t)
	if p := newTerminalPrompter(); p != nil {
		t.Errorf("newTerminalPrompter() = %#v without a terminal, want nil", p)
	}
}

func TestDeclinesRecognisesTheWaysAHumanSaysStop(t *testing.T) {
	for _, stop := range []string{"q", "Q", " quit ", "n", "no", "STOP", "exit"} {
		if !declines(stop) {
			t.Errorf("declines(%q) = false", stop)
		}
	}
	// Anything else is "carry on", because the question says "press enter": a
	// human who typed something else is not asking to be told it was invalid.
	for _, go_ := range []string{"", " ", "y", "yes", "again", "1"} {
		if declines(go_) {
			t.Errorf("declines(%q) = true; the question offers enter as the way to continue", go_)
		}
	}
}
