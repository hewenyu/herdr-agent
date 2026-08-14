package screen

import (
	"context"
	"errors"
	"fmt"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

// ErrNoClient is returned by NewExtractor when it is handed no client. Failing
// at wiring time beats a nil dereference on the first blocked agent.
var ErrNoClient = errors.New("screen: nil herdr client")

// wholeBuffer is the line count passed to every read: let herdr return what it
// has. No read from this package ever asks for a specific number of lines —
// only source=recent can trigger herdr's 15s synthetic-scroll injection into
// the user's live pane (G9), and never carrying a line count means no later
// edit here can reintroduce that path by accident.
const wholeBuffer = 0

// Option configures an Extractor.
type Option func(*extractor)

// WithMaxCols overrides the crop width. Values <= 0 are ignored, leaving
// DefaultMaxCols.
func WithMaxCols(n int) Option {
	return func(e *extractor) {
		if n > 0 {
			e.maxCols = n
		}
	}
}

// WithContext supplies the base context for herdr calls. The Extractor
// interface carries no context of its own, so shutdown cancellation has to be
// wired in here; the herdr client imposes its own per-call deadline either way
// (G10), so omitting this cannot wedge a caller forever.
//
// A nil ctx is tolerated: ctx() is the single place that decides what a call
// runs on, and it falls back to context.Background().
func WithContext(ctx context.Context) Option {
	return func(e *extractor) { e.base = ctx }
}

type extractor struct {
	client  herdrapi.Client
	maxCols int
	base    context.Context
}

// NewExtractor returns an Extractor that reads panes through c.
func NewExtractor(c herdrapi.Client, opts ...Option) (Extractor, error) {
	if c == nil {
		return nil, ErrNoClient
	}
	e := &extractor{client: c, maxCols: DefaultMaxCols, base: context.Background()}
	for _, opt := range opts {
		opt(e)
	}
	return e, nil
}

// Dialog reads the detection buffer — the same snapshot herdr's own detector
// looked at — so that what the phone shows and what herdr called `blocked`
// cannot disagree.
func (e *extractor) Dialog(paneID string) (Screen, error) {
	raw, err := e.client.AgentRead(e.ctx(), paneID, herdrapi.SourceDetection, wholeBuffer)
	if err != nil {
		return Screen{}, fmt.Errorf("screen: read detection buffer of %s: %w", paneID, err)
	}
	c := cleanLines(raw, e.maxCols)
	lines, cropped := c.window(0)
	s := buildScreen(lines, cropped, c.maxWidth)
	s.Rows = e.rows(paneID)
	return s, nil
}

// Tail reads the visible viewport and keeps its last n non-blank lines. n <= 0
// keeps all of them, which is bounded anyway: the viewport is at most a screen
// tall (G5).
//
// The whole viewport is fetched rather than n lines of it, because n raw lines
// yield fewer than n once blanks are dropped, and a TUI is mostly blanks.
func (e *extractor) Tail(paneID string, n int) (Screen, error) {
	raw, err := e.client.AgentRead(e.ctx(), paneID, herdrapi.SourceVisible, wholeBuffer)
	if err != nil {
		return Screen{}, fmt.Errorf("screen: read visible buffer of %s: %w", paneID, err)
	}
	c := cleanLines(raw, e.maxCols)
	kept, cropped := c.window(n)
	s := buildScreen(kept, cropped, c.maxWidth)
	s.Rows = e.rows(paneID)
	return s, nil
}

func (e *extractor) ctx() context.Context {
	if e.base == nil {
		return context.Background()
	}
	return e.base
}

// rows reports the pane's viewport height, or 0 when herdr does not say.
//
// A failing pane.get must not fail the read: the screen text is the payload a
// blocked user is waiting on, Rows is decoration.
func (e *extractor) rows(paneID string) int {
	pane, err := e.client.PaneGet(e.ctx(), paneID)
	if err != nil || pane.Scroll == nil || pane.Scroll.ViewportRows < 0 {
		return 0
	}
	return pane.Scroll.ViewportRows
}
