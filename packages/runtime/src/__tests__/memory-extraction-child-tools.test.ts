import assert from 'node:assert/strict';
import test from 'node:test';
import { toJSONSchema, type z } from 'zod';
import {
  buildMemoryExtractionChildTools,
  buildUnboundMemoryExtractionChildTools,
  MEMORY_EVIDENCE_READ_TOOL_NAME,
  MEMORY_EVIDENCE_SEARCH_TOOL_NAME,
  MEMORY_SUBMIT_TOOL_NAME,
  type MemoryExtractionChildToolPorts,
  type MemoryExtractionChildBinding,
  type MemoryExtractionResponse,
  type MemoryProposalSubmissionResult,
  type MemorySubmissionReceipt,
} from '../memory-extraction-child-tools.js';
import type { MakaToolContext } from '../tool-runtime.js';

test('main and Memory Agents share one strict provider schema while main dispatch fails closed', async () => {
  const bound = buildMemoryExtractionChildTools(binding(), ports());
  const unbound = buildUnboundMemoryExtractionChildTools();
  assert.deepEqual(
    bound.map((tool) => tool.name),
    [MEMORY_EVIDENCE_SEARCH_TOOL_NAME, MEMORY_EVIDENCE_READ_TOOL_NAME, MEMORY_SUBMIT_TOOL_NAME],
  );
  for (const tool of bound) {
    const schema = tool.parameters as z.ZodType;
    assert.equal(schema.safeParse({}).success, false, `${tool.name} must reject empty input`);
  }
  assert.deepEqual(
    bound.map((tool) => tool.recoveryMode),
    ['replay_safe', 'replay_safe', 'idempotent'],
  );
  assert.equal(bound[2]?.executionSemantics, 'exclusive_step');
  assert.ok(
    bound.every((tool) => tool.description.includes('otherwise never call it')),
    'provider-visible internal tools must not invite ordinary Agent runs to call them',
  );
  assert.deepEqual(
    unbound.map((tool) => ({
      name: tool.name,
      description: tool.description,
      recoveryMode: tool.recoveryMode,
      executionSemantics: tool.executionSemantics,
      schema: toJSONSchema(tool.parameters as z.ZodType),
    })),
    bound.map((tool) => ({
      name: tool.name,
      description: tool.description,
      recoveryMode: tool.recoveryMode,
      executionSemantics: tool.executionSemantics,
      schema: toJSONSchema(tool.parameters as z.ZodType),
    })),
  );
  assert.deepEqual(
    await unbound[0]!.impl({ queries: ['workflow'] }, context()),
    toolError('protocol_violation', false, 0, 'search'),
  );
});

test('Attempt binding rejects main-session and stale-run execution before ports', async () => {
  let authorityCalls = 0;
  const [search] = buildMemoryExtractionChildTools(
    binding(),
    ports({ authority: { assertActive: () => void (authorityCalls += 1) } }),
  );
  assert.deepEqual(
    await search!.impl({ queries: ['workflow'] }, context({ sessionId: 'parent-session' })),
    toolError('protocol_violation', false, 0, 'search'),
  );
  assert.deepEqual(
    await search!.impl({ queries: ['workflow'] }, context({ runId: 'stale-run' })),
    toolError('protocol_violation', false, 0, 'search'),
  );
  assert.equal(authorityCalls, 0);
});

test('unissued spanRef terminates the Attempt tool state', async () => {
  let readCalls = 0;
  const terminalFailures: unknown[] = [];
  const [search, read] = buildMemoryExtractionChildTools(
    binding({ onTerminalFailure: (failure) => terminalFailures.push(failure) }),
    ports({
      evidenceRead: {
        read: async () => {
          readCalls += 1;
          return { status: 'ok', span: span('span-2', 'source-2'), truncated: false };
        },
      },
    }),
  );

  assert.deepEqual(
    await read!.impl({ spanRef: 'forged-span', direction: 'both' }, context()),
    toolError('invalid_span_ref', false, 0, 'read'),
  );
  assert.equal(readCalls, 0);
  assert.deepEqual(terminalFailures, [{ code: 'invalid_span_ref', phase: 'read' }]);
  assert.deepEqual(
    await search!.impl({ queries: ['workflow'] }, context()),
    toolError('protocol_violation', false, 0, 'search'),
  );
});

test('search signs Attempt-local refs that read may expand', async () => {
  let readCalls = 0;
  const [search, read] = buildMemoryExtractionChildTools(
    binding(),
    ports({
      evidenceSearch: {
        search: async () => ({
          status: 'ok',
          spans: [span('span-1', 'source-1')],
          truncated: false,
          omittedCount: 0,
        }),
      },
      evidenceRead: {
        read: async () => {
          readCalls += 1;
          return { status: 'ok', span: span('span-2', 'source-2'), truncated: false };
        },
      },
    }),
  );
  assert.equal(
    ((await search!.impl({ queries: ['workflow'] }, context())) as { status: string }).status,
    'ok',
  );
  assert.equal(
    ((await read!.impl({ spanRef: 'span-1', direction: 'both' }, context())) as { status: string })
      .status,
    'ok',
  );
  assert.equal(readCalls, 1);
});

test('propose rejects source refs not issued to the Attempt', async () => {
  let proposalCalls = 0;
  const [, , submit] = buildMemoryExtractionChildTools(
    binding(),
    ports({
      submission: {
        propose: async () => {
          proposalCalls += 1;
          return receipt();
        },
        resolve: async () => receipt(),
      },
    }),
  );
  assert.deepEqual(
    await submit!.impl({ action: 'propose', result: proposed('forged-source') }, context()),
    toolError('invalid_source_ref', false, 0, 'propose'),
  );
  assert.equal(proposalCalls, 0);
});

test('recoverable phase errors consume the bounded repair budget', async () => {
  const proposal = proposed('source-initial');
  const [, , submit] = buildMemoryExtractionChildTools(
    binding(),
    ports({
      submission: {
        propose: async () => needsResolution(proposal),
        resolve: async () => receipt(),
      },
    }),
  );
  await submit!.impl({ action: 'propose', result: proposal }, context());
  const different: MemoryExtractionResponse = {
    ...proposal,
    proposals: [{ ...proposal.proposals[0]!, content: 'A different proposal.' }],
  };

  assert.deepEqual(
    await submit!.impl({ action: 'propose', result: different }, context({ toolCallId: 'tool-2' })),
    toolError('active_submission_exists', true, 1, 'resolve'),
  );
  assert.deepEqual(
    await submit!.impl({ action: 'propose', result: different }, context({ toolCallId: 'tool-3' })),
    toolError('active_submission_exists', false, 0, 'resolve'),
  );
});

test('two-stage submit commits only after exact candidate resolution', async () => {
  const proposal = proposed('source-initial');
  const candidateResult = needsResolution(proposal);
  const committed = receipt({ mutationCount: 1 });
  let proposeCalls = 0;
  let resolveCalls = 0;
  const [, , submit] = buildMemoryExtractionChildTools(
    binding(),
    ports({
      submission: {
        propose: async () => {
          proposeCalls += 1;
          return candidateResult;
        },
        resolve: async (_invocation, input) => {
          resolveCalls += 1;
          assert.deepEqual(input, {
            submissionRef: 'submission-1',
            decisions: [
              { proposalRef: 'proposal-1', relation: 'revises', candidateRef: 'candidate-1' },
            ],
          });
          return committed;
        },
      },
    }),
  );

  assert.deepEqual(
    await submit!.impl({ action: 'propose', result: proposal }, context()),
    candidateResult,
  );
  assert.deepEqual(
    await submit!.impl(
      {
        action: 'resolve',
        submissionRef: 'submission-1',
        decisions: [
          { proposalRef: 'proposal-1', relation: 'revises', candidateRef: 'candidate-1' },
        ],
      },
      context({ toolCallId: 'tool-2' }),
    ),
    committed,
  );
  assert.equal(proposeCalls, 1);
  assert.equal(resolveCalls, 1);
});

test('identical propose and resolve calls replay without invoking ports again', async () => {
  const proposal = proposed('source-initial');
  const candidateResult = needsResolution(proposal);
  let proposeCalls = 0;
  let resolveCalls = 0;
  const [, , submit] = buildMemoryExtractionChildTools(
    binding(),
    ports({
      submission: {
        propose: async () => {
          proposeCalls += 1;
          return candidateResult;
        },
        resolve: async () => {
          resolveCalls += 1;
          return receipt();
        },
      },
    }),
  );
  const proposeInput = { action: 'propose' as const, result: proposal };
  const resolveInput = {
    action: 'resolve' as const,
    submissionRef: 'submission-1',
    decisions: [
      { proposalRef: 'proposal-1', relation: 'same' as const, candidateRef: 'candidate-1' },
    ],
  };

  const firstPropose = await submit!.impl(proposeInput, context());
  assert.deepEqual(
    await submit!.impl(proposeInput, context({ toolCallId: 'tool-2' })),
    firstPropose,
  );
  const firstResolve = await submit!.impl(resolveInput, context({ toolCallId: 'tool-3' }));
  assert.deepEqual(
    await submit!.impl(resolveInput, context({ toolCallId: 'tool-4' })),
    firstResolve,
  );
  assert.equal(proposeCalls, 1);
  assert.equal(resolveCalls, 1);
});

test('replayed valid calls still consume the total Attempt tool budget', async () => {
  let searchCalls = 0;
  const [search] = buildMemoryExtractionChildTools(
    binding(),
    ports({
      evidenceSearch: {
        search: async () => {
          searchCalls += 1;
          return { status: 'ok', spans: [], truncated: false, omittedCount: 0 };
        },
      },
    }),
  );
  for (let index = 0; index < 12; index += 1) {
    const result = await search!.impl(
      { queries: ['workflow'] },
      context({ toolCallId: `tool-${index}` }),
    );
    assert.equal((result as { status: string }).status, 'ok');
  }
  assert.deepEqual(
    await search!.impl({ queries: ['workflow'] }, context({ toolCallId: 'tool-over-budget' })),
    toolError('tool_budget_exhausted', false, 0, 'search'),
  );
  assert.equal(searchCalls, 1);
});

test('forged candidateRef is rejected before the final commit port', async () => {
  const proposal = proposed('source-initial');
  let resolveCalls = 0;
  const [, , submit] = buildMemoryExtractionChildTools(
    binding(),
    ports({
      submission: {
        propose: async () => needsResolution(proposal),
        resolve: async () => {
          resolveCalls += 1;
          return receipt();
        },
      },
    }),
  );
  await submit!.impl({ action: 'propose', result: proposal }, context());
  assert.deepEqual(
    await submit!.impl(
      {
        action: 'resolve',
        submissionRef: 'submission-1',
        decisions: [
          { proposalRef: 'proposal-1', relation: 'same', candidateRef: 'forged-candidate' },
        ],
      },
      context({ toolCallId: 'tool-2' }),
    ),
    toolError('invalid_candidate_ref', false, 0, 'resolve'),
  );
  assert.equal(resolveCalls, 0);
});

function binding(overrides: Partial<MemoryExtractionChildBinding> = {}) {
  return {
    operationId: 'operation-1',
    attemptId: 'attempt-1',
    internalSessionId: 'memory-session-1',
    runId: 'memory-run-1',
    initialSourceRefs: ['source-initial'],
    ...overrides,
  } satisfies MemoryExtractionChildBinding;
}

function ports(
  overrides: Partial<MemoryExtractionChildToolPorts> = {},
): MemoryExtractionChildToolPorts {
  return {
    authority: { assertActive: () => undefined },
    evidenceSearch: {
      search: async () => ({ status: 'ok', spans: [], truncated: false, omittedCount: 0 }),
    },
    evidenceRead: {
      read: async () => ({
        status: 'ok',
        span: span('span-read', 'source-read'),
        truncated: false,
      }),
    },
    submission: { propose: async () => receipt(), resolve: async () => receipt() },
    ...overrides,
  };
}

function context(overrides: Partial<MakaToolContext> = {}): MakaToolContext {
  return {
    sessionId: 'memory-session-1',
    runId: 'memory-run-1',
    turnId: 'memory-turn-1',
    cwd: '/workspace',
    toolCallId: 'tool-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
    ...overrides,
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
        temporal: { type: 'undated' },
        scopeProposal: 'global',
        suggestedKeys: [{ key: 'concise answers', keyType: 'concept' }],
        supports: [{ sourceRef, quote: 'Please keep answers concise.' }],
      },
    ],
  };
}

function needsResolution(response: MemoryExtractionResponse): MemoryProposalSubmissionResult {
  return {
    status: 'needs_resolution',
    submissionRef: 'submission-1',
    cases: [
      {
        proposalRef: 'proposal-1',
        proposal: response.proposals[0]!,
        candidates: [
          {
            candidateRef: 'candidate-1',
            item: {
              content: 'Existing preference',
              kind: 'preference',
              statementType: 'fact',
              temporalType: 'undated',
              eventStartedAt: null,
              eventEndedAt: null,
            },
          },
        ],
      },
    ],
  };
}

function span(spanRef: string, sourceRef: string) {
  return {
    spanRef,
    sources: [
      {
        sourceRef,
        role: 'user' as const,
        kind: 'message' as const,
        occurredAt: 1_722_470_400_000,
        content: 'Please keep answers concise.',
      },
    ],
  };
}

function receipt(overrides: Partial<MemorySubmissionReceipt> = {}): MemorySubmissionReceipt {
  return {
    status: 'committed',
    resultType: 'proposed',
    mutationCount: 0,
    replayed: false,
    ...overrides,
  };
}

function toolError(
  code: string,
  retryableInRun: boolean,
  remainingRepairs: 0 | 1,
  expectedPhase: 'search' | 'read' | 'propose' | 'resolve',
) {
  return { status: 'error', code, retryableInRun, remainingRepairs, expectedPhase } as const;
}
