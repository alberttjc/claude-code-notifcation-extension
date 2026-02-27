# Claude Code Permission Popup

A VS Code extension that alerts you when Claude Code is waiting for permission approval in the terminal.

## How It Works

1. Claude Code triggers a permission hook when it wants to run a tool (e.g., Bash, Write, Edit)
2. The hook script (`permission-request.sh`) sends a fire-and-forget notification to the extension's local HTTP server
3. The extension alerts you three ways: VS Code warning notification, yellow status bar, and OS notification
4. You approve or deny the request directly in the terminal (where Claude Code shows its permission prompt)
5. If the extension isn't running, the hook silently exits and Claude Code shows its terminal prompt as usual

The extension shows a clickable status bar indicator (`$(shield) Claude Permissions`). When a permission request arrives, the bar turns yellow with a bell icon. Click it to focus the terminal. It auto-resets after 30 seconds. All activity is logged to the **Claude Permission Popup** output channel.

## Project Structure

```
claude-permission-popup/
├── package.json                            # Extension manifest and configuration
├── extension.js                            # HTTP server + notification logic
├── hooks/permission-request.sh             # Claude Code hook script (uses node + curl)
├── icon.png                                # 128x128 extension icon
├── test-smoke.js                           # Smoke tests
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
| `claudePermissionPopup.osNotifications` | `true` | Send OS-level notifications (via `notify-send` on Linux, `osascript` on macOS) when permission is needed. Useful when VS Code is not in the foreground. |

The port and auth token are shared automatically via runtime files in `/tmp/claude-permission-popup-$USER/`. No environment variables need to be set.

## Commands

| Command | Description |
|---|---|
| **Claude Permission Popup: Show Logs** | Opens the output channel with extension logs |
| **Claude Permission Popup: Install Hook** | Auto-configures the hook in `.claude/settings.json` |
| **Claude Permission Popup: Focus Terminal** | Focuses the integrated terminal and resets the status bar |

All commands are available from the Command Palette (`Ctrl+Shift+P`).

## Features

### Permission Alerts

When Claude Code requests permission, you're alerted three ways:

- **VS Code warning notification** — Shows the tool name with a "Show Terminal" button
- **Status bar highlight** — The status bar turns yellow with a bell icon and the tool name; click to focus the terminal. Auto-resets after 30 seconds.
- **OS notification** — A system notification via `notify-send` (Linux) or `osascript` (macOS), configurable via `osNotifications` setting

You approve or deny the request in the terminal, where Claude Code shows its standard permission prompt.

### Reliability

- **Health check endpoint** — `GET /health` returns `{ status: "ok" }`. The hook script checks this before sending requests for faster failure detection.
- **Server auto-restart** — If the HTTP server crashes unexpectedly, the extension waits 1 second and attempts to restart.
- **Stale file cleanup** — On activation, detects and removes leftover runtime files from previous crashes.

### Security

- **Auth token** — A random 64-character hex token is generated per session and required on all requests (`Authorization: Bearer <token>`)
- **Custom header** — Requires `X-Claude-Permission: true` header to block browser cross-origin requests
- **Body size limit** — Rejects request bodies larger than 1 MB (HTTP 413)
- **Per-second rate limiting** — Maximum 5 requests per second; excess requests receive HTTP 429
- **Runtime directory validation** — Checks the runtime directory is not a symlink and is owned by the current user (`stat.uid`)
- **Localhost only** — Server binds to `127.0.0.1`, never exposed to the network
- **Untrusted workspaces** — Extension declares `untrustedWorkspaces.supported: false`

## Testing

### Smoke Tests

Run the full test suite:

```sh
npm test
```

Tests cover: health endpoint, notification delivery, response time, old endpoint rejection, auth (403/401), body size limit (413), invalid JSON (400), hook script end-to-end, `formatToolDetail`, and `truncate`.

### Manual Testing

Verify the extension is running:

```sh
# Health check (no auth required)
curl -s http://127.0.0.1:$(cat /tmp/claude-permission-popup-$USER/port)/health
```

Send a test notification:

```sh
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "x-claude-permission: true" \
  -H "Authorization: Bearer $(cat /tmp/claude-permission-popup-$USER/auth-token)" \
  -d '{"tool_name":"Bash","tool_input":{"command":"echo hello"}}' \
  "http://127.0.0.1:$(cat /tmp/claude-permission-popup-$USER/port)/notify"
```

You should see `{"status":"notified"}` returned immediately, a VS Code warning notification, and a yellow status bar.

Test the hook script directly:

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | ./hooks/permission-request.sh
```

The script should produce no stdout (Claude Code will show its terminal prompt).

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

### `POST /notify`

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
{ "status": "notified" }
```

The response is returned immediately (fire-and-forget). The extension shows the notification asynchronously.

## Tool Detail Formatting

The notification includes tool-specific details in the logs:

| Tool | Detail shown |
|---|---|
| **Bash** | Command to execute |
| **Edit / MultiEdit** | File path + old/new string previews |
| **Write** | File path + content preview |
| **Grep** | Pattern + search path |
| **Read** | File path + line range (e.g., "lines 10-29") |
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
