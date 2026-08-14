package cards

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Feishu card schema 2.0 tags and enumerations. They are constants so that a
// typo is a compile error in one place rather than a card the app renders as
// an empty grey bubble.
const (
	schemaVersion = "2.0"

	tagPlainText = "plain_text"
	tagMarkdown  = "markdown"
	tagColumnSet = "column_set"
	tagColumn    = "column"
	tagButton    = "button"
	tagHR        = "hr"

	// behaviorCallback makes a press come back over the WebSocket as
	// card.action.trigger, carrying value verbatim (G16).
	behaviorCallback = "callback"

	// Header colours. Red is the only one that means "a human is blocking a
	// machine right now"; the disarmed replacements deliberately do not use it,
	// so a glance down the chat shows which cards are still live.
	templateBlocked  = "red"
	templateResolved = "grey"
	templateExpired  = "yellow"
	// templateDone marks a finished agent: nothing is stopped, nothing is
	// waiting, and every button on that card is inert. Green is the one colour
	// in this chat that means "you can read this later".
	templateDone = "green"
	// templateList is deliberately NOT red even when an agent on it is blocked.
	// Red is this chat's mark for "a card whose buttons can still send a key
	// right now"; the picker never sends one, and reusing red there would cost
	// the reader the glance that tells a live card from a spent one (G17).
	// A blocked agent is called out by its row instead: 🔴, and sorted first.
	templateList = "blue"

	// btnNeutral is used for every numbered answer, including "1. Yes".
	// Feishu's primary style is the visually loudest thing on the card, and the
	// entry it would highlight is usually the approval — exactly the tap this
	// product must not encourage on a phone (S2 §8).
	btnNeutral = "default"
	// btnDanger marks Esc: the one key that always backs out safely (G2).
	btnDanger = "danger"
	// btnCurrent marks the row that is already selected. It is the loud style,
	// which is forbidden for an answer button because the entry it would
	// highlight is usually the approval (S2 §8) — but nothing styled this way
	// sends a key: an ActSelect press only changes where the NEXT thing the user
	// types goes, so the loudest thing on the picker is a statement of fact
	// ("your typing lands here"), not an invitation to approve something.
	btnCurrent = "primary"
)

// maxButtonLabel is how many runes of an option's label reach the button.
//
// Claude's second option runs to 60+ characters ("Yes, and don't ask again for
// touch commands in /tmp/herdr-accept"); at phone width four such buttons
// would each render as an unreadable sliver. The full text stays visible in
// the card body, which is the copy the user is meant to read before tapping.
const maxButtonLabel = 22

// maxSummary bounds the notification-bar preview.
const maxSummary = 60

// maxRowTitle bounds an agent's own task description on a picker row.
//
// Claude's terminal_title_stripped is a whole sentence ("Create hello.txt with
// touch", G8). Five of those at full length turn the list into a wall of prose,
// and the list exists to be scanned in one glance for the agent that needs a
// human.
const maxRowTitle = 48

type card struct {
	Schema string     `json:"schema"`
	Config cardConfig `json:"config"`
	Header cardHeader `json:"header"`
	Body   cardBody   `json:"body"`
}

type cardConfig struct {
	// UpdateMulti keeps the card updatable in place, which is how an actioned
	// card is disarmed (G17).
	UpdateMulti bool         `json:"update_multi"`
	Summary     *cardSummary `json:"summary,omitempty"`
}

// cardSummary is the one line the phone shows in the notification banner and
// the chat list, where the card itself is not rendered at all.
type cardSummary struct {
	Content string `json:"content"`
}

type cardHeader struct {
	Title    plainText  `json:"title"`
	Subtitle *plainText `json:"subtitle,omitempty"`
	Template string     `json:"template"`
}

type plainText struct {
	Tag     string `json:"tag"`
	Content string `json:"content"`
}

type cardBody struct {
	Elements []any `json:"elements"`
}

type markdownElement struct {
	Tag     string `json:"tag"`
	Content string `json:"content"`
}

// hrElement is the rule drawn between two agents on the picker. Rows there are
// two lines of text followed by two buttons, and without a separator the eye
// reads the buttons of one agent as belonging to the row below them — which on
// this card decides which agent the next thing you type reaches.
type hrElement struct {
	Tag string `json:"tag"`
}

type columnSet struct {
	Tag string `json:"tag"`
	// FlexMode "flow" lets the row wrap. Four buttons side by side on a phone
	// would otherwise be squeezed until every label is an ellipsis.
	FlexMode          string   `json:"flex_mode"`
	HorizontalSpacing string   `json:"horizontal_spacing"`
	Columns           []column `json:"columns"`
}

type column struct {
	Tag      string `json:"tag"`
	Width    string `json:"width"`
	Elements []any  `json:"elements"`
}

type buttonElement struct {
	Tag       string     `json:"tag"`
	Text      plainText  `json:"text"`
	Type      string     `json:"type"`
	Behaviors []behavior `json:"behaviors"`
}

// behavior carries the Decision. Value is a Decision rather than a map so that
// the wire shape is exactly the contract's json tags: a flat object of scalars,
// which Feishu hands back verbatim ({act:key key:1 pane:w1:p1}, measured G16).
type behavior struct {
	Type  string   `json:"type"`
	Value Decision `json:"value"`
}

func newMarkdown(format string, args ...any) markdownElement {
	return markdownElement{Tag: tagMarkdown, Content: fmt.Sprintf(format, args...)}
}

func newHR() hrElement { return hrElement{Tag: tagHR} }

// newButton wraps one Decision in a pressable button.
func newButton(text, style string, d Decision) buttonElement {
	return buttonElement{
		Tag:       tagButton,
		Text:      plainText{Tag: tagPlainText, Content: text},
		Type:      style,
		Behaviors: []behavior{{Type: behaviorCallback, Value: d}},
	}
}

// newColumnSet lays buttons out as one wrapping row.
func newColumnSet(buttons []buttonElement) columnSet {
	cols := make([]column, 0, len(buttons))
	for _, b := range buttons {
		cols = append(cols, column{Tag: tagColumn, Width: "auto", Elements: []any{b}})
	}
	return columnSet{
		Tag:               tagColumnSet,
		FlexMode:          "flow",
		HorizontalSpacing: "8px",
		Columns:           cols,
	}
}

func newHeader(title, subtitle, template string) cardHeader {
	h := cardHeader{
		Title:    plainText{Tag: tagPlainText, Content: title},
		Template: template,
	}
	if subtitle != "" {
		h.Subtitle = &plainText{Tag: tagPlainText, Content: subtitle}
	}
	return h
}

// render serialises a card for lark.Out.Card.
func render(c card, what string) (string, error) {
	b, err := json.Marshal(c)
	if err != nil {
		// Unreachable with these types, but a card that failed to serialise
		// must never be returned as an empty string that Feishu would reject
		// with a message the user cannot act on.
		return "", fmt.Errorf("cards: marshal %s card: %w", what, err)
	}
	return string(b), nil
}

// codeBlock wraps already-cropped screen text in a fence long enough to
// survive backticks inside it.
//
// The text is emitted exactly as the screen package produced it: it was
// CROPPED to phone width, not wrapped, because re-wrapping a TUI destroys the
// column alignment that makes it legible (screen.DefaultMaxCols, G5).
func codeBlock(text string) string {
	longest, run := 0, 0
	for _, r := range text {
		if r != '`' {
			run = 0
			continue
		}
		run++
		if run > longest {
			longest = run
		}
	}
	n := 3
	if longest >= n {
		n = longest + 1
	}
	f := strings.Repeat("`", n)
	return f + "\n" + text + "\n" + f
}

// truncate cuts s to at most limit runes, marking that it did.
func truncate(s string, limit int) string {
	if limit < 2 || utf8.RuneCountInString(s) <= limit {
		return s
	}
	return string([]rune(s)[:limit-1]) + "…"
}
