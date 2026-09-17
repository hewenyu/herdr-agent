package codexui

import (
	"slices"
	"strings"
	"testing"
)

const trustDialog = `> You are in /home/yueban/herder-agent-code/pelican-bike

  Do you trust the contents of this directory? Working with untrusted contents
  comes with higher risk of prompt injection.
  Trusting the directory allows project-local config, hooks, and exec policies to load.

› 1. Yes, continue
  2. No, quit

  Press enter to continue
`

const welcome = "  ,*=*.~**+\"|*~:\"~*=_\n     _//|;+*|^*\"`  `\"*=*.\"|*,\n\n  Welcome to Codex, OpenAI's command-line coding agent\n\n"

func TestParseTrustScreen(t *testing.T) {
	for _, preamble := range []string{"", welcome} {
		for _, selected := range []string{"yes", "no"} {
			t.Run(preamble+selected, func(t *testing.T) {
				raw, keys := preamble+trustDialog, []string{"enter"}
				if selected == "no" {
					raw = strings.ReplaceAll(raw, "› 1.", "  1.")
					raw = strings.ReplaceAll(raw, "  2.", "› 2.")
					keys = []string{"up", "enter"}
				}
				got, ok := ParseTrustScreen(raw)
				if !ok || got.Directory != "/home/yueban/herder-agent-code/pelican-bike" || !slices.Equal(got.ConfirmKeys, keys) {
					t.Fatalf("parsed = %+v, %v; want native trust prompt with keys %v", got, ok, keys)
				}
			})
		}
	}
}

func TestParseTrustScreenRejectsExamplesAndIncompleteMenus(t *testing.T) {
	for name, raw := range map[string]string{
		"quoted dialog":      "Here is an example:\n" + trustDialog,
		"quoted welcome":     "Here is an example:\n" + welcome + trustDialog,
		"Chinese quotation":  "示例：\n" + welcome + trustDialog,
		"later composer":     welcome + trustDialog + "› Tell me what to do\n",
		"missing footer":     strings.ReplaceAll(trustDialog, "Press enter to continue", ""),
		"no highlight":       strings.ReplaceAll(trustDialog, "›", " "),
		"different question": strings.ReplaceAll(trustDialog, "Do you trust the contents of this directory?", "Allow this command?"),
		"missing directory":  strings.ReplaceAll(trustDialog, "/home/yueban/herder-agent-code/pelican-bike", ""),
	} {
		t.Run(name, func(t *testing.T) {
			if got, ok := ParseTrustScreen(raw); ok || got.Directory != "" || len(got.ConfirmKeys) != 0 {
				t.Fatalf("unsafe/incomplete prompt recognized: %+v, %v", got, ok)
			}
		})
	}
}

func TestParseTrustScreenReconstructsWrappedDirectory(t *testing.T) {
	want := "/home/yueban/herder-agent-code/a-long-project/pelican-bike"
	raw := strings.ReplaceAll(trustDialog, "/home/yueban/herder-agent-code/pelican-bike", want)
	lines := strings.Split(raw, "\n")
	lines[0] = lines[0][:53] + "\n" + lines[0][53:]
	got, ok := ParseTrustScreen(strings.Join(lines, "\n"))
	if !ok || got.Directory != want {
		t.Fatalf("wrapped directory = %+v, %v; want %q", got, ok, want)
	}
}
