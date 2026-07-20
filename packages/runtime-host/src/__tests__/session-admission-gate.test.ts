import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type SessionAdmissionLease,
  SessionAdmissionGate,
} from '../server/session-admission-gate.js';

test('operations for the same Session run serially', async () => {
  const gate = new SessionAdmissionGate();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const order: string[] = [];

  const first = gate.run('session', async () => {
    order.push('first:start');
    firstEntered.resolve();
    await releaseFirst.promise;
    order.push('first:end');
  });
  await withTimeout(firstEntered.promise, 1_000, 'first same-Session operation did not enter');
  const second = gate.run('session', () => {
    order.push('second:start');
  });

  releaseFirst.resolve();
  await withTimeout(
    Promise.all([first, second]),
    1_000,
    'same-Session operations did not complete serially',
  );
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
});

test('an explicitly admitted operation for the same Session does not deadlock', async () => {
  const gate = new SessionAdmissionGate();
  const order: string[] = [];

  await withTimeout(
    gate.run('session', async (lease) => {
      order.push('outer:start');
      await gate.runAdmitted('session', lease, async () => {
        await Promise.resolve();
        order.push('inner');
      });
      order.push('outer:end');
    }),
    1_000,
    'reentrant Session operation did not complete',
  );
  assert.deepEqual(order, ['outer:start', 'inner', 'outer:end']);
});

test('awaited same-Session run nesting fails fast', async () => {
  const gate = new SessionAdmissionGate();

  await assert.rejects(
    withTimeout(
      gate.run('session', () => gate.run('session', () => undefined)),
      1_000,
      'awaited same-Session nesting did not fail fast',
    ),
    /Cannot call Session admission run from an active admission/,
  );
});

test('an implicit same-Session descendant is rejected instead of queued', async () => {
  const gate = new SessionAdmissionGate();
  let descendant: Promise<void> | undefined;
  let descendantRan = false;

  await gate.run('session', () => {
    descendant = gate.run('session', () => {
      descendantRan = true;
    });
    void descendant.catch(() => undefined);
  });
  assert.ok(descendant);
  await assert.rejects(
    withTimeout(descendant, 1_000, 'implicit same-Session descendant did not fail fast'),
    /Cannot call Session admission run from an active admission/,
  );
  assert.equal(descendantRan, false);
  await gate.run('session', () => undefined);
});

test('the Session tail waits for an unawaited admitted task', async () => {
  const gate = new SessionAdmissionGate();
  const admittedTaskEntered = deferred();
  const releaseAdmittedTask = deferred();
  const outerCallbackFinished = deferred();
  const order: string[] = [];

  const outer = gate.run('session', (lease) => {
    void gate.runAdmitted('session', lease, async () => {
      order.push('admitted:start');
      admittedTaskEntered.resolve();
      await releaseAdmittedTask.promise;
      order.push('admitted:end');
    });
    order.push('outer:end');
    outerCallbackFinished.resolve();
  });
  await withTimeout(
    Promise.all([admittedTaskEntered.promise, outerCallbackFinished.promise]),
    1_000,
    'outer admission did not register its task',
  );

  const subsequent = gate.run('session', () => {
    order.push('subsequent');
  });
  await withTimeout(
    gate.run('independent-session', () => undefined),
    1_000,
    'independent Session operation did not complete',
  );
  assert.deepEqual(order, ['admitted:start', 'outer:end']);

  releaseAdmittedTask.resolve();
  await withTimeout(
    Promise.all([outer, subsequent]),
    1_000,
    'Session tail did not advance after the admitted task settled',
  );
  assert.deepEqual(order, ['admitted:start', 'outer:end', 'admitted:end', 'subsequent']);
});

test('unawaited admitted task failures are preserved by the admission', async () => {
  const gate = new SessionAdmissionGate();
  const failure = new Error('canonical refresh failed');

  await assert.rejects(
    gate.run('session', (lease) => {
      void gate.runAdmitted('session', lease, () => {
        throw failure;
      });
    }),
    (error) => error === failure,
  );

  const operationFailure = new Error('operation failed');
  const taskFailure = new Error('publication failed');
  await assert.rejects(
    gate.run('session', (lease) => {
      void gate.runAdmitted('session', lease, () => {
        throw taskFailure;
      });
      throw operationFailure;
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors.includes(operationFailure) &&
      error.errors.includes(taskFailure),
  );

  const sharedFailure = new Error('shared task failure');
  await assert.rejects(
    gate.run('session', (lease) => {
      for (let index = 0; index < 2; index += 1) {
        void gate.runAdmitted('session', lease, () => {
          throw sharedFailure;
        });
      }
    }),
    (error) => error === sharedFailure,
  );
});

test('a Session admission lease is bound to its gate, Session, and callback', async () => {
  const gate = new SessionAdmissionGate();
  const otherGate = new SessionAdmissionGate();
  const leaseCapture: {
    current: { kind: 'pending' } | { kind: 'captured'; lease: SessionAdmissionLease };
  } = { current: { kind: 'pending' } };

  await gate.run('session', (lease) => {
    leaseCapture.current = { kind: 'captured', lease };
    assert.throws(
      () => otherGate.runAdmitted('session', lease, () => undefined),
      /was not issued by this gate/,
    );
    assert.throws(
      () => gate.runAdmitted('other-session', lease, () => undefined),
      /does not match the Session/,
    );
  });
  const expiredLease = leaseCapture.current;
  if (expiredLease.kind !== 'captured') {
    assert.fail('Session admission lease was not captured');
  }
  assert.throws(
    () => gate.runAdmitted('session', expiredLease.lease, () => undefined),
    /was not issued by this gate|no longer accepts tasks/,
  );
});

test('nested admission for another Session fails fast', async () => {
  const gate = new SessionAdmissionGate();

  await assert.rejects(
    withTimeout(
      gate.run('first-session', () => gate.run('second-session', () => undefined)),
      1_000,
      'cross-Session admission did not fail fast',
    ),
    /Cannot call Session admission run from an active admission/,
  );
});

test('an operation for another Session is not blocked', async () => {
  const gate = new SessionAdmissionGate();
  const firstEntered = deferred();
  const releaseFirst = deferred();

  const first = gate.run('first-session', async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
  });
  await withTimeout(firstEntered.promise, 1_000, 'first Session operation did not enter');

  try {
    assert.equal(
      await withTimeout(
        gate.run('second-session', () => 'completed'),
        1_000,
        'operation for another Session was blocked',
      ),
      'completed',
    );
  } finally {
    releaseFirst.resolve();
    await withTimeout(first, 1_000, 'first Session operation did not complete');
  }
});

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
