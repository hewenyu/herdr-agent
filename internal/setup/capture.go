package setup

import (
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// drainGrace bounds how long Close waits for the forwarder to finish. It is a
// safety net, not a synchronisation point: the pipe has one writer and we close
// it ourselves, so io.Copy always ends.
const drainGrace = 2 * time.Second

// stdoutCapture points os.Stdout at a pipe whose contents are forwarded to a
// sink, for as long as a setup run lasts.
//
// It exists because two dependencies print to stdout unconditionally and
// neither can be configured:
//
//   - scene/registration/registration.go:102 does a bare
//     fmt.Printf("tenant brand: %s\n", ...) on every poll of the device flow;
//   - larkcore builds its default logger as log.New(os.Stdout, ...)
//     (core/logger.go:88), so every SDK connect/disconnect line lands there too.
//
// The CLI keeps its payload on stdout and its metadata on stderr, so an
// uninvited line from a dependency corrupts a contract the caller cannot
// defend on its own. Forwarding to stderr keeps the information — a reconnect
// storm during setup is worth seeing — while keeping stdout clean.
//
// A nil *stdoutCapture is a working no-op, so a pipe that could not be created
// degrades to "the SDK prints to stdout" rather than failing the run.
type stdoutCapture struct {
	real *os.File
	w    *os.File
	r    *os.File
	done chan struct{}

	mu     sync.Mutex
	closed bool
}

// newStdoutCapture installs the redirect. The caller must Close it.
func newStdoutCapture(sink io.Writer) (*stdoutCapture, error) {
	if sink == nil {
		return nil, fmt.Errorf("setup: stdout capture needs a sink")
	}
	r, w, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("setup: create stdout pipe: %w", err)
	}
	c := &stdoutCapture{real: os.Stdout, w: w, r: r, done: make(chan struct{})}
	os.Stdout = w
	go func() {
		defer close(c.done)
		_, _ = io.Copy(sink, r)
	}()
	return c, nil
}

// direct runs f with the real stdout restored, and re-installs the redirect
// afterwards.
//
// Every call into Progress goes through here. Without it the CLI's own
// presentation — the confirmation URL above all — would be swallowed by the
// redirect this package installed for the SDK's benefit, which would turn a
// hygiene measure into a broken onboarding flow.
func (c *stdoutCapture) direct(f func()) {
	if c == nil {
		f()
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		os.Stdout = c.real
		defer func() { os.Stdout = c.w }()
	}
	f()
}

// Close restores os.Stdout and drains what is left in the pipe. It is
// idempotent.
//
// Anything that captured the pipe by value — larkcore's logger takes os.Stdout
// once, at client construction — keeps writing to a closed file afterwards.
// log.Logger discards write errors, so that is a lost line rather than a
// crash, and setup is a one-shot command whose process is about to exit.
func (c *stdoutCapture) Close() error {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	os.Stdout = c.real
	err := c.w.Close()
	c.mu.Unlock()

	select {
	case <-c.done:
	case <-time.After(drainGrace):
	}
	_ = c.r.Close()

	if err != nil {
		return fmt.Errorf("setup: close stdout pipe: %w", err)
	}
	return nil
}
