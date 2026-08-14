package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/hewenyu/herdr-agent/internal/setup"
)

// errStdinEnded is what a closed input means: stop.
//
// internal/setup treats any Ask error as "do not wait again" and "do not guess
// which app was meant", which is the only safe reading — a run whose stdin ended
// has nobody left to correct a wrong guess.
var errStdinEnded = errors.New("stdin ended without an answer")

// termPrompter asks one question and reads the answer back.
//
// The question goes to deps.Err, never to stdout: this command's payload is the
// app it produced, and a user who redirected stdout must still see what they are
// being asked. It answers setup.Prompter, which is deliberately the whole
// interface — the package owns what the valid answers ARE (1-n or n for the
// two-app question, enter or q for "keep waiting?", each re-asked once) and this
// type owns nothing but getting the line off the terminal. Splitting it the other
// way would put the question's meaning in one package and its wording in another.
type termPrompter struct {
	out io.Writer
	in  *bufio.Reader
}

var _ setup.Prompter = (*termPrompter)(nil)

// newTermPrompter returns the question-asker for this run, or nil when there is
// nobody to ask.
//
// nil is an answer rather than an omission: setup refuses the two questions it
// cannot guess at instead of guessing, and a prompter that read EOF off a pipe
// would turn "stop, and say what to pass instead" into an I/O error. It is also
// why the terminal test is a dependency — `go test` and launchd both hand a
// process /dev/null, which is a character device, and a Prompter built on that
// reads EOF the first time anything asks.
func newTermPrompter(d *deps) setup.Prompter {
	if d.In == nil || d.IsTTY == nil || !d.IsTTY() {
		return nil
	}
	return &termPrompter{out: d.Err, in: bufio.NewReader(d.In)}
}

// Ask writes question and returns the line typed back, space trimmed.
//
// An empty return is a bare enter, which the caller reads as accepting the
// default its question named. The read runs on its own goroutine because a
// blocking read on a terminal cannot be interrupted: without it a Ctrl-C would
// be noticed only after the human pressed enter, on a run that is holding the
// bridge's single-instance lock. The goroutine is abandoned when ctx ends, which
// is acceptable exactly once, in a one-shot command that is about to exit.
func (p *termPrompter) Ask(ctx context.Context, question string) (string, error) {
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
		// A last line with no trailing newline arrives WITH io.EOF. Reporting the
		// error and dropping the text would throw away a perfectly good answer.
		if a.err != nil && line == "" {
			if errors.Is(a.err, io.EOF) {
				return "", errStdinEnded
			}
			return "", fmt.Errorf("read the answer: %w", a.err)
		}
		return line, nil
	}
}

// stdinIsTTY reports whether there is a human at the other end of stdin.
func stdinIsTTY() bool { return isTerminal(os.Stdin) }

// isTerminal reports whether f is something a person can type into.
//
// The character-device test is the one the shell itself uses, and it is the best
// this program can do without adding a dependency for an ioctl. On its own it is
// not enough: /dev/null is a character device too, and it is exactly what a
// launchd job, a `go test` binary and `herdr-agent setup < /dev/null` are all
// handed. Left in, that reads as "there is a human here", the run skips the line
// that says nothing can be asked, and the first question is answered by an EOF
// nobody asked for.
func isTerminal(f *os.File) bool {
	if f == nil {
		return false
	}
	info, err := f.Stat()
	if err != nil {
		return false
	}
	if info.Mode()&os.ModeCharDevice == 0 {
		return false // a pipe, a file, a socket
	}
	if null, err := os.Stat(os.DevNull); err == nil && os.SameFile(info, null) {
		return false
	}
	return true
}
