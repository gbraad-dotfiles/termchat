#!/usr/bin/env bash
# End-to-end tests for the CLI <-> extension protocol, using a fake extension.
set -uo pipefail
cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
status=0

# Keep the fake/harness away from 8765-8774, where a real extension may be
# polling. The CLI, fake extension and service-worker harness all read this.
export TERMCHAT_BASE_PORT="${TERMCHAT_TEST_PORT:-18765}"

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

exit $status
