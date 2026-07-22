import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DEFAULT_SESSION_NAME,
  isDeepResearchSession,
  isExpertTeamSession,
  isModelExplicitlyUnsupportedForChat,
  normalizeUserSessionName,
  thinkingVariantsForModel,
  type CreateSessionInput,
  type SessionHeader,
  type SessionSummary,
} from '@maka/core';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import type { InteractiveUsageStoresWriter } from '@maka/storage/usage-stores';
import type { SessionManager } from '@maka/runtime';
import {
  encodeSessionManagementCreateResult,
  encodeSessionManagementMutateResult,
  encodeSessionManagementQueryResult,
  SESSION_MANAGEMENT_PAGE_MAX_ITEMS,
  SESSION_MANAGEMENT_RESULT_MAX_BYTES,
  type OperationError,
  type OperationOutcome,
  type SessionManagementCreateInput,
  type SessionManagementModelTarget,
  type SessionManagementMutation,
  type SessionManagementMutateResult,
  type SessionManagementProjection,
  type SessionManagementQueryInput,
  type SessionManagementQueryResult,
  type SessionManagementThinkingLevel,
} from '../protocol/index.js';
import type { HostAutomationCoordinator } from './automation-coordinator.js';
import type { HostGoalCoordinator } from './goal-coordinator.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import type { SessionManagementOperationHandlerMap } from './operation-dispatcher.js';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import type { HostRuntimeResourceCoordinator } from './runtime-resource-coordinator.js';
import {
  type SessionAdmissionLease,
  type SessionLifecycleAdmission,
  SessionAdmissionGate,
} from './session-admission-gate.js';
import type { SessionContinuityCoordinator } from './session-continuity-coordinator.js';

type SessionOperationFailureCode =
  | 'operation_unavailable'
  | 'invalid_request'
  | 'not_found'
  | 'persistence_failed';

class SessionOperationFailure extends Error {
  constructor(
    readonly code: SessionOperationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionOperationFailure';
  }
}

interface ResolvedSessionModel {
  readonly connectionSlug: string;
  readonly model: string;
}

type SessionStores = {
  readonly sessionStore: Pick<
    ExecutionStoresWriter<'interactive'>['sessionStore'],
    'archive' | 'createStableSession' | 'list' | 'readHeaderSnapshot' | 'remove' | 'unarchive'
  >;
};
type SessionRuntimePolicyStores = {
  readonly connectionCatalog: Pick<RuntimePolicyStoresWriter['connectionCatalog'], 'getSnapshot'>;
  readonly runtimePolicy: Pick<RuntimePolicyStoresWriter['runtimePolicy'], 'getSnapshot'>;
};
type SessionUsageStores = Pick<InteractiveUsageStoresWriter, 'flush'>;
type SessionManagerCommands = Pick<
  SessionManager,
  | 'disposeSessionBackend'
  | 'markSessionRead'
  | 'renameSession'
  | 'setFlagged'
  | 'setPermissionMode'
  | 'updateSession'
>;
type SessionAdmission = Pick<
  SessionAdmissionGate,
  'beginSessionLifecycle' | 'isNewWorkAdmitted' | 'run'
>;
type SessionRootStateReader = Pick<RootTurnCoordinator, 'readRootState'>;
type SessionMessageLifecycle = Pick<HostMessageCoordinator, 'beginSessionClose' | 'resumeSession'>;
type SessionContinuity = Pick<SessionContinuityCoordinator, 'refreshCanonical' | 'retireSession'>;
type SessionGoalLifecycle = Pick<HostGoalCoordinator, 'beginSessionClose' | 'unarchiveSession'>;
type SessionAutomationLifecycle = Pick<
  HostAutomationCoordinator,
  'beginSessionClose' | 'unarchiveSession'
>;
type SessionResourceLifecycle = Pick<
  HostRuntimeResourceCoordinator,
  'beginSessionClose' | 'resumeSession'
>;

interface SessionCloseHandles {
  readonly goal: ReturnType<SessionGoalLifecycle['beginSessionClose']>;
  readonly automation: ReturnType<SessionAutomationLifecycle['beginSessionClose']>;
  readonly resource: ReturnType<SessionResourceLifecycle['beginSessionClose']>;
  readonly message: Awaited<ReturnType<SessionMessageLifecycle['beginSessionClose']>>;
}

type PartialSessionCloseHandles = {
  -readonly [Key in keyof SessionCloseHandles]?: SessionCloseHandles[Key];
};

export interface HostSessionCoordinatorOptions {
  readonly stores: SessionStores;
  readonly runtimePolicy: SessionRuntimePolicyStores;
  readonly usage: SessionUsageStores;
  readonly manager: SessionManagerCommands;
  readonly admission: SessionAdmission;
  readonly root: SessionRootStateReader;
  readonly messages: SessionMessageLifecycle;
  readonly continuity: SessionContinuity;
  readonly goals: SessionGoalLifecycle;
  readonly automation: SessionAutomationLifecycle;
  readonly resources: SessionResourceLifecycle;
  readonly requestDrain: () => void;
}

/** Host-owned Session control plane and cross-domain lifecycle coordinator. */
export class HostSessionCoordinator {
  readonly handlers: SessionManagementOperationHandlerMap = {
    'session.query': (input) => this.#query(input),
    'session.create': (input) => this.#create(input),
    'session.mutate': (input) => this.#mutate(input),
  };

  readonly #stores: SessionStores;
  readonly #runtimePolicy: SessionRuntimePolicyStores;
  readonly #usage: SessionUsageStores;
  readonly #manager: SessionManagerCommands;
  readonly #admission: SessionAdmission;
  readonly #root: SessionRootStateReader;
  readonly #messages: SessionMessageLifecycle;
  readonly #continuity: SessionContinuity;
  readonly #goals: SessionGoalLifecycle;
  readonly #automation: SessionAutomationLifecycle;
  readonly #resources: SessionResourceLifecycle;
  readonly #requestDrain: () => void;
  readonly #lifecycleSessions = new Set<string>();

  constructor(options: HostSessionCoordinatorOptions) {
    this.#stores = options.stores;
    this.#runtimePolicy = options.runtimePolicy;
    this.#usage = options.usage;
    this.#manager = options.manager;
    this.#admission = options.admission;
    this.#root = options.root;
    this.#messages = options.messages;
    this.#continuity = options.continuity;
    this.#goals = options.goals;
    this.#automation = options.automation;
    this.#resources = options.resources;
    this.#requestDrain = options.requestDrain;
  }

  async #query(input: SessionManagementQueryInput): Promise<OperationOutcome<'session.query'>> {
    try {
      if (input.kind === 'get') {
        const session = await this.#admission.run(input.sessionId, async () =>
          projectHeader(await this.#stores.sessionStore.readHeaderSnapshot(input.sessionId)),
        );
        return successQuery({ kind: 'item', session });
      }

      const summaries = await this.#stores.sessionStore.list(input.filter);
      const offset = decodeCursor(input.cursor);
      if (
        offset === undefined ||
        offset > summaries.length ||
        (input.cursor && offset === summaries.length)
      ) {
        return queryFailure('invalid_request', 'Session list cursor is invalid');
      }
      return successQuery(await this.#page(summaries, offset));
    } catch (error) {
      if (isMissingFile(error)) return queryFailure('not_found', 'Session does not exist');
      return queryFailure('persistence_failed', 'Session projection is unavailable');
    }
  }

  async #page(
    summaries: readonly SessionSummary[],
    offset: number,
  ): Promise<SessionManagementQueryResult> {
    const items: SessionManagementProjection[] = [];
    let nextOffset = offset;
    while (nextOffset < summaries.length && items.length < SESSION_MANAGEMENT_PAGE_MAX_ITEMS) {
      const summary = summaries[nextOffset];
      nextOffset += 1;
      if (!summary) break;

      let header: SessionHeader;
      try {
        header = await this.#stores.sessionStore.readHeaderSnapshot(summary.id);
      } catch (error) {
        if (isMissingFile(error)) continue;
        throw error;
      }
      const item = projectSummary(summary, header);
      const candidate = pageResult([...items, item], nextOffset, summaries.length);
      if (resultBytes(candidate) > SESSION_MANAGEMENT_RESULT_MAX_BYTES) {
        if (items.length === 0) {
          throw new Error('A Session projection cannot fit in one protocol result');
        }
        nextOffset -= 1;
        break;
      }
      items.push(item);
    }
    return pageResult(items, nextOffset, summaries.length);
  }

  async #create(input: SessionManagementCreateInput): Promise<OperationOutcome<'session.create'>> {
    let prepared: PreparedCreateRequest;
    try {
      prepared = prepareCreateRequest(input);
    } catch (error) {
      return createOperationFailure(error, 'invalid_request');
    }

    return this.#admission.run(input.sessionId, async (lease) => {
      const newWorkAdmitted = this.#admission.isNewWorkAdmitted(input.sessionId, lease);
      let existing: SessionHeader | undefined;
      try {
        existing = await this.#readHeaderIfPresent(input.sessionId);
      } catch {
        return createFailure('persistence_failed', 'Session persistence is unavailable');
      }

      let createInput: CreateSessionInput;
      if (existing) {
        createInput = createInputFromHeader(existing);
      } else {
        if (!newWorkAdmitted) {
          return createFailure('operation_conflict', 'Session lifecycle is closing');
        }
        try {
          await assertDirectory(prepared.cwd);
          const [target, policy] = await Promise.all([
            this.#resolveModel(prepared.modelTarget, prepared.thinkingLevel),
            this.#runtimePolicy.runtimePolicy.getSnapshot(),
          ]);
          createInput = {
            cwd: prepared.cwd,
            backend: 'ai-sdk' as const,
            llmConnectionSlug: target.connectionSlug,
            model: target.model,
            ...(prepared.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: prepared.thinkingLevel }),
            permissionMode: prepared.permissionMode ?? policy.policy.chatDefaults.permissionMode,
            collaborationMode: 'agent' as const,
            name: prepared.name,
            labels: [...prepared.labels],
          };
        } catch (error) {
          return createOperationFailure(error, 'persistence_failed');
        }
      }

      try {
        const result = await this.#stores.sessionStore.createStableSession({
          sessionId: input.sessionId,
          semanticKey: prepared.semanticKey,
          input: createInput,
        });
        if (result.kind === 'conflict') {
          return createFailure(
            'operation_conflict',
            'Session id belongs to a different create request',
          );
        }
        if (result.kind === 'existing' && !newWorkAdmitted) {
          return {
            ok: true,
            result: encodeSessionManagementCreateResult(projectHeader(result.header)),
          };
        }
        await this.#continuity.refreshCanonical(input.sessionId, lease);
        return {
          ok: true,
          result: encodeSessionManagementCreateResult(projectHeader(result.header)),
        };
      } catch {
        this.#requestDrain();
        return createFailure('commit_outcome_unknown', 'Session creation outcome is unknown');
      }
    });
  }

  #mutate(input: SessionManagementMutation): Promise<OperationOutcome<'session.mutate'>> {
    switch (input.kind) {
      case 'archive':
      case 'remove':
        return this.#closeSession(input.sessionId, input.kind);
      case 'unarchive':
        return this.#unarchive(input.sessionId);
      case 'set_collaboration_mode':
        return Promise.resolve(
          mutateFailure(
            'operation_unavailable',
            'Session collaboration modes are not yet managed by Runtime Host',
          ),
        );
      default:
        return this.#mutateSession(input);
    }
  }

  #mutateSession(
    input: Exclude<
      SessionManagementMutation,
      { readonly kind: 'archive' | 'unarchive' | 'remove' | 'set_collaboration_mode' }
    >,
  ): Promise<OperationOutcome<'session.mutate'>> {
    return this.#admission.run(input.sessionId, async (lease) => {
      let header: SessionHeader;
      try {
        header = await this.#stores.sessionStore.readHeaderSnapshot(input.sessionId);
      } catch (error) {
        return isMissingFile(error)
          ? mutateFailure('not_found', 'Session does not exist')
          : mutateFailure('persistence_failed', 'Session persistence is unavailable');
      }

      if (requiresIdleRoot(input) && this.#root.readRootState(input.sessionId).kind !== 'idle') {
        return mutateFailure('session_busy', 'Session has an active root Turn');
      }
      if (requiresIdleRoot(input) && header.isArchived) {
        return mutateFailure('operation_conflict', 'Session is archived');
      }
      if (requiresIdleRoot(input) && header.status === 'waiting_for_user') {
        return mutateFailure('session_busy', 'Session has a pending Interaction');
      }
      if (!this.#admission.isNewWorkAdmitted(input.sessionId, lease)) {
        return mutateFailure('session_busy', 'Session lifecycle is closing');
      }

      try {
        await this.#applyMutation(input, header);
        await this.#continuity.refreshCanonical(input.sessionId, lease);
        const next = await this.#stores.sessionStore.readHeaderSnapshot(input.sessionId);
        return successMutation({ kind: 'session', session: projectHeader(next) });
      } catch (error) {
        if (error instanceof SessionOperationFailure)
          return mutateOperationFailure(error, error.code);
        this.#requestDrain();
        return mutateFailure('commit_outcome_unknown', 'Session mutation outcome is unknown');
      }
    });
  }

  async #applyMutation(
    input: Exclude<
      SessionManagementMutation,
      { readonly kind: 'archive' | 'unarchive' | 'remove' | 'set_collaboration_mode' }
    >,
    header: SessionHeader,
  ): Promise<void> {
    switch (input.kind) {
      case 'rename': {
        const normalized = normalizeUserSessionName(input.name);
        if (!normalized.ok) throw new SessionOperationFailure('invalid_request', normalized.error);
        await this.#manager.renameSession(input.sessionId, normalized.value);
        return;
      }
      case 'set_flagged':
        await this.#manager.setFlagged(input.sessionId, input.isFlagged);
        return;
      case 'mark_read':
        await this.#manager.markSessionRead(input.sessionId, input.readThroughTs);
        return;
      case 'set_permission_mode':
        await this.#manager.setPermissionMode(input.sessionId, input.permissionMode);
        return;
      case 'set_model': {
        const target = await this.#resolveModel(input.modelTarget, input.thinkingLevel);
        await this.#manager.updateSession(input.sessionId, {
          backend: 'ai-sdk',
          llmConnectionSlug: target.connectionSlug,
          model: target.model,
          thinkingLevel: input.thinkingLevel,
          connectionLocked: true,
          status: 'active',
          blockedReason: undefined,
          statusUpdatedAt: Date.now(),
        });
        return;
      }
      case 'set_thinking_level':
        if (input.thinkingLevel !== null) {
          await this.#resolveModel(
            {
              kind: 'explicit',
              connectionSlug: header.llmConnectionSlug,
              model: header.model,
            },
            input.thinkingLevel,
          );
        }
        await this.#manager.updateSession(input.sessionId, {
          thinkingLevel: input.thinkingLevel ?? undefined,
        });
        return;
      case 'move_cwd': {
        const cwd = resolve(input.cwd);
        await assertDirectory(cwd);
        if (cwd === header.cwd) return;
        const from = header.pendingCwdReminder?.from ?? header.cwd;
        await this.#manager.updateSession(input.sessionId, {
          cwd,
          pendingCwdReminder: from === cwd ? undefined : { from, to: cwd },
        });
      }
    }
  }

  async #closeSession(
    sessionId: string,
    kind: 'archive' | 'remove',
  ): Promise<OperationOutcome<'session.mutate'>> {
    const lifecycle = this.#beginLifecycle(sessionId);
    if (!lifecycle) {
      return mutateFailure('session_busy', 'Session lifecycle is already changing');
    }

    const acquired: PartialSessionCloseHandles = {};
    let handles: SessionCloseHandles | undefined;
    try {
      const prepared = await this.#admission.run(sessionId, async (lease) => {
        const header = await this.#readHeaderIfPresent(sessionId);
        if (!header) {
          if (kind === 'remove') return { kind: 'remove_retry' as const };
          throw new SessionOperationFailure('not_found', 'Session does not exist');
        }
        if (kind === 'archive' && header.isArchived) {
          return { kind: 'already_archived' as const, header };
        }
        acquired.message = await this.#messages.beginSessionClose(sessionId, lease);
        acquired.goal = this.#goals.beginSessionClose(sessionId, kind);
        acquired.automation = this.#automation.beginSessionClose(sessionId, lease);
        acquired.resource = this.#resources.beginSessionClose(sessionId);
        handles = {
          message: acquired.message,
          goal: acquired.goal,
          automation: acquired.automation,
          resource: acquired.resource,
        };
        return {
          kind: 'prepared' as const,
          header,
        };
      });

      if (prepared.kind === 'remove_retry') {
        return await this.#admission.run(sessionId, async () => {
          try {
            await this.#stores.sessionStore.remove(sessionId);
            return successMutation({ kind: 'removed', sessionId });
          } catch {
            this.#requestDrain();
            return mutateFailure('commit_outcome_unknown', 'Session remove outcome is unknown');
          }
        });
      }
      if (prepared.kind === 'already_archived') {
        return successMutation({ kind: 'session', session: projectHeader(prepared.header) });
      }
      if (!handles) {
        throw new Error('Session lifecycle participants were not acquired');
      }

      const settled = await Promise.allSettled([
        handles.message.deliverStop(),
        handles.message.terminal,
        handles.goal.settled,
        handles.automation.settled,
        handles.resource.settled,
      ]);
      throwRejected(settled, 'Session lifecycle preparation failed');
      await this.#usage.flush();
      await this.#manager.disposeSessionBackend(sessionId);
      await handles.resource.commit();

      return await this.#admission.run(sessionId, async (lease) => {
        try {
          if (kind === 'archive') {
            await this.#stores.sessionStore.archive(sessionId);
            await this.#continuity.refreshCanonical(sessionId, lease);
          } else {
            await this.#stores.sessionStore.remove(sessionId);
            await this.#continuity.retireSession(sessionId, lease);
          }
          handles!.goal.commit();
          handles!.automation.commit();
          return kind === 'remove'
            ? successMutation({ kind: 'removed', sessionId })
            : successMutation({
                kind: 'session',
                session: projectHeader(
                  await this.#stores.sessionStore.readHeaderSnapshot(sessionId),
                ),
              });
        } catch {
          this.#requestDrain();
          return mutateFailure('commit_outcome_unknown', `Session ${kind} outcome is unknown`);
        }
      });
    } catch (error) {
      if (handles) {
        try {
          await this.#rollbackClose(sessionId, handles);
        } catch {
          this.#requestDrain();
          return mutateFailure('internal_failure', 'Session lifecycle rollback failed');
        }
      } else if (hasAcquiredCloseHandle(acquired)) {
        this.#requestDrain();
        await settlePartialClose(acquired);
        return mutateFailure('internal_failure', 'Session lifecycle preparation failed');
      }
      if (error instanceof SessionOperationFailure)
        return mutateOperationFailure(error, error.code);
      if (isMissingFile(error)) {
        return kind === 'remove'
          ? successMutation({ kind: 'removed', sessionId })
          : mutateFailure('not_found', 'Session does not exist');
      }
      return mutateFailure('persistence_failed', `Session ${kind} did not commit`);
    } finally {
      lifecycle.release();
      this.#lifecycleSessions.delete(sessionId);
    }
  }

  async #rollbackClose(sessionId: string, handles: SessionCloseHandles): Promise<void> {
    await handles.message.deliverStop().catch(() => undefined);
    await Promise.allSettled([
      handles.message.terminal,
      handles.goal.settled,
      handles.automation.settled,
      handles.resource.settled,
    ]);
    await this.#admission.run(sessionId, async (lease) => {
      await handles.resource.rollback();
      handles.goal.rollback();
      handles.automation.rollback();
      await this.#messages.resumeSession(sessionId, lease);
    });
  }

  async #unarchive(sessionId: string): Promise<OperationOutcome<'session.mutate'>> {
    const lifecycle = this.#beginLifecycle(sessionId);
    if (!lifecycle) {
      return mutateFailure('session_busy', 'Session lifecycle is already changing');
    }
    try {
      return await this.#admission.run(sessionId, async (lease) => {
        let header: SessionHeader;
        try {
          header = await this.#stores.sessionStore.readHeaderSnapshot(sessionId);
        } catch (error) {
          return isMissingFile(error)
            ? mutateFailure('not_found', 'Session does not exist')
            : mutateFailure('persistence_failed', 'Session persistence is unavailable');
        }
        if (!header.isArchived) {
          return successMutation({ kind: 'session', session: projectHeader(header) });
        }

        try {
          await this.#stores.sessionStore.unarchive(sessionId);
          this.#goals.unarchiveSession(sessionId);
          this.#automation.unarchiveSession(sessionId);
          this.#resources.resumeSession(sessionId);
          await this.#messages.resumeSession(sessionId, lease);
          await this.#continuity.refreshCanonical(sessionId, lease);
          return successMutation({
            kind: 'session',
            session: projectHeader(await this.#stores.sessionStore.readHeaderSnapshot(sessionId)),
          });
        } catch {
          this.#requestDrain();
          return mutateFailure('commit_outcome_unknown', 'Session unarchive outcome is unknown');
        }
      });
    } finally {
      lifecycle.release();
      this.#lifecycleSessions.delete(sessionId);
    }
  }

  #beginLifecycle(sessionId: string): SessionLifecycleAdmission | undefined {
    if (this.#lifecycleSessions.has(sessionId)) return undefined;
    this.#lifecycleSessions.add(sessionId);
    return this.#admission.beginSessionLifecycle(sessionId);
  }

  async #readHeaderIfPresent(sessionId: string): Promise<SessionHeader | undefined> {
    try {
      return await this.#stores.sessionStore.readHeaderSnapshot(sessionId);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async #resolveModel(
    target: SessionManagementModelTarget,
    thinkingLevel?: SessionManagementThinkingLevel,
  ): Promise<ResolvedSessionModel> {
    let snapshot;
    try {
      snapshot = await this.#runtimePolicy.connectionCatalog.getSnapshot();
    } catch {
      throw new SessionOperationFailure('persistence_failed', 'Connection catalog is unavailable');
    }

    const selected =
      target.kind === 'default'
        ? snapshot.defaultTarget
        : {
            connectionId:
              snapshot.connections.find((connection) => connection.slug === target.connectionSlug)
                ?.connectionId ?? '',
            modelId: target.model,
          };
    if (!selected) {
      throw new SessionOperationFailure(
        'operation_unavailable',
        'No default Session model is configured',
      );
    }
    const connection = snapshot.connections.find(
      (candidate) => candidate.connectionId === selected.connectionId,
    );
    if (!connection || !connection.enabled) {
      throw new SessionOperationFailure(
        'invalid_request',
        'Session model connection is unavailable',
      );
    }
    const model = connection.models.find((candidate) => candidate.id === selected.modelId);
    if (!connection.enabledModelIds.includes(selected.modelId) || !model) {
      throw new SessionOperationFailure('invalid_request', 'Session model is not enabled');
    }
    if (isModelExplicitlyUnsupportedForChat(model)) {
      throw new SessionOperationFailure('invalid_request', 'Session model is not chat-capable');
    }
    if (
      thinkingLevel !== undefined &&
      !thinkingVariantsForModel(connection.providerType, selected.modelId).includes(thinkingLevel)
    ) {
      throw new SessionOperationFailure(
        'invalid_request',
        `Session model does not support thinking level ${thinkingLevel}`,
      );
    }
    return { connectionSlug: connection.slug, model: selected.modelId };
  }
}

interface PreparedCreateRequest {
  readonly cwd: string;
  readonly name: string;
  readonly labels: readonly string[];
  readonly modelTarget: SessionManagementModelTarget;
  readonly thinkingLevel?: SessionManagementThinkingLevel;
  readonly permissionMode?: SessionManagementCreateInput['permissionMode'];
  readonly semanticKey: string;
}

function prepareCreateRequest(input: SessionManagementCreateInput): PreparedCreateRequest {
  if (input.collaborationMode === 'plan') {
    throw new SessionOperationFailure(
      'operation_unavailable',
      'Plan sessions are not yet supported by Runtime Host',
    );
  }
  if (isDeepResearchSession(input.labels) || isExpertTeamSession(input.labels)) {
    throw new SessionOperationFailure(
      'operation_unavailable',
      'Special Session modes are not yet supported by Runtime Host',
    );
  }
  const normalized = normalizeUserSessionName(input.name ?? DEFAULT_SESSION_NAME);
  if (!normalized.ok) throw new SessionOperationFailure('invalid_request', normalized.error);
  const cwd = resolve(input.cwd);
  const labels = [...(input.labels ?? [])];
  const canonicalIdentity = [
    'session.create.v0',
    input.sessionId,
    cwd,
    normalized.value,
    labels,
    input.modelTarget.kind === 'default'
      ? ['default']
      : ['explicit', input.modelTarget.connectionSlug, input.modelTarget.model],
    input.thinkingLevel ?? null,
    input.permissionMode ?? 'runtime_default',
    'agent',
  ];
  return {
    cwd,
    name: normalized.value,
    labels,
    modelTarget: input.modelTarget,
    ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    semanticKey: `sha256:${createHash('sha256').update(JSON.stringify(canonicalIdentity)).digest('hex')}`,
  };
}

function createInputFromHeader(header: SessionHeader): CreateSessionInput {
  return {
    cwd: header.cwd,
    backend: header.backend,
    llmConnectionSlug: header.llmConnectionSlug,
    model: header.model,
    ...(header.thinkingLevel === undefined ? {} : { thinkingLevel: header.thinkingLevel }),
    permissionMode: header.permissionMode,
    collaborationMode: header.collaborationMode ?? 'agent',
    name: header.name,
    labels: [...header.labels],
  };
}

function requiresIdleRoot(
  input: Exclude<
    SessionManagementMutation,
    { readonly kind: 'archive' | 'unarchive' | 'remove' | 'set_collaboration_mode' }
  >,
): boolean {
  return (
    input.kind === 'set_permission_mode' ||
    input.kind === 'set_model' ||
    input.kind === 'set_thinking_level' ||
    input.kind === 'move_cwd'
  );
}

function projectHeader(header: SessionHeader): SessionManagementProjection {
  return {
    id: header.id,
    cwd: header.cwd,
    ...(header.pendingCwdReminder ? { pendingCwdReminder: header.pendingCwdReminder } : {}),
    createdAt: header.createdAt,
    lastUsedAt: header.lastUsedAt,
    name: header.name,
    isFlagged: header.isFlagged,
    isArchived: header.isArchived,
    labels: [...header.labels],
    hasUnread: header.hasUnread,
    ...(header.lastMessageAt === undefined ? {} : { lastMessageAt: header.lastMessageAt }),
    status: header.status,
    ...(header.blockedReason ? { blockedReason: header.blockedReason } : {}),
    ...(header.statusUpdatedAt === undefined ? {} : { statusUpdatedAt: header.statusUpdatedAt }),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
    ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
    backend: header.backend,
    llmConnectionSlug: header.llmConnectionSlug,
    connectionLocked: header.connectionLocked,
    model: header.model,
    ...(header.thinkingLevel === undefined ? {} : { thinkingLevel: header.thinkingLevel }),
    permissionMode: header.permissionMode,
    collaborationMode: header.collaborationMode ?? 'agent',
  };
}

function projectSummary(
  summary: SessionSummary,
  header: SessionHeader,
): SessionManagementProjection {
  return {
    ...projectHeader(header),
    ...(summary.lastMessageAt === undefined ? {} : { lastMessageAt: summary.lastMessageAt }),
    ...(summary.lastMessagePreview === undefined
      ? {}
      : { lastMessagePreview: summary.lastMessagePreview }),
  };
}

function pageResult(
  items: readonly SessionManagementProjection[],
  nextOffset: number,
  total: number,
): SessionManagementQueryResult {
  return {
    kind: 'page',
    items,
    ...(nextOffset < total ? { nextCursor: String(nextOffset) } : {}),
  };
}

function decodeCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return 0;
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) return undefined;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

function resultBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function assertDirectory(path: string): Promise<void> {
  try {
    if ((await stat(path)).isDirectory()) return;
  } catch {
    // Project a stable invalid-request result below.
  }
  throw new SessionOperationFailure('invalid_request', 'Session cwd is not an existing directory');
}

function throwRejected(settled: readonly PromiseSettledResult<unknown>[], message: string): void {
  const errors = settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length > 0) throw new AggregateError(errors, message);
}

function hasAcquiredCloseHandle(handles: PartialSessionCloseHandles): boolean {
  return Boolean(handles.message || handles.goal || handles.automation || handles.resource);
}

async function settlePartialClose(handles: PartialSessionCloseHandles): Promise<void> {
  const settlements: Promise<unknown>[] = [];
  if (handles.message) {
    settlements.push(handles.message.deliverStop(), handles.message.terminal);
  }
  if (handles.goal) settlements.push(handles.goal.settled);
  if (handles.automation) settlements.push(handles.automation.settled);
  if (handles.resource) settlements.push(handles.resource.settled);
  await Promise.allSettled(settlements);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function successQuery(result: SessionManagementQueryResult): OperationOutcome<'session.query'> {
  return { ok: true, result: encodeSessionManagementQueryResult(result) };
}

function successMutation(
  result: SessionManagementMutateResult,
): OperationOutcome<'session.mutate'> {
  return { ok: true, result: encodeSessionManagementMutateResult(result) };
}

function queryFailure(
  code: OperationError<'session.query'>['code'],
  message: string,
): Extract<OperationOutcome<'session.query'>, { readonly ok: false }> {
  return { ok: false, error: { code, message } };
}

function createFailure(
  code: OperationError<'session.create'>['code'],
  message: string,
): Extract<OperationOutcome<'session.create'>, { readonly ok: false }> {
  return { ok: false, error: { code, message } };
}

function mutateFailure(
  code: OperationError<'session.mutate'>['code'],
  message: string,
): Extract<OperationOutcome<'session.mutate'>, { readonly ok: false }> {
  return { ok: false, error: { code, message } };
}

function createOperationFailure(
  error: unknown,
  fallback: OperationError<'session.create'>['code'],
): Extract<OperationOutcome<'session.create'>, { readonly ok: false }> {
  if (error instanceof SessionOperationFailure && error.code !== 'not_found') {
    return createFailure(error.code, error.message);
  }
  return createFailure(fallback, 'Session operation failed');
}

function mutateOperationFailure(
  error: unknown,
  fallback: OperationError<'session.mutate'>['code'],
): Extract<OperationOutcome<'session.mutate'>, { readonly ok: false }> {
  const code: OperationError<'session.mutate'>['code'] =
    error instanceof SessionOperationFailure ? error.code : fallback;
  const message =
    error instanceof SessionOperationFailure ? error.message : 'Session operation failed';
  return mutateFailure(code, message);
}
