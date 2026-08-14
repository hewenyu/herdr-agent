package mirror

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"maps"
	"os"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"
)

// DefaultPollInterval is how often every enabled transcript is re-examined even
// when no file event arrived.
//
// fsnotify is the fast path, not the reliable one. On macOS it is kqueue: the
// watch lives on the open file, so it dies with the file rather than following
// the path, and events are simply missed often enough that a tail built on them
// alone goes quiet without saying so. Every step below is therefore derived
// from the file's own size rather than from the event, which makes a missed
// event cost one tick of latency and nothing else.
const DefaultPollInterval = 2 * time.Second

const (
	// defaultTurnBuffer is how far the consumer may fall behind before turns are
	// dropped. Mirroring is cosmetic; stalling the tail loop is not.
	defaultTurnBuffer = 128

	// readChunk is the read size used to walk a transcript forward.
	readChunk = 64 << 10

	// maxSyncBytes bounds how much of one transcript is consumed in a single
	// pass. An agent writing faster than we read must not turn one pass into an
	// unbounded loop that starves the other panes and ctx.Done(); the remainder
	// is picked up by the next pass.
	maxSyncBytes = 8 << 20

	// defaultMaxPartial bounds the unterminated tail carried between reads. A
	// transcript that somehow never produces another newline would otherwise
	// grow the buffer without limit; dropping the fragment costs one garbled
	// record, which the parsers already skip.
	defaultMaxPartial = 4 << 20
)

var (
	// ErrNoResolver is returned by NewWatcher when it is handed no resolver.
	ErrNoResolver = errors.New("mirror: nil path resolver")

	// ErrNoPaneID rejects Enable("") — pane id is the only routing key there is
	// (G10), so a blank one could only ever tail nothing.
	ErrNoPaneID = errors.New("mirror: empty pane id")

	// ErrRunOnce rejects a second Run. Run closes the turns channel on the way
	// out, so a watcher cannot be restarted; build a new one.
	ErrRunOnce = errors.New("mirror: Run may be called only once")

	// ErrClosed is returned by Enable after Run has returned.
	ErrClosed = errors.New("mirror: watcher is closed")
)

// PathResolver maps a pane to the transcript file that pane's agent is
// currently writing, plus the agent kind that decides which parser reads it.
//
// It is an interface declared here, rather than a dependency on the agents
// package, for two reasons: the mirror must not import the registry (the wiring
// is one-way, agents knows nothing about chat), and the resolution is allowed
// to fail. ok is false while an agent has been detected but has no session ref
// yet — for claude that gap lasts until the trust-directory prompt is accepted
// and SessionStart fires (G8). That is an ordinary intermediate state, not an
// error, so the watcher keeps asking.
//
// Resolve is called from the tail loop while it holds the watcher's lock; it
// must not call back into the Watcher.
type PathResolver interface {
	Resolve(paneID string) (path, kind string, ok bool)
}

// WatcherOption configures a Watcher.
type WatcherOption func(*watcher)

// WithPollInterval overrides DefaultPollInterval. Values <= 0 are ignored.
func WithPollInterval(d time.Duration) WatcherOption {
	return func(w *watcher) {
		if d > 0 {
			w.interval = d
		}
	}
}

// WithLogger sets the logger. A nil logger is ignored.
func WithLogger(l *slog.Logger) WatcherOption {
	return func(w *watcher) {
		if l != nil {
			w.log = l
		}
	}
}

func withTurnBuffer(n int) WatcherOption {
	return func(w *watcher) {
		if n >= 0 {
			w.turns = make(chan PaneTurn, n)
		}
	}
}

func withNotifier(f func() (notifier, error)) WatcherOption {
	return func(w *watcher) {
		if f != nil {
			w.newNotifier = f
		}
	}
}

func withMaxPartial(n int) WatcherOption {
	return func(w *watcher) {
		if n > 0 {
			w.maxPartial = n
		}
	}
}

// tail is the reading position in one pane's transcript.
//
// Everything here is owned by whoever holds watcher.mu; there is no per-tail
// lock and no goroutine per pane.
type tail struct {
	paneID string

	// path and kind are the last successful resolution. A change in either
	// means a different conversation, not more of this one.
	path string
	kind string

	// parser is nil when kind has no parser (an agent we cannot read). The tail
	// then stays armed but silent, so that a pane which later reports a kind we
	// do understand starts working without the user re-enabling it.
	parser Parser

	off int64
	// rest is the partial final line of the previous read, carried forward
	// because a transcript is read while its writer is halfway through a record.
	rest []byte
	// info identifies the file we are following, so that a new file appearing at
	// the same path is not mistaken for the old one having grown.
	info fs.FileInfo

	// notedPending keeps "still waiting for a session ref" to one log line per
	// pane instead of one per poll for as long as the agent lives.
	notedPending bool
}

// notifier is the slice of fsnotify this package uses. It exists so tests can
// substitute a fake, and so that failing to obtain a real watcher degrades to
// polling instead of disabling mirroring.
type notifier interface {
	Add(path string) error
	Remove(path string) error
	Close() error
	Events() <-chan fsnotify.Event
	Errors() <-chan error
}

type fsNotifier struct{ w *fsnotify.Watcher }

// newFSNotifier returns a buffered fsnotify watcher. Buffered because the tail
// loop is off reading files for most of its life, and an unbuffered backend
// blocked on delivery is how inotify reaches its queue limit.
func newFSNotifier() (notifier, error) {
	w, err := fsnotify.NewBufferedWatcher(64)
	if err != nil {
		return nil, fmt.Errorf("mirror: new fsnotify watcher: %w", err)
	}
	return &fsNotifier{w: w}, nil
}

func (n *fsNotifier) Add(path string) error         { return n.w.Add(path) }
func (n *fsNotifier) Remove(path string) error      { return n.w.Remove(path) }
func (n *fsNotifier) Close() error                  { return n.w.Close() }
func (n *fsNotifier) Events() <-chan fsnotify.Event { return n.w.Events }
func (n *fsNotifier) Errors() <-chan error          { return n.w.Errors }

// watcher tails enabled panes' transcripts.
type watcher struct {
	resolver    PathResolver
	log         *slog.Logger
	interval    time.Duration
	maxPartial  int
	newNotifier func() (notifier, error)

	turns   chan PaneTurn
	started atomic.Bool
	drops   atomic.Uint64

	// mu guards everything below AND is held for the whole of a pass. Passes are
	// stat+read on a handful of files, so the contention is nil, and in exchange
	// Disable means "no further turns for this pane" with no window.
	mu      sync.Mutex
	tails   map[string]*tail
	watched map[string]bool
	notify  notifier
	closed  bool
}

var _ Watcher = (*watcher)(nil)

// NewWatcher returns a Watcher that tails transcripts resolved by r.
func NewWatcher(r PathResolver, opts ...WatcherOption) (Watcher, error) {
	if r == nil {
		return nil, ErrNoResolver
	}
	w := &watcher{
		resolver:    r,
		log:         slog.Default(),
		interval:    DefaultPollInterval,
		maxPartial:  defaultMaxPartial,
		newNotifier: newFSNotifier,
		turns:       make(chan PaneTurn, defaultTurnBuffer),
		tails:       map[string]*tail{},
		watched:     map[string]bool{},
	}
	for _, opt := range opts {
		opt(w)
	}
	return w, nil
}

// Turns returns the channel of mirrored turns. It is closed when Run returns.
func (w *watcher) Turns() <-chan PaneTurn { return w.turns }

// Enable starts tailing paneID's transcript from the current end of the file.
//
// Enabling is not asking for the session so far: back-filling would replay
// every turn of a day-long session into the chat, which is worse than useless
// on a phone (S2 §3.9). Enable is therefore the moment the starting offset is
// taken, whether or not Run has started yet, and a second Enable for a pane
// already being tailed changes nothing rather than re-arming to a later point.
//
// A pane whose transcript cannot be resolved yet is still armed. The resolver
// says "not yet" for an agent that has been detected but has not produced a
// session ref (G8), which is a state every claude passes through; the file is
// picked up — again from its end — as soon as it can be resolved.
//
// Turn.Seq IS NOT A PER-PANE KEY. It orders turns within one transcript file
// (claude: record order as this tail read it; codex: the envelope ordinal), and
// it restarts whenever the file underneath the pane changes — a /resume writes
// a new session id and therefore a new file (G8), and a file replaced at the
// same path is joined fresh. A consumer that keys idempotency or ordering on
// (pane_id, Seq) alone will therefore swallow the opening turns of every
// resumed session; key on (pane, path generation, seq) or on a counter of your
// own. The stream this channel delivers is itself ordered, so a consumer that
// only needs "what came next" can just read it.
func (w *watcher) Enable(paneID string) error {
	if paneID == "" {
		return ErrNoPaneID
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return ErrClosed
	}
	if _, ok := w.tails[paneID]; ok {
		return nil
	}
	t := &tail{paneID: paneID}
	w.tails[paneID] = t
	w.rebind(t)
	return nil
}

// Disable stops tailing paneID. Once it returns, no further turn for that pane
// can be published.
func (w *watcher) Disable(paneID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	t, ok := w.tails[paneID]
	if !ok {
		return
	}
	delete(w.tails, paneID)
	w.unwatch(t.path)
}

func (w *watcher) Enabled(paneID string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, ok := w.tails[paneID]
	return ok
}

// Run tails until ctx is cancelled, then closes the turns channel and every
// watch, and returns ctx.Err(). It may be called once.
func (w *watcher) Run(ctx context.Context) error {
	if !w.started.CompareAndSwap(false, true) {
		return ErrRunOnce
	}
	defer w.shutdown()

	var events <-chan fsnotify.Event
	var errs <-chan error
	if n, err := w.newNotifier(); err != nil || n == nil {
		// No file notifications: mirroring at the poll interval is a degraded
		// mirror, whereas no mirror at all would also take away the only thing
		// that reports the degradation.
		w.log.Warn("mirror: file notifications unavailable, polling only",
			"interval", w.interval, "err", err)
	} else {
		w.attachNotifier(n)
		events, errs = n.Events(), n.Errors()
	}

	tick := time.NewTicker(w.interval)
	defer tick.Stop()

	// Enable may have run long before Run; anything appended since then belongs
	// to the mirror.
	w.pump()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case ev, ok := <-events:
			if !ok {
				// The backend died. The ticker keeps the mirror alive.
				events = nil
				continue
			}
			w.onEvent(ev)
			// One append can produce a burst of Write events, and every pass is
			// a full stat of every tail: collapse what is already queued into
			// this pass instead of doing the work once per event.
			for drain := true; drain; {
				select {
				case ev, ok := <-events:
					if !ok {
						events, drain = nil, false
						continue
					}
					w.onEvent(ev)
				default:
					drain = false
				}
			}
			w.pump()

		case err, ok := <-errs:
			if !ok {
				errs = nil
				continue
			}
			// Includes ErrEventOverflow, which means events were lost. Nothing
			// to do about it here: the next pass re-reads from the file size, so
			// losing events costs latency, not turns.
			w.log.Warn("mirror: watch error", "err", err)

		case <-tick.C:
			w.pump()
		}
	}
}

// onEvent records what an event implies about our watches. It deliberately does
// not decide what to read: that comes from the files themselves in pump.
func (w *watcher) onEvent(ev fsnotify.Event) {
	if !ev.Op.Has(fsnotify.Remove) && !ev.Op.Has(fsnotify.Rename) {
		return
	}
	// The backend drops the watch when the path goes away; forget it so the next
	// pass re-adds one to whatever takes its place.
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.watched, ev.Name)
}

// pump advances every enabled tail once.
func (w *watcher) pump() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	// Sorted so that a pass which advances several panes delivers them in the
	// same order every time; map order would make the stream non-deterministic
	// for no gain.
	for _, id := range slices.Sorted(maps.Keys(w.tails)) {
		t := w.tails[id]
		w.rebind(t)
		w.read(t)
	}
}

// rebind re-resolves a tail's transcript and switches files if it moved.
//
// The path moving is the normal way a session ends: `claude /resume` starts a
// new session id, and the session id is the file name (G8). The new file is
// joined at its END, exactly like Enable, because a resumed session's file
// opens with a replay of the conversation it resumed — back-filling here would
// push the whole of yesterday into the chat. The price is the records written
// to the replacement between its creation and our noticing it, at most one poll
// interval's worth; losing a couple of lines after a /resume is recoverable,
// and a chat with a whole session pasted into it is not.
//
// Two consequences worth stating. Turn.Seq counts the records THIS tail has
// read, so a tail that joined a file part-way through numbers from 0 rather
// than from the record's position in the file; it orders the stream, which is
// all a consumer needs. And the parser is rebuilt with the file, because it
// carries that counter and a half-line of the previous file's bytes.
//
// A resolution that fails is not a reason to let go of the file we already
// have: Resolve goes through the registry, which reports nothing while herdr is
// unreachable (G10). Dropping the offset on a transient failure would re-read
// or skip depending on the weather.
func (w *watcher) rebind(t *tail) {
	path, kind, ok := w.resolver.Resolve(t.paneID)
	if !ok || path == "" {
		if t.path == "" && !t.notedPending {
			t.notedPending = true
			w.log.Debug("mirror: transcript not resolvable yet", "pane", t.paneID)
		}
		return
	}
	t.notedPending = false
	if path == t.path && kind == t.kind {
		// Make sure a watch exists — a no-op when we already have one. It does
		// not exist after a Remove/Rename event, and after a replacement with no
		// event it is stale rather than missing, which is restart's business.
		w.watch(path)
		return
	}

	old := t.path
	t.path = path
	t.kind = kind
	t.rest = nil
	t.off = 0
	t.info = nil

	p, found := ParserFor(kind)
	if !found {
		// Not fatal, and not silent: an agent kind with no parser is the
		// difference between "mirroring is on" and "mirroring shows nothing".
		w.log.Warn("mirror: no transcript parser for agent kind", "pane", t.paneID, "kind", kind)
		p = nil
	}
	t.parser = p

	// Start at the end. A file that does not exist yet is length zero, so
	// everything it will ever contain was written after this point anyway.
	if fi, err := os.Stat(path); err == nil {
		t.off = fi.Size()
		t.info = fi
	} else if !errors.Is(err, fs.ErrNotExist) {
		w.log.Debug("mirror: cannot stat transcript", "pane", t.paneID, "path", path, "err", err)
	}

	w.log.Debug("mirror: following transcript",
		"pane", t.paneID, "kind", kind, "path", path, "from", t.off, "previous", old)

	if old != path {
		w.unwatch(old)
	}
	w.watch(path)
}

// read consumes whatever has been appended to a tail's file since the last pass.
func (w *watcher) read(t *tail) {
	if t.path == "" || t.parser == nil {
		return
	}
	f, err := os.Open(t.path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			w.log.Debug("mirror: cannot open transcript", "pane", t.paneID, "path", t.path, "err", err)
		}
		// A missing file at a path that still resolves means the agent has not
		// created it yet, or it is mid-replacement. Keep the offset: if a
		// different file appears here, the identity check below resets us.
		return
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		w.log.Debug("mirror: cannot stat transcript", "pane", t.paneID, "path", t.path, "err", err)
		return
	}

	switch {
	case t.info != nil && !os.SameFile(t.info, fi):
		// Same path, different file. Our offset counts bytes of a file that no
		// longer exists.
		w.restart(t, restartReplaced, fi)
	case fi.Size() < t.off:
		// Truncated. Same reasoning: the bytes we had read are gone.
		w.restart(t, restartTruncated, fi)
	}
	t.info = fi

	if fi.Size() <= t.off {
		return
	}
	if _, err := f.Seek(t.off, io.SeekStart); err != nil {
		w.log.Warn("mirror: cannot seek transcript", "pane", t.paneID, "path", t.path, "err", err)
		return
	}

	buf := make([]byte, readChunk)
	for read := 0; read < maxSyncBytes; {
		n, err := f.Read(buf)
		if n > 0 {
			t.off += int64(n)
			read += n
			w.feed(t, buf[:n])
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				w.log.Warn("mirror: transcript read failed", "pane", t.paneID, "path", t.path, "err", err)
			}
			return
		}
	}
	w.log.Debug("mirror: transcript read capped for this pass", "pane", t.paneID, "path", t.path)
}

// restartReason says why a tail lost its place, which decides where it resumes.
type restartReason string

const (
	// restartTruncated: the same file, now shorter than what we already read.
	restartTruncated restartReason = "truncated"
	// restartReplaced: a different file has arrived at the same path.
	restartReplaced restartReason = "replaced"
)

// restart re-arms a tail whose offset no longer means anything, and says where
// it picks up again.
//
// Truncated starts at 0. The file is by definition shorter than what was
// already mirrored, so the replay is bounded by its new length, and refusing to
// read it would leave the tail permanently past the end.
//
// Replaced starts at the END, exactly as rebind does for a /resume. A file that
// appears whole at a path — an atomic rewrite, a restore from backup, a synced
// home re-materialising it — is of unbounded length and may well open with the
// entire session in it, which is the one thing the mirror must never push
// (S2 §3.9, and the Enable contract: "back-filling history would dump an entire
// session into chat"). Losing the records written before we noticed costs at
// most a poll interval; getting this wrong costs the user their chat.
//
// The parser goes with the file either way: it carries the record counter that
// becomes Turn.Seq, and half a line of the previous file's bytes.
func (w *watcher) restart(t *tail, why restartReason, fi fs.FileInfo) {
	t.rest = nil
	switch why {
	case restartReplaced:
		t.off = fi.Size()
		// The watch is on the file that just went away, not on the path.
		w.rewatch(t.path)
	default:
		t.off = 0
	}
	w.log.Debug("mirror: restarting transcript tail",
		"pane", t.paneID, "path", t.path, "why", string(why), "from", t.off)
	if p, ok := ParserFor(t.kind); ok {
		t.parser = p
	}
}

// feed parses one chunk and publishes whatever turns it completed.
func (w *watcher) feed(t *tail, chunk []byte) {
	buf := chunk
	if len(t.rest) > 0 {
		// rest is a copy the parser handed back, so appending to it cannot
		// scribble over the read buffer.
		buf = append(t.rest, chunk...)
	}
	turns, rest, err := t.parser.Parse(buf)
	if err != nil {
		// The Parser contract says an unrecognised record is skipped rather than
		// raised, so this should not happen; if a future parser does raise, the
		// mirror resynchronises at the next newline instead of stopping.
		w.log.Warn("mirror: parser error, resyncing", "pane", t.paneID, "parser", t.parser.Name(), "err", err)
		rest = nil
	}
	if len(rest) > w.maxPartial {
		w.log.Warn("mirror: dropping oversized partial transcript line",
			"pane", t.paneID, "bytes", len(rest))
		rest = nil
	}
	t.rest = rest

	for _, turn := range turns {
		w.publish(PaneTurn{PaneID: t.paneID, Turn: turn})
	}
}

// publish hands a turn to the consumer, dropping it if nobody is keeping up.
//
// Blocking here would stop the tail of every other pane behind a chat client
// that is mid round-trip, and the mirror is the cosmetic half of the product:
// the half that answers permission dialogs must never wait on it.
func (w *watcher) publish(pt PaneTurn) {
	select {
	case w.turns <- pt:
	default:
		w.drops.Add(1)
		w.log.Debug("mirror: dropped turn, consumer not keeping up", "pane", pt.PaneID, "seq", pt.Turn.Seq)
	}
}

// dropped counts turns no consumer had room for.
func (w *watcher) dropped() uint64 { return w.drops.Load() }

func (w *watcher) attachNotifier(n notifier) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		_ = n.Close()
		return
	}
	w.notify = n
	for _, t := range w.tails {
		w.watch(t.path)
	}
}

// watch adds a file watch, if there is a notifier and the path is not already
// watched. Failure is logged at debug and otherwise ignored: the poll interval
// is the guarantee, fsnotify only the latency.
//
// Single files only, never a directory and never fsnotify's recursive form: the
// recursive Add is the one code path in the backend that emits events from
// inside Add, and this is called while holding mu, which is also what the loop
// needs to drain those events.
func (w *watcher) watch(path string) {
	if path == "" || w.notify == nil || w.watched[path] {
		return
	}
	if err := w.notify.Add(path); err != nil {
		w.log.Debug("mirror: cannot watch transcript", "path", path, "err", err)
		return
	}
	w.watched[path] = true
}

// rewatch moves the watch from the file that used to be at path to the one
// there now.
//
// On macOS fsnotify is kqueue, which watches the open file rather than the
// path: when the file is swapped the watch stays attached to the dead inode and
// no event for that path ever arrives again. If the Remove/Rename event was
// delivered, onEvent has already forgotten the path and watch() re-adds it —
// but this design assumes those events go missing (see DefaultPollInterval),
// and in that case w.watched still says true and watch() would do nothing. The
// pane would keep working on the 2s poll while quietly losing the latency the
// notifier is there for, and nothing would say so.
//
// Unlike unwatch this ignores whether another pane follows the path: the watch
// is re-added immediately, and the one being dropped is dead anyway.
func (w *watcher) rewatch(path string) {
	if path == "" {
		return
	}
	delete(w.watched, path)
	if w.notify != nil {
		if err := w.notify.Remove(path); err != nil && !errors.Is(err, fsnotify.ErrNonExistentWatch) {
			w.log.Debug("mirror: cannot drop stale watch", "path", path, "err", err)
		}
	}
	w.watch(path)
}

// unwatch drops the watch on path unless another pane is still following it.
func (w *watcher) unwatch(path string) {
	if path == "" || !w.watched[path] {
		return
	}
	for _, t := range w.tails {
		if t.path == path {
			return
		}
	}
	delete(w.watched, path)
	if w.notify == nil {
		return
	}
	if err := w.notify.Remove(path); err != nil && !errors.Is(err, fsnotify.ErrNonExistentWatch) {
		w.log.Debug("mirror: cannot unwatch transcript", "path", path, "err", err)
	}
}

// shutdown closes the turns channel and releases every watch. Called once, from
// Run's defer.
func (w *watcher) shutdown() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	w.closed = true
	if w.notify != nil {
		// Close removes every watch; individual Removes would only race with it.
		if err := w.notify.Close(); err != nil {
			w.log.Debug("mirror: closing file watcher", "err", err)
		}
		w.notify = nil
	}
	w.watched = map[string]bool{}
	w.tails = map[string]*tail{}
	close(w.turns)
}
