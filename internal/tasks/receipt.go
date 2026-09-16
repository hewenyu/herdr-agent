package tasks

import (
	"crypto/rand"
	"encoding/hex"
)

// newReceiptMarker names one durable initial prompt. Randomness prevents an
// older terminal line or an agent suggestion from predicting its receipt.
func newReceiptMarker() (string, error) {
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", err
	}
	return "HERDR_RECEIPT_" + hex.EncodeToString(token[:]), nil
}

// promptWithReceipt keeps the marker at the end, where it remains visible when
// a long task scrolls above the terminal viewport. It proves delivery only;
// task completion still requires the owner's acceptance.
func promptWithReceipt(r Record) string {
	return initialPrompt(r) + "\n\n投递标识（无需复述）：\n" + r.PromptReceipt
}
