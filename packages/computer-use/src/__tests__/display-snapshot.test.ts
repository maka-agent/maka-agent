import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveCuaDisplaySnapshots } from '../display-snapshot.js';

describe('resolveCuaDisplaySnapshots', () => {
  it('maps a 2x primary display to screenshot pixels', () => {
    assert.deepEqual(
      resolveCuaDisplaySnapshots({
        displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2 }],
        primaryDisplayId: 1,
        screenshotWidthPx: 3024,
        screenshotHeightPx: 1964,
      }),
      [
        {
          displayId: '1',
          logicalBounds: { x: 0, y: 0, width: 1512, height: 982 },
          sourceBoundsPx: { x: 0, y: 0, width: 3024, height: 1964 },
          scaleFactor: 2,
        },
      ],
    );
  });

  it('maps equal-scale displays with a negative origin into one source atlas', () => {
    assert.deepEqual(
      resolveCuaDisplaySnapshots({
        displays: [
          { id: 'left', bounds: { x: -1000, y: 0, width: 1000, height: 800 }, scaleFactor: 1 },
          { id: 'main', bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 1 },
        ],
        primaryDisplayId: 'main',
        screenshotWidthPx: 2000,
        screenshotHeightPx: 800,
      }).map((display) => [display.displayId, display.sourceBoundsPx]),
      [
        ['left', { x: 0, y: 0, width: 1000, height: 800 }],
        ['main', { x: 1000, y: 0, width: 1000, height: 800 }],
      ],
    );
  });

  it('keeps only a proven primary screenshot when mixed-scale atlas mapping is unknown', () => {
    const snapshots = resolveCuaDisplaySnapshots({
      displays: [
        { id: 'main', bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2 },
        { id: 'side', bounds: { x: 1512, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
      ],
      primaryDisplayId: 'main',
      screenshotWidthPx: 3024,
      screenshotHeightPx: 1964,
    });
    assert.deepEqual(
      snapshots.map((display) => display.displayId),
      ['main'],
    );
  });

  it('fails closed when screenshot dimensions match neither atlas nor primary display', () => {
    assert.deepEqual(
      resolveCuaDisplaySnapshots({
        displays: [{ id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 2 }],
        primaryDisplayId: 1,
        screenshotWidthPx: 1200,
        screenshotHeightPx: 900,
      }),
      [],
    );
  });
});
