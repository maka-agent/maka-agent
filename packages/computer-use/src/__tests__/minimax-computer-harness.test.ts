import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMiniMaxComputerHarness,
  minimaxComputerFrameTransform,
  minimaxModelPointToSource,
} from '../minimax-computer-harness.js';

test('MiniMax uses a fixed 1280px long edge without upscaling small captures', () => {
  assert.deepEqual(minimaxComputerFrameTransform({ widthPx: 1920, heightPx: 1200 }), {
    source: { widthPx: 1920, heightPx: 1200 },
    model: { widthPx: 1280, heightPx: 800 },
  });
  assert.deepEqual(minimaxComputerFrameTransform({ widthPx: 1200, heightPx: 1920 }), {
    source: { widthPx: 1200, heightPx: 1920 },
    model: { widthPx: 800, heightPx: 1280 },
  });
  assert.deepEqual(minimaxComputerFrameTransform({ widthPx: 1024, heightPx: 768 }), {
    source: { widthPx: 1024, heightPx: 768 },
    model: { widthPx: 1024, heightPx: 768 },
  });
});

test('MiniMax model coordinates map back through the explicit source/model transform', () => {
  const transform = minimaxComputerFrameTransform({ widthPx: 1920, heightPx: 1200 });
  assert.deepEqual(minimaxModelPointToSource({ x: 640, y: 400 }, transform), {
    x: 960,
    y: 600,
  });
  assert.deepEqual(minimaxModelPointToSource({ x: 1279, y: 799 }, transform), {
    x: 1919,
    y: 1199,
  });
  assert.throws(
    () => minimaxModelPointToSource({ x: 1280, y: 800 }, transform),
    /invalid_coordinate/,
  );
});

test('MiniMax maps click, drag, and zoom coordinates back to the capture frame', () => {
  const harness = createMiniMaxComputerHarness({
    resolveCaptureDisplay: () => ({ widthPx: 1920, heightPx: 1200 }),
    resizeFrame: (screenshot, target) => ({ ...screenshot, ...target }),
  });

  assert.deepEqual(harness.toSourceAction({
    type: 'left_click',
    coordinate: { x: 400, y: 300 },
  }), {
    type: 'left_click',
    coordinate: { x: 600, y: 450 },
  });
  assert.deepEqual(harness.toSourceAction({
    type: 'left_click_drag',
    startCoordinate: { x: 100, y: 80 },
    coordinate: { x: 800, y: 600 },
  }), {
    type: 'left_click_drag',
    startCoordinate: { x: 150, y: 120 },
    coordinate: { x: 1200, y: 900 },
  });
  assert.deepEqual(harness.toSourceAction({
    type: 'zoom',
    region: { x1: 100, y1: 80, x2: 800, y2: 600 },
  }), {
    type: 'zoom',
    region: { x1: 150, y1: 120, x2: 1200, y2: 900 },
  });
});

test('MiniMax sends full desktop screenshots in the declared model frame', () => {
  const harness = createMiniMaxComputerHarness({
    resolveCaptureDisplay: () => ({ widthPx: 1920, heightPx: 1200 }),
    resizeFrame: (screenshot, target) => ({ ...screenshot, ...target, mimeType: 'image/jpeg' }),
  });

  assert.deepEqual(harness.resolveModelDisplay(), { widthPx: 1280, heightPx: 800 });
  assert.deepEqual(harness.prepareScreenshot({
    base64: 'AA==',
    mimeType: 'image/png',
    widthPx: 1920,
    heightPx: 1200,
  }), {
    base64: 'AA==',
    mimeType: 'image/jpeg',
    widthPx: 1280,
    heightPx: 800,
  });
});

test('MiniMax leaves cropped zoom frames outside the desktop transform untouched', () => {
  const harness = createMiniMaxComputerHarness({
    resolveCaptureDisplay: () => ({ widthPx: 1920, heightPx: 1200 }),
    resizeFrame: () => {
      throw new Error('zoom crops must not be resized as full desktop frames');
    },
  });
  const crop = {
    base64: 'AA==',
    mimeType: 'image/jpeg' as const,
    widthPx: 600,
    heightPx: 400,
  };
  assert.equal(harness.prepareScreenshot(crop), crop);
});

test('MiniMax actions use the transform captured with the latest screenshot', () => {
  let display = { widthPx: 1920, heightPx: 1200 };
  const harness = createMiniMaxComputerHarness({
    resolveCaptureDisplay: () => display,
    resizeFrame: (screenshot, target) => ({ ...screenshot, ...target }),
  });
  harness.prepareScreenshot({
    base64: 'AA==',
    mimeType: 'image/png',
    widthPx: 1920,
    heightPx: 1200,
  });
  display = { widthPx: 2560, heightPx: 1600 };

  assert.deepEqual(harness.toSourceAction({
    type: 'left_click',
    coordinate: { x: 640, y: 400 },
  }), {
    type: 'left_click',
    coordinate: { x: 960, y: 600 },
  });
});
