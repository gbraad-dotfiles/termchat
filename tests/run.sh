#!/usr/bin/env bash
# End-to-end tests for the CLI <-> extension protocol, using a fake extension.
set -uo pipefail
cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
status=0

# Keep the fake/harness away from 8765-8774, where a real extension may be
# polling, and use a fresh range per run so a crashed run cannot poison the
# next one. The CLI, fake extension and service-worker harness all read this.
export TERMCHAT_BASE_PORT="${TERMCHAT_TEST_PORT:-$((19000 + RANDOM % 900))}"

ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; status=1; }

tc() {
  env XDG_CONFIG_HOME="$tmp/config" XDG_CACHE_HOME="$tmp/cache" ./bin/termchat "$@"
}

# 1. basic answer
python3 tests/fake_extension.py gemini --reply "hello world" --timeout 8 &
fake=$!
out="$(tc gemini "hi" --wait 5 --timeout 10)"
wait "$fake" || true
if [[ "$out" == "hello world" ]]; then ok "basic"; else bad "basic: got '$out'"; fi

# 2. file contents and piped prompt are combined
printf 'file body\n' > "$tmp/a.txt"
python3 tests/fake_extension.py gemini --reply @echo --dump-prompt "$tmp/prompt" --timeout 8 &
fake=$!
printf 'piped prompt' | tc gemini -f "$tmp/a.txt" --wait 5 --timeout 10 >/dev/null
wait "$fake" || true
if grep -q '<file path=' "$tmp/prompt" \
  && grep -q 'file body' "$tmp/prompt" \
  && grep -q 'piped prompt' "$tmp/prompt"; then
  ok "file and stdin"
else
  bad "file and stdin"
fi

# 3. no extension connected
tc gemini "hi" --wait 1 >/dev/null 2>"$tmp/err"
code=$?
if [[ $code -eq 3 ]] && grep -q 'no browser tab' "$tmp/err"; then
  ok "no extension"
else
  bad "no extension (exit $code)"
fi

# 4. --json
python3 tests/fake_extension.py deepseek --reply "json answer" --timeout 8 &
fake=$!
json="$(tc deepseek "hi" --json --wait 5 --timeout 10)"
wait "$fake" || true
if printf '%s' "$json" | python3 -c \
  'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d["text"]=="json answer" and d["site"]=="deepseek" else 1)'; then
  ok "--json"
else
  bad "--json: $json"
fi

# 5. page errors are propagated and diagnostics are saved
python3 tests/fake_extension.py copilot --error "composer not found" --timeout 8 &
fake=$!
tc copilot "hi" --wait 5 --timeout 10 >/dev/null 2>"$tmp/err2"
code=$?
wait "$fake" || true
if [[ $code -eq 1 ]] && grep -q 'composer not found' "$tmp/err2" \
  && grep -q 'diagnostics saved' "$tmp/err2"; then
  ok "error propagation"
else
  bad "error propagation (exit $code)"
fi

# 6. --inspect prints the page report
python3 tests/fake_extension.py gemini --timeout 8 &
fake=$!
out="$(tc gemini --inspect --wait 5 --timeout 10)"
wait "$fake" || true
if printf '%s' "$out" | grep -q '"fake": true'; then
  ok "inspect"
else
  bad "inspect: $out"
fi

# 7. prompt from a positional '-'
python3 tests/fake_extension.py gemini --reply @echo --timeout 8 &
fake=$!
out="$(printf 'from stdin' | tc gemini - --wait 5 --timeout 10)"
wait "$fake" || true
if [[ "$out" == "from stdin" ]]; then ok "positional dash"; else bad "positional dash: got '$out'"; fi

# 8. the real service-worker state machine against the real CLI
node tests/sw_harness.js >"$tmp/sw.log" 2>&1 &
sw=$!
sleep 1
out="$(tc gemini "hi" --wait 10 --timeout 20)"
wait "$sw"
sw_code=$?
if [[ $sw_code -eq 0 && "$out" == "Hello world" ]]; then
  ok "service worker state machine"
else
  bad "service worker state machine (exit $sw_code, output '$out')"
  sed 's/^/     /' "$tmp/sw.log"
fi

# 9. an answer identical to the previous one is still recognised as new
node tests/sw_harness.js repeat >"$tmp/sw2.log" 2>&1 &
sw=$!
sleep 1
out="$(tc gemini "hi" --continue --wait 10 --timeout 20)"
wait "$sw"
sw_code=$?
if [[ $sw_code -eq 0 && "$out" == "Hello world" ]]; then
  ok "repeated answer"
else
  bad "repeated answer (exit $sw_code, output '$out')"
  sed 's/^/     /' "$tmp/sw2.log"
fi

# 9b. a content script left behind by an extension reload is not driven
node tests/sw_harness.js stale >"$tmp/sw-stale.log" 2>&1 &
sw=$!
sleep 1
out="$(tc gemini "hi" --wait 10 --timeout 20)"
wait "$sw"
sw_code=$?
if [[ $sw_code -eq 0 && "$out" == "Hello world" ]]; then
  ok "stale content script ignored"
else
  bad "stale content script ignored (exit $sw_code, output '$out')"
  sed 's/^/     /' "$tmp/sw-stale.log"
fi

# 10. token-protected bridge accepts the matching token
python3 tests/fake_extension.py gemini --reply "secret answer" --token s3cret --timeout 8 &
fake=$!
out="$(tc gemini "hi" --token s3cret --wait 5 --timeout 10)"
wait "$fake" || true
if [[ "$out" == "secret answer" ]]; then ok "token"; else bad "token: got '$out'"; fi

# 11. a wrong token cannot take the job
python3 tests/fake_extension.py gemini --reply "nope" --token wrong --timeout 4 &
fake=$!
tc gemini "hi" --token right --wait 2 --timeout 5 >/dev/null 2>"$tmp/err3"
code=$?
wait "$fake" || true
if [[ $code -eq 3 ]] && grep -q 'no browser tab' "$tmp/err3"; then
  ok "token rejection"
else
  bad "token rejection (exit $code)"
fi

# 12. --check reports an extension that is polling
python3 tests/fake_extension.py gemini --timeout 6 &
fake=$!
tc gemini --check --wait 5 >/dev/null 2>"$tmp/check.err"
code=$?
kill "$fake" 2>/dev/null || true
wait "$fake" 2>/dev/null || true
if [[ $code -eq 0 ]] && grep -q 'is polling for gemini' "$tmp/check.err"; then
  ok "check"
else
  bad "check (exit $code)"
  sed 's/^/     /' "$tmp/check.err"
fi

# 13. persistent server, explicit --server
server_port=$((TERMCHAT_BASE_PORT + 1))
env XDG_CONFIG_HOME="$tmp/config" TERMCHAT_BASE_PORT="$TERMCHAT_BASE_PORT" \
  ./bin/termchat serve --port "$server_port" --bind 127.0.0.1 >"$tmp/serve.log" 2>&1 &
server_pid=$!
sleep 0.6
python3 tests/fake_extension.py gemini --reply "server answer" --timeout 8 &
fake=$!
out="$(tc gemini "hi" --server "127.0.0.1:$server_port" --wait 5 --timeout 10)"
code=$?
wait "$fake" || true
kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=""
if [[ $code -eq 0 && "$out" == "server answer" ]]; then
  ok "server explicit"
else
  bad "server explicit (exit $code, output '$out')"
  sed 's/^/     /' "$tmp/serve.log"
fi

# 14. a local server is auto-detected; two clients queue on one site
env XDG_CONFIG_HOME="$tmp/config" TERMCHAT_BASE_PORT="$TERMCHAT_BASE_PORT" \
  ./bin/termchat serve --port "$TERMCHAT_BASE_PORT" --bind 127.0.0.1 >"$tmp/serve2.log" 2>&1 &
server_pid=$!
sleep 0.6
python3 tests/fake_extension.py gemini --reply @echo --jobs 2 --timeout 12 &
fake=$!
tc gemini "first" --wait 5 --timeout 15 >"$tmp/out1" 2>"$tmp/err1" &
c1=$!
tc gemini "second" --wait 5 --timeout 15 >"$tmp/out2" 2>"$tmp/err2" &
c2=$!
wait "$c1"; r1=$?
wait "$c2"; r2=$?
wait "$fake" || true
kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=""
o1="$(cat "$tmp/out1")"
o2="$(cat "$tmp/out2")"
if [[ $r1 -eq 0 && $r2 -eq 0 ]] \
  && { [[ "$o1" == "first" && "$o2" == "second" ]] \
    || [[ "$o1" == "second" && "$o2" == "first" ]]; }; then
  ok "server queue"
else
  bad "server queue (exits $r1/$r2, outputs '$o1'/'$o2')"
  sed 's/^/     /' "$tmp/serve2.log" "$tmp/err1" "$tmp/err2"
fi

# 15. an abandoned client job does not block later jobs
env XDG_CONFIG_HOME="$tmp/config" TERMCHAT_BASE_PORT="$TERMCHAT_BASE_PORT" \
  TERMCHAT_PENDING_TTL=2 \
  ./bin/termchat serve --port "$TERMCHAT_BASE_PORT" --bind 127.0.0.1 >"$tmp/serve3.log" 2>&1 &
server_pid=$!
sleep 0.6
curl -sS -m 3 -X POST -H 'Content-Type: application/json' \
  -d '{"site":"gemini","prompt":"orphan","timeout":60}' \
  "http://127.0.0.1:$TERMCHAT_BASE_PORT/v1/request" >/dev/null
sleep 2.5
python3 tests/fake_extension.py gemini --reply "after orphan" --timeout 8 &
fake=$!
started=$(date +%s)
out="$(tc gemini "hi" --wait 5 --timeout 8)"
elapsed=$(( $(date +%s) - started ))
wait "$fake" || true
kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=""
if [[ "$out" == "after orphan" && $elapsed -lt 7 ]]; then
  ok "server orphan pruning"
else
  bad "server orphan pruning (output '$out', ${elapsed}s)"
  sed 's/^/     /' "$tmp/serve3.log"
fi

# 15b. the web UI is served, rejects foreign origins and drives the same API
env XDG_CONFIG_HOME="$tmp/config" TERMCHAT_BASE_PORT="$TERMCHAT_BASE_PORT" \
  ./bin/termchat serve --port "$server_port" --bind 127.0.0.1 >"$tmp/serve5.log" 2>&1 &
server_pid=$!
sleep 0.6
base="http://127.0.0.1:$server_port"
index_code=$(curl -sS -o "$tmp/index.html" -w '%{http_code}' "$base/")
css_code=$(curl -sS -o "$tmp/style.css" -w '%{http_code}' "$base/style.css")
js_code=$(curl -sS -o "$tmp/app.js" -w '%{http_code}' "$base/app.js")
md_code=$(curl -sS -o "$tmp/markdown.js" -w '%{http_code}' "$base/markdown.js")
if [[ "$index_code" == 200 && "$css_code" == 200 && "$js_code" == 200 && "$md_code" == 200 ]] \
  && grep -q 'id="composer"' "$tmp/index.html" \
  && grep -q -- '--accent: #CF1A37' "$tmp/style.css" \
  && grep -q '/v1/state/' "$tmp/app.js" \
  && grep -q 'TermchatMarkdown' "$tmp/markdown.js" \
  && node --check "$tmp/app.js" 2>/dev/null \
  && node --check "$tmp/markdown.js" 2>/dev/null; then
  ok "web UI assets"
else
  bad "web UI assets (index=$index_code css=$css_code js=$js_code markdown=$md_code)"
fi

foreign=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H 'Origin: http://evil.example' \
  -d '{"site":"gemini","prompt":"nope"}' "$base/v1/request")
python3 tests/fake_extension.py gemini --reply "web answer" --timeout 8 &
fake=$!
created=$(curl -sS -X POST -H 'Content-Type: application/json' -H "Origin: $base" \
  -d '{"site":"gemini","prompt":"from the page","timeout":10}' "$base/v1/request")
jid=$(printf '%s' "$created" | python3 -c \
  'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
wait "$fake" || true
final=""
if [[ -n "$jid" ]]; then
  final=$(curl -sS "$base/v1/state/$jid?after=0&wait=0" -H "Origin: $base" \
    | python3 -c \
    'import json,sys; d=json.load(sys.stdin); print(d.get("text","") if d.get("state")=="done" else "")' \
    2>/dev/null)
fi
kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=""
if [[ "$foreign" == 403 && "$final" == "web answer" ]]; then
  ok "web UI same-origin flow"
else
  bad "web UI same-origin flow (foreign=$foreign, final='$final', created='$created')"
  sed 's/^/     /' "$tmp/serve5.log"
fi

# 15c. the web page loads without a token, but its API calls still need one
env XDG_CONFIG_HOME="$tmp/config" TERMCHAT_BASE_PORT="$TERMCHAT_BASE_PORT" \
  ./bin/termchat serve --port "$server_port" --bind 127.0.0.1 --token s3cret \
  >"$tmp/serve6.log" 2>&1 &
server_pid=$!
sleep 0.6
page_code=$(curl -sS -o /dev/null -w '%{http_code}' "$base/")
no_token=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H "Origin: $base" \
  -d '{"site":"gemini","prompt":"nope"}' "$base/v1/request")
yes_token=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H "Origin: $base" -H 'X-Termchat-Token: s3cret' \
  -d '{"site":"gemini","prompt":"ok"}' "$base/v1/request")
kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=""
if [[ "$page_code" == 200 && "$no_token" == 401 && "$yes_token" == 200 ]]; then
  ok "web UI token"
else
  bad "web UI token (page=$page_code, without=$no_token, with=$yes_token)"
  sed 's/^/     /' "$tmp/serve6.log"
fi

# 16. queue state machine (fast, no HTTP)
if python3 tests/bridge_test.py >/dev/null 2>"$tmp/bridge.err"; then
  ok "queue state machine"
else
  bad "queue state machine"
  sed 's/^/     /' "$tmp/bridge.err"
fi

# 17. Markdown renderer
if python3 tests/markdown_test.py >/dev/null 2>"$tmp/markdown.err"; then
  ok "markdown renderer"
else
  bad "markdown renderer"
  sed 's/^/     /' "$tmp/markdown.err"
fi

# 17b. the interactive activity line stays quiet when stderr is not a TTY
if python3 tests/activity_test.py >/dev/null 2>"$tmp/activity.err"; then
  ok "activity indicator"
else
  bad "activity indicator"
  sed 's/^/     /' "$tmp/activity.err"
fi

# 17c. the web UI's Markdown renderer escapes HTML and unsafe links
if node tests/web_test.js >/dev/null 2>"$tmp/web.err"; then
  ok "web markdown renderer"
else
  bad "web markdown renderer"
  sed 's/^/     /' "$tmp/web.err"
fi

# 18. answer DOM -> Markdown
if node tests/content_test.js >/dev/null 2>"$tmp/content.err"; then
  ok "answer markdown extraction"
else
  bad "answer markdown extraction"
  sed 's/^/     /' "$tmp/content.err"
fi

# 19. the extension's Markdown reaches the terminal; --plain ignores it
md=$'# Title\n\nSome **bold** text.\n\n```sh\necho hi\n```\n'
esc="$(printf '\033')"
python3 tests/fake_extension.py gemini --reply @echo --markdown "$md" --timeout 8 &
fake=$!
out="$(tc gemini "plain fallback" --markdown --wait 5 --timeout 10)"
wait "$fake" || true
if printf '%s' "$out" | grep -Fq "${esc}[1m${esc}[4m${esc}[36mTitle${esc}[0m" \
  && printf '%s' "$out" | grep -Fq "${esc}[1mbold${esc}[0m" \
  && printf '%s' "$out" | grep -Fq "  ${esc}[36mecho hi${esc}[0m"; then
  ok "markdown end to end"
else
  bad "markdown end to end: $out"
fi

python3 tests/fake_extension.py gemini --reply @echo --markdown "$md" --timeout 8 &
fake=$!
plain="$(tc gemini "plain fallback" --plain --wait 5 --timeout 10)"
wait "$fake" || true
if [[ "$plain" == "plain fallback" ]]; then
  ok "markdown --plain"
else
  bad "markdown --plain: got '$plain'"
fi

# 20. a worker suspended after its last ping gets one longer window
python3 tests/fake_extension.py gemini --reply "late answer" --idle-before 4 --timeout 12 &
fake=$!
out="$(tc gemini "hi" --wait 2 --timeout 10)"
wait "$fake" || true
if [[ "$out" == "late answer" ]]; then
  ok "sleeping extension"
else
  bad "sleeping extension: got '$out'"
fi

# 20b. the same on the shared server
env XDG_CONFIG_HOME="$tmp/config" TERMCHAT_BASE_PORT="$TERMCHAT_BASE_PORT" \
  ./bin/termchat serve --port "$server_port" --bind 127.0.0.1 >"$tmp/serve4.log" 2>&1 &
server_pid=$!
sleep 0.6
python3 tests/fake_extension.py gemini --reply "late server answer" --idle-before 4 --timeout 12 &
fake=$!
out="$(tc gemini "hi" --server "127.0.0.1:$server_port" --wait 2 --timeout 10)"
wait "$fake" || true
kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=""
if [[ "$out" == "late server answer" ]]; then
  ok "sleeping extension on server"
else
  bad "sleeping extension on server: got '$out'"
  sed 's/^/     /' "$tmp/serve4.log"
fi

# 21. the worker forwards the content script's Markdown to the CLI
node tests/sw_harness.js markdown >"$tmp/sw3.log" 2>&1 &
sw=$!
sleep 1
out="$(tc gemini "hi" --markdown --wait 10 --timeout 20)"
wait "$sw"
sw_code=$?
if [[ $sw_code -eq 0 ]] && printf '%s' "$out" | grep -Fq "${esc}[1mHello world${esc}[0m"; then
  ok "worker forwards markdown"
else
  bad "worker forwards markdown (exit $sw_code, output '$out')"
  sed 's/^/     /' "$tmp/sw3.log"
fi

exit $status
