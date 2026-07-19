import { randomUUID } from 'node:crypto';
import { BackendRegistry, FakeBackend, SessionManager } from '@maka/runtime';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import type { RuntimeHostComposition, RuntimeHostCompositionContext } from './host-kernel.js';
import { RootTurnCoordinator } from './root-turn-coordinator.js';

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
  const coordinator = new RootTurnCoordinator(
    manager,
    stores,
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
    close: () => coordinator.close(),
  };
}
