import { randomUUID } from 'node:crypto';
import { BackendRegistry, FakeBackend, SessionManager } from '@maka/runtime';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import type { RuntimeHostComposition, RuntimeHostCompositionContext } from './host-kernel.js';
import { RootAdmissionOwner } from './root-admission-owner.js';
import { RootTurnCoordinator } from './root-turn-coordinator.js';
import { SessionAdmissionGate } from './session-admission-gate.js';

export async function createExecutionRuntimeHostComposition(
  context: RuntimeHostCompositionContext,
): Promise<RuntimeHostComposition> {
  const stores = await openInteractiveExecutionStoresForWrite(context.owner.lease);
  const backends = new BackendRegistry();
  backends.register('fake', (backendContext) => new FakeBackend(backendContext));
  const manager = new SessionManager({
    store: stores.sessionStore,
    runStore: stores.agentRunStore,
    runtimeEventStore: stores.runtimeEventStore,
    backends,
    newId: randomUUID,
    now: Date.now,
  });
  const sessionAdmission = new SessionAdmissionGate();
  const rootAdmissionOwner = new RootAdmissionOwner(stores.agentRunStore);
  const coordinator = new RootTurnCoordinator(
    manager,
    stores,
    sessionAdmission,
    rootAdmissionOwner,
    context.acquireResidency,
    context.requestDrain,
  );
  return {
    handlers: coordinator.handlers,
    recover: async () => {
      await coordinator.prepareRecovery();
      await manager.recoverInterruptedSessionsStrict(stores);
      await coordinator.recover();
    },
    close: async () => {
      try {
        await coordinator.close();
      } finally {
        stores.sessionStore.close?.();
      }
    },
  };
}
