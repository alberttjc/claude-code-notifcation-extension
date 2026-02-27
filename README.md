# Claude Code Permission Popup

A VS Code extension that shows modal popup dialogs for Claude Code permission requests instead of terminal prompts.

## How It Works

1. Claude Code triggers a permission hook when it wants to run a tool (e.g., Bash, Write, Edit)
2. The hook script (`permission-request.sh`) sends the request to a local HTTP server run by the extension
3. VS Code shows a modal warning dialog with the tool name and details
4. You click **Allow** or **Deny**, and the decision flows back to Claude Code
5. Pressing **Escape** dismisses the dialog and falls back to the terminal prompt

The extension shows a status bar indicator (`$(shield) Claude Permissions`) with the count of pending requests. All activity is logged to the **Claude Permission Popup** output channel.

If the extension isn't running, the hook silently exits and Claude Code falls back to its default terminal prompt.

## Project Structure

```
claude-permission-popup/
├── package.json                            # Extension manifest and configuration
├── extension.js                            # HTTP server + modal dialog logic
├── hooks/permission-request.sh             # Claude Code hook script
└── claude-permission-popup-0.0.2.vsix      # Packaged extension (ready to install)
```

## Installation

1. Install the extension:

   ```sh
   code --install-extension claude-permission-popup-0.0.2.vsix
   ```

2. Reload the VS Code window (`Ctrl+Shift+P` → "Developer: Reload Window")

3. Configure the Claude Code hook in `.claude/settings.json`:

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
| `claudePermissionPopup.port` | `0` | Port for the local HTTP server (0 = random available port, auto-discovered by hook) |
| `claudePermissionPopup.modalTimeout` | `300000` | Timeout in ms for the permission modal (default: 5 minutes) |

The port and auth token are shared automatically via runtime files in `/tmp/claude-permission-popup-$USER/`. No environment variables need to be set.

## Testing

Verify the extension is running:

```sh
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "x-claude-permission: true" \
  -H "Authorization: Bearer $(cat /tmp/claude-permission-popup-$USER/auth-token)" \
  -d '{"tool_name":"Bash","tool_input":{"command":"echo hello"}}' \
  "http://127.0.0.1:$(cat /tmp/claude-permission-popup-$USER/port)/permission"
```

A modal dialog should appear in VS Code. Clicking Allow returns `{"decision":"allow"}`, Deny returns `{"decision":"deny"}`, and pressing Escape returns `{"decision":"dismissed"}`.

Test the hook script directly:

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | ./hooks/permission-request.sh
```

Check the **Output** panel → **Claude Permission Popup** for logs.

## Dependencies

The hook script requires:

- **python3** — for JSON parsing
- **curl** — for HTTP requests to the extension

## Tool Detail Formatting

The modal shows tool-specific details:

| Tool | Detail shown |
|---|---|
| **Bash** | Command to execute |
| **Edit / MultiEdit** | File path + old/new string previews |
| **Write** | File path + content preview |
| **Grep** | Pattern + search path |
| **Read** | File path + line range |
| **Other** | Command, file path, or truncated JSON |
