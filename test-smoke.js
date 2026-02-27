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
let lastWarningMessage = null;
let warningAutoReply = 'Allow';

const vscodeMock = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  workspace: {
    getConfiguration: () => ({
      get: (_key, def) => def,   // port = 0 (random), modalTimeout = default
    }),
    onDidChangeConfiguration: (_cb) => ({ dispose: () => {} }),
  },
  commands: {
    executeCommand: () => Promise.resolve(),
  },
  window: {
    showWarningMessage: (msg, _opts, ...buttons) => {
      lastWarningMessage = msg;
      return Promise.resolve(warningAutoReply);
    },
    showErrorMessage: (msg) => {
      console.log(`  [vscode.error] ${msg}`);
    },
    createOutputChannel: (_name) => ({
      appendLine: () => {},
      dispose: () => {},
    }),
    createStatusBarItem: (_alignment, _priority) => ({
      text: '',
      tooltip: '',
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
  },
};

// Inject mock before requiring the extension
// We can't use require.resolve('vscode') because the module doesn't exist,
// so we hook into Module._resolveFilename to intercept it.
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
function request(port, token, headers, body) {
  return new Promise((resolve) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: '/permission',
      method: 'POST',
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
  const fakeContext = { subscriptions: [] };
  ext.activate(fakeContext);

  // Wait for server to start and write runtime files
  await sleep(500);

  const runtimeDir = path.join(os.tmpdir(), 'claude-permission-popup-' + ext.getRuntimeUser());
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

  // ── Test: valid request -> allow ─────────────────────────────────
  console.log('\n--- Valid request ---');
  warningAutoReply = 'Allow';
  const r1 = await request(port, authToken, authHeaders, {
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
  });
  check('status 200', r1.status === 200);
  check('decision is allow', r1.json && r1.json.decision === 'allow');
  check('showWarningMessage was called', lastWarningMessage !== null);
  check('message mentions tool name', lastWarningMessage && lastWarningMessage.includes('Bash'));

  // ── Test: deny decision ──────────────────────────────────────────
  console.log('\n--- Deny decision ---');
  warningAutoReply = 'Deny';
  const r1b = await request(port, authToken, authHeaders, {
    tool_name: 'Write',
    tool_input: { file_path: '/etc/passwd' },
  });
  check('status 200', r1b.status === 200);
  check('decision is deny', r1b.json && r1b.json.decision === 'deny');

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

  // ── Test: queue overflow -> 429 ──────────────────────────────────
  console.log('\n--- Queue overflow (>10 concurrent) ---');
  // Make showWarningMessage resolve after a short delay (to keep queue full long enough)
  const hangingResolvers = [];
  vscodeMock.window.showWarningMessage = (msg, _opts, ...buttons) => {
    lastWarningMessage = msg;
    return new Promise((resolve) => { hangingResolvers.push(resolve); });
  };

  // Fire 12 concurrent requests — first goes to processing, next 10 fill the queue, #12 should get 429
  const pending = [];
  for (let i = 0; i < 12; i++) {
    pending.push(request(port, authToken, authHeaders, {
      tool_name: `QueueTest-${i}`,
      tool_input: {},
    }));
  }

  // Wait for all requests to reach the server and the 429 to be sent
  await sleep(500);

  // Drain: resolve hanging modals in a loop until all pending requests complete
  const drainInterval = setInterval(() => {
    while (hangingResolvers.length > 0) {
      hangingResolvers.shift()('Allow');
    }
  }, 50);

  const results = await Promise.all(pending);
  clearInterval(drainInterval);

  const got429 = results.some((r) => r.status === 429);
  check('at least one request got 429', got429);

  // ── Test: hook script end-to-end ─────────────────────────────────
  console.log('\n--- Hook script integration ---');
  // Reset the mock to auto-allow (instant resolve)
  vscodeMock.window.showWarningMessage = (msg, _opts, ...buttons) => {
    lastWarningMessage = msg;
    return Promise.resolve('Allow');
  };
  // Wait for any remaining queued requests to drain
  await sleep(500);

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
        resolve(stdout.trim());
      });
      child.stdin.write(hookPayload);
      child.stdin.end();
    });
  } catch (err) {
    hookResult = null;
    console.log(`  [hook error] ${err.message}`);
  }

  if (hookResult) {
    let hookJson;
    try { hookJson = JSON.parse(hookResult); } catch {}
    check('hook returns valid JSON', hookJson !== undefined);
    check('hook decision is allow',
      hookJson &&
      hookJson.hookSpecificOutput &&
      hookJson.hookSpecificOutput.decision &&
      hookJson.hookSpecificOutput.decision.behavior === 'allow'
    );
  } else {
    check('hook returns valid JSON', false);
    check('hook decision is allow', false);
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
