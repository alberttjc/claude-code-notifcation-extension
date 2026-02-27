#!/usr/bin/env bash
# Claude Code PermissionRequest hook
# Posts permission requests to the VS Code extension for modal popup approval.
# Falls back silently to terminal prompt if the extension isn't running.

_EFFECTIVE_USER="${USER:-${LOGNAME:-$(id -un 2>/dev/null || id -u 2>/dev/null || echo unknown)}}"
RUNTIME_DIR="${TMPDIR:-/tmp}/claude-permission-popup-${_EFFECTIVE_USER}"

# Read port from runtime file (written by the extension on startup)
PORT_FILE="${RUNTIME_DIR}/port"
if [ ! -f "$PORT_FILE" ]; then
  echo "Warning: Claude Permission Popup extension not running (no port file)" >&2
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
AUTH_TOKEN=$(cat "$TOKEN_FILE") || { echo "Warning: Failed to read auth token" >&2; exit 0; }

# Read hook JSON from stdin
INPUT=$(cat)

# Extract tool_name and tool_input from the hook payload
PAYLOAD=$(printf '%s' "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
out = {}
out['tool_name'] = data.get('tool_name', 'Unknown')
out['tool_input'] = data.get('tool_input', {})
print(json.dumps(out))
" 2>/dev/null) || { echo "Warning: Failed to parse hook payload" >&2; exit 0; }
if [ -z "$PAYLOAD" ]; then
  echo "Warning: Failed to parse hook payload" >&2
  exit 0
fi

# Post to the extension's HTTP server, capturing HTTP status code
HTTP_RESPONSE=$(printf '%s' "$PAYLOAD" | curl -s \
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
    # Queue full — emit explicit deny
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'
    exit 0
  fi
  echo "Warning: Permission popup server returned HTTP $HTTP_STATUS" >&2
  exit 0
fi

# Parse the decision from the response
DECISION=$(printf '%s' "$HTTP_BODY" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('decision', ''))
" 2>/dev/null) || { echo "Warning: Failed to parse server response" >&2; exit 0; }

if [ "$DECISION" = "allow" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
elif [ "$DECISION" = "deny" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'
fi
# If decision is "dismissed" or unknown, output nothing (fall back to terminal prompt)
