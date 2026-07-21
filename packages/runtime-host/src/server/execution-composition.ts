import { randomUUID } from 'node:crypto';
import { defaultLocalMemoryMarkdown } from '@maka/core/local-memory';
import { TOOL_BOUNDARY_PROTOCOL_V1 } from '@maka/core/runtime-event';
import {
  BackendRegistry,
  buildBuiltinTools,
  createBuiltinSandboxManager,
  createFilesystemWorkerLaunchSpecProvider,
  FakeBackend,
  FilesystemWorkerClient,
  PermissionEngine,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
  type CreateFilesystemWorkerLaunchSpecProviderInput,
  type FilesystemWorkerLaunchSpecProvider,
  type RuntimeMessageAuthority,
  type RuntimeMessageRunOwner,
  SessionManager,
} from '@maka/runtime';
import { createReadImageSnapshotter } from '@maka/storage';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveMemoryStoreForWrite } from '@maka/storage/memory-store';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { openInteractiveShellRunStoreForWrite } from '@maka/storage/shell-run-store';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-store';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import { createCanonicalSessionProjectionReader } from './canonical-session-projection.js';
import { createHostAiSdkBackend } from './execution-model-composition.js';
import type {
  RuntimeHostComposition,
  RuntimeHostCompositionCloseResult,
  RuntimeHostCompositionContext,
  RuntimeHostFailStopDisposition,
} from './host-kernel.js';
import { HostArtifactCoordinator } from './artifact-coordinator.js';
import { HostInteractionAuthority } from './interaction-coordinator.js';
import { HostMessageCoordinator, type HostMessageRootPort } from './message-coordinator.js';
import { HostMemoryCoordinator } from './memory-coordinator.js';
import { combineDomainOperationHandlers } from './operation-dispatcher.js';
import { RootAdmissionOwner } from './root-admission-owner.js';
import { RootTurnCoordinator } from './root-turn-coordinator.js';
import { HostRuntimePolicyCoordinator } from './runtime-policy-coordinator.js';
import { HostRuntimeResourceCoordinator } from './runtime-resource-coordinator.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import { SessionContinuityCoordinator } from './session-continuity-coordinator.js';
import { HostSkillCatalogCoordinator } from './skill-catalog-coordinator.js';
import { HostSkillCatalogFilesystem } from './skill-catalog-filesystem.js';
import { HostTaskLedgerCoordinator } from './task-ledger-coordinator.js';
import { HostUsagePricingCoordinator } from './usage-pricing-coordinator.js';

export async function createExecutionRuntimeHostComposition(
  context: RuntimeHostCompositionContext,
): Promise<RuntimeHostComposition> {
  const stores = await openInteractiveExecutionStoresForWrite(context.owner.lease);
  const runtimePolicyStores = await openInteractiveRuntimePolicyStoresForWrite(context.owner.lease);
  const taskLedgerStore = await openInteractiveTaskLedgerStoreForWrite(context.owner.lease);
  const artifactStore = await openInteractiveArtifactStoreForWrite(context.owner.lease);
  const memoryStore = await openInteractiveMemoryStoreForWrite(context.owner.lease);
  const usageStores = await openInteractiveUsageStoresForWrite(context.owner.lease);
  const shellRunStore = await openInteractiveShellRunStoreForWrite(context.owner.lease);
  let manager!: SessionManager;
  let failStopHandoff!: (error: RuntimeInteractionFailStopError) => void;
  const refreshBackends = async () => {
    try {
      await manager.refreshIdleBackends();
    } catch (error) {
      failStopHandoff(
        new RuntimeInteractionFailStopError(
          'Could not invalidate Runtime Host backend snapshots after a committed policy change',
          error,
        ),
      );
    }
  };
  const runtimePolicy = new HostRuntimePolicyCoordinator(runtimePolicyStores, refreshBackends);
  const memory = new HostMemoryCoordinator(memoryStore, runtimePolicyStores.runtimePolicy);
  const usagePricing = new HostUsagePricingCoordinator(usageStores);
  const skills = new HostSkillCatalogCoordinator(
    new HostSkillCatalogFilesystem(context.owner.lease),
  );
  const sessionAdmission = new SessionAdmissionGate();
  const taskLedger = new HostTaskLedgerCoordinator(taskLedgerStore, sessionAdmission);
  const artifacts = new HostArtifactCoordinator(artifactStore, sessionAdmission);
  const resources = new HostRuntimeResourceCoordinator({
    store: shellRunStore,
    newId: randomUUID,
    now: Date.now,
    acquireResidency: context.acquireResidency,
  });
  const sandboxManager = createBuiltinSandboxManager();
  const filesystemWorker =
    process.platform === 'darwin' && sandboxManager
      ? new FilesystemWorkerClient({
          sandboxManager,
          getLaunchSpec: createHostFilesystemWorkerLaunchSpecProvider(
            process.versions.electron
              ? {
                  runtime: 'electron',
                  executable: process.execPath,
                  resourcesPath: (process as NodeJS.Process & { readonly resourcesPath: string })
                    .resourcesPath,
                }
              : { runtime: 'node' },
          ),
        })
      : undefined;
  const runtimeTools = buildBuiltinTools({
    shellRuns: resources,
    runtimeResources: resources,
    backgroundTasks: resources,
    ptyControls: resources,
    snapshotImage: createReadImageSnapshotter(artifactStore),
    ...(sandboxManager ? { sandboxManager } : {}),
    ...(filesystemWorker
      ? {
          filesystemWorker,
          enableBashAdditionalPermissions: true,
          enableFileToolAdditionalPermissions: true,
        }
      : {}),
  });
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
  const interaction = new HostInteractionAuthority(
    stores.interactionStore,
    continuity,
    sessionAdmission,
    context.acquireResidency,
    (error) => failStopHandoff(error),
  );
  let coordinator: RootTurnCoordinator | undefined;
  const rootPort: HostMessageRootPort = {
    readSessionHeader: (sessionId) =>
      requireRootCoordinator(coordinator).readSessionHeader(sessionId),
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
  const runtimeMessageAuthority = createFailStopMessageAuthority(messageCoordinator, (error) =>
    failStopHandoff(error),
  );
  const permissionEngine = new PermissionEngine({ newId: randomUUID, now: Date.now });
  const backends = new BackendRegistry();
  backends.register('fake', (backendContext) => new FakeBackend(backendContext));
  backends.register('ai-sdk', (backendContext) =>
    createHostAiSdkBackend({
      context: backendContext,
      runtimePolicy: runtimePolicyStores,
      skills,
      memory,
      taskLedger: taskLedgerStore,
      artifacts: artifactStore,
      usage: usageStores,
      permissionEngine,
      runtimeTools,
      runtimeCommitSink: stores.runtimeEventStore,
      onCredentialRefreshed: refreshBackends,
    }),
  );
  manager = new SessionManager({
    store: stores.sessionStore,
    runStore: stores.agentRunStore,
    runtimeEventStore: stores.runtimeEventStore,
    toolBoundaryProtocol: TOOL_BOUNDARY_PROTOCOL_V1,
    shellRuns: resources.shellRuns,
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
  let usageDrain: Promise<void> | undefined;
  let artifactDrain: Promise<void> | undefined;
  let memoryDrain: Promise<void> | undefined;
  const beginArtifactDrain = () => {
    artifactDrain ??= artifactStore.beginDrain();
    observe(artifactDrain);
    return artifactDrain;
  };
  const beginUsageDrain = () => {
    usageDrain ??= usageStores.beginDrain();
    observe(usageDrain);
    return usageDrain;
  };
  const beginMemoryDrain = () => {
    memoryDrain ??= memoryStore.beginDrain();
    observe(memoryDrain);
    return memoryDrain;
  };
  const beginRuntimeDrain = () => {
    beginArtifactDrain();
    beginMemoryDrain();
    beginUsageDrain();
    skills.beginDrain();
    messageCoordinator.beginDrain();
    interaction.beginDrain();
    resources.beginDrain();
    runtimeDrain ??= manager.beginRuntimeDrain();
    observe(runtimeDrain.ownerIsolationDrain);
    observe(runtimeDrain.reclaimDrain);
    return runtimeDrain;
  };
  failStopHandoff = (error) => {
    if (failStopDisposition) return;
    const handoffFailures: unknown[] = [];
    try {
      beginArtifactDrain();
      beginMemoryDrain();
      beginUsageDrain();
      skills.beginDrain();
      const runtimeFailStop = manager.installInteractionFailStop(error);
      resources.beginDrain();
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
      runtimePolicy.handlers,
      skills.handlers,
      taskLedger.handlers,
      artifacts.handlers,
      memory.handlers,
      usagePricing.handlers,
      resources.handlers,
    ),
    continuity,
    onConnectionSettled: (connectionId) => resources.releaseConnection(connectionId),
    beginDrain: () => {
      beginArtifactDrain();
      beginMemoryDrain();
      beginUsageDrain();
      skills.beginDrain();
      messageCoordinator.beginDrain();
      interaction.beginDrain();
      resources.beginDrain();
      if (!failStopDisposition) beginRuntimeDrain();
    },
    recover: async () => {
      await rootCoordinator.prepareRecovery();
      await artifactStore.recover();
      await memoryStore.recover({
        defaultDocument: Buffer.from(defaultLocalMemoryMarkdown(), 'utf8'),
      });
      await skills.recover();
      await interaction.recoverPendingAfterHostRestart();
      for (const session of await stores.sessionStore.listForRecovery()) {
        await resources.recoverSession(session.id);
      }
      await manager.recoverInterruptedSessionsStrict(stores, {
        shellRunsAlreadyRecovered: true,
      });
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
        skills,
        artifactStore,
        memoryStore,
        usageStores,
        resources,
        drain,
        () => failStopDisposition,
      );
      return closeTask;
    },
  };
}

type HostFilesystemWorkerRuntime =
  | { readonly runtime: 'node' }
  | {
      readonly runtime: 'electron';
      readonly executable: string;
      readonly resourcesPath: string;
    };

type FilesystemWorkerProviderFactory = (
  input: CreateFilesystemWorkerLaunchSpecProviderInput,
) => FilesystemWorkerLaunchSpecProvider;

/** Selects the worker runtime and resolves packaged Electron resources before dev resources. */
export function createHostFilesystemWorkerLaunchSpecProvider(
  host: HostFilesystemWorkerRuntime,
  createProvider: FilesystemWorkerProviderFactory = createFilesystemWorkerLaunchSpecProvider,
): FilesystemWorkerLaunchSpecProvider {
  if (host.runtime === 'node') {
    return createProvider({ runtime: 'node', resourceLocation: { kind: 'runtime' } });
  }

  const packagedProvider = createProvider({
    runtime: 'electron',
    executable: host.executable,
    resourceLocation: { kind: 'desktop-packaged', resourcesPath: host.resourcesPath },
  });
  let runtimeProvider: FilesystemWorkerLaunchSpecProvider | undefined;
  let resolution: ReturnType<FilesystemWorkerLaunchSpecProvider> | undefined;
  return () =>
    (resolution ??= packagedProvider().then((result) => {
      if (result.ok || result.reason !== 'worker_bundle_unavailable') return result;
      runtimeProvider ??= createProvider({
        runtime: 'electron',
        executable: host.executable,
        resourceLocation: { kind: 'runtime' },
      });
      return runtimeProvider();
    }));
}

async function closeComposition(
  coordinator: RootTurnCoordinator,
  messages: HostMessageCoordinator,
  interaction: HostInteractionAuthority,
  continuity: SessionContinuityCoordinator,
  skills: HostSkillCatalogCoordinator,
  artifactStore: Awaited<ReturnType<typeof openInteractiveArtifactStoreForWrite>>,
  memoryStore: Awaited<ReturnType<typeof openInteractiveMemoryStoreForWrite>>,
  usageStores: Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>,
  resources: HostRuntimeResourceCoordinator,
  runtimeDrain: ReturnType<SessionManager['beginRuntimeDrain']>,
  getFailStop: () => RuntimeHostFailStopDisposition | undefined,
): Promise<RuntimeHostCompositionCloseResult> {
  const existingFailStop = getFailStop();
  if (existingFailStop) {
    continuity.close();
    return existingFailStop;
  }

  const normalClose = closeNormally(
    coordinator,
    messages,
    interaction,
    continuity,
    skills,
    artifactStore,
    memoryStore,
    usageStores,
    resources,
    runtimeDrain,
  );
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
  skills: HostSkillCatalogCoordinator,
  artifactStore: Awaited<ReturnType<typeof openInteractiveArtifactStoreForWrite>>,
  memoryStore: Awaited<ReturnType<typeof openInteractiveMemoryStoreForWrite>>,
  usageStores: Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>,
  resources: HostRuntimeResourceCoordinator,
  runtimeDrain: ReturnType<SessionManager['beginRuntimeDrain']>,
): Promise<{ readonly kind: 'clean' }> {
  const errors: unknown[] = [];
  try {
    const outcomes = await Promise.allSettled([
      coordinator.close(),
      runtimeDrain.ownerIsolationDrain,
      runtimeDrain.reclaimDrain,
      resources.close(),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') errors.push(outcome.reason);
    }
    await interaction.close().catch((error: unknown) => errors.push(error));
    await messages.close().catch((error: unknown) => errors.push(error));
    await skills.close().catch((error: unknown) => errors.push(error));
    await artifactStore.close().catch((error: unknown) => errors.push(error));
    await memoryStore.close().catch((error: unknown) => errors.push(error));
    await usageStores.close().catch((error: unknown) => errors.push(error));
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

function requireRootCoordinator(coordinator: RootTurnCoordinator | undefined): RootTurnCoordinator {
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
