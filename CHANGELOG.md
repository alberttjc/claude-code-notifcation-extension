# Changelog

All notable changes to the Claude Code Permission Popup extension will be documented in this file.

## [0.1.0] - 2026-02-27

### Added
- `claudePermissionPopup.showLogs` command to open the output channel from the Command Palette
- `claudePermissionPopup.installHook` command to auto-configure the hook in `.claude/settings.json`
- Clickable status bar item that opens logs
- "Allow All for Session" option on permission dialogs for auto-approving subsequent requests
- `GET /health` endpoint for faster failure detection from the hook script
- Health check in hook script before posting permission requests
- Graceful shutdown: pending requests receive `dismissed` on deactivation, preventing Claude Code hangs
- Server auto-restart on unexpected errors (1-second delay before retry)
- Stale runtime file detection and cleanup on activation
- Ownership check (`stat.uid`) on runtime directory for defense in depth
- Per-second rate limiting (max 5 requests/second, returns HTTP 429)
- Activation notification in status bar tooltip confirming the server port
- Getting Started walkthrough with 3 setup steps
- ESLint configuration for consistent code style
- 30 smoke tests covering all endpoints, security, and utilities
- `.vscodeignore` for smaller packaged extension
- Extension icon (128x128 PNG)

### Changed
- Permission UI switched from `showWarningMessage` modal to QuickPick for richer display with labeled options
- Hook script now uses Node.js instead of python3 for JSON parsing (no more python3 dependency)
- Hook script uses `curl --fail-with-body` for better error handling
- `categories` updated to `["Programming Languages", "Other"]`
- Declared `capabilities.untrustedWorkspaces.supported: false`
- `npm test` script now available for running smoke tests

### Fixed
- Extension could leave Claude Code hanging if deactivated with pending requests

## [0.0.2] - 2026-02-26

### Added
- Initial release with HTTP server, modal dialogs, auth token security
- Queue-based permission request processing (max 10 pending)
- Status bar indicator with pending count
- Configurable port and modal timeout
- Hook script for Claude Code integration (required python3 + curl)
- Body size limit (1 MB)
- Symlink attack protection on runtime directory
- Custom header requirement to block cross-origin browser requests
