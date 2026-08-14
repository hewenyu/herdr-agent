package agents

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

const (
	claudeSession = "cf67e552-abca-4b2a-8711-f37c328ed677"
	codexSession  = "0198fd21-4c1e-7a3b-9f52-0f1c2d3e4a5b"
)

// fixtureHome builds a HOME with one claude and one codex transcript in the
// layouts measured in G8, and returns their paths.
func fixtureHome(t *testing.T) (home, claudePath, codexPath string) {
	t.Helper()
	home = t.TempDir()
	// ~/.claude/projects/<cwd with / replaced by ->/<id>.jsonl. The mangled
	// directory name is deliberately odd: nothing here may reconstruct it.
	claudePath = filepath.Join(home, ".claude", "projects", "-tmp-herdr-accept", claudeSession+".jsonl")
	// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
	codexPath = filepath.Join(home, ".codex", "sessions", "2026", "08", "13",
		"rollout-2026-08-13T22-01-02-"+codexSession+".jsonl")
	writeFixture(t, claudePath)
	writeFixture(t, codexPath)
	return home, claudePath, codexPath
}

func writeFixture(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(`{"type":"user"}`+"\n"), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func sessionAgent(paneID, kind, refKind, value string) Agent {
	a := Agent{PaneID: paneID, Kind: kind}
	if value != "" || refKind != "" {
		a.SessionRef = &herdrapi.SessionRef{
			Source: "herdr:" + kind,
			Agent:  kind,
			Kind:   refKind,
			Value:  value,
		}
	}
	return a
}

func newResolver(t *testing.T, home string) TranscriptResolver {
	t.Helper()
	r, err := NewTranscriptResolver(WithHome(home))
	if err != nil {
		t.Fatalf("NewTranscriptResolver: %v", err)
	}
	return r
}

func TestResolveTranscript(t *testing.T) {
	home, claudePath, codexPath := fixtureHome(t)

	tests := []struct {
		name  string
		agent Agent
		want  string
		wants bool
	}{
		{
			// Not an error: for claude the ref only appears once the
			// trust-directory prompt has been accepted and SessionStart has
			// fired, and for codex only after the hook is trusted by hand (G8).
			name:  "no session ref yet",
			agent: Agent{PaneID: "w1:p1", Kind: "claude"},
		},
		{
			name:  "session ref with an empty value",
			agent: sessionAgent("w1:p1", "claude", "id", ""),
		},
		{
			name:  "kind path is used as given",
			agent: sessionAgent("w1:p1", "pi", "path", "/tmp/somewhere/session.jsonl"),
			want:  "/tmp/somewhere/session.jsonl",
			wants: true,
		},
		{
			name:  "claude id found under ~/.claude/projects",
			agent: sessionAgent("w1:p1", "claude", "id", claudeSession),
			want:  claudePath,
			wants: true,
		},
		{
			// The filename only CONTAINS the id here; the rollout timestamp in
			// front of it is codex's business.
			name:  "codex id found under ~/.codex/sessions",
			agent: sessionAgent("w1:p2", "codex", "id", codexSession),
			want:  codexPath,
			wants: true,
		},
		{
			name: "kind comes from the session ref when herdr has not filled it in",
			// herdr's agent field can lag behind the hook that reported the
			// session; the ref itself always names the agent it came from (G8).
			agent: Agent{
				PaneID: "w1:p3",
				SessionRef: &herdrapi.SessionRef{
					Source: "herdr:claude", Agent: "claude", Kind: "id", Value: claudeSession,
				},
			},
			want:  claudePath,
			wants: true,
		},
		{
			name:  "claude id that has no file yet",
			agent: sessionAgent("w1:p4", "claude", "id", "11111111-2222-3333-4444-555555555555"),
		},
		{
			name:  "codex id that has no file yet",
			agent: sessionAgent("w1:p5", "codex", "id", "11111111-2222-3333-4444-555555555555"),
		},
		{
			// Only claude and codex layouts are known. Guessing at another
			// agent's would produce a path that is wrong rather than absent.
			name:  "an agent whose layout we do not know",
			agent: sessionAgent("w1:p6", "aider", "id", claudeSession),
		},
		{
			name:  "a session ref kind we do not understand",
			agent: sessionAgent("w1:p7", "claude", "handle", claudeSession),
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := newResolver(t, home)
			got, ok := r.Resolve(tc.agent)
			if ok != tc.wants {
				t.Fatalf("Resolve ok = %v, want %v (path %q)", ok, tc.wants, got)
			}
			if got != tc.want {
				t.Fatalf("Resolve path = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestResolveRejectsIdsThatAreNotPlainIdentifiers(t *testing.T) {
	home, _, _ := fixtureHome(t)
	r := newResolver(t, home)

	// The id reaches us from an agent's own hook, by way of herdr, and is
	// pasted straight into a glob and compared against filenames.
	for _, id := range []string{
		"*",                     // would match any session's transcript
		"?f67e552",              // same
		"[abc]",                 // same
		"../../../etc/passwd",   // walks out of HOME
		"..",                    //
		"cf67e552/../../secret", //
		"cf67e552 abca",         // a space is not part of any real id
	} {
		t.Run(id, func(t *testing.T) {
			for _, kind := range []string{kindClaude, kindCodex} {
				if got, ok := r.Resolve(sessionAgent("w1:p1", kind, "id", id)); ok {
					t.Fatalf("%s: Resolve(%q) = %q, want no match", kind, id, got)
				}
			}
		})
	}
}

func TestResolveCachesByPaneAndSession(t *testing.T) {
	home, claudePath, _ := fixtureHome(t)
	r := newResolver(t, home)
	a := sessionAgent("w1:p1", "claude", "id", claudeSession)

	if got, ok := r.Resolve(a); !ok || got != claudePath {
		t.Fatalf("first Resolve = %q, %v", got, ok)
	}

	// Delete the file: a second resolution that still answers can only be
	// coming from the cache.
	if err := os.Remove(claudePath); err != nil {
		t.Fatalf("remove fixture: %v", err)
	}
	if got, ok := r.Resolve(a); !ok || got != claudePath {
		t.Fatalf("cached Resolve = %q, %v; want the remembered %q", got, ok, claudePath)
	}
}

func TestResolveInvalidatesWhenTheSessionChanges(t *testing.T) {
	home, claudePath, _ := fixtureHome(t)
	r := newResolver(t, home)
	pane := "w1:p1"

	if _, ok := r.Resolve(sessionAgent(pane, "claude", "id", claudeSession)); !ok {
		t.Fatal("first Resolve failed")
	}

	// Same pane, agent restarted: a new session id, and a transcript that only
	// exists for the new one. Serving the old path here would mirror a file
	// that has stopped growing.
	const restarted = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	newPath := filepath.Join(home, ".claude", "projects", "-tmp-herdr-accept", restarted+".jsonl")
	writeFixture(t, newPath)

	got, ok := r.Resolve(sessionAgent(pane, "claude", "id", restarted))
	if !ok || got != newPath {
		t.Fatalf("Resolve after restart = %q, %v, want %q", got, ok, newPath)
	}
	if got == claudePath {
		t.Fatal("the cache served the previous session's transcript")
	}

	// A session whose file does not exist must not fall back to the cached one.
	if got, ok := r.Resolve(sessionAgent(pane, "claude", "id", "ffffffff-0000-0000-0000-000000000000")); ok {
		t.Fatalf("Resolve for an unwritten transcript = %q, want no match", got)
	}
}

func TestResolveDoesNotCacheAMissThatMayAppearLater(t *testing.T) {
	home, _, _ := fixtureHome(t)
	now := epoch
	r, err := NewTranscriptResolver(WithHome(home), WithTranscriptClock(func() time.Time { return now }))
	if err != nil {
		t.Fatalf("NewTranscriptResolver: %v", err)
	}
	const late = "12121212-3434-5656-7878-909090909090"
	a := sessionAgent("w1:p9", "claude", "id", late)

	if _, ok := r.Resolve(a); ok {
		t.Fatal("Resolve found a transcript that does not exist yet")
	}
	path := filepath.Join(home, ".claude", "projects", "-tmp-herdr-accept", late+".jsonl")
	writeFixture(t, path)

	// Inside the back-off the disk is not touched again. A mirror resolves once
	// per registry poll, and for codex the search is a full recursive walk of a
	// directory that only ever grows (G8); running it every second for an agent
	// whose hook has not been trusted yet is the case this suppresses.
	if _, ok := r.Resolve(a); ok {
		t.Fatal("Resolve searched again inside the back-off window")
	}

	now = now.Add(missRetryInterval)
	got, ok := r.Resolve(a)
	if !ok || got != path {
		t.Fatalf("Resolve after the transcript appeared = %q, %v, want %q", got, ok, path)
	}
}

func TestResolveRetriesImmediatelyForANewSession(t *testing.T) {
	// The back-off is per (pane, session): an agent that restarts in the same
	// pane must not inherit the previous session's suppression, or its first
	// transcript would be invisible for as long as the window lasts.
	home, _, _ := fixtureHome(t)
	now := epoch
	r, err := NewTranscriptResolver(WithHome(home), WithTranscriptClock(func() time.Time { return now }))
	if err != nil {
		t.Fatalf("NewTranscriptResolver: %v", err)
	}
	const pane = "w1:p9"
	if _, ok := r.Resolve(sessionAgent(pane, "claude", "id", "11111111-1111-1111-1111-111111111111")); ok {
		t.Fatal("Resolve found a transcript that does not exist")
	}

	const restarted = "22222222-2222-2222-2222-222222222222"
	path := filepath.Join(home, ".claude", "projects", "-tmp-herdr-accept", restarted+".jsonl")
	writeFixture(t, path)

	got, ok := r.Resolve(sessionAgent(pane, "claude", "id", restarted))
	if !ok || got != path {
		t.Fatalf("Resolve for the new session = %q, %v, want %q", got, ok, path)
	}
}

func TestResolveKeepsPanesApart(t *testing.T) {
	home, claudePath, codexPath := fixtureHome(t)
	r := newResolver(t, home)

	if got, _ := r.Resolve(sessionAgent("w1:p1", "claude", "id", claudeSession)); got != claudePath {
		t.Fatalf("claude pane resolved to %q", got)
	}
	if got, _ := r.Resolve(sessionAgent("w1:p2", "codex", "id", codexSession)); got != codexPath {
		t.Fatalf("codex pane resolved to %q", got)
	}
	if got, _ := r.Resolve(sessionAgent("w1:p1", "claude", "id", claudeSession)); got != claudePath {
		t.Fatalf("claude pane resolved to %q after the codex one was cached", got)
	}
}

func TestResolveDefaultsToTheUserHomeDirectory(t *testing.T) {
	home, claudePath, _ := fixtureHome(t)
	t.Setenv("HOME", home)

	r, err := NewTranscriptResolver()
	if err != nil {
		t.Fatalf("NewTranscriptResolver: %v", err)
	}
	got, ok := r.Resolve(sessionAgent("w1:p1", "claude", "id", claudeSession))
	if !ok || got != claudePath {
		t.Fatalf("Resolve = %q, %v, want %q", got, ok, claudePath)
	}
}

func TestResolveIsSafeForConcurrentUse(t *testing.T) {
	home, claudePath, codexPath := fixtureHome(t)
	r := newResolver(t, home)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			a := sessionAgent("w1:p1", "claude", "id", claudeSession)
			want := claudePath
			if i%2 == 1 {
				a = sessionAgent("w1:p2", "codex", "id", codexSession)
				want = codexPath
			}
			if got, ok := r.Resolve(a); !ok || got != want {
				t.Errorf("Resolve = %q, %v, want %q", got, ok, want)
			}
		}(i)
	}
	wg.Wait()
}
