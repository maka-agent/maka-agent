import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { FAKE_ASK_USER_QUESTION_PROMPT } from '@maka/runtime';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  RuntimeHostOperationError,
  RuntimeHostSubscriptionError,
  type RuntimeHostConnection,
  type RuntimeHostSessionSubscription,
} from '../client/index.js';
import {
  type ConnectionCatalogQueryResult,
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
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
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
      content: { text: 'first root turn' },
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
      content: { text: 'second root turn' },
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
        content: { text: 'first root turn' },
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
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
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
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
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
        content: { text: inputText },
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
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
    });
    assert.equal(started.turnId, turnId);
    await assert.rejects(
      () =>
        second.startTurn({
          sessionId: fixture.sessionId,
          turnId: randomUUID(),
          content: { text: 'must stay busy' },
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
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
    });
    assert.deepEqual(
      await second.startTurn({
        sessionId: fixture.sessionId,
        turnId,
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
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
          content: { text: 'must not execute' },
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
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
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
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
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
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
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
          content: { text: 'must remain behind the recovered admission' },
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
    const content = {
      text: '<model>recover the admitted message</model>',
      displayText: 'recover the admitted message',
      attachments: [attachment('recovery', 'same-name.png')],
    };
    const { runId, userMessageId } = await fixture.seedRunWithoutUserMessage(turnId, content);
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
    assert.deepEqual(ledger.userMessages[0], {
      type: 'user',
      id: userMessageId,
      turnId,
      ts: ledger.userMessages[0]?.ts,
      ...content,
    });
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

test('startup recovery repairs a truncated RuntimeEvent tail before terminalizing the Run', async () => {
  await withExecutionRoot(async (fixture) => {
    const turnId = randomUUID();
    const { runId } = await fixture.seedRunWithoutUserMessage(turnId, {
      text: 'recover after a partial RuntimeEvent write',
    });
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
    const { runId } = await fixture.seedRunWithoutUserMessage(turnId, {
      text: 'do not recover across durable corruption',
    });
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
    await fixture.seedRunWithoutUserMessage(randomUUID(), {
      text: 'do not rewrite durable Session corruption',
    });
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
    const { runId } = await fixture.seedRunWithoutUserMessage(randomUUID(), {
      text: 'do not recover across durable AgentRun corruption',
    });
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
            content: { text: 'fail before the durable start barrier' },
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
    const content = {
      text: '<model>response loss must not duplicate this Turn</model>',
      displayText: 'response loss must not duplicate this Turn',
      attachments: [attachment('start-retry', 'same-name.png')],
    };
    const dropped = await sendRequestWithoutReadingResponse(host.endpoint, 'turn.start', {
      sessionId: fixture.sessionId,
      turnId,
      content,
    });
    const observer = await connectClient(fixture.root, 'tui');
    const committed = await waitForTurn(observer, fixture.sessionId, turnId);
    dropped.destroy();

    const retried = await observer.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      content,
    });
    assert.equal(retried.runId, committed.runId);
    await assert.rejects(
      () =>
        observer.startTurn({
          sessionId: fixture.sessionId,
          turnId,
          content: { ...content, displayText: 'different human input' },
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
    assert.deepEqual(ledger.userMessages[0], {
      type: 'user',
      id: ledger.userMessages[0]?.id,
      turnId,
      ts: ledger.userMessages[0]?.ts,
      ...content,
    });
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

test('a disconnected Client leaves one retried follow-up for the Host to execute', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root, 'desktop');
    const second = await connectClient(fixture.root, 'tui');
    const subscription = await second.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    const firstTurnId = randomUUID();
    await first.startTurn({
      sessionId: fixture.sessionId,
      turnId: firstTurnId,
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
    });
    const pending = await waitForPendingInteraction(subscription, firstTurnId);
    const messageId = randomUUID();
    const content = {
      text: '<model>execute this follow-up exactly once</model>',
      displayText: 'execute this follow-up exactly once',
      attachments: [attachment('follow-up', 'same-name.png')],
    };
    const input = {
      originHostEpoch: host.hostEpoch,
      sessionId: fixture.sessionId,
      messageId,
      content,
      placement: 'next_turn' as const,
    };

    let submitted: Awaited<ReturnType<typeof first.request<'turn.message.submit'>>>;
    try {
      submitted = await first.request('turn.message.submit', input);
    } catch (error) {
      throw new Error('Host connection failed during initial follow-up submit', {
        cause: error,
      });
    }
    assert.equal(submitted.disposition, 'followup');
    if (submitted.disposition !== 'followup') return;
    try {
      assert.deepEqual(await first.request('turn.message.submit', input), submitted);
    } catch (error) {
      throw new Error('Host connection failed during same-Epoch follow-up retry', {
        cause: error,
      });
    }
    await first.close();

    const iterator = subscription[Symbol.asyncIterator]();
    let queuedEntry: (typeof subscription.snapshot.queue.followup)[number] | undefined;
    while (!queuedEntry) {
      let next: Awaited<ReturnType<typeof iterator.next>>;
      try {
        next = await withTimeout(
          iterator.next(),
          PROCESS_TIMEOUT_MS,
          'surviving Client did not observe the canonical follow-up queue',
        );
      } catch (error) {
        throw new Error('Host connection failed before B observed the committed follow-up queue', {
          cause: error,
        });
      }
      if (next.done) throw new Error('Session subscription closed before follow-up admission');
      if (next.value.kind !== 'subscription.session_projection') continue;
      const queue = next.value.snapshot.queue;
      queuedEntry = queue.followup.find((entry) => entry.messageId === messageId);
      if (!queuedEntry) continue;
      assert.equal(queue.hostEpoch, host.hostEpoch);
      assert.equal(queue.queueRevision, submitted.queueRevision);
      assert.equal(queue.followup.length, 1);
      assert.ok(queuedEntry.entryId.length > 0);
      assert.deepEqual(queuedEntry.content, content);
    }

    try {
      await second.request('interaction.answer', {
        interactionId: pending.interactionId,
        answer: questionAnswer('邀请制', '本周', '是'),
      });
    } catch (error) {
      throw new Error('surviving Client lost the Host while completing the old Turn', {
        cause: error,
      });
    }
    let firstTerminalObserved = false;
    let nextTerminal: TurnSnapshot | undefined;
    while (!nextTerminal) {
      let next: Awaited<ReturnType<typeof iterator.next>>;
      try {
        next = await withTimeout(
          iterator.next(),
          PROCESS_TIMEOUT_MS,
          'Host did not automatically complete the queued follow-up Turn',
        );
      } catch (error) {
        throw new Error(
          `Host connection failed while awaiting the follow-up; old terminal observed: ${firstTerminalObserved}`,
          { cause: error },
        );
      }
      if (next.done) throw new Error('Session subscription closed before follow-up completion');
      if (next.value.kind !== 'subscription.session_projection') continue;
      const rootTurn = next.value.snapshot.rootTurn;
      if (rootTurn?.turnId === firstTurnId && rootTurn.status === 'completed') {
        firstTerminalObserved = true;
        continue;
      }
      if (!rootTurn || rootTurn.turnId === firstTurnId) continue;
      assert.equal(firstTerminalObserved, true);
      if (rootTurn.status === 'completed') nextTerminal = rootTurn;
    }

    const terminal = await second.openSessionSubscription({ sessionId: fixture.sessionId });
    assert.deepEqual(terminal.snapshot.rootTurn, nextTerminal);
    assert.ok(terminal.snapshot.queue.queueRevision > submitted.queueRevision);
    assert.deepEqual(terminal.snapshot.queue.followup, []);
    await terminal.close();
    await subscription.close();
    await second.close();
    await fixture.stopHost(host);

    const successor = await fixture.startHost();
    const successorClient = await connectClient(fixture.root, 'desktop');
    const proven = await successorClient.request('turn.message.submit', input);
    assert.equal(proven.disposition, 'followup');
    await assert.rejects(
      () =>
        successorClient.request('turn.message.submit', {
          ...input,
          content: {
            ...content,
            attachments: [attachment('changed-follow-up', 'same-name.png')],
          },
        }),
      operationError('operation_conflict'),
    );
    await successorClient.close();
    await fixture.stopHost(successor);

    const durableAdmission = JSON.parse(
      await readFile(fixture.admissionPath(nextTerminal.turnId), 'utf8'),
    ) as { sourceMessages: Array<{ content: unknown }> };
    assert.deepEqual(durableAdmission.sourceMessages[0]?.content, content);
    const ledger = await fixture.readTurn(nextTerminal.turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.deepEqual(ledger.userMessages[0], {
      type: 'user',
      id: ledger.userMessages[0]?.id,
      turnId: nextTerminal.turnId,
      ts: ledger.userMessages[0]?.ts,
      ...content,
    });
    assert.equal(ledger.terminalEvents.length, 1);
  });
});

test('routes bounded Tool activity from the real root Turn drain', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root, 'desktop');
    const subscription = await client.openSessionSubscription({
      sessionId: fixture.sessionId,
    });
    const iterator = subscription[Symbol.asyncIterator]();
    const turnId = randomUUID();
    const started = await client.startTurn({
      sessionId: fixture.sessionId,
      turnId,
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
    });

    let expectedSequence = 1;
    let pending: InteractionPendingSnapshot | undefined;
    let toolUseId: string | undefined;
    while (!pending || !toolUseId) {
      const next = await withTimeout(
        iterator.next(),
        PROCESS_TIMEOUT_MS,
        'root Turn did not route its Tool start',
      );
      if (next.done) throw new Error('Session subscription closed before Tool start');
      assert.equal(next.value.sequence, expectedSequence);
      expectedSequence += 1;
      if (next.value.kind === 'subscription.session_projection') {
        pending = next.value.snapshot.interactions.pending.find(
          (interaction) => interaction.turnId === turnId,
        );
      }
      if (
        next.value.kind === 'subscription.session_event' &&
        next.value.event.type === 'tool_start'
      ) {
        assert.equal(next.value.sessionId, fixture.sessionId);
        assert.equal(next.value.runId, started.runId);
        assert.equal(next.value.event.turnId, turnId);
        assert.equal(next.value.event.toolName, 'AskUserQuestion');
        assert.equal('args' in next.value.event, false);
        toolUseId = next.value.event.toolUseId;
      }
    }

    await client.request('interaction.answer', {
      interactionId: pending.interactionId,
      answer: questionAnswer('邀请制', '本周', '是'),
    });
    let resultObserved = false;
    let terminalObserved = false;
    while (!resultObserved || !terminalObserved) {
      const next = await withTimeout(
        iterator.next(),
        PROCESS_TIMEOUT_MS,
        'root Turn did not route its Tool result and terminal projection',
      );
      if (next.done) throw new Error('Session subscription closed before Tool result');
      assert.equal(next.value.sequence, expectedSequence);
      expectedSequence += 1;
      if (
        next.value.kind === 'subscription.session_event' &&
        next.value.event.type === 'tool_result'
      ) {
        assert.equal(next.value.runId, started.runId);
        assert.equal(next.value.event.toolUseId, toolUseId);
        assert.equal(next.value.event.status, 'completed');
        assert.equal('content' in next.value.event, false);
        resultObserved = true;
      }
      if (next.value.kind === 'subscription.session_projection') {
        const rootTurn = next.value.snapshot.rootTurn;
        terminalObserved =
          rootTurn?.turnId === turnId &&
          (rootTurn.status === 'completed' ||
            rootTurn.status === 'failed' ||
            rootTurn.status === 'cancelled');
      }
    }

    await subscription.close();
    await client.close();
    await fixture.stopHost(host);
  });
});

test('runs a real Host ai-sdk Tool loop across Clients and refreshes committed personalization', async () => {
  const modelId = 'gpt-4o-mini-local';
  const connectionSlug = 'local-openai-acceptance';
  const apiKey = `local-provider-key-${randomUUID()}`;
  const initialMarker = `INITIAL_HOST_PERSONALIZATION_${randomUUID()}`;
  const updatedMarker = `UPDATED_HOST_PERSONALIZATION_${randomUUID()}`;
  const taskSubject = `Persist real Host tool result ${randomUUID()}`;
  const providerToolUseId = 'call:host.task.create';
  const firstFinalText = 'The Host tool loop completed locally.';
  const secondFinalText = 'The refreshed Host prompt reached the provider.';
  const requests: Array<{
    authorization: string | undefined;
    method: string | undefined;
    path: string | undefined;
    body: Record<string, unknown>;
  }> = [];
  const handlerErrors: unknown[] = [];
  let releaseFirstResponse: (() => void) | undefined;
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve;
  });
  let markFirstRequestReceived: (() => void) | undefined;
  const firstRequestReceived = new Promise<void>((resolve) => {
    markFirstRequestReceived = resolve;
  });

  const readRequestBody = (request: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => resolve(body));
      request.on('error', reject);
    });
  const respondStream = (response: ServerResponse, chunks: readonly unknown[]) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end('data: [DONE]\n\n');
  };
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
        requests.push({
          authorization: request.headers.authorization,
          method: request.method,
          path: request.url,
          body,
        });
        const requestNumber = requests.length;
        if (requestNumber === 1) {
          markFirstRequestReceived?.();
          await firstResponseGate;
          respondStream(response, [
            {
              id: 'chatcmpl-host-tool',
              object: 'chat.completion.chunk',
              created: 1,
              model: modelId,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: providerToolUseId,
                        type: 'function',
                        function: {
                          name: 'task_create',
                          arguments: JSON.stringify({ tasks: [{ subject: taskSubject }] }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
            },
          ]);
          return;
        }
        const text = requestNumber === 2 ? firstFinalText : secondFinalText;
        respondStream(response, [
          {
            id: `chatcmpl-host-final-${requestNumber}`,
            object: 'chat.completion.chunk',
            created: requestNumber,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: text },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 18, completion_tokens: 7, total_tokens: 25 },
          },
        ]);
      } catch (error) {
        handlerErrors.push(error);
        response.destroy(error as Error);
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const providerBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    await withExecutionRoot(async (fixture) => {
      const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const executionStores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const policyStores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
        const created = await policyStores.connectionCatalog.create({
          expectedCatalogRevision: 0,
          connection: {
            slug: connectionSlug,
            name: 'Local OpenAI acceptance provider',
            providerType: 'openai',
            baseUrl: providerBaseUrl,
            enabled: true,
            enabledModelIds: [modelId],
          },
        });
        assert.equal(created.kind, 'committed');
        if (created.kind !== 'committed') return;
        const connection = created.snapshot.connections[0];
        assert.ok(connection);
        if (!connection) return;
        const credential = await policyStores.credentialVault.set({
          locator: {
            scope: 'connection',
            connectionId: connection.connectionId,
            kind: 'api_key',
          },
          expected: null,
          secret: apiKey,
        });
        assert.equal(credential.kind, 'committed');
        const fetch = await policyStores.operations.beginModelFetch(connection.connectionId);
        assert.equal(fetch.kind, 'ready');
        if (fetch.kind !== 'ready') return;
        const fetched = await policyStores.operations.completeModelFetch(fetch.ticket, {
          models: [
            {
              id: modelId,
              apiProtocol: 'openai-chat',
              capabilities: { chat: true, functionCalling: true },
            },
          ],
          source: 'fetched',
          fetchedAt: Date.now(),
        });
        assert.equal(fetched.kind, 'committed');
        const policy = await policyStores.runtimePolicy.getSnapshot();
        const personalized = await policyStores.runtimePolicy.mutate({
          expectedRevision: policy.revision,
          operation: {
            kind: 'set_personalization',
            value: { displayName: 'Local acceptance user', assistantTone: initialMarker },
          },
        });
        assert.equal(personalized.kind, 'committed');
        await executionStores.sessionStore.updateHeader(fixture.sessionId, {
          backend: 'ai-sdk',
          llmConnectionSlug: connectionSlug,
          model: modelId,
        });
      } finally {
        await owner.close();
      }

      const host = await fixture.startHost();
      let starter: RuntimeHostConnection | undefined;
      let observer: RuntimeHostConnection | undefined;
      try {
        starter = await connectClient(fixture.root, 'desktop');
        observer = await connectClient(fixture.root, 'tui');
        const starterSubscription = await starter.openSessionSubscription({
          sessionId: fixture.sessionId,
        });
        const observerSubscription = await observer.openSessionSubscription({
          sessionId: fixture.sessionId,
        });
        assert.notEqual(starterSubscription.subscriptionId, observerSubscription.subscriptionId);
        const iterator = observerSubscription[Symbol.asyncIterator]();
        let expectedSequence = 1;
        const firstTurnId = randomUUID();
        const started = await starter.startTurn({
          sessionId: fixture.sessionId,
          turnId: firstTurnId,
          content: { text: 'Create the requested durable task, then report completion.' },
        });
        await withTimeout(
          firstRequestReceived,
          PROCESS_TIMEOUT_MS,
          'real provider did not receive the first Host request',
        );
        await starter.close();
        starter = undefined;
        const running = await observer.queryTurn({
          sessionId: fixture.sessionId,
          turnId: firstTurnId,
        });
        assert.equal(running.status, 'running');
        assert.equal(running.runId, started.runId);
        const policy = await observer.request('runtime.policy.query', {});
        const mutation = await observer.request('runtime.policy.mutate', {
          expectedRevision: policy.revision,
          operation: {
            kind: 'set_personalization',
            value: { displayName: 'Updated acceptance user', assistantTone: updatedMarker },
          },
        });
        assert.equal(mutation.kind, 'committed');
        releaseFirstResponse?.();

        let toolStarted = false;
        let toolCompleted = false;
        let firstText = '';
        let firstTerminal: TurnSnapshot | undefined;
        while (!toolStarted || !toolCompleted || !firstTerminal) {
          const next = await withTimeout(
            iterator.next(),
            PROCESS_TIMEOUT_MS,
            'surviving Client did not observe the real ai-sdk Tool loop',
          );
          if (next.done) throw new Error('Session subscription closed during the ai-sdk Tool loop');
          assert.equal(next.value.sequence, expectedSequence);
          expectedSequence += 1;
          if (next.value.kind === 'subscription.session_delta') {
            assert.equal(next.value.delta.turnId, firstTurnId);
            assert.equal(next.value.delta.runId, started.runId);
            if (next.value.delta.kind === 'text') firstText += next.value.delta.text;
          }
          if (
            next.value.kind === 'subscription.session_event' &&
            next.value.event.type === 'tool_start'
          ) {
            assert.equal(next.value.runId, started.runId);
            assert.equal(next.value.event.toolName, 'task_create');
            assert.equal(next.value.event.displayName, 'Task Create');
            assert.equal('args' in next.value.event, false);
            assert.equal(next.value.event.toolUseId, providerToolUseId);
            toolStarted = true;
          }
          if (
            next.value.kind === 'subscription.session_event' &&
            next.value.event.type === 'tool_result'
          ) {
            assert.equal(next.value.runId, started.runId);
            assert.equal(next.value.event.toolUseId, providerToolUseId);
            assert.equal(next.value.event.status, 'completed');
            assert.equal('content' in next.value.event, false);
            toolCompleted = true;
          }
          if (next.value.kind === 'subscription.session_projection') {
            const rootTurn = next.value.snapshot.rootTurn;
            if (rootTurn?.turnId === firstTurnId && rootTurn.status === 'completed') {
              firstTerminal = rootTurn;
            }
          }
        }
        assert.equal(firstText, firstFinalText);
        assert.deepEqual(
          firstTerminal,
          await observer.queryTurn({ sessionId: fixture.sessionId, turnId: firstTurnId }),
        );
        const taskPage = await observer.request('task.ledger.query', {
          kind: 'list_start',
          sessionId: fixture.sessionId,
        });
        assert.equal(taskPage.kind, 'page');
        if (taskPage.kind === 'page') {
          assert.ok(taskPage.tasks.some((task) => task.subject === taskSubject));
        }

        assert.equal(handlerErrors.length, 0);
        assert.equal(requests[0]?.method, 'POST');
        assert.equal(requests[0]?.path, '/v1/chat/completions');
        assert.equal(requests[0]?.authorization, `Bearer ${apiKey}`);
        assert.equal(requests[0]?.body.model, modelId);
        assert.equal(requests[0]?.body.stream, true);
        assert.ok(JSON.stringify(requests[0]?.body).includes(initialMarker));
        const tools = requests[0]?.body.tools as
          | Array<{
              type?: unknown;
              function?: { name?: unknown; parameters?: Record<string, unknown> };
            }>
          | undefined;
        const taskCreateSchema = tools?.find((tool) => tool.function?.name === 'task_create');
        assert.ok(taskCreateSchema);
        assert.equal(taskCreateSchema?.type, 'function');
        assert.deepEqual(taskCreateSchema?.function?.parameters?.required, ['tasks']);
        const properties = taskCreateSchema?.function?.parameters?.properties as
          | Record<string, { type?: unknown; items?: { required?: unknown } }>
          | undefined;
        assert.equal(properties?.tasks?.type, 'array');
        assert.deepEqual(properties?.tasks?.items?.required, ['subject']);
        assert.equal(requests[1]?.authorization, `Bearer ${apiKey}`);
        assert.ok(JSON.stringify(requests[1]?.body).includes(initialMarker));
        assert.equal(JSON.stringify(requests[1]?.body).includes(updatedMarker), false);
        const toolResultMessage = (
          requests[1]?.body.messages as
            | Array<{ role?: unknown; tool_call_id?: unknown; content?: unknown }>
            | undefined
        )?.find((message) => message.role === 'tool');
        assert.equal(toolResultMessage?.tool_call_id, providerToolUseId);
        assert.ok(JSON.stringify(toolResultMessage?.content).includes(taskSubject));

        const secondTurnId = randomUUID();
        const secondStarted = await observer.startTurn({
          sessionId: fixture.sessionId,
          turnId: secondTurnId,
          content: { text: 'Confirm the refreshed personalization context.' },
        });
        let secondText = '';
        let secondTerminal: TurnSnapshot | undefined;
        while (!secondTerminal) {
          const next = await withTimeout(
            iterator.next(),
            PROCESS_TIMEOUT_MS,
            'next Turn did not use the refreshed real backend',
          );
          if (next.done) throw new Error('Session subscription closed during the next Turn');
          assert.equal(next.value.sequence, expectedSequence);
          expectedSequence += 1;
          if (
            next.value.kind === 'subscription.session_delta' &&
            next.value.delta.turnId === secondTurnId
          ) {
            assert.equal(next.value.delta.runId, secondStarted.runId);
            if (next.value.delta.kind === 'text') secondText += next.value.delta.text;
          }
          if (next.value.kind === 'subscription.session_projection') {
            const rootTurn = next.value.snapshot.rootTurn;
            if (rootTurn?.turnId === secondTurnId && rootTurn.status === 'completed') {
              secondTerminal = rootTurn;
            }
          }
        }
        assert.equal(secondText, secondFinalText);
        assert.equal(requests[2]?.authorization, `Bearer ${apiKey}`);
        assert.ok(JSON.stringify(requests[2]?.body).includes(updatedMarker));
        assert.equal(handlerErrors.length, 0);

        await observerSubscription.close();
      } finally {
        await Promise.allSettled([starter?.close(), observer?.close()]);
        if (host.child.exitCode === null && host.child.signalCode === null) {
          await fixture.stopHost(host);
        }
      }
    });
  } finally {
    releaseFirstResponse?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
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
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
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
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
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
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
    });
    await waitForPendingInteraction(subscription, turnId);
    const messageId = randomUUID();
    const text = 'cancel this queued follow-up during administrative shutdown';
    const input = {
      originHostEpoch: host.hostEpoch,
      sessionId: fixture.sessionId,
      messageId,
      content: { text },
      placement: 'next_turn' as const,
    };
    const submitted = await client.request('turn.message.submit', input);
    assert.equal(submitted.disposition, 'followup');

    await fixture.stopHost(host);
    assert.equal(host.child.exitCode, 0);
    assert.equal(host.child.signalCode, null);
    await client.closed;
    await fixture.assertOwnerAvailable();

    const successor = await fixture.startHost();
    const successorClient = await connectClient(fixture.root, 'tui');
    await assert.rejects(
      () => successorClient.request('turn.message.submit', input),
      operationError('outcome_unknown'),
    );
    await successorClient.close();
    await fixture.stopHost(successor);
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
      content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
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

test('shares one canonical runtime policy, connection catalog, and credential vault across Clients', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    let desktop: RuntimeHostConnection | undefined;
    let tui: RuntimeHostConnection | undefined;
    try {
      desktop = await connectClient(fixture.root, 'desktop');
      tui = await connectClient(fixture.root, 'tui');

      const initialPolicy = await desktop.request('runtime.policy.query', {});
      assert.deepEqual(await tui.request('runtime.policy.query', {}), initialPolicy);
      const policyMutations = await Promise.all([
        desktop.request('runtime.policy.mutate', {
          expectedRevision: initialPolicy.revision,
          operation: {
            kind: 'set_personalization',
            value: { displayName: 'Desktop owner', assistantTone: 'precise' },
          },
        }),
        tui.request('runtime.policy.mutate', {
          expectedRevision: initialPolicy.revision,
          operation: {
            kind: 'set_memory',
            value: { enabled: false, agentReadEnabled: false },
          },
        }),
      ]);
      assert.deepEqual(policyMutations.map((result) => result.kind).sort(), [
        'committed',
        'revision_conflict',
      ]);
      const committedPolicy = policyMutations.find((result) => result.kind === 'committed');
      const conflictedPolicy = policyMutations.find(
        (result) => result.kind === 'revision_conflict',
      );
      assert.ok(committedPolicy);
      assert.ok(conflictedPolicy);
      assert.equal(conflictedPolicy.expectedRevision, initialPolicy.revision);
      assert.equal(conflictedPolicy.actualRevision, committedPolicy.revision);
      const desktopPolicy = await desktop.request('runtime.policy.query', {});
      const tuiPolicy = await tui.request('runtime.policy.query', {});
      assert.equal(desktopPolicy.revision, committedPolicy.revision);
      assert.deepEqual(tuiPolicy, desktopPolicy);
      if (policyMutations[0].kind === 'committed') {
        assert.deepEqual(desktopPolicy.policy.personalization, {
          displayName: 'Desktop owner',
          assistantTone: 'precise',
        });
        assert.deepEqual(desktopPolicy.policy.memory, initialPolicy.policy.memory);
      } else {
        assert.deepEqual(
          desktopPolicy.policy.personalization,
          initialPolicy.policy.personalization,
        );
        assert.deepEqual(desktopPolicy.policy.memory, {
          enabled: false,
          agentReadEnabled: false,
        });
      }

      const initialCatalog = await desktop.request('connection.catalog.query', { kind: 'start' });
      assert.equal(initialCatalog.kind, 'page');
      if (initialCatalog.kind !== 'page') return;
      const created = await desktop.request('connection.catalog.create', {
        expectedCatalogRevision: initialCatalog.revision,
        connection: {
          slug: 'cross-client-openai',
          name: 'Cross-client OpenAI',
          providerType: 'openai',
          enabled: true,
          enabledModelIds: [],
        },
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;

      const firstPage = await tui.request('connection.catalog.query', { kind: 'start' });
      assert.equal(firstPage.kind, 'page');
      if (firstPage.kind !== 'page') return;
      const catalogItems = [...firstPage.items];
      let page = firstPage;
      while (page.nextCursor) {
        const next: ConnectionCatalogQueryResult = await tui.request('connection.catalog.query', {
          kind: 'continue',
          revision: page.revision,
          cursor: page.nextCursor,
        });
        assert.equal(next.kind, 'page');
        if (next.kind !== 'page') return;
        assert.equal(next.revision, firstPage.revision);
        catalogItems.push(...next.items);
        page = next;
      }
      const connectionItem = catalogItems.find(
        (item) =>
          item.kind === 'connection' && item.connectionId === created.connection.connectionId,
      );
      assert.ok(connectionItem);
      if (!connectionItem || connectionItem.kind !== 'connection') return;
      assert.equal(connectionItem.slug, 'cross-client-openai');
      assert.equal(firstPage.revision, created.catalogRevision);

      const credentialClient = tui;
      await assert.rejects(
        () =>
          credentialClient.request('credential.vault.query', {
            locator: {
              scope: 'connection',
              connectionId: created.connection.connectionId,
              kind: 'oauth_token',
            },
          }),
        operationError('invalid_request'),
      );
      assert.deepEqual(await credentialClient.request('runtime.policy.query', {}), desktopPolicy);

      const locator = {
        scope: 'connection' as const,
        connectionId: created.connection.connectionId,
        kind: 'api_key' as const,
      };
      const secret = `cross-client-secret-${randomUUID()}`;
      const setCredential = await desktop.request('credential.vault.set', {
        locator,
        expected: null,
        secret,
      });
      assert.equal(setCredential.kind, 'committed');
      if (setCredential.kind !== 'committed') return;

      const configured = await tui.request('credential.vault.query', { locator });
      assert.equal(configured.kind, 'status');
      if (configured.kind !== 'status') return;
      assert.equal(configured.status.configured, true);
      assert.deepEqual(configured.status, setCredential.status);
      assert.equal(JSON.stringify(configured).includes(secret), false);
      if (!configured.status.configured) return;

      const deleted = await tui.request('credential.vault.delete', {
        expected: {
          locator: configured.status.locator,
          credentialId: configured.status.credentialId,
          revision: configured.status.revision,
        },
      });
      assert.equal(deleted.kind, 'committed');
      if (deleted.kind !== 'committed') return;
      assert.equal(deleted.status.configured, false);
      assert.equal(JSON.stringify(deleted).includes(secret), false);

      const unconfigured = await desktop.request('credential.vault.query', { locator });
      assert.deepEqual(unconfigured, { kind: 'status', status: deleted.status });
      assert.equal(JSON.stringify(unconfigured).includes(secret), false);
    } finally {
      await Promise.allSettled([desktop?.close(), tui?.close()]);
      if (host.child.exitCode === null && host.child.signalCode === null) {
        await fixture.stopHost(host);
      }
    }
  });
});

function attachment(id: string, name: string) {
  return {
    kind: 'image' as const,
    name,
    mimeType: 'image/png',
    bytes: 10,
    ref: { kind: 'workspace_file' as const, relativePath: `attachments/${id}.png` },
  };
}

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
    const { runId } = await fixture.seedRunWithoutUserMessage(turnId, {
      text: 'recover only after closing inherited interactions',
    });
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
