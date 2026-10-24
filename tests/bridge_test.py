#!/usr/bin/env python3
"""State-machine checks for the server job queue, without HTTP."""

from __future__ import annotations

import sys
import time
import types


def load():
    module = types.ModuleType("tc")
    module.__file__ = "bin/termchat"
    sys.modules["tc"] = module
    with open("bin/termchat", encoding="utf-8") as handle:
        exec(compile(handle.read(), "bin/termchat", "exec"), module.__dict__)
    return module


def main() -> int:
    tc = load()

    # An abandoned pending job (its client stopped polling) is dropped and
    # does not sit in front of a live client forever.
    bridge = tc.Bridge(mode="server", pending_ttl=1.0)
    orphan = tc.Job(site="gemini", prompt="orphan", new_chat=True, inspect=False, timeout=60)
    bridge.submit(orphan)
    time.sleep(1.2)
    live = tc.Job(site="gemini", prompt="live", new_chat=True, inspect=False, timeout=60)
    bridge.submit(live)

    snap = bridge.snapshot(live.id, -1, 0)
    assert snap is not None and snap["queued_ahead"] == 0, snap
    assert bridge.snapshot(orphan.id, -1, 0) is None, "orphan was not pruned"

    taken = bridge.take("gemini", 0)
    assert taken is not None and taken.id == live.id, taken
    assert bridge.update(live.id, text="done", state="done")
    assert bridge.snapshot(live.id, -1, 0)["state"] == "done"

    # A client that keeps polling keeps its queued job alive.
    bridge = tc.Bridge(mode="server", pending_ttl=1.0)
    kept = tc.Job(site="gemini", prompt="kept", new_chat=True, inspect=False, timeout=60)
    bridge.submit(kept)
    for _ in range(4):
        time.sleep(0.4)
        assert bridge.snapshot(kept.id, -1, 0) is not None
    assert bridge.take("gemini", 0).id == kept.id

    print("ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
