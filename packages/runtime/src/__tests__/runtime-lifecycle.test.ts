import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { AgentBackend, BackendSendInput, BackendStopMode } from '@maka/core/backend-types';
import type {
  AgentRunStore,
  LlmConnection,
  RuntimeEvent,
  RuntimeEventStore,
  SessionEvent,
  SessionHeader,
} from '@maka/core';
import { createAgentRunStore, createRuntimeEventStore, createSessionStore } from '@maka/storage';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { AiSdkBackend } from '../ai-sdk-backend.js';
import { FAKE_ASK_USER_QUESTION_PROMPT, FakeBackend } from '../fake-backend.js';
import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionFailStopError,
  type RuntimeInteractionAuthority,
  type RuntimeInteractionContinuationAuthority,
  type RuntimeInteractionRunFacet,
  type RuntimeInteractionRunClosureReason,
  type RuntimeInteractionRunOwner,
  type RuntimeUserQuestionContinuation,
} from '../interaction-authority.js';
import type {
  RuntimeMessageAuthority,
  RuntimeMessageRunOwner,
} from '../message-authority.js';
import { PermissionEngine } from '../permission-engine.js';
import { PiAgentBackend, type PiAgentFrame, type PiAgentTransport } from '../pi-agent-backend.js';
import {
  EMBEDDED_RUNTIME_EXECUTION,
  RUNTIME_BIND_HOSTED_RUN,
  type RuntimeHostedBackendRunBinding,
  type RuntimeHostedRunControl,
} from '../run-execution.js';
import { RuntimeKernel } from '../runtime-kernel.js';
import {
  BackendRegistry,
  SessionManager,
  type BackendFactoryContext,
  type SessionStore,
} from '../session-manager.js';
import { LOCAL_READ_AGENT_ID } from '../agent-catalog.js';

describe('hosted Runtime lifecycle', () => {
  test('clean drain stops active and pending runs and rejects late parent, child, and compact admission', async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      const buildPending = gate();
      const pendingFactoryEntered = gate();
      const activeFactoryEntered = gate();
      let activeBackend: DrainBackend | undefined;
      let pendingBackend: DrainBackend | undefined;
      const backends = new BackendRegistry();
      backends.register('fake', async (context) => {
        if (context.header.name === 'Pending') {
          pendingBackend = new DrainBackend(context.sessionId);
          pendingFactoryEntered.release();
          await buildPending.promise;
          return pendingBackend;
        }
        activeBackend = new DrainBackend(context.sessionId);
        activeFactoryEntered.release();
        return activeBackend;
      });
      const manager = managerFor({
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution: EMBEDDED_RUNTIME_EXECUTION,
      });
      const activeSession = await manager.createSession(sessionInput(root, 'Active'));
      const pendingSession = await manager.createSession(sessionInput(root, 'Pending'));
      const active = drain(
        manager.sendMessage(activeSession.id, {
          turnId: 'turn-active',
          text: 'stay active',
        }),
      );
      await activeFactoryEntered.promise;
      await activeBackend!.entered.promise;
      const pending = drain(
        manager.sendMessage(pendingSession.id, {
          turnId: 'turn-pending',
          text: 'wait for backend registration',
        }),
      );
      await pendingFactoryEntered.promise;

      const drainHandle = manager.beginRuntimeDrain();
      await assert.rejects(
        manager
          .sendMessage(activeSession.id, {
            turnId: 'turn-late-parent',
            text: 'late parent',
          })
          [Symbol.asyncIterator]()
          .next(),
        RuntimeInteractionAdmissionRejectedError,
      );
      await assert.rejects(
        manager
          .startChildTurn(activeSession.id, {
            turnId: 'turn-late-child',
            parentRunId: 'run-never-admitted',
            spec: { id: LOCAL_READ_AGENT_ID, name: 'Local read', systemPrompt: 'ignored' },
            prompt: 'late child',
          })
          [Symbol.asyncIterator]()
          .next(),
        RuntimeInteractionAdmissionRejectedError,
      );
      await assert.rejects(
        manager
          .compactSession(activeSession.id, { turnId: 'turn-late-compact' })
          [Symbol.asyncIterator]()
          .next(),
        RuntimeInteractionAdmissionRejectedError,
      );

      buildPending.release();
      await drainHandle.ownerIsolationDrain;
      await drainHandle.reclaimDrain;
      await Promise.all([active, pending]);

      assert.equal(activeBackend!.stopCalls, 1);
      assert.equal(pendingBackend!.stopCalls, 1);
      assert.equal(pendingBackend!.sendCalls, 0);
      const activeRuns = await runStore.listSessionRuns(activeSession.id);
      const pendingRuns = await runStore.listSessionRuns(pendingSession.id);
      assert.equal(activeRuns[0]?.status, 'cancelled');
      assert.equal(pendingRuns[0]?.status, 'cancelled');
    });
  });

  test('stop-owned consumer abandon joins the pending stop delivery', async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      let backend: PendingStopBackend | undefined;
      const backends = new BackendRegistry();
      backends.register('fake', (context) => {
        backend = new PendingStopBackend(context.sessionId);
        return backend;
      });
      const manager = managerFor({
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution: EMBEDDED_RUNTIME_EXECUTION,
      });
      const session = await manager.createSession(sessionInput(root, 'Stop-owned abandon'));
      const iterator = manager
        .sendMessage(session.id, {
          turnId: 'turn-stop-owned-abandon',
          text: 'stop while the consumer detaches',
        })
        [Symbol.asyncIterator]();

      assert.equal((await iterator.next()).value?.type, 'text_delta');
      const stopping = manager.claimSessionStop(session.id, { source: 'stop_button' });
      await backend!.stopEntered.promise;
      const abandoning = iterator.return!(undefined);
      backend!.releaseStop();

      await Promise.all([stopping, abandoning]);
      assert.equal(backend!.stopCalls, 1);
      const [run] = await runStore.listSessionRuns(session.id);
      assert.equal(run?.status, 'cancelled');
      assert.deepEqual(
        (await terminalEvents(runtimeEventStore, session.id, run!.runId)).map(
          (event) => event.status,
        ),
        ['aborted'],
      );
    });
  });

  test('hosted root runs consume the Host lease into the ledger and leave no Runtime queue owner', async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      const activeOwners = new Set<string>();
      const acked = new Set<string>();
      const nacked = new Set<string>();
      let pulled = false;
      const messages = messageAuthority((identity) => {
        activeOwners.add(identity.runId);
        return {
          ...identity,
          pull: () => {
            if (pulled) return [];
            pulled = true;
            return [{ id: 'host-lease-1', messageId: 'host-message-1', text: 'host steer' }];
          },
          ack: (leaseIds) => leaseIds.forEach((leaseId) => acked.add(leaseId)),
          nack: (leaseIds) => leaseIds.forEach((leaseId) => nacked.add(leaseId)),
          release: () => {
            activeOwners.delete(identity.runId);
          },
        };
      });
      const backends = new BackendRegistry();
      backends.register(
        'fake',
        (context) => {
          if (context.header.name === 'Hosted message failure') {
            return new RejectingSendHostedBackend(context.sessionId, new Error('provider failed'));
          }
          return new FakeBackend({
            execution: context.execution,
            sessionId: context.sessionId,
            header: context.header,
            store: context.store,
            appendMessage: context.appendMessage,
          });
        },
      );
      const manager = managerFor({
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution: {
          kind: 'hosted',
          interactionAuthority: interactionAuthority(),
          messageAuthority: messages,
        },
      });
      const session = await manager.createSession(sessionInput(root, 'Hosted message authority'));

      await drain(
        manager.sendMessage(session.id, {
          turnId: 'turn-host-message',
          text: 'start',
        }),
      );

      const [run] = await runStore.listSessionRuns(session.id);
      const steering = (await runtimeEventStore.readRuntimeEvents(session.id, run!.runId)).find(
        (event) => event.content?.kind === 'text' && event.content.steering === true,
      );
      assert.equal(steering?.refs?.providerEventId, 'host-message-1');
      assert.deepEqual([...acked], ['host-lease-1']);
      assert.deepEqual([...nacked], []);
      assert.deepEqual([...activeOwners], []);

      assert.throws(() => manager.steer(session.id, 'runtime queue'), /Runtime Host owns/);
      assert.throws(() => manager.queueMessage(session.id, 'runtime followup'), /Runtime Host owns/);
      assert.throws(() => manager.drainFollowup(session.id), /Runtime Host owns/);
      assert.throws(() => manager.retractQueue(session.id), /Runtime Host owns/);

      const stoppedSession = await manager.createSession(
        sessionInput(root, 'Hosted message stop'),
      );
      const stoppedIterator = manager
        .sendMessage(stoppedSession.id, { turnId: 'turn-host-stop', text: 'stop' })
        [Symbol.asyncIterator]();
      await stoppedIterator.next();
      assert.equal(activeOwners.size, 1);
      const stopCompletion = manager.claimSessionStop(stoppedSession.id, {
        source: 'stop_button',
      });
      await Promise.all([
        stopCompletion,
        drain({ [Symbol.asyncIterator]: () => stoppedIterator }),
      ]);
      assert.deepEqual([...activeOwners], []);

      const failedSession = await manager.createSession(
        sessionInput(root, 'Hosted message failure'),
      );
      await assert.rejects(
        drain(
          manager.sendMessage(failedSession.id, {
            turnId: 'turn-host-failure',
            text: 'fail',
          }),
        ),
        /provider failed/,
      );
      assert.deepEqual([...activeOwners], []);
    });
  });

  test('overlapping backend disposal shares one rejecting canonical disposition', async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      const disposalFailure = new Error('canonical backend disposal failed');
      const backend = new RejectingDisposeBackend('session-not-bound', disposalFailure);
      const backends = new BackendRegistry();
      backends.register('fake', (context) => {
        backend.sessionId = context.sessionId;
        return backend;
      });
      const execution = {
        kind: 'hosted' as const,
        interactionAuthority: interactionAuthority(),
        messageAuthority: messageAuthority(),
      };
      const deps = {
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution,
        newId: ids('runtime'),
        now: clock(1_000),
        runtimeSource: 'test' as const,
      };
      const kernel = new RuntimeKernel(deps);
      const manager = new SessionManager({ ...deps, runtimeKernel: kernel });
      const session = await manager.createSession(sessionInput(root, 'Dispose single-flight'));
      await drain(
        manager.sendMessage(session.id, {
          turnId: 'turn-before-dispose',
          text: 'populate the backend identity',
        }),
      );

      const first = kernel.disposeBackend(session.id);
      await backend.firstDisposeEntered.promise;
      const overlapping = kernel.disposeBackend(session.id);
      assert.equal(overlapping, first);
      backend.rejectFirstDispose();
      await assert.rejects(first, (error: unknown) => error === disposalFailure);
      await assert.rejects(overlapping, (error: unknown) => error === disposalFailure);
      const afterFailure = kernel.disposeBackend(session.id);
      assert.equal(afterFailure, first);
      await assert.rejects(afterFailure, (error: unknown) => error === disposalFailure);
      assert.equal(backend.disposeCalls, 1);
    });
  });

  test('Pi clean owner isolation waits transport acknowledgment and normal send settlement', async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      const transport = new AckGatedPiTransport();
      const backends = new BackendRegistry();
      backends.register(
        'pi-agent',
        (context) =>
          new PiAgentBackend({
            execution: context.execution,
            sessionId: context.sessionId,
            header: context.header,
            appendMessage: (message) => context.store.appendMessage(context.sessionId, message),
            permissionEngine: new PermissionEngine({
              newId: ids('permission'),
              now: clock(2_000),
            }),
            transport,
            newId: ids('pi'),
            now: clock(3_000),
          }),
      );
      const manager = managerFor({
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution: {
          kind: 'hosted',
          interactionAuthority: interactionAuthority(),
          messageAuthority: messageAuthority(),
        },
      });
      const session = await manager.createSession({
        ...sessionInput(root, 'Pi isolation acknowledgment'),
        backend: 'pi-agent',
      });
      const running = drain(
        manager.sendMessage(session.id, {
          turnId: 'turn-pi-isolation',
          text: 'keep provider settlement pending',
        }),
      );
      void running.catch(() => undefined);
      await transport.sendEntered.promise;

      const runtimeDrain = manager.beginRuntimeDrain();
      await transport.stopEntered.promise;
      transport.acknowledgeIsolation();
      assert.equal(
        await Promise.race([
          runtimeDrain.ownerIsolationDrain.then(() => 'isolated'),
          Promise.resolve('pending'),
        ]),
        'pending',
      );

      transport.releaseSend();
      await Promise.all([
        running,
        runtimeDrain.ownerIsolationDrain,
        runtimeDrain.reclaimDrain,
      ]);
      const [run] = await runStore.listSessionRuns(session.id);
      assert.equal(run?.status, 'cancelled');
    });
  });

  test('clean drain settles a stop claimed by an admitted backend factory before that factory fails', async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      const backendFailure = new Error('backend activation failed after clean drain fenced');
      let messageOwnerBound = false;
      let manager!: SessionManager;
      let runtimeDrain: ReturnType<SessionManager['beginRuntimeDrain']> | undefined;
      const backends = new BackendRegistry();
      backends.register('fake', () => {
        runtimeDrain = manager.beginRuntimeDrain();
        throw backendFailure;
      });
      manager = managerFor({
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution: {
          kind: 'hosted',
          interactionAuthority: interactionAuthority(),
          messageAuthority: messageAuthority((identity) => {
            messageOwnerBound = true;
            return {
              ...identity,
              pull: () => [],
              ack: () => {},
              nack: () => {},
              release: () => {},
            };
          }),
        },
      });
      const session = await manager.createSession(sessionInput(root, 'Pre-bind failure'));
      const running = drain(
        manager.sendMessage(session.id, {
          turnId: 'turn-pre-bind-failure',
          text: 'fail backend activation during clean drain',
        }),
      );

      await assert.rejects(running, (error: unknown) => error === backendFailure);
      assert.ok(runtimeDrain);
      await assert.rejects(
        runtimeDrain.ownerIsolationDrain,
        (error: unknown) => error === backendFailure,
      );
      await assert.rejects(runtimeDrain.reclaimDrain, (error: unknown) => error === backendFailure);
      const [run] = await runStore.listSessionRuns(session.id);
      assert.equal(run?.status, 'cancelled');
      const terminal = await terminalEvents(runtimeEventStore, session.id, run!.runId);
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0]?.status, 'aborted');
      assert.equal(messageOwnerBound, false);
    });
  });

  test('clean drain does not bind Message ownership after run begin observes its stop claim', async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      let draining = false;
      let manager!: SessionManager;
      let runtimeDrain: ReturnType<SessionManager['beginRuntimeDrain']> | undefined;
      const backends = new BackendRegistry();
      backends.register('fake', (context) => {
        draining = true;
        runtimeDrain = manager.beginRuntimeDrain();
        return new DrainBackend(context.sessionId);
      });
      manager = managerFor({
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution: {
          kind: 'hosted',
          interactionAuthority: interactionAuthority(),
          messageAuthority: messageAuthority(() => {
            if (draining) throw new Error('Message owner bound after clean-drain stop claim');
            throw new Error('Message owner bound before run begin completed');
          }),
        },
      });
      const session = await manager.createSession(sessionInput(root, 'Pre-bind stop'));

      await drain(
        manager.sendMessage(session.id, {
          turnId: 'turn-pre-bind-stop',
          text: 'stop after begin without binding messages',
        }),
      );
      assert.ok(runtimeDrain);
      await runtimeDrain.ownerIsolationDrain;
      await runtimeDrain.reclaimDrain;

      const [run] = await runStore.listSessionRuns(session.id);
      assert.equal(run?.status, 'cancelled');
      assert.deepEqual(
        (await terminalEvents(runtimeEventStore, session.id, run!.runId)).map(
          (event) => event.status,
        ),
        ['aborted'],
      );
    });
  });

  test('clean drain waits for in-flight Message settlement before normal owner release', async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      const producer = new InFlightSteeringBackend('session-not-bound');
      const ownerReleased = gate();
      const inFlight = new Set<string>();
      let ownerActive = false;
      const backends = new BackendRegistry();
      backends.register('fake', (context) => {
        producer.sessionId = context.sessionId;
        return producer;
      });
      const manager = managerFor({
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution: {
          kind: 'hosted',
          interactionAuthority: interactionAuthority(),
          messageAuthority: messageAuthority((identity) => {
            ownerActive = true;
            return {
              ...identity,
              pull: () => {
                inFlight.add('lease-clean-drain');
                return [
                  {
                    id: 'lease-clean-drain',
                    messageId: 'message-clean-drain',
                    text: 'settle before release',
                  },
                ];
              },
              ack: () => {},
              nack: (leaseIds) => leaseIds.forEach((leaseId) => inFlight.delete(leaseId)),
              release: () => {
                if (inFlight.size > 0) throw new Error('released with an in-flight lease');
                ownerActive = false;
                ownerReleased.release();
              },
            };
          }),
        },
      });
      const session = await manager.createSession(sessionInput(root, 'In-flight clean drain'));
      const running = drain(
        manager.sendMessage(session.id, {
          turnId: 'turn-in-flight-clean-drain',
          text: 'hold steering settlement',
        }),
      );
      void running.catch(() => undefined);
      await producer.leasePulled.promise;

      const runtimeDrain = manager.beginRuntimeDrain();
      await producer.stopEntered.promise;
      assert.equal(ownerActive, true);
      assert.deepEqual([...inFlight], ['lease-clean-drain']);
      assert.equal(
        await Promise.race([
          runtimeDrain.ownerIsolationDrain.then(() => 'isolated'),
          Promise.resolve('pending'),
        ]),
        'pending',
      );

      producer.releaseProvider();
      await ownerReleased.promise;
      await runtimeDrain.ownerIsolationDrain;
      await Promise.all([running, runtimeDrain.reclaimDrain]);
      assert.equal(ownerActive, false);
      assert.deepEqual([...inFlight], []);
      const [run] = await runStore.listSessionRuns(session.id);
      assert.equal(run?.status, 'cancelled');
    });
  });

  test('provisional bind is fenced before external authority reentry and release failure is canonical', async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      const releaseFailure = new Error('Host run owner release failed');
      const delegate = interactionAuthority({
        release: () => {
          throw releaseFailure;
        },
      });
      let manager!: SessionManager;
      let runtimeDrain: ReturnType<SessionManager['beginRuntimeDrain']> | undefined;
      let backendFactoryStarted = false;
      const interactions: RuntimeInteractionAuthority = {
        bindRun: (identity) => {
          const owner = delegate.bindRun(identity);
          runtimeDrain = manager.beginRuntimeDrain();
          return owner;
        },
      };
      const backends = new BackendRegistry();
      backends.register('fake', (context) => {
        backendFactoryStarted = true;
        return new DrainBackend(context.sessionId);
      });
      manager = managerFor({
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution: {
          kind: 'hosted',
          interactionAuthority: interactions,
          messageAuthority: messageAuthority(),
        },
      });
      const session = await manager.createSession(sessionInput(root, 'Provisional bind'));
      const running = drain(
        manager.sendMessage(session.id, {
          turnId: 'turn-provisional-bind',
          text: 'reenter drain while binding authority',
        }),
      );
      const isReleaseFailure = (error: unknown): boolean =>
        error instanceof RuntimeInteractionFailStopError &&
        error.authorityFailure === releaseFailure;

      await assert.rejects(running, isReleaseFailure);
      assert.ok(runtimeDrain);
      await assert.rejects(runtimeDrain.ownerIsolationDrain, isReleaseFailure);
      await assert.rejects(runtimeDrain.reclaimDrain, isReleaseFailure);
      assert.equal(backendFactoryStarted, false);
      const [run] = await runStore.listSessionRuns(session.id);
      assert.equal(run?.status, 'cancelled');
    });
  });

  test('composition isolation waits registered successor effects while provider settlement remains reclaim-only', async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      const interactions = interactionAuthority();
      const backendRegistered = gate();
      let backend: RegisteredEffectIsolationBackend | undefined;
      const backends = new BackendRegistry();
      backends.register('fake', (context) => {
        backend = new RegisteredEffectIsolationBackend(context.sessionId);
        backendRegistered.release();
        return backend;
      });
      const manager = managerFor({
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution: {
          kind: 'hosted',
          interactionAuthority: interactions,
          messageAuthority: messageAuthority(),
        },
      });
      const session = await manager.createSession(sessionInput(root, 'Isolation'));
      const running = drain(
        manager.sendMessage(session.id, {
          turnId: 'turn-isolation',
          text: 'hold a registered successor effect and provider work',
        }),
      );
      void running.catch(() => undefined);
      await backendRegistered.promise;
      await backend!.entered.promise;
      const fatal = new RuntimeInteractionFailStopError(
        'canonical hosted failure',
        new Error('authority failed'),
      );

      const failStop = manager.installInteractionFailStop(fatal);
      backend!.releaseSuccessorEffect();
      await failStop.ownerIsolationDrain;
      let lateEffectStarted = false;
      assert.throws(
        () =>
          backend!.control.runSuccessorEffect('tool_execution', async () => {
            lateEffectStarted = true;
          }),
        (error: unknown) => error === fatal,
      );
      assert.equal(lateEffectStarted, false);

      backend!.releaseProvider();
      await assert.rejects(failStop.reclaimDrain, (error: unknown) => error === fatal);
      await assert.rejects(running, (error: unknown) => error === fatal);
    });
  });

  test('composition isolation preserves a registered successor-effect rejection', async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      const interactions = interactionAuthority();
      const backendRegistered = gate();
      let backend: RegisteredEffectIsolationBackend | undefined;
      const backends = new BackendRegistry();
      backends.register('fake', (context) => {
        backend = new RegisteredEffectIsolationBackend(context.sessionId);
        backendRegistered.release();
        return backend;
      });
      const manager = managerFor({
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution: {
          kind: 'hosted',
          interactionAuthority: interactions,
          messageAuthority: messageAuthority(),
        },
      });
      const session = await manager.createSession(sessionInput(root, 'Isolation rejection'));
      const running = drain(
        manager.sendMessage(session.id, {
          turnId: 'turn-isolation-rejection',
          text: 'reject a registered successor effect',
        }),
      );
      void running.catch(() => undefined);
      await backendRegistered.promise;
      await backend!.entered.promise;
      const fatal = new RuntimeInteractionFailStopError(
        'canonical hosted failure',
        new Error('authority failed'),
      );
      const effectFailure = new Error('registered artifact persistence failed');

      backend!.failSuccessorEffect(effectFailure);
      await Promise.resolve();
      const failStop = manager.installInteractionFailStop(fatal);
      await assert.rejects(
        failStop.ownerIsolationDrain,
        (error: unknown) => error === effectFailure,
      );

      backend!.releaseProvider();
      await assert.rejects(failStop.reclaimDrain, (error: unknown) => error === effectFailure);
      await assert.rejects(running, (error: unknown) => error === fatal);
    });
  });

  test('backend isolation controller rejection rejects owner isolation without skipping admitted effects', async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      const interactions = interactionAuthority();
      const backendRegistered = gate();
      const isolationFailure = new Error('backend isolation controller failed');
      let backend: RegisteredEffectIsolationBackend | undefined;
      const backends = new BackendRegistry();
      backends.register('fake', (context) => {
        backend = new RegisteredEffectIsolationBackend(context.sessionId, isolationFailure);
        backendRegistered.release();
        return backend;
      });
      const manager = managerFor({
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution: {
          kind: 'hosted',
          interactionAuthority: interactions,
          messageAuthority: messageAuthority(),
        },
      });
      const session = await manager.createSession(sessionInput(root, 'Isolation controller'));
      const running = drain(
        manager.sendMessage(session.id, {
          turnId: 'turn-isolation-controller',
          text: 'fail backend isolation after effect admission',
        }),
      );
      void running.catch(() => undefined);
      await backendRegistered.promise;
      await backend!.entered.promise;

      const runtimeDrain = manager.beginRuntimeDrain();
      backend!.releaseSuccessorEffect();
      backend!.releaseProvider();
      await assert.rejects(
        runtimeDrain.ownerIsolationDrain,
        (error: unknown) => error === isolationFailure,
      );

      await runtimeDrain.reclaimDrain;
      await running;
    });
  });

  test('consumer abandon closes parked Interactions before aborting the backend and commits one failed fact', async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      const order: string[] = [];
      let question: RuntimeUserQuestionContinuation | undefined;
      let acceptedQuestion:
        | Parameters<RuntimeInteractionContinuationAuthority['acceptUserQuestionRequest']>[0]
        | undefined;
      let backend: ObservedFakeBackend | undefined;
      let reentrantClosureError: unknown;
      const interactions = interactionAuthority({
        acceptUserQuestionRequest: async (input) => {
          acceptedQuestion = input;
          const { continuation } = input;
          question = continuation;
        },
        close: async (reason) => {
          order.push(`close:${reason}`);
          try {
            backend!.cachedInteractions.acceptUserQuestionRequest(acceptedQuestion!);
          } catch (error) {
            reentrantClosureError = error;
          }
          question?.applyClosure(reason);
        },
      });
      const backends = new BackendRegistry();
      backends.register('fake', (context) => {
        backend = new ObservedFakeBackend(context, order);
        return backend;
      });
      const manager = managerFor({
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution: {
          kind: 'hosted',
          interactionAuthority: interactions,
          messageAuthority: messageAuthority(),
        },
      });
      const session = await manager.createSession(sessionInput(root, 'Abandon'));
      const iterator = manager
        .sendMessage(session.id, {
          turnId: 'turn-abandon',
          text: FAKE_ASK_USER_QUESTION_PROMPT,
        })
        [Symbol.asyncIterator]();

      assert.equal((await iterator.next()).value?.type, 'tool_start');
      assert.equal((await iterator.next()).value?.type, 'user_question_request');
      assert.ok(question);
      await assert.rejects(async () => {
        await iterator.return?.(undefined);
      }, /backend cancellation failed/);

      assert.deepEqual(order, ['close:turn_terminal', 'backend_stop']);
      const [run] = await runStore.listSessionRuns(session.id);
      assert.equal(run?.status, 'failed');
      const terminal = await terminalEvents(runtimeEventStore, session.id, run!.runId);
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0]?.status, 'failed');
      assert.equal(backend!.receivedGlobalExecutionCapability, false);
      assert.equal('close' in backend!.cachedInteractions, false);
      assert.equal('release' in backend!.cachedInteractions, false);
      assert.equal('delegate' in backend!.cachedInteractions, false);
      assert.ok(reentrantClosureError instanceof RuntimeInteractionAdmissionRejectedError);
      assert.equal(reentrantClosureError.reason, 'run_closed');
      assert.equal(reentrantClosureError.closureReason, 'turn_terminal');
      assert.ok(acceptedQuestion);
      assert.throws(
        () => backend!.cachedInteractions.acceptUserQuestionRequest(acceptedQuestion!),
        (error: unknown) => {
          assert.ok(error instanceof RuntimeInteractionAdmissionRejectedError);
          assert.equal(error.reason, 'run_closed');
          assert.equal(error.closureReason, 'turn_terminal');
          return true;
        },
      );
    });
  });

  test('semantic compaction isolates admitted persistence and rejects recorders after a delayed summary', async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      const admittedRecorderStarted = gate();
      const releaseAdmittedRecorder = gate();
      const delayedSummarizerStarted = gate();
      const releaseDelayedSummarizer = gate();
      const isolationOrder: string[] = [];
      const recordersAdmittedAfterFence: string[] = [];
      const backends = new BackendRegistry();
      backends.register('ai-sdk', (context) => {
        const delayed = context.header.name === 'Delayed semantic summary';
        let streamCalls = 0;
        const model = new MockLanguageModelV4({
          doGenerate: async () => {
            if (delayed) {
              delayedSummarizerStarted.release();
              await releaseDelayedSummarizer.promise;
            }
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    established_findings: ['A large tool result was inspected.'],
                    decisions: [],
                    failed_paths: [],
                    partial_work_product: [],
                    action_in_progress: 'Continue from the preserved recent execution episode.',
                  }),
                },
              ],
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage: {
                inputTokens: { total: 21, noCache: 21, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 13, text: 13, reasoning: 0 },
              },
              warnings: [],
            };
          },
          doStream: async () => {
            streamCalls += 1;
            const chunks: LanguageModelV4StreamPart[] =
              streamCalls <= 2
                ? [
                    { type: 'stream-start', warnings: [] },
                    {
                      type: 'tool-call',
                      toolCallId: `tool-${context.sessionId}-${streamCalls}`,
                      toolName: 'Read',
                      input: JSON.stringify({ path: streamCalls === 1 ? 'large.log' : 'next.log' }),
                    },
                    {
                      type: 'finish',
                      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                      usage: {
                        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 1, text: 1, reasoning: 0 },
                      },
                    },
                  ]
                : [
                    { type: 'stream-start', warnings: [] },
                    {
                      type: 'finish',
                      finishReason: { unified: 'stop', raw: 'stop' },
                      usage: {
                        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 1, text: 1, reasoning: 0 },
                      },
                    },
                  ];
            return {
              stream: simulateReadableStream({
                chunks,
                initialDelayInMs: null,
                chunkDelayInMs: null,
              }),
            };
          },
        });
        return new AiSdkBackend({
          execution: context.execution,
          sessionId: context.sessionId,
          header: context.header,
          appendMessage: (message) => context.store.appendMessage(context.sessionId, message),
          connection: testConnection(),
          apiKey: 'sk-test',
          modelId: 'mock-model',
          permissionEngine: new PermissionEngine({ newId: ids('permission'), now: clock(2_000) }),
          modelFactory: () => model,
          tools: [
            {
              name: 'Read',
              description: 'Read a test file',
              parameters: z.object({ path: z.string() }),
              permissionRequired: false,
              impl: async ({ path }) => ({
                body:
                  path === 'large.log'
                    ? 'SEMANTIC_LIFECYCLE_RAW_OUTPUT'.repeat(180)
                    : 'preserved recent result',
              }),
            },
          ],
          contextBudget: {
            charsPerToken: 1,
            activeToolResultPrune: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
            semanticCompact: {
              enabled: true,
              mode: 'replace',
              minStepNumber: 1,
              minRecentMessages: 0,
              maxActiveEstimatedTokens: 1,
              highWaterRatio: 0.1,
              minSafePrefixEstimatedTokens: 1,
              minNewPrefixEstimatedTokens: 1,
              maxSummaryEstimatedTokens: 1_024,
              minSavingsTokens: 1,
              minSavingsRatio: 0,
            },
          },
          archiveToolResult: async () => ({ artifactId: `archive-${context.sessionId}` }),
          recordLlmCall: async (record) => {
            if (record.callKind !== 'semantic_compact') return;
            if (delayed) {
              recordersAdmittedAfterFence.push('delayed_summary_telemetry');
              return;
            }
            isolationOrder.push('recorder_started');
            admittedRecorderStarted.release();
            await releaseAdmittedRecorder.promise;
            isolationOrder.push('recorder_finished');
          },
          recordSemanticCompactBlock: async () => {
            recordersAdmittedAfterFence.push(
              delayed ? 'delayed_summary_block' : 'admitted_summary_block',
            );
          },
          newId: ids(delayed ? 'delayed-backend' : 'admitted-backend'),
          now: clock(3_000),
        });
      });
      const manager = managerFor({
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution: {
          kind: 'hosted',
          interactionAuthority: interactionAuthority(),
          messageAuthority: messageAuthority(),
        },
      });
      const admittedSession = await manager.createSession({
        ...sessionInput(root, 'Admitted semantic recorder'),
        backend: 'ai-sdk',
        llmConnectionSlug: 'test',
      });
      const delayedSession = await manager.createSession({
        ...sessionInput(root, 'Delayed semantic summary'),
        backend: 'ai-sdk',
        llmConnectionSlug: 'test',
      });
      const admittedRun = drain(
        manager.sendMessage(admittedSession.id, {
          turnId: 'turn-admitted-semantic-recorder',
          text: 'inspect the large result',
        }),
      );
      const delayedRun = drain(
        manager.sendMessage(delayedSession.id, {
          turnId: 'turn-delayed-semantic-summary',
          text: 'inspect the large result',
        }),
      );
      void admittedRun.catch(() => undefined);
      void delayedRun.catch(() => undefined);
      await Promise.all([admittedRecorderStarted.promise, delayedSummarizerStarted.promise]);

      const fatal = new RuntimeInteractionFailStopError(
        'semantic persistence admission fenced',
        new Error('Interaction authority failed'),
      );
      const failStop = manager.installInteractionFailStop(fatal);
      const isolated = failStop.ownerIsolationDrain.then(() => {
        isolationOrder.push('owner_isolated');
      });
      releaseAdmittedRecorder.release();
      await isolated;
      assert.deepEqual(isolationOrder, ['recorder_started', 'recorder_finished', 'owner_isolated']);

      releaseDelayedSummarizer.release();
      await assert.rejects(admittedRun, (error: unknown) => error === fatal);
      await assert.rejects(delayedRun, (error: unknown) => error === fatal);
      await assert.rejects(failStop.reclaimDrain, (error: unknown) => error === fatal);
      assert.deepEqual(recordersAdmittedAfterFence, []);
    });
  });

  test('provider failure claims the terminal before a later stop and commits one failed RuntimeEvent fact', {
    timeout: 5_000,
  }, async () => {
    await withRuntimeStores(async ({ store, runStore, runtimeEventStore, root }) => {
      const failProvider = gate();
      const partialTextObserved = gate();
      const failureClosureStarted = gate();
      const releaseFailureClosure = gate();
      const providerFailure = new Error('provider stream failed after partial output');
      const interactions = interactionAuthority({
        close: async () => {
          failureClosureStarted.release();
          await releaseFailureClosure.promise;
        },
      });
      const backends = new BackendRegistry();
      backends.register('ai-sdk', (context) => {
        const backend = new AiSdkBackend({
          execution: context.execution,
          sessionId: context.sessionId,
          header: context.header,
          appendMessage: (message) => context.store.appendMessage(context.sessionId, message),
          connection: testConnection(),
          apiKey: 'sk-test',
          modelId: 'mock-model',
          permissionEngine: new PermissionEngine({ newId: ids('permission'), now: clock(2_000) }),
          modelFactory: () =>
            new MockLanguageModelV4({
              doStream: async () => ({
                stream: new ReadableStream<LanguageModelV4StreamPart>({
                  start(controller) {
                    controller.enqueue({ type: 'stream-start', warnings: [] });
                    controller.enqueue({ type: 'text-start', id: 'text-1' });
                    controller.enqueue({
                      type: 'text-delta',
                      id: 'text-1',
                      delta: 'partial answer',
                    });
                    void failProvider.promise.then(() => {
                      controller.error(providerFailure);
                    });
                  },
                }),
              }),
            }),
          tools: [],
          newId: ids('backend'),
          now: clock(3_000),
        });
        return backend;
      });
      const manager = managerFor({
        store,
        runStore,
        runtimeEventStore,
        backends,
        execution: {
          kind: 'hosted',
          interactionAuthority: interactions,
          messageAuthority: messageAuthority(),
        },
      });
      const session = await manager.createSession({
        ...sessionInput(root, 'Provider failure'),
        backend: 'ai-sdk',
        llmConnectionSlug: 'test',
      });
      const running = (async () => {
        for await (const event of manager.sendMessage(session.id, {
          turnId: 'turn-provider-failure',
          text: 'answer then fail',
        })) {
          if (event.type === 'text_delta' && event.text === 'partial answer') {
            partialTextObserved.release();
          }
        }
      })();
      void running.catch(() => undefined);
      await partialTextObserved.promise;
      failProvider.release();
      await failureClosureStarted.promise;

      await manager.stopSession(session.id, { source: 'stop_button' });
      releaseFailureClosure.release();
      await running;

      const [run] = await runStore.listSessionRuns(session.id);
      assert.equal(run?.status, 'failed');
      assert.ok(run?.failureClass);
      const terminal = await terminalEvents(runtimeEventStore, session.id, run!.runId);
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0]?.status, 'failed');
      assert.equal(
        terminal.some((event) => event.actions?.stateDelta?.abortSource === 'stop_button'),
        false,
      );
    });
  });
});

class DrainBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly entered = gate();
  private readonly exit = gate();
  stopCalls = 0;
  sendCalls = 0;
  private stopped = false;

  constructor(readonly sessionId: string) {}

  [RUNTIME_BIND_HOSTED_RUN](): RuntimeHostedBackendRunBinding {
    return {
      isolateRegisteredSuccessorEffects: async () => {},
      revoke: () => {},
    };
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.sendCalls += 1;
    this.entered.release();
    yield {
      type: 'text_delta',
      id: `${input.turnId}-delta`,
      turnId: input.turnId,
      ts: 1,
      messageId: `${input.turnId}-message`,
      text: 'active',
    };
    await this.exit.promise;
    if (this.stopped) {
      yield {
        type: 'abort',
        id: `${input.turnId}-abort`,
        turnId: input.turnId,
        ts: 2,
        reason: 'user_stop',
      };
      return;
    }
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 2,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.stopped = true;
    this.exit.release();
  }

  async respondToPermission(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class RejectingSendHostedBackend implements AgentBackend {
  readonly kind = 'fake' as const;

  constructor(
    readonly sessionId: string,
    private readonly failure: Error,
  ) {}

  [RUNTIME_BIND_HOSTED_RUN](): RuntimeHostedBackendRunBinding {
    return {
      isolateRegisteredSuccessorEffects: async () => {},
      revoke: () => {},
    };
  }

  async *send(): AsyncIterable<SessionEvent> {
    throw this.failure;
  }

  async stop(): Promise<void> {}
  async respondToPermission(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class InFlightSteeringBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly leasePulled = gate();
  readonly stopEntered = gate();
  private readonly provider = gate();

  constructor(public sessionId: string) {}

  [RUNTIME_BIND_HOSTED_RUN](): RuntimeHostedBackendRunBinding {
    return {
      isolateRegisteredSuccessorEffects: async () => {},
      revoke: () => {},
    };
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const leases = input.pullSteering?.() ?? [];
    this.leasePulled.release();
    try {
      yield {
        type: 'text_delta',
        id: `${input.turnId}-delta`,
        turnId: input.turnId,
        ts: 1,
        messageId: `${input.turnId}-message`,
        text: 'provider pending',
      };
      await this.provider.promise;
      yield {
        type: 'abort',
        id: `${input.turnId}-abort`,
        turnId: input.turnId,
        ts: 2,
        reason: 'user_stop',
      };
    } finally {
      input.nackSteering?.(leases.map((lease) => lease.id));
    }
  }

  async stop(): Promise<void> {
    this.stopEntered.release();
  }

  releaseProvider(): void {
    this.provider.release();
  }

  async respondToPermission(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class PendingStopBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly stopEntered = gate();
  private readonly stopRelease = gate();
  private readonly sendRelease = gate();
  stopCalls = 0;

  constructor(readonly sessionId: string) {}

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'text_delta',
      id: `${input.turnId}-delta`,
      turnId: input.turnId,
      ts: 1,
      messageId: `${input.turnId}-message`,
      text: 'active',
    };
    await this.sendRelease.promise;
    yield {
      type: 'abort',
      id: `${input.turnId}-abort`,
      turnId: input.turnId,
      ts: 2,
      reason: 'user_stop',
    };
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.stopEntered.release();
    await this.stopRelease.promise;
    this.sendRelease.release();
  }

  releaseStop(): void {
    this.stopRelease.release();
  }

  async respondToPermission(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class RejectingDisposeBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly firstDisposeEntered = gate();
  disposeCalls = 0;
  private readonly rejectFirst = gate();

  constructor(
    public sessionId: string,
    private readonly disposalFailure: Error,
  ) {}

  [RUNTIME_BIND_HOSTED_RUN](_control: RuntimeHostedRunControl): RuntimeHostedBackendRunBinding {
    return {
      isolateRegisteredSuccessorEffects: async () => {},
      revoke: () => {},
    };
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'complete',
      id: `${input.turnId}-complete`,
      turnId: input.turnId,
      ts: 1,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(): Promise<void> {}

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    if (this.disposeCalls === 1) {
      this.firstDisposeEntered.release();
      await this.rejectFirst.promise;
      throw this.disposalFailure;
    }
  }

  rejectFirstDispose(): void {
    this.rejectFirst.release();
  }
}

class AckGatedPiTransport implements PiAgentTransport {
  readonly sendEntered = gate();
  readonly stopEntered = gate();
  private readonly sendRelease = gate();
  private readonly isolation = gate();

  async *send(): AsyncIterable<PiAgentFrame> {
    this.sendEntered.release();
    yield { type: 'text_delta', text: 'provider still settling' };
    await this.sendRelease.promise;
    yield { type: 'complete', stopReason: 'end_turn' };
  }

  stop(): void {
    this.stopEntered.release();
  }

  isolateRegisteredSuccessorSideEffects(): Promise<void> {
    return this.isolation.promise;
  }

  acknowledgeIsolation(): void {
    this.isolation.release();
  }

  releaseSend(): void {
    this.sendRelease.release();
  }
}

class RegisteredEffectIsolationBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly entered = gate();
  private readonly successorEffect = gate();
  private readonly provider = gate();
  private runControl: RuntimeHostedRunControl | undefined;
  private cachedRunControl: RuntimeHostedRunControl | undefined;

  constructor(
    readonly sessionId: string,
    private readonly isolationFailure?: unknown,
  ) {}

  get control(): RuntimeHostedRunControl {
    if (!this.cachedRunControl) throw new Error('Hosted control was not bound');
    return this.cachedRunControl;
  }

  [RUNTIME_BIND_HOSTED_RUN](control: RuntimeHostedRunControl): RuntimeHostedBackendRunBinding {
    this.runControl = control;
    this.cachedRunControl = control;
    return {
      isolateRegisteredSuccessorEffects: async () => {
        if (this.isolationFailure !== undefined) throw this.isolationFailure;
      },
      revoke: () => {
        this.runControl = undefined;
      },
    };
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.control.runSuccessorEffect('tool_execution', async () => {
      await this.successorEffect.promise;
    });
    this.entered.release();
    yield {
      type: 'text_delta',
      id: `${input.turnId}-delta`,
      turnId: input.turnId,
      ts: 1,
      messageId: `${input.turnId}-message`,
      text: 'provider pending',
    };
    await this.provider.promise;
  }

  releaseSuccessorEffect(): void {
    this.successorEffect.release();
  }

  failSuccessorEffect(error: unknown): void {
    this.successorEffect.fail(error);
  }

  releaseProvider(): void {
    this.provider.release();
  }

  async stop(): Promise<void> {}
  async respondToPermission(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class ObservedFakeBackend extends FakeBackend {
  private interactions: RuntimeInteractionRunFacet | undefined;
  receivedGlobalExecutionCapability = false;

  constructor(
    context: BackendFactoryContext,
    private readonly order: string[],
  ) {
    super({
      execution: context.execution,
      sessionId: context.sessionId,
      header: context.header,
      store: context.store,
      appendMessage: context.appendMessage,
    });
  }

  get cachedInteractions(): RuntimeInteractionRunFacet {
    if (!this.interactions) throw new Error('Hosted Interaction facet was not bound');
    return this.interactions;
  }

  override [RUNTIME_BIND_HOSTED_RUN](
    control: RuntimeHostedRunControl,
  ): RuntimeHostedBackendRunBinding {
    this.receivedGlobalExecutionCapability = 'capability' in control;
    this.interactions = control.interactions;
    return super[RUNTIME_BIND_HOSTED_RUN](control);
  }

  override async stop(): Promise<void> {
    this.order.push('backend_stop');
    await super.stop();
    throw new Error('backend cancellation failed');
  }
}

interface RuntimeStores {
  root: string;
  store: SessionStore;
  runStore: AgentRunStore;
  runtimeEventStore: RuntimeEventStore;
}

async function withRuntimeStores(run: (stores: RuntimeStores) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-lifecycle-'));
  const stores: RuntimeStores = {
    root,
    store: createSessionStore(root),
    runStore: createAgentRunStore(root),
    runtimeEventStore: createRuntimeEventStore(root),
  };
  try {
    await run(stores);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function managerFor(input: {
  store: SessionStore;
  runStore: AgentRunStore;
  runtimeEventStore: RuntimeEventStore;
  backends: BackendRegistry;
  execution: ConstructorParameters<typeof SessionManager>[0]['execution'];
}): SessionManager {
  return new SessionManager({
    ...input,
    newId: ids('runtime'),
    now: clock(1_000),
    runtimeSource: 'test',
  });
}

function sessionInput(root: string, name: string) {
  return {
    cwd: root,
    backend: 'fake' as const,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask' as const,
    name,
    labels: [],
  };
}

function interactionAuthority(
  overrides: Partial<RuntimeInteractionContinuationAuthority> & {
    close?: RuntimeInteractionRunOwner['close'];
    release?: RuntimeInteractionRunOwner['release'];
  } = {},
): RuntimeInteractionAuthority {
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected Interaction authority call');
  };
  return {
    bindRun: (identity): RuntimeInteractionRunOwner => ({
      ...identity,
      acceptPermissionRequest: unexpected,
      commitPermissionAnswer: unexpected,
      commitPermissionTimeout: unexpected,
      acceptUserQuestionRequest: unexpected,
      close: async () => {},
      release: () => {},
      ...overrides,
    }),
  };
}

function messageAuthority(
  bindRun: RuntimeMessageAuthority['bindRun'] = (identity): RuntimeMessageRunOwner => ({
    ...identity,
    pull: () => [],
    ack: () => {},
    nack: () => {},
    release: () => {},
  }),
): RuntimeMessageAuthority {
  return { bindRun };
}

async function terminalEvents(
  store: RuntimeEventStore,
  sessionId: string,
  runId: string,
): Promise<RuntimeEvent[]> {
  return (await store.readRuntimeEvents(sessionId, runId)).filter(
    (event) => event.actions?.endInvocation === true,
  );
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of iterable) {
    // Consume the Host-owned execution stream through its terminal boundary.
  }
}

interface Gate {
  promise: Promise<void>;
  release(): void;
  fail(error: unknown): void;
}

function gate(): Gate {
  let release!: () => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

function ids(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function clock(start: number): () => number {
  let now = start;
  return () => ++now;
}

function testConnection(): LlmConnection {
  return {
    slug: 'test',
    name: 'Test',
    providerType: 'openai',
    defaultModel: 'mock-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
