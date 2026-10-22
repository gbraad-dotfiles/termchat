# terminal-chat

Use Gemini, Copilot and DeepSeek chat from your terminal using the
accounts and sessions you are already signed into from your browser.

No API keys, no headless browser, no second browser profile. A tiny CLI talks
to a small browser extension, which types your prompt into the open chat tab
and reads the answer back as it streams.

```
  termchat gemini "..."          ┌──────────────────────────────┐
  termchat copilot -f main.go    │  Vivaldi / Chrome / Edge     │
  cat notes.md | termchat ...    │                              │
           │                     │  chat tab (you stay signed   │
           ▼                     │  in) ── content script       │
  ┌──────────────────────┐       │           │                  │
  │ CLI + loopback HTTP  │◀─────▶│  background service worker   │
  │ 127.0.0.1:8765–8774  │       └──────────────────────────────┘
  └──────────────────────┘
```


## Requirements

- Python 3.9+ (standard library only — nothing to `pip install`)
- A Chromium-based browser (Vivaldi, Chrome, Edge, Brave…) — the primary target
- A Firefox build is included as a convenience (`build.sh firefox`)


## Install

```sh
./install.sh
```

That links `termchat` into `~/.local/bin` (`PREFIX=…` to change) and prints the
extension steps. Then, in Vivaldi:

1. open `chrome://extensions`
2. turn on `Developer mode`
3. `Load unpacked` and select this repository's `extension/` directory

Open and sign in to the sites you want to use. After installing or reloading
the extension, 

> [!NOTE]
> Reload the chat tabs so the content script is injected.

> [!NOTE]
> Flatpak browsers (e.g. `com.vivaldi.Vivaldi`) only see their sandbox. If
> the file picker cannot reach this directory, either grant access with
> `flatpak override --user --filesystem=/path/to/terminal-chat com.vivaldi.Vivaldi`
> or copy `extension/` somewhere under `~/.var/app/com.vivaldi.Vivaldi/` and
> load it from there.


### Packages

`./build.sh` produces both loadable directories and distributable archives:

| output | use |
| --- | --- |
| `dist/chromium/` | *Load unpacked* in Vivaldi/Chrome/Edge |
| `dist/termchat-chromium.zip` | copy to another machine, then unzip and load |
| `dist/termchat-chromium.crx` | signed CRX3 package (self-signed) |
| `dist/firefox/`, `dist/termchat-firefox.zip` | Firefox |

The CRX is signed with a key at `~/.config/terminal-chat/crx-key.pem` (created
on first build; keep it to keep the same extension ID). Chrome and Vivaldi
normally install `.crx` files only from the Chrome Web Store or through
enterprise policy, so *Load unpacked* remains the reliable route for a personal
build; the CRX is for browsers or policies that accept a self-signed package.


## Usage

```sh
termchat gemini "Explain io_uring in two paragraphs"

# include files in the prompt (repeatable; '-' reads stdin)
termchat copilot -f src/main.go -f go.mod "Review this Go code"

# pipe text in
cat incident.md | termchat deepseek "Summarise the root cause"

# continue the conversation already open in the tab
termchat gemini --continue "And what about the error path?"

# small REPL (keeps one conversation; :new, :continue, :inspect, :quit)
termchat deepseek -i

# JSON output / machine-readable
termchat gemini "ping" --json

# see what the extension can find on the page (for troubleshooting)
termchat gemini --inspect
```

By default a one-shot command starts a **new chat** (it clicks *New chat* when
the open tab already has messages), so unrelated questions do not pile up in
one thread. Use `--continue` to append to the open conversation instead. New
chat is best-effort: if the button cannot be found, the prompt is typed into
the conversation that is already open.

Answers stream to the terminal when stdout is a TTY. When piped, only the final
text is printed, so `termchat … > answer.md` works as expected.


### Options

| option | meaning |
| --- | --- |
| `-f, --file PATH` | include a file's contents before the prompt (repeatable, `-` = stdin) |
| `--new` | start a new chat (default for one-shot) |
| `--continue` | use the chat already open in the tab |
| `-i, --interactive` | small REPL; `:new`, `:continue`, `:inspect`, `:quit` |
| `--inspect` | dump composer/send/response candidates as JSON |
| `--timeout SEC` | how long to wait for an answer (default 300) |
| `--wait SEC` | how long to wait for the extension to pick the job up (default 30) |
| `--json` | print `{site, text, error, meta}` |
| `--server URL` | submit to a running `termchat serve` (`host[:port]`) |
| `--local` | always start a private bridge, ignoring a running server |
| `--port N` | base loopback port (default 8765) |
| `--bind ADDR` | listen address (default `127.0.0.1`; use `0.0.0.0` for a remote browser) |
| `--token T` | require this token from the extension (optional) |
| `-v, --verbose` | log bridge traffic to stderr |

Exit codes: `0` success, `1` page/job error, `2` usage, `3` no extension
connected (or bridge/server unavailable).


## Shared server

By default every command starts its own short-lived bridge and exits when the
answer arrives. If you want one bridge that the browser and several CLIs
(including CLIs on other machines) share, run:

```sh
termchat serve --bind 0.0.0.0
```

It stays up, handles any number of jobs, and queues jobs per site. Then:

```sh
# on the server machine: plain commands find it automatically
termchat gemini "hello"

# on another machine: point at the server, or put it in config
termchat gemini "hello" --server 10.0.21.22:8765
```

`~/.config/terminal-chat/config.json` on the client:

```json
{"server": "10.0.21.22:8765", "token": "same-as-the-server"}
```


Notes:

- Only one extension tab per site is needed; it polls the server instead of a
  one-off bridge.
- Two clients asking the same site are served one after the other (FIFO).
  Different sites run concurrently.
- `--local` restores the per-command bridge (useful when testing, so a command
  never joins a shared queue).
- `--check` works in both modes and reports whether the extension is polling
  the server.
- A server on a non-loopback address should use `--token`; anyone who can reach
  it can otherwise submit prompts.


## How it works

1. The CLI either submits to a running `termchat serve` (explicit `--server`,
   or auto-detected on the local base port) or starts its own bridge on the
   first free port in `127.0.0.1:8765–8774` and queues the job.
2. The extension's background service worker discovers that port (it probes the
   range with `/v1/ping`) and long-polls `/v1/job` for open chat tabs.
3. For each job the worker drives a small state machine through the content
   script: `prepare` (new chat + type the prompt), `submit` (send button, or
   Enter), `status` (current answer text, stop button). Partial answers go back
   to the CLI via `/progress`; the final one via `/done`.
4. Timing and polling live in the **service worker**, not the page. Browsers
   throttle timers in hidden tabs (down to once per minute), which would make
   this unusable while you are in the terminal; message delivery is not
   throttled.

Only `127.0.0.1` is bound by default. If you bind elsewhere, requests carrying
a foreign `Origin` are still rejected, and the worker only talks to the bridge
from the three supported sites — but anything on that network can also reach
the bridge, so use `--token` unless the network is trusted.


## Browser on another machine

The extension dials the machine that runs the CLI, so it does not have to be
the same machine as the browser.

1. Bind the CLI where the browser can reach it:

   ```sh
   termchat gemini "hello" --bind 0.0.0.0
   ```

   or set it once in `~/.config/terminal-chat/config.json`:

   ```json
   {"bind": "0.0.0.0"}
   ```

2. In the browser, open the extension's `Options` page (right-click the
   extension `Options`), set `Host` to the CLI machine's address
   (e.g. `10.0.21.52`), and click `Save`. The browser asks for permission
   to reach that host; allow it.

The worker rescans the port range on its own, so no reload is needed. Make
sure ports `8765–8774` are reachable through the firewall.

The bridge is plain HTTP. For occasional or sensitive use, an SSH tunnel keeps
it on loopback instead:

```sh
args=(); for p in $(seq 8765 8774); do args+=(-L "$p:127.0.0.1:$p"); done
ssh -N "${args[@]}" you@cli-machine
```

## Troubleshooting

#### "no browser tab picked up the job"
- Run `termchat <site> --check`. It reports one of three things:
  - *nothing reached the bridge* — the extension cannot see this machine: set
    the Options **Host**, allow the permission, check the firewall/route.
  - *the extension reached the bridge but never asked for a job* — the tab was
    open before the extension was loaded; reload it.
  - *the extension is polling for …* — the connection works; the problem is on
    the page side (signed in? composer present?).
- **Browser on another machine:** the CLI must listen on an address that
  machine can reach. The default is `127.0.0.1`, which is the *CLI machine's*
  loopback and invisible to a remote browser. Put `{"bind": "0.0.0.0"}` in
  `~/.config/terminal-chat/config.json` (or pass `--bind 0.0.0.0`). A useful
  test: `termchat gemini --check` times out, but
  `termchat gemini --check --bind 0.0.0.0` reaches the extension.
- The extension is not loaded, or the tab predates the extension install
  (reload it).
- The chat site is not signed in, or has not finished loading.
- If the browser is on another machine, check the extension Options: the
  **Host** must be the CLI machine, not `127.0.0.1`.
- Check the extension is enabled at `chrome://extensions`.

#### "could not type the prompt" / "could not submit"
- The site changed its DOM. Run `termchat <site> --inspect` and compare the
  reported `composer`, `sendMatches`, `responseCandidates` with the selectors
  in `extension/content.js` (`ADAPTERS`). Update the selector and reload the
  extension.

#### Answers stop early or run long
- Completion is detected by the stop control disappearing plus a stable answer.
  If the control is missing, 1.5 s of unchanged text is enough; if it never
  disappears, the worker waits 20 s of quiet before finishing. A site that
  changes its stop control still works, at the cost of a later finish.

#### Nothing happens for a while on the first command
- The browser may have suspended the extension worker while idle. The content
  script reconnects on focus/visibility; moving to the tab wakes it. Once the
  worker is polling, jobs are picked up within ~2 s.


## Limitations

- One job at a time per site. With `termchat serve`, jobs for the same site
  queue; with per-command bridges, concurrent calls on different sites are fine.
- Text only; file *attachments* (images/PDF) are not uploaded — file contents
  are included in the prompt text instead.
- These are consumer web UIs without a stable API. Selectors will occasionally
  need a one-line repair; `--inspect` makes that quick.
- The extension types into your real session, so it can do anything you could
  do in that tab. It only ever receives prompts from your local CLI.


## Development

```sh
./build.sh            # dist/chromium, dist/firefox, .zip and signed .crx
./tests/run.sh        # protocol + server tests with a fake extension (no browser)
./sync.sh --build     # copy the folder to another machine (REMOTE=… to change)
```

Building the CRX needs `openssl` and `zip`; running the CLI and extension does
not.

The CLI is a single file (`bin/termchat`), the extension is three files
(`manifest.json`, `background.js`, `content.js`).

