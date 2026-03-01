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

# Kill the notification server by process name (avoids killing unrelated processes)
PIDS=$(pgrep -f "node.*permission-notify" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null && echo "Stopped notification server." || true
else
  echo "No notification server running."
fi

echo "Done. Uninstalled."
