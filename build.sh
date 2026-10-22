#!/usr/bin/env bash
# Build the loadable extension directories under dist/.
set -euo pipefail
cd "$(dirname "$0")"

target="${1:-all}"
case "$target" in
  all|chromium|firefox) ;;
  *) echo "usage: $0 [all|chromium|firefox]" >&2; exit 2 ;;
esac

rm -rf dist
mkdir -p dist

if [[ "$target" == "all" || "$target" == "chromium" ]]; then
  mkdir -p dist/chromium
  cp extension/manifest.json extension/background.js extension/content.js \
    extension/options.html extension/options.js dist/chromium/
  (cd dist/chromium && zip -qr ../termchat-chromium.zip .)
  python3 pack_crx.py dist/chromium dist/termchat-chromium.crx
  echo "chromium extension: dist/chromium"
  echo "chromium package:   dist/termchat-chromium.zip, dist/termchat-chromium.crx"
fi

if [[ "$target" == "all" || "$target" == "firefox" ]]; then
  mkdir -p dist/firefox
  cp extension/background.js extension/content.js extension/options.html extension/options.js dist/firefox/
  python3 - <<'PY'
import json
from pathlib import Path

manifest = json.loads(Path("extension/manifest.json").read_text(encoding="utf-8"))
manifest["background"] = {"scripts": ["background.js"]}
manifest["browser_specific_settings"] = {
    "gecko": {"id": "termchat@localhost", "strict_min_version": "115.0"}
}
Path("dist/firefox/manifest.json").write_text(
    json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
)
PY
  echo "firefox extension:  dist/firefox"
  (cd dist/firefox && zip -qr ../termchat-firefox.zip .)
  echo "firefox package:    dist/termchat-firefox.zip"
fi
