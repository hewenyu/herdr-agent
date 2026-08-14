package dedup

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeClock is the injected time source: TTL boundaries are crossed by moving
// it, never by sleeping.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 8, 13, 23, 16, 17, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func openStore(t *testing.T, path string, opts ...Option) *FileStore {
	t.Helper()
	s, err := Open(path, opts...)
	if err != nil {
		t.Fatalf("Open(%s): %v", path, err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// TestReadTimeTTLPerNamespace locks down two things at once: the TTL is
// evaluated in SeenOrMark (not only when the LRU overflows), and each namespace
// gets its own window — MessageTTL for msg, CardTTL for card.
func TestReadTimeTTLPerNamespace(t *testing.T) {
	tests := []struct {
		name    string
		ns      string
		advance time.Duration
		want    bool
	}{
		{"message just before its ttl", NSMessage, MessageTTL - time.Second, true},
		{"message exactly at its ttl", NSMessage, MessageTTL, false},
		{"message long after", NSMessage, 48 * time.Hour, false},
		{"card well inside its window", NSCard, 14 * time.Minute, true},
		{"card exactly at its ttl", NSCard, CardTTL, false},
		// The card window is much shorter than the message one: a card id that
		// would still be a duplicate under MessageTTL must not be.
		{"card after the message ttl would still hold", NSCard, CardTTL + time.Second, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clk := newClock()
			s := openStore(t, filepath.Join(t.TempDir(), "dedup.json"), WithClock(clk.Now))

			if seen := s.SeenOrMark(tt.ns, "0bd206ca"); seen {
				t.Fatal("first sight reported as seen")
			}
			clk.Advance(tt.advance)
			if got := s.SeenOrMark(tt.ns, "0bd206ca"); got != tt.want {
				t.Fatalf("after %s: seen = %v, want %v", tt.advance, got, tt.want)
			}
		})
	}
}

// An expired key must be re-marked with a fresh window, not just reported unseen.
func TestExpiredKeyIsRemarked(t *testing.T) {
	clk := newClock()
	s := openStore(t, filepath.Join(t.TempDir(), "dedup.json"), WithClock(clk.Now))

	s.SeenOrMark(NSCard, "e1")
	clk.Advance(CardTTL)
	if s.SeenOrMark(NSCard, "e1") {
		t.Fatal("expired key reported as seen")
	}
	if !s.SeenOrMark(NSCard, "e1") {
		t.Fatal("re-marked key not remembered")
	}
	clk.Advance(CardTTL)
	if s.SeenOrMark(NSCard, "e1") {
		t.Fatal("second window did not expire either")
	}
}

// A duplicate hit must not slide the expiry forward, otherwise a redelivery
// loop could pin a key in the store indefinitely.
func TestHitDoesNotExtendExpiry(t *testing.T) {
	clk := newClock()
	s := openStore(t, filepath.Join(t.TempDir(), "dedup.json"), WithClock(clk.Now))

	s.SeenOrMark(NSCard, "e1")
	clk.Advance(10 * time.Minute)
	if !s.SeenOrMark(NSCard, "e1") {
		t.Fatal("key expired early")
	}
	clk.Advance(6 * time.Minute) // 16min total, past CardTTL measured from first sight
	if s.SeenOrMark(NSCard, "e1") {
		t.Fatal("expiry was extended by the duplicate hit")
	}
}

func TestNamespacesDoNotCollide(t *testing.T) {
	clk := newClock()
	s := openStore(t, filepath.Join(t.TempDir(), "dedup.json"), WithClock(clk.Now))

	const id = "0bd206ca"
	if s.SeenOrMark(NSMessage, id) {
		t.Fatal("msg first sight reported as seen")
	}
	if s.SeenOrMark(NSCard, id) {
		t.Fatal("same id in the card namespace reported as seen")
	}

	// Card window closes; the message one must be untouched.
	clk.Advance(CardTTL)
	if s.SeenOrMark(NSCard, id) {
		t.Fatal("card entry survived its own ttl")
	}
	if !s.SeenOrMark(NSMessage, id) {
		t.Fatal("message entry died with the card entry")
	}
}

// G14: a handler that failed must let Feishu's ~5-minute, byte-identical
// redelivery through.
func TestUnmarkGivesRedeliveryASecondChance(t *testing.T) {
	const redelivery = 5 * time.Minute

	tests := []struct {
		name     string
		unmark   bool
		wantSeen bool
	}{
		{"handler succeeded: redelivery suppressed", false, true},
		{"handler failed and unmarked: redelivery processed", true, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clk := newClock()
			s := openStore(t, filepath.Join(t.TempDir(), "dedup.json"), WithClock(clk.Now))

			s.SeenOrMark(NSMessage, "om_x100b68e9b40a2ca")
			if tt.unmark {
				s.Unmark(NSMessage, "om_x100b68e9b40a2ca")
			}
			clk.Advance(redelivery)
			if got := s.SeenOrMark(NSMessage, "om_x100b68e9b40a2ca"); got != tt.wantSeen {
				t.Fatalf("seen = %v, want %v", got, tt.wantSeen)
			}
		})
	}
}

func TestUnmarkIsScopedToItsNamespace(t *testing.T) {
	s := openStore(t, filepath.Join(t.TempDir(), "dedup.json"))

	s.SeenOrMark(NSMessage, "e1")
	s.SeenOrMark(NSCard, "e1")
	s.Unmark(NSCard, "e1")

	if !s.SeenOrMark(NSMessage, "e1") {
		t.Fatal("unmarking card:e1 also removed msg:e1")
	}
	if s.SeenOrMark(NSCard, "e1") {
		t.Fatal("card:e1 was not removed")
	}
	s.Unmark(NSMessage, "nonexistent") // must not panic
}

// The bridge restarts exactly when redelivery is most likely, so marks must
// outlive the process.
func TestPersistenceSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dedup.json")
	clk := newClock()

	first, err := Open(path, WithClock(clk.Now))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	first.SeenOrMark(NSMessage, "kept")
	first.SeenOrMark(NSCard, "card-kept")
	first.SeenOrMark(NSMessage, "failed-handler")
	first.Unmark(NSMessage, "failed-handler")
	first.SeenOrMark(NSCard, "expires")
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := info.Mode().Perm(); got != fileMode {
		t.Fatalf("file mode = %v, want %v", got, fileMode)
	}

	clk.Advance(CardTTL + time.Minute)

	second := openStore(t, path, WithClock(clk.Now))
	if warn := second.LoadWarning(); warn != nil {
		t.Fatalf("LoadWarning after clean restart: %v", warn)
	}

	tests := []struct {
		ns, key string
		want    bool
	}{
		{NSMessage, "kept", true},
		{NSCard, "card-kept", false},         // its 15min window closed while down
		{NSMessage, "failed-handler", false}, // unmark must persist too
		{NSCard, "expires", false},
	}
	for _, tt := range tests {
		if got := second.SeenOrMark(tt.ns, tt.key); got != tt.want {
			t.Errorf("after restart SeenOrMark(%q,%q) = %v, want %v", tt.ns, tt.key, got, tt.want)
		}
	}
}

// Expired entries must not be carried across a restart either.
func TestExpiredEntriesDroppedAtLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dedup.json")
	clk := newClock()

	first, err := Open(path, WithClock(clk.Now))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	first.SeenOrMark(NSCard, "old")
	first.SeenOrMark(NSMessage, "young")
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	clk.Advance(CardTTL + time.Second)
	second := openStore(t, path, WithClock(clk.Now))
	if got := second.Len(); got != 1 {
		t.Fatalf("entries after load = %d, want 1", got)
	}
}

// Len reports what is still suppressing something. A key whose window closed
// is not purged until it is read again, the store overflows, or it is written
// out, so Len has to exclude it itself — otherwise /doctor reports a count of
// events that would all be processed again.
func TestLenExcludesExpiredEntries(t *testing.T) {
	clk := newClock()
	s := openStore(t, filepath.Join(t.TempDir(), "dedup.json"),
		WithClock(clk.Now), WithAutoFlush(false))

	s.SeenOrMark(NSCard, "e1")
	s.SeenOrMark(NSMessage, "e2")
	if got := s.Len(); got != 2 {
		t.Fatalf("entries = %d, want 2", got)
	}

	// Nothing touches card:e1 after this, so nothing purges it either.
	clk.Advance(CardTTL)
	if got := s.Len(); got != 1 {
		t.Fatalf("entries after the card window closed = %d, want 1", got)
	}

	clk.Advance(MessageTTL)
	if got := s.Len(); got != 0 {
		t.Fatalf("entries after both windows closed = %d, want 0", got)
	}
}

// Dead entries must not be written out: below capacity nothing else reclaims
// them, so with write-through on every event would re-encode and re-fsync a
// file larger than the live set.
func TestPersistDropsExpiredEntries(t *testing.T) {
	clk := newClock()
	path := filepath.Join(t.TempDir(), "dedup.json")
	// Auto-flush off and well below MaxEntries: neither the overflow purge nor
	// a write-through can do the work under test.
	s := openStore(t, path, WithClock(clk.Now), WithAutoFlush(false))

	s.SeenOrMark(NSCard, "dead")
	clk.Advance(CardTTL + time.Second)
	s.SeenOrMark(NSMessage, "live")

	if err := s.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var f fileFormat
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("unmarshal %s: %v", data, err)
	}
	if len(f.Entries) != 1 || f.Entries[0].Key != "msg:live" {
		t.Fatalf("persisted entries = %+v, want only msg:live", f.Entries)
	}
	// Reclaimed in memory too, not merely skipped while encoding.
	if contains(t, s, NSCard, "dead") {
		t.Error("expired entry still held after a write-through")
	}
}

// A mangled cache file must never stop the bridge from booting.
func TestCorruptFileIsNotFatal(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		wantWarn bool
	}{
		{"garbage", "not json at all", true},
		{"truncated", `{"version":1,"entries":[{"k":"msg:a","exp":"2026-08`, true},
		{"empty file", "", true},
		{"json null", "null", true}, // decodes, but version 0 is not ours
		{"future version", `{"version":99,"entries":[]}`, true},
		{"entries not an array", `{"version":1,"entries":{}}`, true},
		{"valid but empty", `{"version":1,"entries":[]}`, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "dedup.json")
			if err := os.WriteFile(path, []byte(tt.content), fileMode); err != nil {
				t.Fatalf("seed: %v", err)
			}

			s, err := Open(path)
			if err != nil {
				t.Fatalf("Open must not fail on a bad file: %v", err)
			}
			t.Cleanup(func() { _ = s.Close() })

			if gotWarn := s.LoadWarning() != nil; gotWarn != tt.wantWarn {
				t.Fatalf("LoadWarning() != nil = %v (%v), want %v", gotWarn, s.LoadWarning(), tt.wantWarn)
			}
			if got := s.Len(); got != 0 {
				t.Fatalf("entries = %d, want 0", got)
			}
			// Still fully usable afterwards.
			if s.SeenOrMark(NSMessage, "e1") {
				t.Fatal("fresh store reported a key as seen")
			}
			if !s.SeenOrMark(NSMessage, "e1") {
				t.Fatal("store did not record after recovering from a bad file")
			}
			if err := s.Flush(); err != nil {
				t.Fatalf("Flush after recovery: %v", err)
			}
		})
	}
}

func TestOpenRejectsEmptyPath(t *testing.T) {
	if _, err := Open(""); err == nil {
		t.Fatal("Open(\"\") must fail: nothing could ever be persisted")
	}
}

func TestOpenCreatesStateDir(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "state", "dedup.json")
	s := openStore(t, path)
	s.SeenOrMark(NSMessage, "e1")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("store file not created: %v", err)
	}
}

// MaxEntries bounds the on-disk store.
func TestLRUBoundedByMaxEntries(t *testing.T) {
	clk := newClock()
	s := openStore(t, filepath.Join(t.TempDir(), "dedup.json"),
		WithClock(clk.Now), WithAutoFlush(false))

	const overflow = 16
	for i := range MaxEntries + overflow {
		s.SeenOrMark(NSMessage, fmt.Sprintf("e%05d", i))
	}
	if got := s.Len(); got != MaxEntries {
		t.Fatalf("entries = %d, want %d", got, MaxEntries)
	}
	// Oldest were evicted...
	if contains(t, s, NSMessage, "e00000") {
		t.Error("oldest key survived eviction")
	}
	// ...newest are still deduplicated.
	if !contains(t, s, NSMessage, fmt.Sprintf("e%05d", MaxEntries+overflow-1)) {
		t.Error("newest key was evicted")
	}

	if err := s.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	var f fileFormat
	data, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(f.Entries) != MaxEntries {
		t.Fatalf("persisted entries = %d, want %d", len(f.Entries), MaxEntries)
	}
}

func TestEvictionIsLeastRecentlyUsed(t *testing.T) {
	clk := newClock()
	s := openStore(t, filepath.Join(t.TempDir(), "dedup.json"),
		WithClock(clk.Now), WithMaxEntries(3))

	for _, k := range []string{"a", "b", "c"} {
		s.SeenOrMark(NSMessage, k)
	}
	// Touch "a": a duplicate hit refreshes recency even though it does not
	// refresh the expiry.
	if !s.SeenOrMark(NSMessage, "a") {
		t.Fatal("a should be seen")
	}
	s.SeenOrMark(NSMessage, "d") // evicts the LRU, which is now "b"

	// Probed without SeenOrMark: a miss would insert and evict in turn, which
	// would make the assertions chase their own tail.
	tests := map[string]bool{"a": true, "b": false, "c": true, "d": true}
	for key, want := range tests {
		if got := contains(t, s, NSMessage, key); got != want {
			t.Errorf("held(msg,%q) = %v, want %v", key, got, want)
		}
	}
}

// contains reports membership without touching recency or inserting anything.
func contains(t *testing.T, s *FileStore, ns, key string) bool {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.index[storeKey(ns, key)]
	return ok
}

// On overflow, dead entries are dropped before live ones.
func TestOverflowPurgesExpiredBeforeLive(t *testing.T) {
	clk := newClock()
	s := openStore(t, filepath.Join(t.TempDir(), "dedup.json"),
		WithClock(clk.Now), WithMaxEntries(3))

	s.SeenOrMark(NSCard, "short1") // 15min window
	s.SeenOrMark(NSCard, "short2")
	s.SeenOrMark(NSMessage, "long") // 24h window, most recently used

	clk.Advance(CardTTL + time.Second)
	s.SeenOrMark(NSMessage, "fresh") // overflow: both cards are dead

	if s.Len() != 2 {
		t.Fatalf("entries = %d, want 2 (both expired cards purged)", s.Len())
	}
	if !s.SeenOrMark(NSMessage, "long") {
		t.Error("live entry was evicted while dead ones were still present")
	}
}

func TestUnknownNamespaceUsesTheLongerWindow(t *testing.T) {
	clk := newClock()
	s := openStore(t, filepath.Join(t.TempDir(), "dedup.json"), WithClock(clk.Now))

	s.SeenOrMark("weird", "e1")
	clk.Advance(CardTTL + time.Minute)
	if !s.SeenOrMark("weird", "e1") {
		t.Fatal("unknown namespace fell back to the short window")
	}
	clk.Advance(MessageTTL)
	if s.SeenOrMark("weird", "e1") {
		t.Fatal("unknown namespace never expires")
	}
}

// An event with no id cannot be deduplicated; collapsing them all onto one key
// would silently swallow distinct user messages.
func TestEmptyKeyIsNeverDeduplicated(t *testing.T) {
	s := openStore(t, filepath.Join(t.TempDir(), "dedup.json"))

	for i := range 3 {
		if s.SeenOrMark(NSMessage, "") {
			t.Fatalf("call %d: empty key reported as seen", i)
		}
	}
	s.Unmark(NSMessage, "")
	if got := s.Len(); got != 0 {
		t.Fatalf("entries = %d, want 0", got)
	}
}

func TestFlushAndCloseSemantics(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dedup.json")
	s := openStore(t, path, WithAutoFlush(false))

	s.SeenOrMark(NSMessage, "e1")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file exists before Flush with auto-flush off (err=%v)", err)
	}
	if err := s.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file missing after Flush: %v", err)
	}

	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close must be idempotent, got %v", err)
	}
	if err := s.Flush(); err == nil {
		t.Fatal("Flush after Close must fail")
	}
}

// Write-through is the default: a SIGKILL right after a mark must not lose it.
func TestAutoFlushPersistsEveryMutation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dedup.json")
	s := openStore(t, path)

	s.SeenOrMark(NSMessage, "e1")
	if !reopenSees(t, path, NSMessage, "e1") {
		t.Fatal("mark was not on disk without an explicit Flush")
	}

	s.Unmark(NSMessage, "e1")
	if reopenSees(t, path, NSMessage, "e1") {
		t.Fatal("unmark was not on disk without an explicit Flush")
	}
	// The probe must not answer its own question: a probe that marked the key
	// on the way out would make this second read report the unmark as undone.
	if reopenSees(t, path, NSMessage, "e1") {
		t.Fatal("the probe wrote the key back to disk")
	}
}

// reopenSees answers "would a freshly started bridge consider this a duplicate?"
// without disturbing the file or the running store: Open already applies the
// TTL while loading, so membership after a load is exactly that answer, and no
// mark has to be written to obtain it. FileStore holds no descriptor and no
// goroutine, so the probe needs no Close — and Close would persist.
func reopenSees(t *testing.T, path, ns, key string) bool {
	t.Helper()
	probe, err := Open(path, WithAutoFlush(false))
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	return contains(t, probe, ns, key)
}

// The state dir is 0600 territory; a file that was already too permissive must
// be tightened, not inherited.
func TestPersistTightensExistingFileMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dedup.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"entries":[]}`), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	s := openStore(t, path)
	s.SeenOrMark(NSMessage, "e1")

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := info.Mode().Perm(); got != fileMode {
		t.Fatalf("file mode = %v, want %v", got, fileMode)
	}
}

// A crash between CreateTemp and rename leaves a stray temp file; the real file
// must still be the one that loads.
func TestStrayTempFileIsIgnored(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "dedup.json")

	first := openStore(t, path)
	first.SeenOrMark(NSMessage, "kept")
	if err := first.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".dedup.json.tmp-987654"), []byte("half"), fileMode); err != nil {
		t.Fatalf("seed temp: %v", err)
	}

	second := openStore(t, path)
	if warn := second.LoadWarning(); warn != nil {
		t.Fatalf("LoadWarning: %v", warn)
	}
	if !second.SeenOrMark(NSMessage, "kept") {
		t.Fatal("the intact file was not loaded")
	}
}

func TestNoTempFilesLeftBehind(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "dedup.json")
	s := openStore(t, path)

	for i := range 5 {
		s.SeenOrMark(NSMessage, fmt.Sprintf("e%d", i))
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
			t.Errorf("temp file left behind: %s", n.Name())
		}
	}
	if len(names) != 1 {
		t.Errorf("files in state dir = %d, want 1", len(names))
	}
}

// A disk that stops accepting writes must neither panic nor pretend to be
// durable: dedup keeps working in memory and the failure is reportable.
func TestPersistenceFailureIsReportedNotFatal(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "dedup.json")
	s := openStore(t, path)

	if err := os.Chmod(dir, 0o500); err != nil {
		t.Skipf("cannot make dir read-only: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	if s.SeenOrMark(NSMessage, "e1") {
		t.Fatal("first sight reported as seen")
	}
	if !s.SeenOrMark(NSMessage, "e1") {
		t.Fatal("in-memory dedup stopped working when the disk did")
	}
	if s.LastError() == nil {
		t.Fatal("failed write-through was swallowed")
	}
	if err := s.Flush(); err == nil {
		t.Fatal("Flush reported success on an unwritable directory")
	}

	// Recovers, and stops reporting an error, once the disk does.
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	if err := s.Flush(); err != nil {
		t.Fatalf("Flush after recovery: %v", err)
	}
	if err := s.LastError(); err != nil {
		t.Fatalf("LastError not cleared after a good write: %v", err)
	}
}

// Every failure path of a write-through must reach LastError, not just the
// one that touches the disk: a store whose marks never leave memory lets every
// event through again after a restart, which is when Feishu redelivers (G14).
func TestEncodeFailureIsReportedNotFatal(t *testing.T) {
	// time.Time refuses to marshal a year outside [0,9999], so an expiry that
	// crosses the boundary fails json.Marshal without any injected encoder.
	clk := &fakeClock{now: time.Date(9999, 12, 31, 23, 59, 0, 0, time.UTC)}
	path := filepath.Join(t.TempDir(), "dedup.json")
	s := openStore(t, path, WithClock(clk.Now))

	if s.SeenOrMark(NSMessage, "e1") { // expires in year 10000
		t.Fatal("first sight reported as seen")
	}
	err := s.LastError()
	if err == nil {
		t.Fatal("failed encode was swallowed: LastError still reports success")
	}
	if !strings.Contains(err.Error(), "encode") {
		t.Fatalf("LastError = %v, want the encode failure", err)
	}
	if err := s.Flush(); err == nil {
		t.Fatal("Flush reported success on an unencodable store")
	}
	// In-memory dedup keeps working; only durability was lost.
	if !s.SeenOrMark(NSMessage, "e1") {
		t.Fatal("in-memory dedup stopped working when encoding did")
	}

	// And it clears once the store is encodable again.
	s.Unmark(NSMessage, "e1")
	if err := s.LastError(); err != nil {
		t.Fatalf("LastError not cleared after a good write: %v", err)
	}
}

// Exactly one caller may win a given key, even when Feishu's redelivery lands
// while the original event is still in flight. Run under -race.
func TestConcurrentSeenOrMark(t *testing.T) {
	clk := newClock()
	s := openStore(t, filepath.Join(t.TempDir(), "dedup.json"),
		WithClock(clk.Now), WithAutoFlush(false))

	const (
		goroutines = 16
		keys       = 32
	)

	var winners [keys]atomic.Int64
	var wg sync.WaitGroup
	start := make(chan struct{})

	for g := range goroutines {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			<-start
			for i := range keys {
				if !s.SeenOrMark(NSCard, fmt.Sprintf("evt-%02d", i)) {
					winners[i].Add(1)
				}
				// Concurrent readers, writers and persisters on the same lock.
				s.SeenOrMark(NSMessage, fmt.Sprintf("g%d-%d", g, i))
				if i%8 == 0 {
					s.Unmark(NSMessage, fmt.Sprintf("g%d-%d", g, i))
					if err := s.Flush(); err != nil {
						t.Errorf("Flush: %v", err)
						return
					}
				}
				_ = s.Len()
			}
		}(g)
	}
	close(start)
	wg.Wait()

	for i := range keys {
		if got := winners[i].Load(); got != 1 {
			t.Errorf("key %d: %d goroutines saw it as new, want exactly 1", i, got)
		}
	}
}

func TestStoreKeyFormat(t *testing.T) {
	if got := storeKey(NSMessage, "abc"); got != "msg:abc" {
		t.Fatalf("storeKey = %q, want %q", got, "msg:abc")
	}
	if got := storeKey(NSCard, "abc"); got != "card:abc" {
		t.Fatalf("storeKey = %q, want %q", got, "card:abc")
	}
}

// The persisted key must be the composite one, so a restart cannot confuse
// namespaces.
func TestPersistedFileLayout(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dedup.json")
	s := openStore(t, path)
	s.SeenOrMark(NSMessage, "a")
	s.SeenOrMark(NSCard, "b")
	if err := s.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var f fileFormat
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("unmarshal %s: %v", data, err)
	}
	if f.Version != fileVersion {
		t.Errorf("version = %d, want %d", f.Version, fileVersion)
	}
	want := []string{"msg:a", "card:b"} // least-recently-used first
	if len(f.Entries) != len(want) {
		t.Fatalf("entries = %d, want %d", len(f.Entries), len(want))
	}
	for i, w := range want {
		if f.Entries[i].Key != w {
			t.Errorf("entry[%d].k = %q, want %q", i, f.Entries[i].Key, w)
		}
		if f.Entries[i].Expires.IsZero() {
			t.Errorf("entry[%d] has no expiry", i)
		}
	}
}
