// Unit tests for the ported agent-cursor engine (palette + Dubins + tick/spring).
// Pure math — no DOM; `paint()` is exercised only by the visual demo. Faithful to
// trycua/cua's cursor-overlay Rust source these were ported from.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CursorEngine } from '../../renderer/computer-use-overlay/engine/cursor-engine.js';
import { planPath } from '../../renderer/computer-use-overlay/engine/dubins.js';
import { paletteForInstance, defaultPalette, gradientAt } from '../../renderer/computer-use-overlay/engine/palette.js';

const finite = (v: number): boolean => Number.isFinite(v);
const REST_HEADING = Math.PI / 4;
const ARROW_TIP_LENGTH = 14;

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
  e.moveTo(tx, ty); // center is offset so the 14px arrow tip lands on (tx, ty)
  const offX = tx + Math.cos(REST_HEADING) * ARROW_TIP_LENGTH;
  const offY = ty + Math.sin(REST_HEADING) * ARROW_TIP_LENGTH;
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

test('first move glides IN from off-screen (not a pop) and converges to target', () => {
  const e = new CursorEngine();
  assert.ok(e.pos[0] < -100, 'starts off-screen');
  e.moveTo(400, 400);
  e.tick(1 / 60);
  // Entered on-screen but NOT already at the target — it's gliding in.
  assert.ok(e.pos[0] > 0 && e.pos[0] < 400, `entering, still gliding (pos ${e.pos[0]})`);
  let frames = 1;
  while (e.isMoving() && frames < 600) { e.tick(1 / 60); frames++; }
  const tx = 400 + Math.cos(REST_HEADING) * ARROW_TIP_LENGTH;
  const ty = 400 + Math.sin(REST_HEADING) * ARROW_TIP_LENGTH;
  assert.ok(Math.hypot(e.pos[0] - tx, e.pos[1] - ty) < 1.5, 'converged to target+offset');
});

test('click pulse is centered on the action coordinate, not the arrow body', () => {
  const e = new CursorEngine();
  const targetX = 320;
  const targetY = 240;
  e.moveTo(targetX, targetY, undefined, true);
  for (let frames = 0; e.isMoving() && frames < 600; frames++) e.tick(1 / 60);
  e.triggerClick(targetX, targetY);

  const arcs: Array<{ x: number; y: number; radius: number }> = [];
  const gradient = { addColorStop() {} };
  const ctx = {
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    beginPath() {},
    arc(x: number, y: number, radius: number) { arcs.push({ x, y, radius }); },
    fill() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    set fillStyle(_value: unknown) {},
    set strokeStyle(_value: unknown) {},
    set lineWidth(_value: number) {},
    set lineJoin(_value: CanvasLineJoin) {},
  } as unknown as CanvasRenderingContext2D;

  e.paint(ctx, 0, 0);
  assert.ok(
    arcs.some((arc) => Math.hypot(arc.x - targetX, arc.y - targetY) < 0.01),
    `click pulse should include action coordinate (${targetX},${targetY}); arcs=${JSON.stringify(arcs)}`,
  );
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
