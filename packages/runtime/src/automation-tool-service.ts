import type {
  AutomationDefinition,
  AutomationKind,
  AutomationManager,
  AutomationSchedule,
  AutomationStatus,
} from './automation-state.js';

export interface AutomationToolRequester {
  /** The session currently invoking the model tool. */
  sessionId: string;
}

export interface AutomationToolProjection {
  id: string;
  kind: AutomationKind;
  name: string;
  status: AutomationStatus;
  schedule: AutomationSchedule;
  nextFireAt: number | null;
  lastFireAt: number | null;
  fireCount: number;
  maxFires: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  durable: boolean;
  deferredFireCount: number;
}

export interface AutomationToolCreateRequest {
  requester: AutomationToolRequester;
  kind: AutomationKind;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  maxFires?: number;
  durable?: boolean;
}

export interface AutomationToolByIdRequest {
  requester: AutomationToolRequester;
  id: string;
}

export interface AutomationToolListRequest {
  requester: AutomationToolRequester;
}

export type AutomationToolCreateResult =
  | { outcome: 'created'; automation: AutomationToolProjection }
  | { outcome: 'rejected'; error: string };

export type AutomationToolDeleteResult =
  | { outcome: 'deleted' }
  | { outcome: 'not_found_or_not_owned' };

export type AutomationToolPauseResult =
  | { outcome: 'paused'; automation: AutomationToolProjection }
  | { outcome: 'not_found_or_invalid' };

export type AutomationToolResumeResult =
  | { outcome: 'resumed'; automation: AutomationToolProjection }
  | { outcome: 'fire_budget_exhausted'; automation: AutomationToolProjection }
  | { outcome: 'not_found_or_invalid' };

/** Model-tool-facing port. Hosted implementations own persistence and scheduling. */
export interface AutomationToolService {
  create(request: AutomationToolCreateRequest): Promise<AutomationToolCreateResult>;
  delete(request: AutomationToolByIdRequest): Promise<AutomationToolDeleteResult>;
  list(request: AutomationToolListRequest): Promise<readonly AutomationToolProjection[]>;
  pause(request: AutomationToolByIdRequest): Promise<AutomationToolPauseResult>;
  resume(request: AutomationToolByIdRequest): Promise<AutomationToolResumeResult>;
}

export interface AutomationManagerToolServiceDeps {
  automationManager: AutomationManager;
  onAutomationChange?: () => void;
}

/** Adapts the embedded in-memory manager without changing its synchronous mutation order. */
export function createAutomationManagerToolService(
  deps: AutomationManagerToolServiceDeps,
): AutomationToolService {
  const changed = async <T>(run: () => T): Promise<T> => {
    const result = run();
    deps.onAutomationChange?.();
    return result;
  };

  return {
    create: (request) =>
      changed(() => {
        const result = deps.automationManager.create({
          kind: request.kind,
          name: request.name,
          prompt: request.prompt,
          sessionId: request.requester.sessionId,
          schedule: request.schedule,
          maxFires: request.maxFires,
          durable: request.durable,
        });
        return 'error' in result
          ? { outcome: 'rejected' as const, error: result.error }
          : { outcome: 'created' as const, automation: projectAutomation(result) };
      }),
    delete: (request) =>
      changed(() => ({
        outcome: deps.automationManager.delete(request.id, request.requester.sessionId)
          ? ('deleted' as const)
          : ('not_found_or_not_owned' as const),
      })),
    list: (request) =>
      Promise.resolve(
        deps.automationManager
          .listVisibleForSession(request.requester.sessionId)
          .map(projectAutomation),
      ),
    pause: (request) =>
      changed(() => {
        const automation = deps.automationManager.pause(request.id, request.requester.sessionId);
        return automation
          ? { outcome: 'paused' as const, automation: projectAutomation(automation) }
          : { outcome: 'not_found_or_invalid' as const };
      }),
    resume: (request) =>
      changed(() => {
        const automation = deps.automationManager.resume(request.id, request.requester.sessionId);
        if (automation) {
          return { outcome: 'resumed' as const, automation: projectAutomation(automation) };
        }

        const existing = deps.automationManager
          .listVisibleForSession(request.requester.sessionId)
          .find((candidate) => candidate.id === request.id);
        const exhausted =
          existing?.status === 'paused' &&
          ((existing.maxFires != null && existing.fireCount >= existing.maxFires) ||
            (existing.schedule.type === 'once' && existing.fireCount > 0));
        return exhausted && existing
          ? {
              outcome: 'fire_budget_exhausted' as const,
              automation: projectAutomation(existing),
            }
          : { outcome: 'not_found_or_invalid' as const };
      }),
  };
}

function projectAutomation(automation: AutomationDefinition): AutomationToolProjection {
  return {
    id: automation.id,
    kind: automation.kind,
    name: automation.name,
    status: automation.status,
    schedule: automation.schedule,
    nextFireAt: automation.nextFireAt,
    lastFireAt: automation.lastFireAt,
    fireCount: automation.fireCount,
    maxFires: automation.maxFires,
    lastError: automation.lastError,
    consecutiveFailures: automation.consecutiveFailures,
    durable: automation.durable === true,
    deferredFireCount: automation.deferredFireCount ?? 0,
  };
}
