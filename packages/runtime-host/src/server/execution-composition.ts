import { randomUUID } from 'node:crypto';
import {
  BackendRegistry,
  FakeBackend,
  type RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  SessionManager,
} from '@maka/runtime';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { createCanonicalSessionProjectionReader } from './canonical-session-projection.js';
import type {
  RuntimeHostComposition,
  RuntimeHostCompositionCloseResult,
  RuntimeHostCompositionContext,
  RuntimeHostFailStopDisposition,
} from './host-kernel.js';
import { HostInteractionAuthority } from './interaction-coordinator.js';
import { combineDomainOperationHandlers } from './operation-dispatcher.js';
import { RootAdmissionOwner } from './root-admission-owner.js';
import { RootTurnCoordinator } from './root-turn-coordinator.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import { SessionContinuityCoordinator } from './session-continuity-coordinator.js';

export async function createExecutionRuntimeHostComposition(
  context: RuntimeHostCompositionContext,
): Promise<RuntimeHostComposition> {
  const stores = await openInteractiveExecutionStoresForWrite(context.owner.lease);
  const sessionAdmission = new SessionAdmissionGate();
  const rootAdmissionOwner = new RootAdmissionOwner();
  const canonicalProjection = createCanonicalSessionProjectionReader(
    stores,
    rootAdmissionOwner.reader,
  );
  const continuity = new SessionContinuityCoordinator(
    context.hostEpoch,
    canonicalProjection.read,
    sessionAdmission,
  );
  let failStopDisposition: RuntimeHostFailStopDisposition | undefined;
  let failStopHandoff!: (error: RuntimeInteractionFailStopError) => void;
  const interaction = new HostInteractionAuthority(
    stores.interactionStore,
    continuity,
    sessionAdmission,
    context.acquireResidency,
    (error) => failStopHandoff(error),
  );
  const backends = new BackendRegistry();
  backends.register('fake', (backendContext) => new FakeBackend(backendContext));
  const manager = new SessionManager({
    store: stores.sessionStore,
    runStore: stores.agentRunStore,
    runtimeEventStore: stores.runtimeEventStore,
    backends,
    newId: randomUUID,
    now: Date.now,
    execution: { kind: 'hosted', interactionAuthority: interaction },
  });
  const coordinator = new RootTurnCoordinator(
    manager,
    stores,
    continuity,
    rootAdmissionOwner.writer,
    context.acquireResidency,
    context.requestDrain,
    sessionAdmission,
    interaction,
  );
  let runtimeDrain: ReturnType<SessionManager['beginRuntimeDrain']> | undefined;
  const beginRuntimeDrain = () => {
    interaction.beginDrain();
    runtimeDrain ??= manager.beginRuntimeDrain();
    observe(runtimeDrain.ownerIsolationDrain);
    observe(runtimeDrain.reclaimDrain);
    return runtimeDrain;
  };
  failStopHandoff = (error) => {
    if (failStopDisposition) return;
    const handoffFailures: unknown[] = [];
    try {
      const runtimeFailStop = manager.installInteractionFailStop(error);
      observe(runtimeFailStop.ownerIsolationDrain);
      observe(runtimeFailStop.reclaimDrain);
      if (runtimeFailStop.error !== error) {
        handoffFailures.push(
          new RuntimeInteractionInvariantError(
            'Runtime installed a different Interaction fail-stop identity',
          ),
        );
      }
    } catch (handoffFailure) {
      handoffFailures.push(handoffFailure);
    }

    let reclaimRoot = () => {};
    try {
      reclaimRoot = coordinator.prepareFailStopReclaim(error);
    } catch (handoffFailure) {
      handoffFailures.push(handoffFailure);
    }
    try {
      continuity.close();
    } catch (handoffFailure) {
      handoffFailures.push(handoffFailure);
    }
    const cause =
      handoffFailures.length === 0
        ? error
        : new AggregateError(
            [error, ...handoffFailures],
            'Runtime Host Interaction fail-stop handoff failed',
          );
    let reclaimed = false;
    const disposition: RuntimeHostFailStopDisposition = Object.freeze({
      kind: 'fail_stop' as const,
      cause,
      reclaimAfterOwnerIsolation: () => {
        if (reclaimed) return;
        reclaimed = true;
        interaction.reclaimAfterOwnerIsolation();
        reclaimRoot();
      },
    });
    failStopDisposition = disposition;
    context.requestFailStop(disposition);
  };
  let closeTask: Promise<RuntimeHostCompositionCloseResult> | undefined;
  return {
    handlers: combineDomainOperationHandlers(
      coordinator.handlers,
      interaction.handlers,
      continuity.handlers,
    ),
    continuity,
    beginDrain: () => {
      interaction.beginDrain();
      if (!failStopDisposition) beginRuntimeDrain();
    },
    recover: async () => {
      await coordinator.prepareRecovery();
      await interaction.recoverPendingAfterHostRestart();
      await manager.recoverInterruptedSessionsStrict(stores);
      await coordinator.recover();
    },
    close: () => {
      if (failStopDisposition) {
        closeTask ??= Promise.resolve(failStopDisposition);
        return closeTask;
      }
      const drain = beginRuntimeDrain();
      closeTask ??= closeComposition(
        coordinator,
        interaction,
        continuity,
        drain,
        () => failStopDisposition,
      );
      return closeTask;
    },
  };
}

async function closeComposition(
  coordinator: RootTurnCoordinator,
  interaction: HostInteractionAuthority,
  continuity: SessionContinuityCoordinator,
  runtimeDrain: ReturnType<SessionManager['beginRuntimeDrain']>,
  getFailStop: () => RuntimeHostFailStopDisposition | undefined,
): Promise<RuntimeHostCompositionCloseResult> {
  const existingFailStop = getFailStop();
  if (existingFailStop) {
    continuity.close();
    return existingFailStop;
  }

  const normalClose = closeNormally(coordinator, interaction, continuity, runtimeDrain);
  const observedNormal = normalClose.then(
    (result) => ({ kind: 'fulfilled' as const, result }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );
  const winner = await Promise.race([
    observedNormal,
    interaction.fatalSignal.then(() => ({ kind: 'fatal' as const })),
  ]);
  if (winner.kind === 'fatal') {
    continuity.close();
    return requireFailStopDisposition(getFailStop());
  }
  const lateFailStop = getFailStop();
  if (lateFailStop) {
    continuity.close();
    return lateFailStop;
  }
  if (winner.kind === 'rejected') throw winner.error;
  return winner.result;
}

async function closeNormally(
  coordinator: RootTurnCoordinator,
  interaction: HostInteractionAuthority,
  continuity: SessionContinuityCoordinator,
  runtimeDrain: ReturnType<SessionManager['beginRuntimeDrain']>,
): Promise<{ readonly kind: 'clean' }> {
  const errors: unknown[] = [];
  try {
    const outcomes = await Promise.allSettled([
      coordinator.close(),
      runtimeDrain.ownerIsolationDrain,
      runtimeDrain.reclaimDrain,
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') errors.push(outcome.reason);
    }
    await interaction.close().catch((error: unknown) => errors.push(error));
  } finally {
    continuity.close();
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Runtime Host composition did not close cleanly');
  }
  return { kind: 'clean' };
}

function observe(task: Promise<unknown>): void {
  void task.catch(() => undefined);
}

function requireFailStopDisposition(
  disposition: RuntimeHostFailStopDisposition | undefined,
): RuntimeHostFailStopDisposition {
  if (!disposition) {
    throw new Error('Interaction fatal signal has no fail-stop disposition');
  }
  return disposition;
}
