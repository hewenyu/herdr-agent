package tasks

import (
	"regexp"
	"strings"
	"testing"
)

func TestReceiptMarkerIsDistinctAndCarries128Bits(t *testing.T) {
	format := regexp.MustCompile(`^HERDR_RECEIPT_[0-9a-f]{32}$`)
	seen := map[string]bool{}
	for range 32 {
		marker, err := newReceiptMarker()
		if err != nil {
			t.Fatal(err)
		}
		if !format.MatchString(marker) || seen[marker] {
			t.Fatalf("invalid or reused receipt marker: %q", marker)
		}
		seen[marker] = true
	}
}

func TestReceiptKeepsFullProjectPromptAndEndsWithPersistedMarker(t *testing.T) {
	marker, err := newReceiptMarker()
	if err != nil {
		t.Fatal(err)
	}
	r := Record{Project: "demo", Path: "/project", Directories: []string{"/project", "/shared"}, Title: strings.Repeat("完整保留任务要求。", 500), PromptReceipt: marker}
	prompt := promptWithReceipt(r)
	if !strings.HasPrefix(prompt, initialPrompt(r)) || !strings.Contains(prompt, r.Title) || !strings.Contains(prompt, r.Path) || !strings.Contains(prompt, r.Directories[1]) {
		t.Fatal("receipt replaced or truncated project context and user requirements")
	}
	if !strings.HasSuffix(prompt, "\n\n投递标识（无需复述）：\n"+marker) || strings.Count(prompt, marker) != 1 {
		t.Fatal("receipt is not a unique suffix of the submitted prompt")
	}
	if promptWithReceipt(r) != prompt {
		t.Fatal("retry changed the persisted prompt receipt")
	}
}
