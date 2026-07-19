import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { latestInterruptedResumeTurnId } from '../../renderer/interrupted-resume.js';

describe('deriveAppShellTurnViewModel interrupted recovery', () => {
  it('offers safe resume only for the latest app-restarted failed turn', () => {
    const turnId = latestInterruptedResumeTurnId([
      { turnId: 'turn-1', status: 'failed', errorClass: 'app_restarted' },
    ]);

    assert.equal(turnId, 'turn-1');
  });

  it('removes the action after a later turn completes', () => {
    const turnId = latestInterruptedResumeTurnId([
      { turnId: 'turn-1', status: 'failed', errorClass: 'app_restarted' },
      { turnId: 'turn-2', status: 'completed' },
    ]);

    assert.equal(turnId, undefined);
  });
});
