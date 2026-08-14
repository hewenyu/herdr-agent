package setup

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/larksuite/oapi-sdk-go/v3/scene/registration"
)

// TestCaptureForwardsStdoutAndLiftsForCallbacks.
//
// Two dependencies print to stdout unconditionally and neither can be
// configured: scene/registration does fmt.Printf("tenant brand: %s\n") on every
// poll, and larkcore builds its logger as log.New(os.Stdout, ...). The CLI
// keeps payload on stdout and metadata on stderr, so those lines have to be
// moved — without moving the CLI's own output with them.
func TestCaptureForwardsStdoutAndLiftsForCallbacks(t *testing.T) {
	real := os.Stdout
	var buf syncBuffer

	c, err := newStdoutCapture(&buf)
	if err != nil {
		t.Fatalf("newStdoutCapture: %v", err)
	}
	if os.Stdout == real {
		t.Fatal("stdout was not redirected")
	}

	fmt.Printf("tenant brand: %s\n", "feishu") // exactly what registration.go:102 does

	sawReal := false
	c.direct(func() { sawReal = os.Stdout == real })
	if !sawReal {
		t.Error("a Progress callback would have written into the capture instead of to the user")
	}
	if os.Stdout == real {
		t.Error("the redirect was not re-installed after the callback")
	}

	if err := c.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if os.Stdout != real {
		t.Fatal("stdout was not restored")
	}
	if err := c.Close(); err != nil {
		t.Errorf("second Close: %v", err)
	}

	if got := buf.String(); !strings.Contains(got, "tenant brand: feishu") {
		t.Errorf("the sink did not receive the line: %q", got)
	}
}

// TestNilCaptureIsAWorkingNoOp: a pipe that could not be created must degrade
// to "the SDK prints to stdout", not fail the run.
func TestNilCaptureIsAWorkingNoOp(t *testing.T) {
	var c *stdoutCapture
	ran := false
	c.direct(func() { ran = true })
	if !ran {
		t.Error("direct did not run its callback")
	}
	if err := c.Close(); err != nil {
		t.Errorf("Close: %v", err)
	}
}

// TestRunKeepsTheSDKOffStdout is the same thing end to end.
func TestRunKeepsTheSDKOffStdout(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	r, p, _ := newRun(t, b)
	real := os.Stdout

	var buf syncBuffer
	captureInto(t, &buf)

	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		// The SDK prints this on every poll, straight to os.Stdout.
		fmt.Printf("tenant brand: %s\n", "feishu")
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/link", ExpireIn: 600})
		return &registration.RegisterAppResult{
			ClientID: testAppID, ClientSecret: testSecret,
			UserInfo: &registration.UserInfo{OpenID: testOpenID},
		}, nil
	})

	if _, err := r.Run(context.Background(), false); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if os.Stdout != real {
		t.Fatal("stdout was not restored after the run")
	}
	if got := buf.String(); !strings.Contains(got, "tenant brand") {
		t.Errorf("the SDK's print did not reach the sink: %q", got)
	}
	for _, c := range p.snapshot() {
		if c.Stdout != real {
			t.Fatalf("Progress.%s was called with stdout still redirected; the confirmation URL "+
				"would have been swallowed", c.Method)
		}
	}
}
