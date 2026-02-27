# Claude Code Permission Popup

A VS Code extension that shows interactive popup dialogs for Claude Code permission requests instead of terminal prompts.

## How It Works

1. Claude Code triggers a permission hook when it wants to run a tool (e.g., Bash, Write, Edit)
2. The hook script (`permission-request.sh`) first runs a health check, then sends the request to a local HTTP server run by the extension
3. VS Code shows a QuickPick dialog with the tool name and details
4. You select **Allow**, **Deny**, or **Allow All for Session**, and the decision flows back to Claude Code
5. Pressing **Escape** dismisses the dialog and falls back to the terminal prompt

The extension shows a clickable status bar indicator (`$(shield) Claude Permissions`) with the count of pending requests. Click it to open the logs. All activity is logged to the **Claude Permission Popup** output channel.

If the extension isn't running, the hook silently exits and Claude Code falls back to its default terminal prompt.

## Project Structure

```
claude-permission-popup/
├── package.json                            # Extension manifest and configuration
├── extension.js                            # HTTP server + QuickPick dialog logic
├── hooks/permission-request.sh             # Claude Code hook script (uses node + curl)
├── icon.png                                # 128x128 extension icon
├── test-smoke.js                           # Smoke tests (30 tests)
├── .vscodeignore                           # Files excluded from packaged extension
├── .eslintrc.json                          # ESLint configuration
├── CHANGELOG.md                            # Version history
└── LICENSE                                 # MIT License
```

## Installation

### From .vsix

1. Build the package:

   ```sh
   npm install
   npx vsce package
   ```

2. Install the extension:

   ```sh
   code --install-extension claude-permission-popup-0.1.0.vsix
   ```

3. Reload the VS Code window (`Ctrl+Shift+P` → "Developer: Reload Window")

### From Extension Development Host

1. Open the `claude-permission-popup/` folder in VS Code
2. Press `F5` to launch the Extension Development Host

## Setup

### Automatic (Recommended)

Run **Claude Permission Popup: Install Hook** from the Command Palette (`Ctrl+Shift+P`). This writes the hook configuration to your `.claude/settings.json` automatically.

### Manual

Add this to your `.claude/settings.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/claude-permission-popup/hooks/permission-request.sh"
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/` with the actual path to the extension source.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `claudePermissionPopup.port` | `0` | Port for the local HTTP server. `0` = random available port, auto-discovered by the hook script. |
| `claudePermissionPopup.modalTimeout` | `300000` | Timeout in ms for the permission dialog. Default: 5 minutes. If no response, the dialog is dismissed and Claude Code falls back to the terminal prompt. |

The port and auth token are shared automatically via runtime files in `/tmp/claude-permission-popup-$USER/`. No environment variables need to be set.

## Commands

| Command | Description |
|---|---|
| **Claude Permission Popup: Show Logs** | Opens the output channel with extension logs |
| **Claude Permission Popup: Install Hook** | Auto-configures the hook in `.claude/settings.json` |
| **Claude Permission Popup: Revoke Allow All** | Disables the "Allow All for Session" auto-approve mode and restores per-request prompts |

All commands are available from the Command Palette (`Ctrl+Shift+P`).

## Features

### Permission Dialog

When Claude Code requests permission, a QuickPick dialog appears with three options:

- **Allow** — Permit this specific action
- **Deny** — Block this specific action
- **Allow All for Session** — Auto-approve all subsequent requests until the VS Code window is reloaded or **Claude Permission Popup: Revoke Allow All** is run

### Reliability

- **Health check endpoint** — `GET /health` returns `{ status: "ok" }`. The hook script checks this before sending requests for faster failure detection.
- **Graceful shutdown** — When the extension deactivates, all pending requests receive a `dismissed` response so Claude Code doesn't hang waiting.
- **Server auto-restart** — If the HTTP server crashes unexpectedly, the extension waits 1 second and attempts to restart.
- **Stale file cleanup** — On activation, detects and removes leftover runtime files from previous crashes.

### Security

- **Auth token** — A random 64-character hex token is generated per session and required on all requests (`Authorization: Bearer <token>`)
- **Custom header** — Requires `X-Claude-Permission: true` header to block browser cross-origin requests
- **Body size limit** — Rejects request bodies larger than 1 MB (HTTP 413)
- **Queue cap** — Maximum 10 pending requests; additional requests receive HTTP 429
- **Per-second rate limiting** — Maximum 5 requests per second; excess requests receive HTTP 429
- **Runtime directory validation** — Checks the runtime directory is not a symlink and is owned by the current user (`stat.uid`)
- **Localhost only** — Server binds to `127.0.0.1`, never exposed to the network
- **Untrusted workspaces** — Extension declares `untrustedWorkspaces.supported: false`

## Testing

### Smoke Tests

Run the full test suite (30 tests):

```sh
npm test
```

Tests cover: health endpoint, allow/deny decisions, QuickPick UI, auth (403/401), body size limit (413), invalid JSON (400), queue overflow (429), hook script end-to-end, `formatToolDetail`, and `truncate`.

### Manual Testing

Verify the extension is running:

```sh
# Health check (no auth required)
curl -s http://127.0.0.1:$(cat /tmp/claude-permission-popup-$USER/port)/health
```

Send a test permission request:

```sh
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "x-claude-permission: true" \
  -H "Authorization: Bearer $(cat /tmp/claude-permission-popup-$USER/auth-token)" \
  -d '{"tool_name":"Bash","tool_input":{"command":"echo hello"}}' \
  "http://127.0.0.1:$(cat /tmp/claude-permission-popup-$USER/port)/permission"
```

A QuickPick dialog should appear in VS Code. Selecting Allow returns `{"decision":"allow"}`, Deny returns `{"decision":"deny"}`, Allow All for Session returns `{"decision":"allow"}` and enables auto-approve mode, and pressing Escape returns `{"decision":"dismissed"}`.

Test the hook script directly:

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | ./hooks/permission-request.sh
```

Check the **Output** panel → **Claude Permission Popup** for logs.

## Hook Script Dependencies

The hook script requires:

- **node** — for JSON parsing (guaranteed available when VS Code is installed)
- **curl** — for HTTP requests to the extension

> **Note:** Previous versions required `python3`. As of v0.1.0, the hook script uses `node` instead.

## HTTP API Reference

The extension runs a local HTTP server with two endpoints:

### `GET /health`

No authentication required. Returns server status.

```json
{ "status": "ok" }
```

### `POST /permission`

Requires `X-Claude-Permission: true` header and `Authorization: Bearer <token>` header.

**Request body:**
```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "echo hello" }
}
```

**Response:**
```json
{ "decision": "allow" }
```

Possible `decision` values: `"allow"`, `"deny"`, `"dismissed"`.

## Tool Detail Formatting

The dialog shows tool-specific details:

| Tool | Detail shown |
|---|---|
| **Bash** | Command to execute |
| **Edit / MultiEdit** | File path + old/new string previews |
| **Write** | File path + content preview |
| **Grep** | Pattern + search path |
| **Read** | File path + line range (e.g., "lines 10–29") |
| **Other** | Command, file path, or truncated JSON |

## Development

```sh
# Install dev dependencies
npm install

# Run linter
npm run lint

# Run tests
npm test

# Package for distribution
npx vsce package
```

The `vscode:prepublish` script runs lint + tests automatically before packaging.

## License

MIT — see [LICENSE](LICENSE).
