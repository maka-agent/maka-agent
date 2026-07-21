import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeAgentRunEvent } from '../agent-run.js';

test('AgentRun accepts provider request capture and attempt trace rows', () => {
  for (const type of ['provider_request_captured', 'provider_request_attempt_recorded']) {
    const decoded = decodeAgentRunEvent({
      type,
      id: `${type}-1`,
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      ts: 1,
      data: { traceId: 'provider-trace-1' },
    });
    assert.equal(decoded.type, type);
  }
});
