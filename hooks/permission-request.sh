#!/usr/bin/env bash
# Claude Code PermissionRequest hook
# Posts permission requests to the VS Code extension for modal popup approval.
# Falls back silently to terminal prompt if the extension isn't running.

set -u

_EFFECTIVE_USER="${USER:-${LOGNAME:-$(id -un 2>/dev/null || id -u 2>/dev/null || echo unknown)}}"

# Determine runtime directory base — prefer XDG_RUNTIME_DIR (per-user, secure)
# [Security Fix: Finding 5 — match extension's getRuntimeBase()]
if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "$XDG_RUNTIME_DIR" ]; then
  _RUNTIME_BASE="$XDG_RUNTIME_DIR"
else
  _RUNTIME_BASE="${TMPDIR:-/tmp}"
fi

RUNTIME_DIR="${_RUNTIME_BASE}/claude-permission-popup-${_EFFECTIVE_USER}"

# [Security Fix: Finding 7] Validate TMPDIR/runtime base is a real directory
if [ -L "$_RUNTIME_BASE" ]; then
  echo "Warning: Runtime base directory is a symlink, refusing to continue" >&2
  exit 0
fi

# [Security Fix: Finding 6] Validate runtime directory is not a symlink
if [ -L "$RUNTIME_DIR" ]; then
  echo "Warning: Runtime directory is a symlink, refusing to continue" >&2
  exit 0
fi

if [ ! -d "$RUNTIME_DIR" ]; then
  echo "Warning: Claude Permission Popup extension not running (no runtime dir)" >&2
  exit 0
fi

# [Security Fix: Finding 6] Validate runtime directory ownership
# stat -c %u is GNU/Linux, stat -f %u is macOS/BSD
_DIR_OWNER=$(stat -c %u "$RUNTIME_DIR" 2>/dev/null || stat -f %u "$RUNTIME_DIR" 2>/dev/null)
_MY_UID=$(id -u)
if [ -n "$_DIR_OWNER" ] && [ "$_DIR_OWNER" != "$_MY_UID" ]; then
  echo "Warning: Runtime directory not owned by current user (owner: $_DIR_OWNER, expected: $_MY_UID)" >&2
  exit 0
fi

# Read port from runtime file (written by the extension on startup)
PORT_FILE="${RUNTIME_DIR}/port"
if [ ! -f "$PORT_FILE" ]; then
  echo "Warning: Claude Permission Popup extension not running (no port file)" >&2
  exit 0
fi

# [Security Fix: Finding 6] Validate port file is not a symlink
if [ -L "$PORT_FILE" ]; then
  echo "Warning: Port file is a symlink, refusing to read" >&2
  exit 0
fi

PORT=$(cat "$PORT_FILE") || { echo "Warning: Failed to read port file" >&2; exit 0; }

# Validate port is numeric and in range 1–65535
if ! printf '%s' "$PORT" | grep -qE '^[0-9]+$' || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "Warning: Invalid port number: $PORT" >&2
  exit 0
fi

# Read auth token from runtime file
TOKEN_FILE="${RUNTIME_DIR}/auth-token"
if [ ! -f "$TOKEN_FILE" ]; then
  echo "Warning: Claude Permission Popup auth token not found" >&2
  exit 0
fi

# [Security Fix: Finding 6] Validate token file is not a symlink
if [ -L "$TOKEN_FILE" ]; then
  echo "Warning: Auth token file is a symlink, refusing to read" >&2
  exit 0
fi

AUTH_TOKEN=$(cat "$TOKEN_FILE") || { echo "Warning: Failed to read auth token" >&2; exit 0; }

# Health check — verify the server is running before sending the full request
HEALTH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 1 "http://127.0.0.1:${PORT}/health" 2>/dev/null)
if [ "$HEALTH_STATUS" != "200" ]; then
  echo "Warning: Claude Permission Popup server not responding (health check failed)" >&2
  exit 0
fi

# Read hook JSON from stdin
INPUT=$(cat)

# Extract tool_name and tool_input using Node.js (guaranteed available via VS Code)
PAYLOAD=$(printf '%s' "$INPUT" | node -e "
  let data = '';
  process.stdin.on('data', c => data += c);
  process.stdin.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const out = {
        tool_name: parsed.tool_name || 'Unknown',
        tool_input: parsed.tool_input || {}
      };
      process.stdout.write(JSON.stringify(out));
    } catch (e) {
      process.exit(1);
    }
  });
" 2>/dev/null) || { echo "Warning: Failed to parse hook payload" >&2; exit 0; }

if [ -z "$PAYLOAD" ]; then
  echo "Warning: Failed to parse hook payload" >&2
  exit 0
fi

# Post to the extension's HTTP server, capturing HTTP status code
HTTP_RESPONSE=$(printf '%s' "$PAYLOAD" | curl -s \
  --fail-with-body \
  --connect-timeout 2 \
  --max-time 300 \
  -w '\n%{http_code}' \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-Claude-Permission: true" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  --data-binary @- \
  "http://127.0.0.1:${PORT}/permission" 2>/dev/null)

if [ $? -ne 0 ]; then
  echo "Warning: Failed to reach permission popup server" >&2
  exit 0
fi

# Split response body and HTTP status code
HTTP_STATUS="${HTTP_RESPONSE##*$'\n'}"
HTTP_BODY="${HTTP_RESPONSE%$'\n'*}"

# Handle non-200 responses
if [ "$HTTP_STATUS" != "200" ]; then
  if [ "$HTTP_STATUS" = "429" ]; then
    # Queue full or rate limited — emit explicit deny
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'
    exit 0
  fi
  echo "Warning: Permission popup server returned HTTP $HTTP_STATUS" >&2
  exit 0
fi

# Parse the decision from the response using Node.js
DECISION=$(printf '%s' "$HTTP_BODY" | node -e "
  let data = '';
  process.stdin.on('data', c => data += c);
  process.stdin.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      process.stdout.write(parsed.decision || '');
    } catch (e) {
      process.exit(1);
    }
  });
" 2>/dev/null) || { echo "Warning: Failed to parse server response" >&2; exit 0; }

if [ "$DECISION" = "allow" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
elif [ "$DECISION" = "deny" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'
fi
# If decision is "dismissed" or unknown, output nothing (fall back to terminal prompt)
