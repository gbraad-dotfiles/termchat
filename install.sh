#!/usr/bin/env bash
# Link the CLI into ~/.local/bin and print the extension install steps.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
prefix="${PREFIX:-$HOME/.local}"

chmod +x "$here/bin/termchat" "$here/build.sh" "$here/pack_crx.py" "$here/tests/run.sh" "$here/tests/fake_extension.py"
mkdir -p "$prefix/bin"
ln -sf "$here/bin/termchat" "$prefix/bin/termchat"

echo "linked $prefix/bin/termchat"
echo
echo "Load the browser extension (Chromium / Vivaldi / Chrome / Edge):"
echo "  1. open chrome://extensions"
echo "  2. enable Developer mode (top right)"
echo "  3. click 'Load unpacked' and choose:"
echo "       $here/extension"
echo
echo "Then open https://gemini.google.com, https://copilot.microsoft.com or"
echo "https://chat.deepseek.com, sign in, and leave the tab open."
echo
echo "Try: termchat gemini 'hello'"
echo
echo "Flatpak browsers only see their sandbox. If the file picker cannot reach"
echo "this directory, either grant access:"
echo "  flatpak override --user --filesystem=$here com.vivaldi.Vivaldi"
echo "or copy the extension somewhere the sandbox can read and load it there."
