package main

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

// TestPromptReadsStdinOnlyAtATerminal is the whole gate. `go test` and launchd
// both hand a process /dev/null — a character device — so a prompter built on the
// file mode alone would read EOF in the middle of a suite, or in a launchd job,
// and internal/setup would report "stdin ended" instead of the flag to pass.
func TestPromptReadsStdinOnlyAtATerminal(t *testing.T) {
	t.Run("no terminal means no prompter", func(t *testing.T) {
		h := newHarness(t) // In fails the test if it is read, IsTTY is nil
		if p := newTermPrompter(h.d); p != nil {
			t.Fatal("built a prompter with no terminal: nothing would be there to answer it")
		}
	})

	t.Run("IsTTY false means no prompter", func(t *testing.T) {
		h := newHarness(t)
		h.d.In = strings.NewReader("1\n")
		h.d.IsTTY = func() bool { return false }
		if p := newTermPrompter(h.d); p != nil {
			t.Fatal("built a prompter for a reader the harness said is not a terminal")
		}
	})

	t.Run("no reader means no prompter", func(t *testing.T) {
		h := newHarness(t)
		h.d.In = nil
		h.d.IsTTY = func() bool { return true }
		if p := newTermPrompter(h.d); p != nil {
			t.Fatal("built a prompter with nothing to read from")
		}
	})

	t.Run("a terminal gets one", func(t *testing.T) {
		h := newHarness(t)
		h.withTerminal("2\n")
		p := newTermPrompter(h.d)
		if p == nil {
			t.Fatal("no prompter at a terminal: the two questions would fail instead of being asked")
		}
		got, err := p.Ask(context.Background(), "Which should the bridge use? [1-2, or n to register a new app]")
		if err != nil {
			t.Fatalf("Ask: %v", err)
		}
		if got != "2" {
			t.Errorf("Ask returned %q, want 2", got)
		}
		if !strings.Contains(h.stderr(), "Which should the bridge use?") {
			t.Errorf("the question was not put to the human:\n%s", h.stderr())
		}
		if h.stdout() != "" {
			t.Errorf("the question went to stdout, which carries the payload: %q", h.stdout())
		}
	})
}

// TestPromptReturnsTheAnswersSetupParses. The valid answers belong to
// internal/setup — 1..n or n for "which app", enter or q for "keep waiting?",
// each re-asked once — so this side must hand every one of them over verbatim.
// A prompter that trimmed, lowercased or "helpfully" defaulted would silently
// change which app the bridge ends up pointing at.
func TestPromptReturnsTheAnswersSetupParses(t *testing.T) {
	tests := []struct {
		typed string
		want  string
	}{
		{"1\n", "1"},
		{"2\n", "2"},
		{"n\n", "n"},
		{"\n", ""},       // a bare enter: the caller's named default
		{"q\n", "q"},     //
		{"  1  \n", "1"}, // a terminal answer arrives with whatever the human typed around it
		{"1\r\n", "1"},   // and, on some terminals, with a carriage return
		{"cli_x1\n", "cli_x1"},
		{"3", "3"}, // a last line with no newline still carries an answer
	}
	for _, tc := range tests {
		t.Run(tc.typed, func(t *testing.T) {
			h := newHarness(t)
			h.withTerminal(tc.typed)
			got, err := newTermPrompter(h.d).Ask(context.Background(), "pick one:")
			if err != nil {
				t.Fatalf("Ask(%q): %v", tc.typed, err)
			}
			if got != tc.want {
				t.Errorf("Ask(%q) = %q, want %q", tc.typed, got, tc.want)
			}
		})
	}
}

// TestPromptSurvivesBeingAskedTwice: internal/setup re-asks once on an answer it
// cannot parse, and offers another wait after each timeout. Both re-use the same
// prompter, so a reader that was closed or consumed by the first question would
// turn a typo into the end of the run.
func TestPromptSurvivesBeingAskedTwice(t *testing.T) {
	h := newHarness(t)
	h.withTerminal("x\n2\n")
	p := newTermPrompter(h.d)

	first, err := p.Ask(context.Background(), "Which should the bridge use? [1-2, or n]")
	if err != nil {
		t.Fatalf("first Ask: %v", err)
	}
	second, err := p.Ask(context.Background(), "Answer 1-2 to pick one of the apps above, or n:")
	if err != nil {
		t.Fatalf("second Ask: %v", err)
	}
	if first != "x" || second != "2" {
		t.Fatalf("answers = %q, %q; want x then 2", first, second)
	}
	if strings.Count(h.stderr(), "?") == 0 || !strings.Contains(h.stderr(), "Answer 1-2") {
		t.Errorf("the second question never reached the human:\n%s", h.stderr())
	}
}

// TestPromptTreatsEOFAsStop: a closed stdin has nobody left to correct a wrong
// guess, so it must be an error internal/setup can turn into "not waiting again"
// and "not picking an app for you" — not a hang, and not a made-up answer.
func TestPromptTreatsEOFAsStop(t *testing.T) {
	h := newHarness(t)
	h.withTerminal("")
	got, err := newTermPrompter(h.d).Ask(context.Background(), "press enter to wait again, or q to stop:")
	if !errors.Is(err, errStdinEnded) {
		t.Fatalf("err = %v, want errStdinEnded", err)
	}
	if got != "" {
		t.Errorf("an answer was invented out of EOF: %q", got)
	}
}

// TestPromptGivesUpWhenTheContextEnds: a blocking read on a terminal cannot be
// interrupted, and this run holds the bridge's single-instance lock. Without this
// a Ctrl-C would be noticed only after the human pressed enter.
func TestPromptGivesUpWhenTheContextEnds(t *testing.T) {
	h := newHarness(t)
	h.d.In = blockingReader{}
	h.d.IsTTY = func() bool { return true }

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan error, 1)
	go func() {
		_, err := newTermPrompter(h.d).Ask(ctx, "keep waiting?")
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Ask ignored a cancelled context and is still waiting on the read")
	}
}

// TestIsTerminalRejectsDevNull: /dev/null is a character device, so the mode test
// alone calls it a terminal. launchd, `go test` and `setup < /dev/null` all hand
// a process exactly that, and each of them would then be told a question was
// asked and answered with EOF instead of being told up front that nothing can be
// asked here.
func TestIsTerminalRejectsDevNull(t *testing.T) {
	null, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer null.Close()

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()

	file, err := os.CreateTemp(t.TempDir(), "stdin-*")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	for name, f := range map[string]*os.File{
		"/dev/null":    null,
		"pipe":         r,
		"regular file": file,
		"nil":          nil,
	} {
		if isTerminal(f) {
			t.Errorf("isTerminal(%s) = true; nothing typed into that", name)
		}
	}
}

// blockingReader never returns, like a terminal with nobody typing at it.
type blockingReader struct{}

func (blockingReader) Read([]byte) (int, error) {
	<-make(chan struct{})
	return 0, io.EOF
}
