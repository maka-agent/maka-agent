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
import { createCuaDriverBackend, parseKeyChord } from '../cua-driver-backend.js';

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
// A "big" frame (~1.9MB decoded) to exercise the compression threshold path.
const BIG_IMG = process.env.CUA_MOCK_BIG_IMAGE === '1' ? 'A'.repeat(2600000) : '';
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
          content: [{ type: 'image', data: BIG_IMG || PNG, mimeType: 'image/png' }],
          structuredContent: { screenshot_width: 1440, screenshot_height: 900 },
        });
        return;
      case 'click':
        reply(id, { content: [{ type: 'text', text: 'clicked' }], structuredContent: {} });
        return;
      case 'scroll':
        reply(id, { content: [{ type: 'text', text: 'scrolled' }], structuredContent: {} });
        return;
      case 'drag':
        reply(id, { content: [{ type: 'text', text: 'dragged' }], structuredContent: {} });
        return;
      case 'get_screen_size':
        reply(id, { content: [], structuredContent: { width: 1512, height: 982, scale_factor: 2 } });
        return;
      case 'list_windows':
        // Two layer-0 windows. Win 77 covers screen-points (100,100)-(700,500).
        // Win 88 sits at (100,600)-(400,900) — disjoint from win 77 and from every
        // existing test's probe point, used only to exercise cross-window drag.
        // Wins 91-94 overlap ONLY at a fresh probe point screen (1000,200) that no
        // other test touches — they exercise the z-order tiebreak (92 z9 beats 91 z2)
        // and the eligibility filter (93 is layer!=0, 94 is off-screen → both excluded
        // despite the highest z / covering the point).
        reply(id, { content: [], structuredContent: { windows: [
          { window_id: 77, pid: 4242, layer: 0, is_on_screen: true, z_index: 5, bounds: { x: 100, y: 100, width: 600, height: 400 } },
          { window_id: 88, pid: 4242, layer: 0, is_on_screen: true, z_index: 3, bounds: { x: 100, y: 600, width: 300, height: 300 } },
          { window_id: 91, pid: 5001, layer: 0, is_on_screen: true, z_index: 2, bounds: { x: 900, y: 100, width: 400, height: 300 } },
          { window_id: 92, pid: 5002, layer: 0, is_on_screen: true, z_index: 9, bounds: { x: 950, y: 150, width: 300, height: 200 } },
          { window_id: 93, pid: 5003, layer: 3, is_on_screen: true, z_index: 99, bounds: { x: 900, y: 100, width: 400, height: 300 } },
          { window_id: 94, pid: 5004, layer: 0, is_on_screen: false, z_index: 50, bounds: { x: 900, y: 100, width: 400, height: 300 } },
        ] } });
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
function makeBackend(opts: { hangTool?: string; rpcErrTool?: string; handshakeTimeoutMs?: number; bigImage?: boolean; compressFrame?: (b: string, m: string) => { base64: string; mimeType: 'image/png' | 'image/jpeg' } } = {}): { backend: ReturnType<typeof createCuaDriverBackend>; logPath: string } {
  const logPath = join(workDir, 'log-' + randomUUID() + '.ndjson');
  process.env.CUA_MOCK_LOG = logPath;
  process.env.CUA_MOCK_HANG_TOOL = opts.hangTool ?? '';
  process.env.CUA_MOCK_RPCERR_TOOL = opts.rpcErrTool ?? '';
  process.env.CUA_MOCK_BIG_IMAGE = opts.bigImage ? '1' : '';
  const backend = createCuaDriverBackend({
    binaryPath: mockPath,
    hostBundleId: HOST_BUNDLE_ID,
    timeoutMs: 5000,
    ...(opts.compressFrame ? { compressFrame: opts.compressFrame } : {}),
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
    assert.deepEqual(start!.argv, ['mcp', '--embedded', '--no-daemon-relaunch', '--no-overlay', '--host-bundle-id', HOST_BUNDLE_ID]);
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

  it('large frame → compressFrame applied (JPEG); small frame → untouched (PNG)', async () => {
    let calls = 0;
    const compressFrame = (_b: string, _m: string) => { calls += 1; return { base64: 'anVzdGpwZWc=', mimeType: 'image/jpeg' as const }; };

    // Big frame (~1.9 MB decoded > 1.5 MB threshold) → compressed to JPEG.
    const big = makeBackend({ bigImage: true, compressFrame });
    const bigRes = await big.backend.run({ type: 'screenshot' } as CuAction, new AbortController().signal);
    assert.equal(calls, 1, 'compressFrame called for a large frame');
    assert.equal(bigRes.screenshot!.mimeType, 'image/jpeg');
    assert.equal(bigRes.screenshot!.base64, 'anVzdGpwZWc=');

    // Small frame (tiny PNG < threshold) → compressor NOT called, stays PNG.
    const small = makeBackend({ bigImage: false, compressFrame });
    const smallRes = await small.backend.run({ type: 'screenshot' } as CuAction, new AbortController().signal);
    assert.equal(calls, 1, 'compressFrame NOT called for a small frame');
    assert.equal(smallRes.screenshot!.mimeType, 'image/png');
  });

  it('click on an app window → pid+window_id path (no cursor warp), NEVER scope:desktop', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // scale=2; window covers screen-points (100,100)-(700,500). Device (600,400) →
    // screen (300,200) is inside → resolves. window-local device = (600-200, 400-200).
    const res = await backend.run({ type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction, sig);
    assert.equal(res.outcome.ok, true, 'click on a window succeeds');

    const records = await readRecords(logPath);
    const click = toolCall(records, 'click');
    assert.ok(click, 'click was sent to cua-driver');
    // The non-negotiable invariant: pid+window_id present (forces post_to_pid, no warp),
    // and NO scope:desktop (the warping path) anywhere.
    assert.equal(click!.pid, 4242);
    assert.equal(click!.window_id, 77);
    assert.equal(click!.x, 400);
    assert.equal(click!.y, 200);
    assert.equal(click!.scope, undefined, 'must NOT use scope:desktop (that warps the real cursor)');
    assert.equal(click!.delivery_mode, undefined, 'must NOT force foreground on click (default Background = no warp / no z-order change)');
  });

  it('click on empty desktop (no window) fails closed — never warps', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // Device (2000,2000) → screen (1000,1000): outside the mock window → no window.
    const res = await backend.run({ type: 'left_click', coordinate: { x: 2000, y: 2000 } } as CuAction, sig);
    assert.equal(res.outcome.ok, false);
    if (res.outcome.ok === false) assert.equal(res.outcome.error, 'unsupported_action');
    const trace = methodTrace(await readRecords(logPath));
    assert.ok(!trace.includes('tools/call:click'), 'no click sent when no window (would warp)');
  });

  it('after a screenshot, coordinates use the true device/logical ratio (screenshot_width/logical_width), not scale_factor', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // A screenshot sets lastFrameWidthPx=1440; get_screen_size.width=1512. So the
    // PRIMARY scale is 1440/1512 (≈0.952), NOT scale_factor=2. This is the path that
    // matters in the real app (scale_factor was observed lying as 1 on a Retina display
    // → clicks flew off-screen); every OTHER coordinate test exercises only the
    // pre-screenshot scale_factor fallback, so this locks the production path.
    await backend.run({ type: 'screenshot' } as CuAction, sig);
    const res = await backend.run({ type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction, sig);
    assert.equal(res.outcome.ok, true);

    const click = toolCall(await readRecords(logPath), 'click');
    assert.ok(click);
    assert.equal(click!.pid, 4242);
    assert.equal(click!.window_id, 77, 'device (600,400) ÷ 0.952 = screen (630,420) ∈ win 77');
    const scale = 1440 / 1512;
    const expectedX = 600 - 100 * scale; // window-local device px = device − origin*scale
    const expectedY = 400 - 100 * scale;
    assert.ok(Math.abs(click!.x - expectedX) < 1e-6, `localX ${click!.x} ≈ ${expectedX} (primary scale), not the fallback`);
    assert.ok(Math.abs(click!.y - expectedY) < 1e-6, `localY ${click!.y} ≈ ${expectedY}`);
    assert.notEqual(click!.x, 400, 'must NOT be the scale_factor=2 fallback value (400)');
  });

  it('resolveWindowAt picks the highest z-order eligible window; excludes layer!=0 and off-screen', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // scale_factor=2 (no screenshot). Device (2000,400) → screen (1000,200), covered by
    // win 91 (z2), 92 (z9), 93 (layer 3), 94 (off-screen). Eligible = {91,92}; highest
    // z_index wins → 92. 93/94 are excluded despite covering the point and outranking on z.
    const res = await backend.run({ type: 'left_click', coordinate: { x: 2000, y: 400 } } as CuAction, sig);
    assert.equal(res.outcome.ok, true);

    const click = toolCall(await readRecords(logPath), 'click');
    assert.ok(click);
    assert.equal(click!.window_id, 92, 'highest-z eligible window wins the tiebreak (not 91)');
    assert.equal(click!.pid, 5002, 'winner is 92, and the excluded 93 (layer!=0) / 94 (off-screen) were NOT chosen');
    assert.equal(click!.x, 2000 - 950 * 2, 'window-local device px = device − origin.x*scale');
    assert.equal(click!.y, 400 - 150 * 2);
  });

  it('scroll on an app window → pid+window_id (no warp); empty desktop fails closed', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // On a window: device (600,400) → screen (300,200) is inside the mock window.
    const onWin = await backend.run({ type: 'scroll', coordinate: { x: 600, y: 400 }, scrollDirection: 'down', scrollAmount: 3 } as CuAction, sig);
    assert.equal(onWin.outcome.ok, true);
    const scroll = toolCall(await readRecords(logPath), 'scroll');
    assert.ok(scroll, 'scroll sent when a window is under the point');
    assert.equal(scroll!.pid, 4242);
    assert.equal(scroll!.window_id, 77);
    assert.equal(scroll!.scope, undefined, 'must NOT use scope:desktop');
    assert.equal(scroll!.direction, 'down');
    assert.equal(scroll!.amount, 3);
    assert.equal(scroll!.delivery_mode, undefined, 'must NOT force foreground on scroll');

    // Empty desktop → fail closed (device (5,5) → screen (2.5,2.5), outside window).
    const empty = await backend.run({ type: 'scroll', coordinate: { x: 5, y: 5 }, scrollDirection: 'down', scrollAmount: 3 } as CuAction, sig);
    assert.equal(empty.outcome.ok, false);
  });

  it('left_click_drag within one window → drag via pid+window_id (no warp), window-local coords', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // scale=2. start device (600,400) → screen (300,200) ∈ win 77;
    //           end  device (800,600) → screen (400,300) ∈ win 77. Same window.
    const res = await backend.run(
      { type: 'left_click_drag', startCoordinate: { x: 600, y: 400 }, coordinate: { x: 800, y: 600 } } as CuAction,
      sig,
    );
    assert.equal(res.outcome.ok, true, 'same-window drag succeeds');
    const drag = toolCall(await readRecords(logPath), 'drag');
    assert.ok(drag, 'drag sent to cua-driver');
    assert.equal(drag!.pid, 4242);
    assert.equal(drag!.window_id, 77);
    // window-local device px = model device − window origin(100) * scale(2) = 200.
    assert.equal(drag!.from_x, 400); // 600-200
    assert.equal(drag!.from_y, 200); // 400-200
    assert.equal(drag!.to_x, 600); // 800-200
    assert.equal(drag!.to_y, 400); // 600-200
    assert.equal(drag!.scope, undefined, 'must NOT use scope:desktop (the warping path)');
    assert.equal(drag!.delivery_mode, undefined, 'must NOT force foreground; default Background is no-warp + no z-order disturbance');
  });

  it('left_click_drag with an endpoint on empty desktop fails closed — never posts a drag', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // start device (5,5) → screen (2.5,2.5): outside every window ⇒ no pid to post to.
    const res = await backend.run(
      { type: 'left_click_drag', startCoordinate: { x: 5, y: 5 }, coordinate: { x: 600, y: 400 } } as CuAction,
      sig,
    );
    assert.equal(res.outcome.ok, false);
    if (res.outcome.ok === false) assert.equal(res.outcome.error, 'unsupported_action');
    const trace = methodTrace(await readRecords(logPath));
    assert.ok(!trace.includes('tools/call:drag'), 'no drag sent when an endpoint has no window');
  });

  it('left_click_drag across two different windows fails closed — no cross-window drag', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // start device (600,400) → screen (300,200) ∈ win 77;
    //  end  device (400,1400) → screen (200,700) ∈ win 88. Different windows.
    const res = await backend.run(
      { type: 'left_click_drag', startCoordinate: { x: 600, y: 400 }, coordinate: { x: 400, y: 1400 } } as CuAction,
      sig,
    );
    assert.equal(res.outcome.ok, false);
    if (res.outcome.ok === false) assert.equal(res.outcome.error, 'unsupported_action');
    const trace = methodTrace(await readRecords(logPath));
    assert.ok(!trace.includes('tools/call:drag'), 'no drag sent when endpoints span windows');
  });

  it('mouse_move succeeds without touching cua-driver (visual agent-cursor only)', async () => {
    const { backend, logPath } = makeBackend();
    const res = await backend.run({ type: 'mouse_move', coordinate: { x: 100, y: 100 } } as CuAction, new AbortController().signal);
    assert.equal(res.outcome.ok, true);
    const trace = methodTrace(await readRecords(logPath));
    assert.ok(!trace.some((m) => m.startsWith('tools/call:click') || m.startsWith('tools/call:move')), 'mouse_move must not inject real input');
  });

  it('keyboard with NO prior click fails closed — never guesses a target, never injects', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;

    const typeRes = await backend.run({ type: 'type', text: 'hello' } as CuAction, sig);
    assert.equal(typeRes.outcome.ok, false);
    if (typeRes.outcome.ok === false) assert.equal(typeRes.outcome.error, 'unsupported_action');

    const keyRes = await backend.run({ type: 'key', text: 'Return' } as CuAction, sig);
    assert.equal(keyRes.outcome.ok, false);
    if (keyRes.outcome.ok === false) assert.equal(keyRes.outcome.error, 'unsupported_action');

    // The non-negotiable invariant: with no agent-established target, the backend
    // must NEVER resolve a frontmost pid (list_apps) or emit any keystroke. It is
    // the ONLY safe answer — guessing frontmost = typing into the user's window.
    const trace = methodTrace(await readRecords(logPath));
    assert.ok(!trace.includes('tools/call:list_apps'), 'list_apps must not be queried (no frontmost routing)');
    assert.ok(!trace.includes('tools/call:type_text'), 'type_text must never be sent without a target');
    assert.ok(!trace.includes('tools/call:press_key'), 'press_key must never be sent without a target');
  });

  it('type after a click → type_text to the clicked window (pid+window_id, background, never foreground)', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    // Establish the target: click win 77 (device 600,400 → screen 300,200 ∈ win 77).
    const click = await backend.run({ type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction, sig);
    assert.equal(click.outcome.ok, true);

    const typed = await backend.run({ type: 'type', text: 'hello world' } as CuAction, sig);
    assert.equal(typed.outcome.ok, true, 'type succeeds once a target is established');

    const records = await readRecords(logPath);
    const call = toolCall(records, 'type_text');
    assert.ok(call, 'type_text sent to the agent-clicked window');
    assert.equal(call!.pid, 4242);
    assert.equal(call!.window_id, 77);
    assert.equal(call!.text, 'hello world');
    assert.equal(call!.delivery_mode, undefined, 'must NOT force foreground — default background = no focus steal');
    // Red line: the target came from the click, never from a frontmost lookup.
    assert.ok(!methodTrace(records).includes('tools/call:list_apps'), 'must never resolve a frontmost pid to type into');
  });

  it('key chord after a click → press_key with parsed key + modifiers (cmd+a)', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    await backend.run({ type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction, sig);

    const res = await backend.run({ type: 'key', text: 'cmd+a' } as CuAction, sig);
    assert.equal(res.outcome.ok, true);
    const call = toolCall(await readRecords(logPath), 'press_key');
    assert.ok(call, 'press_key sent to the clicked window');
    assert.equal(call!.pid, 4242);
    assert.equal(call!.window_id, 77);
    assert.equal(call!.key, 'a');
    assert.deepEqual(call!.modifiers, ['cmd']);
    assert.equal(call!.delivery_mode, undefined, 'background default, never foreground');
  });

  it('plain named key after a click → press_key key:"return" with no modifier array', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    await backend.run({ type: 'left_click', coordinate: { x: 600, y: 400 } } as CuAction, sig);

    const res = await backend.run({ type: 'key', text: 'Return' } as CuAction, sig);
    assert.equal(res.outcome.ok, true);
    const call = toolCall(await readRecords(logPath), 'press_key');
    assert.ok(call);
    assert.equal(call!.key, 'return');
    assert.equal(call!.modifiers, undefined, 'omit modifiers when the chord carries none');
  });

  it('scroll also establishes the keyboard target (any agent-aimed window counts)', async () => {
    const { backend, logPath } = makeBackend();
    const sig = new AbortController().signal;
    await backend.run({ type: 'scroll', coordinate: { x: 600, y: 400 }, scrollDirection: 'down', scrollAmount: 2 } as CuAction, sig);

    const res = await backend.run({ type: 'type', text: 'hi' } as CuAction, sig);
    assert.equal(res.outcome.ok, true, 'type works after scroll established the target');
    const call = toolCall(await readRecords(logPath), 'type_text');
    assert.ok(call);
    assert.equal(call!.pid, 4242);
    assert.equal(call!.window_id, 77);
  });

  it('parseKeyChord maps Anthropic key chords to cua-driver key + mac modifiers', () => {
    assert.deepEqual(parseKeyChord('Return'), { key: 'return', modifiers: [] });
    assert.deepEqual(parseKeyChord('cmd+a'), { key: 'a', modifiers: ['cmd'] });
    assert.deepEqual(parseKeyChord('ctrl+shift+t'), { key: 't', modifiers: ['ctrl', 'shift'] });
    assert.deepEqual(parseKeyChord('command+Shift+3'), { key: '3', modifiers: ['cmd', 'shift'] });
    assert.deepEqual(parseKeyChord('alt+Tab'), { key: 'tab', modifiers: ['option'] });
    assert.deepEqual(parseKeyChord('super+l'), { key: 'l', modifiers: ['cmd'] });
    assert.deepEqual(parseKeyChord('esc'), { key: 'escape', modifiers: [] });
    assert.deepEqual(parseKeyChord('Page_Down'), { key: 'pagedown', modifiers: [] });
    assert.deepEqual(parseKeyChord('+'), { key: '+', modifiers: [] }); // lone plus key
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
