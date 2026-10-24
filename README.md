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

Answers are styled for the terminal when stdout is a TTY: the extension reads
the answer's structure (headings, lists, code blocks, emphasis, tables) and the
CLI renders it without reflowing the text, so code and tables keep their
layout. Styled answers are printed once, when they are complete. Use `--plain`
to stream the raw text instead (the old behaviour), `NO_COLOR=1` to keep the
layout but drop the colours, or `--markdown` to force styling when stdout is
not a terminal. When piped, the plain final text is printed, so
`termchat … > answer.md` works as expected.

When stderr is a terminal, one status line is drawn in place while a command
waits, for example `termchat: sent to http://10.0.21.22:8765, waiting for the
browser tab (4s)` and then `termchat: answering (12s)`. It is erased before the
answer starts. Piped or redirected stderr, and `--json`, get no extra output.


### Options

| option | meaning |
| --- | --- |
| `-f, --file PATH` | include a file's contents before the prompt (repeatable, `-` = stdin) |
| `--new` | start a new chat (default for one-shot) |
| `--continue` | use the chat already open in the tab |
| `-i, --interactive` | small REPL; `:new`, `:continue`, `:inspect`, `:quit` |
| `--inspect` | dump composer/send/response candidates as JSON |
| `--timeout SEC` | how long to wait for an answer (default 300) |
| `--wait SEC` | how long to wait for the extension to pick the job up (default 30; up to 3× when the extension recently polled and is only asleep) |
| `--json` | print `{site, text, error, meta}` |
| `--plain` | print the raw text and stream it (no Markdown styling) |
| `--markdown` | render Markdown styling even when stdout is not a TTY |
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


## Web interface

`termchat serve` also serves a small web page on the same port. Open
`http://<server>:8765/` in any browser that can reach the server; it does not
have to be the browser that runs the extension:

- choose Gemini, Copilot or DeepSeek in the top bar;
- type a prompt and press Enter (`Shift+Enter` adds a line);
- the answer streams in and is rendered as Markdown; **Stop** cancels the job;
- with **New chat** ticked the next prompt starts a fresh conversation,
  otherwise it continues the thread shown in the page.

Each site keeps its own transcript in the browser's `localStorage`, and an
answer that was still running is picked up again after a reload. The page uses
the same `/v1/request` and `/v1/state` endpoints as the CLI, so it shares the
per-site queue with commands from the terminal and from other machines.

When the server was started with `--token`, the page asks for the token and
remembers it in `localStorage`. Use the **Token** button to replace or clear it
on a shared browser. The page is served from the bridge's own origin; requests
from any other origin are still rejected.


## How it works

1. The CLI either submits to a running `termchat serve` (explicit `--server`,
   or auto-detected on the local base port) or starts its own bridge on the
   first free port in `127.0.0.1:8765–8774` and queues the job. The web page
   served by `serve` submits to the same `/v1/request` endpoint.
2. The extension's background service worker discovers that port (it probes the
   range with `/v1/ping`) and long-polls `/v1/job` for open chat tabs.
3. For each job the worker drives a small state machine through the content
   script: `prepare` (new chat + type the prompt), `submit` (send button, or
   Enter), `status` (current answer text, Markdown, stop button). Partial
   answers go back to the CLI via `/progress`; the final one, with its
   Markdown, via `/done`.
4. Timing and polling live in the **service worker**, not the page. Browsers
   throttle timers in hidden tabs (down to once per minute), which would make
   this unusable while you are in the terminal; message delivery is not
   throttled.
5. Browsers stop an idle service worker after about 30 seconds. A `chrome.alarms`
   heartbeat (30 s, or 60 s on browsers that reject shorter periods) wakes it
   again, and the content scripts re-announce themselves, so a background chat
   tab keeps answering commands. While the page is alive it also sends a light
   port heartbeat every 20 seconds. A pending `fetch` does *not* count as
   activity for the idle timer, so while polling or running a job the worker
   also calls a cheap extension API (`runtime.getPlatformInfo`) every 20
   seconds; without that, Vivaldi lets the worker fall asleep even while its
   long-poll is in flight.
6. Hidden tabs are protected from the browser's memory saver: the content
   script holds a no-op Web Lock, which opts the tab out of freezing, and the
   worker marks it `autoDiscardable: false`. A tab that was already discarded
   is reloaded by the heartbeat. If the worker was asleep when a command
   arrived, the CLI gives a recently-polling extension one longer window
   (three times `--wait`, at most 90 s) instead of failing at the first
   timeout. A tab running the content script from before an extension reload
   is ignored; the worker injects the current build, which takes over.
7. Even when it is not frozen, a hidden Gemini tab may ignore the synthetic
   send click or stop repainting the answer. For the duration of a job the
   worker therefore selects the chat tab and brings its window to the front.
   At the end it selects the previous tab again and asks the window manager
   for the next window in the z-order, which normally gives keyboard focus
   back to the terminal. A minimised window is restored, not minimised again.
   The whole exchange is recorded in the bridge's log, and `--check -v` shows
   the last lines (`page 1a2b3c4d ...`).

Only `127.0.0.1` is bound by default. If you bind elsewhere, requests carrying
a foreign `Origin` are still rejected, and the worker only talks to the bridge
from the three supported sites. The one exception is the web page served by
the bridge itself: a request whose `Origin` matches the request's `Host` is
accepted, so the page can use the API from the same address you opened. It
does not open CORS to other sites. Anything on that network can still reach
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
  Add `-v` to see how long ago each site last polled, which extension build
  is loaded (`poll_ages={'gemini': 0.4} extension=0.1.5`) and the last page
  diagnostics (`page 1a2b3c4d 2.1s ago: ...`). A poll age above
  10 s means the service worker is not running at that moment, even if it
  polled recently; an empty `extension=` usually means an older build.
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
- The browser may have suspended the extension worker while idle. An alarm
  wakes it within about 30 seconds and the content script reconnects; the CLI
  waits one longer window instead of giving up. Since 0.1.3 the worker also
  resets its own idle timer while it polls (see *How it works*), so it should
  not fall asleep while a command is waiting. Since 0.1.5 the worker also
  brings the chat tab and its window to the front while a job runs, because a
  hidden Gemini tab can ignore the send click and stop repainting the answer.
  It restores the previous tab and hands focus back afterwards. If `--check -v`
  shows a stale `poll_ages` after reloading the extension, the tab was
  hibernated; the Vivaldi setting below is the remaining lever. The extension
  also holds a Web Lock in the chat tab and disables auto-discard, so
  background tabs are not frozen or discarded. Browser-level hibernation can
  still override this; see
  [Keeping the chat tab awake in Vivaldi](#keeping-the-chat-tab-awake-in-vivaldi).
  If a tab was discarded before the extension loaded, activate it once. After
  updating the extension the worker injects the new content script itself; if
  the tab is still not picked up, reload the chat tab once.

#### Keeping the chat tab awake in Vivaldi
Vivaldi's Memory Saver hibernates inactive tabs. The extension's Web Lock and
`autoDiscardable: false` stop Chromium's own freezing and discarding, but
Vivaldi's hibernation can still unload the tab and ignore wake messages. The
per-job tab switch described above works around the hidden-tab behaviour; this
setting prevents the tab from being unloaded during long idle periods.
Exclude the chat site:

1. Open `vivaldi://settings/performance/`. On Vivaldi 7.7 and later Memory
   Saver lives under **Settings → Performance**; on older versions it is under
   **Settings → Tabs → Memory Saver** (`vivaldi://settings/tabs/`).
2. Set Memory Saver to **Never save memory** (older versions: **Disabled**).
   If you want to keep memory saving on, add the chat site to the exceptions
   list, and pin the chat tab if pinned tabs can be exempted. Pinning is the
   most reliable exemption when a per-site list is not available.
3. Do not use the manual **Hibernate** action on this tab or on the window
   that holds it (right-click the tab → *Hibernate*, including *Hibernate
   background tabs*). A hibernated tab is greyed out; click it once to reload
   it, then run `termchat <site> --check` again.

For Chrome and other Chromium browsers, open
`chrome://settings/performance`, find **Memory Saver**, and add
`gemini.google.com`, `copilot.microsoft.com` and `chat.deepseek.com` under
**Always keep these sites active**.


## Limitations

- One job at a time per site. With `termchat serve`, jobs for the same site
  queue; with per-command bridges, concurrent calls on different sites are fine.
- Text only; file *attachments* (images/PDF) are not uploaded — file contents
  are included in the prompt text instead.
- Styled output is not streamed: the answer appears when it is complete. Use
  `--plain` if you prefer to watch it arrive.
- Markdown is reconstructed from the page's HTML. Unusual site markup can lose
  a marker or a table alignment; the words themselves are unaffected.
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

The CLI is a single Python file (`bin/termchat`). The page it serves lives in
`web/` (`index.html`, `style.css`, `markdown.js`, `app.js`); if the directory
is missing, `serve` still works for the CLI and the extension, but `/` shows a
short explanation. The extension is three files (`manifest.json`,
`background.js`, `content.js`).

