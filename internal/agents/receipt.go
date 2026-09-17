package agents

import "strings"

// A managed prompt is sent in one AgentPrompt call. A fresh random suffix
// appearing in its echo can confirm that submission even when the first lines
// have scrolled away. Never relax ordinary human prose to a partial match.
func verifyReceiptEcho(lines []string, read bool, text, marker string, queued bool, before boxProbe) bool {
	const prefix = "HERDR_RECEIPT_"
	if !strings.HasPrefix(marker, prefix) || len(marker) != len(prefix)+32 {
		return false
	}
	for _, r := range marker[len(prefix):] {
		if !(r >= '0' && r <= '9') && !(r >= 'a' && r <= 'f') {
			return false
		}
	}
	if !strings.HasSuffix(strings.TrimSpace(text), marker) || strings.Count(text, marker) != 1 || !before.read {
		return false
	}
	// Include the input box in the pre-image check: an old queued copy or a
	// ghost suggestion must not be mistaken for this delivery.
	if echoHits(before.all, normalizeEcho(marker), false) != 0 {
		return false
	}
	return verifyEcho(lines, read, marker, queued, before)
}
