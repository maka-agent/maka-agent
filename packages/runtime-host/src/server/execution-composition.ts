import { randomUUID } from 'node:crypto';
import { defaultLocalMemoryMarkdown } from '@maka/core/local-memory';
import { TOOL_BOUNDARY_PROTOCOL_V1 } from '@maka/core/runtime-event';
import { filterModelVisibleTaskLedgerTasks } from '@maka/core/task-ledger';
import {
  BackendRegistry,
  buildBrowserTools,
  buildBuiltinTools,
  buildComputerUseTools,
  createBuiltinSandboxManager,
  createFilesystemWorkerLaunchSpecProvider,
  createSandboxDiagnosticsProvider,
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
import { createReadImageSnapshotter, openInteractiveAutomationStoreForWrite } from '@maka/storage';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveMemoryStoreForWrite } from '@maka/storage/memory-store';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { openInteractiveShellRunStoreForWrite } from '@maka/storage/shell-run-store';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-store';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import { createCanonicalSessionProjectionReader } from './canonical-session-projection.js';
import { createHostAiSdkBackend, createHostGoalEvaluator } from './execution-model-composition.js';
import type {
  RuntimeHostComposition,
  RuntimeHostCompositionCloseResult,
  RuntimeHostCompositionContext,
  RuntimeHostFailStopDisposition,
} from './host-kernel.js';
import { HostArtifactCoordinator } from './artifact-coordinator.js';
import { HostAutomationCoordinator } from './automation-coordinator.js';
import { HostGoalCoordinator } from './goal-coordinator.js';
import { HostInteractionAuthority } from './interaction-coordinator.js';
import { HostMessageCoordinator, type HostMessageRootPort } from './message-coordinator.js';
import { HostMemoryCoordinator } from './memory-coordinator.js';
import { createHostNativeBrowserInvocationProvider } from './native-browser-provider.js';
import { createHostNativeComputerUseInvocationProvider } from './native-computer-use-provider.js';
import { HostNativeProviderCoordinator } from './native-provider-coordinator.js';
import { HostOAuthCoordinator } from './oauth-coordinator.js';
import { combineDomainOperationHandlers } from './operation-dispatcher.js';
import { RootAdmissionOwner } from './root-admission-owner.js';
import {
  type HostGoalTurnBoundary,
  RootTurnCoordinator,
  type RootTurnCoordinatorHooks,
} from './root-turn-coordinator.js';
import { HostRuntimePolicyCoordinator } from './runtime-policy-coordinator.js';
import { HostRuntimeResourceCoordinator } from './runtime-resource-coordinator.js';
import { SessionAdmissionGate } from './session-admission-gate.js';
import { HostSessionCoordinator } from './session-coordinator.js';
import { SessionContinuityCoordinator } from './session-continuity-coordinator.js';
import { HostSkillCatalogCoordinator } from './skill-catalog-coordinator.js';
import { HostSkillCatalogFilesystem } from './skill-catalog-filesystem.js';
import { HostTaskLedgerCoordinator } from './task-ledger-coordinator.js';
import { HostUsagePricingCoordinator } from './usage-pricing-coordinator.js';

export interface ExecutionRuntimeHostCompositionOptions {
  readonly rootTurnHooks?: RootTurnCoordinatorHooks;
}

export async function createExecutionRuntimeHostComposition(
  context: RuntimeHostCompositionContext,
  options: ExecutionRuntimeHostCompositionOptions = {},
): Promise<RuntimeHostComposition> {
  const stores = await openInteractiveExecutionStoresForWrite(context.owner.lease);
  const runtimePolicyStores = await openInteractiveRuntimePolicyStoresForWrite(context.owner.lease);
  const taskLedgerStore = await openInteractiveTaskLedgerStoreForWrite(context.owner.lease);
  const artifactStore = await openInteractiveArtifactStoreForWrite(context.owner.lease);
  const automationStore = await openInteractiveAutomationStoreForWrite(context.owner.lease);
  const memoryStore = await openInteractiveMemoryStoreForWrite(context.owner.lease);
  const usageStores = await openInteractiveUsageStoresForWrite(context.owner.lease);
  const shellRunStore = await openInteractiveShellRunStoreForWrite(context.owner.lease);
  let manager!: SessionManager;
  let failStopHandoff!: (error: RuntimeInteractionFailStopError) => void;
  const refreshBackends = async () => {
    try {
      await manager.refreshIdleBackends();
    } catch (error) {
      const fatal = new RuntimeInteractionFailStopError(
        'Could not invalidate Runtime Host backend snapshots after a committed policy change',
        error,
      );
      failStopHandoff(fatal);
      throw fatal;
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
  const nativeProvider = new HostNativeProviderCoordinator(
    context.hostEpoch,
    context.acquireResidency,
  );
  const oauth = new HostOAuthCoordinator({
    runtimePolicy: runtimePolicyStores,
    nativeProvider,
    acquireResidency: context.acquireResidency,
    invalidateBackends: refreshBackends,
    onFatal: (error) =>
      failStopHandoff(
        new RuntimeInteractionFailStopError('Runtime Host OAuth entered fail-stop', error),
      ),
  });
  const sandboxManager = createBuiltinSandboxManager();
  const filesystemWorkerLaunchSpecProvider =
    process.platform === 'darwin'
      ? createHostFilesystemWorkerLaunchSpecProvider(
          process.versions.electron
            ? {
                runtime: 'electron',
                executable: process.execPath,
                resourcesPath: (process as NodeJS.Process & { readonly resourcesPath: string })
                  .resourcesPath,
              }
            : { runtime: 'node' },
        )
      : undefined;
  const filesystemWorker =
    sandboxManager && filesystemWorkerLaunchSpecProvider
      ? new FilesystemWorkerClient({
          sandboxManager,
          getLaunchSpec: filesystemWorkerLaunchSpecProvider,
        })
      : undefined;
  const sandboxDiagnosticsProvider = createSandboxDiagnosticsProvider({
    ...(sandboxManager ? { sandboxManager } : {}),
    ...(filesystemWorkerLaunchSpecProvider
      ? { getFilesystemWorkerLaunchSpec: filesystemWorkerLaunchSpecProvider }
      : {}),
  });
  const computerUseTools = buildComputerUseTools({
    invocationProvider: createHostNativeComputerUseInvocationProvider(nativeProvider),
  });
  const browserTools = buildBrowserTools({
    invocationProvider: createHostNativeBrowserInvocationProvider(nativeProvider),
  });
  const runtimeTools = [
    ...buildBuiltinTools({
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
    }),
    ...computerUseTools,
    ...browserTools,
  ];
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
  let goals: HostGoalCoordinator | undefined;
  let automation: HostAutomationCoordinator | undefined;
  const goalTurns: HostGoalTurnBoundary = {
    beginExternalTurn: (sessionId, turnId) =>
      requireGoalCoordinator(goals).beginExternalTurn(sessionId, turnId),
  };
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
  const permissionEngine = new PermissionEngine({
    newId: randomUUID,
    now: Date.now,
  });
  const backends = new BackendRegistry();
  backends.register('fake', (backendContext) => new FakeBackend(backendContext));
  backends.register('ai-sdk', (backendContext) =>
    createHostAiSdkBackend({
      context: backendContext,
      automationService: requireAutomationCoordinator(automation),
      runtimePolicy: runtimePolicyStores,
      skills,
      memory,
      taskLedger: taskLedgerStore,
      artifacts: artifactStore,
      usage: usageStores,
      permissionEngine,
      sandboxDiagnosticsProvider,
      runtimeTools: [...runtimeTools, ...requireGoalCoordinator(goals).tools],
      runtimeCommitSink: stores.runtimeEventStore,
      oauth,
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
    goalTurns,
    async ({ sessionId, turnId }) => {
      computerUseTools.clearSession(sessionId);
      await browserTools.releaseTurnState({ sessionId, turnId });
      await nativeProvider.releaseTurnState({ sessionId, turnId });
    },
    options.rootTurnHooks,
  );
  coordinator = rootCoordinator;
  const goalEvaluator = createHostGoalEvaluator({
    sessions: stores.sessionStore,
    runtimePolicy: runtimePolicyStores,
    oauth,
  });
  goals = new HostGoalCoordinator({
    root: rootCoordinator,
    evaluate: goalEvaluator.evaluate,
    waitForEvaluatorPostCutEffects: goalEvaluator.whenCurrentPostCutEffectsSettled,
    readEvaluationContext: async (sessionId) => {
      const messages = await stores.sessionStore.readMessages(sessionId);
      let tokenCount = 0;
      for (const message of messages) {
        if (message.type === 'token_usage') {
          tokenCount += message.total ?? message.input + message.output;
        }
      }
      const recentContext = messages
        .slice(-10)
        .filter((message) => message.type === 'user' || message.type === 'assistant')
        .slice(-6)
        .map((message) => `[${message.type}]: ${message.text.slice(0, 500)}`)
        .join('\n');
      return { recentContext, tokenCount };
    },
    taskGate: {
      listActionableTaskKeys: async (sessionId) =>
        filterModelVisibleTaskLedgerTasks(
          await taskLedgerStore.listCanonical(sessionId, {
            classifyResumeTrust: true,
            includeArchived: false,
          }),
        )
          .filter((task) => task.status === 'pending' || task.status === 'in_progress')
          .map((task) => task.key),
      recordDecision: async (trace) => {
        const admission = await stores.agentRunStore.readRootTurnAdmission(
          trace.sessionId,
          trace.turnId,
        );
        if (!admission) return;
        await stores.agentRunStore.appendEvent(trace.sessionId, admission.runId, {
          type: 'task_gate_decided',
          id: randomUUID(),
          runId: admission.runId,
          sessionId: trace.sessionId,
          turnId: trace.turnId,
          ts: Date.now(),
          data: {
            goalId: trace.goalId,
            decision: trace.decision,
            taskKeys: trace.taskKeys,
          },
        });
      },
    },
    acquireResidency: context.acquireResidency,
    requestDrain: context.requestDrain,
  });
  automation = new HostAutomationCoordinator({
    store: automationStore,
    executionStores: stores,
    root: rootCoordinator,
    sessionAdmission,
    acquireResidency: context.acquireResidency,
    requestDrain: context.requestDrain,
    newId: randomUUID,
    now: Date.now,
  });
  const sessions = new HostSessionCoordinator({
    stores,
    runtimePolicy: runtimePolicyStores,
    usage: usageStores,
    manager,
    admission: sessionAdmission,
    root: rootCoordinator,
    messages: messageCoordinator,
    continuity,
    goals,
    automation,
    resources,
    requestDrain: context.requestDrain,
  });
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
  const beginDomainDrain = () => {
    oauth.beginDrain();
    goalEvaluator.beginDrain();
    goals.beginDrain();
    automation.beginDrain();
    beginArtifactDrain();
    beginMemoryDrain();
    beginUsageDrain();
    skills.beginDrain();
    messageCoordinator.beginDrain();
    interaction.beginDrain();
    resources.beginDrain();
  };
  const beginRuntimeDrain = () => {
    if (runtimeDrain) return runtimeDrain;
    beginDomainDrain();
    runtimeDrain = manager.beginRuntimeDrain();
    observe(runtimeDrain.ownerIsolationDrain);
    observe(runtimeDrain.reclaimDrain);
    return runtimeDrain;
  };
  failStopHandoff = (error) => {
    if (failStopDisposition) return;
    const handoffFailures: unknown[] = [];
    let oauthFailStop = {
      ownerIsolationBarrier: Promise.resolve(),
      reclaimAfterOwnerIsolation: () => {},
    };
    let runtimeOwnerIsolationBarrier: Promise<unknown> = Promise.resolve();
    let reclaimGoals = () => {};
    let reclaimAutomation = () => {};
    try {
      oauthFailStop = oauth.prepareFailStop();
    } catch (handoffFailure) {
      handoffFailures.push(handoffFailure);
    }
    try {
      reclaimGoals = goals.prepareFailStopReclaim();
    } catch (handoffFailure) {
      handoffFailures.push(handoffFailure);
    }
    try {
      reclaimAutomation = automation.prepareFailStopReclaim();
    } catch (handoffFailure) {
      handoffFailures.push(handoffFailure);
    }
    try {
      beginArtifactDrain();
      beginMemoryDrain();
      beginUsageDrain();
      skills.beginDrain();
      const runtimeFailStop = manager.installInteractionFailStop(error);
      runtimeOwnerIsolationBarrier = runtimeFailStop.ownerIsolationDrain;
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
      ownerIsolationBarrier: settleOwnerIsolationBarriers(
        runtimeOwnerIsolationBarrier,
        oauthFailStop.ownerIsolationBarrier,
      ),
      reclaimAfterOwnerIsolation: () => {
        if (reclaimed) return;
        reclaimed = true;
        interaction.reclaimAfterOwnerIsolation();
        oauthFailStop.reclaimAfterOwnerIsolation();
        reclaimGoals();
        reclaimAutomation();
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
      goals.handlers,
      automation.handlers,
      sessions.handlers,
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
      nativeProvider.handlers,
      oauth.handlers,
    ),
    continuity,
    nativeProvider,
    onConnectionSettled: (connectionId) => resources.releaseConnection(connectionId),
    beginDrain: () => {
      if (failStopDisposition) {
        beginDomainDrain();
        return;
      }
      beginRuntimeDrain();
    },
    recover: async () => {
      await rootCoordinator.prepareRecovery();
      await artifactStore.recover();
      await memoryStore.recover({
        defaultDocument: Buffer.from(defaultLocalMemoryMarkdown(), 'utf8'),
      });
      await skills.recover();
      await interaction.recoverPendingAfterHostRestart();
      await manager.recoverInterruptedSessionsStrict(stores);
      await rootCoordinator.recover();
      await automation.recover();
      await automation.startScheduler();
    },
    close: () => {
      if (failStopDisposition) {
        closeTask ??= Promise.resolve(failStopDisposition);
        return closeTask;
      }
      const drain = beginRuntimeDrain();
      closeTask ??= closeComposition(
        rootCoordinator,
        oauth,
        goalEvaluator,
        goals,
        automation,
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
    return createProvider({
      runtime: 'node',
      resourceLocation: { kind: 'runtime' },
    });
  }

  const packagedProvider = createProvider({
    runtime: 'electron',
    executable: host.executable,
    resourceLocation: {
      kind: 'desktop-packaged',
      resourcesPath: host.resourcesPath,
    },
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
  oauth: HostOAuthCoordinator,
  goalEvaluator: ReturnType<typeof createHostGoalEvaluator>,
  goals: HostGoalCoordinator,
  automation: HostAutomationCoordinator,
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
    oauth,
    goalEvaluator,
    goals,
    automation,
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
  oauth: HostOAuthCoordinator,
  goalEvaluator: ReturnType<typeof createHostGoalEvaluator>,
  goals: HostGoalCoordinator,
  automation: HostAutomationCoordinator,
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
      oauth.close(),
      goalEvaluator.close(),
      goals.close(),
      automation.close(),
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

async function settleOwnerIsolationBarriers(
  runtimeBarrier: Promise<unknown>,
  goalBarrier: Promise<unknown>,
): Promise<void> {
  const outcomes = await Promise.allSettled([runtimeBarrier, goalBarrier]);
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Runtime Host owner isolation barriers failed');
  }
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

function requireAutomationCoordinator(
  automation: HostAutomationCoordinator | undefined,
): HostAutomationCoordinator {
  if (!automation) throw new Error('Runtime Host Automation coordinator is not bound');
  return automation;
}

function requireGoalCoordinator(goals: HostGoalCoordinator | undefined): HostGoalCoordinator {
  if (!goals) throw new Error('Runtime Host Goal coordinator is not bound');
  return goals;
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
