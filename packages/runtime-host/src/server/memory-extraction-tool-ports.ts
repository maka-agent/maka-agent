import { createHash, randomBytes } from 'node:crypto';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { redactSecrets } from '@maka/core/redaction';
import {
  normalizeLongTermMemoryContent,
  type MemoryExtractionCandidate,
  type MemoryExtractionOperation,
  type MemoryItemMutation,
  type MemoryItemRecord,
  type MemoryItemStore,
  type MemoryItemWrite,
  type MemorySha256Digest,
} from '@maka/core/long-term-memory';
import { decodeRuntimePrefixSegment } from '@maka/core/runtime-boundary';
import { stableJsonStringify } from '@maka/core/tool-args-identity';
import {
  MemoryExtractionProtocolError,
  type MemoryEvidenceReadInput,
  type MemoryEvidenceReadResult,
  type MemoryEvidenceSearchInput,
  type MemoryEvidenceSearchResult,
  type MemoryEvidenceSourceView,
  type MemoryEvidenceSpanView,
  type MemoryExtractionChildToolPorts,
  type MemoryExtractionInvocation,
  type MemoryExtractionResponse,
  type MemoryProposal,
  type MemoryProposalSubmissionResult,
  type MemoryResolutionDecision,
  type MemorySubmissionReceipt,
} from '@maka/runtime';

const SEARCH_MATCH_LIMIT = 5;
const SEARCH_CANDIDATE_LIMIT = 20;
const EXPOSED_CANDIDATE_LIMIT = 5;
/** Additional searched/read evidence only; the frozen extraction Range is already model-bounded. */
const MAX_ADDITIONAL_EVIDENCE_CHARS = 32_768;
const MAX_SEARCH_CALLS = 3;
const MAX_READ_CALLS = 4;
const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

type OperationStore = Pick<
  MemoryItemStore,
  | 'readMemoryExtractionOperation'
  | 'readMemoryExtractionAttempt'
  | 'searchMemoryExtractionCandidates'
  | 'commitMemoryExtraction'
>;

export interface HostMemoryExtractionAttemptPortsInput {
  readonly operationId: string;
  readonly attemptId: string;
  readonly internalSessionId: string;
  readonly runId: string;
  /** PR1 canonical Workspace identity derived from the Storage Root, never cwd. */
  readonly workspaceKey: string;
  readonly operations: OperationStore;
  readonly runtimeEvents: Pick<
    RuntimeEventStore,
    'readImmutableRuntimeEvents' | 'readImmutableRuntimePrefix'
  >;
  /** Short SessionAdmissionGate critical section used only for final commit. */
  readonly commitWithParentAdmission: <Result>(
    parentSessionId: string,
    commit: () => Promise<Result>,
  ) => Promise<Result>;
  readonly now?: () => number;
}

interface AuthorizedSource {
  readonly view: MemoryEvidenceSourceView;
  readonly event: RuntimeEvent;
  readonly digest: MemorySha256Digest;
  readonly turnIndex: number;
}

interface AuthorizedTurn {
  readonly key: string;
  readonly sources: readonly AuthorizedSource[];
}

interface AuthorizedEvidence {
  readonly operation: MemoryExtractionOperation;
  readonly turns: readonly AuthorizedTurn[];
  readonly initialTurnIndexes: ReadonlySet<number>;
}

interface IssuedSpan {
  readonly evidenceDigest: string;
  readonly firstTurn: number;
  readonly lastTurn: number;
  readonly depth: number;
}

interface AdmittedProposal {
  readonly proposalRef: string;
  readonly proposal: MemoryProposal;
  readonly write: MemoryItemWrite;
  readonly candidateByRef: ReadonlyMap<string, MemoryExtractionCandidate>;
  readonly deterministic: boolean;
  readonly deterministicMutation?: MemoryItemMutation;
}

interface ActiveSubmission {
  readonly submissionRef: string;
  readonly response: MemoryExtractionResponse;
  readonly admitted: readonly AdmittedProposal[];
}

type DatedTemporalProposal = Exclude<MemoryProposal['temporal'], { type: 'undated' }>;
type TemporalExpressionOf<T> = T extends { at: infer Expression }
  ? Expression
  : T extends { start: infer Expression }
    ? Expression
    : never;
type TimeExpression = TemporalExpressionOf<DatedTemporalProposal>;

/**
 * Attempt-scoped Runtime Host implementation of the three internal Memory
 * tools. All model-visible references are opaque capabilities owned by this
 * instance and are revalidated against the durable Operation on every call.
 */
export class HostMemoryExtractionAttemptPorts implements MemoryExtractionChildToolPorts {
  readonly authority = {
    assertActive: (invocation: MemoryExtractionInvocation) => this.#assertActive(invocation),
  };
  readonly evidenceSearch = {
    search: (
      invocation: MemoryExtractionInvocation,
      input: MemoryEvidenceSearchInput,
      signal: AbortSignal,
    ) => this.#search(invocation, input, signal),
  };
  readonly evidenceRead = {
    read: (
      invocation: MemoryExtractionInvocation,
      input: MemoryEvidenceReadInput,
      signal: AbortSignal,
    ) => this.#read(invocation, input, signal),
  };
  readonly submission = {
    propose: (
      invocation: MemoryExtractionInvocation,
      response: MemoryExtractionResponse,
      signal: AbortSignal,
    ) => this.#propose(invocation, response, signal),
    resolve: (
      invocation: MemoryExtractionInvocation,
      input: {
        readonly submissionRef: string;
        readonly decisions: readonly MemoryResolutionDecision[];
      },
      signal: AbortSignal,
    ) => this.#resolve(invocation, input, signal),
  };

  readonly #input: HostMemoryExtractionAttemptPortsInput;
  readonly #refSecret = randomBytes(32);
  readonly #issuedSources = new Map<string, AuthorizedSource>();
  readonly #issuedSpans = new Map<string, IssuedSpan>();
  #remainingEvidenceChars = MAX_ADDITIONAL_EVIDENCE_CHARS;
  #searchCalls = 0;
  #readCalls = 0;
  #initialSpan: MemoryEvidenceSpanView | undefined;
  #activeSubmission: ActiveSubmission | undefined;

  constructor(input: HostMemoryExtractionAttemptPortsInput) {
    this.#input = input;
  }

  /** Initial Range/target Turn projection supplied to the Child prompt. */
  async prepareInitialEvidence(): Promise<MemoryEvidenceSpanView> {
    if (this.#initialSpan) return this.#initialSpan;
    const evidence = await this.#loadAuthorizedEvidence();
    const indexes = [...evidence.initialTurnIndexes].sort((left, right) => left - right);
    if (indexes.length === 0) {
      this.#initialSpan = this.#issueSpan(evidence, 0, -1, 0);
      return this.#initialSpan;
    }
    // The scheduler freezes this Range from an already model-bounded parent
    // request. Do not reject a valid coverage Range using the smaller budget
    // reserved for optional historical search/read expansion.
    this.#initialSpan = this.#issueSpan(evidence, indexes[0]!, indexes.at(-1)!, 0);
    return this.#initialSpan;
  }

  async #assertActive(invocation: MemoryExtractionInvocation): Promise<void> {
    if (
      invocation.operationId !== this.#input.operationId ||
      invocation.attemptId !== this.#input.attemptId ||
      invocation.sessionId !== this.#input.internalSessionId ||
      invocation.runId !== this.#input.runId
    ) {
      throw protocolError('protocol_violation', false, 'search');
    }
    const [operation, attempt] = await Promise.all([
      this.#input.operations.readMemoryExtractionOperation(this.#input.operationId),
      this.#input.operations.readMemoryExtractionAttempt(this.#input.attemptId),
    ]);
    if (
      !operation ||
      !attempt ||
      operation.state !== 'running' ||
      operation.activeAttemptId !== this.#input.attemptId ||
      operation.internalSessionId !== this.#input.internalSessionId ||
      operation.sessionId === this.#input.internalSessionId ||
      attempt.state !== 'running' ||
      attempt.operationId !== this.#input.operationId ||
      attempt.runId !== this.#input.runId
    ) {
      throw protocolError('stale_attempt', false, 'search');
    }
  }

  async #search(
    _invocation: MemoryExtractionInvocation,
    input: MemoryEvidenceSearchInput,
    signal: AbortSignal,
  ): Promise<MemoryEvidenceSearchResult> {
    throwIfAborted(signal, 'search');
    this.#searchCalls += 1;
    if (this.#searchCalls > MAX_SEARCH_CALLS) {
      throw protocolError('evidence_search_limit', false, 'search');
    }
    const evidence = await this.#loadAuthorizedEvidence();
    const terms = input.queries.map(searchText).filter(Boolean);
    let indexes = evidence.turns.flatMap((turn, index) =>
      turn.sources.some(
        (source) =>
          (!input.role || source.view.role === input.role) &&
          terms.some((term) => searchText(source.view.content).includes(term)),
      )
        ? [index]
        : [],
    );
    if (input.relativeTime === 'before_current_turn') {
      const latest = evidence.turns.length - 1;
      indexes = indexes.filter((index) => index < latest);
    }
    if (input.relativeTime === 'recent') indexes.reverse();
    const omittedCount = Math.max(0, indexes.length - SEARCH_MATCH_LIMIT);
    indexes = indexes.slice(0, SEARCH_MATCH_LIMIT).sort((left, right) => left - right);
    const neighborhoods = mergeNeighborhoods(
      indexes.map((index) => ({
        first: Math.max(0, index - 1),
        last: Math.min(evidence.turns.length - 1, index + 1),
      })),
    );
    let remaining = this.#remainingEvidenceChars;
    const spans: MemoryEvidenceSpanView[] = [];
    let budgetTruncated = false;
    for (const neighborhood of neighborhoods) {
      const size = spanCharCount(evidence, neighborhood.first, neighborhood.last);
      if (size > remaining) {
        budgetTruncated = true;
        continue;
      }
      remaining -= size;
      spans.push(this.#issueSpan(evidence, neighborhood.first, neighborhood.last, 0));
    }
    this.#remainingEvidenceChars = remaining;
    return {
      status: 'ok',
      spans,
      truncated: omittedCount > 0 || budgetTruncated,
      omittedCount: omittedCount + (budgetTruncated ? neighborhoods.length - spans.length : 0),
    };
  }

  async #read(
    _invocation: MemoryExtractionInvocation,
    input: MemoryEvidenceReadInput,
    signal: AbortSignal,
  ): Promise<MemoryEvidenceReadResult> {
    throwIfAborted(signal, 'read');
    this.#readCalls += 1;
    if (this.#readCalls > MAX_READ_CALLS) {
      throw protocolError('evidence_read_limit', false, 'read');
    }
    const issued = this.#issuedSpans.get(input.spanRef);
    if (!issued) throw protocolError('invalid_span_ref', false, 'read');
    if (issued.depth >= 2) throw protocolError('evidence_read_limit', false, 'read');
    const evidence = await this.#loadAuthorizedEvidence();
    if (evidenceDigest(evidence) !== issued.evidenceDigest) {
      throw protocolError('evidence_changed', false, 'read');
    }
    const first =
      input.direction === 'after' ? issued.firstTurn : Math.max(0, issued.firstTurn - 1);
    const last =
      input.direction === 'before'
        ? issued.lastTurn
        : Math.min(evidence.turns.length - 1, issued.lastTurn + 1);
    const size = spanCharCount(evidence, first, last);
    const truncated = size > this.#remainingEvidenceChars;
    if (truncated) throw protocolError('evidence_budget_exhausted', false, 'read');
    this.#remainingEvidenceChars -= size;
    return {
      status: 'ok',
      span: this.#issueSpan(evidence, first, last, issued.depth + 1),
      truncated: false,
    };
  }

  async #propose(
    _invocation: MemoryExtractionInvocation,
    response: MemoryExtractionResponse,
    signal: AbortSignal,
  ): Promise<MemoryProposalSubmissionResult> {
    throwIfAborted(signal, 'propose');
    const operation = await this.#requireOperation();
    validateOutcome(operation, response);
    if (response.outcome !== 'proposed') {
      return this.#commit(operation, response, [], signal);
    }
    const proposalInputs: Array<{
      index: number;
      proposal: MemoryProposal;
      write: MemoryItemWrite;
    }> = [];
    const equivalentByDigest = new Map<string, number>();
    for (const [index, proposal] of response.proposals.entries()) {
      const write = this.#admitProposal(operation, proposal);
      const equivalence = digest({
        content: write.content,
        kind: write.kind,
        statementType: write.statementType,
        temporalType: write.temporalType,
        scopeType: write.scopeType,
        scopeKey: write.scopeKey,
        eventStartedAt: write.eventStartedAt,
        eventEndedAt: write.eventEndedAt,
      });
      const priorIndex = equivalentByDigest.get(equivalence);
      if (priorIndex !== undefined) {
        const prior = proposalInputs[priorIndex]!;
        proposalInputs[priorIndex] = {
          ...prior,
          write: {
            ...prior.write,
            observedAt: Math.max(prior.write.observedAt, write.observedAt),
            keys: uniqueKeys([...prior.write.keys, ...write.keys]),
            sources: uniqueSources([...prior.write.sources, ...write.sources]),
          },
        };
        continue;
      }
      equivalentByDigest.set(equivalence, proposalInputs.length);
      proposalInputs.push({ index, proposal, write });
    }

    const admitted: AdmittedProposal[] = [];
    for (const { index, proposal, write } of proposalInputs) {
      const query = await this.#input.operations.searchMemoryExtractionCandidates({
        content: write.content,
        kind: write.kind,
        statementType: write.statementType,
        temporalType: write.temporalType,
        scopeType: write.scopeType,
        scopeKey: write.scopeKey,
        eventStartedAt: write.eventStartedAt,
        eventEndedAt: write.eventEndedAt,
        keys: write.keys.map((key) => key.key),
        sourceEventIds: write.sources.map((source) => source.eventId),
        limit: SEARCH_CANDIDATE_LIMIT,
      });
      const proposalRef = this.#ref('proposal', `${index}:${digest(proposal)}`);
      const exact = query.candidates.find((candidate) => exactCandidate(candidate, write));
      if (exact) {
        admitted.push({
          proposalRef,
          proposal,
          write,
          candidateByRef: new Map(),
          deterministic: true,
          deterministicMutation: mergeSameCandidate(exact.record, write),
        });
        continue;
      }
      if (query.candidates.length === 0) {
        admitted.push({
          proposalRef,
          proposal,
          write,
          candidateByRef: new Map(),
          deterministic: true,
          deterministicMutation: { type: 'create', item: write },
        });
        continue;
      }
      const strong = query.candidates.filter(
        (candidate) => candidate.contentHashMatch || candidate.sourceOverlapCount > 0,
      );
      if (strong.length > EXPOSED_CANDIDATE_LIMIT) {
        throw protocolError('candidate_ambiguity', false, 'resolve');
      }
      const exposed = query.candidates.slice(0, EXPOSED_CANDIDATE_LIMIT);
      const candidateByRef = new Map<string, MemoryExtractionCandidate>();
      for (const candidate of exposed) {
        const candidateRef = this.#ref(
          'candidate',
          `${proposalRef}:${candidate.record.item.itemId}:${candidate.record.item.version}:${candidate.record.item.contentHash}`,
        );
        candidateByRef.set(candidateRef, candidate);
      }
      admitted.push({ proposalRef, proposal, write, candidateByRef, deterministic: false });
    }

    const unresolved = admitted.filter((proposal) => !proposal.deterministic);
    if (unresolved.length === 0) {
      return this.#commit(
        operation,
        response,
        admitted.flatMap((proposal) =>
          proposal.deterministicMutation ? [proposal.deterministicMutation] : [],
        ),
        signal,
      );
    }
    const submissionRef = this.#ref('submission', digest(response));
    this.#activeSubmission = { submissionRef, response, admitted };
    return {
      status: 'needs_resolution',
      submissionRef,
      cases: unresolved.map((entry) => ({
        proposalRef: entry.proposalRef,
        proposal: entry.proposal,
        candidates: [...entry.candidateByRef.entries()].map(([candidateRef, candidate]) => ({
          candidateRef,
          item: itemView(candidate.record),
        })),
      })),
    };
  }

  async #resolve(
    _invocation: MemoryExtractionInvocation,
    input: {
      readonly submissionRef: string;
      readonly decisions: readonly MemoryResolutionDecision[];
    },
    signal: AbortSignal,
  ): Promise<MemorySubmissionReceipt> {
    throwIfAborted(signal, 'resolve');
    const submission = this.#activeSubmission;
    if (!submission || submission.submissionRef !== input.submissionRef) {
      throw protocolError('invalid_submission_ref', false, 'resolve');
    }
    const unresolved = submission.admitted.filter((entry) => !entry.deterministic);
    if (
      input.decisions.length !== unresolved.length ||
      new Set(input.decisions.map((decision) => decision.proposalRef)).size !== unresolved.length
    ) {
      throw protocolError('incomplete_resolution', true, 'resolve');
    }
    const byProposal = new Map(input.decisions.map((decision) => [decision.proposalRef, decision]));
    const mutations: MemoryItemMutation[] = [];
    const revisedItems = new Set<string>();
    for (const entry of submission.admitted) {
      if (entry.deterministic) {
        if (entry.deterministicMutation) mutations.push(entry.deterministicMutation);
        continue;
      }
      const decision = byProposal.get(entry.proposalRef);
      if (!decision) throw protocolError('incomplete_resolution', true, 'resolve');
      if (decision.relation === 'distinct' || decision.relation === 'uncertain') {
        mutations.push({ type: 'create', item: entry.write });
        continue;
      }
      const candidate = decision.candidateRef
        ? entry.candidateByRef.get(decision.candidateRef)
        : undefined;
      if (!candidate) throw protocolError('invalid_candidate_ref', false, 'resolve');
      if (revisedItems.has(candidate.record.item.itemId)) {
        throw protocolError('conflicting_resolution', false, 'resolve');
      }
      revisedItems.add(candidate.record.item.itemId);
      if (decision.relation === 'same') {
        const mutation = mergeSameCandidate(candidate.record, entry.write);
        if (mutation) mutations.push(mutation);
      } else {
        const mutation = reviseCandidate(candidate.record, entry.write);
        mutations.push(mutation ?? { type: 'create', item: entry.write });
      }
    }
    const operation = await this.#requireOperation();
    return this.#commit(operation, submission.response, mutations, signal);
  }

  #admitProposal(operation: MemoryExtractionOperation, proposal: MemoryProposal): MemoryItemWrite {
    const normalized = normalizeLongTermMemoryContent(proposal.content);
    if (!normalized.ok) throw protocolError('invalid_content', false, 'propose');
    const supports = proposal.supports.map((support) => {
      const source = this.#issuedSources.get(support.sourceRef);
      if (!source) throw protocolError('invalid_source_ref', false, 'propose');
      if (/\p{Cc}/u.test(support.quote)) {
        throw protocolError('invalid_quote', false, 'propose');
      }
      const quote = normalizeEvidenceText(support.quote).trim();
      if (quote.length === 0) throw protocolError('invalid_quote', false, 'propose');
      if (containsSecret(quote) || !source.view.content.includes(quote)) {
        throw protocolError(
          containsSecret(quote) ? 'secret_detected' : 'quote_mismatch',
          !containsSecret(quote),
          'propose',
        );
      }
      return source;
    });
    if (
      containsSecret(normalized.value) ||
      proposal.suggestedKeys.some((key) => containsSecret(key.key))
    ) {
      throw protocolError('secret_detected', false, 'propose');
    }
    const hasUserSource = supports.some((source) => source.view.role === 'user');
    const hasNonAgentEvidence = supports.some(
      (source) => source.view.role === 'user' || source.view.role === 'tool',
    );
    if ((proposal.kind === 'preference' || proposal.kind === 'identity') && !hasUserSource) {
      throw protocolError('insufficient_user_evidence', false, 'propose');
    }
    if (proposal.statementType === 'plan' && !hasUserSource) {
      throw protocolError('insufficient_user_evidence', false, 'propose');
    }
    if ((proposal.kind === 'failure' || proposal.kind === 'knowledge') && !hasNonAgentEvidence) {
      throw protocolError('insufficient_direct_evidence', false, 'propose');
    }
    const scopeType =
      proposal.scopeProposal === 'global' &&
      (proposal.kind === 'preference' || proposal.kind === 'identity') &&
      hasUserSource
        ? 'global'
        : 'workspace';
    const temporal = resolveTemporal(
      proposal,
      this.#issuedSources,
      requireCalendarTimeZone(operation.requestJson),
    );
    const observedAt = Math.max(...supports.map((source) => source.event.ts));
    if (observedAt > this.#now()) throw protocolError('invalid_observed_at', false, 'propose');
    return {
      content: normalized.value,
      kind: proposal.kind,
      statementType: proposal.statementType,
      temporalType: temporal.temporalType,
      scopeType,
      scopeKey: scopeType === 'workspace' ? this.#input.workspaceKey : null,
      eventStartedAt: temporal.eventStartedAt,
      eventEndedAt: temporal.eventEndedAt,
      observedAt,
      origin: operation.triggerKind === 'user_requested' ? 'user_requested' : 'agent_extracted',
      keys: proposal.suggestedKeys.map((key) => ({
        key: key.key,
        keyType: key.keyType,
        keyOrigin: 'llm',
      })),
      sources: uniqueSources(
        supports.map((source) => ({
          sessionId: source.event.sessionId,
          runId: source.event.runId,
          turnId: source.event.turnId,
          eventId: source.event.id,
        })),
      ),
    };
  }

  async #commit(
    operation: MemoryExtractionOperation,
    response: MemoryExtractionResponse,
    mutations: readonly MemoryItemMutation[],
    signal: AbortSignal,
  ): Promise<MemorySubmissionReceipt> {
    throwIfAborted(signal, 'propose');
    const updateTargets = mutations.flatMap((mutation) =>
      mutation.type === 'update' ? [mutation.itemId] : [],
    );
    if (new Set(updateTargets).size !== updateTargets.length) {
      throw protocolError('conflicting_resolution', false, 'resolve');
    }
    const result = await this.#input.commitWithParentAdmission(operation.sessionId, async () => {
      await this.#revalidateIssuedSources();
      return this.#input.operations.commitMemoryExtraction({
        operationId: operation.operationId,
        attemptId: this.#input.attemptId,
        runId: this.#input.runId,
        resultType: response.outcome,
        selectionSaturated: response.selectionSaturated,
        evidenceDigest: digest(
          [...this.#issuedSources.entries()]
            .map(([sourceRef, source]) => ({ sourceRef, digest: source.digest }))
            .sort((left, right) => left.sourceRef.localeCompare(right.sourceRef)),
        ),
        mutations,
        diagnosticRetentionUntil: this.#now() + DIAGNOSTIC_RETENTION_MS,
      });
    });
    return {
      status: 'committed',
      resultType: response.outcome,
      mutationCount: result.receipt.mutationResults.filter((entry) => entry.outcome !== 'noop')
        .length,
      replayed: result.replayed,
    };
  }

  async #requireOperation(): Promise<MemoryExtractionOperation> {
    const operation = await this.#input.operations.readMemoryExtractionOperation(
      this.#input.operationId,
    );
    if (
      !operation ||
      operation.state !== 'running' ||
      operation.activeAttemptId !== this.#input.attemptId ||
      operation.internalSessionId !== this.#input.internalSessionId ||
      operation.sessionId === this.#input.internalSessionId
    ) {
      throw protocolError('stale_attempt', false, 'propose');
    }
    return operation;
  }

  async #revalidateIssuedSources(): Promise<void> {
    const evidence = await this.#loadAuthorizedEvidence();
    const currentByEventId = new Map(
      evidence.turns
        .flatMap((turn) => turn.sources)
        .map((source) => [source.event.id, source] as const),
    );
    for (const source of this.#issuedSources.values()) {
      const current = currentByEventId.get(source.event.id);
      if (
        !current ||
        current.digest !== source.digest ||
        current.event.sessionId !== source.event.sessionId ||
        current.event.runId !== source.event.runId ||
        current.event.turnId !== source.event.turnId
      ) {
        throw protocolError('evidence_changed', false, 'propose');
      }
    }
  }

  async #loadAuthorizedEvidence(): Promise<AuthorizedEvidence> {
    const operation = await this.#requireOperation();
    const manifest = parseManifest(operation.requestJson);
    const runs: Array<{
      runId: string;
      toEventSeqInclusive: number;
      toEventId: string;
      prefixDigest: MemorySha256Digest;
      fromEventSeqExclusive: number;
      initialTurnId?: string;
    }> = [];
    if (operation.mode === 'sweep') {
      for (const range of operation.ranges) {
        if (range.sessionId !== operation.sessionId) {
          throw protocolError('evidence_boundary_mismatch', false, 'search');
        }
        runs.push({
          runId: range.runId,
          toEventSeqInclusive: range.toEventSeqInclusive,
          toEventId: range.toEventId,
          prefixDigest: range.toPrefixDigest,
          fromEventSeqExclusive: range.fromEventSeqExclusive,
        });
      }
    } else {
      const segment = decodeRuntimePrefixSegment(manifest.searchBoundary);
      if (segment.identity.sessionId !== operation.sessionId) {
        throw protocolError('evidence_boundary_mismatch', false, 'search');
      }
      runs.push({
        runId: segment.identity.runId,
        toEventSeqInclusive: segment.position.lastEventSeq,
        toEventId: segment.position.lastEventId,
        prefixDigest: segment.prefixDigest,
        fromEventSeqExclusive: 0,
        initialTurnId: segment.identity.turnId,
      });
    }

    const targetedPriorRunIds =
      operation.mode === 'targeted' ? authorizedPriorRunIds(manifest, runs[0]!.runId) : [];
    const orderedRunIds =
      operation.mode === 'targeted'
        ? [...targetedPriorRunIds, runs[0]!.runId]
        : runs.map((run) => run.runId);
    const runOrder = new Map(orderedRunIds.map((runId, index) => [runId, index] as const));
    const authorizedEntries = new Map<
      string,
      { event: RuntimeEvent; initial: boolean; runOrder: number; eventSeq: number }
    >();
    for (const run of runs) {
      const readPrefix = this.#input.runtimeEvents.readImmutableRuntimePrefix;
      if (!readPrefix) throw protocolError('evidence_authority_unavailable', false, 'search');
      const prefix = await readPrefix.call(this.#input.runtimeEvents, {
        sessionId: operation.sessionId,
        runId: run.runId,
        upToEventSeq: run.toEventSeqInclusive,
      });
      if (
        prefix.position.lastEventId !== run.toEventId ||
        prefix.prefixDigest !== run.prefixDigest ||
        prefix.identity.sessionId !== operation.sessionId ||
        prefix.identity.runId !== run.runId
      ) {
        throw protocolError('evidence_changed', false, 'search');
      }
      for (const [index, event] of prefix.events.entries()) {
        const eventSeq = index + 1;
        authorizedEntries.set(event.id, {
          event,
          initial:
            (operation.mode === 'sweep' && eventSeq > run.fromEventSeqExclusive) ||
            (operation.mode === 'targeted' && event.turnId === run.initialTurnId),
          runOrder: runOrder.get(run.runId) ?? Number.MAX_SAFE_INTEGER,
          eventSeq,
        });
      }
    }
    if (operation.mode === 'targeted') {
      const readImmutableEvents = this.#input.runtimeEvents.readImmutableRuntimeEvents;
      if (!readImmutableEvents) {
        throw protocolError('evidence_authority_unavailable', false, 'search');
      }
      for (const priorRunId of targetedPriorRunIds) {
        const events = await readImmutableEvents.call(
          this.#input.runtimeEvents,
          operation.sessionId,
          priorRunId,
        );
        assertTerminalPriorRun(events, operation.sessionId, priorRunId);
        for (const [index, event] of events.entries()) {
          authorizedEntries.set(event.id, {
            event,
            initial: false,
            runOrder: runOrder.get(priorRunId) ?? Number.MAX_SAFE_INTEGER,
            eventSeq: index + 1,
          });
        }
      }
    }
    const authorizedEvents = [...authorizedEntries.values()].sort(
      (left, right) => left.runOrder - right.runOrder || left.eventSeq - right.eventSeq,
    );
    const projectedViews = projectEvidenceViews(authorizedEvents.map((entry) => entry.event));
    const turns: Array<{ key: string; sources: AuthorizedSource[] }> = [];
    const turnIndexByKey = new Map<string, number>();
    const initialTurnIndexes = new Set<number>();
    for (const entry of authorizedEvents) {
      const event = entry.event;
      const view = projectedViews.get(event.id);
      if (!view) continue;
      const key = `${event.runId}:${event.turnId}`;
      let turnIndex = turnIndexByKey.get(key);
      if (turnIndex === undefined) {
        turnIndex = turns.length;
        turnIndexByKey.set(key, turnIndex);
        turns.push({ key, sources: [] });
      }
      turns[turnIndex]!.sources.push({
        view: { ...view, sourceRef: '' },
        event,
        digest: digest(view.content),
        turnIndex,
      });
      if (entry.initial) initialTurnIndexes.add(turnIndex);
    }
    return { operation, turns, initialTurnIndexes };
  }

  #issueSpan(
    evidence: AuthorizedEvidence,
    firstTurn: number,
    lastTurn: number,
    depth: number,
  ): MemoryEvidenceSpanView {
    const sources =
      lastTurn < firstTurn
        ? []
        : evidence.turns
            .slice(firstTurn, lastTurn + 1)
            .flatMap((turn) => turn.sources)
            .map((source) => this.#issueSource(source));
    const spanRef = this.#ref(
      'span',
      `${evidenceDigest(evidence)}:${firstTurn}:${lastTurn}:${depth}`,
    );
    this.#issuedSpans.set(spanRef, {
      evidenceDigest: evidenceDigest(evidence),
      firstTurn,
      lastTurn,
      depth,
    });
    return { spanRef, sources };
  }

  #issueSource(source: AuthorizedSource): MemoryEvidenceSourceView {
    const sourceRef = this.#ref(
      'source',
      `${source.event.sessionId}:${source.event.runId}:${source.event.turnId}:${source.event.id}:${source.digest}`,
    );
    const issued = { ...source, view: { ...source.view, sourceRef } };
    this.#issuedSources.set(sourceRef, issued);
    return issued.view;
  }

  #ref(kind: string, material: string): string {
    return `${kind}_${createHash('sha256')
      .update(this.#refSecret)
      .update('\0')
      .update(this.#input.operationId)
      .update('\0')
      .update(this.#input.attemptId)
      .update('\0')
      .update(material)
      .digest('base64url')}`;
  }

  #now(): number {
    return (this.#input.now ?? Date.now)();
  }
}

function validateOutcome(
  operation: MemoryExtractionOperation,
  response: MemoryExtractionResponse,
): void {
  const valid =
    operation.mode === 'sweep'
      ? response.outcome === 'proposed' || response.outcome === 'empty'
      : response.outcome === 'proposed' ||
        response.outcome === 'unresolved' ||
        response.outcome === 'not_storable';
  if (!valid) throw protocolError('invalid_outcome', false, 'propose');
}

function exactCandidate(candidate: MemoryExtractionCandidate, write: MemoryItemWrite): boolean {
  const item = candidate.record.item;
  return (
    candidate.contentHashMatch &&
    item.content === write.content &&
    item.kind === write.kind &&
    item.statementType === write.statementType &&
    item.temporalType === write.temporalType &&
    item.scopeType === write.scopeType &&
    item.scopeKey === (write.scopeKey ?? null) &&
    item.eventStartedAt === (write.eventStartedAt ?? null) &&
    item.eventEndedAt === (write.eventEndedAt ?? null)
  );
}

function mergeSameCandidate(
  record: MemoryItemRecord,
  write: MemoryItemWrite,
): MemoryItemMutation | undefined {
  const keys = uniqueKeys([
    ...record.keys.map((key) => ({
      key: key.key,
      keyType: key.keyType,
      keyOrigin: key.keyOrigin,
    })),
    ...write.keys,
  ]);
  const sources = uniqueSources([...record.sources, ...write.sources]);
  if (keys.length === record.keys.length && sources.length === record.sources.length)
    return undefined;
  return {
    type: 'update',
    itemId: record.item.itemId,
    expectedVersion: record.item.version,
    item: {
      content: record.item.content,
      kind: record.item.kind,
      statementType: record.item.statementType,
      temporalType: record.item.temporalType,
      scopeType: record.item.scopeType,
      scopeKey: record.item.scopeKey,
      eventStartedAt: record.item.eventStartedAt,
      eventEndedAt: record.item.eventEndedAt,
      observedAt: Math.max(record.item.observedAt, write.observedAt),
      origin: record.item.origin,
      keys,
      sources,
    },
  };
}

function reviseCandidate(
  record: MemoryItemRecord,
  write: MemoryItemWrite,
): MemoryItemMutation | undefined {
  const oldKeys = new Set(record.keys.map((key) => key.normalizedKey));
  const overlappingKey = write.keys.some((key) => oldKeys.has(searchText(key.key)));
  if (
    record.item.lifecycleState !== 'active' ||
    record.item.scopeType !== write.scopeType ||
    record.item.scopeKey !== (write.scopeKey ?? null) ||
    record.item.kind !== write.kind ||
    record.item.statementType !== write.statementType ||
    record.item.temporalType !== write.temporalType ||
    record.item.eventStartedAt !== (write.eventStartedAt ?? null) ||
    record.item.eventEndedAt !== (write.eventEndedAt ?? null) ||
    !overlappingKey ||
    write.observedAt < record.item.observedAt
  ) {
    return undefined;
  }
  return {
    type: 'update',
    itemId: record.item.itemId,
    expectedVersion: record.item.version,
    item: write,
  };
}

function itemView(record: MemoryItemRecord) {
  return {
    content: record.item.content,
    kind: record.item.kind,
    statementType: record.item.statementType,
    temporalType: record.item.temporalType,
    eventStartedAt: record.item.eventStartedAt,
    eventEndedAt: record.item.eventEndedAt,
  };
}

function textEventView(
  event: RuntimeEvent,
): Omit<MemoryEvidenceSourceView, 'sourceRef'> | undefined {
  if (event.partial || !event.content) return undefined;
  if (event.content.kind !== 'text' || (event.role !== 'user' && event.role !== 'model')) {
    return undefined;
  }
  return {
    role: event.role === 'user' ? 'user' : 'assistant',
    kind: 'message',
    occurredAt: event.ts,
    content: normalizeEvidenceText(event.content.text),
  };
}

function projectEvidenceViews(
  events: readonly RuntimeEvent[],
): ReadonlyMap<string, Omit<MemoryEvidenceSourceView, 'sourceRef'>> {
  const views = new Map<string, Omit<MemoryEvidenceSourceView, 'sourceRef'>>();
  const calls = new Map<string, RuntimeEvent>();
  const responses = new Map<string, RuntimeEvent>();
  for (const event of events) {
    const text = textEventView(event);
    if (text) views.set(event.id, text);
    if (event.partial || !event.content) continue;
    if (event.content.kind === 'function_call') {
      if (isMemoryControlTool(event.content.name)) continue;
      const key = `${event.runId}:${event.content.id}`;
      if (calls.has(key)) throw protocolError('invalid_tool_projection', false, 'read');
      calls.set(key, event);
    } else if (event.content.kind === 'function_response') {
      if (isMemoryControlTool(event.content.name)) continue;
      const key = `${event.runId}:${event.content.id}`;
      if (responses.has(key)) {
        throw protocolError('invalid_tool_projection', false, 'read');
      }
      responses.set(key, event);
    }
  }
  for (const [toolCallKey, callEvent] of calls) {
    const responseEvent = responses.get(toolCallKey);
    if (
      !responseEvent ||
      callEvent.content?.kind !== 'function_call' ||
      responseEvent.content?.kind !== 'function_response' ||
      callEvent.content.name !== responseEvent.content.name ||
      callEvent.turnId !== responseEvent.turnId ||
      callEvent.runId !== responseEvent.runId
    ) {
      if (callEvent.content?.kind === 'function_call') {
        views.set(callEvent.id, {
          role: 'tool',
          kind: 'tool_call',
          occurredAt: callEvent.ts,
          content: normalizeEvidenceText(
            `tool_call name=${callEvent.content.name} outcome=unknown args=${stableJsonStringify(callEvent.content.args)}`,
          ),
        });
      }
      continue;
    }
    views.set(callEvent.id, {
      role: 'tool',
      kind: 'tool_call',
      occurredAt: callEvent.ts,
      content: normalizeEvidenceText(
        `tool_call name=${callEvent.content.name} args=${stableJsonStringify(callEvent.content.args)}`,
      ),
    });
    views.set(responseEvent.id, {
      role: 'tool',
      kind: 'tool_result',
      occurredAt: responseEvent.ts,
      content: normalizeEvidenceText(
        `tool_result name=${responseEvent.content.name} isError=${responseEvent.content.isError === true ? 'true' : 'false'} result=${stableJsonStringify(responseEvent.content.result)}`,
      ),
    });
  }
  // Orphan results are omitted: without the canonical call they cannot prove
  // which request produced the value. Other Turn evidence remains usable.
  return views;
}

function isMemoryControlTool(name: string): boolean {
  return (
    name === 'memory_remember' ||
    name === 'memory_extract' ||
    name === 'memory_evidence_search' ||
    name === 'memory_evidence_read' ||
    name === 'memory_submit'
  );
}

function resolveTemporal(
  proposal: MemoryProposal,
  sources: ReadonlyMap<string, AuthorizedSource>,
  timeZone: string,
): {
  temporalType: 'undated' | 'point' | 'interval' | 'open_ended';
  eventStartedAt: number | null;
  eventEndedAt: number | null;
} {
  if (proposal.temporal.type === 'undated') {
    return { temporalType: 'undated', eventStartedAt: null, eventEndedAt: null };
  }
  if (proposal.temporal.type === 'point') {
    const value = resolveTimeExpression(proposal.temporal.at, proposal, sources, timeZone);
    return { temporalType: 'point', eventStartedAt: value.start, eventEndedAt: value.end };
  }
  if (proposal.temporal.type === 'open_ended') {
    const value = resolveTimeExpression(proposal.temporal.start, proposal, sources, timeZone);
    return { temporalType: 'open_ended', eventStartedAt: value.start, eventEndedAt: null };
  }
  const start = resolveTimeExpression(proposal.temporal.start, proposal, sources, timeZone).start;
  const end = resolveTimeExpression(proposal.temporal.end, proposal, sources, timeZone).end;
  if (end <= start) throw protocolError('invalid_temporal_range', false, 'propose');
  return { temporalType: 'interval', eventStartedAt: start, eventEndedAt: end };
}

function resolveTimeExpression(
  expression: TimeExpression,
  proposal: MemoryProposal,
  sources: ReadonlyMap<string, AuthorizedSource>,
  timeZone: string,
): { start: number; end: number } {
  if (expression.kind === 'absolute') return absoluteBucket(expression.value, timeZone);
  const anchor = sources.get(expression.anchorSourceRef);
  if (
    !anchor ||
    !proposal.supports.some((support) => support.sourceRef === expression.anchorSourceRef)
  ) {
    throw protocolError('invalid_time_anchor', false, 'propose');
  }
  const anchorFields = zonedParts(anchor.event.ts, timeZone);
  if (expression.kind === 'calendar_date') {
    const year = anchorFields.year + expression.yearOffset;
    const fields = {
      year,
      month: expression.month,
      day: expression.day ?? 1,
      hour: 0,
      minute: 0,
    };
    assertValidCalendarFields(fields);
    const start = zonedDateTimeToUtc(fields, timeZone);
    const end = zonedDateTimeToUtc(
      addCalendarFields(fields, expression.day ? 'day' : 'month', 1),
      timeZone,
    );
    return { start, end };
  }
  const shifted = addCalendarFields(
    anchorFields,
    expression.unit === 'week' ? 'day' : expression.unit,
    expression.unit === 'week' ? expression.value * 7 : expression.value,
  );
  const start = zonedDateTimeToUtc(shifted, timeZone);
  const end = zonedDateTimeToUtc(addCalendarFields(shifted, 'minute', 1), timeZone);
  return { start, end };
}

function absoluteBucket(value: string, timeZone: string): { start: number; end: number } {
  const [datePart, timePart] = value.split('T');
  const parts = datePart!.split('-').map(Number);
  const year = parts[0]!;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  const time = timePart?.split(':').map(Number) ?? [];
  const hour = time[0] ?? 0;
  const minute = time[1] ?? 0;
  const fields = { year, month, day, hour, minute };
  assertValidCalendarFields(fields);
  const start = zonedDateTimeToUtc(fields, timeZone);
  const endFields =
    time.length === 2
      ? addCalendarFields(fields, 'minute', 1)
      : time.length === 1
        ? addCalendarFields(fields, 'hour', 1)
        : parts.length === 3
          ? addCalendarFields(fields, 'day', 1)
          : parts.length === 2
            ? addCalendarFields(fields, 'month', 1)
            : addCalendarFields(fields, 'year', 1);
  const end = zonedDateTimeToUtc(endFields, timeZone);
  return { start, end };
}

interface CalendarFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function assertValidCalendarFields(fields: CalendarFields): void {
  const timestamp = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
  const value = new Date(timestamp);
  if (
    !Number.isFinite(timestamp) ||
    value.getUTCFullYear() !== fields.year ||
    value.getUTCMonth() !== fields.month - 1 ||
    value.getUTCDate() !== fields.day ||
    value.getUTCHours() !== fields.hour ||
    value.getUTCMinutes() !== fields.minute
  ) {
    throw protocolError('invalid_calendar_time', false, 'propose');
  }
}

function addCalendarFields(
  fields: CalendarFields,
  unit: 'minute' | 'hour' | 'day' | 'month' | 'year',
  value: number,
): CalendarFields {
  const date = new Date(
    Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute),
  );
  if (unit === 'minute') date.setUTCMinutes(date.getUTCMinutes() + value);
  else if (unit === 'hour') date.setUTCHours(date.getUTCHours() + value);
  else if (unit === 'day') date.setUTCDate(date.getUTCDate() + value);
  else if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + value);
  else date.setUTCFullYear(date.getUTCFullYear() + value);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

function zonedParts(timestamp: number, timeZone: string): CalendarFields {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
  };
}

function zonedDateTimeToUtc(fields: CalendarFields, timeZone: string): number {
  assertValidCalendarFields(fields);
  const desired = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
  let candidate = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(candidate, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    const delta = desired - actualAsUtc;
    if (delta === 0) return candidate;
    candidate += delta;
  }
  const final = zonedParts(candidate, timeZone);
  if (stableJsonStringify(final) !== stableJsonStringify(fields)) {
    throw protocolError('invalid_calendar_time', false, 'propose');
  }
  return candidate;
}

function parseManifest(json: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw protocolError('invalid_operation_manifest', false, 'search');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolError('invalid_operation_manifest', false, 'search');
  }
  return value as Record<string, unknown>;
}

function authorizedPriorRunIds(manifest: Record<string, unknown>, currentRunId: string): string[] {
  const value = manifest.authorizedPriorRunIds;
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (runId) =>
        typeof runId !== 'string' ||
        runId.length === 0 ||
        runId.length > 256 ||
        runId === currentRunId,
    ) ||
    new Set(value).size !== value.length
  ) {
    throw protocolError('invalid_prior_run_authority', false, 'search');
  }
  return value as string[];
}

function assertTerminalPriorRun(
  events: readonly RuntimeEvent[],
  sessionId: string,
  runId: string,
): void {
  const terminalStatuses = new Set(['completed', 'failed', 'aborted', 'cancelled']);
  if (
    events.length === 0 ||
    events.some(
      (event) => event.partial || event.sessionId !== sessionId || event.runId !== runId,
    ) ||
    !terminalStatuses.has(events.at(-1)?.status ?? '') ||
    events.slice(0, -1).some((event) => terminalStatuses.has(event.status ?? ''))
  ) {
    throw protocolError('invalid_prior_run_authority', false, 'search');
  }
}

function requireCalendarTimeZone(json: string): string {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw protocolError('invalid_operation_manifest', false, 'propose');
  }
  const timeZone =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).calendarTimeZone
      : undefined;
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 128) {
    throw protocolError('missing_calendar_time_zone', false, 'propose');
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(0);
  } catch {
    throw protocolError('invalid_calendar_time_zone', false, 'propose');
  }
  return timeZone;
}

function mergeNeighborhoods(
  ranges: readonly { first: number; last: number }[],
): Array<{ first: number; last: number }> {
  const result: Array<{ first: number; last: number }> = [];
  for (const range of ranges) {
    const previous = result.at(-1);
    if (previous && range.first <= previous.last + 1)
      previous.last = Math.max(previous.last, range.last);
    else result.push({ ...range });
  }
  return result;
}

function spanCharCount(evidence: AuthorizedEvidence, first: number, last: number): number {
  return evidence.turns
    .slice(first, last + 1)
    .flatMap((turn) => turn.sources)
    .reduce((sum, source) => sum + source.view.content.length, 0);
}

function evidenceDigest(evidence: AuthorizedEvidence): string {
  return digest(
    evidence.turns.map((turn) => ({
      key: turn.key,
      events: turn.sources.map((source) => source.digest),
    })),
  );
}

function normalizeEvidenceText(input: string): string {
  return input
    .replace(/\r\n?/gu, '\n')
    .normalize('NFC')
    .replace(/[\u200b-\u200d\ufeff]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ' ');
}

function searchText(value: string): string {
  return normalizeEvidenceText(value).trim().toLocaleLowerCase('und');
}

function containsSecret(value: string): boolean {
  return (
    redactSecrets(value) !== value ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu.test(value)
  );
}

function uniqueSources<
  T extends { sessionId: string; runId: string; turnId: string; eventId: string },
>(sources: readonly T[]): T[] {
  return [
    ...new Map(
      sources.map((source) => [
        `${source.sessionId}:${source.runId}:${source.turnId}:${source.eventId}`,
        source,
      ]),
    ).values(),
  ];
}

function uniqueKeys<T extends { key: string; keyType: string; keyOrigin: string }>(
  keys: readonly T[],
): T[] {
  return [...new Map(keys.map((key) => [`${searchText(key.key)}:${key.keyType}`, key])).values()];
}

function digest(value: unknown): MemorySha256Digest {
  return `sha256:${createHash('sha256').update(stableJsonStringify(value)).digest('hex')}`;
}

function throwIfAborted(
  signal: AbortSignal,
  phase: 'search' | 'read' | 'propose' | 'resolve',
): void {
  if (signal.aborted) throw protocolError('attempt_cancelled', false, phase);
}

function protocolError(
  code: string,
  retryableInRun: boolean,
  expectedPhase: 'search' | 'read' | 'propose' | 'resolve',
): MemoryExtractionProtocolError {
  return new MemoryExtractionProtocolError({ code, retryableInRun, expectedPhase });
}
