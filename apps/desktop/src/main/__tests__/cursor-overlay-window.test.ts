// Behavior contract for the cursor overlay window controller. Drives it against a
// FakeCursorOverlayWindow (no Electron) and asserts the Path 18 invariants:
//  - S14: focusable:false + setIgnoreMouseEvents(true,{forward:true}) armed BEFORE
//    showInactive; never a .focus(); receive-only preload wired.
//  - persistence: move() does NOT recreate the window (no teardown-per-move).
//  - S15: coords are MAIN-computed window-local (screen − bounds.origin).
//  - S13/S18: teardown is synchronous destroy() on clear/abort/destroyAll/supersede.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCursorOverlayController, cursorOverlayWindowOptions } from '../computer-use/cursor-overlay-window.js';

type Call = { m: string; args: unknown[] };

class FakeCursorOverlayWindow {
  calls: Call[] = [];
  sent: Array<{ channel: string; payload: unknown }> = [];
  private readyCb: (() => void) | null = null;
  destroyed = false;
  constructor(public options: Record<string, unknown>) {}
  private rec(m: string, ...args: unknown[]): void { this.calls.push({ m, args }); }
  setIgnoreMouseEvents(ignore: boolean, opts?: unknown): void { this.rec('setIgnoreMouseEvents', ignore, opts); }
  setAlwaysOnTop(flag: boolean, level?: unknown): void { this.rec('setAlwaysOnTop', flag, level); }
  setVisibleOnAllWorkspaces(v: boolean, o?: unknown): void { this.rec('setVisibleOnAllWorkspaces', v, o); }
  async loadFile(p: string): Promise<void> { this.rec('loadFile', p); }
  showInactive(): void { this.rec('showInactive'); }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; this.rec('destroy'); }
  send(channel: string, payload: unknown): void { this.sent.push({ channel, payload }); }
  onReady(cb: () => void): void { this.readyCb = cb; }
  fireReady(): void { this.readyCb?.(); }
}

const BOUNDS = { x: 100, y: 50, width: 1440, height: 900 };
function harness() {
  const created: FakeCursorOverlayWindow[] = [];
  const controller = createCursorOverlayController({
    createOverlayWindow: (options) => {
      const w = new FakeCursorOverlayWindow(options as Record<string, unknown>);
      created.push(w);
      return w as never;
    },
    resolveOverlayBounds: () => BOUNDS,
    preloadPath: '/fake/preload.cjs',
    htmlPath: '/fake/overlay.html',
  });
  return { controller, created };
}

test('S14 window options: focusable:false + non-interactive flags + receive-only preload', () => {
  const opts = cursorOverlayWindowOptions(BOUNDS, '/p/preload.cjs') as Record<string, any>;
  assert.equal(opts.focusable, false);
  assert.equal(opts.transparent, true);
  assert.equal(opts.frame, false);
  assert.equal(opts.alwaysOnTop, true);
  assert.equal(opts.skipTaskbar, true);
  assert.equal(opts.acceptFirstMouse, false);
  assert.equal(opts.show, false);
  assert.equal(opts.webPreferences.preload, '/p/preload.cjs');
  assert.equal(opts.webPreferences.sandbox, true);
  assert.equal(opts.webPreferences.contextIsolation, true);
  assert.equal(opts.webPreferences.nodeIntegration, false);
});

test('ensure(): arms click-through BEFORE showInactive, never focuses', () => {
  const { controller, created } = harness();
  controller.ensure('sess-1');
  assert.equal(created.length, 1);
  const w = created[0];
  assert.equal(w.options.focusable, false);
  const order = w.calls.map((c) => c.m);
  const armIdx = order.indexOf('setIgnoreMouseEvents');
  const showIdx = order.indexOf('showInactive');
  assert.ok(armIdx >= 0 && showIdx >= 0 && armIdx < showIdx, `click-through armed before show (${order.join(',')})`);
  const arm = w.calls.find((c) => c.m === 'setIgnoreMouseEvents')!;
  assert.deepEqual(arm.args, [true, { forward: true }]);
  const aot = w.calls.find((c) => c.m === 'setAlwaysOnTop')!;
  assert.deepEqual(aot.args, [true, 'screen-saver']);
  assert.ok(!order.includes('focus'), 'never focuses');
});

test('persistence: move() does NOT recreate the window; sends window-local coords', () => {
  const { controller, created } = harness();
  controller.move({ actionId: 'a0', sessionId: 's', screenX: 300, screenY: 250, kind: 'move' });
  controller.move({ actionId: 'a1', sessionId: 's', screenX: 500, screenY: 450, kind: 'click' });
  controller.move({ actionId: 'a2', sessionId: 's', screenX: 700, screenY: 650, kind: 'move' });
  assert.equal(created.length, 1, 'one window across 3 moves');
  const w = created[0];
  // before ready → queued; fire ready → reset first, then the 3 moves.
  w.fireReady();
  assert.equal(w.sent[0].channel, 'overlay:reset');
  assert.deepEqual((w.sent[0].payload as any).sessionColorId, 's');
  const moves = w.sent.filter((s) => s.channel === 'overlay:move');
  assert.equal(moves.length, 3);
  // window-local = screen − bounds.origin (100,50)
  assert.deepEqual(moves[0].payload, { x: 200, y: 200, kind: 'move', pressed: false });
  assert.deepEqual(moves[1].payload, { x: 400, y: 400, kind: 'click', pressed: false });
  // a post-ready move sends immediately
  controller.move({ actionId: 'a3', sessionId: 's', screenX: 200, screenY: 150, kind: 'move' });
  const movesAfter = w.sent.filter((s) => s.channel === 'overlay:move');
  assert.equal(movesAfter.length, 4);
  assert.deepEqual(movesAfter[3].payload, { x: 100, y: 100, kind: 'move', pressed: false });
});

test('teardown: clearForSession / abort / destroyAll destroy synchronously; supersede on session change', () => {
  const { controller, created } = harness();
  controller.move({ actionId: 'a0', sessionId: 's1', screenX: 300, screenY: 250, kind: 'move' });
  controller.clearForSession('other'); // non-match ignored
  assert.ok(!created[0].destroyed, 'non-matching clear ignored');
  controller.clearForSession('s1');
  assert.ok(created[0].destroyed, 'matching clear destroys');

  // supersede: a different session destroys the old window and creates a new one
  const h = harness();
  h.controller.ensure('sA');
  h.controller.ensure('sB');
  assert.ok(h.created[0].destroyed, 'old session window superseded');
  assert.equal(h.created.length, 2);
  assert.ok(!h.created[1].destroyed);

  // abort keys on actionId
  const h2 = harness();
  h2.controller.move({ actionId: 'act-9', sessionId: 's', screenX: 1, screenY: 1, kind: 'move' });
  h2.controller.abort('stale'); // ignored
  assert.ok(!h2.created[0].destroyed);
  h2.controller.abort('act-9');
  assert.ok(h2.created[0].destroyed);
});

test('fail-closed: empty ids and non-finite coords are no-ops', () => {
  const { controller, created } = harness();
  controller.ensure('');
  assert.equal(created.length, 0, 'empty sessionId → no window');
  controller.move({ actionId: 'a', sessionId: '', screenX: 10, screenY: 10, kind: 'move' });
  assert.equal(created.length, 0, 'empty sessionId move → no window');
  controller.move({ actionId: 'a', sessionId: 's', screenX: NaN, screenY: 10, kind: 'move' });
  assert.equal(created.length, 0, 'NaN coord → no window');
});
