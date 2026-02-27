const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vscode = require('vscode');

const MAX_BODY = 1024 * 1024; // 1 MB
const MAX_QUEUE = 10;
const MAX_DISPLAY_LEN = 500;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

let server = null;
let runtimeDir = null;
let outputChannel = null;
let statusBarItem = null;

// Permission request queue — processes one dialog at a time
const requestQueue = [];
let processing = false;

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
  const pending = requestQueue.length + (processing ? 1 : 0);
  if (pending > 0) {
    statusBarItem.text = `$(shield) Claude Permissions (${pending})`;
    statusBarItem.tooltip = `${pending} pending permission request(s)`;
  } else {
    statusBarItem.text = '$(shield) Claude Permissions';
    statusBarItem.tooltip = 'Claude Permission Popup is active';
  }
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

function processQueue() {
  if (processing || requestQueue.length === 0) return;
  processing = true;
  const { data, res } = requestQueue.shift();
  updateStatusBar();

  const toolName = truncate(data.tool_name || 'Unknown tool', MAX_DISPLAY_LEN);
  const toolInput = data.tool_input || {};
  const detail = formatToolDetail(data.tool_name || '', toolInput);
  const message = `Claude wants to run: ${toolName}\n\n${detail}`;

  log(`Showing modal for tool: ${toolName}`);

  const config = vscode.workspace.getConfiguration('claudePermissionPopup');
  const timeoutMs = config.get('modalTimeout', DEFAULT_TIMEOUT_MS);

  let modalResolved = false;
  let timeoutHandle;

  const modalPromise = vscode.window.showWarningMessage(message, { modal: true }, 'Allow', 'Deny');

  const timeoutPromise = new Promise(resolve => {
    timeoutHandle = setTimeout(() => resolve('__timeout__'), timeoutMs);
  });

  Promise.race([modalPromise, timeoutPromise])
    .then(choice => {
      if (modalResolved) return;
      modalResolved = true;
      clearTimeout(timeoutHandle);

      let decision;
      if (choice === 'Allow') {
        decision = 'allow';
      } else if (choice === 'Deny') {
        decision = 'deny';
      } else if (choice === '__timeout__') {
        decision = 'dismissed';
        log('Modal timed out, returning dismissed');
        // Show a non-modal notification to dismiss the stale modal
        vscode.window.showInformationMessage('Claude permission request timed out.');
      } else {
        // undefined = Escape pressed or modal dismissed
        decision = 'dismissed';
        log('Modal dismissed (Escape), returning dismissed');
      }
      log(`Decision for ${toolName}: ${decision}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ decision }));
    })
    .then(
      () => { processing = false; updateStatusBar(); processQueue(); },
      (err) => { log(`Error processing modal: ${err}`); processing = false; updateStatusBar(); processQueue(); }
    );
}

function truncate(str, max) {
  if (typeof str !== 'string') return String(str).slice(0, max);
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function activate(context) {
  // Create output channel for logging
  outputChannel = vscode.window.createOutputChannel('Claude Permission Popup');
  context.subscriptions.push(outputChannel);

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(shield) Claude Permissions';
  statusBarItem.tooltip = 'Claude Permission Popup is active';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const config = vscode.workspace.getConfiguration('claudePermissionPopup');
  const configPort = config.get('port', 0);

  // Generate a shared secret for authentication
  const authToken = crypto.randomBytes(32).toString('hex');

  // Determine runtime directory for port/token files
  runtimeDir = path.join(os.tmpdir(), 'claude-permission-popup-' + getRuntimeUser());
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  // Guard against symlink attacks on the runtime directory
  const runtimeDirStat = fs.lstatSync(runtimeDir);
  if (!runtimeDirStat.isDirectory() || runtimeDirStat.isSymbolicLink()) {
    vscode.window.showErrorMessage('Claude Permission Popup: Runtime directory is a symlink or not a directory');
    log('Aborting: runtime directory is a symlink');
    return;
  }

  server = http.createServer((req, res) => {
    // Require custom header to block browser cross-origin requests
    if (req.headers['x-claude-permission'] !== 'true') {
      log('Rejected request: missing x-claude-permission header');
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Missing required header' }));
      return;
    }

    // Validate auth token
    if (req.headers['authorization'] !== `Bearer ${authToken}`) {
      log('Rejected request: invalid auth token');
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/permission') {
      res.writeHead(404);
      res.end();
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
        req.destroy(); // discard remaining data
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

      // Throttle: reject if queue is full — return explicit deny
      if (requestQueue.length >= MAX_QUEUE) {
        log('Queue full, returning deny');
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision: 'deny', error: 'Too many pending requests' }));
        return;
      }

      log(`Queued permission request for tool: ${data.tool_name || 'Unknown'} (queue size: ${requestQueue.length + 1})`);
      requestQueue.push({ data, res });
      updateStatusBar();
      processQueue();
    });
  });

  // Use port 0 to get a random available port, unless user configured one
  const listenPort = configPort || 0;

  server.listen(listenPort, '127.0.0.1', () => {
    const actualPort = server.address().port;
    log(`Server listening on 127.0.0.1:${actualPort}`);

    // Write port and auth token to files for the hook script to read
    try {
      fs.writeFileSync(path.join(runtimeDir, 'port'), String(actualPort), { mode: 0o600 });
      fs.writeFileSync(path.join(runtimeDir, 'auth-token'), authToken, { mode: 0o600 });
    } catch (err) {
      vscode.window.showErrorMessage(`Claude Permission Popup: Failed to write runtime files: ${err.code || 'UNKNOWN'}`);
      log(`Failed to write runtime files: ${err.message}`);
    }
  });

  server.on('error', (err) => {
    vscode.window.showErrorMessage(`Claude Permission Popup: Failed to start server: ${err.code || 'UNKNOWN'}`);
    log(`Server error: ${err.message}`);
  });

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
      if (server) {
        server.close();
        server = null;
      }
      cleanupRuntimeFiles();
    }
  });
}

function cleanupRuntimeFiles() {
  if (!runtimeDir) return;
  try { fs.unlinkSync(path.join(runtimeDir, 'port')); } catch {}
  try { fs.unlinkSync(path.join(runtimeDir, 'auth-token')); } catch {}
  try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
}

function deactivate() {
  if (server) {
    server.close();
    server = null;
  }
  cleanupRuntimeFiles();
}

module.exports = { activate, deactivate, getRuntimeUser, formatToolDetail };
