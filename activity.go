package main

import (
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// Activity draws a one-line progress indicator on stderr, for interactive
// terminals only. Piped or redirected stderr stays byte-for-byte quiet. The
// line is redrawn in place and erased before any other output.
type Activity struct {
	mu      sync.Mutex
	Enabled bool
	Color   bool
	Out     io.Writer

	shown   string
	drawnAt time.Time
	active  bool
}

var activityFrames = []string{"|", "/", "-", "\\"}

// ACTIVITY is the process-wide indicator used by the CLI.
var ACTIVITY = &Activity{Out: os.Stderr}

func (a *Activity) writer() io.Writer {
	if a.Out != nil {
		return a.Out
	}
	return os.Stderr
}

func (a *Activity) write(text string) {
	out := a.writer()
	_, _ = io.WriteString(out, text)
	if flusher, ok := out.(interface{ Flush() error }); ok {
		_ = flusher.Flush()
	}
}

func (a *Activity) Update(text string, elapsed float64) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.Enabled {
		return
	}
	now := time.Now()
	index := (now.UnixNano() / int64(250*time.Millisecond)) % int64(len(activityFrames))
	frame := activityFrames[index]
	suffix := ""
	if elapsed >= 1 {
		suffix = fmt.Sprintf(" (%.0fs)", elapsed)
	}
	line := fmt.Sprintf("%s termchat: %s%s", frame, text, suffix)
	if line == a.shown && now.Sub(a.drawnAt) < 200*time.Millisecond {
		return
	}
	a.shown = line
	a.drawnAt = now
	a.active = true
	rendered := line
	if a.Color {
		rendered = "\x1b[2m" + line + "\x1b[0m"
	}
	a.write("\r\x1b[K" + rendered)
}

func (a *Activity) Clear() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.active {
		return
	}
	a.active = false
	a.shown = ""
	if !a.Enabled {
		return
	}
	a.write("\r\x1b[K")
}
