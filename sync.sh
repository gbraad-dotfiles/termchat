#!/usr/bin/env bash
# Sync this folder to another machine, keeping the same relative path.
#
#   ./sync.sh                 # -> gbraad@10.0.21.52:~/Projects/gbraad-dotfiles/terminal-chat/
#   REMOTE=host ./sync.sh     # different host
#   ./sync.sh --build         # refresh dist/ (zip + crx) before sending
#   ./sync.sh --delete        # mirror: remove files on the target that are gone here
#   ./sync.sh --dry-run       # show what would be transferred
#
# Authentication is whatever ssh uses; it will prompt for a password unless a
# key is installed. The remote destination is created if it does not exist.
set -euo pipefail
cd "$(dirname "$0")"

remote="${REMOTE:-gbraad@10.0.21.52}"
remote_dir="${REMOTE_DIR:-Projects/gbraad-dotfiles/terminal-chat}"

delete=0
build=0
include_git=1
dry_run=0

usage() {
  cat <<'EOF'
Sync this folder to another machine, keeping the same relative path.

  ./sync.sh                 # -> gbraad@10.0.21.52:~/Projects/gbraad-dotfiles/terminal-chat/
  REMOTE=host ./sync.sh     # different host
  ./sync.sh --build         # refresh dist/ (zip + crx) before sending
  ./sync.sh --delete        # mirror: remove files on the target that are gone here
  ./sync.sh --dry-run       # show what would be transferred
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete) delete=1 ;;
    --build) build=1 ;;
    --no-git) include_git=0 ;;
    -n|--dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

command -v rsync >/dev/null || { echo "rsync is not installed" >&2; exit 1; }

if [[ $build -eq 1 ]]; then
  ./build.sh
fi

if [[ "$remote_dir" == /* ]]; then
  remote_abs="$remote_dir"
else
  remote_abs="\$HOME/$remote_dir"
fi

args=(-a --human-readable --itemize-changes)
args+=(--exclude='__pycache__/' --exclude='*.pyc' --exclude='.DS_Store')
[[ $include_git -eq 0 ]] && args+=(--exclude='.git/')
[[ $delete -eq 1 ]] && args+=(--delete)
[[ $dry_run -eq 1 ]] && args+=(--dry-run)

echo "syncing $(pwd)/ -> $remote:$remote_dir/"
rsync "${args[@]}" \
  --rsync-path="mkdir -p \"$remote_abs\" && rsync" \
  ./ "$remote:$remote_dir/"
echo "done"
