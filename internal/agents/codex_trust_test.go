package agents

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

const codexTrustScreen = `> You are in /tmp/example

  Do you trust the contents of this directory? Working
  with untrusted contents comes with higher risk of
  prompt injection. Trusting the directory allows
  project-local config, hooks, and exec policies to
  load.

› 1. Yes, continue
  2. No, quit

  Press enter to continue
`

func TestCodexTrustCardConfirmsTheChosenYes(t *testing.T) {
	for _, selected := range []string{"yes", "no"} {
		t.Run(selected, func(t *testing.T) {
			text, want := codexTrustScreen, []string{"enter"}
			if selected == "no" {
				text = strings.ReplaceAll(text, "› 1.", "  1.")
				text = strings.ReplaceAll(text, "  2.", "› 2.")
				want = []string{"up", "enter"}
			}
			h := newInputHarness(t, &fakePane{kind: "codex", status: StatusBlocked, seq: 3, screen: text})
			g := h.guard()
			g.MenuChoice = true
			if _, err := h.ctrl.SendKey(context.Background(), g, "1"); err != nil {
				t.Fatal(err)
			}
			if !equalStrings(h.pane.sentKeys(), want) || h.client.Count("agent.send_keys") != 1 {
				t.Fatalf("confirmation keys = %v, want one write of %v", h.pane.sentKeys(), want)
			}
		})
	}
}

func TestCodexTrustDoesNotAddConfirmationToOtherInputs(t *testing.T) {
	for _, tc := range []struct {
		name, kind, key, text string
		card                  bool
	}{
		{"raw key", "codex", "1", codexTrustScreen, false},
		{"decline", "codex", "2", codexTrustScreen, true},
		{"escape", "codex", "esc", codexTrustScreen, true},
		{"claude", "claude", "1", codexTrustScreen, true},
		{"other menu", "codex", "1", strings.ReplaceAll(codexTrustScreen, "Do you trust the contents of this directory?", "Allow this command?"), true},
		{"printed example", "codex", "1", "Here is an example:\n" + codexTrustScreen, true},
		{"stale screen text", "codex", "1", codexTrustScreen + "› Tell me what to do\n", true},
		{"no selection", "codex", "1", strings.ReplaceAll(codexTrustScreen, "›", " "), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newInputHarness(t, &fakePane{kind: tc.kind, status: StatusBlocked, seq: 3, screen: tc.text})
			g := h.guard()
			g.MenuChoice = tc.card
			if _, err := h.ctrl.SendKey(context.Background(), g, tc.key); err != nil {
				t.Fatal(err)
			}
			if !equalStrings(h.pane.sentKeys(), []string{tc.key}) {
				t.Fatalf("unexpected confirmation keys: %v", h.pane.sentKeys())
			}
		})
	}
}

func TestCodexTrustRechecksTheGuardAfterReadingTheMenu(t *testing.T) {
	h := newInputHarness(t, &fakePane{kind: "codex", status: StatusBlocked, seq: 3})
	h.client.OnAgentRead = func(context.Context, string, herdrapi.ReadSource, int) (string, error) {
		h.pane.mu.Lock()
		h.pane.status, h.pane.seq = StatusIdle, 4
		h.pane.mu.Unlock()
		return codexTrustScreen, nil
	}
	g := h.guard()
	g.MenuChoice = true
	if _, err := h.ctrl.SendKey(context.Background(), g, "1"); !errors.Is(err, ErrNoLongerBlocked) {
		t.Fatalf("changed menu error = %v", err)
	}
	h.assertNoInput()
}

func TestCodexTrustNeedsACompleteReadableMenu(t *testing.T) {
	for _, broken := range []string{"read error", "truncated"} {
		t.Run(broken, func(t *testing.T) {
			h := newInputHarness(t, &fakePane{kind: "codex", status: StatusBlocked, seq: 3})
			h.client.OnAgentReadFull = func(context.Context, string, herdrapi.ReadSource, int) (string, bool, error) {
				if broken == "read error" {
					return "", false, errors.New("read failed")
				}
				return codexTrustScreen, true, nil
			}
			g := h.guard()
			g.MenuChoice = true
			_, err := h.ctrl.SendKey(context.Background(), g, "1")
			if broken == "read error" {
				if err == nil {
					t.Fatal("unreadable menu was confirmed")
				}
				h.assertNoInput()
			} else if err != nil || !equalStrings(h.pane.sentKeys(), []string{"1"}) {
				t.Fatalf("truncated menu used confirmation: %v, %v", h.pane.sentKeys(), err)
			}
		})
	}
}

func TestCodexTrustConfirmationReadsVisibleMenuWithWelcomeBanner(t *testing.T) {
	h := newInputHarness(t, &fakePane{kind: "codex", status: StatusBlocked, seq: 3})
	h.client.OnAgentReadFull = func(_ context.Context, _ string, src herdrapi.ReadSource, _ int) (string, bool, error) {
		if src != herdrapi.SourceVisible {
			t.Fatalf("confirmation read source = %q, want visible", src)
		}
		return "  ,*=*.~**+\n\n  Welcome to Codex, OpenAI's command-line coding agent\n\n" + codexTrustScreen, false, nil
	}
	g := h.guard()
	g.MenuChoice = true
	if _, err := h.ctrl.SendKey(context.Background(), g, "1"); err != nil {
		t.Fatal(err)
	}
	if !equalStrings(h.pane.sentKeys(), []string{"enter"}) {
		t.Fatalf("confirmation keys = %v, want enter", h.pane.sentKeys())
	}
}

func TestCodexTrustOnScreenVetoesPromptDespiteIdleStatus(t *testing.T) {
	h := newInputHarness(t, &fakePane{kind: "codex", status: StatusIdle, seq: 3, screen: codexTrustScreen})
	d, err := h.ctrl.Say(context.Background(), h.guard(), "create the requested animation")
	if !errors.Is(err, ErrDialogOnScreen) || d.Acked || d.Attempts != 0 {
		t.Fatalf("delivery = %+v, err = %v; want refused before any input", d, err)
	}
	h.assertNoInput()
}
