/**
 * Tests for the pure tool-row run→done seam mapping (#646). The subject lives in
 * `@maka/ui`; the test rides in the desktop workspace where node:test is wired,
 * like trow-summary.test.ts / materialize-turns.test.ts.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  isToolRowRunning,
  isToolRowSettled,
  deriveToolRowMotion,
  type ToolActivityItem,
} from '@maka/ui';

type Status = ToolActivityItem['status'];

const RUNNING: Status[] = ['pending', 'running', 'waiting_permission'];
const SETTLED: Status[] = ['completed', 'errored', 'interrupted'];

describe('tool-row run→done seam (#646)', () => {
  it('classifies pending / running / waiting_permission as running (shimmering)', () => {
    for (const status of RUNNING) {
      assert.equal(isToolRowRunning(status), true, `${status} is running-like`);
      assert.equal(isToolRowSettled(status), false, `${status} is not settled`);
    }
  });

  it('classifies completed / errored / interrupted as settled', () => {
    for (const status of SETTLED) {
      assert.equal(isToolRowSettled(status), true, `${status} is settled`);
      assert.equal(isToolRowRunning(status), false, `${status} does not shimmer`);
    }
  });

  it('shimmers while running regardless of whether it was ever running', () => {
    for (const status of RUNNING) {
      const motion = deriveToolRowMotion({ status, everRunning: true });
      assert.deepEqual(motion, { shimmer: true, settled: false, settling: false });
    }
  });

  it('plays the settle fade only for a row that was seen running in this view', () => {
    for (const status of SETTLED) {
      // A live run→done: the row was running, then settled → land it.
      assert.deepEqual(
        deriveToolRowMotion({ status, everRunning: true }),
        { shimmer: false, settled: true, settling: true },
        `${status} after a live run settles with a fade`,
      );
      // A replayed transcript row: mounted already terminal, never ran here →
      // stays static so loaded history does not fade in on scroll.
      assert.deepEqual(
        deriveToolRowMotion({ status, everRunning: false }),
        { shimmer: false, settled: true, settling: false },
        `${status} replayed from history does not fade`,
      );
    }
  });
});
