import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatToolResultContent } from '../pi-transcript-format.js';

test('formats an agent swarm with bounded child evidence references', () => {
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

  assert.equal(
    output,
    [
      'Agent swarm: partial · 2 items · 1 completed · 1 failed · 0 cancelled · 1 artifacts · 10ms',
      'auth: completed · local_read · 1 artifacts · run run-auth · turn turn-auth\nAuth boundaries are documented.',
      'storage: failed · local_read · 0 artifacts\nStorage inspection failed.',
    ].join('\n\n'),
  );
  assert.match(output, /run run-auth · turn turn-auth/);
  assert.doesNotMatch(output, /artifact-auth|local-read/);
});

test('bounds individual and aggregate agent swarm text', () => {
  const output = formatToolResultContent({
    kind: 'agent_swarm',
    status: 'completed',
    items: Array.from({ length: 32 }, (_, index) => ({
      itemId: `item-${index}`,
      index,
      profile: 'local_read',
      started: true,
      status: 'completed' as const,
      summary: 'x'.repeat(2_000),
      artifactIds: [],
    })),
    startedAt: 10,
    completedAt: 20,
    durationMs: 10,
  });

  assert.ok(output.length < 16_100);
  assert.match(output, /chars truncated/);
  assert.match(output, /item-0: completed/);
  assert.doesNotMatch(output, /item-31: completed/);
});
