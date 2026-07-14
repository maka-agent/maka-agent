import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BotStatus } from '@maka/runtime';
import { deriveBotStatusPersistenceUpdate } from '../bot-status-persistence.js';

function status(readiness: BotStatus['readiness'], reason?: string): BotStatus {
  return {
    platform: 'telegram',
    running: true,
    readiness,
    reason,
    connection: 'polling',
  };
}

describe('Bot status persistence', () => {
  it('persists a changed degraded reason without requiring a readiness transition', () => {
    const update = deriveBotStatusPersistenceUpdate(
      status('degraded', 'rate-limited'),
      status('degraded', 'send-failed'),
    );

    assert.match(update?.lastError ?? '', /发送失败/);
  });

  it('does not rewrite an unchanged degraded status', () => {
    assert.equal(
      deriveBotStatusPersistenceUpdate(
        status('degraded', 'send-failed'),
        status('degraded', 'send-failed'),
      ),
      undefined,
    );
  });

  it('clears the persisted error after recovery', () => {
    assert.deepEqual(
      deriveBotStatusPersistenceUpdate(
        status('degraded', 'send-failed'),
        status('operational'),
      ),
      { lastError: undefined },
    );
  });

  it('clears a persisted error when operational state is re-established after restart', () => {
    assert.deepEqual(
      deriveBotStatusPersistenceUpdate(
        status('credentials_valid'),
        status('operational'),
      ),
      { lastError: undefined },
    );
  });
});
