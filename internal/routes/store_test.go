package routes

import (
	"container/list"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Open must keep exactly the signature contract.go pins down.
var _ func(string) (Store, error) = Open

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 8, 14, 1, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// rawLen counts entries still physically in the list, expired ones included.
// Len and Lookup both filter at read time, so assertions that must pin down
// what load() or eviction actually kept have to look here instead.
func rawLen(s *FileStore) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.order.Len()
}

func openTest(t *testing.T, path string, opts ...Option) *FileStore {
	t.Helper()
	s, err := OpenWith(path, opts...)
	if err != nil {
		t.Fatalf("OpenWith(%q): %v", path, err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func mustLookup(t *testing.T, s Store, msgID, wantPane string) {
	t.Helper()
	pane, ok := s.Lookup(msgID)
	if !ok {
		t.Fatalf("Lookup(%q): ok=false, want pane %q", msgID, wantPane)
	}
	if pane != wantPane {
		t.Fatalf("Lookup(%q) = %q, want %q", msgID, pane, wantPane)
	}
}

func mustMiss(t *testing.T, s Store, msgID string) {
	t.Helper()
	if pane, ok := s.Lookup(msgID); ok {
		t.Fatalf("Lookup(%q) = %q, true; want miss", msgID, pane)
	}
}

func TestBindLookup(t *testing.T) {
	tests := []struct {
		name     string
		binds    [][2]string // messageID, paneID
		lookup   string
		wantPane string
		wantOK   bool
		wantLen  int // entries actually stored, checked for every case
	}{
		{
			name:     "bound message resolves",
			binds:    [][2]string{{"om_1", "w1:p1"}},
			lookup:   "om_1",
			wantPane: "w1:p1",
			wantOK:   true,
			wantLen:  1,
		},
		{
			name:    "unknown message misses",
			binds:   [][2]string{{"om_1", "w1:p1"}},
			lookup:  "om_nope",
			wantLen: 1,
		},
		{
			// The whole point of reply-to-route: one chat, several agents,
			// no /use switch command (S2 3.5).
			name:     "second agent keeps its own route",
			binds:    [][2]string{{"om_1", "w1:p1"}, {"om_2", "w2:p3"}},
			lookup:   "om_2",
			wantPane: "w2:p3",
			wantOK:   true,
			wantLen:  2,
		},
		{
			name:     "rebinding overwrites the pane",
			binds:    [][2]string{{"om_1", "w1:p1"}, {"om_1", "w9:p9"}},
			lookup:   "om_1",
			wantPane: "w9:p9",
			wantOK:   true,
			wantLen:  1,
		},
		{
			// A blank pane would make Lookup report success for a target no
			// herdr call can address; the caller must fall through instead.
			name:    "empty pane is not bound",
			binds:   [][2]string{{"om_1", ""}},
			lookup:  "om_1",
			wantLen: 0,
		},
		{
			// Lookup("") refuses on its own, so only the stored count can show
			// that Bind rejected this: a blank key would otherwise collapse
			// every such binding onto one entry, invisibly.
			name:    "empty message id is not bound",
			binds:   [][2]string{{"", "w1:p1"}, {"", "w2:p2"}},
			lookup:  "",
			wantLen: 0,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := openTest(t, filepath.Join(t.TempDir(), "routes.json"), WithClock(newClock().Now))
			for _, b := range tc.binds {
				s.Bind(b[0], b[1])
			}
			pane, ok := s.Lookup(tc.lookup)
			if ok != tc.wantOK || pane != tc.wantPane {
				t.Fatalf("Lookup(%q) = (%q, %v), want (%q, %v)", tc.lookup, pane, ok, tc.wantPane, tc.wantOK)
			}
			if got := rawLen(s); got != tc.wantLen {
				t.Fatalf("stored entries = %d, want %d", got, tc.wantLen)
			}
		})
	}
}

// G17: Feishu messages never expire. A reply to a week-old message must not
// steer a pane that is now running something else, and the check has to happen
// at read time — nothing else touches a binding between Bind and Lookup.
func TestLookupExpiresAtReadTime(t *testing.T) {
	tests := []struct {
		name    string
		advance time.Duration
		wantOK  bool
	}{
		{"fresh", 0, true},
		{"one day in", 24 * time.Hour, true},
		{"one second before TTL", TTL - time.Second, true},
		{"exactly at TTL", TTL, false},
		{"long past TTL", TTL + 72*time.Hour, false},
		// A binding dated in the future must fail closed, not stay routable
		// until the clock catches up: that is how a wrong-clock-at-boot entry
		// escapes the 7-day window entirely (G17).
		{"clock rewound behind boundAt", -time.Second, false},
		{"boundAt far in the future", -100 * 365 * 24 * time.Hour, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clk := newClock()
			s := openTest(t, filepath.Join(t.TempDir(), "routes.json"), WithClock(clk.Now))
			s.Bind("om_1", "w1:p1")

			clk.Advance(tc.advance)

			// No reopen, no flush, no overflow: only Lookup can notice.
			pane, ok := s.Lookup("om_1")
			if ok != tc.wantOK {
				t.Fatalf("after %v Lookup = (%q, %v), want ok=%v", tc.advance, pane, ok, tc.wantOK)
			}
			if got := s.Len(); (got == 1) != tc.wantOK {
				t.Fatalf("after %v Len = %d, want live=%v", tc.advance, got, tc.wantOK)
			}
		})
	}
}

// Rebinding is a fresh binding, so the 7-day window restarts from it. The
// bridge rebinds when it sends another message about the same agent; if that
// only reordered the eviction list, the route would still die 7 days after the
// FIRST message and a reply to a freshly updated card would stop resolving.
func TestRebindRestartsTTL(t *testing.T) {
	clk := newClock()
	s := openTest(t, filepath.Join(t.TempDir(), "routes.json"), WithClock(clk.Now))

	s.Bind("om_1", "w1:p1")
	clk.Advance(TTL - time.Hour)
	s.Bind("om_1", "w1:p1")

	// Two hours later: past the TTL of the original bind, well inside the new one.
	clk.Advance(2 * time.Hour)
	mustLookup(t, s, "om_1", "w1:p1")

	clk.Advance(TTL)
	mustMiss(t, s, "om_1")
}

// Eviction is by binding age, oldest first — and a Lookup must not refresh it.
func TestEvictionDropsOldestBinding(t *testing.T) {
	clk := newClock()
	s := openTest(t, filepath.Join(t.TempDir(), "routes.json"),
		WithClock(clk.Now), WithMaxEntries(3), WithAutoFlush(false))

	for _, id := range []string{"om_1", "om_2", "om_3"} {
		s.Bind(id, "pane-"+id)
		clk.Advance(time.Second)
	}

	// Reading the oldest binding must not rescue it: recency of use says
	// nothing about which route is still worth keeping.
	mustLookup(t, s, "om_1", "pane-om_1")

	s.Bind("om_4", "pane-om_4")

	mustMiss(t, s, "om_1")
	for _, id := range []string{"om_2", "om_3", "om_4"} {
		mustLookup(t, s, id, "pane-"+id)
	}
	if got := s.Len(); got != 3 {
		t.Fatalf("Len = %d, want 3", got)
	}

	// Rebinding an existing id restarts its age, so it survives the next
	// overflow while the entry bound after it does not.
	clk.Advance(time.Second)
	s.Bind("om_2", "pane-om_2b")
	clk.Advance(time.Second)
	s.Bind("om_5", "pane-om_5")

	mustMiss(t, s, "om_3")
	mustLookup(t, s, "om_2", "pane-om_2b")
	mustLookup(t, s, "om_4", "pane-om_4")
	mustLookup(t, s, "om_5", "pane-om_5")
}

// A dead binding is worth less than a live one, so capacity pressure must take
// the expired entries first even when they are not the oldest by insertion.
//
// That only diverges from plain oldest-first when the wall clock goes backwards
// — a VM snapshot restore or an RTC that boots wrong — because a bind made
// afterwards then carries an EARLIER boundAt than one made before it. With a
// monotonic clock the list is already sorted by boundAt and the two rules agree.
func TestEvictionPrefersExpiredOverLive(t *testing.T) {
	clk := newClock()
	s := openTest(t, filepath.Join(t.TempDir(), "routes.json"),
		WithClock(clk.Now), WithMaxEntries(2), WithAutoFlush(false))

	// Bound first, so it sits at the back of the list where oldest-first looks.
	s.Bind("om_live", "w1:p1")

	clk.Advance(-(TTL + time.Hour)) // clock jumps backwards
	s.Bind("om_stale", "w2:p2")     // newer in list position, older by boundAt

	clk.Advance(TTL + 2*time.Hour) // clock corrected: om_stale is now expired
	s.Bind("om_new", "w3:p3")      // overflow

	if got := rawLen(s); got != 2 {
		t.Fatalf("stored entries = %d, want 2", got)
	}
	// The load-bearing assertion: a plain removeLocked(Back()) would have taken
	// om_live, the only one of the three that is still somebody's reply target.
	mustLookup(t, s, "om_live", "w1:p1")
	mustLookup(t, s, "om_new", "w3:p3")
	mustMiss(t, s, "om_stale")
}

func TestPersistAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "routes.json")
	clk := newClock()

	s1 := openTest(t, path, WithClock(clk.Now))
	s1.Bind("om_1", "w1:p1")
	s1.Bind("om_2", "w2:p2")
	if err := s1.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if err := s1.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	// Literal, not fileMode: S2 3.1 fixes 0600 for the state dir, and this
	// file says which agent every message the bridge sent was about.
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("mode = %#o, want 0600", got)
	}

	clk.Advance(time.Hour)
	s2 := openTest(t, path, WithClock(clk.Now))
	if err := s2.LoadWarning(); err != nil {
		t.Fatalf("LoadWarning after clean reopen: %v", err)
	}
	mustLookup(t, s2, "om_1", "w1:p1")
	mustLookup(t, s2, "om_2", "w2:p2")

	// boundAt survives the round trip, so the TTL keeps running across a
	// restart instead of resetting.
	clk.Advance(TTL - time.Hour)
	mustMiss(t, s2, "om_1")
}

// The bridge is killed, not shut down, more often than we would like: a Bind
// must be on disk before the process that made it goes away.
func TestBindIsDurableWithoutExplicitFlush(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	clk := newClock()

	s1 := openTest(t, path, WithClock(clk.Now))
	s1.Bind("om_1", "w1:p1")
	if err := s1.LastError(); err != nil {
		t.Fatalf("LastError after Bind: %v", err)
	}

	// No Flush, no Close: reopen the file exactly as it is on disk right now.
	s2 := openTest(t, path, WithClock(clk.Now))
	mustLookup(t, s2, "om_1", "w1:p1")
}

func TestExpiredBindingsAreNotReloaded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	clk := newClock()

	s1 := openTest(t, path, WithClock(clk.Now))
	s1.Bind("om_stale", "w1:p1")
	s1.Bind("om_fresh", "w2:p2")
	if err := s1.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	clk.Advance(TTL + time.Minute)
	s2 := openTest(t, path, WithClock(clk.Now))
	mustMiss(t, s2, "om_stale")
	mustMiss(t, s2, "om_fresh")

	// Lookup and Len both filter expired entries on their own, so only the raw
	// list shows that load() dropped them instead of carrying them in memory
	// until something else happened to notice.
	if got := rawLen(s2); got != 0 {
		t.Fatalf("stored entries after reload = %d, want 0", got)
	}
}

// load() is exercised directly here: OpenWith's write probe purges expired
// entries a moment after load returns, so nothing observable through OpenWith
// can tell whether load kept them. This is the filter that stops a week-old
// routes.json from ever being held in memory (G17).
func TestLoadDropsExpiredEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	clk := newClock() // 2026-08-14T01:00:00Z
	body := `{"version":1,"entries":[` +
		`{"m":"om_stale","p":"w1:p1","t":"2026-08-06T00:00:00Z"},` + // 8 days old
		`{"m":"om_fresh","p":"w2:p2","t":"2026-08-13T01:00:00Z"}]}` // 1 day old
	if err := os.WriteFile(path, []byte(body), fileMode); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	s := &FileStore{
		path:       path,
		now:        clk.Now,
		maxEntries: MaxEntries,
		order:      list.New(),
		index:      make(map[string]*list.Element),
	}
	if err := s.load(); err != nil {
		t.Fatalf("load: %v", err)
	}

	if got := rawLen(s); got != 1 {
		t.Fatalf("stored entries after load = %d, want 1 (expired one must not be kept)", got)
	}
	mustLookup(t, s, "om_fresh", "w2:p2")
}

// Duplicate ids can reach load from a file written by an older build or a
// half-merged edit. The later one must win and leave exactly one entry, or the
// index and the list disagree and an eviction leaks an unreachable element.
func TestLoadDeduplicatesMessageIDs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	// Both timestamps are behind newClock's now and inside the TTL.
	body := `{"version":1,"entries":[` +
		`{"m":"om_1","p":"w1:p1","t":"2026-08-13T01:00:00Z"},` +
		`{"m":"om_1","p":"w9:p9","t":"2026-08-13T02:00:00Z"}]}`
	if err := os.WriteFile(path, []byte(body), fileMode); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	s := openTest(t, path, WithClock(newClock().Now))
	if got := rawLen(s); got != 1 {
		t.Fatalf("stored entries = %d, want 1", got)
	}
	mustLookup(t, s, "om_1", "w9:p9")
}

// A mangled routes.json must cost the bridge its routes, not its boot.
func TestCorruptFileStartsEmpty(t *testing.T) {
	valid := func(t *testing.T) []byte {
		t.Helper()
		b, err := json.Marshal(fileFormat{
			Version: fileVersion,
			Entries: []*entry{{MessageID: "om_1", PaneID: "w1:p1", BoundAt: newClock().Now()}},
		})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		return b
	}

	tests := []struct {
		name     string
		content  func(t *testing.T) []byte
		wantWarn bool
		wantLen  int
	}{
		{"garbage", func(*testing.T) []byte { return []byte("not json at all") }, true, 0},
		{"truncated", func(t *testing.T) []byte { return valid(t)[:len(valid(t))/2] }, true, 0},
		{"empty file", func(*testing.T) []byte { return nil }, true, 0},
		{"future version", func(*testing.T) []byte {
			return []byte(`{"version":99,"entries":[{"m":"om_1","p":"w1:p1","t":"2026-08-14T01:00:00Z"}]}`)
		}, true, 0},
		{"null entry", func(*testing.T) []byte {
			return []byte(`{"version":1,"entries":[null,{"m":"om_1","p":"w1:p1","t":"2026-08-14T01:00:00Z"}]}`)
		}, false, 1},
		{"entry missing pane", func(*testing.T) []byte {
			return []byte(`{"version":1,"entries":[{"m":"om_2","p":"","t":"2026-08-14T01:00:00Z"}]}`)
		}, false, 0},
		{"entry missing message id", func(*testing.T) []byte {
			return []byte(`{"version":1,"entries":[{"m":"","p":"w1:p1","t":"2026-08-14T01:00:00Z"}]}`)
		}, false, 0},
		{
			// Written by a Mac whose clock was wrong at boot. It must not
			// outlive the 7-day window once the clock is corrected (G17).
			"entry dated in the future", func(*testing.T) []byte {
				return []byte(`{"version":1,"entries":[{"m":"om_3","p":"w1:p1","t":"2099-01-01T00:00:00Z"}]}`)
			}, false, 0,
		},
		{"intact", valid, false, 1},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "routes.json")
			if err := os.WriteFile(path, tc.content(t), fileMode); err != nil {
				t.Fatalf("seed file: %v", err)
			}

			clk := newClock()
			s, err := OpenWith(path, WithClock(clk.Now))
			if err != nil {
				t.Fatalf("OpenWith must not fail on a bad file: %v", err)
			}
			t.Cleanup(func() { _ = s.Close() })

			if gotWarn := s.LoadWarning() != nil; gotWarn != tc.wantWarn {
				t.Fatalf("LoadWarning = %v, want warning=%v", s.LoadWarning(), tc.wantWarn)
			}
			if got := s.Len(); got != tc.wantLen {
				t.Fatalf("Len = %d, want %d", got, tc.wantLen)
			}
			// Raw too: a rejected entry must be absent from the list, not
			// merely filtered out of every read.
			if got := rawLen(s); got != tc.wantLen {
				t.Fatalf("stored entries = %d, want %d", got, tc.wantLen)
			}

			// The store must recover: a fresh bind is persisted over the bad
			// file and survives the next reopen.
			s.Bind("om_new", "w7:p7")
			s2 := openTest(t, path, WithClock(clk.Now))
			if err := s2.LoadWarning(); err != nil {
				t.Fatalf("LoadWarning after repair: %v", err)
			}
			mustLookup(t, s2, "om_new", "w7:p7")
		})
	}
}

func TestFlushAfterCloseFails(t *testing.T) {
	s := openTest(t, filepath.Join(t.TempDir(), "routes.json"), WithClock(newClock().Now))
	s.Bind("om_1", "w1:p1")
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("second Close must be a no-op, got %v", err)
	}
	if err := s.Flush(); err == nil {
		t.Fatal("Flush after Close: want error, got nil")
	}
}

// Bind cannot return an error, so a bind that lands after Close would otherwise
// be lost in complete silence — and Flush reports that same state as an error,
// so the two paths must not disagree about whether the store is still durable.
func TestBindAfterCloseIsReported(t *testing.T) {
	path := filepath.Join(t.TempDir(), "routes.json")
	clk := newClock()
	s := openTest(t, path, WithClock(clk.Now))
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	s.Bind("om_1", "w1:p1")
	err := s.LastError()
	if err == nil {
		t.Fatal("LastError after Bind following Close: want error, got nil")
	}
	if !errors.Is(err, ErrClosed) {
		t.Fatalf("LastError = %v, want it to wrap ErrClosed", err)
	}

	// And the report is true: the binding really did not reach disk.
	s2 := openTest(t, path, WithClock(clk.Now))
	mustMiss(t, s2, "om_1")
}

// An existing but non-writable state dir gets past MkdirAll, and load() reads
// the missing file as a first run, so Open used to report a perfectly healthy
// store that dropped every route on each restart. Fail at boot instead.
func TestOpenFailsOnUnwritableStateDir(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0o500); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	if _, err := Open(filepath.Join(dir, "routes.json")); err == nil {
		t.Fatal("Open on a non-writable state dir: want error, got nil")
	}
}

func TestOpenRejectsEmptyPath(t *testing.T) {
	if _, err := Open(""); err == nil {
		t.Fatal("Open(\"\"): want error, got nil")
	}
}

func TestOpenCreatesStateDir(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "state", "routes.json")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	s.Bind("om_1", "w1:p1")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("stat after Bind: %v", err)
	}
}

// tmp + rename must not litter the state dir, and a reader must never observe
// a partial file under the real name.
func TestAtomicWriteLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "routes.json")

	// Left by a process killed between CreateTemp and Rename. With
	// write-through on there is one such window per outbound message, and the
	// bridge is killed and restarted routinely (S2 3.1), so if Open does not
	// reclaim these the state dir fills with hidden junk forever.
	stale := filepath.Join(dir, ".routes.json.tmp-1234567890")
	if err := os.WriteFile(stale, []byte("half a file"), fileMode); err != nil {
		t.Fatalf("seed stale temp: %v", err)
	}

	s := openTest(t, path, WithClock(newClock().Now))
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale temp file survived Open: stat err = %v", err)
	}
	for i := range 20 {
		s.Bind("om_"+strconv.Itoa(i), "w1:p1")
	}
	if err := s.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	names, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, n := range names {
		if strings.Contains(n.Name(), ".tmp-") {
			t.Fatalf("temp file left behind: %s", n.Name())
		}
	}
	if len(names) != 1 {
		t.Fatalf("state dir has %d files, want 1", len(names))
	}
}

// Every entry point is reachable from the Feishu event loop and the notifier
// at the same time. Run under -race.
func TestConcurrentAccess(t *testing.T) {
	clk := newClock()
	s := openTest(t, filepath.Join(t.TempDir(), "routes.json"),
		WithClock(clk.Now), WithMaxEntries(64))

	// Write-through is left on so the persist path is in the race too; the
	// counts are kept modest because every Bind is a real fsync.
	const workers = 8
	const iterations = 20

	var wg sync.WaitGroup
	for w := range workers {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := range iterations {
				id := "om_" + strconv.Itoa(w) + "_" + strconv.Itoa(i)
				s.Bind(id, "w"+strconv.Itoa(w)+":p1")
				s.Lookup(id)
				s.Lookup("om_absent")
				if i%10 == 0 {
					_ = s.Flush()
					_ = s.Len()
					_ = s.LastError()
					clk.Advance(time.Second)
				}
			}
		}(w)
	}
	wg.Wait()

	if got := s.Len(); got > 64 {
		t.Fatalf("Len = %d, want <= 64", got)
	}
	if err := s.LastError(); err != nil {
		t.Fatalf("LastError: %v", err)
	}
}

func TestDefaultBoundsMatchContract(t *testing.T) {
	if TTL != 7*24*time.Hour {
		t.Fatalf("TTL = %v, want 168h", TTL)
	}
	s := openTest(t, filepath.Join(t.TempDir(), "routes.json"), WithClock(newClock().Now))
	if s.maxEntries != MaxEntries {
		t.Fatalf("maxEntries = %d, want %d", s.maxEntries, MaxEntries)
	}
	if !s.autoFlush {
		t.Fatal("autoFlush must default to on")
	}
}
