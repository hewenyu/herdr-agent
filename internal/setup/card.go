package setup

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

// Feishu card schema 2.0 tags, matching internal/cards. They are spelled out
// here rather than imported because internal/cards builds cards ABOUT AN AGENT
// — every one of its constructors needs an agents.Agent and a guard — and this
// card is about nothing but itself.
const (
	cardSchema   = "2.0"
	tagPlainText = "plain_text"
	tagMarkdown  = "markdown"
	tagColumnSet = "column_set"
	tagColumn    = "column"
	tagButton    = "button"

	// behaviorCallback makes a press come back over the WebSocket as
	// card.action.trigger, carrying value verbatim (G16).
	behaviorCallback = "callback"

	// actVerify is this card's only action. It is deliberately NOT one of the
	// cards package's actions: if this card is pressed months later, the
	// running bridge decodes it, finds an action it does not know and no pane,
	// and drops it — instead of finding a well-formed decision it might act on.
	actVerify = "setup-verify"
)

// verifyValue is what the button carries back.
type verifyValue struct {
	Act   string `json:"act"`
	Nonce string `json:"n"`
}

// newNonce returns the single-use token that ties a press to this run.
func newNonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("setup: generate nonce: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}

// buildVerifyCard renders the one-button card whose press proves the
// card.action.trigger path end to end.
func buildVerifyCard(nonce string, now time.Time) (string, error) {
	if nonce == "" {
		return "", fmt.Errorf("setup: refusing to build a verification card with no nonce")
	}
	body := []any{
		map[string]any{
			"tag": tagMarkdown,
			"content": "**最后一步 · one tap left**\n\n" +
				"Press the button below. It sends nothing to any agent — it only proves that " +
				"card.action.trigger reaches this machine, which is the half of the round trip " +
				"a plain message cannot test.",
		},
		map[string]any{
			"tag":       tagColumnSet,
			"flex_mode": "flow",
			"columns": []any{
				map[string]any{
					"tag":   tagColumn,
					"width": "auto",
					"elements": []any{
						map[string]any{
							"tag":  tagButton,
							"text": map[string]any{"tag": tagPlainText, "content": "确认 · Confirm setup"},
							"type": "primary",
							"behaviors": []any{
								map[string]any{
									"type":  behaviorCallback,
									"value": verifyValue{Act: actVerify, Nonce: nonce},
								},
							},
						},
					},
				},
			},
		},
		map[string]any{
			"tag":     tagMarkdown,
			"content": fmt.Sprintf("_setup · %s_", now.Format("2006-01-02 15:04:05 MST")),
		},
	}
	return render(map[string]any{
		"schema": cardSchema,
		// update_multi keeps the card editable in place, which is how it is
		// disarmed when the run ends (G17).
		"config": map[string]any{
			"update_multi": true,
			"summary":      map[string]any{"content": "herdr-agent setup: one tap to finish"},
		},
		"header": map[string]any{
			"title":    map[string]any{"tag": tagPlainText, "content": "herdr-agent · verify"},
			"template": "blue",
		},
		"body": map[string]any{"elements": body},
	})
}

// buildDisarmedCard is the replacement posted when the run stops waiting.
//
// It is posted whether the press arrived or not. A card left in chat history
// with a live-looking button is the loaded gun of G17: this one could only ever
// have been answered by a process that has since exited, and saying so is
// better than leaving a button that does nothing and explains nothing.
func buildDisarmedCard(outcome string, at time.Time) (string, error) {
	return render(map[string]any{
		"schema": cardSchema,
		"config": map[string]any{"update_multi": true},
		"header": map[string]any{
			"title":    map[string]any{"tag": tagPlainText, "content": "herdr-agent · verify"},
			"template": "grey",
		},
		"body": map[string]any{"elements": []any{
			map[string]any{
				"tag":     tagMarkdown,
				"content": outcome + "\n\n_" + at.Format("2006-01-02 15:04:05 MST") + "_",
			},
		}},
	})
}

func render(card map[string]any) (string, error) {
	b, err := json.Marshal(card)
	if err != nil {
		return "", fmt.Errorf("setup: marshal card: %w", err)
	}
	return string(b), nil
}
