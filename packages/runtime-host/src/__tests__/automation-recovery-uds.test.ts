import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { RuntimeHostConnection } from '../client/index.js';
import type { AutomationProjection } from '../protocol/index.js';
import { connectClient, withExecutionRoot } from './support/execution-root-fixture.js';

test('fire admission without a Run recovers exactly one stable Automation Run', async () => {
  await withExecutionRoot(async (fixture) => {
    const seeded = await fixture.seedAutomationFire();
    const firstHost = await fixture.startHost();
    let client: RuntimeHostConnection | undefined;
    try {
      client = await connectClient(fixture.root, 'desktop');
      const automation = await waitForTerminalFire(client, seeded.automationId);
      assert.equal(automation.lastFire?.fireId, seeded.fireId);
      assert.equal(automation.lastFire?.status, 'succeeded');
      assert.equal(automation.currentFire, null);
    } finally {
      await client?.close();
      await fixture.stopHost(firstHost);
    }
    assert.deepEqual(await fixture.readTurnFootprint(seeded.turnId), {
      admitted: true,
      runCount: 1,
      userMessageCount: 1,
    });

    const successor = await fixture.startHost();
    await fixture.stopHost(successor);
    assert.deepEqual(await fixture.readTurnFootprint(seeded.turnId), {
      admitted: true,
      runCount: 1,
      userMessageCount: 1,
    });
  });
});

test('a Run interrupted after Automation admission settles outcome_unknown without replay', async () => {
  await withExecutionRoot(async (fixture) => {
    const seeded = await fixture.seedAutomationFire({ runStarted: true });
    const host = await fixture.startHost();
    let client: RuntimeHostConnection | undefined;
    try {
      client = await connectClient(fixture.root, 'tui');
      const result = await client.request('automation.query', {
        kind: 'get',
        automationId: seeded.automationId,
      });
      assert.equal(result.kind, 'item');
      if (result.kind !== 'item') assert.fail('Automation recovery did not return an item');
      assert.equal(result.automation.currentFire, null);
      assert.equal(result.automation.lastFire?.fireId, seeded.fireId);
      assert.equal(result.automation.lastFire?.status, 'outcome_unknown');
    } finally {
      await client?.close();
      await fixture.stopHost(host);
    }
    assert.deepEqual(await fixture.readTurnFootprint(seeded.turnId), {
      admitted: true,
      runCount: 1,
      userMessageCount: 1,
    });
    const ledger = await fixture.readTurn(seeded.turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.runs[0]?.runId, seeded.runId);
    assert.equal(ledger.runs[0]?.status, 'failed');
    assert.equal(ledger.runs[0]?.failureClass, 'app_restarted');
  });
});

async function waitForTerminalFire(
  client: RuntimeHostConnection,
  automationId: string,
): Promise<AutomationProjection> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await client.request('automation.query', { kind: 'get', automationId });
    if (result.kind === 'item' && result.automation.lastFire) return result.automation;
    await delay(25);
  }
  assert.fail('Recovered Automation fire did not settle');
}
