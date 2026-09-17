package mirror

import (
	"encoding/json"
	"strconv"
	"strings"
)

// These fields describe an operation without exposing file contents or scripts
// stored under an unknown single-field payload.
var codexArgKeys = []string{"command", "cmd", "file_path", "notebook_path", "pattern", "path", "query", "url"}

func codexObjectArg(name string, obj map[string]any) string {
	for _, key := range codexArgKeys {
		if arg, ok := stringish(obj[key]); ok {
			return arg
		}
	}
	if name == "apply_patch" || name == "functions.apply_patch" {
		if patch, ok := obj["patch"].(string); ok {
			return patchFiles(patch)
		}
	}
	return ""
}

func patchFiles(patch string) string {
	if !strings.HasPrefix(strings.TrimSpace(patch), "*** Begin Patch\n") {
		return ""
	}
	var paths []string
	for _, line := range strings.Split(patch, "\n") {
		for _, prefix := range []string{"*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "} {
			if path, ok := strings.CutPrefix(line, prefix); ok && strings.TrimSpace(path) != "" {
				paths = append(paths, strings.TrimSpace(path))
			}
		}
	}
	return strings.Join(paths, ", ")
}

type scriptToken struct {
	text   string
	quoted bool
}

// codexScriptCalls recognizes the documented tools.NAME(...) wrapper only.
// It does not evaluate JavaScript or follow variable aliases. The small lexer
// keeps strings and comments opaque, so code quoted inside a patch or command
// cannot masquerade as another operation. Unsupported expressions lose their
// argument, rather than falling back to displaying the script.
func codexScriptCalls(script string) []string {
	tokens := scriptTokens(script)
	var calls []string
	for i := 0; i+3 < len(tokens); i++ {
		if tokens[i].quoted || tokens[i].text != "tools" || tokens[i+1].text != "." ||
			tokens[i+2].quoted || !scriptIdentifier(tokens[i+2].text) || tokens[i+3].text != "(" {
			continue
		}
		if i > 0 && tokens[i-1].text == "." {
			continue // e.g. an unrelated object.tools method
		}
		name := tokens[i+2].text
		arg := ""
		start := i + 4
		if start < len(tokens) {
			if tokens[start].quoted && start+1 < len(tokens) && tokens[start+1].text == ")" && name == "apply_patch" {
				arg = patchFiles(tokens[start].text)
			} else if tokens[start].text == "{" {
				arg = codexObjectArg(name, scriptObject(tokens[start:]))
			}
		}
		calls = append(calls, toolSummary(name, arg))
	}
	return calls
}

// scriptObject accepts JSON-compatible literals with JavaScript's optional
// quoted keys and trailing commas. Expressions, shorthand properties and
// interpolated values fail decoding instead of producing a guessed argument.
func scriptObject(tokens []scriptToken) map[string]any {
	var literal strings.Builder
	depth := 0
	for i := 0; i < len(tokens); i++ {
		t := tokens[i]
		if t.quoted || (scriptIdentifier(t.text) && i+1 < len(tokens) && tokens[i+1].text == ":") {
			quoted, _ := json.Marshal(t.text)
			literal.Write(quoted)
			continue
		}
		if t.text == "," && i+1 < len(tokens) && (tokens[i+1].text == "}" || tokens[i+1].text == "]") {
			continue
		}
		literal.WriteString(t.text)
		if !t.quoted {
			switch t.text {
			case "{", "[", "(":
				depth++
			case "}", "]", ")":
				depth--
				if depth == 0 {
					return decodeObject(literal.String())
				}
			}
		}
	}
	return nil // an incomplete object is not reliable
}

func scriptIdentifier(s string) bool {
	if s == "" {
		return false
	}
	for i := range s {
		c := s[i]
		if c != '_' && c != '$' && !(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z') && !(i > 0 && c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

func scriptTokens(s string) []scriptToken {
	var tokens []scriptToken
	for i := 0; i < len(s); {
		i = skipSpace(s, i)
		if i == len(s) {
			break
		}
		if strings.HasPrefix(s[i:], "//") {
			end := strings.IndexByte(s[i:], '\n')
			if end < 0 {
				break
			}
			i += end + 1
			continue
		}
		if strings.HasPrefix(s[i:], "/*") {
			end := strings.Index(s[i+2:], "*/")
			if end < 0 {
				return nil
			}
			i += end + 4
			continue
		}
		if s[i] == '/' {
			// Distinguishing regular expressions from division requires a full
			// JavaScript grammar. Neither is needed for literal tool summaries.
			return nil
		}
		if s[i] == '"' || s[i] == '\'' || s[i] == '`' {
			value, size, ok := scriptString(s[i:])
			if !ok {
				return nil
			}
			tokens = append(tokens, scriptToken{text: value, quoted: true})
			i += size
			continue
		}
		end := i + 1
		if scriptIdentifier(s[i:end]) {
			for end < len(s) && (scriptIdentifier(s[end:end+1]) || s[end] >= '0' && s[end] <= '9') {
				end++
			}
		}
		tokens = append(tokens, scriptToken{text: s[i:end]})
		i = end
	}
	return tokens
}

func scriptString(s string) (string, int, bool) {
	quote := s[0]
	var value strings.Builder
	for i := 1; i < len(s); {
		if s[i] == quote {
			return value.String(), i + 1, true
		}
		if quote == '`' && strings.HasPrefix(s[i:], "${") {
			return "", 0, false // template interpolation is dynamic JavaScript
		}
		if s[i] != '\\' {
			value.WriteByte(s[i])
			i++
			continue
		}
		if i+1 < len(s) && (s[i+1] == quote || s[i+1] == '\n') {
			if s[i+1] != '\n' {
				value.WriteByte(quote)
			}
			i += 2
			continue
		}
		c, _, tail, err := strconv.UnquoteChar(s[i:], '"')
		if err != nil {
			return "", 0, false
		}
		value.WriteRune(c)
		i = len(s) - len(tail)
	}
	return "", 0, false
}
