package tasks

import (
	"net/url"
	"regexp"
	"strings"
)

var descriptionReference = regexp.MustCompile(`^( {0,3})\[([^\]\n]+)\]:([^\n]*)$`)

// descriptionText retains link labels and destinations while making links that
// Feishu tasks reject ordinary text. Agent output commonly links local files;
// keeping that Markdown would reject the entire progress/result update.
func descriptionText(text string) string {
	var b strings.Builder
	for i := 0; i < len(text); {
		if i == 0 || text[i-1] == '\n' {
			end := descriptionLineEnd(text, i)
			if marker, length, _, ok := descriptionFence(text[i:end]); ok {
				end = descriptionFenceEnd(text, end, marker, length)
				b.WriteString(text[i:end])
				i = end
				continue
			}
			if parts := descriptionReference.FindStringSubmatch(text[i:end]); parts != nil && !validDescriptionLink(parts[3]) {
				b.WriteString(parts[1] + parts[2] + "：" + strings.TrimSpace(parts[3]))
				i = end
				continue
			}
		}
		if text[i] == '`' {
			length := descriptionRun(text, i, '`')
			end := i + length
			for j := end; j < len(text); {
				if text[j] != '`' {
					j++
					continue
				}
				run := descriptionRun(text, j, '`')
				if run == length {
					end = j + run
					break
				}
				j += run
			}
			b.WriteString(text[i:end])
			i = end
			continue
		}
		start := i
		if text[i] == '!' && i+1 < len(text) && text[i+1] == '[' {
			start++
		}
		if text[start] == '[' {
			labelEnd := descriptionDelimiter(text, start, '[', ']')
			if labelEnd >= 0 && labelEnd+1 < len(text) && text[labelEnd+1] == '(' {
				end := descriptionDelimiter(text, labelEnd+1, '(', ')')
				if end >= 0 {
					target := text[labelEnd+2 : end]
					if validDescriptionLink(target) {
						b.WriteString(text[i : end+1])
					} else {
						b.WriteString(text[start+1 : labelEnd])
						b.WriteString("（" + strings.TrimSpace(target) + "）")
					}
					i = end + 1
					continue
				}
			}
		}
		if text[i] == '<' {
			if end := strings.IndexByte(text[i+1:], '>'); end >= 0 {
				end += i + 1
				target := text[i+1 : end]
				if u, err := url.Parse(target); err == nil && u.Scheme != "" && !validDescriptionLink(target) {
					b.WriteString(target)
					i = end + 1
					continue
				}
			}
		}
		b.WriteByte(text[i])
		i++
	}
	return b.String()
}

func descriptionLineEnd(text string, start int) int {
	if end := strings.IndexByte(text[start:], '\n'); end >= 0 {
		return start + end
	}
	return len(text)
}

func descriptionRun(text string, start int, marker byte) int {
	end := start
	for end < len(text) && text[end] == marker {
		end++
	}
	return end - start
}

func descriptionFence(line string) (marker byte, length int, info string, ok bool) {
	trimmed := strings.TrimLeft(line, " ")
	if len(line)-len(trimmed) > 3 || len(trimmed) < 3 || (trimmed[0] != '`' && trimmed[0] != '~') {
		return 0, 0, "", false
	}
	marker = trimmed[0]
	length = descriptionRun(trimmed, 0, marker)
	info = strings.TrimSpace(trimmed[length:])
	return marker, length, info, length >= 3 && (marker != '`' || !strings.ContainsRune(info, '`'))
}

func descriptionFenceEnd(text string, end int, marker byte, length int) int {
	for end < len(text) {
		start := end + 1
		end = descriptionLineEnd(text, start)
		if closeMarker, closeLength, info, ok := descriptionFence(text[start:end]); ok && closeMarker == marker && closeLength >= length && info == "" {
			return end
		}
	}
	return len(text)
}

func validDescriptionLink(target string) bool {
	target = strings.TrimSpace(target)
	if strings.HasPrefix(target, "<") {
		end := strings.IndexByte(target, '>')
		if end < 0 {
			return false
		}
		target = target[1:end]
	} else if end := strings.IndexAny(target, " \t\r\n"); end >= 0 {
		// Markdown may include an optional title after its destination.
		target = target[:end]
	}
	u, err := url.Parse(target)
	return err == nil && u.Host != "" && (u.Scheme == "http" || u.Scheme == "https" || u.Scheme == "applink")
}

func descriptionDelimiter(text string, start int, open, close byte) int {
	depth := 0
	for i := start; i < len(text); i++ {
		switch text[i] {
		case '\\':
			i++
		case open:
			depth++
		case close:
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}
