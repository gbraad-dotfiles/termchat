#!/usr/bin/env python3
"""Minimal stand-in for the browser extension, used by tests/run.sh.

It discovers the CLI bridge on the loopback port range, takes one job, streams
a canned answer and finishes. No browser or DOM involved.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE_PORT = int(os.environ.get("TERMCHAT_BASE_PORT", "8765"))
PORT_SPAN = 10
TOKEN = ""


def call(port: int, path: str, method: str = "GET", body: dict | None = None, timeout: float = 3.0):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, method=method
    )
    if data is not None:
        request.add_header("Content-Type", "application/json")
    if TOKEN:
        request.add_header("X-Termchat-Token", TOKEN)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
        return response.status, (json.loads(raw) if raw else None)


def discover(deadline: float) -> int | None:
    while time.monotonic() < deadline:
        for port in range(BASE_PORT, BASE_PORT + PORT_SPAN):
            try:
                status, payload = call(port, "/v1/ping", timeout=0.4)
                if status == 200 and payload and payload.get("app") == "termchat":
                    return port
            except (urllib.error.URLError, TimeoutError, ValueError):
                pass
        time.sleep(0.1)
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("site")
    parser.add_argument("--reply", default="Hello from the fake extension.")
    parser.add_argument("--chunks", type=int, default=3)
    parser.add_argument("--delay", type=float, default=0.04)
    parser.add_argument("--dump-prompt", metavar="PATH")
    parser.add_argument("--error", metavar="MESSAGE")
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument("--token", default="")
    args = parser.parse_args()

    global TOKEN
    TOKEN = args.token

    port = discover(time.monotonic() + args.timeout)
    if port is None:
        print("fake extension: no bridge found", file=sys.stderr)
        return 1

    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        try:
            _, job = call(port, f"/v1/job?site={args.site}&wait=1", timeout=3.0)
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            print(f"fake extension: {exc}", file=sys.stderr)
            return 1
        if not job:
            continue

        prompt = job.get("prompt", "")
        if args.dump_prompt:
            with open(args.dump_prompt, "w", encoding="utf-8") as handle:
                handle.write(prompt)

        if job.get("inspect"):
            call(
                port,
                f"/v1/job/{job['id']}/done",
                "POST",
                {
                    "text": "",
                    "error": None,
                    "meta": {"site": args.site, "composer": {"tag": "textarea"}, "fake": True},
                },
            )
            return 0

        if args.error:
            call(
                port,
                f"/v1/job/{job['id']}/done",
                "POST",
                {"text": "", "error": args.error, "meta": {"fake": True}},
            )
            return 0

        reply = prompt if args.reply == "@echo" else args.reply
        step = max(1, len(reply) // max(1, args.chunks))
        for end in range(step, len(reply) + step, step):
            time.sleep(args.delay)
            call(
                port,
                f"/v1/job/{job['id']}/progress",
                "POST",
                {"text": reply[:end]},
            )
        call(
            port,
            f"/v1/job/{job['id']}/done",
            "POST",
            {"text": reply, "error": None, "meta": {"fake": True}},
        )
        return 0

    print("fake extension: timed out waiting for a job", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
