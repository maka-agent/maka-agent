import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

test('serializes operations for one Session', async () => {
  const gate = new SessionAdmissionGate();
  const entered = deferred();
  const release = deferred();
  const order: string[] = [];

  const first = gate.run('session', async () => {
    order.push('first:start');
    entered.resolve();
    await release.promise;
    order.push('first:end');
  });
  await entered.promise;
  const second = gate.run('session', () => {
    order.push('second');
  });

  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
});

test('does not serialize operations for different Sessions', async () => {
  const gate = new SessionAdmissionGate();
  const entered = deferred();
  const release = deferred();
  const first = gate.run('first', async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;

  assert.equal(await gate.run('second', () => 'completed'), 'completed');
  release.resolve();
  await first;
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
