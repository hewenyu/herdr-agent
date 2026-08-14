package mirror

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

// ---------- harness ----------

// fakeResolver stands in for agents.TranscriptResolver. It is mutable so a test
// can do what /resume does: change the path a pane resolves to.
type fakeResolver struct {
	mu      sync.Mutex
	entries map[string]resolution
	// calls receives once per Resolve, so a test running against a live tail
	// loop can wait for a pass to happen instead of guessing at a duration.
	calls chan struct{}
}

type resolution struct {
	path string
	kind string
	ok   bool
}

func newResolver() *fakeResolver {
	return &fakeResolver{entries: map[string]resolution{}, calls: make(chan struct{}, 64)}
}

func (r *fakeResolver) set(paneID, path, kind string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries[paneID] = resolution{path: path, kind: kind, ok: true}
}

func (r *fakeResolver) unset(paneID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries[paneID] = resolution{}
}

func (r *fakeResolver) Resolve(paneID string) (string, string, bool) {
	r.mu.Lock()
	e := r.entries[paneID]
	r.mu.Unlock()
	select {
	case r.calls <- struct{}{}:
	default:
	}
	return e.path, e.kind, e.ok
}

// awaitPass blocks until a whole tail pass has started and finished after the
// caller's last change. Resolve is called once per pane per pass, so a second
// call proves the pass that made the first one is over.
func (r *fakeResolver) awaitPass(t *testing.T) {
	t.Helper()
	for stale := true; stale; {
		select {
		case <-r.calls:
		default:
			stale = false
		}
	}
	for range 2 {
		select {
		case <-r.calls:
		case <-time.After(10 * time.Second):
			t.Fatal("timed out waiting for a tail pass")
		}
	}
}

// fakeNotifier is a hand-driven fsnotify. Tests that exercise Run's wiring use
// it so an event is a function call rather than a race with the kernel.
type fakeNotifier struct {
	events chan fsnotify.Event
	errs   chan error
	// added and removed report watch bookkeeping as it happens, so tests wait on
	// a channel rather than spinning on a slice.
	added   chan string
	removed chan string

	mu     sync.Mutex
	closed bool
}

func newFakeNotifier() *fakeNotifier {
	return &fakeNotifier{
		events:  make(chan fsnotify.Event, 16),
		errs:    make(chan error, 4),
		added:   make(chan string, 32),
		removed: make(chan string, 32),
	}
}

func (n *fakeNotifier) Add(path string) error {
	n.added <- path
	return nil
}

func (n *fakeNotifier) Remove(path string) error {
	n.removed <- path
	return nil
}

func (n *fakeNotifier) Close() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.closed = true
	close(n.events)
	close(n.errs)
	return nil
}

func (n *fakeNotifier) Events() <-chan fsnotify.Event { return n.events }
func (n *fakeNotifier) Errors() <-chan error          { return n.errs }

func (n *fakeNotifier) isClosed() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.closed
}

// assertNoPath asserts that no watch bookkeeping happened. Every caller drives
// the watcher synchronously, so "not there yet" and "never" are the same thing.
func assertNoPath(t *testing.T, ch <-chan string, what string) {
	t.Helper()
	select {
	case p := <-ch:
		t.Fatalf("%s: %q", what, p)
	default:
	}
}

func waitPath(t *testing.T, ch <-chan string, what string) string {
	t.Helper()
	select {
	case p := <-ch:
		return p
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for a watch to be %s", what)
		return ""
	}
}

// newTestWatcher builds a watcher with no notifier at all: the tail logic is
// driven by calling pump directly, which makes every assertion below exact
// rather than timing-dependent.
func newTestWatcher(t *testing.T, r PathResolver, opts ...WatcherOption) (*watcher, *bytes.Buffer) {
	t.Helper()
	var log bytes.Buffer
	base := []WatcherOption{
		WithLogger(slog.New(slog.NewTextHandler(&log, &slog.HandlerOptions{Level: slog.LevelDebug}))),
		withNotifier(func() (notifier, error) { return nil, errors.New("no notifier in this test") }),
	}
	w, err := NewWatcher(r, append(base, opts...)...)
	if err != nil {
		t.Fatalf("NewWatcher: %v", err)
	}
	return w.(*watcher), &log
}

// claudeLine renders one claude transcript record. The parser's own fixture
// tests cover the format; here the record is only a carrier for text.
func claudeLine(role, text string) string {
	return fmt.Sprintf(`{"type":%q,"timestamp":"2026-08-13T14:59:32.011Z","message":{"role":%q,"content":%q}}`+"\n",
		role, role, text)
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func appendFile(t *testing.T, path, content string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	if _, err := f.WriteString(content); err != nil {
		f.Close()
		t.Fatalf("append %s: %v", path, err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close %s: %v", path, err)
	}
}

// drain takes every turn already sitting in the channel. Only ever called after
// a synchronous pump, so "already sitting there" is the complete set.
func drain(w *watcher) []PaneTurn {
	var out []PaneTurn
	for {
		select {
		case pt := <-w.turns:
			out = append(out, pt)
		default:
			return out
		}
	}
}

func texts(turns []PaneTurn) []string {
	var out []string
	for _, pt := range turns {
		out = append(out, pt.PaneID+":"+pt.Turn.Text)
	}
	return out
}

func wantTexts(t *testing.T, got []PaneTurn, want ...string) {
	t.Helper()
	g := texts(got)
	if strings.Join(g, "|") != strings.Join(want, "|") {
		t.Fatalf("turns = %q, want %q", g, want)
	}
}

// waitTurn reads one turn with a deadline. Used only by the Run tests, where
// the whole point is that delivery happens on another goroutine.
func waitTurn(t *testing.T, ch <-chan PaneTurn) PaneTurn {
	t.Helper()
	select {
	case pt, ok := <-ch:
		if !ok {
			t.Fatal("turns channel closed while waiting for a turn")
		}
		return pt
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for a turn")
		return PaneTurn{}
	}
}

// ---------- construction ----------

func TestNewWatcherRejectsNilResolver(t *testing.T) {
	if _, err := NewWatcher(nil); !errors.Is(err, ErrNoResolver) {
		t.Fatalf("NewWatcher(nil) err = %v, want ErrNoResolver", err)
	}
}

func TestEnableValidatesPaneID(t *testing.T) {
	w, _ := newTestWatcher(t, newResolver())
	if err := w.Enable(""); !errors.Is(err, ErrNoPaneID) {
		t.Fatalf("Enable(\"\") err = %v, want ErrNoPaneID", err)
	}
	if w.Enabled("") {
		t.Fatal("Enabled(\"\") = true after a rejected Enable")
	}
}

func TestEnableDisableEnabled(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, "")

	r := newResolver()
	r.set("w1:p1", path, "claude")
	w, _ := newTestWatcher(t, r)

	if w.Enabled("w1:p1") {
		t.Fatal("Enabled before Enable")
	}
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	if !w.Enabled("w1:p1") {
		t.Fatal("Enabled = false after Enable")
	}

	appendFile(t, path, claudeLine("assistant", "one"))
	w.Disable("w1:p1")
	if w.Enabled("w1:p1") {
		t.Fatal("Enabled = true after Disable")
	}
	w.pump()
	// Mirroring is opt-in per agent (S2 §3.9): once it is off, nothing from that
	// pane may reach the chat, including bytes written before it was turned off.
	if got := drain(w); len(got) != 0 {
		t.Fatalf("turns after Disable = %q, want none", texts(got))
	}
}

// ---------- no back-fill ----------

// S2 §3.9: enabling the mirror is not a request for the session so far. A
// day-long session replayed into a chat is unusable, so Enable takes the
// current end of the file as its starting point.
func TestEnableDoesNotBackfill(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path,
		claudeLine("user", "history 1")+
			claudeLine("assistant", "history 2")+
			claudeLine("user", "history 3"))

	r := newResolver()
	r.set("w1:p1", path, "claude")
	w, _ := newTestWatcher(t, r)

	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	w.pump()
	if got := drain(w); len(got) != 0 {
		t.Fatalf("Enable replayed history: %q", texts(got))
	}

	appendFile(t, path, claudeLine("assistant", "live"))
	w.pump()
	wantTexts(t, drain(w), "w1:p1:live")
}

// Re-enabling an already-tailed pane must not move the offset either way: not
// forward (swallowing what arrived since), not backward (replaying it).
func TestEnableIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, "")

	r := newResolver()
	r.set("w1:p1", path, "claude")
	w, _ := newTestWatcher(t, r)

	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	appendFile(t, path, claudeLine("assistant", "written between enables"))
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("second Enable: %v", err)
	}
	w.pump()
	wantTexts(t, drain(w), "w1:p1:written between enables")
}

// ---------- incremental tail ----------

func TestTailPublishesAppends(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, "")

	r := newResolver()
	r.set("w1:p1", path, "claude")
	w, _ := newTestWatcher(t, r)
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	appendFile(t, path, claudeLine("user", "hello"))
	w.pump()
	wantTexts(t, drain(w), "w1:p1:hello")

	appendFile(t, path, claudeLine("assistant", "hi")+claudeLine("assistant", "again"))
	w.pump()
	wantTexts(t, drain(w), "w1:p1:hi", "w1:p1:again")

	// Nothing new: a pass over an unchanged file must not re-emit.
	w.pump()
	if got := drain(w); len(got) != 0 {
		t.Fatalf("idle pass emitted %q", texts(got))
	}
}

// A transcript is read while its writer is halfway through a record, so a pass
// routinely lands on a half-written line. It must be held, not parsed.
func TestPartialLineIsHeldUntilComplete(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, "")

	r := newResolver()
	r.set("w1:p1", path, "claude")
	w, _ := newTestWatcher(t, r)
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	line := claudeLine("assistant", "split across two writes")
	appendFile(t, path, line[:len(line)/2])
	w.pump()
	if got := drain(w); len(got) != 0 {
		t.Fatalf("half a record produced %q", texts(got))
	}

	appendFile(t, path, line[len(line)/2:])
	w.pump()
	wantTexts(t, drain(w), "w1:p1:split across two writes")
}

// An unterminated line cannot be allowed to grow the carry buffer forever.
func TestOversizedPartialLineIsDropped(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, "")

	r := newResolver()
	r.set("w1:p1", path, "claude")
	w, log := newTestWatcher(t, r, withMaxPartial(16))
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	appendFile(t, path, strings.Repeat("x", 512)) // no newline, ever
	w.pump()
	if !strings.Contains(log.String(), "oversized partial") {
		t.Fatalf("no warning about the oversized partial line; log:\n%s", log.String())
	}
	if n := len(w.tails["w1:p1"].rest); n > 16 {
		t.Fatalf("carried partial line = %d bytes, want <= 16", n)
	}

	// The dropped fragment costs the record it belonged to and nothing more:
	// the tail resynchronises at the next newline.
	appendFile(t, path, "\n"+claudeLine("assistant", "after the garbage"))
	w.pump()
	wantTexts(t, drain(w), "w1:p1:after the garbage")
}

// ---------- file replacement ----------

// `claude /resume` starts a new session id, and the session id is the file name
// (G8): the pane keeps going but its transcript path changes underneath us.
func TestReplacedFileAtNewPathIsPickedUp(t *testing.T) {
	dir := t.TempDir()
	oldPath := filepath.Join(dir, "old-session.jsonl")
	newPath := filepath.Join(dir, "new-session.jsonl")
	writeFile(t, oldPath, "")

	r := newResolver()
	r.set("w1:p1", oldPath, "claude")
	w, _ := newTestWatcher(t, r)
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	appendFile(t, oldPath, claudeLine("assistant", "before resume"))
	w.pump()
	wantTexts(t, drain(w), "w1:p1:before resume")

	// A resumed session's file opens with a replay of the conversation it
	// resumed; joining it at the end is what keeps that replay off the phone.
	writeFile(t, newPath, claudeLine("assistant", "replayed history"))
	r.set("w1:p1", newPath, "claude")
	w.pump()
	if got := drain(w); len(got) != 0 {
		t.Fatalf("switching files replayed %q", texts(got))
	}

	appendFile(t, newPath, claudeLine("assistant", "after resume"))
	w.pump()
	got := drain(w)
	wantTexts(t, got, "w1:p1:after resume")
	// The parser went with the file. Had the old one been kept, this record
	// would be numbered 1 — a continuation of a transcript it is not part of.
	if got[0].Turn.Seq != 0 {
		t.Fatalf("Seq = %d, want 0 (first record this tail read from the new file)", got[0].Turn.Seq)
	}

	// The old file is no longer ours, however much it grows.
	appendFile(t, oldPath, claudeLine("assistant", "stale writer"))
	w.pump()
	if got := drain(w); len(got) != 0 {
		t.Fatalf("kept reading the abandoned transcript: %q", texts(got))
	}
}

// A different file appearing at the SAME path (an atomic rewrite: write temp,
// rename over; a restore from backup; a synced home re-materialising the file)
// leaves the offset pointing into bytes that no longer exist.
//
// The replacement is joined at its END, exactly like a /resume file at a new
// path. Its length is unbounded and it may well contain the whole session, and
// "never back-fill" (S2 §3.9, and Enable's contract) does not stop applying
// because the inode changed rather than the name.
func TestReplacedFileAtSamePathJoinsAtTheEnd(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, "")

	r := newResolver()
	r.set("w1:p1", path, "claude")
	w, _ := newTestWatcher(t, r)
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	appendFile(t, path, claudeLine("assistant", "first file"))
	w.pump()
	wantTexts(t, drain(w), "w1:p1:first file")

	var history strings.Builder
	for i := range 200 {
		history.WriteString(claudeLine("assistant", fmt.Sprintf("history %d", i)))
	}
	tmp := filepath.Join(dir, "s.jsonl.tmp")
	writeFile(t, tmp, history.String())
	if err := os.Rename(tmp, path); err != nil {
		t.Fatalf("rename: %v", err)
	}
	w.pump()
	if got := drain(w); len(got) != 0 {
		t.Fatalf("a file dropped in at the watched path was replayed into the chat: %d turns, first %q",
			len(got), texts(got)[0])
	}
	if w.dropped() != 0 {
		t.Fatalf("dropped = %d; the replacement was replayed and overran the consumer", w.dropped())
	}

	// What the agent writes AFTER the replacement is the live conversation, and
	// is mirrored — numbered from 0, because the parser went with the file.
	appendFile(t, path, claudeLine("assistant", "live in the new file"))
	w.pump()
	got := drain(w)
	wantTexts(t, got, "w1:p1:live in the new file")
	if got[0].Turn.Seq != 0 {
		t.Fatalf("Seq = %d, want 0 (first record this tail read from the new file)", got[0].Turn.Seq)
	}
}

// kqueue watches the open file, not the path, so a replacement leaves the watch
// on a dead inode. The Remove/Rename event that would say so is exactly what
// this design assumes goes missing on macOS (see DefaultPollInterval), so the
// replacement itself has to re-arm the watch — otherwise the pane silently
// degrades to the 2s poll for the rest of the process's life.
func TestReplacementReArmsTheWatchWithoutAnEvent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, "")

	r := newResolver()
	r.set("w1:p1", path, "claude")
	fake := newFakeNotifier()
	w, _ := newTestWatcher(t, r)
	w.attachNotifier(fake)
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	if got := waitPath(t, fake.added, "added"); got != path {
		t.Fatalf("watched %q, want %q", got, path)
	}

	tmp := filepath.Join(dir, "s.jsonl.tmp")
	writeFile(t, tmp, claudeLine("assistant", "replacement"))
	if err := os.Rename(tmp, path); err != nil {
		t.Fatalf("rename: %v", err)
	}
	// No event delivered: the pass must notice the swap by itself.
	w.pump()

	if got := waitPath(t, fake.removed, "removed"); got != path {
		t.Fatalf("dropped the watch on %q, want %q", got, path)
	}
	if got := waitPath(t, fake.added, "re-added after the replacement"); got != path {
		t.Fatalf("re-watched %q, want %q", got, path)
	}
	if !w.watched[path] {
		t.Fatal("path not marked as watched after the replacement")
	}
}

// Truncation: offset past end of file means the bytes we read are gone.
func TestTruncationResetsToZero(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, "")

	r := newResolver()
	r.set("w1:p1", path, "claude")
	w, _ := newTestWatcher(t, r)
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	appendFile(t, path, claudeLine("assistant", "long line one")+claudeLine("assistant", "long line two"))
	w.pump()
	wantTexts(t, drain(w), "w1:p1:long line one", "w1:p1:long line two")

	// Truncate in place, keeping the same inode, and write something shorter.
	f, err := os.OpenFile(path, os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open for truncate: %v", err)
	}
	if err := f.Truncate(0); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if _, err := f.WriteAt([]byte(claudeLine("assistant", "short")), 0); err != nil {
		t.Fatalf("write after truncate: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	w.pump()
	got := drain(w)
	wantTexts(t, got, "w1:p1:short")
	if got[0].Turn.Seq != 0 {
		t.Fatalf("Seq = %d, want 0 after truncation", got[0].Turn.Seq)
	}
	if off := w.tails["w1:p1"].off; off != int64(len(claudeLine("assistant", "short"))) {
		t.Fatalf("offset = %d, want the length of the truncated file", off)
	}
}

// ---------- resolution ----------

// G8: an agent can be detected long before it has a session ref (for claude the
// gap lasts until the trust prompt is accepted). Enable must survive that, and
// pick the file up when it appears.
func TestPendingResolutionIsPickedUpLater(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")

	r := newResolver()
	r.unset("w1:p1")
	w, log := newTestWatcher(t, r)
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable with no session ref yet: %v", err)
	}
	if !w.Enabled("w1:p1") {
		t.Fatal("pane not armed while its transcript is unresolvable")
	}
	w.pump()
	if got := drain(w); len(got) != 0 {
		t.Fatalf("unresolvable pane produced %q", texts(got))
	}
	if !strings.Contains(log.String(), "not resolvable yet") {
		t.Fatalf("no debug line for the pending state; log:\n%s", log.String())
	}

	// SessionStart fires and the ref appears, but the agent has not written the
	// file yet. Nothing that ever lands in it can predate Enable, so all of it is
	// mirrored — the no-back-fill rule costs nothing in the case it was aimed at.
	r.set("w1:p1", path, "claude")
	w.pump()
	writeFile(t, path, claudeLine("user", "first thing typed")+claudeLine("assistant", "answer"))
	w.pump()
	wantTexts(t, drain(w), "w1:p1:first thing typed", "w1:p1:answer")
}

// The same gap, but the file already exists when the ref appears — the bridge
// restarting next to a week-old session, for instance. Its contents predate the
// mirror and stay out of the chat.
func TestFirstResolutionDoesNotReplayAnExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, claudeLine("user", "old")+claudeLine("assistant", "older"))

	r := newResolver()
	r.unset("w1:p1")
	w, _ := newTestWatcher(t, r)
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	w.pump()

	r.set("w1:p1", path, "claude")
	w.pump()
	if got := drain(w); len(got) != 0 {
		t.Fatalf("late resolution replayed %q", texts(got))
	}

	appendFile(t, path, claudeLine("assistant", "new"))
	w.pump()
	wantTexts(t, drain(w), "w1:p1:new")
}

// A resolution that fails after we already have a file means the registry is
// degraded (G10), not that the agent lost its transcript. Losing our place over
// a herdr hiccup would re-read or skip depending on timing.
func TestTransientResolveFailureKeepsTailing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, "")

	r := newResolver()
	r.set("w1:p1", path, "claude")
	w, _ := newTestWatcher(t, r)
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	appendFile(t, path, claudeLine("assistant", "before the outage"))
	w.pump()
	wantTexts(t, drain(w), "w1:p1:before the outage")

	r.unset("w1:p1")
	appendFile(t, path, claudeLine("assistant", "during the outage"))
	w.pump()
	wantTexts(t, drain(w), "w1:p1:during the outage")
}

// An agent kind with no parser must not take the tail loop down, and must say
// so: "mirroring is on but shows nothing" is otherwise indistinguishable from a
// quiet agent.
func TestUnknownKindIsInertAndLoud(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, "")

	r := newResolver()
	r.set("w1:p1", path, "gemini")
	w, log := newTestWatcher(t, r)
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	appendFile(t, path, claudeLine("assistant", "unreadable"))
	w.pump()
	if got := drain(w); len(got) != 0 {
		t.Fatalf("turns from an unparseable kind: %q", texts(got))
	}
	if !strings.Contains(log.String(), "no transcript parser") {
		t.Fatalf("no warning for the unknown kind; log:\n%s", log.String())
	}

	// And it recovers if the pane turns out to be a kind we can read.
	r.set("w1:p1", path, "claude")
	w.pump()
	appendFile(t, path, claudeLine("assistant", "readable"))
	w.pump()
	wantTexts(t, drain(w), "w1:p1:readable")
}

// A missing file at a path that still resolves is normal: the agent has not
// created it yet.
func TestMissingFileIsNotAnError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "not-created-yet.jsonl")

	r := newResolver()
	r.set("w1:p1", path, "claude")
	w, _ := newTestWatcher(t, r)
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	w.pump()
	w.pump()

	writeFile(t, path, claudeLine("assistant", "created late"))
	w.pump()
	wantTexts(t, drain(w), "w1:p1:created late")
}

// ---------- multiple panes ----------

func TestPanesAreIndependent(t *testing.T) {
	dir := t.TempDir()
	p1 := filepath.Join(dir, "one.jsonl")
	p2 := filepath.Join(dir, "two.jsonl")
	writeFile(t, p1, "")
	writeFile(t, p2, "")

	r := newResolver()
	r.set("w1:p1", p1, "claude")
	r.set("w1:p2", p2, "claude")
	w, _ := newTestWatcher(t, r)
	for _, id := range []string{"w1:p1", "w1:p2"} {
		if err := w.Enable(id); err != nil {
			t.Fatalf("Enable(%s): %v", id, err)
		}
	}

	appendFile(t, p1, claudeLine("assistant", "from one"))
	appendFile(t, p2, claudeLine("assistant", "from two"))
	w.pump()
	got := drain(w)
	wantTexts(t, got, "w1:p1:from one", "w1:p2:from two")
	// Each pane counts its own records: a shared parser would number the second
	// pane's first turn as a continuation of the first pane's.
	for _, pt := range got {
		if pt.Turn.Seq != 0 {
			t.Fatalf("%s: Seq = %d, want 0", pt.PaneID, pt.Turn.Seq)
		}
	}
}

// ---------- watch bookkeeping ----------

// Two panes can resolve to the same transcript: the same agent seen through two
// herdr panes, or a pane id reused after a restart. Disabling one of them must
// not take the other's notifications away — the survivor would keep working on
// the poll, which looks identical to working properly until someone measures
// the latency.
func TestDisableKeepsAWatchAnotherPaneStillNeeds(t *testing.T) {
	dir := t.TempDir()
	shared := filepath.Join(dir, "shared.jsonl")
	writeFile(t, shared, "")

	r := newResolver()
	r.set("w1:p1", shared, "claude")
	r.set("w1:p2", shared, "claude")
	fake := newFakeNotifier()
	w, _ := newTestWatcher(t, r)
	w.attachNotifier(fake)
	for _, id := range []string{"w1:p1", "w1:p2"} {
		if err := w.Enable(id); err != nil {
			t.Fatalf("Enable(%s): %v", id, err)
		}
	}
	// One path, one watch, however many panes are looking at it.
	if got := waitPath(t, fake.added, "added"); got != shared {
		t.Fatalf("watched %q, want %q", got, shared)
	}
	assertNoPath(t, fake.added, "added a second watch for the same path")

	w.Disable("w1:p1")
	assertNoPath(t, fake.removed, "dropped a watch that another pane is still following")
	if !w.watched[shared] {
		t.Fatal("watch forgotten while a pane is still following the path")
	}
	// And it still works for the pane that is left.
	appendFile(t, shared, claudeLine("assistant", "for the second pane"))
	w.pump()
	wantTexts(t, drain(w), "w1:p2:for the second pane")

	w.Disable("w1:p2")
	if got := waitPath(t, fake.removed, "removed"); got != shared {
		t.Fatalf("removed %q, want %q", got, shared)
	}
	if w.watched[shared] {
		t.Fatal("watch still recorded after the last pane following it was disabled")
	}
}

func TestDisableRemovesOnlyItsOwnWatch(t *testing.T) {
	dir := t.TempDir()
	one := filepath.Join(dir, "one.jsonl")
	two := filepath.Join(dir, "two.jsonl")
	writeFile(t, one, "")
	writeFile(t, two, "")

	r := newResolver()
	r.set("w1:p1", one, "claude")
	r.set("w1:p2", two, "claude")
	fake := newFakeNotifier()
	w, _ := newTestWatcher(t, r)
	w.attachNotifier(fake)
	for _, id := range []string{"w1:p1", "w1:p2"} {
		if err := w.Enable(id); err != nil {
			t.Fatalf("Enable(%s): %v", id, err)
		}
	}
	waitPath(t, fake.added, "added")
	waitPath(t, fake.added, "added")

	w.Disable("w1:p1")
	if got := waitPath(t, fake.removed, "removed"); got != one {
		t.Fatalf("removed %q, want %q", got, one)
	}
	assertNoPath(t, fake.removed, "removed a second watch")
	if !w.watched[two] {
		t.Fatalf("watch on %q lost when the other pane was disabled", two)
	}

	appendFile(t, two, claudeLine("assistant", "still following"))
	w.pump()
	wantTexts(t, drain(w), "w1:p2:still following")
}

// ---------- back-pressure ----------

// The half of this product that answers permission dialogs must never wait on
// the half that mirrors prose.
func TestPublishDropsRatherThanBlocks(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, "")

	r := newResolver()
	r.set("w1:p1", path, "claude")
	w, _ := newTestWatcher(t, r, withTurnBuffer(1))
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	var b strings.Builder
	for i := range 20 {
		b.WriteString(claudeLine("assistant", fmt.Sprintf("turn %d", i)))
	}
	appendFile(t, path, b.String())

	done := make(chan struct{})
	go func() { defer close(done); w.pump() }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("pump blocked on a full turns channel")
	}

	if got := len(drain(w)); got != 1 {
		t.Fatalf("buffered turns = %d, want 1", got)
	}
	if w.dropped() != 19 {
		t.Fatalf("dropped = %d, want 19", w.dropped())
	}
}

// ---------- Run ----------

func TestRunOnlyOnce(t *testing.T) {
	w, _ := newTestWatcher(t, newResolver())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := w.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run err = %v, want context.Canceled", err)
	}
	if err := w.Run(context.Background()); !errors.Is(err, ErrRunOnce) {
		t.Fatalf("second Run err = %v, want ErrRunOnce", err)
	}
}

func TestRunClosesChannelAndWatches(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, "")

	r := newResolver()
	r.set("w1:p1", path, "claude")
	fake := newFakeNotifier()
	w, _ := newTestWatcher(t, r, withNotifier(func() (notifier, error) { return fake, nil }))
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- w.Run(ctx) }()

	// The watch is installed for the pane that was enabled before Run.
	if got := waitPath(t, fake.added, "added"); got != path {
		t.Fatalf("watched %q, want %q", got, path)
	}

	cancel()
	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run err = %v, want context.Canceled", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return after cancel")
	}

	if _, ok := <-w.Turns(); ok {
		t.Fatal("turns channel still open after Run returned")
	}
	if !fake.isClosed() {
		t.Fatal("file watcher not closed after Run returned")
	}
	if err := w.Enable("w1:p2"); !errors.Is(err, ErrClosed) {
		t.Fatalf("Enable after Run err = %v, want ErrClosed", err)
	}
}

// An event wakes the loop: the poll interval here is long enough that a turn
// arriving at all proves it was the event, not the tick.
func TestRunReactsToWatchEvents(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, "")

	r := newResolver()
	r.set("w1:p1", path, "claude")
	fake := newFakeNotifier()
	w, _ := newTestWatcher(t, r,
		WithPollInterval(time.Hour),
		withNotifier(func() (notifier, error) { return fake, nil }))
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.Run(ctx) //nolint:errcheck // asserted in TestRunClosesChannelAndWatches
	waitPath(t, fake.added, "added")

	appendFile(t, path, claudeLine("assistant", "woken by an event"))
	fake.events <- fsnotify.Event{Name: path, Op: fsnotify.Write}
	if got := waitTurn(t, w.Turns()); got.Turn.Text != "woken by an event" {
		t.Fatalf("turn = %q", got.Turn.Text)
	}

	// A Remove drops the backend's watch; the watcher must forget it so a later
	// pass re-installs one on whatever replaces the file.
	fake.events <- fsnotify.Event{Name: path, Op: fsnotify.Remove}
	appendFile(t, path, claudeLine("assistant", "after the remove event"))
	fake.events <- fsnotify.Event{Name: path, Op: fsnotify.Write}
	if got := waitTurn(t, w.Turns()); got.Turn.Text != "after the remove event" {
		t.Fatalf("turn = %q", got.Turn.Text)
	}
	if got := waitPath(t, fake.added, "re-added after a Remove event"); got != path {
		t.Fatalf("re-watched %q, want %q", got, path)
	}

	// Backend errors (ErrEventOverflow among them) are reported, not fatal.
	fake.errs <- errors.New("simulated backend error")
	appendFile(t, path, claudeLine("assistant", "still alive"))
	fake.events <- fsnotify.Event{Name: path, Op: fsnotify.Write}
	if got := waitTurn(t, w.Turns()); got.Turn.Text != "still alive" {
		t.Fatalf("turn = %q", got.Turn.Text)
	}
}

// The poll is the guarantee, fsnotify only the latency: with no notifier at all
// the mirror still works (G: kqueue misses events on macOS).
func TestRunPollsWhenNotificationsAreUnavailable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	writeFile(t, path, "")

	r := newResolver()
	r.set("w1:p1", path, "claude")
	w, log := newTestWatcher(t, r, WithPollInterval(5*time.Millisecond))
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.Run(ctx) //nolint:errcheck // asserted in TestRunClosesChannelAndWatches

	appendFile(t, path, claudeLine("assistant", "found by polling"))
	if got := waitTurn(t, w.Turns()); got.Turn.Text != "found by polling" {
		t.Fatalf("turn = %q", got.Turn.Text)
	}
	if !strings.Contains(log.String(), "polling only") {
		t.Fatalf("degradation not logged; log:\n%s", log.String())
	}
}

// End to end over the real backend: real files, real fsnotify, and a poll
// interval short enough that neither path can hang the test.
func TestRunWithRealFsnotify(t *testing.T) {
	if n, err := newFSNotifier(); err != nil {
		t.Skipf("no file notifications available here: %v", err)
	} else {
		n.Close()
	}

	dir := t.TempDir()
	first := filepath.Join(dir, "first.jsonl")
	second := filepath.Join(dir, "second.jsonl")
	writeFile(t, first, claudeLine("assistant", "history that must not be replayed"))

	r := newResolver()
	r.set("w1:p1", first, "claude")
	w, err := NewWatcher(r, WithPollInterval(10*time.Millisecond),
		WithLogger(slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))))
	if err != nil {
		t.Fatalf("NewWatcher: %v", err)
	}
	if err := w.Enable("w1:p1"); err != nil {
		t.Fatalf("Enable: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	go func() { runErr <- w.Run(ctx) }()

	appendFile(t, first, claudeLine("assistant", "live one"))
	if got := waitTurn(t, w.Turns()); got.Turn.Text != "live one" {
		t.Fatalf("turn = %q, want the first live append (history must not be replayed)", got.Turn.Text)
	}

	// /resume: new session id, new file, same pane. The new file opens with the
	// conversation it resumed, which must not reach the chat, so the switch is
	// let through a full pass before anything live is appended.
	writeFile(t, second, claudeLine("assistant", "replayed history"))
	r.set("w1:p1", second, "claude")
	r.awaitPass(t)
	appendFile(t, second, claudeLine("assistant", "live two"))
	if got := waitTurn(t, w.Turns()); got.Turn.Text != "live two" {
		t.Fatalf("turn = %q, want the append to the replacement file", got.Turn.Text)
	}

	cancel()
	select {
	case err := <-runErr:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run err = %v, want context.Canceled", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
}
