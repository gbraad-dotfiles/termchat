#!/usr/bin/env python3
"""Checks the interactive progress line without a real terminal.

The CLI only enables it when stderr is a TTY; this test drives the class with a
StringIO so the drawing and the quiet path are both covered.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import sys
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "bin" / "termchat"
loader = importlib.machinery.SourceFileLoader("termchat_under_test", str(path))
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules[loader.name] = module
loader.exec_module(module)

out = io.StringIO()
real_stderr = sys.stderr
sys.stderr = out
try:
    activity = module.Activity()
    activity.enabled = True
    activity.color = False
    activity.update("gemini: sent to http://127.0.0.1:8765", 0)
    activity.update("gemini: answering", 2)
    activity.clear()

    text = out.getvalue()
    assert "\r\x1b[K" in text, "the line is not redrawn in place"
    assert "gemini: sent to http://127.0.0.1:8765" in text, "server message missing"
    assert "gemini: answering (2s)" in text, "elapsed time missing"
    assert activity.active is False, "clear left the line active"

    out.seek(0)
    out.truncate(0)
    activity.enabled = False
    activity.update("hidden", 1)
    activity.clear()
    assert out.getvalue() == "", "disabled activity wrote to stderr"

    out.seek(0)
    out.truncate(0)
    activity.enabled = True
    activity.color = True
    activity.update("colored", 0)
    assert "\x1b[2m" in out.getvalue(), "color was requested but not used"
    activity.clear()
finally:
    sys.stderr = real_stderr

print("activity: OK")
