import type { AnyPermissionRequestEvent, UserQuestionRequestEvent } from '@maka/core/events';
import type {
  InteractionClosureReason,
  InteractionQuestionClosureReason,
} from '@maka/core/interaction';
import type { PermissionResponse } from '@maka/core/permission';
import type { UserQuestionResponse } from '@maka/core/user-question';

export type RuntimeInteractionClosureReason = InteractionClosureReason;

export type RuntimeInteractionRunClosureReason = Extract<
  RuntimeInteractionClosureReason,
  'turn_stopped' | 'turn_terminal'
>;

export type RuntimeUserQuestionClosureReason = InteractionQuestionClosureReason;

export interface RuntimeInteractionContinuationIdentity {
  readonly requestId: string;
  readonly turnId: string;
  readonly runId: string;
}

export interface RuntimeInteractionRunIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
}

export interface RuntimePermissionAnswer {
  /** A canonical answer is routed only by its bound continuation. */
  readonly requestId?: never;
  readonly decision: PermissionResponse['decision'];
  readonly rememberForTurn?: boolean;
  readonly reviewer?: PermissionResponse['reviewer'];
  readonly riskLevel?: PermissionResponse['riskLevel'];
}

export interface RuntimeUserQuestionAnswer {
  /** A canonical answer is routed only by its bound continuation. */
  readonly requestId?: never;
  readonly answers: UserQuestionResponse['answers'];
}

export type RuntimePermissionOutcome =
  | { kind: 'permission_answer'; answer: RuntimePermissionAnswer }
  | { kind: 'closure'; reason: RuntimeInteractionClosureReason };

export type RuntimeUserQuestionOutcome =
  | { kind: 'question_answer'; answer: RuntimeUserQuestionAnswer }
  | { kind: 'closure'; reason: RuntimeUserQuestionClosureReason };

export type RuntimeInteractionFatalError =
  | RuntimeInteractionFailStopError
  | RuntimeInteractionInvariantError;

export interface RuntimePermissionContinuation extends RuntimeInteractionContinuationIdentity {
  applyAnswer(answer: RuntimePermissionAnswer): void;
  applyClosure(reason: RuntimeInteractionClosureReason): void;
}

export interface RuntimeUserQuestionContinuation extends RuntimeInteractionContinuationIdentity {
  applyAnswer(answer: RuntimeUserQuestionAnswer): void;
  applyClosure(reason: RuntimeUserQuestionClosureReason): void;
}

/**
 * Durable Interaction boundary supplied by the Runtime Host. Embedded runtimes
 * omit it and retain their existing in-process ownership.
 */
export interface RuntimeInteractionContinuationAuthority {
  acceptPermissionRequest(input: {
    request: AnyPermissionRequestEvent;
    /** Stable non-secret identity for remember-for-turn sibling requests. */
    rememberScopeId?: string;
    /** Exact in-memory continuation; the Host never persists or projects it. */
    continuation: RuntimePermissionContinuation;
  }): Promise<void>;

  /** Resolves only after the canonical outcome settled this continuation. */
  commitPermissionAnswer(input: {
    continuation: RuntimePermissionContinuation;
    answer: RuntimePermissionAnswer;
  }): Promise<RuntimePermissionOutcome>;

  /** Resolves only after the canonical outcome settled this continuation. */
  commitPermissionTimeout(input: {
    continuation: RuntimePermissionContinuation;
  }): Promise<RuntimePermissionOutcome>;

  acceptUserQuestionRequest(input: {
    request: UserQuestionRequestEvent;
    /** Exact in-memory continuation; the Host never persists or projects it. */
    continuation: RuntimeUserQuestionContinuation;
  }): Promise<void>;
}

export interface RuntimeInteractionRunFacet
  extends RuntimeInteractionContinuationAuthority,
    RuntimeInteractionRunIdentity {}

export interface RuntimeInteractionRunOwner extends RuntimeInteractionRunFacet {
  /**
   * Durable-first closure for this exact live Run. Repeating the same closure
   * is idempotent for the same reason.
   */
  close(reason: RuntimeInteractionRunClosureReason): Promise<void>;

  /** Releases Host-side routing after Runtime has permanently revoked this facet. */
  release(): void;
}

/** Process-wide factory. It never admits or settles a request directly. */
export interface RuntimeInteractionAuthority {
  bindRun(identity: RuntimeInteractionRunIdentity): RuntimeInteractionRunOwner;
}

/** Closure applied to a continuation whose request was already durable. */
export class RuntimeInteractionClosedError extends Error {
  readonly name = 'RuntimeInteractionClosedError';

  constructor(
    readonly requestId: string,
    readonly reason: RuntimeInteractionClosureReason,
  ) {
    super(`Interaction request ${requestId} was already closed: ${reason}`);
  }
}

export type RuntimeInteractionAdmissionRejectionReason =
  | 'capacity_exceeded'
  | 'invalid_request'
  | 'not_published'
  | 'run_closed'
  | 'request_settled'
  | 'authority_draining';

export class RuntimeInteractionAdmissionRejectedError extends Error {
  readonly name = 'RuntimeInteractionAdmissionRejectedError';
  readonly requestId: string;
  readonly reason: RuntimeInteractionAdmissionRejectionReason;
  readonly closureReason: RuntimeInteractionRunClosureReason | undefined;

  constructor(requestId: string, reason: 'capacity_exceeded' | 'invalid_request');
  constructor(requestId: string, reason: 'not_published', authorityFailure: unknown);
  constructor(requestId: string, reason: 'request_settled' | 'authority_draining');
  constructor(
    requestId: string,
    reason: 'run_closed',
    closureReason: RuntimeInteractionRunClosureReason,
  );
  constructor(
    requestId: string,
    reason: RuntimeInteractionAdmissionRejectionReason,
    authorityFailureOrClosureReason?: unknown,
  ) {
    const closureReason =
      reason === 'run_closed'
        ? (authorityFailureOrClosureReason as RuntimeInteractionRunClosureReason)
        : undefined;
    super(
      reason === 'run_closed'
        ? `Interaction request ${requestId} was not admitted because its run closed: ${closureReason}`
        : `Interaction request ${requestId} was not admitted: ${reason}`,
      reason === 'not_published' ? { cause: authorityFailureOrClosureReason } : undefined,
    );
    this.requestId = requestId;
    this.reason = reason;
    this.closureReason = closureReason;
  }
}

export class RuntimeInteractionInvariantError extends Error {
  readonly name = 'RuntimeInteractionInvariantError';
}

export class RuntimeInteractionFailStopError extends Error {
  readonly name = 'RuntimeInteractionFailStopError';

  constructor(
    message: string,
    readonly authorityFailure: unknown,
  ) {
    super(message, { cause: authorityFailure });
  }
}
