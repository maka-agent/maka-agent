import { z } from 'zod';
import { stableHash } from './request-shape.js';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';

export const MEMORY_EVIDENCE_SEARCH_TOOL_NAME = 'memory_evidence_search';
export const MEMORY_EVIDENCE_READ_TOOL_NAME = 'memory_evidence_read';
export const MEMORY_SUBMIT_TOOL_NAME = 'memory_submit';

/** Includes replayed calls so a model cannot keep an Attempt alive by repeating valid inputs. */
const MAX_MEMORY_EXTRACTION_TOOL_INVOCATIONS = 12;

const OPAQUE_REF = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u);
const SEARCH_QUERY = z.string().trim().min(1).max(256);

const searchParameters = z
  .object({
    queries: z.array(SEARCH_QUERY).min(1).max(3),
    role: z.enum(['user', 'assistant', 'tool']).optional(),
    relativeTime: z.enum(['recent', 'earlier', 'before_current_turn']).optional(),
  })
  .strict();

const readParameters = z
  .object({
    spanRef: OPAQUE_REF,
    direction: z.enum(['before', 'after', 'both']),
  })
  .strict();

const absoluteTimeExpression = z
  .object({
    kind: z.literal('absolute'),
    value: z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2}(?:T\d{2}(?::\d{2})?)?)?)?$/u),
  })
  .strict();

const calendarOffsetTimeExpression = z
  .object({
    kind: z.literal('calendar_offset'),
    unit: z.enum(['minute', 'hour', 'day', 'week', 'month', 'year']),
    value: z.number().int(),
    anchorSourceRef: OPAQUE_REF,
  })
  .strict();

const calendarDateTimeExpression = z
  .object({
    kind: z.literal('calendar_date'),
    yearOffset: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31).optional(),
    anchorSourceRef: OPAQUE_REF,
  })
  .strict();

const timeExpression = z.discriminatedUnion('kind', [
  absoluteTimeExpression,
  calendarOffsetTimeExpression,
  calendarDateTimeExpression,
]);

const temporalProposal = z.discriminatedUnion('type', [
  z.object({ type: z.literal('undated') }).strict(),
  z.object({ type: z.literal('point'), at: timeExpression }).strict(),
  z
    .object({
      type: z.literal('interval'),
      start: timeExpression,
      end: timeExpression,
    })
    .strict(),
  z.object({ type: z.literal('open_ended'), start: timeExpression }).strict(),
]);

const memoryProposal = z
  .object({
    content: z.string().min(1).max(2_000),
    kind: z.enum(['preference', 'identity', 'context', 'knowledge', 'failure', 'note']),
    statementType: z.enum(['fact', 'plan', 'prediction']),
    temporal: temporalProposal,
    scopeProposal: z.enum(['global', 'workspace', 'ambiguous']),
    suggestedKeys: z
      .array(
        z
          .object({
            key: z.string().min(1).max(256),
            keyType: z.enum(['exact', 'entity', 'concept', 'alias', 'code']),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    supports: z
      .array(
        z
          .object({
            sourceRef: OPAQUE_REF,
            quote: z
              .string()
              .trim()
              .min(1)
              .max(256)
              .regex(/^[^\p{Cc}]+$/u),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

const extractionResponse = z
  .object({
    outcome: z.enum(['proposed', 'empty', 'unresolved', 'not_storable']),
    selectionSaturated: z.boolean(),
    proposals: z.array(memoryProposal).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === 'proposed' && value.proposals.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['proposals'],
        message: 'proposed requires at least one proposal',
      });
    }
    if (value.outcome !== 'proposed' && value.proposals.length !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['proposals'],
        message: `${value.outcome} requires an empty proposal list`,
      });
    }
  });

const resolveDecision = z
  .object({
    proposalRef: OPAQUE_REF,
    relation: z.enum(['same', 'revises', 'distinct', 'uncertain']),
    candidateRef: OPAQUE_REF.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const requiresCandidate = value.relation === 'same' || value.relation === 'revises';
    if (requiresCandidate && value.candidateRef === null) {
      context.addIssue({
        code: 'custom',
        path: ['candidateRef'],
        message: `${value.relation} requires a candidateRef`,
      });
    }
    if (!requiresCandidate && value.candidateRef !== null) {
      context.addIssue({
        code: 'custom',
        path: ['candidateRef'],
        message: `${value.relation} requires candidateRef to be null`,
      });
    }
  });

const submitParameters = z.discriminatedUnion('action', [
  z.object({ action: z.literal('propose'), result: extractionResponse }).strict(),
  z
    .object({
      action: z.literal('resolve'),
      submissionRef: OPAQUE_REF,
      decisions: z.array(resolveDecision).min(1).max(10),
    })
    .strict(),
]);

export type MemoryEvidenceSearchInput = z.infer<typeof searchParameters>;
export type MemoryEvidenceReadInput = z.infer<typeof readParameters>;
export type MemorySubmitInput = z.infer<typeof submitParameters>;
export type MemoryExtractionResponse = z.infer<typeof extractionResponse>;
export type MemoryProposal = z.infer<typeof memoryProposal>;
export type MemoryResolutionDecision = z.infer<typeof resolveDecision>;

export interface MemoryExtractionChildBinding {
  readonly operationId: string;
  readonly attemptId: string;
  readonly internalSessionId: string;
  readonly runId: string;
  readonly initialSourceRefs?: readonly string[];
  /** Defaults to two recoverable protocol errors for the complete Tool loop. */
  readonly repairBudget?: number;
  /** Host-owned cancellation seam for terminal, non-repairable protocol failures. */
  readonly onTerminalFailure?: (failure: MemoryExtractionTerminalToolFailure) => void;
}

export interface MemoryExtractionInvocation {
  readonly operationId: string;
  readonly attemptId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly toolCallId: string;
}

export interface MemoryEvidenceSourceView {
  readonly sourceRef: string;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly kind: 'message' | 'tool_call' | 'tool_result';
  readonly occurredAt: number;
  readonly content: string;
}

export interface MemoryEvidenceSpanView {
  readonly spanRef: string;
  readonly sources: readonly MemoryEvidenceSourceView[];
}

export interface MemoryEvidenceSearchResult {
  readonly status: 'ok';
  readonly spans: readonly MemoryEvidenceSpanView[];
  readonly truncated: boolean;
  readonly omittedCount: number;
}

export interface MemoryEvidenceReadResult {
  readonly status: 'ok';
  readonly span: MemoryEvidenceSpanView;
  readonly truncated: boolean;
}

export interface MemoryCandidateView {
  readonly content: string;
  readonly kind: MemoryProposal['kind'];
  readonly statementType: MemoryProposal['statementType'];
  readonly temporalType: 'undated' | 'point' | 'interval' | 'open_ended';
  readonly eventStartedAt: number | null;
  readonly eventEndedAt: number | null;
}

export interface MemoryResolutionCandidate {
  readonly candidateRef: string;
  readonly item: MemoryCandidateView;
}

export interface MemoryResolutionCase {
  readonly proposalRef: string;
  readonly proposal: MemoryProposal;
  readonly candidates: readonly MemoryResolutionCandidate[];
}

export interface MemorySubmissionReceipt {
  readonly status: 'committed';
  readonly resultType: 'proposed' | 'empty' | 'unresolved' | 'not_storable';
  readonly mutationCount: number;
  readonly replayed: boolean;
}

export interface MemorySubmissionNeedsResolution {
  readonly status: 'needs_resolution';
  readonly submissionRef: string;
  readonly cases: readonly MemoryResolutionCase[];
}

export type MemoryProposalSubmissionResult =
  | MemorySubmissionReceipt
  | MemorySubmissionNeedsResolution;

export interface MemoryExtractionChildAuthority {
  assertActive(invocation: MemoryExtractionInvocation): Promise<void> | void;
}

export interface MemoryEvidenceSearchPort {
  search(
    invocation: MemoryExtractionInvocation,
    input: MemoryEvidenceSearchInput,
    signal: AbortSignal,
  ): Promise<MemoryEvidenceSearchResult>;
}

export interface MemoryEvidenceReadPort {
  read(
    invocation: MemoryExtractionInvocation,
    input: MemoryEvidenceReadInput,
    signal: AbortSignal,
  ): Promise<MemoryEvidenceReadResult>;
}

export interface MemorySubmissionPort {
  propose(
    invocation: MemoryExtractionInvocation,
    response: MemoryExtractionResponse,
    signal: AbortSignal,
  ): Promise<MemoryProposalSubmissionResult>;
  resolve(
    invocation: MemoryExtractionInvocation,
    input: {
      readonly submissionRef: string;
      readonly decisions: readonly MemoryResolutionDecision[];
    },
    signal: AbortSignal,
  ): Promise<MemorySubmissionReceipt>;
}

export interface MemoryExtractionChildToolPorts {
  readonly authority: MemoryExtractionChildAuthority;
  readonly evidenceSearch: MemoryEvidenceSearchPort;
  readonly evidenceRead: MemoryEvidenceReadPort;
  readonly submission: MemorySubmissionPort;
}

export type MemoryToolExpectedPhase = 'search' | 'read' | 'propose' | 'resolve';

export interface MemoryToolErrorResult {
  readonly status: 'error';
  readonly code: string;
  readonly retryableInRun: boolean;
  readonly remainingRepairs: 0 | 1;
  readonly expectedPhase: MemoryToolExpectedPhase;
}

export class MemoryExtractionProtocolError extends Error {
  readonly code: string;
  readonly retryableInRun: boolean;
  readonly expectedPhase: MemoryToolExpectedPhase;

  constructor(input: {
    code: string;
    retryableInRun: boolean;
    expectedPhase: MemoryToolExpectedPhase;
  }) {
    super(input.code);
    this.name = 'MemoryExtractionProtocolError';
    this.code = input.code;
    this.retryableInRun = input.retryableInRun;
    this.expectedPhase = input.expectedPhase;
  }
}

export type MemoryEvidenceSearchToolResult = MemoryEvidenceSearchResult | MemoryToolErrorResult;
export type MemoryEvidenceReadToolResult = MemoryEvidenceReadResult | MemoryToolErrorResult;
export type MemorySubmitToolResult =
  | MemoryProposalSubmissionResult
  | MemorySubmissionReceipt
  | MemoryToolErrorResult;

/**
 * Builds one Attempt-bound internal Memory Tool set. The closure is the
 * authoritative in-run state machine; ports own evidence access, admission,
 * candidate lookup, and the final atomic commit.
 */
export function buildMemoryExtractionChildTools(
  binding: MemoryExtractionChildBinding,
  ports: MemoryExtractionChildToolPorts,
): readonly MakaTool[] {
  return createMemoryExtractionChildToolSet(binding, ports).tools;
}

export interface MemoryExtractionTerminalToolFailure {
  readonly code: string;
  readonly phase: MemoryToolExpectedPhase;
}

export interface MemoryExtractionChildToolSet {
  readonly tools: readonly MakaTool[];
  readonly terminalFailure: () => MemoryExtractionTerminalToolFailure | undefined;
}

export function createMemoryExtractionChildToolSet(
  binding: MemoryExtractionChildBinding,
  ports: MemoryExtractionChildToolPorts,
): MemoryExtractionChildToolSet {
  const state = new AttemptToolState(binding, ports);
  return Object.freeze({
    tools: buildMemoryExtractionToolDefinitions({
      search: (input, context) => state.search(input, context),
      read: (input, context) => state.read(input, context),
      submit: (input, context) => state.submit(input, context),
    }),
    terminalFailure: () => state.terminalFailure,
  });
}

/**
 * Provider-visible definitions for ordinary Agent runs. Host ACL must reject
 * these tools before dispatch; the implementation is an additional fail-closed
 * guard. Metadata comes from the same builder as the Attempt-bound tools.
 */
export function buildUnboundMemoryExtractionChildTools(): readonly MakaTool[] {
  return buildMemoryExtractionToolDefinitions({
    search: async () => protocolViolationResult('search'),
    read: async () => protocolViolationResult('read'),
    submit: async (input) =>
      protocolViolationResult(input.action === 'resolve' ? 'resolve' : 'propose'),
  });
}

interface MemoryExtractionToolHandlers {
  search(
    input: MemoryEvidenceSearchInput,
    context: MakaToolContext,
  ): Promise<MemoryEvidenceSearchToolResult>;
  read(
    input: MemoryEvidenceReadInput,
    context: MakaToolContext,
  ): Promise<MemoryEvidenceReadToolResult>;
  submit(input: MemorySubmitInput, context: MakaToolContext): Promise<MemorySubmitToolResult>;
}

function buildMemoryExtractionToolDefinitions(
  handlers: MemoryExtractionToolHandlers,
): readonly MakaTool[] {
  const searchTool: MakaTool<MemoryEvidenceSearchInput, MemoryEvidenceSearchToolResult> = {
    name: MEMORY_EVIDENCE_SEARCH_TOOL_NAME,
    displayName: 'Search memory evidence',
    description:
      'Internal memory-extraction protocol tool. Use only when the current user instruction explicitly identifies this run as a memory extraction operation; otherwise never call it. During extraction, search authorized current-session evidence only when supplied evidence cannot explain a reference to older content.',
    parameters: searchParameters,
    categoryHint: 'read',
    recoveryMode: 'replay_safe',
    impl: handlers.search,
  };
  const readTool: MakaTool<MemoryEvidenceReadInput, MemoryEvidenceReadToolResult> = {
    name: MEMORY_EVIDENCE_READ_TOOL_NAME,
    displayName: 'Read memory evidence',
    description:
      'Internal memory-extraction protocol tool. Use only when the current user instruction explicitly identifies this run as a memory extraction operation; otherwise never call it. During extraction, expand a spanRef returned by memory_evidence_search only when that span lacks necessary context.',
    parameters: readParameters,
    categoryHint: 'read',
    recoveryMode: 'replay_safe',
    impl: handlers.read,
  };
  const submitTool: MakaTool<MemorySubmitInput, MemorySubmitToolResult> = {
    name: MEMORY_SUBMIT_TOOL_NAME,
    displayName: 'Submit extracted memory',
    description:
      'Internal memory-extraction protocol tool. Use only when the current user instruction explicitly identifies this run as a memory extraction operation; otherwise never call it. During extraction, submit the complete result with action=propose, then resolve every returned candidate case if required.',
    parameters: submitParameters,
    categoryHint: 'custom_tool',
    recoveryMode: 'idempotent',
    executionSemantics: 'exclusive_step',
    impl: handlers.submit,
  };
  return Object.freeze([searchTool, readTool, submitTool]);
}

function protocolViolationResult(expectedPhase: MemoryToolExpectedPhase): MemoryToolErrorResult {
  return {
    status: 'error',
    code: 'protocol_violation',
    retryableInRun: false,
    remainingRepairs: 0,
    expectedPhase,
  };
}

class AttemptToolState {
  readonly #binding: MemoryExtractionChildBinding;
  readonly #ports: MemoryExtractionChildToolPorts;
  readonly #issuedSpanRefs = new Set<string>();
  readonly #issuedSourceRefs = new Set<string>();
  readonly #searchReplays = new Map<string, MemoryEvidenceSearchResult>();
  readonly #readReplays = new Map<string, MemoryEvidenceReadResult>();
  #remainingRepairs: number;
  #remainingToolInvocations = MAX_MEMORY_EXTRACTION_TOOL_INVOCATIONS;
  #terminated = false;
  #terminalFailure: MemoryExtractionTerminalToolFailure | undefined;
  #submission:
    | undefined
    | {
        proposeDigest: string;
        proposeResult: MemoryProposalSubmissionResult;
        submissionRef?: string;
        cases?: readonly MemoryResolutionCase[];
        resolveDigest?: string;
        resolveResult?: MemorySubmissionReceipt;
      };

  constructor(binding: MemoryExtractionChildBinding, ports: MemoryExtractionChildToolPorts) {
    this.#binding = binding;
    this.#ports = ports;
    this.#remainingRepairs = Math.max(0, Math.min(2, binding.repairBudget ?? 2));
    for (const sourceRef of binding.initialSourceRefs ?? []) this.#issuedSourceRefs.add(sourceRef);
  }

  get terminalFailure(): MemoryExtractionTerminalToolFailure | undefined {
    return this.#terminalFailure;
  }

  async search(
    input: MemoryEvidenceSearchInput,
    context: MakaToolContext,
  ): Promise<MemoryEvidenceSearchToolResult> {
    return this.#guard('search', context, async (invocation) => {
      const digest = stableHash(input);
      const replay = this.#searchReplays.get(digest);
      if (replay) return replay;
      const result = await this.#ports.evidenceSearch.search(
        invocation,
        input,
        context.abortSignal,
      );
      this.#recordSpanViews(result.spans);
      this.#searchReplays.set(digest, result);
      return result;
    });
  }

  async read(
    input: MemoryEvidenceReadInput,
    context: MakaToolContext,
  ): Promise<MemoryEvidenceReadToolResult> {
    return this.#guard('read', context, async (invocation) => {
      if (!this.#issuedSpanRefs.has(input.spanRef)) {
        throw protocolError('invalid_span_ref', false, 'read');
      }
      const digest = stableHash(input);
      const replay = this.#readReplays.get(digest);
      if (replay) return replay;
      const result = await this.#ports.evidenceRead.read(invocation, input, context.abortSignal);
      this.#recordSpanViews([result.span]);
      this.#readReplays.set(digest, result);
      return result;
    });
  }

  async submit(
    input: MemorySubmitInput,
    context: MakaToolContext,
  ): Promise<MemorySubmitToolResult> {
    return input.action === 'propose'
      ? this.#propose(input.result, context)
      : this.#resolve(input, context);
  }

  async #propose(
    response: MemoryExtractionResponse,
    context: MakaToolContext,
  ): Promise<MemorySubmitToolResult> {
    const digest = stableHash(response);
    return this.#guard(
      'propose',
      context,
      async (invocation) => {
        if (this.#submission) {
          if (this.#submission.proposeResult.status === 'committed') {
            throw protocolError('submission_already_committed', false, 'propose');
          }
          throw protocolError('active_submission_exists', true, this.#expectedSubmissionPhase());
        }
        this.#validateProposalSourceRefs(response);
        const result = await this.#ports.submission.propose(
          invocation,
          response,
          context.abortSignal,
        );
        if (result.status === 'needs_resolution') this.#validateResolutionCases(response, result);
        this.#submission = {
          proposeDigest: digest,
          proposeResult: result,
          ...(result.status === 'needs_resolution'
            ? { submissionRef: result.submissionRef, cases: result.cases }
            : {}),
        };
        return result;
      },
      () =>
        this.#submission?.proposeDigest === digest ? this.#submission.proposeResult : undefined,
    );
  }

  async #resolve(
    input: Extract<MemorySubmitInput, { action: 'resolve' }>,
    context: MakaToolContext,
  ): Promise<MemorySubmitToolResult> {
    const digest = stableHash(input);
    return this.#guard(
      'resolve',
      context,
      async (invocation) => {
        const active = this.#submission;
        if (!active?.submissionRef || !active.cases) {
          throw protocolError('resolve_without_active_submission', true, 'propose');
        }
        if (input.submissionRef !== active.submissionRef) {
          throw protocolError('invalid_submission_ref', false, 'resolve');
        }
        if (active.resolveDigest) {
          throw protocolError('submission_already_resolved', false, 'resolve');
        }
        this.#validateDecisions(input.decisions, active.cases);
        const result = await this.#ports.submission.resolve(
          invocation,
          { submissionRef: input.submissionRef, decisions: input.decisions },
          context.abortSignal,
        );
        active.resolveDigest = digest;
        active.resolveResult = result;
        return result;
      },
      () => {
        const active = this.#submission;
        return active?.resolveDigest === digest ? active.resolveResult : undefined;
      },
    );
  }

  async #guard<T>(
    phase: MemoryToolExpectedPhase,
    context: MakaToolContext,
    execute: (invocation: MemoryExtractionInvocation) => Promise<T>,
    replay?: (invocation: MemoryExtractionInvocation) => T | undefined,
  ): Promise<T | MemoryToolErrorResult> {
    try {
      if (this.#terminated) throw protocolError('protocol_violation', false, phase);
      if (this.#remainingToolInvocations <= 0) {
        throw protocolError('tool_budget_exhausted', false, phase);
      }
      this.#remainingToolInvocations -= 1;
      const invocation = this.#invocation(context, phase);
      const replayed = replay?.(invocation);
      if (replayed !== undefined) return replayed;
      await this.#ports.authority.assertActive(invocation);
      return await execute(invocation);
    } catch (error) {
      if (!(error instanceof MemoryExtractionProtocolError)) throw error;
      const repairAccepted = error.retryableInRun && this.#remainingRepairs > 0;
      if (repairAccepted) this.#remainingRepairs -= 1;
      const retryable = repairAccepted && this.#remainingRepairs > 0;
      if (!retryable) {
        this.#terminated = true;
        this.#terminalFailure = { code: error.code, phase };
        this.#binding.onTerminalFailure?.(this.#terminalFailure);
      }
      return {
        status: 'error',
        code: error.code,
        retryableInRun: retryable,
        remainingRepairs: retryable ? 1 : 0,
        expectedPhase: error.expectedPhase,
      };
    }
  }

  #invocation(
    context: MakaToolContext,
    expectedPhase: MemoryToolExpectedPhase,
  ): MemoryExtractionInvocation {
    if (
      context.sessionId !== this.#binding.internalSessionId ||
      !context.runId ||
      context.runId !== this.#binding.runId
    ) {
      throw protocolError('protocol_violation', false, expectedPhase);
    }
    return Object.freeze({
      operationId: this.#binding.operationId,
      attemptId: this.#binding.attemptId,
      sessionId: context.sessionId,
      runId: context.runId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
    });
  }

  #recordSpanViews(spans: readonly MemoryEvidenceSpanView[]): void {
    for (const span of spans) {
      this.#issuedSpanRefs.add(span.spanRef);
      for (const source of span.sources) this.#issuedSourceRefs.add(source.sourceRef);
    }
  }

  #validateProposalSourceRefs(response: MemoryExtractionResponse): void {
    for (const proposal of response.proposals) {
      const supportRefs = new Set(proposal.supports.map((support) => support.sourceRef));
      for (const sourceRef of supportRefs) {
        if (!this.#issuedSourceRefs.has(sourceRef)) {
          throw protocolError('invalid_source_ref', false, 'propose');
        }
      }
      for (const anchorRef of temporalAnchorRefs(proposal.temporal)) {
        if (!supportRefs.has(anchorRef)) {
          throw protocolError('temporal_anchor_not_supported', true, 'propose');
        }
      }
    }
  }

  #validateResolutionCases(
    response: MemoryExtractionResponse,
    result: MemorySubmissionNeedsResolution,
  ): void {
    if (response.outcome !== 'proposed' || result.cases.length === 0) {
      throw new Error('Trusted Memory Submission Port returned invalid resolution cases');
    }
    const proposalRefs = new Set<string>();
    const proposalDigests = new Set(response.proposals.map((proposal) => stableHash(proposal)));
    for (const resolutionCase of result.cases) {
      if (
        proposalRefs.has(resolutionCase.proposalRef) ||
        !proposalDigests.has(stableHash(resolutionCase.proposal))
      ) {
        throw new Error('Trusted Memory Submission Port returned invalid proposalRef mapping');
      }
      proposalRefs.add(resolutionCase.proposalRef);
      if (resolutionCase.candidates.length === 0 || resolutionCase.candidates.length > 5) {
        throw new Error('Trusted Memory Submission Port returned an invalid candidate set');
      }
      const candidateRefs = new Set<string>();
      for (const candidate of resolutionCase.candidates) {
        if (candidateRefs.has(candidate.candidateRef)) {
          throw new Error('Trusted Memory Submission Port returned a duplicate candidateRef');
        }
        candidateRefs.add(candidate.candidateRef);
      }
    }
  }

  #validateDecisions(
    decisions: readonly MemoryResolutionDecision[],
    cases: readonly MemoryResolutionCase[],
  ): void {
    if (decisions.length !== cases.length) {
      throw protocolError('incomplete_resolution', true, 'resolve');
    }
    const caseByProposal = new Map(cases.map((entry) => [entry.proposalRef, entry] as const));
    const seen = new Set<string>();
    for (const decision of decisions) {
      const resolutionCase = caseByProposal.get(decision.proposalRef);
      if (!resolutionCase || seen.has(decision.proposalRef)) {
        throw protocolError('invalid_proposal_ref', false, 'resolve');
      }
      seen.add(decision.proposalRef);
      if (decision.candidateRef !== null) {
        const allowed = resolutionCase.candidates.some(
          (candidate) => candidate.candidateRef === decision.candidateRef,
        );
        if (!allowed) throw protocolError('invalid_candidate_ref', false, 'resolve');
      }
    }
  }

  #expectedSubmissionPhase(): MemoryToolExpectedPhase {
    return this.#submission?.submissionRef ? 'resolve' : 'propose';
  }
}

function protocolError(
  code: string,
  retryableInRun: boolean,
  expectedPhase: MemoryToolExpectedPhase,
): MemoryExtractionProtocolError {
  return new MemoryExtractionProtocolError({ code, retryableInRun, expectedPhase });
}

function temporalAnchorRefs(temporal: MemoryProposal['temporal']): readonly string[] {
  const expressions =
    temporal.type === 'undated'
      ? []
      : temporal.type === 'point'
        ? [temporal.at]
        : temporal.type === 'interval'
          ? [temporal.start, temporal.end]
          : [temporal.start];
  return expressions.flatMap((expression) =>
    expression.kind === 'absolute' ? [] : [expression.anchorSourceRef],
  );
}
