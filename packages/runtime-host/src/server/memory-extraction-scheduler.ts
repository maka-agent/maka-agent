import { createHash } from 'node:crypto';
import { runtimePrefixSegment, type ImmutableRuntimePrefixV1 } from '@maka/core/runtime-boundary';
import { stableJsonStringify } from '@maka/core/tool-args-identity';
import {
  MEMORY_EXTRACTION_MAX_RANGES,
  MemoryItemStoreConflictError,
  type MemoryExtractionCursor,
  type MemoryExtractionOperationRangeInput,
  type MemoryItemStore,
  type MemorySha256Digest,
} from '@maka/core/long-term-memory';
import {
  selectMidTurnSafeBoundary,
  MEMORY_EXTRACT_TOOL_NAME,
  MEMORY_REMEMBER_TOOL_NAME,
  type AutomaticMemoryExtractionScheduleRequest,
  type MemoryExtractionScheduleRequest,
  type MemoryExtractionScheduleResult,
  type MemoryExtractionScheduler,
} from '@maka/runtime';
import type { RuntimePolicyReader } from '@maka/storage/runtime-policy-stores';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { RuntimePolicyActivationGate } from './runtime-policy-activation-gate.js';
import type { SessionAdmissionGate } from './session-admission-gate.js';

const REQUEST_PROTOCOL = 'memory_extraction_request_v1';
const INTERNAL_SESSION_PROTOCOL = 'memory_extraction_internal_session_v1';
const MAX_TARGETED_PRIOR_RUNS = 256;
const MAX_UNFINISHED_TARGETED_PER_SESSION = 16;

type MemoryExtractionOperationStore = Pick<
  MemoryItemStore,
  | 'createMemoryExtractionOperation'
  | 'createMemoryExtractionSweepFollowup'
  | 'listUnassignedMemoryExtractionSweepDebts'
  | 'readMemoryExtractionCursor'
  | 'raiseMemoryExtractionRequestedBoundary'
>;

interface RuntimeEventBoundaryAuthority {
  readonly readImmutableRuntimePrefix?: (input: {
    sessionId: string;
    runId: string;
    upToEventSeq?: number;
  }) => Promise<ImmutableRuntimePrefixV1>;
}

interface AgentRunBoundaryAuthority {
  readonly listSessionRuns: (sessionId: string) => Promise<readonly AgentRunHeader[]>;
}

export interface HostMemoryExtractionSchedulerInput {
  readonly policy: Readonly<RuntimePolicyReader>;
  readonly operations: MemoryExtractionOperationStore;
  readonly runtimeEvents: RuntimeEventBoundaryAuthority;
  readonly agentRuns: AgentRunBoundaryAuthority;
  readonly activation: RuntimePolicyActivationGate;
  readonly admission: Pick<SessionAdmissionGate, 'run'>;
  readonly sessions: {
    readHeaderSnapshot(sessionId: string): Promise<unknown>;
  };
  readonly resolveTimeZone?: () => string;
  /** Best-effort wake-up after durable scheduling; it never changes the Tool result. */
  readonly onOperationReady?: (operationId: string) => void;
}

/**
 * Runtime Host adapter for the two public Memory scheduling tools.
 *
 * It reads policy at call time, freezes the canonical RuntimeEvent prefix at
 * this tool call's durable dispatch fact, and only then writes an extraction
 * Operation. It never starts or waits for a Memory child AgentRun.
 */
export class HostMemoryExtractionScheduler implements MemoryExtractionScheduler {
  readonly #input: HostMemoryExtractionSchedulerInput;

  constructor(input: HostMemoryExtractionSchedulerInput) {
    this.#input = input;
  }

  async schedule(
    request: MemoryExtractionScheduleRequest,
  ): Promise<MemoryExtractionScheduleResult> {
    try {
      return await this.#input.activation.runReadActivation(async () => {
        const policy = (await this.#input.policy.getSnapshot()).policy;
        if (policy.privacy.incognitoActive) {
          return { status: 'rejected', reason: 'incognito_active' };
        }
        if (!policy.memory.enabled) {
          return { status: 'rejected', reason: 'memory_disabled' };
        }

        return await this.#withParentAdmission(request.sessionId, async () => {
          const prefix = await this.#freezeAtSchedulingDispatch(request);
          return request.mode === 'sweep'
            ? await this.#scheduleSweep(request, prefix)
            : await this.#scheduleTargeted(request, prefix);
        });
      });
    } catch (error) {
      if (
        error instanceof MemoryItemStoreConflictError &&
        error.reason === 'extraction_queue_full'
      ) {
        return { status: 'rejected', reason: 'queue_full' };
      }
      return { status: 'rejected', reason: 'runtime_unavailable' };
    }
  }

  /** Trusted automatic entry used by request occupancy and History Compaction. */
  async scheduleAutomatic(
    request: AutomaticMemoryExtractionScheduleRequest,
  ): Promise<MemoryExtractionScheduleResult> {
    try {
      return await this.#input.activation.runReadActivation(async () => {
        const policy = (await this.#input.policy.getSnapshot()).policy;
        if (policy.privacy.incognitoActive) {
          return { status: 'rejected', reason: 'incognito_active' };
        }
        if (!policy.memory.enabled) {
          return { status: 'rejected', reason: 'memory_disabled' };
        }
        return await this.#withParentAdmission(request.sessionId, () =>
          this.#scheduleAutomaticSweep(request),
        );
      });
    } catch {
      return { status: 'rejected', reason: 'runtime_unavailable' };
    }
  }

  /** Rebuild durable follow-up Operations for Cursor debt left by a coalesced Sweep. */
  async reconcileSweepDebts(limit = 20): Promise<number> {
    return await this.#input.activation.runReadActivation(async () => {
      const policy = (await this.#input.policy.getSnapshot()).policy;
      if (policy.privacy.incognitoActive || !policy.memory.enabled) return 0;
      const debts = await this.#input.operations.listUnassignedMemoryExtractionSweepDebts({
        limit,
      });
      let createdCount = 0;
      for (const debt of debts) {
        const created = await this.#withParentAdmission(debt.sessionId, async () => {
          const range = {
            rangeOrdinal: 0,
            sessionId: debt.sessionId,
            invocationId: debt.invocationId,
            runId: debt.runId,
            turnId: debt.turnId,
            fromEventSeqExclusive: debt.committedEventSeq,
            fromEventId: debt.committedEventId,
            fromPrefixDigest: debt.committedPrefixDigest,
            toEventSeqInclusive: debt.requestedEventSeq,
            toEventId: requireDebtBoundary(debt.requestedEventId, 'event id'),
            toPrefixDigest: requireDebtBoundary(debt.requestedPrefixDigest, 'prefix digest'),
          } as const;
          const semanticIdentity = {
            protocol: REQUEST_PROTOCOL,
            mode: 'sweep',
            kind: 'cursor_debt_followup',
            cursorVersion: debt.version,
            calendarTimeZone: this.#timeZone(),
            ranges: [range],
            policyVersion: 1,
            tailVersion: 1,
            outputSchemaVersion: 1,
          } as const;
          const requestHash = digest(semanticIdentity);
          const operationSeed = digest({
            protocol: REQUEST_PROTOCOL,
            kind: 'cursor_debt_followup',
            requestHash,
          });
          const suffix = operationSeed.slice('sha256:'.length);
          const operationId = `memory-extraction-${suffix}`;
          const internalSessionId = `memory-extraction-session-${suffix}`;
          const requestJson = stableJsonStringify({
            ...semanticIdentity,
            source: { kind: 'cursor_debt' },
          });
          return await this.#input.operations.createMemoryExtractionSweepFollowup({
            expectedCursorVersion: debt.version,
            operation: {
              operationId,
              sessionId: debt.sessionId,
              mode: 'sweep',
              triggerKind: 'context_threshold',
              internalSessionId,
              sessionCreateFingerprint: digest({
                protocol: INTERNAL_SESSION_PROTOCOL,
                internalSessionId,
                operationId,
                parentSessionId: debt.sessionId,
              }),
              requestHash,
              requestJson,
              triggerEpoch: `cursor-debt-${debt.version}`,
              ranges: [range],
            },
          });
        });
        if (!created) continue;
        createdCount += created.replayed ? 0 : 1;
        this.#notify(created.operation.operationId);
      }
      return createdCount;
    });
  }

  async #withParentAdmission<T>(sessionId: string, execute: () => Promise<T>): Promise<T> {
    return await this.#input.admission.run(sessionId, async () => {
      await this.#input.sessions.readHeaderSnapshot(sessionId);
      return await execute();
    });
  }

  async #scheduleAutomaticSweep(
    request: AutomaticMemoryExtractionScheduleRequest,
  ): Promise<MemoryExtractionScheduleResult> {
    // A concurrent scheduler can attach one of the same Cursors between our
    // reads and the multi-Range transaction. Rebuild once from the authority;
    // any second failure is classified by the public fail-open boundary.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const collected = await this.#collectAutomaticRanges(request);
      for (const operationId of collected.coalescedOperationIds) this.#notify(operationId);
      if (collected.ranges.length === 0) {
        return collected.coalescedOperationIds.size > 0
          ? { status: 'coalesced' }
          : { status: 'already_covered' };
      }
      try {
        return await this.#persistAutomatic(request, collected.ranges);
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    return { status: 'rejected', reason: 'runtime_unavailable' };
  }

  async #collectAutomaticRanges(request: AutomaticMemoryExtractionScheduleRequest): Promise<{
    readonly ranges: readonly MemoryExtractionOperationRangeInput[];
    readonly coalescedOperationIds: ReadonlySet<string>;
  }> {
    const headers = (await this.#input.agentRuns.listSessionRuns(request.sessionId))
      .filter(
        (run) =>
          run.runId === request.runId ||
          run.status === 'completed' ||
          run.status === 'failed' ||
          run.status === 'cancelled',
      )
      .sort(
        (left, right) => left.createdAt - right.createdAt || left.runId.localeCompare(right.runId),
      );
    const uniqueRunIds = [...new Set(headers.map((run) => run.runId))];
    if (!uniqueRunIds.includes(request.runId)) uniqueRunIds.push(request.runId);

    const candidates: MemoryExtractionOperationRangeInput[] = [];
    const coalescedOperationIds = new Set<string>();
    for (const runId of uniqueRunIds) {
      const prefix = await this.#readSafePrefix(request.sessionId, runId);
      if (!prefix) continue;
      const cursor = await this.#input.operations.readMemoryExtractionCursor(
        request.sessionId,
        runId,
      );
      await this.#assertCursorStart(prefix, cursor);
      if (cursor && cursor.committedEventSeq >= prefix.position.lastEventSeq) continue;
      if (cursor?.activeSweepOperationId) {
        await this.#assertCursorBoundary(
          prefix,
          cursor.requestedEventSeq,
          cursor.requestedEventId,
          cursor.requestedPrefixDigest,
          'requested',
        );
        if (cursor.requestedEventSeq < prefix.position.lastEventSeq) {
          await this.#input.operations.raiseMemoryExtractionRequestedBoundary({
            sessionId: request.sessionId,
            runId,
            activeSweepOperationId: cursor.activeSweepOperationId,
            requestedEventSeq: prefix.position.lastEventSeq,
            requestedEventId: prefix.position.lastEventId,
            requestedPrefixDigest: prefix.prefixDigest,
          });
        }
        coalescedOperationIds.add(cursor.activeSweepOperationId);
        continue;
      }
      candidates.push({
        rangeOrdinal: 0,
        sessionId: request.sessionId,
        invocationId: prefix.identity.invocationId,
        runId,
        turnId: prefix.identity.turnId,
        fromEventSeqExclusive: cursor?.committedEventSeq ?? 0,
        fromEventId: cursor?.committedEventId ?? null,
        fromPrefixDigest: cursor?.committedPrefixDigest ?? null,
        toEventSeqInclusive: prefix.position.lastEventSeq,
        toEventId: prefix.position.lastEventId,
        toPrefixDigest: prefix.prefixDigest,
      });
    }

    // Preserve oldest debt while ensuring the currently triggering Run is not
    // starved by a very long Session. A later automatic edge picks up any
    // remaining unassigned Runs.
    let selected = candidates;
    if (candidates.length > MEMORY_EXTRACTION_MAX_RANGES) {
      const current = candidates.find((range) => range.runId === request.runId);
      const older = candidates
        .filter((range) => range.runId !== request.runId)
        .slice(0, MEMORY_EXTRACTION_MAX_RANGES - (current ? 1 : 0));
      selected = current ? [...older, current] : candidates.slice(0, MEMORY_EXTRACTION_MAX_RANGES);
    }
    return {
      ranges: selected.map((range, rangeOrdinal) => ({ ...range, rangeOrdinal })),
      coalescedOperationIds,
    };
  }

  async #readSafePrefix(
    sessionId: string,
    runId: string,
  ): Promise<ImmutableRuntimePrefixV1 | undefined> {
    const readPrefix = this.#input.runtimeEvents.readImmutableRuntimePrefix;
    if (!readPrefix) throw new Error('Immutable RuntimeEvent prefix authority is unavailable');
    const full = await readPrefix.call(this.#input.runtimeEvents, { sessionId, runId });
    if (full.identity.sessionId !== sessionId || full.identity.runId !== runId) {
      throw new Error('Automatic Memory boundary identity changed');
    }
    const safe = selectMidTurnSafeBoundary(full.events);
    if (!safe.ok) return undefined;
    if (safe.coveredCount === full.position.lastEventSeq) return full;
    return await readPrefix.call(this.#input.runtimeEvents, {
      sessionId,
      runId,
      upToEventSeq: safe.coveredCount,
    });
  }

  async #persistAutomatic(
    request: AutomaticMemoryExtractionScheduleRequest,
    ranges: readonly MemoryExtractionOperationRangeInput[],
  ): Promise<MemoryExtractionScheduleResult> {
    const calendarTimeZone = this.#timeZone();
    const semanticIdentity = {
      protocol: REQUEST_PROTOCOL,
      mode: 'sweep',
      triggerKind: request.triggerKind,
      triggerEpoch: request.triggerEpoch,
      ranges,
      policyVersion: 1,
      tailVersion: 1,
      outputSchemaVersion: 1,
      calendarTimeZone,
    } as const;
    const requestHash = digest(semanticIdentity);
    const suffix = requestHash.slice('sha256:'.length);
    const operationId = `memory-extraction-${suffix}`;
    const internalSessionId = `memory-extraction-session-${suffix}`;
    const created = await this.#input.operations.createMemoryExtractionOperation({
      operationId,
      sessionId: request.sessionId,
      mode: 'sweep',
      triggerKind: request.triggerKind,
      internalSessionId,
      sessionCreateFingerprint: digest({
        protocol: INTERNAL_SESSION_PROTOCOL,
        internalSessionId,
        operationId,
        parentSessionId: request.sessionId,
      }),
      requestHash,
      requestJson: stableJsonStringify({
        ...semanticIdentity,
        source: {
          kind: 'automatic',
          runId: request.runId,
          turnId: request.turnId,
        },
        boundaries: ranges.map((range) => ({
          rangeOrdinal: range.rangeOrdinal,
          sessionId: range.sessionId,
          invocationId: range.invocationId,
          runId: range.runId,
          turnId: range.turnId,
          toEventSeqInclusive: range.toEventSeqInclusive,
          toEventId: range.toEventId,
          toPrefixDigest: range.toPrefixDigest,
        })),
      }),
      triggerEpoch: request.triggerEpoch,
      ranges,
    });
    this.#notify(created.operation.operationId);
    return { status: created.replayed ? 'coalesced' : 'accepted' };
  }

  async #scheduleSweep(
    request: MemoryExtractionScheduleRequest,
    prefix: ImmutableRuntimePrefixV1,
  ): Promise<MemoryExtractionScheduleResult> {
    const cursor = await this.#input.operations.readMemoryExtractionCursor(
      request.sessionId,
      request.runId,
    );
    await this.#assertCursorStart(prefix, cursor);

    const highWater = prefix.position.lastEventSeq;
    if (cursor && cursor.committedEventSeq >= highWater) {
      return { status: 'already_covered' };
    }

    if (cursor?.activeSweepOperationId) {
      return await this.#coalesceSweep(request, prefix, cursor, cursor.activeSweepOperationId);
    }

    const range = {
      rangeOrdinal: 0,
      sessionId: request.sessionId,
      invocationId: prefix.identity.invocationId,
      runId: request.runId,
      turnId: request.turnId,
      fromEventSeqExclusive: cursor?.committedEventSeq ?? 0,
      fromEventId: cursor?.committedEventId ?? null,
      fromPrefixDigest: cursor?.committedPrefixDigest ?? null,
      toEventSeqInclusive: highWater,
      toEventId: prefix.position.lastEventId,
      toPrefixDigest: prefix.prefixDigest,
    } as const;
    const calendarTimeZone = this.#timeZone();
    const manifest = {
      protocol: REQUEST_PROTOCOL,
      mode: request.mode,
      triggerKind: request.triggerKind,
      source: scheduleSource(request),
      boundary: runtimePrefixSegment(prefix),
      ranges: [range],
      policyVersion: 1,
      tailVersion: 1,
      outputSchemaVersion: 1,
      calendarTimeZone,
    } as const;
    const semanticIdentity = {
      protocol: REQUEST_PROTOCOL,
      mode: request.mode,
      triggerKind: request.triggerKind,
      ranges: [range],
      policyVersion: 1,
      tailVersion: 1,
      outputSchemaVersion: 1,
      calendarTimeZone,
    } as const;
    try {
      return await this.#persist(request, manifest, semanticIdentity, [range]);
    } catch (error) {
      // Another scheduler may have attached a Sweep after our Cursor read.
      // Re-read the durable authority and classify that winner instead of
      // surfacing a transient CAS race to the model.
      const refreshed = await this.#input.operations.readMemoryExtractionCursor(
        request.sessionId,
        request.runId,
      );
      await this.#assertCursorStart(prefix, refreshed);
      if (refreshed && refreshed.committedEventSeq >= highWater) {
        return { status: 'already_covered' };
      }
      if (refreshed?.activeSweepOperationId) {
        return await this.#coalesceSweep(
          request,
          prefix,
          refreshed,
          refreshed.activeSweepOperationId,
        );
      }
      throw error;
    }
  }

  async #coalesceSweep(
    request: MemoryExtractionScheduleRequest,
    prefix: ImmutableRuntimePrefixV1,
    cursor: MemoryExtractionCursor,
    activeSweepOperationId: string,
  ): Promise<MemoryExtractionScheduleResult> {
    await this.#assertCursorBoundary(
      prefix,
      cursor.requestedEventSeq,
      cursor.requestedEventId,
      cursor.requestedPrefixDigest,
      'requested',
    );
    if (cursor.requestedEventSeq < prefix.position.lastEventSeq) {
      await this.#input.operations.raiseMemoryExtractionRequestedBoundary({
        sessionId: request.sessionId,
        runId: request.runId,
        activeSweepOperationId,
        requestedEventSeq: prefix.position.lastEventSeq,
        requestedEventId: prefix.position.lastEventId,
        requestedPrefixDigest: prefix.prefixDigest,
      });
    }
    this.#notify(activeSweepOperationId);
    return { status: 'coalesced' };
  }

  async #scheduleTargeted(
    request: MemoryExtractionScheduleRequest,
    prefix: ImmutableRuntimePrefixV1,
  ): Promise<MemoryExtractionScheduleResult> {
    const userRequest = [...prefix.events]
      .reverse()
      .find(
        (event) =>
          event.turnId === request.turnId &&
          event.role === 'user' &&
          event.author === 'user' &&
          event.content?.kind === 'text',
      );
    if (!userRequest) throw new Error('Targeted Memory scheduling has no user request event');
    const authorizedPriorRunIds = (await this.#input.agentRuns.listSessionRuns(request.sessionId))
      .filter(
        (run) =>
          run.runId !== request.runId &&
          (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'),
      )
      .sort(
        (left, right) => left.createdAt - right.createdAt || left.runId.localeCompare(right.runId),
      )
      .map((run) => run.runId)
      .slice(-MAX_TARGETED_PRIOR_RUNS);
    const calendarTimeZone = this.#timeZone();

    const manifest = {
      protocol: REQUEST_PROTOCOL,
      mode: request.mode,
      triggerKind: request.triggerKind,
      source: scheduleSource(request),
      targetedReference: {
        userRequestEventId: userRequest.id,
        toolCallId: request.toolCallId,
      },
      searchBoundary: runtimePrefixSegment(prefix),
      authorizedPriorRunIds,
      policyVersion: 1,
      tailVersion: 1,
      outputSchemaVersion: 1,
      calendarTimeZone,
    } as const;
    // The user request event, not a possibly repeated model Tool Call, defines
    // the one-Targeted-Operation-per-user-Turn identity.
    const semanticIdentity = {
      protocol: REQUEST_PROTOCOL,
      mode: request.mode,
      triggerKind: request.triggerKind,
      sessionId: request.sessionId,
      runId: request.runId,
      turnId: request.turnId,
      userRequestEventId: userRequest.id,
      authorizedPriorRunIds,
      policyVersion: 1,
      tailVersion: 1,
      outputSchemaVersion: 1,
      calendarTimeZone,
    } as const;
    return await this.#persist(request, manifest, semanticIdentity, []);
  }

  async #persist(
    request: MemoryExtractionScheduleRequest,
    manifest: object,
    semanticIdentity: object,
    ranges: readonly MemoryExtractionOperationRangeInput[],
  ): Promise<MemoryExtractionScheduleResult> {
    const requestJson = stableJsonStringify(manifest);
    const requestHash = digest(semanticIdentity);
    const operationSeed = digest({
      protocol: REQUEST_PROTOCOL,
      requestHash,
      toolCallId: request.toolCallId,
    });
    const operationId = `memory-extraction-${operationSeed.slice('sha256:'.length)}`;
    const internalSessionId = `memory-extraction-session-${operationSeed.slice('sha256:'.length)}`;
    const sessionCreateFingerprint = digest({
      protocol: INTERNAL_SESSION_PROTOCOL,
      internalSessionId,
      operationId,
      parentSessionId: request.sessionId,
    });
    const created = await this.#input.operations.createMemoryExtractionOperation({
      operationId,
      sessionId: request.sessionId,
      mode: request.mode,
      triggerKind: request.triggerKind,
      internalSessionId,
      sessionCreateFingerprint,
      requestHash,
      requestJson,
      ...(ranges.length > 0 ? { ranges } : {}),
      ...(request.mode === 'targeted'
        ? { maxUnfinishedTargetedPerSession: MAX_UNFINISHED_TARGETED_PER_SESSION }
        : {}),
    });
    this.#notify(created.operation.operationId);
    return { status: created.replayed ? 'coalesced' : 'accepted' };
  }

  async #freezeAtSchedulingDispatch(
    request: MemoryExtractionScheduleRequest,
  ): Promise<ImmutableRuntimePrefixV1> {
    const readPrefix = this.#input.runtimeEvents.readImmutableRuntimePrefix;
    if (!readPrefix) throw new Error('Immutable RuntimeEvent prefix authority is unavailable');
    const current = await readPrefix.call(this.#input.runtimeEvents, {
      sessionId: request.sessionId,
      runId: request.runId,
    });
    assertPrefixIdentity(current, request);
    const expectedToolName =
      request.mode === 'sweep' ? MEMORY_EXTRACT_TOOL_NAME : MEMORY_REMEMBER_TOOL_NAME;
    const dispatchIndex = current.events.findIndex(
      (event) =>
        event.actions?.toolDispatch?.providerToolCallId === request.toolCallId &&
        event.actions.toolDispatch.toolName === expectedToolName,
    );
    if (dispatchIndex < 0) {
      throw new Error('Memory scheduling Tool dispatch is absent from the RuntimeEvent ledger');
    }
    // Never split one Tool Call/Result pair across two extraction ranges. The
    // scheduling call cannot yet have a result, so freeze immediately before
    // its dispatch fact; both facts remain available to the next Sweep.
    const dispatchHighWater = dispatchIndex;
    if (dispatchHighWater < 1) {
      throw new Error('Memory scheduling Tool dispatch has no preceding evidence boundary');
    }
    if (dispatchHighWater === current.position.lastEventSeq) return current;
    const frozen = await readPrefix.call(this.#input.runtimeEvents, {
      sessionId: request.sessionId,
      runId: request.runId,
      upToEventSeq: dispatchHighWater,
    });
    assertPrefixIdentity(frozen, request);
    return frozen;
  }

  async #assertCursorStart(
    prefix: ImmutableRuntimePrefixV1,
    cursor: MemoryExtractionCursor | undefined,
  ): Promise<void> {
    if (!cursor) return;
    if (
      cursor.sessionId !== prefix.identity.sessionId ||
      cursor.runId !== prefix.identity.runId ||
      cursor.invocationId !== prefix.identity.invocationId ||
      cursor.turnId !== prefix.identity.turnId
    ) {
      throw new Error('Memory Extraction Cursor identity does not match the RuntimeEvent prefix');
    }
    await this.#assertCursorBoundary(
      prefix,
      cursor.committedEventSeq,
      cursor.committedEventId,
      cursor.committedPrefixDigest,
      'committed',
    );
  }

  async #assertCursorBoundary(
    prefix: ImmutableRuntimePrefixV1,
    eventSeq: number,
    eventId: string | null,
    prefixDigest: MemorySha256Digest | null,
    label: 'committed' | 'requested',
  ): Promise<void> {
    if (eventSeq === 0) {
      if (eventId !== null || prefixDigest !== null) {
        throw new Error(`Memory Extraction Cursor has an inconsistent zero ${label} boundary`);
      }
      return;
    }
    const readPrefix = this.#input.runtimeEvents.readImmutableRuntimePrefix;
    if (!readPrefix) throw new Error('Immutable RuntimeEvent prefix authority is unavailable');
    const boundary = await readPrefix.call(this.#input.runtimeEvents, {
      sessionId: prefix.identity.sessionId,
      runId: prefix.identity.runId,
      upToEventSeq: eventSeq,
    });
    if (
      boundary.identity.invocationId !== prefix.identity.invocationId ||
      boundary.identity.turnId !== prefix.identity.turnId
    ) {
      throw new Error(`Memory Extraction Cursor ${label} identity changed`);
    }
    if (boundary.position.lastEventId !== eventId || boundary.prefixDigest !== prefixDigest) {
      throw new Error(`Memory Extraction Cursor ${label} boundary no longer matches RuntimeEvent`);
    }
  }

  #notify(operationId: string): void {
    try {
      this.#input.onOperationReady?.(operationId);
    } catch {
      // The Operation is already durable. A process-local wake failure must not
      // turn a successful scheduling acknowledgement into a false rejection.
    }
  }

  #timeZone(): string {
    const value =
      this.#input.resolveTimeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!value || value.length > 128) throw new Error('Memory Extraction time zone is invalid');
    return value;
  }
}

function requireDebtBoundary<T extends string>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Memory Extraction Sweep debt is missing ${label}`);
  return value;
}

function scheduleSource(request: MemoryExtractionScheduleRequest): object {
  return {
    sessionId: request.sessionId,
    runId: request.runId,
    turnId: request.turnId,
    toolCallId: request.toolCallId,
  };
}

function assertPrefixIdentity(
  prefix: ImmutableRuntimePrefixV1,
  request: MemoryExtractionScheduleRequest,
): void {
  if (
    prefix.identity.sessionId !== request.sessionId ||
    prefix.identity.runId !== request.runId ||
    prefix.identity.turnId !== request.turnId
  ) {
    throw new Error('RuntimeEvent prefix does not match the scheduling Tool authority');
  }
}

function digest(value: unknown): MemorySha256Digest {
  return `sha256:${createHash('sha256').update(stableJsonStringify(value)).digest('hex')}`;
}
