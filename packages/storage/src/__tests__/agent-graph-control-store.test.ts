import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION } from '@maka/core/agent-graph-control';
import {
  AGENT_GRAPH_INTENT_CLAIMS_JSONL_PATH,
  createAgentGraphControlStore,
} from '../agent-graph-control-store.js';

describe('AgentGraphControlStore', () => {
  test('mirrors authoritative SQLite claims to durable JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-graph-control-'));
    try {
      const store = createAgentGraphControlStore(root, { now: () => 42 });
      const result = await store.claimAgentGraphIntent(request());
      store.close();

      assert.equal(result.created, true);
      const lines = (await readFile(join(root, AGENT_GRAPH_INTENT_CLAIMS_JSONL_PATH), 'utf8'))
        .trim()
        .split('\n');
      assert.deepEqual(
        lines.map((line) => JSON.parse(line)),
        [result.claim],
      );

      const reopened = createAgentGraphControlStore(root);
      try {
        assert.deepEqual(
          await reopened.readAgentGraphIntentClaim('graph-1', request().intentId),
          result.claim,
        );
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('repairs only from SQLite after a crash before the JSONL append', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-graph-control-repair-'));
    try {
      const crashing = createAgentGraphControlStore(root, {
        now: () => 42,
        failpoint(point) {
          if (point === 'after_sqlite_intent_claim') throw new Error('crash');
        },
      });
      await assert.rejects(crashing.claimAgentGraphIntent(request()), /crash/);
      crashing.close();

      const reopened = createAgentGraphControlStore(root);
      try {
        const claims = await reopened.listAgentGraphIntentClaims();
        assert.equal(claims.length, 1);
        assert.deepEqual(
          JSON.parse(
            (await readFile(join(root, AGENT_GRAPH_INTENT_CLAIMS_JSONL_PATH), 'utf8')).trim(),
          ),
          claims[0],
        );
      } finally {
        reopened.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('never rebuilds a missing SQLite authority from JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-graph-control-no-fallback-'));
    const path = join(root, AGENT_GRAPH_INTENT_CLAIMS_JSONL_PATH);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ ...request(), claimedAt: 42 })}\n`, 'utf8');
      assert.throws(
        () => createAgentGraphControlStore(root),
        /SQLite authority is missing; JSONL audit records cannot rebuild it/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function request() {
  return {
    schemaVersion: AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION,
    claimId: `graph_claim_${'a'.repeat(32)}`,
    graphId: 'graph-1',
    intentId: `graph_intent_${'b'.repeat(32)}`,
    intentFingerprint: `sha256:${'c'.repeat(64)}`,
    readinessContextFingerprint: `sha256:${'d'.repeat(64)}`,
    targetOperatorId: 'summarizer',
    targetSessionId: 'session-child',
    targetTurnId: 'turn-next',
    targetRunId: 'run-next',
  };
}
