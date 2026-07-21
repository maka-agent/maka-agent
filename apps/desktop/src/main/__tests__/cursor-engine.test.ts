import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  CODEX_CURSOR_GLYPH,
  CODEX_CURSOR_MOTION,
  CursorEngine,
} from '../../renderer/computer-use-overlay/engine/cursor-engine.js';
import { planDirectPath, planPath } from '../../renderer/computer-use-overlay/engine/dubins.js';
import { paletteForInstance, defaultPalette, gradientAt } from '../../renderer/computer-use-overlay/engine/palette.js';

const finite = (value: number): boolean => Number.isFinite(value);

test('Dubins path primitive remains finite for legacy callers', () => {
  const path = planPath(0, 0, 0, 400, 200, Math.PI / 4, Math.PI / 4, 80);
  assert.ok(finite(path.length) && path.length > 0);
  const start = path.sample(0);
  const end = path.sample(path.length);
  assert.ok(Math.hypot(start.x, start.y) < 0.01);
  assert.ok(Math.hypot(end.x - 400, end.y - 200) < 1);
});

test('legacy direct planner still ends exactly at the target', () => {
  const path = planDirectPath(12, 34, 112, 84, Math.PI / 4);
  assert.ok(Math.abs(path.length - Math.hypot(100, 50)) < 0.001);
  const end = path.sample(path.length);
  assert.ok(Math.hypot(end.x - 112, end.y - 84) < 0.001);
});

test('recovered Codex cursor constants keep their inspected-build values', () => {
  assert.equal(CODEX_CURSOR_MOTION.candidateCount, 20);
  assert.equal(CODEX_CURSOR_MOTION.straightPathDistanceThreshold, 10);
  assert.equal(CODEX_CURSOR_MOTION.scootDistanceThreshold, 196);
  assert.equal(CODEX_CURSOR_MOTION.scootStretchXAmount, 0.38);
  assert.equal(CODEX_CURSOR_MOTION.scootSquashYAmount, 0.18);
  assert.equal(CODEX_CURSOR_MOTION.terminalTangentBlendStart, 0.99);
  assert.equal(CODEX_CURSOR_GLYPH.size, 14);
  assert.deepEqual(CODEX_CURSOR_GLYPH.start, [0.00599, 0.15864]);
});

test('first appearance uses the requested center hotspot without an off-screen glide', () => {
  const engine = new CursorEngine();
  engine.moveTo(400, 300);
  assert.deepEqual(engine.pos, [400, 300]);
  assert.equal(engine.hasMotionPath(), false);
  assert.ok(engine.isMoving(), 'first appearance fades in at the target');
  for (let frame = 0; frame < 12; frame++) engine.tick(1 / 60);
  assert.ok(!engine.isMoving());
});

test('subsequent move spring-settles exactly on the center hotspot', () => {
  const engine = new CursorEngine();
  engine.moveTo(100, 100);
  engine.moveTo(700, 360);
  let frames = 0;
  while (engine.isMoving() && frames < 60 * 8) {
    engine.tick(1 / 60);
    assert.ok(finite(engine.pos[0]) && finite(engine.pos[1]) && finite(engine.heading));
    frames++;
  }
  assert.ok(!engine.isMoving(), `settled in ${frames} frames`);
  assert.ok(Math.hypot(engine.pos[0] - 700, engine.pos[1] - 360) < 0.01);
  assert.ok(frames > 10 && frames < 60 * 4);
});

test('presentation progress APIs track the active spring path', () => {
  const engine = new CursorEngine();
  engine.moveTo(100, 100);
  engine.moveTo(700, 360);
  assert.equal(engine.hasMotionPath(), true);
  assert.equal(engine.motionProgress(), 0);
  assert.ok(engine.motionDistanceRemaining() > 600);
  for (let frame = 0; frame < 20; frame++) engine.tick(1 / 60);
  assert.ok(engine.motionProgress() > 0);
  assert.ok(engine.motionDistanceRemaining() < 654);
});

test('short move remains finite and converges without a curved overshoot', () => {
  const engine = new CursorEngine();
  engine.moveTo(200, 200);
  engine.moveTo(206, 204);
  let frames = 0;
  while (engine.isMoving() && frames < 300) {
    engine.tick(1 / 60);
    frames++;
  }
  assert.ok(Math.hypot(engine.pos[0] - 206, engine.pos[1] - 204) < 0.01);
});

test('boundary path never bows outside the viewport', () => {
  const engine = new CursorEngine();
  engine.setViewport(800, 600);
  engine.moveTo(5, 5);
  engine.moveTo(5, 500);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (let frame = 0; engine.isMoving() && frame < 300; frame++) {
    engine.tick(1 / 60);
    minX = Math.min(minX, engine.pos[0]);
    minY = Math.min(minY, engine.pos[1]);
  }
  assert.ok(minX >= 0, `minimum x should remain visible, got ${minX}`);
  assert.ok(minY >= 0, `minimum y should remain visible, got ${minY}`);
  assert.deepEqual(engine.pos, [5, 500]);
});

test('paint uses exact three-curve AgentCursor shape centered on the hotspot', () => {
  const engine = new CursorEngine();
  engine.moveTo(320, 240);

  const moves: Point[] = [];
  const curves: number[][] = [];
  const transforms: string[] = [];
  const gradient = { addColorStop() {} };
  type Point = [number, number];
  const ctx = {
    createLinearGradient: () => gradient,
    beginPath() {},
    fill() {},
    stroke() {},
    moveTo(x: number, y: number) { moves.push([x, y]); },
    lineTo() {},
    bezierCurveTo(...args: number[]) { curves.push(args); },
    closePath() {},
    save() { transforms.push('save'); },
    restore() { transforms.push('restore'); },
    translate(x: number, y: number) { transforms.push(`translate:${x},${y}`); },
    rotate() {},
    scale() {},
    set fillStyle(_value: unknown) {},
    set strokeStyle(_value: unknown) {},
    set lineWidth(_value: number) {},
    set lineJoin(_value: CanvasLineJoin) {},
    set lineCap(_value: CanvasLineCap) {},
    set shadowColor(_value: string) {},
    set shadowBlur(_value: number) {},
    set shadowOffsetX(_value: number) {},
    set shadowOffsetY(_value: number) {},
    set globalAlpha(_value: number) {},
  } as unknown as CanvasRenderingContext2D;

  engine.paint(ctx, 0, 0);
  assert.equal(curves.length, 3);
  assert.deepEqual(transforms, ['save', 'translate:320,240', 'restore']);
  const expectedStartX = -CODEX_CURSOR_GLYPH.size / 2
    + CODEX_CURSOR_GLYPH.start[0] * CODEX_CURSOR_GLYPH.size;
  const expectedStartY = -CODEX_CURSOR_GLYPH.size / 2
    + CODEX_CURSOR_GLYPH.start[1] * CODEX_CURSOR_GLYPH.size;
  assert.ok(Math.abs(moves[0][0] - expectedStartX) < 1e-9);
  assert.ok(Math.abs(moves[0][1] - expectedStartY) < 1e-9);
});

test('native completion snaps the center hotspot and cancels the planned move', () => {
  const engine = new CursorEngine();
  engine.moveTo(100, 100);
  engine.moveTo(500, 300);
  engine.tick(1 / 60);
  engine.completeAt(320, 240, true);
  assert.deepEqual(engine.pos, [320, 240]);
  assert.equal(engine.hasMotionPath(), false);
  assert.equal(engine.motionProgress(), 1);
  assert.equal(engine.motionDistanceRemaining(), 0);
  assert.equal(engine.isMoving(), true, 'press animation remains active');
});

test('cancel clears path, pressed state, and press animation', () => {
  const engine = new CursorEngine();
  engine.moveTo(100, 100);
  engine.moveTo(500, 300, undefined, true);
  engine.pressed = true;
  engine.triggerClick(500, 300);
  engine.cancel();
  assert.equal(engine.hasMotionPath(), false);
  assert.equal(engine.isMoving(), false);
  assert.equal(engine.pressed, false);
});

test('cancel during first fade restores full opacity for the next move', () => {
  const engine = new CursorEngine();
  engine.moveTo(100, 100);
  engine.tick(1 / 60);
  engine.cancel();
  engine.moveTo(200, 200);

  let globalAlpha = -1;
  const gradient = { addColorStop() {} };
  const ctx = {
    createLinearGradient: () => gradient,
    beginPath() {},
    fill() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    bezierCurveTo() {},
    closePath() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    set fillStyle(_value: unknown) {},
    set strokeStyle(_value: unknown) {},
    set lineWidth(_value: number) {},
    set lineJoin(_value: CanvasLineJoin) {},
    set lineCap(_value: CanvasLineCap) {},
    set shadowColor(_value: string) {},
    set shadowBlur(_value: number) {},
    set shadowOffsetX(_value: number) {},
    set shadowOffsetY(_value: number) {},
    set globalAlpha(value: number) { globalAlpha = value; },
  } as unknown as CanvasRenderingContext2D;

  engine.paint(ctx, 0, 0);
  assert.equal(globalAlpha, 1);
});

test('overlay cancel waits for the renderer frame before reporting finished', async () => {
  const source = await readFile(
    new URL('../../../src/overlay/cursor-overlay.ts', import.meta.url),
    'utf8',
  );
  const cancelBlock = source.match(/onCancel\(\(p\) => \{([\s\S]*?)\n\}\);/)?.[1] ?? '';
  assert.match(cancelBlock, /engine\.cancel\(\)/);
  assert.match(cancelBlock, /kick\(\)/);
  assert.doesNotMatch(cancelBlock, /reportPhase\('finished'\)/);
});

test('click press animation clears over about 0.25 seconds', () => {
  const engine = new CursorEngine();
  engine.moveTo(100, 100);
  engine.triggerClick(100, 100);
  let ticks = 0;
  while (engine.isMoving() && ticks < 60) {
    engine.tick(1 / 60);
    ticks++;
  }
  assert.ok(ticks >= 14 && ticks <= 18, `${ticks} ticks`);
});

test('palette selection remains deterministic', () => {
  assert.equal(paletteForInstance('run-1').name, paletteForInstance('run-1').name);
  assert.equal(paletteForInstance('default').name, 'default_blue');
  assert.equal(paletteForInstance('').name, 'default_blue');
  const names = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => paletteForInstance(`run-${n}`).name));
  assert.ok(names.size >= 5);
  assert.notEqual(gradientAt(defaultPalette(), 0).join(), gradientAt(defaultPalette(), 1).join());
});
