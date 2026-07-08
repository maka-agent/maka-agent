// Unit test for the cua-driver CuDispatchBackend (Tier-2). Drives the module
// against a MOCK cua-driver child (a tiny node script written to a temp dir) —
// the real binary is never spawned. The mock speaks the same line-delimited
// JSON-RPC 2.0 the driver does and records every message (plus its own
// pid/argv/selected-env) to an NDJSON log the test inspects.
//
// Run (from repo root), after @maka/core + @maka/runtime are built:
//   npm --workspace @maka/desktop run clean:main \
//     && npm --workspace @maka/desktop run build:main \
//     && node --test apps/desktop/dist/main/__tests__/cua-driver-backend.test.js
// or simply: npm --workspace @maka/desktop test  (builds main + runs all).
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import type { CuAction } from '@maka/core';
import { createCuaDriverBackend } from '../computer-use/cua-driver-backend.js';

const HOST_BUNDLE_ID = 'com.maka.test';

// A CommonJS mock cua-driver. No backticks / ${} inside → embedded via
// String.raw so \n survives as a literal escape in the written file.
const MOCK_SRC = String.raw`#!/usr/bin/env node
'use strict';
const fs = require('fs');
const LOG = process.env.CUA_MOCK_LOG || '';
const HANG_TOOL = process.env.CUA_MOCK_HANG_TOOL || '';
const ERR_TOOL = process.env.CUA_MOCK_RPCERR_TOOL || '';
// 1x1 transparent PNG (tiny, well under the 2MB frame cap).
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
function logRec(rec) { if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(rec) + '\n'); } catch (e) {} } }
logRec({
  kind: 'start',
  pid: process.pid,
  argv: process.argv.slice(2),
  env: {
    CUA_DRIVER_EMBEDDED: process.env.CUA_DRIVER_EMBEDDED,
    CUA_DRIVER_HOST_BUNDLE_ID: process.env.CUA_DRIVER_HOST_BUNDLE_ID,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED,
    CUA_DRIVER_RS_UPDATE_CHECK: process.env.CUA_DRIVER_RS_UPDATE_CHECK,
  },
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id: id, result: result }); }
function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};
  if (method === 'initialize') {
    reply(id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '0' } });
    return;
  }
  if (method === 'tools/call') {
    const name = params.name;
    if (name === HANG_TOOL) { return; } // never respond → exercises abort/kill/handshake-timeout
    if (name === ERR_TOOL) { send({ jsonrpc: '2.0', id: id, error: { code: -32000, message: 'mock rpc error' } }); return; }
    switch (name) {
      case 'set_config':
        reply(id, { content: [], structuredContent: {} });
        return;
      case 'check_permissions':
        reply(id, { content: [], structuredContent: { accessibility: true, screen_recording_capturable: true } });
        return;
      case 'get_desktop_state':
        reply(id, {
          content: [{ type: 'image', data: PNG, mimeType: 'image/png' }],
          structuredContent: { screenshot_width: 1440, screenshot_height: 900 },
        });
        return;
      case 'click':
        reply(id, { content: [{ type: 'text', text: 'clicked' }], structuredContent: {} });
        return;
      case 'scroll':
        reply(id, { content: [{ type: 'text', text: 'scrolled' }], structuredContent: {} });
        return;
      case 'list_apps':
        // No frontmost app → the backend cannot resolve a target pid.
        reply(id, { content: [], structuredContent: { apps: [{ pid: 4242, frontmost: false }] } });
        return;
      case 'type_text':
        reply(id, { content: [{ type: 'text', text: 'typed' }], structuredContent: {} });
        return;
      case 'press_key':
        reply(id, { content: [{ type: 'text', text: 'keyed' }], structuredContent: {} });
        return;
      default:
        reply(id, { content: [{ type: 'text', text: 'unknown tool' }], isError: true, structuredContent: {} });
        return;
    }
  }
  reply(id, {});
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    logRec({ kind: 'recv', method: msg.method, id: msg.id, params: msg.params });
    if (typeof msg.id !== 'number') continue; // notification: record only
    handle(msg);
  }
});
`;

let workDir = '';
let mockPath = '';
const backends: Array<{ dispose: () => void }> = [];

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function readRecords(logPath: string): Promise<Array<Record<string, any>>> {
  let raw = '';
  try {
    raw = await readFile(logPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, any>);
}

/** recv methods in order, with tool name inlined for tools/call. */
function methodTrace(records: Array<Record<string, any>>): string[] {
  return records
    .filter((r) => r.kind === 'recv')
    .map((r) => (r.method === 'tools/call' ? 'tools/call:' + (r.params && r.params.name) : r.method));
}

function toolCall(records: Array<Record<string, any>>, name: string): Record<string, any> | undefined {
  const rec = records.find((r) => r.kind === 'recv' && r.method === 'tools/call' && r.params && r.params.name === name);
  return rec && rec.params ? (rec.params.arguments as Record<string, any>) : undefined;
}

/**
 * Create a backend pointed at the mock. The module captures process.env at
 * spawn time, so we set the per-child log path (and optional hang tool) right
 * before returning — tests run sequentially, so there is no env interleave.
 */
function makeBackend(opts: { hangTool?: string; rpcErrTool?: string; handshakeTimeoutMs?: number } = {}): { backend: ReturnType<typeof createCuaDriverBackend>; logPath: string } {
  const logPath = join(workDir, 'log-' + randomUUID() + '.ndjson');
  process.env.CUA_MOCK_LOG = logPath;
  process.env.CUA_MOCK_HANG_TOOL = opts.hangTool ?? '';
  process.env.CUA_MOCK_RPCERR_TOOL = opts.rpcErrTool ?? '';
  const backend = createCuaDriverBackend({
    binaryPath: mockPath,
    hostBundleId: HOST_BUNDLE_ID,
    timeoutMs: 5000,
    ...(opts.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: opts.handshakeTimeoutMs } : {}),
  });
  backends.push(backend);
  return { backend, logPath };
}

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'cua-driver-test-'));
  // Redirect HOME so the module's best-effort ~/.cua-driver/.installation_recorded
  // pre-seed writes into the temp dir, not the real home.
  process.env.HOME = workDir;
  mockPath = join(workDir, 'cua-mock.cjs');
  await writeFile(mockPath, MOCK_SRC, 'utf8');
  chmodSync(mockPath, 0o755);
});

after(async () => {
  for (const b of backends) {
    try {
      b.dispose();
    } catch {
      /* already gone */
    }
  }
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('cua-driver backend', () => {
  it('performs the initialize → initialized → set_config{desktop} handshake and spawns with the right env/args', async () => {
    const { backend, logPath } = makeBackend();
    // Any call triggers lazy spawn + handshake.
    const pf = await backend.preflight(new AbortController().signal);
    assert.deepEqual(pf, { accessibility: true, screenRecording: true });

    const records = await readRecords(logPath);

    // Handshake ordering.
    const trace = methodTrace(records);
    assert.deepEqual(trace.slice(0, 3), ['initialize', 'notifications/initialized', 'tools/call:set_config']);
    assert.equal(toolCall(records, 'set_config')?.capture_scope, 'desktop');

    // Spawn contract: args + env.
    const start = records.find((r) => r.kind === 'start');
    assert.ok(start, 'mock recorded a start line');
    assert.deepEqual(start!.argv, ['mcp', '--embedded', '--host-bundle-id', HOST_BUNDLE_ID]);
    assert.equal(start!.env.CUA_DRIVER_EMBEDDED, '1');
    assert.equal(start!.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, 'false');
    assert.equal(start!.env.CUA_DRIVER_RS_UPDATE_CHECK, 'false');
    assert.equal(start!.env.CUA_DRIVER_HOST_BUNDLE_ID, HOST_BUNDLE_ID);
  });

  it('preflight maps check_permissions{prompt:false} to {accessibility, screenRecording}', async () => {
    const { backend, logPath } = makeBackend();
    const pf = await backend.preflight(new AbortController().signal);
    assert.deepEqual(pf, { accessibility: true, screenRecording: true });
    const records = await readRecords(logPath);
    assert.deepEqual(toolCall(records, 'check_permissions'), { prompt: false });
  });

  it('screenshot maps get_desktop_state → {base64, mimeType, widthPx, heightPx}', async () => {
    const { backend } = makeBackend();
    const res = await backend.run({ type: 'screenshot' } as CuAction, new AbortController().signal);
    assert.deepEqual(res.outcome, { ok: true, tier: 'coordinate-background' });
    assert.ok(res.screenshot, 'screenshot present');
    assert.equal(res.screenshot!.mimeType, 'image/png');
    assert.equal(res.screenshot!.widthPx, 1440);
    assert.equal(res.screenshot!.heightPx, 900);
    assert.ok(res.screenshot!.base64.length > 0);
    assert.ok(Buffer.from(res.screenshot!.base64, 'base64').byteLength > 0);
  });

  it('click / scroll fail closed and are NEVER sent to cua-driver (desktop-scope warps the real cursor)', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;

    for (const action of [
      { type: 'left_click', coordinate: { x: 10, y: 20 } },
      { type: 'right_click', coordinate: { x: 30, y: 40 } },
      { type: 'double_click', coordinate: { x: 50, y: 60 } },
      { type: 'scroll', coordinate: { x: 5, y: 5 }, scrollDirection: 'down', scrollAmount: 3 },
    ] as CuAction[]) {
      const res = await backend.run(action, sig);
      assert.equal(res.outcome.ok, false, `${action.type} must fail closed`);
      if (res.outcome.ok === false) assert.equal(res.outcome.error, 'unsupported_action');
    }

    // The non-negotiable cursor invariant: no click/scroll ever reaches cua-driver.
    const records = await readRecords(logPath);
    const trace = methodTrace(records);
    assert.ok(!trace.includes('tools/call:click'), 'click must never be sent (would warp the real cursor)');
    assert.ok(!trace.includes('tools/call:scroll'), 'scroll must never be sent');
  });

  it('mouse_move succeeds without touching cua-driver (visual agent-cursor only)', async () => {
    const { backend, logPath } = makeBackend();
    const res = await backend.run({ type: 'mouse_move', coordinate: { x: 100, y: 100 } } as CuAction, new AbortController().signal);
    assert.equal(res.outcome.ok, true);
    const trace = methodTrace(await readRecords(logPath));
    assert.ok(!trace.some((m) => m.startsWith('tools/call:click') || m.startsWith('tools/call:move')), 'mouse_move must not inject real input');
  });

  it('type / key fail closed as unsupported_action and never inject keystrokes', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;

    const typeRes = await backend.run({ type: 'type', text: 'hello' } as CuAction, sig);
    assert.equal(typeRes.outcome.ok, false);
    if (typeRes.outcome.ok === false) assert.equal(typeRes.outcome.error, 'unsupported_action');

    const keyRes = await backend.run({ type: 'key', text: 'Return' } as CuAction, sig);
    assert.equal(keyRes.outcome.ok, false);
    if (keyRes.outcome.ok === false) assert.equal(keyRes.outcome.error, 'unsupported_action');

    // The non-negotiable invariant: the backend must NEVER resolve a frontmost
    // target or emit keystrokes. It touches neither list_apps (the removed
    // frontmost-routing masking shim) nor type_text / press_key.
    const records = await readRecords(logPath);
    const trace = methodTrace(records);
    assert.ok(!trace.includes('tools/call:list_apps'), 'list_apps must not be queried (no frontmost routing)');
    assert.ok(!trace.includes('tools/call:type_text'), 'type_text must never be sent');
    assert.ok(!trace.includes('tools/call:press_key'), 'press_key must never be sent');
  });

  it('abort mid-call kills the child and rejects the promise', async () => {
    const { backend, logPath } = makeBackend({ hangTool: 'get_desktop_state' });
    const controller = new AbortController();
    const p = backend.run({ type: 'screenshot' } as CuAction, controller.signal);
    // Let the handshake finish and the (hanging) capture reach the mock.
    await delay(150);

    const records = await readRecords(logPath);
    const start = records.find((r) => r.kind === 'start');
    assert.ok(start, 'mock started');
    const pid: number = start!.pid;
    // Child alive before abort.
    assert.doesNotThrow(() => process.kill(pid, 0));

    controller.abort();
    await assert.rejects(p, /abort/i);

    // Child SIGKILLed → process.kill(pid,0) eventually throws ESRCH.
    let dead = false;
    for (let i = 0; i < 100 && !dead; i++) {
      try {
        process.kill(pid, 0);
        await delay(20);
      } catch {
        dead = true;
      }
    }
    assert.ok(dead, 'cua-driver child was killed on abort');
  });

  it('a hung handshake times out, kills the child, and fails closed (no deadlock)', async () => {
    // set_config never answers → the bounded handshake must time out instead of
    // wedging every future action forever (the deadlock the review confirmed).
    const { backend, logPath } = makeBackend({ hangTool: 'set_config', handshakeTimeoutMs: 250 });
    await assert.rejects(backend.preflight(new AbortController().signal), /timeout/i);

    const records = await readRecords(logPath);
    const start = records.find((r) => r.kind === 'start');
    assert.ok(start, 'mock started');
    const pid: number = start!.pid;
    let dead = false;
    for (let i = 0; i < 100 && !dead; i++) {
      try {
        process.kill(pid, 0);
        await delay(20);
      } catch {
        dead = true;
      }
    }
    assert.ok(dead, 'child killed after handshake timeout');
  });

  it('a set_config RPC error rejects startup (fail closed — no warn-and-continue)', async () => {
    // The old code swallowed this with console.warn and reported startup ok,
    // letting later scope:desktop actions run against an unconfigured scope.
    const { backend } = makeBackend({ rpcErrTool: 'set_config' });
    await assert.rejects(backend.preflight(new AbortController().signal), /set_config/i);
  });
});
