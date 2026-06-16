import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  applyRuntimeEventContextBudget,
  deserializeToolResultArchive,
  retrieveArchivedToolResultsForReplay,
  retrieveRuntimeEventHistoryAround,
  serializeToolResultForArchive,
} from '../context-budget.js';

describe('context-budget archive retrieval', () => {
  test('deserializes JSON, undefined, and fallback strings', () => {
    assert.deepEqual(deserializeToolResultArchive('{"kind":"text","text":"ok"}'), { kind: 'text', text: 'ok' });
    assert.equal(deserializeToolResultArchive('undefined'), undefined);
    assert.equal(deserializeToolResultArchive('plain fallback'), 'plain fallback');
  });

  test('hydrates archived placeholders for replay only after hash validation', async () => {
    const originalResult = { kind: 'text', text: 'old archived payload' };
    const serialized = serializeToolResultForArchive(originalResult);
    const events = [
      toolCall('call-old', 'turn-old', 'tool-old'),
      toolResult('result-old', 'turn-old', 'tool-old', originalResult),
      toolCall('call-new', 'turn-new', 'tool-new'),
      toolResult('result-new', 'turn-new', 'tool-new', { kind: 'text', text: 'new full payload' }),
    ];
    const budgeted = applyRuntimeEventContextBudget(events, {
      staleToolResultPrune: {
        enabled: true,
        maxResultEstimatedTokens: 1,
        minRecentTurnsFull: 1,
        archiveRefs: [{
          runtimeEventId: 'result-old',
          toolCallId: 'tool-old',
          toolName: 'Read',
          artifactId: 'artifact-old',
          bodySha256: sha256(serialized),
          originalEstimatedTokens: serialized.length,
          originalBytes: utf8Bytes(serialized),
          rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
          reason: 'stale_tool_result_pruned_before_compact',
        }],
      },
      archiveRetrieval: { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      minRecentTurns: 2,
      charsPerToken: 1,
    });

    assert.ok(budgeted);
    const retrieval = await retrieveArchivedToolResultsForReplay(
      budgeted.events,
      { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      async () => ({ ok: true, serializedResult: serialized }),
      { sessionId: 'session-1', charsPerToken: 1 },
    );

    const originalBudgeted = budgeted.events.find((event) => event.id === 'result-old');
    assert.equal(
      originalBudgeted?.content?.kind === 'function_response'
        ? (originalBudgeted.content.result as { kind?: string }).kind
        : undefined,
      ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
    );
    const hydrated = retrieval.events.find((event) => event.id === 'result-old');
    assert.deepEqual(
      hydrated?.content?.kind === 'function_response' ? hydrated.content.result : undefined,
      originalResult,
    );
    assert.equal(retrieval.diagnosticPatch.retrievedArchiveToolResults, 1);
    assert.equal(retrieval.diagnosticPatch.retrievedArchiveEstimatedTokens, serialized.length);
  });

  test('uses UTF-8 byte length for non-ASCII archive size validation', async () => {
    const originalResult = { kind: 'text', text: '旧归档 payload 🙂'.repeat(3) };
    const serialized = serializeToolResultForArchive(originalResult);
    assert.ok(utf8Bytes(serialized) > serialized.length);
    const events = [
      toolCall('call-old', 'turn-old', 'tool-old'),
      toolResult('result-old', 'turn-old', 'tool-old', originalResult),
      toolCall('call-new', 'turn-new', 'tool-new'),
      toolResult('result-new', 'turn-new', 'tool-new', { kind: 'text', text: 'new full payload' }),
    ];
    const budgeted = applyRuntimeEventContextBudget(events, {
      staleToolResultPrune: {
        enabled: true,
        maxResultEstimatedTokens: 1,
        minRecentTurnsFull: 1,
        archiveRefs: [{
          runtimeEventId: 'result-old',
          toolCallId: 'tool-old',
          toolName: 'Read',
          artifactId: 'artifact-old',
          bodySha256: sha256(serialized),
          originalEstimatedTokens: serialized.length,
          originalBytes: utf8Bytes(serialized),
          rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
          reason: 'stale_tool_result_pruned_before_compact',
        }],
      },
      archiveRetrieval: { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      minRecentTurns: 1,
      charsPerToken: 1,
    });

    assert.ok(budgeted);
    assert.equal(budgeted.diagnostic.prunedToolResults, 1);
    const retrieval = await retrieveArchivedToolResultsForReplay(
      budgeted.events,
      { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      async (input) =>
        input.originalBytes === utf8Bytes(serialized)
          ? { ok: true, serializedResult: serialized }
          : { ok: false, reason: 'size_mismatch' },
      { sessionId: 'session-1', charsPerToken: 1 },
    );

    const hydrated = retrieval.events.find((event) => event.id === 'result-old');
    assert.deepEqual(
      hydrated?.content?.kind === 'function_response' ? hydrated.content.result : undefined,
      originalResult,
    );
    assert.equal(retrieval.diagnosticPatch.retrievedArchiveToolResults, 1);
    assert.equal(retrieval.diagnosticPatch.archiveRetrievalFailures, 0);
  });

  test('keeps placeholders and records corrupt/missing archive diagnostics', async () => {
    const serialized = serializeToolResultForArchive({ kind: 'text', text: 'body' });
    const events = [toolCall('call-1', 'turn-1', 'tool-1'), archivedResult('result-1', 'turn-1', 'tool-1', {
      artifactId: 'artifact-1',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    })];

    const corrupt = await retrieveArchivedToolResultsForReplay(
      events,
      { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      async () => ({ ok: true, serializedResult: 'tampered' }),
      { sessionId: 'session-1' },
    );
    assert.equal(corrupt.diagnosticPatch.archiveRetrievalFailures, 1);
    assert.deepEqual(corrupt.diagnosticPatch.archiveRetrievalFailureReasonCounts, { corrupt: 1 });
    assert.equal(
      corrupt.events[1]?.content?.kind === 'function_response'
        ? (corrupt.events[1].content.result as { kind?: string }).kind
        : undefined,
      ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
    );

    const missing = await retrieveArchivedToolResultsForReplay(
      events,
      { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      async () => ({ ok: false, reason: 'not_found' }),
      { sessionId: 'session-1' },
    );
    assert.deepEqual(missing.diagnosticPatch.archiveRetrievalFailureReasonCounts, { not_found: 1 });
  });

  test('fails open when retrieval is disabled or no reader is available', async () => {
    const serialized = serializeToolResultForArchive({ kind: 'text', text: 'body' });
    const events = [archivedResult('result-1', 'turn-1', 'tool-1', {
      artifactId: 'artifact-1',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    })];

    const disabled = await retrieveArchivedToolResultsForReplay(
      events,
      { enabled: false, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      async () => ({ ok: true, serializedResult: serialized }),
      { sessionId: 'session-1' },
    );
    assert.notEqual(disabled.events, events);
    assert.deepEqual(disabled.events, events);
    assert.deepEqual(disabled.diagnosticPatch, {});

    const noReader = await retrieveArchivedToolResultsForReplay(
      events,
      { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      undefined,
      { sessionId: 'session-1' },
    );
    assert.deepEqual(noReader.events, events);
    assert.deepEqual(noReader.diagnosticPatch, {});
  });

  test('skips oversized candidates before reading archives', async () => {
    const small = serializeToolResultForArchive({ kind: 'text', text: 'small' });
    const big = serializeToolResultForArchive({ kind: 'text', text: 'big' });
    const events = [
      archivedResult('result-big', 'turn-1', 'tool-big', {
        artifactId: 'artifact-big',
        bodySha256: sha256(big),
        originalEstimatedTokens: 500,
        originalBytes: 5000,
      }),
      archivedResult('result-small', 'turn-2', 'tool-small', {
        artifactId: 'artifact-small',
        bodySha256: sha256(small),
        originalEstimatedTokens: small.length,
        originalBytes: utf8Bytes(small),
      }),
    ];
    const readIds: string[] = [];

    const result = await retrieveArchivedToolResultsForReplay(
      events,
      { enabled: true, maxResults: 2, maxEstimatedTokens: 100, maxBytes: 100 },
      async (input) => {
        readIds.push(input.runtimeEventId);
        return { ok: true, serializedResult: small };
      },
      { sessionId: 'session-1' },
    );

    assert.deepEqual(readIds, ['result-small']);
    assert.equal(result.diagnosticPatch.retrievedArchiveToolResults, 1);
    assert.equal(result.diagnosticPatch.archiveRetrievalSkipped, 1);
    assert.deepEqual(result.diagnosticPatch.archiveRetrievalSkippedReasonCounts, { max_bytes: 1 });
  });

  test('selects newest placeholders first and obeys max result bounds', async () => {
    const first = serializeToolResultForArchive({ kind: 'text', text: 'first' });
    const second = serializeToolResultForArchive({ kind: 'text', text: 'second' });
    const events = [
      toolCall('call-1', 'turn-1', 'tool-1'),
      archivedResult('result-1', 'turn-1', 'tool-1', {
        artifactId: 'artifact-1',
        bodySha256: sha256(first),
        originalEstimatedTokens: first.length,
        originalBytes: utf8Bytes(first),
      }),
      toolCall('call-2', 'turn-2', 'tool-2'),
      archivedResult('result-2', 'turn-2', 'tool-2', {
        artifactId: 'artifact-2',
        bodySha256: sha256(second),
        originalEstimatedTokens: second.length,
        originalBytes: utf8Bytes(second),
      }),
    ];
    const seen: string[] = [];

    const retrieved = await retrieveArchivedToolResultsForReplay(
      events,
      { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      async (input) => {
        seen.push(input.runtimeEventId);
        return { ok: true, serializedResult: input.runtimeEventId === 'result-2' ? second : first };
      },
      { sessionId: 'session-1' },
    );

    assert.deepEqual(seen, ['result-2']);
    assert.equal(retrieved.diagnosticPatch.retrievedArchiveToolResults, 1);
    assert.deepEqual(
      retrieved.events[3]?.content?.kind === 'function_response'
        ? retrieved.events[3].content.result
        : undefined,
      { kind: 'text', text: 'second' },
    );
  });
});

describe('context-budget search and rewrite diagnostics', () => {
  test('retrieves bounded around-context for deterministic RuntimeEvent search hits', () => {
    const events = [
      textEvent('before', 'turn-1', 'setup context'),
      textEvent('target', 'turn-2', 'needle project archive detail'),
      textEvent('after', 'turn-3', 'follow-up context'),
      textEvent('far', 'turn-4', 'unrelated'),
    ];

    const result = retrieveRuntimeEventHistoryAround(
      events,
      'please find needle',
      { enabled: true, maxResults: 1, around: 1, maxEstimatedTokens: 1000 },
      { charsPerToken: 1 },
    );

    assert.deepEqual(result.events.map((event) => event.id), ['before', 'target', 'after']);
    assert.equal(result.diagnosticPatch.historySearchMatches, 1);
    assert.equal(result.diagnosticPatch.historyAroundRetrievedEvents, 3);
  });

  test('records named history rewrite gate version and reset reason', () => {
    const budgeted = applyRuntimeEventContextBudget(
      [textEvent('event-1', 'turn-1', 'hello')],
      {
        historyRewrite: {
          enabled: true,
          name: 'phase6-high-water',
          historyRewriteVersion: 'phase6-v1',
          resetReason: 'explicit_test_reset',
        },
      },
    );

    assert.ok(budgeted);
    assert.equal(budgeted.diagnostic.historyRewriteGate, 'phase6-high-water');
    assert.equal(budgeted.diagnostic.historyRewriteVersion, 'phase6-v1');
    assert.equal(budgeted.diagnostic.historyRewriteResetReason, 'explicit_test_reset');
  });
});

function textEvent(id: string, turnId: string, text: string): RuntimeEvent {
  return baseEvent({
    id,
    turnId,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  });
}

function toolCall(id: string, turnId: string, toolCallId: string): RuntimeEvent {
  return baseEvent({
    id,
    turnId,
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: toolCallId, name: 'Read', args: { path: `${toolCallId}.txt` } },
  });
}

function toolResult(id: string, turnId: string, toolCallId: string, result: unknown): RuntimeEvent {
  return baseEvent({
    id,
    turnId,
    role: 'tool',
    author: 'tool',
    content: { kind: 'function_response', id: toolCallId, name: 'Read', result },
  });
}

function archivedResult(
  id: string,
  turnId: string,
  toolCallId: string,
  archive: {
    artifactId: string;
    bodySha256: string;
    originalEstimatedTokens: number;
    originalBytes: number;
  },
): RuntimeEvent {
  return toolResult(id, turnId, toolCallId, {
    kind: ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
    rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
    runtimeEventId: id,
    toolCallId,
    toolName: 'Read',
    reason: 'stale_tool_result_pruned_before_compact',
    ...archive,
  });
}

function baseEvent(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    invocationId: 'invocation-1',
    ts: 1_800_000_000_000,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
