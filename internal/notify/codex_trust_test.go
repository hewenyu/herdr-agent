package notify

import (
	"context"
	"errors"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/cards"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

const codexTrustDialog = `  ,*=*.~**+

  Welcome to Codex, OpenAI's command-line coding agent

> You are in /home/yueban/herder-agent-code/pelican-bike

  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.
  Trusting the directory allows project-local config, hooks, and exec policies to load.

› 1. Yes, continue
  2. No, quit

  Press enter to continue
`

func TestCodexStartupCardUsesCompleteVisibleTrustMenu(t *testing.T) {
	for _, mode := range []string{"visible", "truncated", "read-error", "other-menu", "established-session", "launch-pending"} {
		t.Run(mode, func(t *testing.T) {
			client := &herdrapi.RecordingClient{
				OnAgentReadFull: func(_ context.Context, _ string, src herdrapi.ReadSource, _ int) (string, bool, error) {
					if src == herdrapi.SourceDetection {
						return "detection buffer has no menu", false, nil
					}
					if mode == "read-error" {
						return "", false, errors.New("read failed")
					}
					if mode == "other-menu" {
						return "Choose a command\n1. Yes\n2. No", false, nil
					}
					return codexTrustDialog, mode == "truncated", nil
				},
			}
			ex, err := screen.NewExtractor(client)
			if err != nil {
				t.Fatal(err)
			}
			h := newHarnessEx(t, ex)
			transition := blockedAt("w1:p1", 1)
			transition.Agent.Kind = "codex"
			if mode == "established-session" || mode == "launch-pending" {
				transition.Agent.SessionRef = &herdrapi.SessionRef{Value: "session"}
				transition.Agent.Interactive = true
				transition.Agent.LaunchPend = mode == "launch-pending"
			}
			h.send(transition)
			got := h.sink.recorded()
			if len(got) != 1 {
				t.Fatalf("pushes = %d, want 1", len(got))
			}
			opts := cards.ParseOptions(got[0].screen)
			if mode == "visible" || mode == "launch-pending" {
				if len(opts) != 2 || opts[0].Key != "1" || opts[1].Key != "2" {
					t.Fatalf("startup card lost trust choices: %+v", opts)
				}
			} else if len(opts) != 0 || got[0].screen.Text() != "detection buffer has no menu" {
				t.Fatalf("invalid startup view replaced detection: %q, %+v", got[0].screen.Text(), opts)
			}
		})
	}
}
