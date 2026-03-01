#!/bin/bash
set -euo pipefail

# Resolve the directory where this script (and permission-notify.js) lives
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_SCRIPT="$SCRIPT_DIR/permission-notify.js"

if [ ! -f "$SERVER_SCRIPT" ]; then
  echo "Error: permission-notify.js not found in $SCRIPT_DIR"
  exit 1
fi

# Determine which shell profile to use
if [ -n "${ZSH_VERSION:-}" ] || [ "$(basename "$SHELL")" = "zsh" ]; then
  PROFILE="$HOME/.zshrc"
else
  PROFILE="$HOME/.bashrc"
fi

MARKER="# Claude Code webhook notification server"

# Check if snippet is already installed
if grep -qF "$MARKER" "$PROFILE" 2>/dev/null; then
  echo "Already installed in $PROFILE — skipping."
else
  NOTIFY_PORT="${NOTIFY_PORT:-7777}"
  cat >> "$PROFILE" << EOF

$MARKER
if ! lsof -i :${NOTIFY_PORT} &>/dev/null; then
  node "$SERVER_SCRIPT" &>/dev/null &
  disown
fi
EOF
  echo "Added auto-start snippet to $PROFILE"
fi

NOTIFY_PORT="${NOTIFY_PORT:-7777}"

# Start the server now if not already running
if lsof -i :"$NOTIFY_PORT" &>/dev/null; then
  echo "Server is already running on port $NOTIFY_PORT."
else
  node "$SERVER_SCRIPT" &>/dev/null &
  disown
  echo "Server started on port $NOTIFY_PORT."
fi

echo "Done. New terminals will auto-start the server."
