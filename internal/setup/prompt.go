package setup

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// stdinIsTTY reports whether there is a human at the other end of stdin.
//
// Behind a variable so no test depends on how it was started. A character
// device is the test the shell itself uses; a pipe, a file or /dev/null (what
// `go test` and every CI runner hand a process) is not one.
var stdinIsTTY = func() bool {
	info, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

// terminalPrompter asks on stderr and reads from stdin.
//
// stderr, not stdout: this command's payload is the app it produced, and a user
// who redirected stdout still has to see the question they are being asked.
type terminalPrompter struct {
	out io.Writer
	in  *bufio.Reader
}

// newTerminalPrompter returns a Prompter when a human is present, nil otherwise.
//
// nil is the whole point: every question in this package is answered by
// refusing when there is nobody to ask, and a Prompter that read EOF from a
// pipe would turn "stop and say why" into "stop with an I/O error".
func newTerminalPrompter() Prompter {
	if !stdinIsTTY() {
		return nil
	}
	return &terminalPrompter{out: os.Stderr, in: bufio.NewReader(os.Stdin)}
}

// Ask writes the question and returns the line typed back.
//
// The read runs on its own goroutine because a blocking read on a terminal
// cannot be interrupted: without this, a Ctrl-C would be noticed only after the
// human pressed enter, on a run that is holding the bridge's instance lock. The
// goroutine is abandoned when ctx ends — acceptable exactly once, in a one-shot
// command that is about to exit.
func (p *terminalPrompter) Ask(ctx context.Context, question string) (string, error) {
	fmt.Fprintf(p.out, "\n  %s ", question)

	type answer struct {
		line string
		err  error
	}
	ch := make(chan answer, 1)
	go func() {
		line, err := p.in.ReadString('\n')
		ch <- answer{line, err}
	}()

	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case a := <-ch:
		line := strings.TrimSpace(a.line)
		if a.err != nil && line == "" {
			if errors.Is(a.err, io.EOF) {
				return "", errors.New("stdin ended without an answer")
			}
			return "", fmt.Errorf("read the answer: %w", a.err)
		}
		return line, nil
	}
}

// declines reports whether an answer means "stop".
//
// Everything else counts as "keep going", because the question says "press
// enter": a human who typed something other than q is not asking to be told
// their input was invalid, they are asking to carry on.
func declines(answer string) bool {
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "q", "quit", "n", "no", "stop", "exit":
		return true
	default:
		return false
	}
}

// offerAnotherWait asks whether to keep waiting, in place, rather than making
// the human re-run the whole command.
//
// This is the difference between a missed message costing one keypress and
// costing another registration-shaped run: everything before this point is
// already done and correct, and the only thing that failed is that a human was
// not looking at their phone.
//
// It returns false without asking when there is nobody to ask, when the run has
// no time left, or when the answer is a refusal.
func (r *Runner) offerAnotherWait(ctx context.Context, rep *reporter, what string, waited time.Duration) bool {
	if !r.interactive() {
		return false
	}
	if effectiveWait(ctx, time.Second) <= 0 {
		// The caller's deadline is spent; offering a wait we cannot honour is
		// the promise-we-cannot-keep shape that outOfBudget exists to avoid.
		return false
	}

	answer, err := r.prompt.Ask(ctx, fmt.Sprintf(
		"%s in %s — press enter to wait again, or q to stop and print the checklist:", what, waited))
	if err != nil {
		if ctx.Err() == nil {
			rep.note("Not waiting again: %s", rep.errText(err))
		}
		return false
	}
	return !declines(answer)
}
