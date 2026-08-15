package selection

import (
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

// claude is a fully populated target: pane plus the identity that gets
// re-checked before every delivery (G8, G17).
func claude(pane string) Target {
	return Target{
		Pane:          pane,
		Kind:          "claude",
		Session:       "cf67e552-abca-4b2a-8711-f37c328ed677",
		CardMessageID: "om_card_1",
	}
}

// rawLen counts entries still physically in the map, expired ones included.
// Len and Get both filter at read time, so assertions that must pin down what
// load() or eviction actually kept have to look here instead.
func rawLen(s *FileStore) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.targets)
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

func mustGet(t *testing.T, s Store, chatID string, want Target) Target {
	t.Helper()
	got, ok := s.Get(chatID)
	if !ok {
		t.Fatalf("Get(%q): ok=false, want %+v", chatID, want)
	}
	if got.Pane != want.Pane || got.Kind != want.Kind || got.Session != want.Session {
		t.Fatalf("Get(%q) = %+v, want pane/kind/session %q/%q/%q",
			chatID, got, want.Pane, want.Kind, want.Session)
	}
	return got
}

func mustMiss(t *testing.T, s Store, chatID string) {
	t.Helper()
	if got, ok := s.Get(chatID); ok {
		t.Fatalf("Get(%q) = %+v, true; want miss", chatID, got)
	}
}

func TestSetGetClear(t *testing.T) {
	tests := []struct {
		name string
		sets []struct {
			chat string
			t    Target
		}
		clear    string
		get      string
		wantPane string
		wantOK   bool
		wantLen  int // selections actually stored, checked for every case
	}{
		{
			name:     "selected chat resolves",
			sets:     setList("oc_1", claude("w1:p1")),
			get:      "oc_1",
			wantPane: "w1:p1",
			wantOK:   true,
			wantLen:  1,
		},
		{
			name:    "unknown chat misses",
			sets:    setList("oc_1", claude("w1:p1")),
			get:     "oc_nope",
			wantLen: 1,
		},
		{
			// One selection per chat: a second chat must not steal the first
			// chat's agent.
			name: "each chat keeps its own selection",
			sets: append(setList("oc_1", claude("w1:p1")),
				setList("oc_2", claude("w2:p3"))...),
			get:      "oc_2",
			wantPane: "w2:p3",
			wantOK:   true,
			wantLen:  2,
		},
		{
			name: "selecting again replaces the target",
			sets: append(setList("oc_1", claude("w1:p1")),
				setList("oc_1", claude("w9:p9"))...),
			get:      "oc_1",
			wantPane: "w9:p9",
			wantOK:   true,
			wantLen:  1,
		},
		{
			name:    "clear forgets the selection",
			sets:    setList("oc_1", claude("w1:p1")),
			clear:   "oc_1",
			get:     "oc_1",
			wantLen: 0,
		},
		{
			name:     "clear leaves other chats alone",
			sets:     append(setList("oc_1", claude("w1:p1")), setList("oc_2", claude("w2:p2"))...),
			clear:    "oc_1",
			get:      "oc_2",
			wantPane: "w2:p2",
			wantOK:   true,
			wantLen:  1,
		},
		{
			name:    "clearing an unselected chat is a no-op",
			sets:    setList("oc_1", claude("w1:p1")),
			clear:   "oc_absent",
			get:     "oc_absent",
			wantLen: 1,
		},
		{
			// A blank chat id would collapse every selection onto one key, so
			// one chat's typing would be delivered using another chat's agent.
			name:    "blank chat id is refused",
			sets:    setList("", claude("w1:p1")),
			get:     "",
			wantLen: 0,
		},
		{
			// Nothing can be delivered without a pane.
			name:    "blank pane is refused",
			sets:    setList("oc_1", Target{Kind: "claude"}),
			get:     "oc_1",
			wantLen: 0,
		},
		{
			// The identity half. With no Kind recorded there is nothing to
			// compare the live agent against, and the seat could since have
			// been taken by a different agent (G8, G17).
			name:    "blank kind is refused",
			sets:    setList("oc_1", Target{Pane: "w1:p1"}),
			get:     "oc_1",
			wantLen: 0,
		},
		{
			// G8: an agent is detected before its session ref exists (Claude
			// until SessionStart, Codex until the hook is trusted). A selection
			// made in that window is legitimate.
			name:     "missing session is accepted",
			sets:     setList("oc_1", Target{Pane: "w1:p1", Kind: "claude"}),
			get:      "oc_1",
			wantPane: "w1:p1",
			wantOK:   true,
			wantLen:  1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := openTest(t, filepath.Join(t.TempDir(), "selection.json"), WithClock(newClock().Now))
			for _, set := range tc.sets {
				s.Set(set.chat, set.t)
			}
			if tc.clear != "" {
				s.Clear(tc.clear)
			}

			got, ok := s.Get(tc.get)
			if ok != tc.wantOK {
				t.Fatalf("Get(%q) = (%+v, %v), want ok=%v", tc.get, got, ok, tc.wantOK)
			}
			if ok && got.Pane != tc.wantPane {
				t.Fatalf("Get(%q).Pane = %q, want %q", tc.get, got.Pane, tc.wantPane)
			}
			if n := s.Len(); n != tc.wantLen {
				t.Fatalf("Len = %d, want %d", n, tc.wantLen)
			}
			if n := rawLen(s); n != tc.wantLen {
				t.Fatalf("stored entries = %d, want %d", n, tc.wantLen)
			}
		})
	}
}

func setList(chat string, t Target) []struct {
	chat string
	t    Target
} {
	return []struct {
		chat string
		t    Target
	}{{chat, t}}
}

// The whole reason the Target carries an identity: the bridge re-checks Kind
// and Session against the live agent before delivering, so both have to come
// back out exactly as they went in — including across a restart.
func TestIdentityAndCardIDSurviveRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "selection.json")
	clk := newClock()

	want := Target{
		Pane:          "w1:p1",
		Kind:          "codex",
		Session:       "rollout-2026-08-14T01-00-00-abc123",
		SelectedAt:    clk.Now(),
		CardMessageID: "om_x100b68e9b40a2ca",
	}

	s1 := openTest(t, path, WithClock(clk.Now))
	s1.Set("oc_1", want)
	if err := s1.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	s2 := openTest(t, path, WithClock(clk.Now))
	got, ok := s2.Get("oc_1")
	if !ok {
		t.Fatal("Get after reopen: ok=false")
	}
	if got.Pane != want.Pane || got.Kind != want.Kind || got.Session != want.Session {
		t.Fatalf("identity changed across restart: got %+v, want %+v", got, want)
	}
	// Without this the picker card cannot be re-rendered in place after a
	// restart, and every selection change posts a new card instead.
	if got.CardMessageID != want.CardMessageID {
		t.Fatalf("CardMessageID = %q, want %q", got.CardMessageID, want.CardMessageID)
	}
	if !got.SelectedAt.Equal(want.SelectedAt) {
		t.Fatalf("SelectedAt = %v, want %v", got.SelectedAt, want.SelectedAt)
	}
}

// TestASelectionNeverExpires is the retraction of the 12h TTL, stated as a
// test so it cannot creep back in.
//
// A selection is a conversation the user opened, and no amount of elapsed time
// is evidence that they finished it. The clock used to end one silently, which
// from the phone looked like the bridge forgetting who you were talking to —
// with nothing to point at, because the thing that ended it was not an event.
// Clear (i.e. /close, or picking another agent) is the only way out now.
func TestASelectionNeverExpires(t *testing.T) {
	for _, advance := range []time.Duration{
		0,
		9 * time.Hour,
		StaleAfter,
		StaleAfter + 12*time.Hour,
		30 * 24 * time.Hour,
		5 * 365 * 24 * time.Hour,
		// A selection dated in the future — a Mac whose clock was wrong at boot
		// — is data, not a reason to drop a conversation. Nothing here compares
		// timestamps any more, so it simply survives like every other entry.
		-time.Second,
		-100 * 365 * 24 * time.Hour,
	} {
		t.Run(advance.String(), func(t *testing.T) {
			clk := newClock()
			s := openTest(t, filepath.Join(t.TempDir(), "selection.json"), WithClock(clk.Now))
			s.Set("oc_1", claude("w1:p1"))

			clk.Advance(advance)

			mustGet(t, s, "oc_1", claude("w1:p1"))
			if n := s.Len(); n != 1 {
				t.Fatalf("after %v Len = %d, want the selection still held", advance, n)
			}
		})
	}
}

// Reading is not an event either: Get must not rewrite the stamp the bridge
// reads to decide whether to remind the user how old their aim is. If it did,
// a chat that keeps typing would never be told, which is the one case where
// the age is worth saying.
func TestGetDoesNotTouchTheSelection(t *testing.T) {
	clk := newClock()
	s := openTest(t, filepath.Join(t.TempDir(), "selection.json"), WithClock(clk.Now))
	s.Set("oc_1", claude("w1:p1"))
	want, ok := s.Get("oc_1")
	if !ok {
		t.Fatal("the selection was not stored")
	}

	for range 20 {
		clk.Advance(StaleAfter / 10)
		s.Get("oc_1")
	}
	got, ok := s.Get("oc_1")
	if !ok {
		t.Fatal("the selection was lost by being read")
	}
	if !got.SelectedAt.Equal(want.SelectedAt) {
		t.Fatalf("SelectedAt = %v, want it untouched at %v", got.SelectedAt, want.SelectedAt)
	}
}

// Selecting again is a fresh confirmation, and it replaces what was there.
func TestSetReplacesTheTarget(t *testing.T) {
	clk := newClock()
	s := openTest(t, filepath.Join(t.TempDir(), "selection.json"), WithClock(clk.Now))

	s.Set("oc_1", claude("w1:p1"))
	clk.Advance(StaleAfter - time.Hour)
	again := claude("w1:p2")
	s.Set("oc_1", again)

	clk.Advance(2 * time.Hour)
	mustGet(t, s, "oc_1", again)

	// And Clear — the only retirement path left — is what ends it.
	s.Clear("oc_1")
	mustMiss(t, s, "oc_1")
}

func TestSetTimestampHandling(t *testing.T) {
	clk := newClock()

	t.Run("zero is stamped from the clock", func(t *testing.T) {
		s := openTest(t, filepath.Join(t.TempDir(), "selection.json"), WithClock(clk.Now))
		// A struct literal that omits SelectedAt must not produce a selection
		// that reads as expired on the very first Get.
		bare := Target{Pane: "w1:p1", Kind: "claude"}
		s.Set("oc_1", bare)
		got := mustGet(t, s, "oc_1", bare)
		if !got.SelectedAt.Equal(clk.Now()) {
			t.Fatalf("SelectedAt = %v, want %v", got.SelectedAt, clk.Now())
		}
	})

	t.Run("caller timestamp is kept", func(t *testing.T) {
		s := openTest(t, filepath.Join(t.TempDir(), "selection.json"), WithClock(clk.Now))
		// Rewriting a target (a new picker card id for the same selection) must
		// not restamp it: SelectedAt means "when a human chose this", and the
		// bridge reads it to decide whether to remind them how long ago that
		// was. A rewrite that moved it would silence the reminder forever.
		earlier := clk.Now().Add(-StaleAfter + time.Minute)
		tgt := claude("w1:p1")
		tgt.SelectedAt = earlier
		s.Set("oc_1", tgt)

		got := mustGet(t, s, "oc_1", tgt)
		if !got.SelectedAt.Equal(earlier) {
			t.Fatalf("SelectedAt = %v, want %v", got.SelectedAt, earlier)
		}
	})
}

func TestPersistAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "selection.json")
	clk := newClock()

	s1 := openTest(t, path, WithClock(clk.Now))
	s1.Set("oc_1", claude("w1:p1"))
	s1.Set("oc_2", claude("w2:p2"))
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
	// Literal, not fileMode: S2 3.1 fixes 0600 for the state dir, and this file
	// carries pane and session ids that address a live shell.
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("mode = %#o, want 0600", got)
	}

	clk.Advance(time.Hour)
	s2 := openTest(t, path, WithClock(clk.Now))
	if err := s2.LoadWarning(); err != nil {
		t.Fatalf("LoadWarning after clean reopen: %v", err)
	}
	mustGet(t, s2, "oc_1", claude("w1:p1"))
	mustGet(t, s2, "oc_2", claude("w2:p2"))

	// selectedAt survives the round trip, so the age the bridge reports is the
	// age since the human picked — not since the last time the process bounced.
	if got := mustGet(t, s2, "oc_1", claude("w1:p1")); !got.SelectedAt.Equal(clk.Now().Add(-time.Hour)) {
		t.Fatalf("SelectedAt = %v, want it to have survived the restart", got.SelectedAt)
	}
}

// The bridge is killed, not shut down, more often than we would like: a Set
// must be on disk before the process that made it goes away, or the first
// message after a restart lands on the picker card mid-conversation.
func TestSetIsDurableWithoutExplicitFlush(t *testing.T) {
	path := filepath.Join(t.TempDir(), "selection.json")
	clk := newClock()

	s1 := openTest(t, path, WithClock(clk.Now))
	s1.Set("oc_1", claude("w1:p1"))
	if err := s1.LastError(); err != nil {
		t.Fatalf("LastError after Set: %v", err)
	}

	// No Flush, no Close: reopen the file exactly as it is on disk right now.
	s2 := openTest(t, path, WithClock(clk.Now))
	mustGet(t, s2, "oc_1", claude("w1:p1"))
}

// Clear is /close: the user said they are done talking to that agent. If it
// only ever lived in memory, a restart would resurrect a conversation they
// closed and the next thing typed would go to an agent they had walked away
// from.
func TestClearIsDurableWithoutExplicitFlush(t *testing.T) {
	path := filepath.Join(t.TempDir(), "selection.json")
	clk := newClock()

	s1 := openTest(t, path, WithClock(clk.Now))
	s1.Set("oc_1", claude("w1:p1"))
	s1.Clear("oc_1")

	s2 := openTest(t, path, WithClock(clk.Now))
	mustMiss(t, s2, "oc_1")
}

// TestAnOldSelectionSurvivesARestart: S2 3.1 has this bridge killed and
// restarted routinely, so an age filter on the load path would be the retracted
// TTL under another name — and "the process bounced" is the least explicable
// reason a conversation could end.
func TestAnOldSelectionSurvivesARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "selection.json")
	clk := newClock()

	s1 := openTest(t, path, WithClock(clk.Now))
	s1.Set("oc_1", claude("w1:p1"))
	if err := s1.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	clk.Advance(30 * 24 * time.Hour)
	s2 := openTest(t, path, WithClock(clk.Now))
	mustGet(t, s2, "oc_1", claude("w1:p1"))
	if n := rawLen(s2); n != 1 {
		t.Fatalf("stored entries = %d, want the selection reloaded", n)
	}

	// A Mac whose clock came back wrong at boot changes nothing either: no path
	// in this store compares a timestamp any more.
	rewound := newClock()
	s3 := openTest(t, path, WithClock(rewound.Now))
	mustGet(t, s3, "oc_1", claude("w1:p1"))
}

// Set must never evict the entry it was just asked to store. Eviction orders by
// SelectedAt and Set keeps a caller-supplied stamp, so at capacity a selection
// carrying an older stamp (the issuing card's IssuedAt) sorts oldest — and
// dropping it would tell the user a selection was made that the store never
// held, leaving the next thing typed to fall through to the picker.
func TestSetNeverEvictsWhatItJustStored(t *testing.T) {
	clk := newClock()
	s := openTest(t, filepath.Join(t.TempDir(), "selection.json"),
		WithClock(clk.Now), WithMaxEntries(3), WithAutoFlush(false))

	for i := range 3 {
		s.Set("oc_"+strconv.Itoa(i), claude("w1:p"+strconv.Itoa(i)))
		clk.Advance(time.Minute)
	}

	// Older than every stored selection, and eviction orders by exactly that.
	late := claude("w9:p9")
	late.SelectedAt = clk.Now().Add(-time.Hour)
	s.Set("oc_late", late)

	mustGet(t, s, "oc_late", late)
	// And the bound still holds: something else was evicted, not nothing.
	if n := rawLen(s); n != 3 {
		t.Fatalf("stored entries = %d, want 3", n)
	}
	mustMiss(t, s, "oc_0")
}

// A write encodes every selection the store holds. The purge that used to run
// here went with the expiry: an entry in this map is somebody's open
// conversation, and the three things that retire one — /close, picking another
// agent, eviction at capacity — have all already deleted it by the time a write
// happens.
func TestPersistKeepsEverySelection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "selection.json")
	clk := newClock()

	s := openTest(t, path, WithClock(clk.Now))
	s.Set("oc_stale", claude("w1:p1"))
	clk.Advance(StaleAfter + time.Minute)
	s.Set("oc_fresh", claude("w2:p2")) // write-through rewrites the whole file

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	// The bytes, not Get: only the file itself shows what was written out.
	for _, chat := range []string{"oc_stale", "oc_fresh"} {
		if !strings.Contains(string(data), chat) {
			t.Fatalf("%s missing from disk: %s", chat, data)
		}
	}
}

// maxEntries must bound a file that already exceeds it, not just the Sets made
// in this process: a file written by a build with a larger bound (or a
// hand-edited one) would otherwise be loaded whole and the bound would only
// start applying at the next overflow.
func TestLoadEnforcesMaxEntries(t *testing.T) {
	const max = 4
	path := filepath.Join(t.TempDir(), "selection.json")
	clk := newClock()

	f := fileFormat{Version: fileVersion}
	for i := range max + 2 {
		tgt := claude("w1:p" + strconv.Itoa(i))
		tgt.SelectedAt = clk.Now().Add(-time.Duration(i) * time.Minute) // oc_0 newest
		f.Entries = append(f.Entries, &entry{ChatID: "oc_" + strconv.Itoa(i), Target: tgt})
	}
	data, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, data, fileMode); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	s := openTest(t, path, WithClock(clk.Now), WithMaxEntries(max))
	// Right after Open, before any mutation could have trimmed it.
	if n := rawLen(s); n != max {
		t.Fatalf("stored entries after Open = %d, want %d", n, max)
	}
	for i := range max {
		chat := "oc_" + strconv.Itoa(i)
		if _, ok := s.Get(chat); !ok {
			t.Fatalf("Get(%q): dropped a newer selection than the ones kept", chat)
		}
	}
}

// The on-disk field names belong to contract.go. A build that renamed them
// would read every existing state file as empty, silently deselecting every
// chat, so pin the wire shape here.
func TestOnDiskShapeMatchesContract(t *testing.T) {
	path := filepath.Join(t.TempDir(), "selection.json")
	clk := newClock()

	s := openTest(t, path, WithClock(clk.Now))
	s.Set("oc_1", claude("w1:p1"))
	if err := s.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var raw struct {
		Version int `json:"version"`
		Entries []struct {
			ChatID string `json:"c"`
			Target struct {
				Pane          string    `json:"pane"`
				Kind          string    `json:"kind"`
				Session       string    `json:"session"`
				SelectedAt    time.Time `json:"selected_at"`
				CardMessageID string    `json:"card_message_id"`
			} `json:"t"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if raw.Version != fileVersion {
		t.Fatalf("version = %d, want %d", raw.Version, fileVersion)
	}
	if len(raw.Entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(raw.Entries))
	}
	e := raw.Entries[0]
	want := claude("w1:p1")
	if e.ChatID != "oc_1" || e.Target.Pane != want.Pane || e.Target.Kind != want.Kind ||
		e.Target.Session != want.Session || e.Target.CardMessageID != want.CardMessageID ||
		!e.Target.SelectedAt.Equal(clk.Now()) {
		t.Fatalf("on-disk entry = %+v, want %+v under chat oc_1", e, want)
	}
}

// Unchanged state must produce byte-identical output: map iteration order is
// random, and a file that reshuffles on every write is impossible to diff and
// looks like a change to anything watching the state dir.
func TestPersistIsDeterministic(t *testing.T) {
	path := filepath.Join(t.TempDir(), "selection.json")
	clk := newClock()
	s := openTest(t, path, WithClock(clk.Now), WithAutoFlush(false))
	for i := range 30 {
		s.Set("oc_"+strconv.Itoa(i), claude("w1:p"+strconv.Itoa(i)))
	}

	if err := s.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	first, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	for range 5 {
		if err := s.Flush(); err != nil {
			t.Fatalf("Flush: %v", err)
		}
		again, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if string(again) != string(first) {
			t.Fatal("re-persisting unchanged state produced different bytes")
		}
	}
}

func TestCorruptFileStartsEmpty(t *testing.T) {
	valid := func(t *testing.T) []byte {
		t.Helper()
		tgt := claude("w1:p1")
		tgt.SelectedAt = newClock().Now()
		b, err := json.Marshal(fileFormat{
			Version: fileVersion,
			Entries: []*entry{{ChatID: "oc_1", Target: tgt}},
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
			return []byte(`{"version":99,"entries":[{"c":"oc_1","t":{"pane":"w1:p1","kind":"claude","selected_at":"2026-08-14T01:00:00Z"}}]}`)
		}, true, 0},
		{"null entry", func(*testing.T) []byte {
			return []byte(`{"version":1,"entries":[null,{"c":"oc_1","t":{"pane":"w1:p1","kind":"claude","selected_at":"2026-08-14T01:00:00Z"}}]}`)
		}, false, 1},
		{"entry missing pane", func(*testing.T) []byte {
			return []byte(`{"version":1,"entries":[{"c":"oc_1","t":{"pane":"","kind":"claude","selected_at":"2026-08-14T01:00:00Z"}}]}`)
		}, false, 0},
		{
			// Nothing to identity-check the live agent against, so this
			// selection could only be honoured blind (G8, G17).
			"entry missing kind", func(*testing.T) []byte {
				return []byte(`{"version":1,"entries":[{"c":"oc_1","t":{"pane":"w1:p1","selected_at":"2026-08-14T01:00:00Z"}}]}`)
			}, false, 0,
		},
		{"entry missing chat id", func(*testing.T) []byte {
			return []byte(`{"version":1,"entries":[{"c":"","t":{"pane":"w1:p1","kind":"claude","selected_at":"2026-08-14T01:00:00Z"}}]}`)
		}, false, 0},
		{
			// Written by a Mac whose clock was wrong at boot. It is kept: the
			// stamp is only ever read to decide whether to REMIND the user how
			// old their aim is, and a nonsense stamp costs at most a reminder
			// that never fires. Dropping the entry would cost the conversation,
			// which is the more expensive way to be wrong about a clock.
			"entry dated in the future", func(*testing.T) []byte {
				return []byte(`{"version":1,"entries":[{"c":"oc_1","t":{"pane":"w1:p1","kind":"claude","selected_at":"2099-01-01T00:00:00Z"}}]}`)
			}, false, 1,
		},
		{
			// Hand-edited or merged file: keep the newest, so the loaded
			// selection does not depend on the order entries happen to be in.
			"duplicate chat id keeps the newest", func(*testing.T) []byte {
				return []byte(`{"version":1,"entries":[` +
					`{"c":"oc_1","t":{"pane":"w9:p9","kind":"claude","selected_at":"2026-08-14T00:30:00Z"}},` +
					`{"c":"oc_1","t":{"pane":"w1:p1","kind":"claude","selected_at":"2026-08-14T00:59:00Z"}},` +
					`{"c":"oc_1","t":{"pane":"w8:p8","kind":"claude","selected_at":"2026-08-14T00:10:00Z"}}]}`)
			}, false, 1,
		},
		{"intact", valid, false, 1},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "selection.json")
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
			// Raw too: a rejected entry must be absent from the map, not merely
			// filtered out of every read.
			if got := rawLen(s); got != tc.wantLen {
				t.Fatalf("stored entries = %d, want %d", got, tc.wantLen)
			}
			if tc.wantLen == 1 {
				// Every surviving case above resolves to the same pane, so a
				// case that loaded the wrong one of several entries is caught.
				got, ok := s.Get("oc_1")
				if !ok || got.Pane != "w1:p1" || got.Kind != "claude" {
					t.Fatalf("Get(oc_1) = (%+v, %v), want pane w1:p1 kind claude", got, ok)
				}
			}

			// The store must recover: a fresh selection is persisted over the
			// bad file and survives the next reopen.
			s.Set("oc_new", claude("w7:p7"))
			s2 := openTest(t, path, WithClock(clk.Now))
			if err := s2.LoadWarning(); err != nil {
				t.Fatalf("LoadWarning after repair: %v", err)
			}
			mustGet(t, s2, "oc_new", claude("w7:p7"))
		})
	}
}

// A state file this process cannot read (written by another uid, mangled
// permissions) is the same class of problem as a corrupt one: warn and start
// empty. Refusing to boot would take the whole bridge down over a cache.
func TestUnreadableFileStartsEmpty(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores file permissions")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "selection.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"entries":[]}`), 0o600); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	if err := os.Chmod(path, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o600) })

	clk := newClock()
	s, err := OpenWith(path, WithClock(clk.Now))
	if err != nil {
		t.Fatalf("OpenWith must not fail on an unreadable file: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if s.LoadWarning() == nil {
		t.Fatal("LoadWarning after an unreadable file: want a warning, got nil")
	}
	if n := rawLen(s); n != 0 {
		t.Fatalf("stored entries = %d, want 0", n)
	}

	s.Set("oc_1", claude("w1:p1"))
	s2 := openTest(t, path, WithClock(clk.Now))
	mustGet(t, s2, "oc_1", claude("w1:p1"))
}

// A config typo that points the state path at a child of a regular file must
// stop the bridge at boot, where there is still an error return to say it in.
func TestOpenFailsWhenStateDirCannotBeCreated(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := Open(filepath.Join(blocker, "state", "selection.json")); err == nil {
		t.Fatal("Open under a regular file: want error, got nil")
	}
}

// A blank chat id is not a wildcard: Clear("") must not touch any selection.
func TestClearIgnoresBlankChatID(t *testing.T) {
	s := openTest(t, filepath.Join(t.TempDir(), "selection.json"), WithClock(newClock().Now))
	s.Set("oc_1", claude("w1:p1"))
	s.Clear("")
	mustGet(t, s, "oc_1", claude("w1:p1"))
}

func TestFlushAfterCloseFails(t *testing.T) {
	s := openTest(t, filepath.Join(t.TempDir(), "selection.json"), WithClock(newClock().Now))
	s.Set("oc_1", claude("w1:p1"))
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("second Close must be a no-op, got %v", err)
	}
	err := s.Flush()
	if err == nil {
		t.Fatal("Flush after Close: want error, got nil")
	}
	if !errors.Is(err, ErrClosed) {
		t.Fatalf("Flush after Close = %v, want ErrClosed", err)
	}
}

// Set and Clear cannot return an error, so a mutation that lands after Close
// would otherwise be lost in complete silence — and Flush reports that same
// state as an error, so the two paths must not disagree about whether the store
// is still durable.
func TestMutationAfterCloseIsReported(t *testing.T) {
	for _, tc := range []struct {
		name  string
		apply func(s *FileStore)
	}{
		{"set", func(s *FileStore) { s.Set("oc_2", claude("w2:p2")) }},
		{"clear", func(s *FileStore) { s.Clear("oc_1") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "selection.json")
			clk := newClock()
			s := openTest(t, path, WithClock(clk.Now))
			s.Set("oc_1", claude("w1:p1"))
			if err := s.Close(); err != nil {
				t.Fatalf("Close: %v", err)
			}

			tc.apply(s)
			err := s.LastError()
			if err == nil {
				t.Fatal("LastError after mutating a closed store: want error, got nil")
			}
			if !errors.Is(err, ErrClosed) {
				t.Fatalf("LastError = %v, want ErrClosed", err)
			}

			// And the change really did not reach disk.
			s2 := openTest(t, path, WithClock(clk.Now))
			mustGet(t, s2, "oc_1", claude("w1:p1"))
			mustMiss(t, s2, "oc_2")
		})
	}
}

// A selection that never reaches disk is not durable, and Set cannot say so.
func TestLastErrorReportsAFailedWrite(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "selection.json")
	s := openTest(t, path, WithClock(newClock().Now))

	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	s.Set("oc_1", claude("w1:p1"))
	if err := s.LastError(); err == nil {
		t.Fatal("LastError after a failed write-through: want error, got nil")
	}
	// In-memory state still answers: losing durability must not lose the
	// selection the user is mid-conversation with.
	mustGet(t, s, "oc_1", claude("w1:p1"))
}

func TestOpenFailsOnUnwritableStateDir(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0o500); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	if _, err := Open(filepath.Join(dir, "selection.json")); err == nil {
		t.Fatal("Open on a non-writable state dir: want error, got nil")
	}
}

func TestOpenRejectsEmptyPath(t *testing.T) {
	if _, err := Open(""); err == nil {
		t.Fatal("Open(\"\"): want error, got nil")
	}
}

func TestOpenCreatesStateDir(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "state", "selection.json")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()

	s.Set("oc_1", claude("w1:p1"))
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("stat after Set: %v", err)
	}
}

// tmp + rename must not litter the state dir, and a reader must never observe a
// partial file under the real name.
func TestAtomicWriteLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "selection.json")

	// Left by a process killed between CreateTemp and Rename. The bridge is
	// killed and restarted routinely (S2 3.1), so if Open does not reclaim
	// these the state dir fills with hidden junk forever.
	stale := filepath.Join(dir, ".selection.json.tmp-1234567890")
	if err := os.WriteFile(stale, []byte("half a file"), fileMode); err != nil {
		t.Fatalf("seed stale temp: %v", err)
	}

	s := openTest(t, path, WithClock(newClock().Now))
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale temp file survived Open: stat err = %v", err)
	}
	for i := range 20 {
		s.Set("oc_"+strconv.Itoa(i), claude("w1:p1"))
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

// Overflow drops the least recently selected chat, and reading a selection must
// not protect it: eviction is by selection age, not by access.
func TestEvictionDropsOldestSelection(t *testing.T) {
	clk := newClock()
	s := openTest(t, filepath.Join(t.TempDir(), "selection.json"),
		WithClock(clk.Now), WithMaxEntries(3), WithAutoFlush(false))

	for i := range 3 {
		s.Set("oc_"+strconv.Itoa(i), claude("w1:p"+strconv.Itoa(i)))
		clk.Advance(time.Minute)
	}
	mustGet(t, s, "oc_0", claude("w1:p0")) // read the oldest; must not save it

	s.Set("oc_3", claude("w1:p3"))
	if n := rawLen(s); n != 3 {
		t.Fatalf("stored entries = %d, want 3", n)
	}
	mustMiss(t, s, "oc_0")
	for _, chat := range []string{"oc_1", "oc_2", "oc_3"} {
		if _, ok := s.Get(chat); !ok {
			t.Fatalf("Get(%q): evicted a newer selection", chat)
		}
	}
}

// Eviction at capacity is the only thing left that retires a selection nobody
// asked to retire, so it must drop the chat that chose longest ago and nothing
// else. There is no "dead" tier to raid first any more: every entry here is
// somebody's open conversation.
func TestEvictionDropsTheOldestChoice(t *testing.T) {
	clk := newClock()
	s := openTest(t, filepath.Join(t.TempDir(), "selection.json"),
		WithClock(clk.Now), WithMaxEntries(2), WithAutoFlush(false))

	ancient := claude("w1:p0")
	ancient.SelectedAt = clk.Now().Add(-30 * 24 * time.Hour)
	s.Set("oc_ancient", ancient)
	s.Set("oc_older", claude("w1:p1"))
	clk.Advance(time.Minute)
	s.Set("oc_new", claude("w1:p2"))

	if n := rawLen(s); n != 2 {
		t.Fatalf("stored entries = %d, want 2", n)
	}
	mustMiss(t, s, "oc_ancient")
	mustGet(t, s, "oc_older", claude("w1:p1"))
	mustGet(t, s, "oc_new", claude("w1:p2"))
}

// Every entry point is reachable from the Feishu event loop, a card action and
// the notifier at the same time. Run under -race.
func TestConcurrentAccess(t *testing.T) {
	clk := newClock()
	s := openTest(t, filepath.Join(t.TempDir(), "selection.json"),
		WithClock(clk.Now), WithMaxEntries(16))

	// Write-through is left on so the persist path is in the race too; the
	// counts are kept modest because every Set is a real fsync.
	const workers = 8
	const iterations = 20

	var wg sync.WaitGroup
	for w := range workers {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := range iterations {
				chat := "oc_" + strconv.Itoa(w) + "_" + strconv.Itoa(i)
				s.Set(chat, claude("w"+strconv.Itoa(w)+":p1"))
				s.Get(chat)
				s.Get("oc_absent")
				if i%3 == 0 {
					s.Clear(chat)
				}
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

	if got := s.Len(); got > 16 {
		t.Fatalf("Len = %d, want <= 16", got)
	}
	if err := s.LastError(); err != nil {
		t.Fatalf("LastError: %v", err)
	}
}

func TestDefaultsMatchContract(t *testing.T) {
	// Not an expiry: how long a selection may go unconfirmed before the bridge
	// says so out loud while delivering anyway. Long enough to survive a night,
	// so a chat that is simply being used never sees it.
	if StaleAfter != 12*time.Hour {
		t.Fatalf("StaleAfter = %v, want 12h", StaleAfter)
	}
	s := openTest(t, filepath.Join(t.TempDir(), "selection.json"), WithClock(newClock().Now))
	if s.maxEntries != DefaultMaxEntries {
		t.Fatalf("maxEntries = %d, want %d", s.maxEntries, DefaultMaxEntries)
	}
	if !s.autoFlush {
		t.Fatal("autoFlush must default to on")
	}
	if s.now == nil {
		t.Fatal("clock must default to time.Now")
	}
}

func TestOptionsIgnoreNonsense(t *testing.T) {
	s := openTest(t, filepath.Join(t.TempDir(), "selection.json"),
		WithClock(nil), WithMaxEntries(0), WithMaxEntries(-1))
	if s.now == nil {
		t.Fatal("WithClock(nil) must leave the default clock in place")
	}
	if s.maxEntries != DefaultMaxEntries {
		t.Fatalf("maxEntries = %d, want %d", s.maxEntries, DefaultMaxEntries)
	}
}

// With write-through off nothing reaches disk until Flush, and Close must
// flush what is still in memory.
func TestAutoFlushOffDefersWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "selection.json")
	clk := newClock()

	s1 := openTest(t, path, WithClock(clk.Now), WithAutoFlush(false))
	s1.Set("oc_1", claude("w1:p1"))

	s2 := openTest(t, path, WithClock(clk.Now))
	mustMiss(t, s2, "oc_1")
	if err := s2.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if err := s1.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	s3 := openTest(t, path, WithClock(clk.Now))
	mustGet(t, s3, "oc_1", claude("w1:p1"))
}
