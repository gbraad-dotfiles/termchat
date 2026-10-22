#!/usr/bin/env python3
"""Checks for the Markdown-to-terminal renderer."""

from __future__ import annotations

import sys
import types


def load():
    module = types.ModuleType("tc")
    sys.modules["tc"] = module
    with open("bin/termchat", encoding="utf-8") as handle:
        exec(compile(handle.read(), "bin/termchat", "exec"), module.__dict__)
    return module


def main() -> int:
    tc = load()
    source = (
        "# Title\n\n"
        "Some **bold**, *italic*, ~~gone~~ and `a_b` plus a "
        "[link](https://example.com).\n\n"
        "## Steps\n\n"
        "1. First\n"
        "2. Second\n"
        "   - nested **item**\n\n"
        "- [x] done\n"
        "- [ ] todo\n\n"
        "> quoted **text**\n\n"
        "```python\n"
        "def f(x):\n"
        "    return x * 2\n"
        "```\n"
    )

    colored = tc.render_markdown(source, color=True)
    assert "\x1b[4m\x1b[36mTitle\x1b[0m" in colored, "heading is not styled"
    assert "\x1b[1mbold\x1b[0m" in colored, "bold is not styled"
    assert "\x1b[3mitalic\x1b[0m" in colored, "italic is not styled"
    assert "\x1b[9mgone\x1b[0m" in colored, "strike is not styled"
    assert "\x1b[36ma_b\x1b[0m" in colored, "inline code is not styled"
    assert "https://example.com" in colored, "link target missing"
    assert "\x1b[33m•\x1b[0m nested \x1b[1mitem\x1b[0m" in colored, "nested list"
    assert "\x1b[33m☑\x1b[0m done" in colored, "task list"
    assert "\x1b[2m│ \x1b[0mquoted" in colored, "blockquote"
    assert "  \x1b[36mdef f(x):\x1b[0m" in colored, "code block indentation"
    assert "  \x1b[36m    return x * 2\x1b[0m" in colored, "code indentation inside block"
    assert "**" not in colored, "unrendered bold markers"
    assert "```" not in colored, "unrendered fence"

    plain = tc.render_markdown(source, color=False)
    assert "\x1b[" not in plain, "color=False still emitted ANSI"
    assert "**" not in plain and "`" not in plain, "markers left in plain render"
    assert "   • nested item" in plain, "nested list indentation lost"
    assert "  def f(x):\n      return x * 2" in plain, "code block changed"

    # Text that is not Markdown survives untouched.
    assert tc.render_markdown("plain text\n", color=False) == "plain text"

    # Unclosed fences must not swallow styling state or crash.
    assert "x = 1" in tc.render_markdown("```\nx = 1\n", color=False)

    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
