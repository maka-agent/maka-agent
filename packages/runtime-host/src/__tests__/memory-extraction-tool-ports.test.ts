import assert from 'node:assert/strict';
import test from 'node:test';
import { buildImmutableRuntimePrefix, type RuntimeEvent } from '@maka/core';
import type {
  CommitMemoryExtractionRequest,
  MemoryExtractionAttempt,
  MemoryExtractionCandidate,
  MemoryExtractionOperation,
  MemoryItemRecord,
  SearchMemoryExtractionCandidatesRequest,
} from '@maka/core/long-term-memory';
import { runtimePrefixSegment } from '@maka/core/runtime-boundary';
import type { MemoryExtractionInvocation, MemoryExtractionResponse } from '@maka/runtime';
import { HostMemoryExtractionAttemptPorts } from '../server/memory-extraction-tool-ports.js';

const NOW = Date.UTC(2026, 7, 3, 12, 0);

test('search is confined to the frozen parent boundary and returns complete-turn neighborhoods', async () => {
  const events = [
    textEvent('event-1', 'turn-1', 'user', 'user', 'Earlier interface constraint', 1),
    textEvent('event-2', 'turn-1', 'model', 'agent', 'Acknowledged.', 2),
    textEvent('event-3', 'turn-2', 'user', 'user', 'Middle turn', 3),
    toolEvent('event-4', 'turn-2', 'function_call', 4),
    toolEvent('event-5', 'turn-2', 'function_response', 5),
    textEvent('event-6', 'turn-3', 'user', 'user', 'Remember that interface constraint', 6),
    textEvent('event-7', 'turn-4', 'user', 'user', 'not yet authorized', 7),
    textEvent('event-8', 'turn-3', 'model', 'agent', 'same-run tail not frozen', 8),
  ];
  const fixture = targetedFixture(events, 6);
  const result = await fixture.ports.evidenceSearch.search(
    invocation(),
    { queries: ['interface constraint'] },
    new AbortController().signal,
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.spans.length, 1);
  assert.deepEqual(
    [...new Set(result.spans[0]!.sources.map((source) => source.content))],
    [
      'Earlier interface constraint',
      'Acknowledged.',
      'Middle turn',
      'tool_call name=test_tool args={"path":"src/main.ts"}',
      'tool_result name=test_tool isError=false result={"count":2,"ok":true}',
      'Remember that interface constraint',
    ],
  );
  assert.doesNotMatch(JSON.stringify(result), /not yet authorized|same-run tail not frozen/u);
  assert.deepEqual(fixture.prefixReads, [
    { sessionId: 'parent-session', runId: 'parent-run', upToEventSeq: 1 },
  ]);
});

test('read expands only an issued span and fails closed for forged refs', async () => {
  const events = Array.from({ length: 5 }, (_, index) =>
    textEvent(
      `event-${index + 1}`,
      `turn-${index + 1}`,
      'user',
      'user',
      `turn ${index + 1}`,
      index + 1,
    ),
  );
  const fixture = targetedFixture(events, 5);
  const found = await fixture.ports.evidenceSearch.search(
    invocation(),
    { queries: ['turn 3'] },
    new AbortController().signal,
  );
  const spanRef = found.spans[0]!.spanRef;
  const expanded = await fixture.ports.evidenceRead.read(
    invocation(),
    { spanRef, direction: 'both' },
    new AbortController().signal,
  );
  assert.deepEqual(
    expanded.span.sources.map((source) => source.content),
    ['turn 1', 'turn 2', 'turn 3', 'turn 4', 'turn 5'],
  );
  await assert.rejects(
    fixture.ports.evidenceRead.read(
      invocation(),
      { spanRef: 'span_forged', direction: 'both' },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof Error && error.message === 'invalid_span_ref',
  );
});

test('search enforces cumulative evidence and call budgets across one Attempt', async () => {
  const fixture = targetedFixture(
    [textEvent('event-1', 'turn-1', 'user', 'user', `alpha ${'x'.repeat(20_000)} beta`, 1)],
    1,
  );
  const first = await fixture.ports.evidenceSearch.search(
    invocation(),
    { queries: ['alpha'] },
    new AbortController().signal,
  );
  assert.equal(first.spans.length, 1);
  const second = await fixture.ports.evidenceSearch.search(
    invocation(),
    { queries: ['beta'] },
    new AbortController().signal,
  );
  assert.equal(second.spans.length, 0);
  assert.equal(second.truncated, true);
  await fixture.ports.evidenceSearch.search(
    invocation(),
    { queries: ['missing'] },
    new AbortController().signal,
  );
  await assert.rejects(
    fixture.ports.evidenceSearch.search(
      invocation(),
      { queries: ['fourth'] },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof Error && error.message === 'evidence_search_limit',
  );
});

test('initial coverage is not rejected by the smaller optional-search budget', async () => {
  const content = `durable workflow ${'x'.repeat(40_000)}`;
  const fixture = targetedFixture([textEvent('event-1', 'turn-1', 'user', 'user', content, 1)], 1);
  const initial = await fixture.ports.prepareInitialEvidence();
  assert.equal(initial.sources.length, 1);
  assert.equal(initial.sources[0]!.content, content);
});

test('authorized evidence follows canonical Run and event sequence, not timestamps', async () => {
  const fixture = targetedFixture(
    [
      textEvent('event-1', 'turn-1', 'user', 'user', 'shared first', 1, 300),
      textEvent('event-2', 'turn-2', 'user', 'user', 'shared second', 2, 200),
      textEvent('event-3', 'turn-3', 'user', 'user', 'shared current', 3, 100),
    ],
    3,
  );
  const found = await fixture.ports.evidenceSearch.search(
    invocation(),
    { queries: ['shared'] },
    new AbortController().signal,
  );
  assert.deepEqual(
    found.spans.flatMap((span) => span.sources).map((source) => source.content),
    ['shared first', 'shared second', 'shared current'],
  );
});

test('evidence projection keeps orphan calls but excludes private and control events', async () => {
  const events: RuntimeEvent[] = [
    textEvent('event-1', 'turn-1', 'user', 'user', 'Remember the public constraint.', 1),
    {
      id: 'event-2',
      invocationId: 'parent-invocation',
      runId: 'parent-run',
      sessionId: 'parent-session',
      turnId: 'turn-1',
      ts: 2,
      partial: false,
      role: 'model',
      author: 'agent',
      content: { kind: 'thinking', text: 'private chain of thought' },
    },
    toolEvent('event-3', 'turn-1', 'function_call', 3, 'memory_remember', 'memory-call'),
    toolEvent('event-4', 'turn-1', 'function_response', 4, 'memory_remember', 'memory-call'),
    toolEvent('event-5', 'turn-1', 'function_response', 5, 'orphan_tool', 'orphan-call'),
    toolEvent('event-6', 'turn-1', 'function_call', 6),
  ];
  const fixture = targetedFixture(events, 6);
  const initial = await fixture.ports.prepareInitialEvidence();
  const initialContent = initial.sources.map((source) => source.content).join('\n');
  assert.match(initialContent, /tool_call name=test_tool outcome=unknown/u);
  assert.doesNotMatch(initialContent, /private chain of thought|memory_remember|orphan_tool/u);

  const result = await fixture.ports.evidenceSearch.search(
    invocation(),
    { queries: ['public constraint'] },
    new AbortController().signal,
  );

  const resultContent = result.spans
    .flatMap((span) => span.sources)
    .map((source) => source.content)
    .join('\n');
  assert.match(resultContent, /Remember the public constraint\./u);
  assert.doesNotMatch(resultContent, /private chain of thought|memory_remember|orphan_tool/u);
});

test('tool call ids are paired within a Run and may repeat across authorized prior Runs', async () => {
  const fixture = targetedFixture(
    [
      toolEvent('event-1', 'turn-1', 'function_call', 1),
      toolEvent('event-2', 'turn-1', 'function_response', 2),
      toolEvent('event-3', 'turn-2', 'function_call', 3),
      toolEvent('event-4', 'turn-2', 'function_response', 4),
      textEvent('event-5', 'turn-3', 'user', 'user', 'Remember both checks.', 5),
    ],
    5,
  );
  const found = await fixture.ports.evidenceSearch.search(
    invocation(),
    { queries: ['src/main.ts'] },
    new AbortController().signal,
  );
  assert.equal(
    found.spans.flatMap((span) => span.sources).filter((source) => source.kind === 'tool_call')
      .length,
    2,
  );
});

test('an explicitly authorized prior Run must still end at a terminal immutable event', async () => {
  const fixture = targetedFixture(
    [
      textEvent('event-1', 'turn-1', 'user', 'user', 'Earlier fact.', 1),
      textEvent('event-2', 'turn-2', 'user', 'user', 'Remember it.', 2),
    ],
    2,
    { leavePriorRunsNonTerminal: true },
  );
  await assert.rejects(
    fixture.ports.evidenceSearch.search(
      invocation(),
      { queries: ['Earlier'] },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof Error && error.message === 'invalid_prior_run_authority',
  );
});

test('propose validates quote, source, global gate, time and commits a normalized create', async () => {
  const events = [
    textEvent(
      'event-1',
      'turn-1',
      'user',
      'user',
      'Please keep answers concise next week.',
      1,
      Date.UTC(2026, 7, 3, 10, 30),
    ),
  ];
  const fixture = targetedFixture(events, 1);
  const initial = await fixture.ports.prepareInitialEvidence();
  const sourceRef = initial.sources[0]!.sourceRef;
  const result = await fixture.ports.submission.propose(
    invocation(),
    proposed(sourceRef),
    new AbortController().signal,
  );

  assert.equal(result.status, 'committed');
  assert.equal(fixture.commits.length, 1);
  const mutation = fixture.commits[0]!.mutations[0];
  assert.equal(mutation?.type, 'create');
  if (mutation?.type !== 'create') throw new Error('expected create');
  assert.equal(mutation.item.scopeType, 'global');
  assert.equal(mutation.item.scopeKey, null);
  assert.equal(mutation.item.origin, 'user_requested');
  assert.equal(mutation.item.observedAt, Date.UTC(2026, 7, 3, 10, 30));
  assert.equal(mutation.item.eventStartedAt, Date.UTC(2026, 7, 10, 10, 30));
  assert.deepEqual(mutation.item.sources, [
    { sessionId: 'parent-session', runId: 'parent-run', turnId: 'turn-1', eventId: 'event-1' },
  ]);
});

test('calendar time is resolved with the IANA timezone frozen in the Operation manifest', async () => {
  const fixture = targetedFixture(
    [textEvent('event-1', 'turn-1', 'user', 'user', 'The event is on August 10.', 1)],
    1,
    { timeZone: 'Asia/Shanghai' },
  );
  const sourceRef = (await fixture.ports.prepareInitialEvidence()).sources[0]!.sourceRef;
  await fixture.ports.submission.propose(
    invocation(),
    {
      outcome: 'proposed',
      selectionSaturated: false,
      proposals: [
        {
          content: 'The event is on August 10, 2026.',
          kind: 'context',
          statementType: 'fact',
          temporal: { type: 'point', at: { kind: 'absolute', value: '2026-08-10' } },
          scopeProposal: 'workspace',
          suggestedKeys: [{ key: 'event', keyType: 'concept' }],
          supports: [{ sourceRef, quote: 'The event is on August 10.' }],
        },
      ],
    },
    new AbortController().signal,
  );
  const mutation = fixture.commits[0]!.mutations[0];
  if (mutation?.type !== 'create') throw new Error('expected create');
  assert.equal(mutation.item.eventStartedAt, Date.UTC(2026, 7, 9, 16, 0));
  assert.equal(mutation.item.eventEndedAt, Date.UTC(2026, 7, 10, 16, 0));
});

test('proposal admission rejects quote mismatch and secret-like content before candidate lookup', async () => {
  const fixture = targetedFixture(
    [textEvent('event-1', 'turn-1', 'user', 'user', 'Please keep answers concise.', 1)],
    1,
  );
  const initial = await fixture.ports.prepareInitialEvidence();
  const sourceRef = initial.sources[0]!.sourceRef;
  await assert.rejects(
    fixture.ports.submission.propose(
      invocation(),
      {
        ...proposed(sourceRef),
        proposals: [
          {
            ...proposed(sourceRef).proposals[0]!,
            supports: [{ sourceRef, quote: 'a quote that is absent' }],
          },
        ],
      },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof Error && error.message === 'quote_mismatch',
  );
  for (const quote of ['   ', 'Please\nkeep answers concise']) {
    await assert.rejects(
      fixture.ports.submission.propose(
        invocation(),
        {
          ...proposed(sourceRef),
          proposals: [
            {
              ...proposed(sourceRef).proposals[0]!,
              supports: [{ sourceRef, quote }],
            },
          ],
        },
        new AbortController().signal,
      ),
      (error: unknown) => error instanceof Error && error.message === 'invalid_quote',
    );
  }
  await assert.rejects(
    fixture.ports.submission.propose(
      invocation(),
      {
        ...proposed(sourceRef),
        proposals: [
          {
            ...proposed(sourceRef).proposals[0]!,
            content: 'API key = sk-123456789012345678901234',
          },
        ],
      },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof Error && error.message === 'secret_detected',
  );
  assert.equal(fixture.candidateQueries.length, 0);
  assert.equal(fixture.commits.length, 0);
});

test('plans require direct user evidence even when an assistant source is authorized', async () => {
  const fixture = targetedFixture(
    [textEvent('event-1', 'turn-1', 'model', 'agent', 'We will migrate next week.', 1)],
    1,
  );
  const sourceRef = (await fixture.ports.prepareInitialEvidence()).sources[0]!.sourceRef;
  await assert.rejects(
    fixture.ports.submission.propose(
      invocation(),
      {
        outcome: 'proposed',
        selectionSaturated: false,
        proposals: [
          {
            content: 'The project will migrate next week.',
            kind: 'context',
            statementType: 'plan',
            temporal: { type: 'undated' },
            scopeProposal: 'workspace',
            suggestedKeys: [{ key: 'migration', keyType: 'concept' }],
            supports: [{ sourceRef, quote: 'We will migrate next week.' }],
          },
        ],
      },
      new AbortController().signal,
    ),
    (error: unknown) => error instanceof Error && error.message === 'insufficient_user_evidence',
  );
});

test('batch-equivalent proposals merge keys and sources before one candidate query and mutation', async () => {
  const fixture = targetedFixture(
    [textEvent('event-1', 'turn-1', 'user', 'user', 'Please keep answers concise.', 1)],
    1,
  );
  const sourceRef = (await fixture.ports.prepareInitialEvidence()).sources[0]!.sourceRef;
  const base = {
    ...proposed(sourceRef).proposals[0]!,
    temporal: { type: 'undated' as const },
  };
  const result = await fixture.ports.submission.propose(
    invocation(),
    {
      outcome: 'proposed',
      selectionSaturated: false,
      proposals: [
        base,
        {
          ...base,
          suggestedKeys: [{ key: 'short replies', keyType: 'alias' }],
        },
      ],
    },
    new AbortController().signal,
  );
  assert.equal(result.status, 'committed');
  assert.equal(fixture.candidateQueries.length, 1);
  assert.equal(fixture.commits[0]!.mutations.length, 1);
  const mutation = fixture.commits[0]!.mutations[0];
  if (mutation?.type !== 'create') throw new Error('expected create');
  assert.deepEqual(
    mutation.item.keys.map((key) => key.key),
    ['concise answers', 'short replies'],
  );
});

test('semantic candidates require two-stage resolution and never expose Item ids', async () => {
  const fixture = targetedFixture(
    [textEvent('event-1', 'turn-1', 'user', 'user', 'Please keep answers concise.', 1)],
    1,
    { candidates: [candidateRecord()] },
  );
  const initial = await fixture.ports.prepareInitialEvidence();
  const sourceRef = initial.sources[0]!.sourceRef;
  const proposal = {
    ...proposed(sourceRef),
    proposals: [
      {
        ...proposed(sourceRef).proposals[0]!,
        content: 'The user wants very concise answers.',
        temporal: { type: 'undated' },
      },
    ],
  } satisfies MemoryExtractionResponse;
  const first = await fixture.ports.submission.propose(
    invocation(),
    proposal,
    new AbortController().signal,
  );
  assert.equal(first.status, 'needs_resolution');
  if (first.status !== 'needs_resolution') throw new Error('expected candidates');
  assert.doesNotMatch(JSON.stringify(first), /existing-item-id/u);
  const entry = first.cases[0]!;
  const committed = await fixture.ports.submission.resolve(
    invocation(),
    {
      submissionRef: first.submissionRef,
      decisions: [
        {
          proposalRef: entry.proposalRef,
          relation: 'revises',
          candidateRef: entry.candidates[0]!.candidateRef,
        },
      ],
    },
    new AbortController().signal,
  );
  assert.equal(committed.status, 'committed');
  assert.equal(fixture.commits[0]!.mutations[0]?.type, 'update');
});

test('final commit is linearized with parent Session retirement and revalidates evidence', async () => {
  const fixture = targetedFixture(
    [textEvent('event-1', 'turn-1', 'user', 'user', 'Please keep answers concise.', 1)],
    1,
  );
  const sourceRef = (await fixture.ports.prepareInitialEvidence()).sources[0]!.sourceRef;
  fixture.deleteParent();
  await assert.rejects(
    fixture.ports.submission.propose(
      invocation(),
      proposed(sourceRef),
      new AbortController().signal,
    ),
    /parent_session_unavailable/u,
  );
  assert.deepEqual(fixture.admissions, ['parent-session']);
  assert.equal(fixture.commits.length, 0);
});

function targetedFixture(
  events: readonly RuntimeEvent[],
  highWater: number,
  options: {
    candidates?: readonly MemoryExtractionCandidate[];
    timeZone?: string;
    leavePriorRunsNonTerminal?: boolean;
  } = {},
) {
  const boundaryEvent = events[Math.max(0, highWater - 1)]!;
  const sessionEvents = events.map((event) => ({
    ...event,
    runId: event.turnId === boundaryEvent.turnId ? 'parent-run' : `run-${event.turnId}`,
    invocationId:
      event.turnId === boundaryEvent.turnId ? 'parent-invocation' : `invocation-${event.turnId}`,
  }));
  const prefixEvents = sessionEvents
    .slice(0, highWater)
    .filter((event) => event.runId === 'parent-run');
  const authorizedPriorRunIds = [
    ...new Set(
      sessionEvents
        .slice(0, highWater)
        .map((event) => event.runId)
        .filter((runId) => runId !== 'parent-run'),
    ),
  ];
  for (const priorRunId of authorizedPriorRunIds) {
    let lastIndex = -1;
    for (let index = 0; index < highWater; index += 1) {
      if (sessionEvents[index]?.runId === priorRunId) lastIndex = index;
    }
    assert.notEqual(lastIndex, -1);
    if (!options.leavePriorRunsNonTerminal) {
      sessionEvents[lastIndex] = { ...sessionEvents[lastIndex]!, status: 'completed' };
    }
  }
  const prefix = buildImmutableRuntimePrefix(
    {
      sessionId: 'parent-session',
      invocationId: 'parent-invocation',
      runId: 'parent-run',
      turnId: boundaryEvent.turnId,
    },
    prefixEvents.map((event, index) => ({ eventSeq: index + 1, event })),
  );
  const operation = {
    operationId: 'operation-1',
    sessionId: 'parent-session',
    mode: 'targeted',
    triggerKind: 'user_requested',
    internalSessionId: 'internal-session',
    state: 'running',
    activeAttemptId: 'attempt-1',
    requestJson: JSON.stringify({
      searchBoundary: runtimePrefixSegment(prefix),
      authorizedPriorRunIds,
      calendarTimeZone: options.timeZone ?? 'UTC',
    }),
    ranges: [],
  } as unknown as MemoryExtractionOperation;
  const attempt = {
    attemptId: 'attempt-1',
    operationId: 'operation-1',
    state: 'running',
    runId: 'memory-run',
  } as MemoryExtractionAttempt;
  const commits: CommitMemoryExtractionRequest[] = [];
  const candidateQueries: SearchMemoryExtractionCandidatesRequest[] = [];
  const prefixReads: Array<{ sessionId: string; runId: string; upToEventSeq?: number }> = [];
  const admissions: string[] = [];
  let parentAvailable = true;
  const ports = new HostMemoryExtractionAttemptPorts({
    operationId: 'operation-1',
    attemptId: 'attempt-1',
    internalSessionId: 'internal-session',
    runId: 'memory-run',
    workspaceKey: 'workspace-key',
    now: () => NOW,
    runtimeEvents: {
      readImmutableRuntimeEvents: async (sessionId, runId) => {
        assert.equal(sessionId, 'parent-session');
        return sessionEvents.filter((event) => event.runId === runId);
      },
      readImmutableRuntimePrefix: async (input) => {
        prefixReads.push(input);
        assert.equal(input.sessionId, 'parent-session');
        assert.equal(input.runId, 'parent-run');
        assert.equal(input.upToEventSeq, prefixEvents.length);
        return prefix;
      },
    },
    commitWithParentAdmission: async (parentSessionId, commit) => {
      admissions.push(parentSessionId);
      if (!parentAvailable) throw new Error('parent_session_unavailable');
      return commit();
    },
    operations: {
      readMemoryExtractionOperation: async () => operation,
      readMemoryExtractionAttempt: async () => attempt,
      searchMemoryExtractionCandidates: async (input) => {
        candidateQueries.push(input);
        return { candidates: options.candidates ?? [], truncated: false };
      },
      commitMemoryExtraction: async (input) => {
        commits.push(input);
        return {
          replayed: false,
          receipt: {
            mutationResults: input.mutations.map((mutation, index) => ({
              mutationIndex: index,
              mutationType: mutation.type,
              itemId: `item-${index}`,
              version: 1,
              lifecycleState: 'active',
              outcome: mutation.type === 'create' ? 'created' : 'updated',
            })),
          },
        } as never;
      },
    },
  });
  return {
    ports,
    commits,
    candidateQueries,
    prefixReads,
    admissions,
    deleteParent: () => {
      parentAvailable = false;
    },
  };
}

function invocation(): MemoryExtractionInvocation {
  return {
    operationId: 'operation-1',
    attemptId: 'attempt-1',
    sessionId: 'internal-session',
    runId: 'memory-run',
    turnId: 'memory-turn',
    toolCallId: 'memory-tool-call',
  };
}

function proposed(sourceRef: string): MemoryExtractionResponse {
  return {
    outcome: 'proposed',
    selectionSaturated: false,
    proposals: [
      {
        content: 'The user prefers concise answers.',
        kind: 'preference',
        statementType: 'fact',
        temporal: {
          type: 'point',
          at: { kind: 'calendar_offset', unit: 'week', value: 1, anchorSourceRef: sourceRef },
        },
        scopeProposal: 'global',
        suggestedKeys: [{ key: 'concise answers', keyType: 'concept' }],
        supports: [{ sourceRef, quote: 'Please keep answers concise' }],
      },
    ],
  };
}

function candidateRecord(): MemoryExtractionCandidate {
  const record: MemoryItemRecord = {
    item: {
      itemId: 'existing-item-id',
      version: 3,
      content: 'The user prefers concise answers.',
      kind: 'preference',
      statementType: 'fact',
      temporalType: 'undated',
      scopeType: 'global',
      scopeKey: null,
      eventStartedAt: null,
      eventEndedAt: null,
      observedAt: 1,
      lifecycleState: 'active',
      origin: 'user_requested',
      contentHash: 'hash',
      createdAt: 1,
      updatedAt: 1,
    },
    keys: [
      {
        key: 'concise answers',
        normalizedKey: 'concise answers',
        keyType: 'concept',
        keyOrigin: 'user',
      },
    ],
    sources: [],
  };
  return {
    record,
    contentHashMatch: false,
    sourceOverlapCount: 0,
    exactKeyMatchCount: 1,
    kindMatch: true,
    statementTypeMatch: true,
    temporalMatch: false,
  };
}

function textEvent(
  id: string,
  turnId: string,
  role: 'user' | 'model',
  author: 'user' | 'agent',
  text: string,
  ordinal: number,
  ts = ordinal,
): RuntimeEvent {
  return {
    id,
    invocationId: 'parent-invocation',
    runId: 'parent-run',
    sessionId: 'parent-session',
    turnId,
    ts,
    partial: false,
    role,
    author,
    content: { kind: 'text', text },
  };
}

function toolEvent(
  id: string,
  turnId: string,
  kind: 'function_call' | 'function_response',
  ordinal: number,
  name = 'test_tool',
  toolCallId = 'tool-call',
): RuntimeEvent {
  return {
    id,
    invocationId: 'parent-invocation',
    runId: 'parent-run',
    sessionId: 'parent-session',
    turnId,
    ts: ordinal,
    partial: false,
    role: kind === 'function_call' ? 'model' : 'tool',
    author: kind === 'function_call' ? 'agent' : 'tool',
    content:
      kind === 'function_call'
        ? { kind, id: toolCallId, name, args: { path: 'src/main.ts' } }
        : { kind, id: toolCallId, name, result: { ok: true, count: 2 } },
  };
}
