package agents

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Agent kinds this package knows how to locate a transcript for.
const (
	kindClaude = "claude"
	kindCodex  = "codex"
)

// transcriptExt is the extension both agents write. Matching on it keeps the
// codex walk from returning the lock files and sidecars that live in the same
// directories.
const transcriptExt = ".jsonl"

// missRetryInterval is how long a fruitless search is remembered before it is
// tried again.
//
// A miss is never cached as an answer — the transcript appears on disk shortly
// after the session does, and for codex only after the hook has been trusted by
// hand with `t`, which can be minutes or never (G8). But the codex layout has
// to be found by walking ~/.codex/sessions, which grows by a rollout file per
// session forever, and a mirror that resolves once per registry poll would run
// that walk once a second for the entire life of the process. Five seconds
// keeps the answer fresh enough for a human watching a phone while turning the
// walk into something the disk cache absorbs.
const missRetryInterval = 5 * time.Second

// TranscriptOption configures a TranscriptResolver.
type TranscriptOption func(*transcripts)

// WithHome overrides the home directory the resolver searches under. Empty
// values are ignored.
func WithHome(dir string) TranscriptOption {
	return func(t *transcripts) {
		if dir != "" {
			t.home = dir
		}
	}
}

// WithTranscriptClock injects the time source used to rate-limit repeated
// searches for a transcript that is not on disk yet. A nil function is ignored.
func WithTranscriptClock(now func() time.Time) TranscriptOption {
	return func(t *transcripts) {
		if now != nil {
			t.now = now
		}
	}
}

// transcripts resolves agents to their native transcript files (S1 §3.5).
type transcripts struct {
	home string
	now  func() time.Time

	mu    sync.Mutex
	cache map[string]cachedTranscript
	// misses records the last fruitless search per pane, so that the walk is
	// rate-limited without ever becoming a cached "no".
	misses map[string]missedTranscript
}

// missedTranscript is one pane's last fruitless search. The session id is part
// of it for the same reason it is part of the positive entry: a pane whose
// agent restarts keeps its pane_id, and the new session deserves an immediate
// look rather than the previous one's back-off.
type missedTranscript struct {
	sessionID string
	checkedAt time.Time
}

// cachedTranscript remembers one pane's answer. The session id is stored with
// it because that is half the cache key: a pane whose agent restarts keeps its
// pane_id and gets a new session, and serving the old path then would mirror a
// transcript that has stopped growing.
type cachedTranscript struct {
	sessionID string
	path      string
}

var _ TranscriptResolver = (*transcripts)(nil)

// NewTranscriptResolver returns a resolver rooted at the user's home
// directory, or at WithHome's directory when one is given.
func NewTranscriptResolver(opts ...TranscriptOption) (TranscriptResolver, error) {
	t := &transcripts{
		now:    time.Now,
		cache:  map[string]cachedTranscript{},
		misses: map[string]missedTranscript{},
	}
	for _, opt := range opts {
		opt(t)
	}
	if t.home == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		t.home = home
	}
	return t, nil
}

// Resolve maps an agent to its transcript file.
//
// ok is false, with no error anywhere, when the agent has no session reference
// yet. That is a normal intermediate state and not a fault: herdr only reports
// agent_session once the agent's SessionStart hook has fired, which for claude
// is after the trust-directory prompt has been accepted, and for codex only
// after the hook has been trusted by hand with `t` inside codex (G8).
//
// ok is also false when the id resolves to no file on disk — the transcript may
// simply not have been written yet — so callers must be able to ask again
// later.
func (t *transcripts) Resolve(a Agent) (string, bool) {
	ref := a.SessionRef
	if ref == nil || ref.Value == "" {
		return "", false
	}

	if ref.Kind == "path" {
		// Only pi/omp report a path today. It is used as given: herdr got it
		// from the agent itself, and second-guessing it here would just be a
		// different guess.
		return ref.Value, true
	}
	if ref.Kind != "id" {
		return "", false
	}

	kind := a.Kind
	if kind == "" {
		// A pane whose kind herdr has not filled in still carries the agent
		// name inside the session ref it got from that agent's own hook.
		kind = ref.Agent
	}

	if p, ok := t.cached(a.PaneID, ref.Value); ok {
		return p, true
	}
	if t.searchedRecently(a.PaneID, ref.Value) {
		return "", false
	}

	path, ok := t.find(kind, ref.Value)
	if !ok {
		// The miss is remembered as a timestamp, not as an answer: asking again
		// in missRetryInterval still finds a transcript that has since been
		// written, which caching "no" would not.
		t.rememberMiss(a.PaneID, ref.Value)
		return "", false
	}
	t.remember(a.PaneID, ref.Value, path)
	return path, true
}

// searchedRecently reports whether this exact (pane, session) was searched for
// too recently to be worth walking the disk again.
func (t *transcripts) searchedRecently(paneID, sessionID string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	m, ok := t.misses[paneID]
	if !ok || m.sessionID != sessionID {
		return false
	}
	// A clock that jumps backwards must not extend the back-off, so the
	// comparison is on the absolute gap.
	gap := t.now().Sub(m.checkedAt)
	if gap < 0 {
		gap = -gap
	}
	return gap < missRetryInterval
}

func (t *transcripts) rememberMiss(paneID, sessionID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.misses[paneID] = missedTranscript{sessionID: sessionID, checkedAt: t.now()}
}

func (t *transcripts) cached(paneID, sessionID string) (string, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.cache[paneID]
	if !ok || e.sessionID != sessionID {
		return "", false
	}
	return e.path, true
}

func (t *transcripts) remember(paneID, sessionID, path string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.cache[paneID] = cachedTranscript{sessionID: sessionID, path: path}
	// The pane has an answer now; a leftover miss would only delay the next
	// session's first search.
	delete(t.misses, paneID)
}

// find locates the transcript for one session id.
//
// Both agents are found by FILENAME, never by rebuilding the directory that
// contains it. Claude mangles the project's cwd into its directory name by
// replacing separators, and that escaping rule is undocumented and unstable —
// herdr's own hook receives the real transcript_path and throws it away (G8),
// so the filename is the only part of the layout worth trusting.
func (t *transcripts) find(kind, id string) (string, bool) {
	if !safeSessionID(id) {
		return "", false
	}
	switch kind {
	case kindClaude:
		// ~/.claude/projects/<mangled cwd>/<id>.jsonl
		matches, err := filepath.Glob(filepath.Join(t.home, ".claude", "projects", "*", id+transcriptExt))
		if err != nil || len(matches) == 0 {
			return "", false
		}
		// Glob sorts, so a session id that somehow appears under two projects
		// resolves to the same file on every call.
		return matches[0], true
	case kindCodex:
		// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl. The date nesting
		// is walked rather than globbed at a fixed depth: it is a layout choice
		// of codex's, and the id is the part of the name that is ours.
		return t.walkFor(filepath.Join(t.home, ".codex", "sessions"), id)
	default:
		return "", false
	}
}

// walkFor returns the first file under root whose name contains id and ends in
// transcriptExt. Lexical walk order makes "first" deterministic.
func (t *transcripts) walkFor(root, id string) (string, bool) {
	var found string
	// The error is deliberately ignored: a walk that cannot read one directory
	// still answers correctly from the rest, and a missing root simply means no
	// match. Resolve's contract has nowhere to report a fault, and "not found"
	// is the honest answer to "where is this file".
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// Skip what we cannot read rather than abandoning the walk.
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		name := d.Name()
		if strings.HasSuffix(name, transcriptExt) && strings.Contains(name, id) {
			found = path
			return fs.SkipAll
		}
		return nil
	})
	return found, found != ""
}

// safeSessionID rejects anything that is not a plain identifier.
//
// The id arrives from herdr, which got it from an agent's hook, and it is
// pasted straight into a glob pattern and compared against filenames. A `*`
// would match any session's transcript, and a separator would walk out of the
// home directory entirely. Real ids are UUIDs, so nothing legitimate is lost.
func safeSessionID(id string) bool {
	if id == "" {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}
