package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const ansiReset = "\x1b[0m"

var (
	linkRe        = regexp.MustCompile(`\[([^\]]+)\]\(([^)\s]+)\)`)
	fenceRe       = regexp.MustCompile("^\\s*```(.*)$")
	headingRe     = regexp.MustCompile(`^(#{1,6})\s+(.*)$`)
	quoteRe       = regexp.MustCompile(`^\s*>\s?(.*)$`)
	itemRe        = regexp.MustCompile(`^(\s*)([-*+]|\d+[.)])\s+(.*)$`)
	taskRe        = regexp.MustCompile(`^\[([ xX])\]\s+(.*)`)
	tableSepRe    = regexp.MustCompile(`^\s*\|[\s:|-]+\|\s*$`)
	placeholderRe = regexp.MustCompile("\x00([0-9]+)\x00")
)

func styled(text string, color bool, codes ...string) string {
	if !color || text == "" {
		return text
	}
	return strings.Join(codes, "") + text + ansiReset
}

func collapseSpace(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

// replaceCodeSpans replaces `code` runs, using the same backtick count to
// close as the run that opened them.
func replaceCodeSpans(text string, hold func(string) string) string {
	var out strings.Builder
	for i := 0; i < len(text); {
		if text[i] != '`' {
			out.WriteByte(text[i])
			i++
			continue
		}
		width := 0
		for i+width < len(text) && text[i+width] == '`' {
			width++
		}
		closeAt := -1
		for j := i + width; j < len(text); {
			if text[j] != '`' {
				j++
				continue
			}
			run := 0
			for j+run < len(text) && text[j+run] == '`' {
				run++
			}
			if run == width {
				closeAt = j
				break
			}
			j += run
		}
		if closeAt < 0 || closeAt == i+width {
			out.WriteString(text[i : i+width])
			i += width
			continue
		}
		out.WriteString(hold(collapseSpace(text[i+width : closeAt])))
		i = closeAt + width
	}
	return out.String()
}

func replaceLinks(text string, hold func(string) string, color bool) string {
	matches := linkRe.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return text
	}
	var out strings.Builder
	last := 0
	for _, match := range matches {
		out.WriteString(text[last:match[0]])
		label := text[match[2]:match[3]]
		url := text[match[4]:match[5]]
		switch {
		case !strings.HasPrefix(url, "http://") &&
			!strings.HasPrefix(url, "https://") &&
			!strings.HasPrefix(url, "mailto:"):
			out.WriteString(hold(label))
		case url == label:
			out.WriteString(hold(styled(label, color, "\x1b[4m")))
		default:
			shown := styled(url, color, "\x1b[2;4m")
			out.WriteString(hold(label + " (" + shown + ")"))
		}
		last = match[1]
	}
	out.WriteString(text[last:])
	return out.String()
}

func isWordByte(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func prevByte(s string, i int) byte {
	if i <= 0 {
		return 0
	}
	return s[i-1]
}

func nextByte(s string, i int) byte {
	if i >= len(s) {
		return 0
	}
	return s[i]
}

// replaceEmphasis replaces one delimiter kind. Go's regexp has no
// lookarounds or backreferences, so the scans are written out.
func replaceEmphasis(
	text, delim string,
	canOpen func(string, int) bool,
	canClose func(string, int) bool,
	apply func(string) string,
) string {
	if !strings.Contains(text, delim) {
		return text
	}
	var out strings.Builder
	for i := 0; i < len(text); {
		if strings.HasPrefix(text[i:], delim) && (canOpen == nil || canOpen(text, i)) {
			contentStart := i + len(delim)
			closeAt := -1
			for j := contentStart + 1; j+len(delim) <= len(text); j++ {
				if strings.HasPrefix(text[j:], delim) && (canClose == nil || canClose(text, j)) {
					closeAt = j
					break
				}
			}
			if closeAt > contentStart {
				out.WriteString(apply(text[contentStart:closeAt]))
				i = closeAt + len(delim)
				continue
			}
		}
		out.WriteByte(text[i])
		i++
	}
	return out.String()
}

func renderInline(text string, color bool) string {
	stash := make([]string, 0, 4)
	hold := func(value string) string {
		stash = append(stash, value)
		return "\x00" + strconv.Itoa(len(stash)-1) + "\x00"
	}

	work := replaceCodeSpans(text, func(value string) string {
		return hold(styled(value, color, "\x1b[36m"))
	})
	work = replaceLinks(work, hold, color)
	work = replaceEmphasis(work, "***", nil, nil, func(value string) string {
		return styled(value, color, "\x1b[1m", "\x1b[3m")
	})
	work = replaceEmphasis(work, "**", nil, nil, func(value string) string {
		return styled(value, color, "\x1b[1m")
	})
	work = replaceEmphasis(work, "__",
		func(s string, i int) bool { return !isWordByte(prevByte(s, i)) },
		func(s string, i int) bool { return !isWordByte(nextByte(s, i+2)) },
		func(value string) string { return styled(value, color, "\x1b[1m") },
	)
	work = replaceEmphasis(work, "*",
		func(s string, i int) bool {
			return prevByte(s, i) != '*' && nextByte(s, i+1) != '*'
		},
		func(s string, i int) bool {
			return prevByte(s, i) != '*' && nextByte(s, i+1) != '*'
		},
		func(value string) string { return styled(value, color, "\x1b[3m") },
	)
	work = replaceEmphasis(work, "_",
		func(s string, i int) bool {
			return !isWordByte(prevByte(s, i)) && nextByte(s, i+1) != '_'
		},
		func(s string, i int) bool {
			return prevByte(s, i) != '_' && !isWordByte(nextByte(s, i+1))
		},
		func(value string) string { return styled(value, color, "\x1b[3m") },
	)
	work = replaceEmphasis(work, "~~", nil, nil, func(value string) string {
		return styled(value, color, "\x1b[9m")
	})

	if len(stash) > 0 {
		work = placeholderRe.ReplaceAllStringFunc(work, func(match string) string {
			groups := placeholderRe.FindStringSubmatch(match)
			index, err := strconv.Atoi(groups[1])
			if err != nil || index < 0 || index >= len(stash) {
				return match
			}
			return stash[index]
		})
	}
	return work
}

func isHorizontalRule(line string) bool {
	trimmed := strings.TrimSpace(line)
	if len(trimmed) < 3 {
		return false
	}
	marker := trimmed[0]
	if marker != '-' && marker != '*' && marker != '_' {
		return false
	}
	count := 0
	for i := 0; i < len(trimmed); i++ {
		switch {
		case trimmed[i] == marker:
			count++
		case unicode.IsSpace(rune(trimmed[i])):
		default:
			return false
		}
	}
	return count >= 3
}

func fenceOpener(line string) bool {
	return fenceRe.MatchString(line)
}

func renderMarkdown(markdown string, color bool, width int) string {
	if width <= 0 {
		width = terminalColumns()
		if width > 72 {
			width = 72
		}
	}
	markdown = strings.ReplaceAll(markdown, "\r\n", "\n")
	markdown = strings.ReplaceAll(markdown, "\r", "\n")
	lines := strings.Split(markdown, "\n")
	out := make([]string, 0, len(lines))
	var fence []string

	flushFence := func() {
		if fence == nil {
			return
		}
		for _, codeLine := range fence {
			out = append(out, "  "+styled(codeLine, color, "\x1b[36m"))
		}
		fence = nil
	}

	for _, raw := range lines {
		if fenceOpener(raw) {
			if fence == nil {
				fence = []string{}
			} else {
				flushFence()
			}
			continue
		}
		if fence != nil {
			fence = append(fence, raw)
			continue
		}

		line := strings.TrimRightFunc(raw, unicode.IsSpace)
		if strings.TrimSpace(line) == "" {
			if len(out) > 0 && out[len(out)-1] != "" {
				out = append(out, "")
			}
			continue
		}

		if match := headingRe.FindStringSubmatch(line); match != nil {
			level := len(match[1])
			text := renderInline(match[2], color)
			switch level {
			case 1:
				out = append(out, styled(text, color, "\x1b[1m", "\x1b[4m", "\x1b[36m"))
			case 2:
				out = append(out, styled(text, color, "\x1b[1m", "\x1b[36m"))
			case 3:
				out = append(out, styled(text, color, "\x1b[1m", "\x1b[34m"))
			default:
				out = append(out, styled(text, color, "\x1b[1m"))
			}
			continue
		}

		if isHorizontalRule(line) {
			out = append(out, styled(strings.Repeat("─", width), color, "\x1b[2m"))
			continue
		}

		if match := quoteRe.FindStringSubmatch(line); match != nil {
			out = append(out,
				styled("│ ", color, "\x1b[2m")+renderInline(match[1], color))
			continue
		}

		if match := itemRe.FindStringSubmatch(line); match != nil {
			indent, marker, body := match[1], match[2], match[3]
			var markerText string
			if task := taskRe.FindStringSubmatch(body); task != nil {
				box := "☐"
				if strings.EqualFold(task[1], "x") {
					box = "☑"
				}
				markerText = styled(box, color, "\x1b[33m")
				body = task[2]
			} else if marker == "-" || marker == "*" || marker == "+" {
				markerText = styled("•", color, "\x1b[33m")
			} else {
				markerText = styled(marker, color, "\x1b[33m")
			}
			out = append(out, indent+markerText+" "+renderInline(body, color))
			continue
		}

		if strings.HasPrefix(strings.TrimLeftFunc(line, unicode.IsSpace), "|") &&
			tableSepRe.MatchString(line) {
			out = append(out, styled(line, color, "\x1b[2m"))
			continue
		}

		out = append(out, renderInline(line, color))
	}

	flushFence()
	for len(out) > 0 && out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	return strings.Join(out, "\n")
}

func printDelta(text, printed string, stream bool) string {
	if !stream || text == "" {
		return printed
	}
	if strings.HasPrefix(text, printed) {
		if len(text) > len(printed) {
			_, _ = fmt.Fprint(os.Stdout, text[len(printed):])
			flushStdout()
		}
		return text
	}
	// The page rewrote earlier text; wait for the final version.
	return printed
}

func emitFinal(text, printed string, stream bool) {
	if !stream {
		_, _ = fmt.Fprint(os.Stdout, text)
		if !strings.HasSuffix(text, "\n") {
			_, _ = fmt.Fprint(os.Stdout, "\n")
		}
		flushStdout()
		return
	}
	rest := text
	if strings.HasPrefix(text, printed) {
		rest = text[len(printed):]
	} else if printed != "" && !strings.HasSuffix(printed, "\n") {
		_, _ = fmt.Fprint(os.Stdout, "\n")
	}
	if rest != "" {
		_, _ = fmt.Fprint(os.Stdout, rest)
	}
	if !strings.HasSuffix(text, "\n") {
		_, _ = fmt.Fprint(os.Stdout, "\n")
	}
	flushStdout()
}

func emitAnswer(text string, markdown *string, printed string, stream, styled, color bool) {
	if !styled {
		emitFinal(text, printed, stream)
		return
	}
	body := ""
	if markdown != nil {
		body = strings.TrimSpace(*markdown)
	}
	if body == "" {
		body = text
	}
	rendered := renderMarkdown(body, color, 0)
	if rendered != "" {
		_, _ = fmt.Fprint(os.Stdout, rendered)
		if !strings.HasSuffix(rendered, "\n") {
			_, _ = fmt.Fprint(os.Stdout, "\n")
		}
	}
	flushStdout()
}

func flushStdout() {
	_ = os.Stdout.Sync()
}

func saveDiagnostics(job *Job) string {
	if len(job.Meta) == 0 {
		return ""
	}
	base := os.Getenv("XDG_CACHE_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		base = filepath.Join(home, ".cache")
	}
	folder := filepath.Join(base, "terminal-chat")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return ""
	}
	path := filepath.Join(folder,
		fmt.Sprintf("job-%s-%s.json", time.Now().Format("20060102-150405"), shortID(job.ID)))
	payload := map[string]any{"site": job.Site}
	if job.Error != nil {
		payload["error"] = *job.Error
	} else {
		payload["error"] = nil
	}
	for key, value := range job.Meta {
		payload[key] = value
	}
	data, err := marshalIndented(payload)
	if err != nil {
		return ""
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		return ""
	}
	return path
}

// marshalIndented matches json.dumps(..., indent=2, ensure_ascii=False).
func marshalIndented(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}
