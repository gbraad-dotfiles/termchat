package main

import (
	"strings"
	"testing"
)

// Checks for the Markdown-to-terminal renderer.
func TestRenderMarkdown(t *testing.T) {
	source := "# Title\n\n" +
		"Some **bold**, *italic*, ~~gone~~ and `a_b` plus a " +
		"[link](https://example.com).\n\n" +
		"## Steps\n\n" +
		"1. First\n" +
		"2. Second\n" +
		"   - nested **item**\n\n" +
		"- [x] done\n" +
		"- [ ] todo\n\n" +
		"> quoted **text**\n\n" +
		"```python\n" +
		"def f(x):\n" +
		"    return x * 2\n" +
		"```\n"

	colored := renderMarkdown(source, true, 0)
	expect := func(needle, why string) {
		t.Helper()
		if !strings.Contains(colored, needle) {
			t.Errorf("%s: missing %q in %q", why, needle, colored)
		}
	}
	expect("\x1b[4m\x1b[36mTitle\x1b[0m", "heading is not styled")
	expect("\x1b[1mbold\x1b[0m", "bold is not styled")
	expect("\x1b[3mitalic\x1b[0m", "italic is not styled")
	expect("\x1b[9mgone\x1b[0m", "strike is not styled")
	expect("\x1b[36ma_b\x1b[0m", "inline code is not styled")
	expect("https://example.com", "link target missing")
	expect("\x1b[33m•\x1b[0m nested \x1b[1mitem\x1b[0m", "nested list")
	expect("\x1b[33m☑\x1b[0m done", "task list")
	expect("\x1b[2m│ \x1b[0mquoted", "blockquote")
	expect("  \x1b[36mdef f(x):\x1b[0m", "code block indentation")
	expect("  \x1b[36m    return x * 2\x1b[0m", "code indentation inside block")
	if strings.Contains(colored, "**") {
		t.Errorf("unrendered bold markers in %q", colored)
	}
	if strings.Contains(colored, "```") {
		t.Errorf("unrendered fence in %q", colored)
	}

	plain := renderMarkdown(source, false, 0)
	if strings.Contains(plain, "\x1b[") {
		t.Errorf("color=false still emitted ANSI: %q", plain)
	}
	if strings.Contains(plain, "**") || strings.Contains(plain, "`") {
		t.Errorf("markers left in plain render: %q", plain)
	}
	if !strings.Contains(plain, "   • nested item") {
		t.Errorf("nested list indentation lost: %q", plain)
	}
	if !strings.Contains(plain, "  def f(x):\n      return x * 2") {
		t.Errorf("code block changed: %q", plain)
	}

	// Text that is not Markdown survives untouched.
	if got := renderMarkdown("plain text\n", false, 0); got != "plain text" {
		t.Errorf("plain text = %q", got)
	}

	// Unclosed fences must not swallow styling state or crash.
	if got := renderMarkdown("```\nx = 1\n", false, 0); !strings.Contains(got, "x = 1") {
		t.Errorf("unclosed fence = %q", got)
	}
}
