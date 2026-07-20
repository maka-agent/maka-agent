import { randomUUID } from 'node:crypto';
import {
  BackendRegistry,
  FakeBackend,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  type RuntimeMessageAuthority,
  type RuntimeMessageRunOwner,
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
import {
  HostMessageCoordinator,
  type HostMessageRootPort,
} from './message-coordinator.js';
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
  let messages: HostMessageCoordinator | undefined;
  const canonicalProjection = createCanonicalSessionProjectionReader(
    stores,
    rootAdmissionOwner.reader,
    (sessionId) => requireMessages(messages).projection(sessionId),
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
  let coordinator: RootTurnCoordinator | undefined;
  const rootPort: HostMessageRootPort = {
    readSessionHeader: (sessionId) => requireRootCoordinator(coordinator).readSessionHeader(sessionId),
    readRootState: (sessionId) => requireRootCoordinator(coordinator).readRootState(sessionId),
    startFromMessage: (input, admission) =>
      requireRootCoordinator(coordinator).startFromMessage(input, admission),
    claimStop: (input, admission, commitQueueFence) =>
      requireRootCoordinator(coordinator).claimStop(input, admission, commitQueueFence),
  };
  const messageCoordinator = new HostMessageCoordinator({
    hostEpoch: context.hostEpoch,
    root: rootPort,
    durableProof: {
      readRootTurnSourceMessageReceipt: (sessionId, messageId) =>
        stores.agentRunStore.readRootTurnSourceMessageReceipt(sessionId, messageId),
      readSessionRuntimeEvents: (sessionId) =>
        stores.runtimeEventStore.readSessionRuntimeEvents(sessionId),
    },
    sessionAdmission,
    acquireResidency: context.acquireResidency,
    validateProjectionCapacity: (sessionId, projection) =>
      canonicalProjection.validateMessageQueue(sessionId, projection),
    onProjectionChanged: async (sessionId, _projection, admission) => {
      try {
        await continuity.refreshCanonical(sessionId, admission);
      } catch (error) {
        const fatal = new RuntimeInteractionFailStopError(
          `Could not publish Message projection for Session ${sessionId}`,
          error,
        );
        failStopHandoff(fatal);
        throw fatal;
      }
    },
  });
  messages = messageCoordinator;
  const runtimeMessageAuthority = createFailStopMessageAuthority(
    messageCoordinator,
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
    execution: {
      kind: 'hosted',
      interactionAuthority: interaction,
      messageAuthority: runtimeMessageAuthority,
    },
  });
  const rootCoordinator = new RootTurnCoordinator(
    manager,
    stores,
    continuity,
    rootAdmissionOwner.writer,
    context.acquireResidency,
    context.requestDrain,
    sessionAdmission,
    interaction,
    messageCoordinator,
  );
  coordinator = rootCoordinator;
  let runtimeDrain: ReturnType<SessionManager['beginRuntimeDrain']> | undefined;
  const beginRuntimeDrain = () => {
    messageCoordinator.beginDrain();
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
    let reclaimMessages = () => {};
    try {
      reclaimMessages = messageCoordinator.prepareFailStopReclaim();
    } catch (handoffFailure) {
      handoffFailures.push(handoffFailure);
    }
    try {
      reclaimRoot = rootCoordinator.prepareFailStopReclaim(error);
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
        reclaimMessages();
        reclaimRoot();
      },
    });
    failStopDisposition = disposition;
    context.requestFailStop(disposition);
  };
  let closeTask: Promise<RuntimeHostCompositionCloseResult> | undefined;
  return {
    handlers: combineDomainOperationHandlers(
      rootCoordinator.handlers,
      messageCoordinator.handlers,
      interaction.handlers,
      continuity.handlers,
    ),
    continuity,
    beginDrain: () => {
      messageCoordinator.beginDrain();
      interaction.beginDrain();
      if (!failStopDisposition) beginRuntimeDrain();
    },
    recover: async () => {
      await rootCoordinator.prepareRecovery();
      await interaction.recoverPendingAfterHostRestart();
      await manager.recoverInterruptedSessionsStrict(stores);
      await rootCoordinator.recover();
    },
    close: () => {
      if (failStopDisposition) {
        closeTask ??= Promise.resolve(failStopDisposition);
        return closeTask;
      }
      const drain = beginRuntimeDrain();
      closeTask ??= closeComposition(
        rootCoordinator,
        messageCoordinator,
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
  messages: HostMessageCoordinator,
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

  const normalClose = closeNormally(coordinator, messages, interaction, continuity, runtimeDrain);
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
  messages: HostMessageCoordinator,
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
    await messages.close().catch((error: unknown) => errors.push(error));
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

function requireMessages(messages: HostMessageCoordinator | undefined): HostMessageCoordinator {
  if (!messages) throw new Error('Runtime Host Message coordinator is not bound');
  return messages;
}

function requireRootCoordinator(
  coordinator: RootTurnCoordinator | undefined,
): RootTurnCoordinator {
  if (!coordinator) throw new Error('Runtime Host root coordinator is not bound');
  return coordinator;
}

function createFailStopMessageAuthority(
  authority: RuntimeMessageAuthority,
  onFailStop: (error: RuntimeInteractionFailStopError) => void,
): RuntimeMessageAuthority {
  let fatal: RuntimeInteractionFailStopError | undefined;
  const guard = <T>(operation: () => T): T => {
    if (fatal) throw fatal;
    try {
      return operation();
    } catch (error) {
      fatal =
        error instanceof RuntimeInteractionFailStopError
          ? error
          : new RuntimeInteractionFailStopError(
              'Runtime Host Message authority entered fail-stop',
              error,
            );
      onFailStop(fatal);
      throw fatal;
    }
  };
  const release = (operation: () => void): void => {
    try {
      operation();
    } catch (error) {
      if (!fatal) {
        fatal =
          error instanceof RuntimeInteractionFailStopError
            ? error
            : new RuntimeInteractionFailStopError(
                'Runtime Host Message authority entered fail-stop',
                error,
              );
        onFailStop(fatal);
      }
      throw fatal;
    }
  };
  return {
    bindRun: (identity): RuntimeMessageRunOwner =>
      guard(() => {
        const owner = authority.bindRun(identity);
        return Object.freeze({
          ...identity,
          pull: () => guard(() => owner.pull()),
          ack: (leaseIds: readonly string[]) => guard(() => owner.ack(leaseIds)),
          nack: (leaseIds: readonly string[]) => guard(() => owner.nack(leaseIds)),
          release: () => release(() => owner.release()),
        });
      }),
  };
}
