package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/hewenyu/herdr-agent/internal/agents"
)

// cmdTranscript prints the path of the agent's own transcript file.
func cmdTranscript(ctx context.Context, d *deps, args []string) error {
	fs := newFlags(d, "transcript", "<pane>")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	pane, err := onePane(fs.Args(), "transcript")
	if err != nil {
		return err
	}
	if d.Resolver == nil {
		// wire() tolerates a machine with no resolvable home directory so that
		// ls and key keep working; this is the one command that cannot.
		return errors.New("transcript: no home directory, so ~/.claude and ~/.codex cannot be searched")
	}

	info, err := d.Client.AgentGet(ctx, pane)
	if err != nil {
		return fmt.Errorf("agent.get %s: %w", pane, err)
	}
	// Only the fields Resolve reads are copied. agents.fromWire is unexported,
	// and the resolver keys its cache on (pane_id, session id).
	a := agents.Agent{
		PaneID:     info.PaneID,
		Kind:       derefStr(info.Agent),
		Status:     statusOf(info.AgentStatus),
		SessionRef: info.AgentSession,
	}

	path, ok := d.Resolver.Resolve(a)
	if ok {
		fmt.Fprintln(d.Out, path)
		return nil
	}
	return noTranscript(d, a)
}

// noTranscript explains the two ways a transcript can legitimately be missing.
// Neither is a bug in the bridge, and both are things the operator can fix or
// wait out, so they are spelled out rather than reported as "not found".
func noTranscript(d *deps, a agents.Agent) error {
	if a.SessionRef == nil || a.SessionRef.Value == "" {
		fmt.Fprintf(d.Err, `%s has no agent_session yet.
herdr only reports one once the agent's SessionStart hook has fired (G8):
  claude: after the trust-directory prompt in that pane has been accepted
  codex:  after "herdr integration install codex" AND pressing t inside codex
          once to trust the hook — until then agent_session stays empty forever
Run "herdr-agent doctor" to check the hooks are installed.
`, orDash(a.PaneID))
		return fmt.Errorf("no transcript for %s: agent has no session reference yet", orDash(a.PaneID))
	}
	fmt.Fprintf(d.Err, `%s reports session %s (%s) but no matching file is on disk yet.
Transcripts are located by FILENAME, not by rebuilding the directory name (G8):
  claude: ~/.claude/projects/*/%s.jsonl
  codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-*-%s.jsonl
The file appears shortly after the first turn; try again in a moment.
`, a.PaneID, a.SessionRef.Value, orDash(a.SessionRef.Kind), a.SessionRef.Value, a.SessionRef.Value)
	return fmt.Errorf("no transcript file found for %s (session %s)", a.PaneID, a.SessionRef.Value)
}
