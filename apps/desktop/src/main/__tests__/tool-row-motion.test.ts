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

});
