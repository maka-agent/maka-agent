import assert from 'node:assert/strict';
import test from 'node:test';

import { createKimiComputerHarness, kimiComputerImageSize } from '../kimi-computer-harness.js';

test('Kimi keeps a 1920x1200 screenshot at native size', () => {
  assert.deepEqual(kimiComputerImageSize(1920, 1200), { widthPx: 1920, heightPx: 1200 });
});

test('Kimi fits oversized screenshots inside 4096x2160', () => {
  assert.deepEqual(kimiComputerImageSize(5120, 2880), { widthPx: 3840, heightPx: 2160 });
});

test('Kimi maps model coordinates back to the source frame', () => {
  const harness = createKimiComputerHarness({
    resolveCaptureDisplay: () => ({ widthPx: 5120, heightPx: 2880 }),
    resizeFrame: (screenshot, target) => ({ ...screenshot, ...target }),
  });
  assert.deepEqual(harness.toSourceAction({
    type: 'left_click',
    coordinate: { x: 1920, y: 1080 },
  }), {
    type: 'left_click',
    coordinate: { x: 2560, y: 1440 },
  });
});
