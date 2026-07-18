import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatToolResultContent } from '../pi-transcript-format.js';

test('keeps the pre-exposure agent swarm fallback bounded', () => {
  const output = formatToolResultContent({
    kind: 'agent_swarm',
    status: 'partial',
    items: [
      {
        itemId: 'auth',
        index: 0,
        profile: 'local_read',
        started: true,
        agentId: 'local-read',
        agentName: 'Local Read',
        turnId: 'turn-auth',
        runId: 'run-auth',
        status: 'completed',
        summary: 'Auth boundaries are documented.',
        artifactIds: ['artifact-auth'],
      },
      {
        itemId: 'storage',
        index: 1,
        profile: 'local_read',
        started: false,
        status: 'failed',
        summary: 'Storage inspection failed.',
        artifactIds: [],
      },
    ],
    startedAt: 10,
    completedAt: 20,
    durationMs: 10,
  });

  assert.equal(output, 'Agent swarm: partial');
  assert.doesNotMatch(
    output,
    /auth|storage|turn-auth|run-auth|artifact-auth|local-read/,
  );
});
