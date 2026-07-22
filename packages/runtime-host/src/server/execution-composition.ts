import { randomUUID } from 'node:crypto';
import { BackendRegistry, FakeBackend, SessionManager } from '@maka/runtime';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import type { RuntimeHostComposition, RuntimeHostCompositionContext } from './host-kernel.js';
import { type HostMessageRootPort, HostMessageCoordinator } from './message-coordinator.js';
import type { AllDomainOperationHandlerMap } from './operation-dispatcher.js';
import { RootAdmissionOwner } from './root-admission-owner.js';
import { RootTurnCoordinator } from './root-turn-coordinator.js';
import { SessionAdmissionGate } from './session-admission-gate.js';

export async function createExecutionRuntimeHostComposition(
  context: RuntimeHostCompositionContext,
): Promise<RuntimeHostComposition> {
  const stores = await openInteractiveExecutionStoresForWrite(context.owner.lease);
  const backends = new BackendRegistry();
  backends.register('fake', (backendContext) => new FakeBackend(backendContext));
  const sessionAdmission = new SessionAdmissionGate();
  let rootCoordinator: RootTurnCoordinator | undefined;
  const rootPort: HostMessageRootPort = {
    readSessionHeader: (sessionId) =>
      requireRootCoordinator(rootCoordinator).readSessionHeader(sessionId),
    readRootState: (sessionId) => requireRootCoordinator(rootCoordinator).readRootState(sessionId),
    startFromMessage: (input) => requireRootCoordinator(rootCoordinator).startFromMessage(input),
    claimStop: (input, commitQueueFence) =>
      requireRootCoordinator(rootCoordinator).claimStop(input, commitQueueFence),
  };
  const messages = new HostMessageCoordinator({
    hostEpoch: context.hostEpoch,
    root: rootPort,
    durableProof: {
      readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
        stores.agentRunStore.readRootTurnSourceMessageReceipt(sessionId, messageId),
      readImmutableSessionRuntimeEvents: async (sessionId) => {
        const runs = await stores.agentRunStore.listSessionRuns(sessionId);
        const events = await Promise.all(
          runs.map((run) =>
            stores.runtimeEventStore.readImmutableRuntimeEvents(sessionId, run.runId),
          ),
        );
        return events.flat();
      },
    },
    sessionAdmission,
    acquireResidency: context.acquireResidency,
  });
  const manager = new SessionManager({
    store: stores.sessionStore,
    runStore: stores.agentRunStore,
    runtimeEventStore: stores.runtimeEventStore,
    backends,
    newId: randomUUID,
    now: Date.now,
    messageAuthority: messages,
  });
  const rootAdmissionOwner = new RootAdmissionOwner(stores.agentRunStore);
  rootCoordinator = new RootTurnCoordinator(
    manager,
    stores,
    sessionAdmission,
    rootAdmissionOwner,
    messages,
    context.acquireResidency,
    context.requestDrain,
  );
  const coordinator = rootCoordinator;
  const handlers = {
    ...coordinator.handlers,
    ...messages.handlers,
  } satisfies AllDomainOperationHandlerMap;
  return {
    handlers,
    recover: async () => {
      await coordinator.prepareRecovery();
      await manager.recoverInterruptedSessionsStrict(stores);
      await coordinator.recover();
    },
    close: async () => {
      messages.beginDrain();
      const errors: unknown[] = [];
      try {
        await coordinator.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await messages.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Unable to close Runtime Host execution composition');
      }
    },
  };
}

function requireRootCoordinator(coordinator: RootTurnCoordinator | undefined): RootTurnCoordinator {
  if (!coordinator) throw new Error('Runtime Host root coordinator is not composed');
  return coordinator;
}
