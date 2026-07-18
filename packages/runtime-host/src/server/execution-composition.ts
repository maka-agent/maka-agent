import { randomUUID } from 'node:crypto';
import { BackendRegistry, FakeBackend, SessionManager } from '@maka/runtime';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { createCanonicalSessionProjectionReader } from './canonical-session-projection.js';
import type { RuntimeHostComposition, RuntimeHostCompositionContext } from './host-kernel.js';
import { combineDomainOperationHandlers } from './operation-dispatcher.js';
import { RootTurnCoordinator } from './root-turn-coordinator.js';
import { SessionContinuityCoordinator } from './session-continuity-coordinator.js';

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
  const canonicalProjection = createCanonicalSessionProjectionReader(stores);
  const continuity = new SessionContinuityCoordinator(context.hostEpoch, canonicalProjection.read);
  const coordinator = new RootTurnCoordinator(
    manager,
    stores,
    continuity,
    canonicalProjection.rootAdmissions,
    context.acquireResidency,
    context.requestDrain,
  );
  return {
    handlers: combineDomainOperationHandlers(coordinator.handlers, continuity.handlers),
    continuity,
    recover: async () => {
      await coordinator.prepareRecovery();
      await manager.recoverInterruptedSessionsStrict(stores);
      await coordinator.recover();
    },
    close: async () => {
      try {
        await coordinator.close();
      } finally {
        continuity.close();
      }
    },
  };
}
