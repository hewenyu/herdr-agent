package screen

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

type readCall struct {
	target string
	src    herdrapi.ReadSource
	lines  int
}

// stubClient records everything the extractor asks herdr for. Methods the
// extractor has no business calling record themselves and fail, so the
// read-only property is testable rather than assumed.
type stubClient struct {
	buffers map[herdrapi.ReadSource]string
	readErr error

	pane    herdrapi.PaneInfo
	paneErr error

	reads   []readCall
	methods []string
}

var errStub = errors.New("stub: method not expected here")

func (c *stubClient) note(m string) { c.methods = append(c.methods, m) }

func (c *stubClient) AgentRead(_ context.Context, target string, src herdrapi.ReadSource, lines int) (string, error) {
	c.note("agent.read")
	c.reads = append(c.reads, readCall{target: target, src: src, lines: lines})
	if c.readErr != nil {
		return "", c.readErr
	}
	return c.buffers[src], nil
}

func (c *stubClient) PaneGet(_ context.Context, paneID string) (herdrapi.PaneInfo, error) {
	c.note("pane.get")
	if c.paneErr != nil {
		return herdrapi.PaneInfo{}, c.paneErr
	}
	pane := c.pane
	pane.PaneID = paneID
	return pane, nil
}

func (c *stubClient) Ping(context.Context) (herdrapi.PingResult, error) {
	c.note("ping")
	return herdrapi.PingResult{}, errStub
}

func (c *stubClient) AgentList(context.Context) ([]herdrapi.AgentInfo, error) {
	c.note("agent.list")
	return nil, errStub
}

func (c *stubClient) AgentGet(context.Context, string) (herdrapi.AgentInfo, error) {
	c.note("agent.get")
	return herdrapi.AgentInfo{}, errStub
}

func (c *stubClient) AgentPrompt(context.Context, string, string, *herdrapi.PromptWait) (herdrapi.AgentInfo, error) {
	c.note("agent.prompt")
	return herdrapi.AgentInfo{}, errStub
}

func (c *stubClient) AgentSendKeys(context.Context, string, []string) error {
	c.note("agent.send_keys")
	return errStub
}

func (c *stubClient) NotificationShow(context.Context, string, string) error {
	c.note("notification.show")
	return errStub
}

func (c *stubClient) Close() error { c.note("close"); return nil }

func newExtractorT(t *testing.T, c herdrapi.Client, opts ...Option) Extractor {
	t.Helper()
	e, err := NewExtractor(c, opts...)
	if err != nil {
		t.Fatalf("NewExtractor: %v", err)
	}
	return e
}

func TestNewExtractorRejectsNilClient(t *testing.T) {
	if _, err := NewExtractor(nil); !errors.Is(err, ErrNoClient) {
		t.Errorf("err = %v, want ErrNoClient", err)
	}
}

func TestDialogReadsDetectionBuffer(t *testing.T) {
	c := &stubClient{
		buffers: map[herdrapi.ReadSource]string{
			herdrapi.SourceDetection: fixture(t, "claude-173.txt"),
			herdrapi.SourceVisible:   "must not be read by Dialog\n",
		},
		pane: herdrapi.PaneInfo{Scroll: &herdrapi.ScrollInfo{ViewportRows: 49}},
	}

	s, err := newExtractorT(t, c).Dialog("w1:p1")
	if err != nil {
		t.Fatalf("Dialog: %v", err)
	}

	if len(c.reads) != 1 {
		t.Fatalf("%d reads, want 1", len(c.reads))
	}
	if c.reads[0].src != herdrapi.SourceDetection {
		t.Errorf("source = %q, want %q: Dialog must see what herdr's own detector saw",
			c.reads[0].src, herdrapi.SourceDetection)
	}
	if c.reads[0].target != "w1:p1" {
		t.Errorf("target = %q, want w1:p1", c.reads[0].target)
	}
	if !hasLineContaining(s.Lines, "Do you want to proceed?") {
		t.Error("Dialog returned content that is not the detection buffer")
	}
	if s.Rows != 49 {
		t.Errorf("Rows = %d, want 49 from the pane's scroll info", s.Rows)
	}
	if s.Cols != 173 || s.Narrow || !s.Cropped {
		t.Errorf("Cols=%d Narrow=%v Cropped=%v, want 173/false/true", s.Cols, s.Narrow, s.Cropped)
	}
}

func TestTailReadsVisibleBufferAndKeepsLastN(t *testing.T) {
	visible := strings.Join([]string{
		"line one", "", "line two", "", "line three", "", "line four", "", "line five", "",
	}, "\n")
	c := &stubClient{
		buffers: map[herdrapi.ReadSource]string{
			herdrapi.SourceVisible:   visible,
			herdrapi.SourceDetection: "must not be read by Tail\n",
		},
	}

	s, err := newExtractorT(t, c).Tail("w1:p1", 3)
	if err != nil {
		t.Fatalf("Tail: %v", err)
	}
	if c.reads[0].src != herdrapi.SourceVisible {
		t.Errorf("source = %q, want %q", c.reads[0].src, herdrapi.SourceVisible)
	}
	want := []string{"line three", "line four", "line five"}
	if !equalLines(s.Lines, want) {
		t.Errorf("Lines = %q, want %q: n counts non-blank lines", s.Lines, want)
	}
}

func TestTailNonPositiveKeepsEverything(t *testing.T) {
	c := &stubClient{buffers: map[herdrapi.ReadSource]string{
		herdrapi.SourceVisible: "one\ntwo\nthree\n",
	}}
	for _, n := range []int{0, -1} {
		s, err := newExtractorT(t, c).Tail("w1:p1", n)
		if err != nil {
			t.Fatalf("Tail(%d): %v", n, err)
		}
		if len(s.Lines) != 3 {
			t.Errorf("Tail(%d) returned %d lines, want all 3", n, len(s.Lines))
		}
	}
}

func TestTailMoreLinesThanAvailable(t *testing.T) {
	c := &stubClient{buffers: map[herdrapi.ReadSource]string{
		herdrapi.SourceVisible: "one\ntwo\n",
	}}
	s, err := newExtractorT(t, c).Tail("w1:p1", 30)
	if err != nil {
		t.Fatalf("Tail: %v", err)
	}
	if !equalLines(s.Lines, []string{"one", "two"}) {
		t.Errorf("Lines = %q, want both lines", s.Lines)
	}
}

// The tail of a wide pane is still a wide pane: Cols and Narrow describe the
// pane that was read, not the slice handed back.
//
// Cropped is the exception. contract.go defines it as "at least one line was
// truncated at MaxCols", and a card renders a "content truncated" note next to
// the lines it is showing — so it has to be true of those lines, not of a
// 173-column line further up the viewport that the caller never sees.
func TestTailReportsPaneWidthNotTailWidth(t *testing.T) {
	c := &stubClient{buffers: map[herdrapi.ReadSource]string{
		herdrapi.SourceVisible: strings.Repeat("x", 173) + "\nshort\n",
	}}
	s, err := newExtractorT(t, c).Tail("w1:p1", 1)
	if err != nil {
		t.Fatalf("Tail: %v", err)
	}
	if !equalLines(s.Lines, []string{"short"}) {
		t.Fatalf("Lines = %q", s.Lines)
	}
	if s.Cols != 173 || s.Narrow {
		t.Errorf("Cols = %d, Narrow = %v; want the pane's 173 columns", s.Cols, s.Narrow)
	}
	if s.Cropped {
		t.Error("Cropped = true, but nothing the caller received was truncated")
	}
}

// The other half of the same rule: once the cropped line IS in the window,
// Cropped must say so.
func TestTailReportsCroppedWhenTheWindowHoldsACroppedLine(t *testing.T) {
	c := &stubClient{buffers: map[herdrapi.ReadSource]string{
		herdrapi.SourceVisible: strings.Repeat("x", 173) + "\nshort\n",
	}}
	for _, n := range []int{2, 0} {
		s, err := newExtractorT(t, c).Tail("w1:p1", n)
		if err != nil {
			t.Fatalf("Tail(%d): %v", n, err)
		}
		if !s.Cropped {
			t.Errorf("Tail(%d): Cropped = false although a returned line was cut at 56", n)
		}
	}
}

// A line that cropping consumed entirely — right-aligned status text whose
// padding is all that fits inside the crop — vanishes from Lines, so the flag
// is the only trace of it left. It still belongs to the window it fell in, and
// only to that window.
func TestTailReportsCroppedWhenCroppingAteTheWholeLine(t *testing.T) {
	padded := strings.Repeat(" ", 60) + "right-aligned"

	tests := []struct {
		name        string
		visible     string
		n           int
		wantLines   []string
		wantCropped bool
	}{
		{
			name:      "the eaten line is inside the window",
			visible:   "first\n" + padded + "\n",
			n:         1,
			wantLines: []string{"first"}, wantCropped: true,
		},
		{
			name:      "the eaten line is above the window",
			visible:   padded + "\na\nb\nc\n",
			n:         2,
			wantLines: []string{"b", "c"}, wantCropped: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := &stubClient{buffers: map[herdrapi.ReadSource]string{
				herdrapi.SourceVisible: tc.visible,
			}}
			s, err := newExtractorT(t, c).Tail("w1:p1", tc.n)
			if err != nil {
				t.Fatalf("Tail: %v", err)
			}
			if !equalLines(s.Lines, tc.wantLines) {
				t.Fatalf("Lines = %q, want %q", s.Lines, tc.wantLines)
			}
			if s.Cropped != tc.wantCropped {
				t.Errorf("Cropped = %v, want %v", s.Cropped, tc.wantCropped)
			}
			if s.Cols != 73 {
				t.Errorf("Cols = %d, want the pane's 73 columns regardless", s.Cols)
			}
		})
	}
}

func TestRowsDegradeToZero(t *testing.T) {
	tests := []struct {
		name    string
		pane    herdrapi.PaneInfo
		paneErr error
		want    int
	}{
		{name: "scroll info present", pane: herdrapi.PaneInfo{Scroll: &herdrapi.ScrollInfo{ViewportRows: 23}}, want: 23},
		{name: "no scroll info", pane: herdrapi.PaneInfo{}, want: 0},
		{name: "pane.get fails", paneErr: errors.New("boom"), want: 0},
		{name: "negative rows", pane: herdrapi.PaneInfo{Scroll: &herdrapi.ScrollInfo{ViewportRows: -1}}, want: 0},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := &stubClient{
				buffers: map[herdrapi.ReadSource]string{
					herdrapi.SourceDetection: "hello\n",
					herdrapi.SourceVisible:   "hello\n",
				},
				pane:    tc.pane,
				paneErr: tc.paneErr,
			}
			e := newExtractorT(t, c)

			// A pane.get failure must never cost the caller the screen text.
			calls := map[string]func() (Screen, error){
				"Dialog": func() (Screen, error) { return e.Dialog("w1:p1") },
				"Tail":   func() (Screen, error) { return e.Tail("w1:p1", 10) },
			}
			for name, call := range calls {
				s, err := call()
				if err != nil {
					t.Fatalf("%s: %v", name, err)
				}
				if s.Rows != tc.want {
					t.Errorf("%s Rows = %d, want %d", name, s.Rows, tc.want)
				}
				if len(s.Lines) != 1 {
					t.Errorf("%s dropped the screen text: %q", name, s.Lines)
				}
			}
		})
	}
}

func TestReadErrorsAreWrapped(t *testing.T) {
	sentinel := &herdrapi.APIError{Code: herdrapi.CodeNotFound, Message: "no such pane"}
	c := &stubClient{readErr: sentinel}
	e := newExtractorT(t, c)

	for _, tc := range []struct {
		name string
		call func() (Screen, error)
	}{
		{"Dialog", func() (Screen, error) { return e.Dialog("w1:p1") }},
		{"Tail", func() (Screen, error) { return e.Tail("w1:p1", 5) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tc.call()
			if err == nil {
				t.Fatal("want an error")
			}
			var apiErr *herdrapi.APIError
			if !errors.As(err, &apiErr) || apiErr.Code != herdrapi.CodeNotFound {
				t.Errorf("err = %v, want the herdr error preserved through %%w", err)
			}
			if !strings.Contains(err.Error(), "w1:p1") {
				t.Errorf("err = %v, want the pane id in the message", err)
			}
		})
	}
}

// G9: only `visible` and `detection` may ever be read, and never with an
// explicit line count — `recent` with a line count makes herdr synthesise mouse
// wheel events into the user's live pane for up to 15 seconds.
func TestOnlySafeReadsAreIssued(t *testing.T) {
	c := &stubClient{buffers: map[herdrapi.ReadSource]string{
		herdrapi.SourceDetection: fixture(t, "claude-173.txt"),
		herdrapi.SourceVisible:   fixture(t, "claude-53.txt"),
	}}
	e := newExtractorT(t, c)

	if _, err := e.Dialog("w1:p1"); err != nil {
		t.Fatalf("Dialog: %v", err)
	}
	if _, err := e.Tail("w1:p1", 20); err != nil {
		t.Fatalf("Tail: %v", err)
	}

	for _, r := range c.reads {
		if r.src != herdrapi.SourceVisible && r.src != herdrapi.SourceDetection {
			t.Errorf("read source %q is not whitelisted", r.src)
		}
		if r.lines != 0 {
			t.Errorf("read asked for %d lines; this package must never send a line count", r.lines)
		}
	}

	allowed := map[string]bool{"agent.read": true, "pane.get": true}
	for _, m := range c.methods {
		if !allowed[m] {
			t.Errorf("called %q; the extractor is read-only", m)
		}
	}
}

func TestWithMaxCols(t *testing.T) {
	c := &stubClient{buffers: map[herdrapi.ReadSource]string{
		herdrapi.SourceDetection: strings.Repeat("x", 100) + "\n",
	}}

	s, err := newExtractorT(t, c, WithMaxCols(20)).Dialog("w1:p1")
	if err != nil {
		t.Fatalf("Dialog: %v", err)
	}
	if len(s.Lines) != 1 || len([]rune(s.Lines[0])) != 20 {
		t.Errorf("Lines = %q, want one 20-rune line", s.Lines)
	}

	// A nonsense override leaves the phone default in place.
	s, err = newExtractorT(t, c, WithMaxCols(0)).Dialog("w1:p1")
	if err != nil {
		t.Fatalf("Dialog: %v", err)
	}
	if len([]rune(s.Lines[0])) != DefaultMaxCols {
		t.Errorf("line is %d runes, want the %d-column default", len([]rune(s.Lines[0])), DefaultMaxCols)
	}
}

func TestWithContextIsPassedThrough(t *testing.T) {
	type ctxKey struct{}
	want := context.WithValue(context.Background(), ctxKey{}, "v")

	var got context.Context
	c := &ctxSpyClient{stubClient: stubClient{buffers: map[herdrapi.ReadSource]string{
		herdrapi.SourceDetection: "hello\n",
	}}, seen: &got}

	if _, err := newExtractorT(t, c, WithContext(want)).Dialog("w1:p1"); err != nil {
		t.Fatalf("Dialog: %v", err)
	}
	if got == nil || got.Value(ctxKey{}) != "v" {
		t.Error("the configured context did not reach the client")
	}

	// A nil context is tolerated, and must never reach the client: every call
	// still runs on context.Background().
	var fallback context.Context
	nilCtx := &ctxSpyClient{stubClient: stubClient{buffers: map[herdrapi.ReadSource]string{
		herdrapi.SourceDetection: "hello\n",
	}}, seen: &fallback}

	if _, err := newExtractorT(t, nilCtx, WithContext(nil)).Dialog("w1:p1"); err != nil {
		t.Fatalf("Dialog: %v", err)
	}
	if fallback == nil {
		t.Error("WithContext(nil) let a nil context through to the herdr client")
	}
}

type ctxSpyClient struct {
	stubClient
	seen *context.Context
}

func (c *ctxSpyClient) AgentRead(ctx context.Context, target string, src herdrapi.ReadSource, lines int) (string, error) {
	*c.seen = ctx
	return c.stubClient.AgentRead(ctx, target, src, lines)
}
