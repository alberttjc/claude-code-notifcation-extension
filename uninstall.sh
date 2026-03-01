#!/bin/bash
set -euo pipefail

MARKER="# Claude Code webhook notification server"

# Remove snippet from shell profiles
for PROFILE in "$HOME/.zshrc" "$HOME/.bashrc"; do
  if [ -f "$PROFILE" ] && grep -qF "$MARKER" "$PROFILE"; then
    # Remove the snippet block (marker line + next 4 lines)
    sed -i.bak "/$MARKER/,+4d" "$PROFILE"
    # Clean up trailing blank lines left behind
    sed -i.bak -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$PROFILE"
    rm -f "${PROFILE}.bak"
    echo "Removed auto-start snippet from $PROFILE"
  fi
done

# Kill any running server on port 7777
if lsof -i :7777 &>/dev/null; then
  kill $(lsof -ti :7777) 2>/dev/null && echo "Stopped server on port 7777." || true
else
  echo "No server running on port 7777."
fi

echo "Done. Uninstalled."
