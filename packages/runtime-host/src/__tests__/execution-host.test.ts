import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { FAKE_ASK_USER_QUESTION_PROMPT } from '@maka/runtime';
import {
  RuntimeHostOperationError,
  RuntimeHostSubscriptionError,
  type RuntimeHostSessionSubscription,
} from '../client/index.js';
import {
  type InteractionAnswer,
  type InteractionPendingSnapshot,
  type SessionProjectionFrame,
  type TurnSnapshot,
} from '../protocol/index.js';
import {
  connectClient,
  PROCESS_TIMEOUT_MS,
  sendRequestWithoutReadingResponse,
  waitForTerminalTurn,
  waitForTurn,
  withExecutionRoot,
  withTimeout,
} from './support/execution-root-fixture.js';

test('subscription.open is observational for the durable Session header', async () => {
  await withExecutionRoot(async (fixture) => {
    await fixture.seedUnlockedUserMessage();
    const host = await fixture.startHost();
    const sessionPath = fixture.sessionPath();
    await utimes(sessionPath, new Date(1_000), new Date(1_000));
    const beforeBytes = await readFile(sessionPath);
    const beforeStat = await stat(sessionPath, { bigint: true });
    const header = JSON.parse(beforeBytes.toString('utf8').split('\n')[0] ?? 'null') as {
      connectionLocked?: unknown;
    };
    assert.equal(header.connectionLocked, false);

    const client = await connectClient(fixture.root, 'desktop');
    const subscription = await client.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    assert.equal(subscription.snapshot.session.sessionId, fixture.sessionId);
    await subscription.close();

    assert.deepEqual(await readFile(sessionPath), beforeBytes);
    assert.equal((await stat(sessionPath, { bigint: true })).mtimeNs, beforeStat.mtimeNs);
    await client.close();
    await fixture.stopHost(host);
  });
});

test('publishes the durable running projection before a controlled first event', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const subscription = await client.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    const iterator = subscription[Symbol.asyncIterator]();
    const turnId = randomUUID();
    const start = client.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });

    let running: TurnSnapshot | undefined;
    while (!running) {
      const next = await withTimeout(
        iterator.next(),
        PROCESS_TIMEOUT_MS,
        'running Session projection was not published',
      );
      assert.equal(next.done, false);
      if (next.done) break;
      assert.equal(next.value.kind, 'subscription.session_projection');
      if (next.value.kind !== 'subscription.session_projection') continue;
      const rootTurn = next.value.snapshot.rootTurn;
      if (rootTurn?.turnId !== turnId) continue;
      assert.notEqual(rootTurn.status, 'waiting_permission');
      if (rootTurn.status === 'running') running = rootTurn;
    }

    const started = await start;
    assert.equal(running?.runId, started.runId);
    await client.stopTurn(
      {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.runId,
      },
      PROCESS_TIMEOUT_MS,
    );
    await subscription.close();
    await client.close();
    await fixture.stopHost(host);
  });
});

test('keeps same-millisecond root admissions in durable predecessor order live and after recovery', {
  skip: process.platform === 'win32' ? 'POSIX process death gate' : false,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const admittedAt = 1_900_000_000_000;
    const firstTurnId = 'turn-z';
    const secondTurnId = 'turn-a';
    const firstHost = await fixture.startHost({ frozenNow: admittedAt });
    const client = await connectClient(fixture.root, 'desktop');
    const subscription = await client.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    assert.equal(subscription.snapshot.rootTurn, null);
    const iterator = subscription[Symbol.asyncIterator]();
    await client.startTurn({
      sessionId: fixture.sessionId,
      turnId: firstTurnId,
      text: 'first root turn',
    });
    let firstTerminal: TurnSnapshot | undefined;
    while (!firstTerminal) {
      const next = await withTimeout(
        iterator.next(),
        PROCESS_TIMEOUT_MS,
        'first root Turn did not publish a terminal projection',
      );
      if (next.done) {
        throw new Error('Session subscription closed before terminal projection');
      }
      if (next.value.kind !== 'subscription.session_projection') continue;
      const rootTurn = next.value.snapshot.rootTurn;
      if (
        rootTurn?.turnId === firstTurnId &&
        (rootTurn.status === 'completed' ||
          rootTurn.status === 'failed' ||
          rootTurn.status === 'cancelled')
      ) {
        firstTerminal = rootTurn;
      }
    }

    const secondStarted = await client.startTurn({
      sessionId: fixture.sessionId,
      turnId: secondTurnId,
      text: 'second root turn',
    });
    let liveSecond: TurnSnapshot | undefined;
    while (!liveSecond) {
      const next = await withTimeout(
        iterator.next(),
        PROCESS_TIMEOUT_MS,
        'later same-millisecond root Turn was not projected live',
      );
      assert.equal(next.done, false);
      if (next.done) break;
      if (next.value.kind !== 'subscription.session_projection') continue;
      const rootTurn = next.value.snapshot.rootTurn;
      if (rootTurn?.turnId === secondTurnId) liveSecond = rootTurn;
    }
    assert.equal(liveSecond?.runId, secondStarted.runId);
    const secondTerminal = await waitForTerminalTurn(client, fixture.sessionId, secondTurnId);

    assert.deepEqual(
      await client.startTurn({
        sessionId: fixture.sessionId,
        turnId: firstTurnId,
        text: 'first root turn',
      }),
      firstTerminal,
    );
    const stillLatest = await client.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    assert.deepEqual(stillLatest.snapshot.rootTurn, secondTerminal);
    await stillLatest.close();
    await subscription.close();

    const firstAdmission = JSON.parse(
      await readFile(fixture.admissionPath(firstTurnId), 'utf8'),
    ) as { admittedAt: number; previousRootTurnId: string | null };
    const secondAdmission = JSON.parse(
      await readFile(fixture.admissionPath(secondTurnId), 'utf8'),
    ) as { admittedAt: number; previousRootTurnId: string | null };
    assert.equal(firstAdmission.admittedAt, admittedAt);
    assert.equal(secondAdmission.admittedAt, admittedAt);
    assert.equal(firstAdmission.previousRootTurnId, null);
    assert.equal(secondAdmission.previousRootTurnId, firstTurnId);

    await fixture.killHost(firstHost);
    await client.closed;
    const successor = await fixture.startHost();
    assert.notEqual(successor.hostEpoch, firstHost.hostEpoch);
    const observer = await connectClient(fixture.root, 'tui');
    const recovered = await observer.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    assert.deepEqual(recovered.snapshot.rootTurn, secondTerminal);
    assert.deepEqual(
      recovered.snapshot.rootTurn,
      await observer.queryTurn({
        sessionId: fixture.sessionId,
        turnId: secondTurnId,
      }),
    );
    await recovered.close();
    await observer.close();
    await fixture.stopHost(successor);
  });
});

test('reopens a canonical Session snapshot after the subscribing Client disconnects', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const second = await connectClient(fixture.root, 'tui');
    const firstSubscription = await first.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    const secondSubscription = await second.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    assert.notEqual(firstSubscription.subscriptionId, secondSubscription.subscriptionId);
    assert.equal(firstSubscription.snapshot.session.sessionId, fixture.sessionId);
    assert.equal(firstSubscription.snapshot.rootTurn, null);
    assert.deepEqual(secondSubscription.snapshot, firstSubscription.snapshot);

    const turnId = randomUUID();
    const started = await first.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    await first.close();
    await assert.rejects(
      () => firstSubscription[Symbol.asyncIterator]().next(),
      (error: unknown) =>
        error instanceof RuntimeHostSubscriptionError && error.reason === 'connection_closed',
    );

    const stopped = await second.stopTurn(
      {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.runId,
      },
      PROCESS_TIMEOUT_MS,
    );
    assert.equal(stopped.status, 'cancelled');
    const iterator = secondSubscription[Symbol.asyncIterator]();
    let expectedSequence = 1;
    let terminalFrame: SessionProjectionFrame | undefined;
    while (!terminalFrame) {
      const next = await withTimeout(
        iterator.next(),
        PROCESS_TIMEOUT_MS,
        'surviving Client did not receive the terminal projection',
      );
      assert.equal(next.done, false);
      if (next.done) break;
      assert.equal(next.value.sequence, expectedSequence);
      expectedSequence += 1;
      if (
        next.value.kind === 'subscription.session_projection' &&
        next.value.snapshot.rootTurn?.status === 'cancelled'
      ) {
        terminalFrame = next.value;
      }
    }
    assert.ok(terminalFrame?.kind === 'subscription.session_projection');
    if (terminalFrame?.kind === 'subscription.session_projection') {
      assert.deepEqual(terminalFrame.snapshot.rootTurn, stopped);
      assert.equal(terminalFrame.hostEpoch, host.hostEpoch);
      assert.ok(
        terminalFrame.snapshot.projectionRevision > secondSubscription.snapshot.projectionRevision,
      );
    }
    await secondSubscription.close();

    const terminal = await second.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    assert.deepEqual(terminal.snapshot.rootTurn, stopped);
    assert.equal(terminal.snapshot.projectionRevision, 1);
    await terminal.close();
    await second.close();
    await fixture.stopHost(host);
  });
});

test('live subscription reads do not perform root admission recovery cleanup', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();
    const started = await client.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    const stagingPath = fixture.admissionStagingPath(randomUUID());
    await writeFile(stagingPath, 'in-flight admission');

    const subscription = await client.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    assert.equal(await readFile(stagingPath, 'utf8'), 'in-flight admission');

    await client.stopTurn({
      sessionId: fixture.sessionId,
      turnId,
      runId: started.runId,
    });
    await subscription.close();
    await client.close();
    await fixture.stopHost(host);
  });
});

test('keeps a concurrent snapshot and live cut gap-free and converges on the durable terminal fact', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();
    const inputText = 'continuity-cut '.repeat(24);
    const expectedText =
      `Fake backend received: ${inputText}` +
      '\n\nThis proves the session stream, JSONL storage, and renderer loop are connected.';

    const [started, subscription] = await Promise.all([
      client.startTurn({
        sessionId: fixture.sessionId,
        turnId,
        text: inputText,
      }),
      client.openSessionSubscription({ sessionId: fixture.sessionId }),
    ]);
    const iterator = subscription[Symbol.asyncIterator]();
    let expectedSequence = 1;
    let projectionRevision = subscription.snapshot.projectionRevision;
    let liveText = '';
    let terminalSnapshot: TurnSnapshot | null = null;
    while (!terminalSnapshot) {
      const next = await withTimeout(
        iterator.next(),
        PROCESS_TIMEOUT_MS,
        'Session subscription did not converge',
      );
      assert.equal(next.done, false);
      if (next.done) break;
      assert.equal(next.value.sequence, expectedSequence);
      expectedSequence += 1;
      if (next.value.kind === 'subscription.session_delta') {
        assert.equal(next.value.sessionId, fixture.sessionId);
        assert.equal(next.value.delta.turnId, turnId);
        assert.equal(next.value.delta.runId, started.runId);
        assert.equal(next.value.delta.kind, 'text');
        liveText += next.value.delta.text;
        continue;
      }
      if (next.value.kind === 'subscription.session_projection') {
        assert.ok(next.value.snapshot.projectionRevision > projectionRevision);
        projectionRevision = next.value.snapshot.projectionRevision;
        const rootTurn = next.value.snapshot.rootTurn;
        if (
          rootTurn?.status === 'completed' ||
          rootTurn?.status === 'failed' ||
          rootTurn?.status === 'cancelled'
        ) {
          terminalSnapshot = rootTurn;
        }
      }
    }

    assert.ok(liveText.length > 0);
    assert.ok(expectedText.endsWith(liveText));
    assert.deepEqual(
      terminalSnapshot,
      await client.queryTurn({ sessionId: fixture.sessionId, turnId }),
    );
    await subscription.close();
    await client.close();
    await fixture.stopHost(host);
  });
});

test('two Clients share one execution after the starting Client disconnects', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const second = await connectClient(fixture.root, 'tui');
    const turnId = randomUUID();

    const started = await first.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    assert.equal(started.turnId, turnId);
    await assert.rejects(
      () =>
        second.startTurn({
          sessionId: fixture.sessionId,
          turnId: randomUUID(),
          text: 'must stay busy',
        }),
      operationError('session_busy'),
    );

    await first.close();
    const observed = await second.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(observed.runId, started.runId);
    assert.ok(observed.status === 'running' || observed.status === 'waiting_permission');
    const stopped = await second.stopTurn(
      {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.runId,
      },
      PROCESS_TIMEOUT_MS,
    );
    assert.equal(stopped.status, 'cancelled');

    const nextTurnId = randomUUID();
    const next = await second.startTurn({
      sessionId: fixture.sessionId,
      turnId: nextTurnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    assert.deepEqual(
      await second.startTurn({
        sessionId: fixture.sessionId,
        turnId,
        text: FAKE_ASK_USER_QUESTION_PROMPT,
      }),
      stopped,
    );
    assert.deepEqual(
      await second.stopTurn({
        sessionId: fixture.sessionId,
        turnId,
        runId: started.runId,
      }),
      stopped,
    );
    const nextObserved = await second.queryTurn({
      sessionId: fixture.sessionId,
      turnId: nextTurnId,
    });
    assert.equal(nextObserved.runId, next.runId);
    assert.ok(nextObserved.status === 'running' || nextObserved.status === 'waiting_permission');
    await second.stopTurn(
      {
        sessionId: fixture.sessionId,
        turnId: nextTurnId,
        runId: next.runId,
      },
      PROCESS_TIMEOUT_MS,
    );
    await second.close();
    await fixture.stopHost(host);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.terminalEvents.length, 1);
    assert.equal(ledger.classification.kind, 'fact');
    if (ledger.classification.kind === 'fact') {
      assert.equal(ledger.classification.fact.runStatus, 'cancelled');
      assert.notEqual(ledger.classification.fact.failureClass, 'app_restarted');
    }
  });
});

test('an archived Session rejects a new Turn before durable admission', async () => {
  await withExecutionRoot(async (fixture) => {
    await fixture.archiveSession();
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();

    await assert.rejects(
      () =>
        client.startTurn({
          sessionId: fixture.sessionId,
          turnId,
          text: 'must not execute',
        }),
      operationError('session_archived'),
    );
    assert.equal((await client.status()).state, 'ready');
    await client.close();
    await fixture.stopHost(host);

    assert.deepEqual(await fixture.readTurnFootprint(turnId), {
      admitted: false,
      runCount: 0,
      userMessageCount: 0,
    });
  });
});

test('a killed Host is recovered exactly once before its successor becomes ready', {
  skip: process.platform === 'win32' ? 'POSIX process death gate' : false,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const firstSubscription = await first.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    const firstIterator = firstSubscription[Symbol.asyncIterator]();
    const turnId = randomUUID();
    const started = await first.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    const observedBeforeCrash = await withTimeout(
      firstIterator.next(),
      PROCESS_TIMEOUT_MS,
      'old Host subscription did not publish before SIGKILL',
    );
    assert.equal(observedBeforeCrash.done, false);

    await fixture.killHost(firstHost);
    await first.closed;
    await assert.rejects(
      () => firstIterator.next(),
      (error: unknown) =>
        error instanceof RuntimeHostSubscriptionError && error.reason === 'connection_closed',
    );
    const secondHost = await fixture.startHost();
    assert.notEqual(secondHost.hostEpoch, firstHost.hostEpoch);
    const second = await connectClient(fixture.root, 'tui');
    const secondSubscription = await second.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    assert.equal(secondSubscription.hostEpoch, secondHost.hostEpoch);
    const recovered = await second.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.status, 'failed');
    if (recovered.status === 'failed') assert.equal(recovered.failureClass, 'app_restarted');
    assert.deepEqual(secondSubscription.snapshot.rootTurn, recovered);

    const successorIterator = secondSubscription[Symbol.asyncIterator]();
    const successorTurnId = randomUUID();
    const successorStarted = await second.startTurn({
      sessionId: fixture.sessionId,
      turnId: successorTurnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    const successorFirstFrame = await withTimeout(
      successorIterator.next(),
      PROCESS_TIMEOUT_MS,
      'successor Host did not publish a live projection',
    );
    assert.equal(successorFirstFrame.done, false);
    if (!successorFirstFrame.done) {
      assert.equal(successorFirstFrame.value.hostEpoch, secondHost.hostEpoch);
      assert.equal(successorFirstFrame.value.sequence, 1);
      assert.equal(successorFirstFrame.value.kind, 'subscription.session_projection');
      if (successorFirstFrame.value.kind === 'subscription.session_projection') {
        assert.equal(successorFirstFrame.value.snapshot.rootTurn?.turnId, successorTurnId);
      }
    }
    await second.stopTurn(
      {
        sessionId: fixture.sessionId,
        turnId: successorTurnId,
        runId: successorStarted.runId,
      },
      PROCESS_TIMEOUT_MS,
    );
    await secondSubscription.close();
    await second.close();
    await fixture.stopHost(secondHost);

    const thirdHost = await fixture.startHost();
    const third = await connectClient(fixture.root, 'run');
    const stable = await third.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.deepEqual(stable, recovered);
    assert.equal(stable.runId, started.runId);
    await third.close();
    await fixture.stopHost(thirdHost);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.terminalEvents.length, 1);
    assert.equal(ledger.classification.kind, 'fact');
    if (ledger.classification.kind === 'fact') {
      assert.equal(ledger.classification.fact.failureClass, 'app_restarted');
    }
  });
});

test('graceful Host shutdown stops and drains an active Turn before releasing ownership', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();
    const started = await client.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });

    await fixture.stopHost(host);
    await client.closed;

    const successor = await fixture.startHost();
    const observer = await connectClient(fixture.root, 'tui');
    const stable = await observer.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(stable.runId, started.runId);
    assert.equal(stable.status, 'cancelled');
    await observer.close();
    await fixture.stopHost(successor);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.terminalEvents.length, 1);
    assert.equal(ledger.classification.kind, 'fact');
    if (ledger.classification.kind === 'fact') {
      assert.equal(ledger.classification.fact.runStatus, 'cancelled');
      assert.notEqual(ledger.classification.fact.failureClass, 'app_restarted');
    }
  });
});

test('a durable admission without a Run resumes before the Host becomes ready', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const { runId } = await fixture.seedAdmission(turnId, FAKE_ASK_USER_QUESTION_PROMPT);
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'tui');

    const recovered = await client.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.runId, runId);
    assert.ok(recovered.status === 'running' || recovered.status === 'waiting_permission');
    await assert.rejects(
      () =>
        client.startTurn({
          sessionId: fixture.sessionId,
          turnId: randomUUID(),
          text: 'must remain behind the recovered admission',
        }),
      operationError('session_busy'),
    );
    const stopped = await client.stopTurn(
      {
        sessionId: fixture.sessionId,
        turnId,
        runId,
      },
      PROCESS_TIMEOUT_MS,
    );
    assert.equal(stopped.status, 'cancelled');
    await client.close();
    await fixture.stopHost(host);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.terminalEvents.length, 1);
    assert.equal(ledger.classification.kind, 'fact');
    if (ledger.classification.kind === 'fact') {
      assert.notEqual(ledger.classification.fact.failureClass, 'app_restarted');
    }
  });
});

test('startup recovery restores the admitted UserMessage before terminalizing its Run', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const { runId, userMessageId } = await fixture.seedRunWithoutUserMessage(
      turnId,
      'recover the admitted message',
    );
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'tui');

    const recovered = await client.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.runId, runId);
    assert.equal(recovered.status, 'failed');
    if (recovered.status === 'failed') {
      assert.equal(recovered.failureClass, 'app_restarted');
    }
    await client.close();
    await fixture.stopHost(host);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.userMessages[0]?.id, userMessageId);
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

test('startup recovery repairs a truncated RuntimeEvent tail before terminalizing the Run', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const { runId } = await fixture.seedRunWithoutUserMessage(
      turnId,
      'recover after a partial RuntimeEvent write',
    );
    const runtimeEventsPath = fixture.runtimeEventsPath(runId);
    await writeFile(runtimeEventsPath, '{"id":"truncated"', 'utf8');

    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'tui');
    const recovered = await client.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.status, 'failed');
    if (recovered.status === 'failed') {
      assert.equal(recovered.failureClass, 'app_restarted');
    }
    await client.close();
    await fixture.stopHost(host);

    const bytes = await readFile(runtimeEventsPath, 'utf8');
    assert.doesNotMatch(bytes, /truncated/);
    assertJsonLines(bytes);
    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

test('startup recovery fails closed on a complete malformed RuntimeEvent record', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const { runId } = await fixture.seedRunWithoutUserMessage(
      turnId,
      'do not recover across durable corruption',
    );
    const runtimeEventsPath = fixture.runtimeEventsPath(runId);
    const malformed = '{"id":"malformed"\n';
    await writeFile(runtimeEventsPath, malformed, 'utf8');

    await fixture.expectHostStartupFailure();
    assert.equal(await readFile(runtimeEventsPath, 'utf8'), malformed);
    await fixture.assertOwnerAvailable();
  });
});

test('startup recovery fails closed on a complete malformed Session record', async () => {
  await withExecutionRoot(async (fixture) => {
    await fixture.seedRunWithoutUserMessage(
      randomUUID(),
      'do not rewrite durable Session corruption',
    );
    const sessionPath = fixture.sessionPath();
    const malformed = '{"type":"user"\n';
    await appendFile(sessionPath, malformed, 'utf8');
    const expected = await readFile(sessionPath, 'utf8');

    await fixture.expectHostStartupFailure();
    assert.equal(await readFile(sessionPath, 'utf8'), expected);
    await fixture.assertOwnerAvailable();
  });
});

test('startup recovery fails closed on a complete malformed AgentRun record', async () => {
  await withExecutionRoot(async (fixture) => {
    const { runId } = await fixture.seedRunWithoutUserMessage(
      randomUUID(),
      'do not recover across durable AgentRun corruption',
    );
    const eventsPath = fixture.eventsPath(runId);
    const malformed = '{"type":"run_started"\n';
    await writeFile(eventsPath, malformed, 'utf8');

    await fixture.expectHostStartupFailure();
    assert.equal(await readFile(eventsPath, 'utf8'), malformed);
    await fixture.assertOwnerAvailable();
  });
});

test('a pre-start durability failure rejects turn.start and drains the Host', {
  skip:
    process.platform === 'win32' || process.getuid?.() === 0 ? 'POSIX file-permission gate' : false,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const turnId = randomUUID();
    const sessionPath = fixture.sessionPath();
    await chmod(sessionPath, 0o400);
    try {
      await assert.rejects(
        () =>
          client.startTurn({
            sessionId: fixture.sessionId,
            turnId,
            text: 'fail before the durable start barrier',
          }),
        operationError('internal_failure'),
      );
      await client.closed;
      await fixture.waitForHostExit(host);
    } finally {
      await chmod(sessionPath, 0o600);
    }

    const successor = await fixture.startHost();
    const observer = await connectClient(fixture.root, 'tui');
    const recovered = await observer.queryTurn({
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(recovered.status, 'failed');
    await observer.close();
    await fixture.stopHost(successor);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

test('retry after a discarded turn.start response reuses the durable semantic admission', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const turnId = randomUUID();
    const text = 'response loss must not duplicate this Turn';
    const dropped = await sendRequestWithoutReadingResponse(host.endpoint, 'turn.start', {
      sessionId: fixture.sessionId,
      turnId,
      text,
    });
    const observer = await connectClient(fixture.root, 'tui');
    const committed = await waitForTurn(observer, fixture.sessionId, turnId);
    dropped.destroy();

    const retried = await observer.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text,
    });
    assert.equal(retried.runId, committed.runId);
    await assert.rejects(
      () =>
        observer.startTurn({
          sessionId: fixture.sessionId,
          turnId,
          text: `${text} changed`,
        }),
      operationError('operation_conflict'),
    );
    const terminal = await waitForTerminalTurn(observer, fixture.sessionId, turnId);
    assert.equal(terminal.status, 'completed');
    await observer.close();
    await fixture.stopHost(host);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

test('two Clients arbitrate one per-Run Interaction winner', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const second = await connectClient(fixture.root, 'tui');
    const subscription = await first.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    const turnId = randomUUID();
    const started = await first.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    const pending = await waitForPendingInteraction(subscription, turnId);
    assert.equal(pending.runId, started.runId);

    const firstAnswer = questionAnswer('邀请制', '本周', '是');
    const secondAnswer = questionAnswer('公开测试', '下周', '否');
    const attempts = await Promise.allSettled([
      first.request('interaction.answer', {
        interactionId: pending.interactionId,
        answer: firstAnswer,
      }),
      second.request('interaction.answer', {
        interactionId: pending.interactionId,
        answer: secondAnswer,
      }),
    ]);
    const winner = attempts.find(
      (
        attempt,
      ): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<typeof first.request<'interaction.answer'>>>
      > => attempt.status === 'fulfilled',
    );
    const loser = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
    );
    assert.ok(winner);
    assert.ok(loser);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.ok(
      loser.reason instanceof RuntimeHostOperationError && loser.reason.code === 'already_resolved',
    );

    const canonical = await second.request('interaction.query', {
      sessionId: fixture.sessionId,
      interactionId: pending.interactionId,
    });
    assert.deepEqual(canonical, winner.value);
    assert.equal((await waitForTerminalTurn(first, fixture.sessionId, turnId)).status, 'completed');
    await subscription.close();
    await first.close();
    await second.close();
    await fixture.stopHost(host);
  });
});

test('a Store-first retry returns the durable answer after response loss', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const observer = await connectClient(fixture.root, 'tui');
    const subscription = await observer.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    const turnId = randomUUID();
    await observer.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    const pending = await waitForPendingInteraction(subscription, turnId);
    const answer = questionAnswer('邀请制', '下周', '是');
    const dropped = await sendRequestWithoutReadingResponse(host.endpoint, 'interaction.answer', {
      interactionId: pending.interactionId,
      answer,
    });
    await waitForInteractionRemoval(subscription, pending.interactionId);
    dropped.destroy();

    const canonical = await observer.request('interaction.query', {
      sessionId: fixture.sessionId,
      interactionId: pending.interactionId,
    });
    assert.equal(canonical.status, 'answered');
    const retried = await observer.request('interaction.answer', {
      interactionId: pending.interactionId,
      answer,
    });
    assert.deepEqual(retried, canonical);
    assert.equal(
      (await waitForTerminalTurn(observer, fixture.sessionId, turnId)).status,
      'completed',
    );
    await subscription.close();
    await observer.close();
    await fixture.stopHost(host);
  });
});

test('SIGTERM gracefully closes an active Interaction', {
  skip: process.platform === 'win32' ? 'POSIX signal gate' : false,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const subscription = await client.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    const turnId = randomUUID();
    await client.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    await waitForPendingInteraction(subscription, turnId);

    await fixture.stopHost(host);
    assert.equal(host.child.exitCode, 0);
    assert.equal(host.child.signalCode, null);
    await client.closed;
    await fixture.assertOwnerAvailable();
  });
});

test('SIGKILL successor closes a pending Interaction as host_restarted', {
  skip: process.platform === 'win32' ? 'POSIX process death gate' : false,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const subscription = await first.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    const turnId = randomUUID();
    await first.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      text: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    const pending = await waitForPendingInteraction(subscription, turnId);

    await fixture.killHost(firstHost);
    await first.closed;
    const successor = await fixture.startHost();
    const observer = await connectClient(fixture.root, 'tui');
    const recovered = await observer.request('interaction.query', {
      sessionId: fixture.sessionId,
      interactionId: pending.interactionId,
    });
    assert.equal(recovered.status, 'closed');
    if (recovered.status === 'closed') {
      assert.equal(recovered.outcome.reason, 'host_restarted');
    }
    const turn = await observer.queryTurn({ sessionId: fixture.sessionId, turnId });
    assert.equal(turn.status, 'failed');
    if (turn.status === 'failed') assert.equal(turn.failureClass, 'app_restarted');
    await observer.close();
    await fixture.stopHost(successor);
  });
});

test('root prepare failure leaves an inherited Interaction pending', async () => {
  await withExecutionRoot(async (fixture) => {
    const request = await fixture.seedPendingQuestion({
      turnId: randomUUID(),
      runId: randomUUID(),
    });
    await appendFile(fixture.sessionPath(), '{"type":"corrupt"\n', 'utf8');

    await fixture.expectHostStartupFailure();
    const canonical = await fixture.readInteraction(request.requestId);
    assert.deepEqual(canonical, { request });
    await fixture.assertOwnerAvailable();
  });
});

test('startup commits Interaction closure before strict Run recovery', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const { runId } = await fixture.seedRunWithoutUserMessage(
      turnId,
      'recover only after closing inherited interactions',
    );
    const request = await fixture.seedPendingQuestion({ turnId, runId });
    const host = await fixture.startHost({ steppingNow: 1_900_000_000_000 });
    const client = await connectClient(fixture.root, 'tui');
    const interaction = await client.request('interaction.query', {
      sessionId: fixture.sessionId,
      interactionId: request.requestId,
    });
    assert.equal(interaction.status, 'closed');
    if (interaction.status !== 'closed') return;
    assert.equal(interaction.outcome.reason, 'host_restarted');
    const turn = await client.queryTurn({ sessionId: fixture.sessionId, turnId });
    assert.equal(turn.status, 'failed');
    await client.close();
    await fixture.stopHost(host);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.terminalEvents.length, 1);
    assert.ok(interaction.outcome.committedAt < ledger.terminalEvents[0]!.ts);
  });
});

function operationError(code: RuntimeHostOperationError['code']) {
  return (error: unknown): boolean =>
    error instanceof RuntimeHostOperationError && error.code === code;
}

function questionAnswer(first: string, second: string, third: string): InteractionAnswer {
  return { kind: 'question', answers: [first, second, third] };
}

async function waitForPendingInteraction(
  subscription: RuntimeHostSessionSubscription,
  turnId: string,
): Promise<InteractionPendingSnapshot> {
  const initial = subscription.snapshot.interactions.pending.find(
    (interaction) => interaction.turnId === turnId,
  );
  if (initial) return initial;
  const iterator = subscription[Symbol.asyncIterator]();
  while (true) {
    const next = await withTimeout(
      iterator.next(),
      PROCESS_TIMEOUT_MS,
      'pending Interaction was not projected',
    );
    if (next.done) throw new Error('Session subscription closed before Interaction admission');
    if (next.value.kind !== 'subscription.session_projection') continue;
    const pending = next.value.snapshot.interactions.pending.find(
      (interaction) => interaction.turnId === turnId,
    );
    if (pending) return pending;
  }
}

async function waitForInteractionRemoval(
  subscription: RuntimeHostSessionSubscription,
  interactionId: string,
): Promise<void> {
  const iterator = subscription[Symbol.asyncIterator]();
  while (true) {
    const next = await withTimeout(
      iterator.next(),
      PROCESS_TIMEOUT_MS,
      'resolved Interaction remained in the Session projection',
    );
    if (next.done) throw new Error('Session subscription closed before Interaction resolution');
    if (
      next.value.kind === 'subscription.session_projection' &&
      !next.value.snapshot.interactions.pending.some(
        (interaction) => interaction.interactionId === interactionId,
      )
    ) {
      return;
    }
  }
}

function assertJsonLines(bytes: string): void {
  for (const line of bytes.split('\n').filter(Boolean)) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
}
