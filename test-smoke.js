#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

// ─── Results tracking ───────────────────────────────────────────────
let passed = 0;
let failed = 0;

function check(name, ok) {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}`);
    failed++;
  }
}

// ─── Mock vscode module ─────────────────────────────────────────────
const warningMessages = [];
const executedCommands = [];

const vscodeMock = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class ThemeColor {
    constructor(id) { this.id = id; }
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key, def) => def,   // port = 0 (random), osNotifications = true
    }),
    onDidChangeConfiguration: (_cb) => ({ dispose: () => {} }),
    workspaceFolders: null,
  },
  commands: {
    executeCommand: (cmd) => {
      executedCommands.push(cmd);
      return Promise.resolve();
    },
    registerCommand: (_id, _cb) => ({ dispose: () => {} }),
  },
  window: {
    showWarningMessage: (msg, ...args) => {
      warningMessages.push({ msg, args });
      return Promise.resolve();
    },
    showErrorMessage: (msg) => {
      console.log(`  [vscode.error] ${msg}`);
    },
    showInformationMessage: (msg) => {
      return Promise.resolve();
    },
    createOutputChannel: (_name) => ({
      appendLine: () => {},
      show: () => {},
      dispose: () => {},
    }),
    createStatusBarItem: (_alignment, _priority) => ({
      text: '',
      tooltip: '',
      command: '',
      backgroundColor: undefined,
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
  },
};

// Inject mock before requiring the extension
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, parent, isMain, options);
};
require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: vscodeMock,
};

const ext = require('./extension');

// ─── Helpers ────────────────────────────────────────────────────────
function request(port, token, headers, body, method, urlPath) {
  return new Promise((resolve) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: urlPath || '/notify',
      method: method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: data, json });
      });
    });

    req.on('error', (err) => {
      resolve({ status: 0, body: '', json: null, error: err });
    });

    if (body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Main ───────────────────────────────────────────────────────────
(async () => {
  console.log('\n=== Claude Permission Popup — Smoke Tests ===\n');

  // 1. Activate the extension
  const stateStore = {};
  const fakeContext = {
    subscriptions: [],
    workspaceState: {
      get(key, defaultValue) { return key in stateStore ? stateStore[key] : defaultValue; },
      update(key, value) { stateStore[key] = value; return Promise.resolve(); },
    },
  };
  ext.activate(fakeContext);

  // Wait for server to start and write runtime files
  await sleep(500);

  // Match extension's getRuntimeBase() logic: prefer XDG_RUNTIME_DIR
  const runtimeBase = (process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR))
    ? process.env.XDG_RUNTIME_DIR
    : os.tmpdir();
  const runtimeDir = path.join(runtimeBase, 'claude-permission-popup-' + ext.getRuntimeUser());
  const portFile = path.join(runtimeDir, 'port');
  const tokenFile = path.join(runtimeDir, 'auth-token');

  check('runtime dir exists', fs.existsSync(runtimeDir));
  check('port file exists', fs.existsSync(portFile));
  check('auth-token file exists', fs.existsSync(tokenFile));

  const port = parseInt(fs.readFileSync(portFile, 'utf8'), 10);
  const authToken = fs.readFileSync(tokenFile, 'utf8').trim();

  check('port is a valid number', port > 0 && port < 65536);
  check('auth token is 64-char hex', /^[0-9a-f]{64}$/.test(authToken));

  const authHeaders = {
    'X-Claude-Permission': 'true',
    'Authorization': `Bearer ${authToken}`,
  };

  // ── Test: health check endpoint ────────────────────────────────
  console.log('\n--- Health check endpoint ---');
  const rHealth = await request(port, authToken, {}, undefined, 'GET', '/health');
  check('health status 200', rHealth.status === 200);
  check('health returns ok', rHealth.json && rHealth.json.status === 'ok');

  // ── Test: POST /notify returns immediately with notified ───────
  console.log('\n--- POST /notify ---');
  warningMessages.length = 0;
  executedCommands.length = 0;
  const r1 = await request(port, authToken, authHeaders, {
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
  });
  check('status 200', r1.status === 200);
  check('response has status notified', r1.json && r1.json.status === 'notified');
  check('no decision in response', r1.json && r1.json.decision === undefined);

  // Give async handlers a tick to fire
  await sleep(50);
  check('showWarningMessage was called', warningMessages.length > 0);
  check('warning mentions tool name', warningMessages.length > 0 && warningMessages[0].msg.includes('Bash'));
  check('focusWindow was called', executedCommands.includes('workbench.action.focusWindow'));

  // ── Test: POST /permission (old endpoint) returns 404 ─────────
  console.log('\n--- Old /permission endpoint ---');
  const rOld = await request(port, authToken, authHeaders, {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  }, 'POST', '/permission');
  check('old endpoint returns 404', rOld.status === 404);

  // ── Test: /notify response time < 500ms (fire-and-forget) ─────
  console.log('\n--- Response time ---');
  await sleep(300); // let rate limiter window clear
  const startTime = Date.now();
  const rFast = await request(port, authToken, authHeaders, {
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/test.txt', content: 'hello' },
  });
  const elapsed = Date.now() - startTime;
  check('response time < 500ms', rFast.status === 200 && elapsed < 500);

  // ── Test: missing X-Claude-Permission header -> 403 ──────────────
  console.log('\n--- Missing header ---');
  const r2 = await request(port, authToken, {
    'Authorization': `Bearer ${authToken}`,
  }, { tool_name: 'test' });
  check('status 403', r2.status === 403);

  // ── Test: bad auth token -> 401 ──────────────────────────────────
  console.log('\n--- Bad auth token ---');
  const r3 = await request(port, authToken, {
    'X-Claude-Permission': 'true',
    'Authorization': 'Bearer bad-token',
  }, { tool_name: 'test' });
  check('status 401', r3.status === 401);

  // ── Test: oversized body -> 413 ──────────────────────────────────
  console.log('\n--- Oversized body ---');
  const bigBody = 'x'.repeat(1024 * 1024 + 100);
  const r4 = await request(port, authToken, authHeaders, bigBody);
  // The server may destroy the connection or return 413
  check('status 413 or connection error', r4.status === 413 || r4.status === 0);

  // ── Test: invalid JSON -> 400 ────────────────────────────────────
  console.log('\n--- Invalid JSON ---');
  await sleep(200); // let server recover from destroyed connection
  const r5 = await request(port, authToken, authHeaders, 'not-json{{{');
  check('status 400', r5.status === 400);

  // ── Test: hook script end-to-end ─────────────────────────────────
  console.log('\n--- Hook script integration ---');
  // Wait for any rate limiting to clear
  await sleep(1200);

  const hookScript = path.join(__dirname, 'hooks', 'permission-request.sh');
  const hookPayload = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'echo hello' },
  });

  let hookResult;
  try {
    hookResult = await new Promise((resolve, reject) => {
      const child = execFile('bash', [hookScript], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          TMPDIR: os.tmpdir(),
        },
      }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve(stdout);
      });
      child.stdin.write(hookPayload);
      child.stdin.end();
    });
  } catch (err) {
    hookResult = null;
    console.log(`  [hook error] ${err.message}`);
  }

  if (hookResult !== null) {
    check('hook produces no stdout (empty)', hookResult.trim() === '');
  } else {
    check('hook produces no stdout (empty)', false);
  }

  // ── Test: formatToolDetail Read line ranges ─────────────────────
  console.log('\n--- Read tool formatting ---');
  const fmt = ext.formatToolDetail;
  check('Read: offset+limit shows range',
    fmt('Read', { file_path: '/a.txt', offset: 10, limit: 20 }) === '/a.txt (lines 10–29)');
  check('Read: offset only shows "from line"',
    fmt('Read', { file_path: '/a.txt', offset: 5 }) === '/a.txt (from line 5)');
  check('Read: limit only shows range from 1',
    fmt('Read', { file_path: '/a.txt', limit: 50 }) === '/a.txt (lines 1–50)');
  check('Read: no offset/limit shows path only',
    fmt('Read', { file_path: '/a.txt' }) === '/a.txt');

  // ── Test: truncate utility ──────────────────────────────────────
  console.log('\n--- Truncate utility ---');
  const trunc = ext.truncate;
  check('truncate: short string unchanged', trunc('hello', 10) === 'hello');
  check('truncate: long string cut', trunc('hello world', 5) === 'hello...');
  check('truncate: non-string coerced', trunc(123, 10) === '123');

  // ── Cleanup: deactivate ──────────────────────────────────────────
  console.log('\n--- Deactivate & cleanup ---');
  ext.deactivate();
  await sleep(200);

  check('port file removed', !fs.existsSync(portFile));
  check('auth-token file removed', !fs.existsSync(tokenFile));

  // ── Summary ──────────────────────────────────────────────────────
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
