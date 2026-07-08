// Unit tests for the ported agent-cursor engine (palette + Dubins + tick/spring).
// Pure math — no DOM; `paint()` is exercised only by the visual demo. Faithful to
// trycua/cua's cursor-overlay Rust source these were ported from.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CursorEngine } from '../../renderer/computer-use-overlay/engine/cursor-engine.js';
import { planPath } from '../../renderer/computer-use-overlay/engine/dubins.js';
import { paletteForInstance, defaultPalette, gradientAt } from '../../renderer/computer-use-overlay/engine/palette.js';

const finite = (v: number): boolean => Number.isFinite(v);

test('Dubins path: exact endpoints, finite length, C0 continuity', () => {
  const path = planPath(0, 0, 0, 400, 200, Math.PI / 4, Math.PI / 4, 80);
  assert.ok(finite(path.length) && path.length > 0, `length ${path.length}`);
  const s0 = path.sample(0);
  assert.ok(Math.hypot(s0.x, s0.y) < 0.01, 'sample(0) == start');
  const sEnd = path.sample(path.length);
  assert.ok(Math.hypot(sEnd.x - 400, sEnd.y - 200) < 1.0, `sample(len) ≈ target (err ${Math.hypot(sEnd.x - 400, sEnd.y - 200)})`);
  let prev = path.sample(0);
  const N = 400;
  let maxStep = 0;
  for (let i = 1; i <= N; i++) {
    const cur = path.sample((path.length * i) / N);
    assert.ok(finite(cur.x) && finite(cur.y), 'no NaN along path');
    maxStep = Math.max(maxStep, Math.hypot(cur.x - prev.x, cur.y - prev.y));
    prev = cur;
  }
  assert.ok(maxStep < (path.length / N) * 3, `continuity: max step ${maxStep}`);
});

test('speed profile peaks at 1.0 at u=0.5 (smootherstep)', () => {
  const u = 0.5;
  const profile = (30 * u * u * (1 - u) * (1 - u)) / 1.875;
  assert.ok(Math.abs(profile - 1.0) < 1e-9, `profile ${profile}`);
});

test('engine glides + spring-settles onto target+offset, no NaN', () => {
  const e = new CursorEngine();
  e.setSession('conv-test');
  const tx = 500, ty = 300;
  e.moveTo(tx, ty); // default endHeading π/4 → +16px offset
  const offX = tx + Math.cos(Math.PI / 4) * 16;
  const offY = ty + Math.sin(Math.PI / 4) * 16;
  let frames = 0;
  const dt = 1 / 60;
  while (e.isMoving() && frames < 60 * 8) {
    e.tick(dt);
    assert.ok(finite(e.pos[0]) && finite(e.pos[1]) && finite(e.heading), 'no NaN');
    frames++;
  }
  assert.ok(!e.isMoving(), `settled (frames ${frames})`);
  assert.ok(Math.hypot(e.pos[0] - offX, e.pos[1] - offY) < 1.0, 'final pos ≈ target+offset');
  assert.ok(frames > 20 && frames < 60 * 6, `glide duration sane (${(frames / 60).toFixed(2)}s)`);
});

test('first move snaps in from off-screen sentinel (no wild glide from -200)', () => {
  const e = new CursorEngine();
  // sentinel start
  assert.ok(e.pos[0] < -100, 'starts off-screen');
  e.moveTo(400, 400);
  e.tick(1 / 60);
  assert.ok(e.pos[0] > 0 && e.pos[1] > 0, 'came on-screen on first move');
});

test('click pulse clears over ~0.25s', () => {
  const e = new CursorEngine();
  e.setSession('x');
  e.triggerClick(100, 100);
  let ticks = 0;
  while (e.isMoving() && ticks < 60) { e.tick(1 / 60); ticks++; }
  assert.ok(ticks >= 14 && ticks <= 17, `~0.25s (${ticks} ticks)`);
});

test('palette: deterministic, default→default_blue, varied across ids', () => {
  assert.equal(paletteForInstance('run-1').name, paletteForInstance('run-1').name);
  assert.equal(paletteForInstance('default').name, 'default_blue');
  assert.equal(paletteForInstance('').name, 'default_blue');
  const names = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => paletteForInstance(`run-${n}`).name));
  assert.ok(names.size >= 5, `varied (${names.size})`);
  const g0 = gradientAt(defaultPalette(), 0).join();
  const g1 = gradientAt(defaultPalette(), 1).join();
  assert.notEqual(g0, g1, 'gradient endpoints differ');
});
