package main

import (
	"bytes"
	"strings"
	"testing"
)

// Checks the interactive progress line without a real terminal.
func TestActivity(t *testing.T) {
	var out bytes.Buffer
	activity := &Activity{Out: &out, Enabled: true}

	activity.Update("gemini: sent to http://127.0.0.1:8765", 0)
	activity.Update("gemini: answering", 2)
	activity.Clear()

	text := out.String()
	if !strings.Contains(text, "\r\x1b[K") {
		t.Error("the line is not redrawn in place")
	}
	if !strings.Contains(text, "gemini: sent to http://127.0.0.1:8765") {
		t.Error("server message missing")
	}
	if !strings.Contains(text, "gemini: answering (2s)") {
		t.Error("elapsed time missing")
	}
	if activity.active {
		t.Error("clear left the line active")
	}

	out.Reset()
	activity.Enabled = false
	activity.Update("hidden", 1)
	activity.Clear()
	if out.Len() != 0 {
		t.Errorf("disabled activity wrote to stderr: %q", out.String())
	}

	out.Reset()
	activity.Enabled = true
	activity.Color = true
	activity.Update("colored", 0)
	if !strings.Contains(out.String(), "\x1b[2m") {
		t.Error("color was requested but not used")
	}
	activity.Clear()
}
