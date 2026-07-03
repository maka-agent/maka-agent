import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAsyncActionBoundary } from '../async-action-boundary.js';

test('runAsyncActionBoundary swallows action rejections and still settles local state', async () => {
  let settled = 0;

  await assert.doesNotReject(() =>
    runAsyncActionBoundary(
      () => Promise.reject(new Error('action failed')),
      () => {
        settled += 1;
      },
    ),
  );

  assert.equal(settled, 1);
});

test('runAsyncActionBoundary waits for fulfilled actions before settling', async () => {
  const events: string[] = [];

  await runAsyncActionBoundary(
    async () => {
      events.push('action');
    },
    () => {
      events.push('settled');
    },
  );

  assert.deepEqual(events, ['action', 'settled']);
});
