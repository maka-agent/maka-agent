import assert from 'node:assert/strict';
import test from 'node:test';

import {
  anthropicComputerImageSize,
  createAnthropicComputerHarness,
} from '../anthropic-computer-harness.js';

test('Anthropic vision budget maps 1920x1200 to 1389x868', () => {
  assert.deepEqual(anthropicComputerImageSize(1920, 1200), {
    widthPx: 1389,
    heightPx: 868,
  });
});

test('Anthropic model coordinates map back to the capture frame', () => {
  const harness = createAnthropicComputerHarness({
    resolveCaptureDisplay: () => ({ widthPx: 1920, heightPx: 1200 }),
    resizeFrame: (screenshot, target) => ({ ...screenshot, ...target }),
  });
  const action = harness.toSourceAction({
    type: 'left_click',
    coordinate: { x: 916, y: 492 },
  });
  assert.deepEqual(action, {
    type: 'left_click',
    coordinate: { x: 1266, y: 680 },
  });
});

test('Anthropic screenshots are sent in the exact declared model frame', () => {
  const harness = createAnthropicComputerHarness({
    resolveCaptureDisplay: () => ({ widthPx: 1920, heightPx: 1200 }),
    resizeFrame: (screenshot, target) => ({ ...screenshot, ...target, mimeType: 'image/jpeg' }),
  });
  assert.deepEqual(harness.resolveModelDisplay(), { widthPx: 1389, heightPx: 868 });
  const prepared = harness.prepareScreenshot({
    base64: 'AA==',
    mimeType: 'image/png',
    widthPx: 1920,
    heightPx: 1200,
  });
  assert.deepEqual(prepared, {
    base64: 'AA==',
    mimeType: 'image/jpeg',
    widthPx: 1389,
    heightPx: 868,
  });
});
