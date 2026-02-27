const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const vscode = require('vscode');

const MAX_BODY = 1024 * 1024; // 1 MB
const MAX_DISPLAY_LEN = 500;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX = 5;
const STATUS_BAR_DECAY_MS = 30 * 1000; // 30 seconds

let server = null;
let runtimeDir = null;
let outputChannel = null;
let statusBarItem = null;
let statusBarDecayTimer = null;

// Rate limiting state
const rateLimitTimestamps = [];

function getRuntimeUser() {
  if (process.env.USER) return process.env.USER;
  if (process.env.LOGNAME) return process.env.LOGNAME;
  try { const info = os.userInfo(); if (info.username) return info.username; } catch {}
  return String(process.getuid ? process.getuid() : 'unknown');
}

function log(message) {
  if (outputChannel) {
    outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

function updateStatusBar() {
  if (!statusBarItem) return;
  statusBarItem.text = '$(shield) Claude Permissions';
  statusBarItem.tooltip = 'Claude Permission Popup is active — click to show logs';
  statusBarItem.command = 'claudePermissionPopup.showLogs';
  statusBarItem.backgroundColor = undefined;
}

function flashStatusBarWarning(toolName) {
  if (!statusBarItem) return;
  statusBarItem.text = `$(bell) Permission needed: ${truncate(toolName, 30)}`;
  statusBarItem.tooltip = 'Claude Code is waiting for permission — click to focus terminal';
  statusBarItem.command = 'claudePermissionPopup.focusTerminal';
  statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

  // Clear any existing decay timer
  if (statusBarDecayTimer) {
    clearTimeout(statusBarDecayTimer);
  }
  // Auto-reset after 30 seconds
  statusBarDecayTimer = setTimeout(() => {
    resetStatusBar();
  }, STATUS_BAR_DECAY_MS);
}

function resetStatusBar() {
  if (statusBarDecayTimer) {
    clearTimeout(statusBarDecayTimer);
    statusBarDecayTimer = null;
  }
  updateStatusBar();
}

function sendOsNotification(title, message) {
  const config = vscode.workspace.getConfiguration('claudePermissionPopup');
  if (!config.get('osNotifications', true)) return;

  try {
    if (process.platform === 'darwin') {
      execFile('osascript', ['-e', `display notification "${message}" with title "${title}"`], () => {});
    } else if (process.platform === 'linux') {
      execFile('notify-send', [title, message], () => {});
    }
    // Windows: no-op (VS Code notification is sufficient)
  } catch {
    // Best-effort — silently ignore errors
  }
}

function handleNotification(data) {
  const toolName = truncate(data.tool_name || 'Unknown tool', MAX_DISPLAY_LEN);
  const toolInput = data.tool_input || {};
  const detail = formatToolDetail(data.tool_name || '', toolInput);

  log(`Permission notification for tool: ${toolName}`);

  // Flash status bar yellow
  flashStatusBarWarning(toolName);

  // Show VS Code warning notification with "Show Terminal" button
  vscode.window.showWarningMessage(
    `Claude Code needs permission: ${toolName}`,
    'Show Terminal'
  ).then(choice => {
    if (choice === 'Show Terminal') {
      vscode.commands.executeCommand('workbench.action.terminal.focus');
      resetStatusBar();
    }
  });

  // Send OS-level notification
  sendOsNotification('Claude Code Permission', `Waiting for approval: ${toolName}`);

  // Bring VS Code to the foreground
  vscode.commands.executeCommand('workbench.action.focusWindow');

  log(`Notification detail: ${detail}`);
}

function formatToolDetail(toolName, toolInput) {
  switch (toolName) {
    case 'Edit':
    case 'MultiEdit': {
      let detail = toolInput.file_path || '';
      if (toolInput.old_string) {
        detail += `\n\nOld: ${truncate(toolInput.old_string, 200)}`;
      }
      if (toolInput.new_string) {
        detail += `\nNew: ${truncate(toolInput.new_string, 200)}`;
      }
      return truncate(detail, MAX_DISPLAY_LEN);
    }
    case 'Write': {
      let detail = toolInput.file_path || '';
      if (toolInput.content) {
        detail += `\n\nContent: ${truncate(toolInput.content, 200)}`;
      }
      return truncate(detail, MAX_DISPLAY_LEN);
    }
    case 'Grep': {
      let detail = '';
      if (toolInput.pattern) detail += `Pattern: ${toolInput.pattern}`;
      if (toolInput.path) detail += `\nPath: ${toolInput.path}`;
      return truncate(detail, MAX_DISPLAY_LEN);
    }
    case 'Read': {
      let detail = toolInput.file_path || '';
      const offset = typeof toolInput.offset === 'number' ? toolInput.offset : 0;
      const limit = typeof toolInput.limit === 'number' ? toolInput.limit : 0;
      if (offset > 0 && limit > 0) {
        detail += ` (lines ${offset}–${offset + limit - 1})`;
      } else if (offset > 0) {
        detail += ` (from line ${offset})`;
      } else if (limit > 0) {
        detail += ` (lines 1–${limit})`;
      }
      return truncate(detail, MAX_DISPLAY_LEN);
    }
    case 'Bash': {
      return truncate(toolInput.command || '', MAX_DISPLAY_LEN);
    }
    default: {
      if (toolInput.command) {
        return truncate(toolInput.command, MAX_DISPLAY_LEN);
      }
      if (toolInput.file_path) {
        return truncate(toolInput.file_path, MAX_DISPLAY_LEN);
      }
      const inputStr = JSON.stringify(toolInput, null, 2);
      return inputStr.length > 200 ? inputStr.slice(0, 200) + '...' : inputStr;
    }
  }
}

/**
 * Check per-second rate limit. Returns true if the request should be allowed.
 */
function checkRateLimit() {
  const now = Date.now();
  // Remove timestamps outside the window
  while (rateLimitTimestamps.length > 0 && rateLimitTimestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
    rateLimitTimestamps.shift();
  }
  if (rateLimitTimestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }
  rateLimitTimestamps.push(now);
  return true;
}

/**
 * Timing-safe comparison of the Authorization header against the expected token.
 * Prevents timing side-channel attacks on localhost where network jitter is minimal.
 * [Security Fix: Finding 3]
 */
function verifyAuthToken(header, authToken) {
  const expected = Buffer.from(`Bearer ${authToken}`);
  const actual = Buffer.from(header || '');
  if (expected.length !== actual.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

function truncate(str, max) {
  if (typeof str !== 'string') return String(str).slice(0, max);
  return str.length > max ? str.slice(0, max) + '...' : str;
}

/**
 * Validate ownership of the runtime directory.
 * Returns true if safe to use, false otherwise.
 */
function validateRuntimeDir(dirPath) {
  try {
    const stat = fs.lstatSync(dirPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      log('Runtime directory is a symlink or not a directory');
      return false;
    }
    // Check ownership if getuid is available (Unix)
    if (typeof process.getuid === 'function') {
      if (stat.uid !== process.getuid()) {
        log(`Runtime directory owned by uid ${stat.uid}, expected ${process.getuid()}`);
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely write a file into the runtime directory with re-validation.
 * Re-checks directory integrity immediately before each write to close the
 * TOCTOU gap between initial validation and file creation.
 * [Security Fix: Findings 1 & 2]
 */
function safeWriteRuntimeFile(filename, content) {
  // Re-validate the runtime directory right before writing
  if (!validateRuntimeDir(runtimeDir)) {
    throw new Error('Runtime directory validation failed before write');
  }

  // Resolve the real path to detect symlinks on the file itself
  // Use the directory's real path, not the potentially-symlinked one
  const realDir = fs.realpathSync(runtimeDir);
  const realFilePath = path.join(realDir, filename);

  // Ensure the resolved path is still within the expected directory
  if (!realFilePath.startsWith(realDir + path.sep) && realFilePath !== realDir) {
    throw new Error('Runtime file path escapes runtime directory');
  }

  // Write with restricted permissions using the resolved path
  fs.writeFileSync(realFilePath, content, { mode: 0o600 });
}

/**
 * Clean up stale runtime files from a previous crash.
 */
function cleanupStaleRuntimeFiles(dirPath) {
  const portFile = path.join(dirPath, 'port');
  const tokenFile = path.join(dirPath, 'auth-token');
  let cleaned = false;
  if (fs.existsSync(portFile)) {
    try { fs.unlinkSync(portFile); cleaned = true; } catch {}
  }
  if (fs.existsSync(tokenFile)) {
    try { fs.unlinkSync(tokenFile); cleaned = true; } catch {}
  }
  if (cleaned) {
    log('Cleaned up stale runtime files from a previous session');
  }
}

/**
 * Determine the best runtime directory base path.
 * Prefers XDG_RUNTIME_DIR (per-user, not world-readable) over TMPDIR/tmp.
 * [Security Fix: Finding 5]
 */
function getRuntimeBase() {
  // XDG_RUNTIME_DIR is per-user, mode 0700, and managed by the OS
  if (process.env.XDG_RUNTIME_DIR) {
    try {
      const stat = fs.statSync(process.env.XDG_RUNTIME_DIR);
      if (stat.isDirectory()) {
        return process.env.XDG_RUNTIME_DIR;
      }
    } catch {}
  }
  return os.tmpdir();
}

function createHttpServer(authToken) {
  return http.createServer((req, res) => {
    // Health check endpoint — no auth required but no state leaked
    // [Security Fix: Finding 4]
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Deny CORS preflight explicitly [Security Fix: Finding 8]
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Require custom header to block browser cross-origin requests
    if (req.headers['x-claude-permission'] !== 'true') {
      log('Rejected request: missing x-claude-permission header');
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Missing required header' }));
      return;
    }

    // Validate auth token using timing-safe comparison [Security Fix: Finding 3]
    if (!verifyAuthToken(req.headers['authorization'], authToken)) {
      log('Rejected request: invalid auth token');
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/notify') {
      res.writeHead(404);
      res.end();
      return;
    }

    // Per-second rate limiting
    if (!checkRateLimit()) {
      log('Rate limit exceeded');
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
      return;
    }

    // Enforce body size limit
    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        aborted = true;
        res.writeHead(413);
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (aborted) return;

      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      log(`Received notification for tool: ${data.tool_name || 'Unknown'}`);

      // Fire-and-forget: respond immediately, then show notification
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'notified' }));

      handleNotification(data);
    });
  });
}

function startServer(authToken, listenPort, context) {
  server = createHttpServer(authToken);

  server.listen(listenPort, '127.0.0.1', () => {
    const actualPort = server.address().port;
    log(`Server listening on 127.0.0.1:${actualPort}`);

    // Write port and auth token with re-validation before each write
    // [Security Fix: Findings 1 & 2]
    try {
      safeWriteRuntimeFile('port', String(actualPort));
      safeWriteRuntimeFile('auth-token', authToken);
    } catch (err) {
      vscode.window.showErrorMessage(`Claude Permission Popup: Failed to write runtime files: ${err.code || err.message}`);
      log(`Failed to write runtime files: ${err.message}`);
    }

    // Show activation notification
    statusBarItem.text = '$(shield) Claude Permissions';
    statusBarItem.tooltip = `Claude Permission Popup is active on port ${actualPort} — click to show logs`;
    log(`Extension activated successfully on port ${actualPort}`);
  });

  server.on('error', (err) => {
    log(`Server error: ${err.message}`);
    if (server) {
      vscode.window.showWarningMessage(
        `Claude Permission Popup: Server error (${err.code || 'UNKNOWN'}). Attempting restart...`
      );
      log('Attempting server restart...');
      try { server.close(); } catch {}
      server = null;
      setTimeout(() => {
        if (!server) {
          startServer(authToken, listenPort, context);
        }
      }, 1000);
    }
  });
}

function activate(context) {
  // Create output channel for logging
  outputChannel = vscode.window.createOutputChannel('Claude Permission Popup');
  context.subscriptions.push(outputChannel);

  // Register show-logs command
  const showLogsCmd = vscode.commands.registerCommand('claudePermissionPopup.showLogs', () => {
    if (outputChannel) {
      outputChannel.show();
    }
  });
  context.subscriptions.push(showLogsCmd);

  // Register install-hook command
  const installHookCmd = vscode.commands.registerCommand('claudePermissionPopup.installHook', async () => {
    await installHook();
  });
  context.subscriptions.push(installHookCmd);

  // Register focus-terminal command
  const focusTerminalCmd = vscode.commands.registerCommand('claudePermissionPopup.focusTerminal', () => {
    vscode.commands.executeCommand('workbench.action.terminal.focus');
    resetStatusBar();
  });
  context.subscriptions.push(focusTerminalCmd);

  // Create status bar item — clickable, opens logs
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'claudePermissionPopup.showLogs';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  updateStatusBar();

  const config = vscode.workspace.getConfiguration('claudePermissionPopup');
  const configPort = config.get('port', 0);

  // Generate a shared secret for authentication
  const authToken = crypto.randomBytes(32).toString('hex');

  // Determine runtime directory using XDG_RUNTIME_DIR when available [Security Fix: Finding 5]
  const runtimeBase = getRuntimeBase();
  runtimeDir = path.join(runtimeBase, 'claude-permission-popup-' + getRuntimeUser());
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  // Enforce permissions even if directory was pre-created by another process [Security Fix: Finding 5]
  try {
    fs.chmodSync(runtimeDir, 0o700);
  } catch (err) {
    log(`Warning: Could not set runtime directory permissions: ${err.message}`);
  }

  // Validate runtime directory (symlink + ownership check)
  if (!validateRuntimeDir(runtimeDir)) {
    vscode.window.showErrorMessage('Claude Permission Popup: Runtime directory is a symlink, not a directory, or owned by another user');
    log('Aborting: runtime directory validation failed');
    return;
  }

  // Clean up stale runtime files from a previous crash
  cleanupStaleRuntimeFiles(runtimeDir);

  // Use port 0 to get a random available port, unless user configured one
  const listenPort = configPort || 0;
  startServer(authToken, listenPort, context);

  // Listen for configuration changes — prompt reload when port changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudePermissionPopup.port')) {
        vscode.window.showInformationMessage(
          'Claude Permission Popup: Port setting changed. Reload the window to apply.',
          'Reload'
        ).then(choice => {
          if (choice === 'Reload') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        });
      }
    })
  );

  context.subscriptions.push({
    dispose() {
      resetStatusBar();
      if (server) {
        server.close();
        server = null;
      }
      cleanupRuntimeFiles();
    }
  });
}

/**
 * Install the hook script into .claude/settings.json
 */
async function installHook() {
  const hookScriptPath = path.join(__dirname, 'hooks', 'permission-request.sh');
  if (!fs.existsSync(hookScriptPath)) {
    vscode.window.showErrorMessage('Claude Permission Popup: Hook script not found at expected path.');
    return;
  }

  // Find workspace folder or home directory
  const targetDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  const claudeDir = path.join(targetDir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      vscode.window.showErrorMessage('Claude Permission Popup: Failed to parse .claude/settings.json');
      return;
    }
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!settings.hooks.PermissionRequest) {
    settings.hooks.PermissionRequest = [];
  }

  const alreadyInstalled = settings.hooks.PermissionRequest.some(entry =>
    entry.hooks && entry.hooks.some(h => h.command && h.command.includes('permission-request.sh'))
  );

  if (alreadyInstalled) {
    vscode.window.showInformationMessage('Claude Permission Popup: Hook is already configured.');
    return;
  }

  settings.hooks.PermissionRequest.push({
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: hookScriptPath
      }
    ]
  });

  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    vscode.window.showInformationMessage(`Claude Permission Popup: Hook installed in ${settingsPath}`);
    log(`Hook installed in ${settingsPath}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Claude Permission Popup: Failed to write settings`);
    log(`Failed to write settings: ${err.message}`);
  }
}

function cleanupRuntimeFiles() {
  if (!runtimeDir) return;
  try { fs.unlinkSync(path.join(runtimeDir, 'port')); } catch {}
  try { fs.unlinkSync(path.join(runtimeDir, 'auth-token')); } catch {}
  try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
}

function deactivate() {
  resetStatusBar();
  if (server) {
    server.close();
    server = null;
  }
  cleanupRuntimeFiles();
}

module.exports = { activate, deactivate, getRuntimeUser, formatToolDetail, truncate };
