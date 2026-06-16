import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  applyRuntimeEventContextBudget,
  buildSynthesisCacheBlocksFromHydratedArchives,
  deserializeToolResultArchive,
  renderSynthesisCacheBlock,
  retrieveArchivedToolResultsForReplay,
  retrieveRuntimeEventHistoryAround,
  selectSynthesisCacheForReplay,
  serializeToolResultForArchive,
  validateSynthesisCacheBlockShape,
  type SynthesisCacheBlock,
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
    assert.deepEqual(retrieval.retrievedSourceRefs, [{
      kind: 'archived_tool_result',
      sessionId: 'session-1',
      turnId: 'turn-old',
      runtimeEventId: 'result-old',
      toolCallId: 'tool-old',
      toolName: 'Read',
      artifactId: 'artifact-old',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
      placeholderReason: 'stale_tool_result_pruned_before_compact',
    }]);
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

  test('gates archive reads to history-selected turns when requested', async () => {
    const selected = serializeToolResultForArchive({ kind: 'text', text: 'selected' });
    const unselected = serializeToolResultForArchive({ kind: 'text', text: 'unselected' });
    const events = [
      archivedResult('result-selected', 'turn-selected', 'tool-selected', {
        artifactId: 'artifact-selected',
        bodySha256: sha256(selected),
        originalEstimatedTokens: selected.length,
        originalBytes: utf8Bytes(selected),
      }),
      archivedResult('result-unselected', 'turn-unselected', 'tool-unselected', {
        artifactId: 'artifact-unselected',
        bodySha256: sha256(unselected),
        originalEstimatedTokens: unselected.length,
        originalBytes: utf8Bytes(unselected),
      }),
    ];
    const reads: string[] = [];

    const retrieved = await retrieveArchivedToolResultsForReplay(
      events,
      {
        enabled: true,
        mode: 'history_search_gated',
        maxResults: 2,
        maxEstimatedTokens: 1024,
        maxBytes: 1024,
      },
      async (input) => {
        reads.push(input.runtimeEventId);
        return {
          ok: true,
          serializedResult: input.runtimeEventId === 'result-selected' ? selected : unselected,
        };
      },
      { sessionId: 'session-1', allowedTurnIds: new Set(['turn-selected']) },
    );

    assert.deepEqual(reads, ['result-selected']);
    assert.equal(retrieved.diagnosticPatch.archiveRetrievalMode, 'history_search_gated');
    assert.equal(retrieved.diagnosticPatch.archiveRetrievalEligibleTurns, 1);
    assert.equal(retrieved.diagnosticPatch.retrievedArchiveToolResults, 1);
    assert.equal(retrieved.diagnosticPatch.archiveRetrievalSkipped, 1);
    assert.deepEqual(retrieved.diagnosticPatch.archiveRetrievalSkippedReasonCounts, {
      history_search_gate: 1,
    });
    assert.deepEqual(
      retrieved.events[0]?.content?.kind === 'function_response'
        ? retrieved.events[0].content.result
        : undefined,
      { kind: 'text', text: 'selected' },
    );
    assert.equal(
      retrieved.events[1]?.content?.kind === 'function_response'
        ? (retrieved.events[1].content.result as { kind?: string }).kind
        : undefined,
      ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
    );
  });
});

describe('context-budget synthesis cache', () => {
  test('selects a source-bearing synthesis block and injects it for replay only', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [
      toolCall('call-alpha', 'turn-alpha', 'tool-alpha'),
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
      textEvent('recent', 'turn-recent', 'newer retained context'),
    ];
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });

    const result = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      { enabled: true, blocks: [block] },
      { sessionId: 'session-1', charsPerToken: 1 },
    );

    assert.equal(result.selectedBlocks.length, 1);
    assert.equal(result.diagnosticPatch.synthesisCacheMode, 'lookup');
    assert.deepEqual(result.diagnosticPatch.synthesisCacheBlockIds, ['synth-key-alpha']);
    assert.equal(result.diagnosticPatch.highWaterName, 'after-gated-key-alpha');
    assert.equal(events.some((event) => event.id === 'result-alpha'), true);
    assert.equal(result.events.some((event) => event.id === 'result-alpha'), false);
    assert.equal(result.events.some((event) => event.id === 'recent'), true);
    const synthetic = result.events.find((event) => event.id === 'synthesis-cache:synth-key-alpha');
    assert.equal(synthetic?.role, 'model');
    assert.match(
      synthetic?.content?.kind === 'text' ? synthetic.content.text : '',
      /<maka_synthesis_cache_block/,
    );
    assert.match(renderSynthesisCacheBlock(block), /artifact-alpha/);
  });

  test('does not select synthesis when raw evidence is requested', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
    ];
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });

    const result = selectSynthesisCacheForReplay(
      events,
      'Show raw archive evidence for key-alpha',
      { enabled: true, blocks: [block] },
      { sessionId: 'session-1' },
    );

    assert.equal(result.selectedBlocks.length, 0);
    assert.equal(result.diagnosticPatch.synthesisCacheMode, 'fallback_archive_retrieval');
    assert.deepEqual(result.diagnosticPatch.synthesisCacheSkippedReasonCounts, {
      raw_evidence_requested: 1,
    });
    assert.deepEqual(result.events, events);
  });

  test('does not select synthesis for a longer uncovered key that shares a prefix', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
    ];
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });

    const result = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha-noise-01',
      { enabled: true, blocks: [block] },
      { sessionId: 'session-1' },
    );

    assert.equal(result.selectedBlocks.length, 0);
    assert.deepEqual(result.diagnosticPatch.synthesisCacheSkippedReasonCounts, {
      coverage_miss: 1,
    });
  });

  test('invalidates synthesis when source placeholder hashes do not match', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
    ];
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: 'sha256:mismatch',
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });

    const result = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      { enabled: true, blocks: [block] },
      { sessionId: 'session-1' },
    );

    assert.equal(result.selectedBlocks.length, 0);
    assert.deepEqual(result.diagnosticPatch.synthesisCacheInvalidationReasonCounts, {
      source_hash_mismatch: 1,
    });
  });

  test('invalidates synthesis when a newer matching tool result exists', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
      {
        ...archivedResult('result-newer', 'turn-newer', 'tool-newer', {
          artifactId: 'artifact-newer',
          bodySha256: sha256(serialized),
          originalEstimatedTokens: serialized.length,
          originalBytes: utf8Bytes(serialized),
        }),
        ts: 1_800_000_000_010,
        content: {
          kind: 'function_response' as const,
          id: 'tool-newer',
          name: 'Read',
          result: { text: 'new key-alpha payload' },
          isError: false,
        },
      },
    ];
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });

    const result = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      { enabled: true, blocks: [block] },
      { sessionId: 'session-1' },
    );

    assert.equal(result.selectedBlocks.length, 0);
    assert.deepEqual(result.diagnosticPatch.synthesisCacheInvalidationReasonCounts, {
      new_relevant_tool_result: 1,
    });
  });

  test('enforces synthesis block count and token budgets', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
      archivedResult('result-beta', 'turn-beta', 'tool-beta', {
        artifactId: 'artifact-beta',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
    ];
    const first = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });
    const second = {
      ...synthesisBlock({
        queryKey: 'key-alpha',
        turnId: 'turn-beta',
        runtimeEventId: 'result-beta',
        toolCallId: 'tool-beta',
        artifactId: 'artifact-beta',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
      blockId: 'synth-key-alpha-second',
    };

    const maxBlocks = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      { enabled: true, blocks: [first, second], maxBlocks: 1, maxEstimatedTokens: 10_000 },
      { sessionId: 'session-1' },
    );
    assert.equal(maxBlocks.selectedBlocks.length, 1);
    assert.deepEqual(maxBlocks.diagnosticPatch.synthesisCacheSkippedReasonCounts, { max_blocks: 1 });

    const maxBlockTokens = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      { enabled: true, blocks: [{ ...first, estimatedTokens: 99 }], maxBlockEstimatedTokens: 10 },
      { sessionId: 'session-1' },
    );
    assert.equal(maxBlockTokens.selectedBlocks.length, 0);
    assert.deepEqual(maxBlockTokens.diagnosticPatch.synthesisCacheSkippedReasonCounts, {
      max_block_tokens: 1,
    });

    const maxTotalTokens = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      {
        enabled: true,
        blocks: [{ ...first, estimatedTokens: 7 }, { ...second, estimatedTokens: 7 }],
        maxBlocks: 2,
        maxEstimatedTokens: 10,
      },
      { sessionId: 'session-1' },
    );
    assert.equal(maxTotalTokens.selectedBlocks.length, 1);
    assert.deepEqual(maxTotalTokens.diagnosticPatch.synthesisCacheSkippedReasonCounts, {
      max_total_tokens: 1,
    });
  });

  test('builds stable bounded synthesis blocks from hydrated archive refs', () => {
    const resultBody = { text: 'key-alpha stable sentinel SYNTHESIS_BUILDER_SENTINEL' };
    const serialized = serializeToolResultForArchive(resultBody);
    const placeholderEvents = [
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
    ];
    const hydratedEvents = [
      {
        ...placeholderEvents[0]!,
        content: {
          kind: 'function_response' as const,
          id: 'tool-alpha',
          name: 'Read',
          result: resultBody,
        },
      },
    ];
    const sourceRefs = [{
      kind: 'archived_tool_result' as const,
      sessionId: 'session-1',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      toolName: 'Read',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
      placeholderReason: 'stale_tool_result_pruned_before_compact' as const,
    }];

    const first = buildSynthesisCacheBlocksFromHydratedArchives({
      sessionId: 'session-1',
      query: 'Recover key-alpha',
      hydratedRuntimeEvents: hydratedEvents,
      retrievedArchiveRefs: sourceRefs,
      archiveRetrievalMode: 'history_search_gated',
      limits: { maxBlocks: 1, maxBlockEstimatedTokens: 1024, maxEstimatedTokens: 1024, charsPerToken: 4 },
      now: 1_800_000_000_100,
    });
    const second = buildSynthesisCacheBlocksFromHydratedArchives({
      sessionId: 'session-1',
      query: 'Recover key-alpha',
      hydratedRuntimeEvents: hydratedEvents,
      retrievedArchiveRefs: sourceRefs,
      archiveRetrievalMode: 'history_search_gated',
      limits: { maxBlocks: 1, maxBlockEstimatedTokens: 1024, maxEstimatedTokens: 1024, charsPerToken: 4 },
      now: 1_800_000_000_100,
    });

    assert.equal(first.blocks.length, 1);
    assert.equal(first.blocks[0]?.blockId, second.blocks[0]?.blockId);
    assert.equal(first.blocks[0]?.createdFrom, 'gated_archive_retrieval');
    assert.deepEqual(first.blocks[0]?.coverage.artifactIds, ['artifact-alpha']);
    assert.equal(first.blocks[0]?.coverage.queryKeys.includes('key-alpha'), true);
    for (const genericKey of ['context', 'for', 'json', 'kind', 'lookup', 'the', 'tools']) {
      assert.equal(first.blocks[0]?.coverage.queryKeys.includes(genericKey), false, genericKey);
    }
    assert.match(first.blocks[0]?.summary ?? '', /SYNTHESIS_BUILDER_SENTINEL/);
    assert.equal(validateSynthesisCacheBlockShape(first.blocks[0], 'session-1'), true);

    const genericMiss = selectSynthesisCacheForReplay(
      placeholderEvents,
      'Recover an unrelated lookup key',
      { enabled: true, blocks: first.blocks },
      { sessionId: 'session-1' },
    );
    assert.equal(genericMiss.selectedBlocks.length, 0);
    assert.deepEqual(genericMiss.diagnosticPatch.synthesisCacheSkippedReasonCounts, {
      coverage_miss: 1,
    });

    const tooSmall = buildSynthesisCacheBlocksFromHydratedArchives({
      sessionId: 'session-1',
      query: 'Recover key-alpha',
      hydratedRuntimeEvents: hydratedEvents,
      retrievedArchiveRefs: sourceRefs,
      archiveRetrievalMode: 'history_search_gated',
      limits: { maxBlocks: 1, maxBlockEstimatedTokens: 1, maxEstimatedTokens: 1, charsPerToken: 1 },
    });
    assert.equal(tooSmall.blocks.length, 0);
    assert.deepEqual(tooSmall.skippedReasonCounts, { max_block_tokens: 1 });
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

function synthesisBlock(input: {
  queryKey: string;
  turnId: string;
  runtimeEventId: string;
  toolCallId: string;
  artifactId: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
}): SynthesisCacheBlock {
  return {
    kind: 'maka.synthesis_cache_block',
    version: 1,
    blockId: `synth-${input.queryKey}`,
    sessionId: 'session-1',
    createdAt: 1_800_000_000_001,
    highWaterName: `after-gated-${input.queryKey}`,
    highWaterSeq: 1,
    coverage: {
      queryKeys: [input.queryKey],
      turnIds: [input.turnId],
      runtimeEventIds: [input.runtimeEventId],
      toolNames: ['Read'],
      toolCallIds: [input.toolCallId],
      artifactIds: [input.artifactId],
      bodySha256: [input.bodySha256],
    },
    summary: `The stable answer for ${input.queryKey} is SYNTH_SENTINEL.`,
    limitations: ['Does not include raw tool output.'],
    sourceRefs: [{
      kind: 'archived_tool_result',
      sessionId: 'session-1',
      turnId: input.turnId,
      runtimeEventId: input.runtimeEventId,
      toolCallId: input.toolCallId,
      toolName: 'Read',
      artifactId: input.artifactId,
      bodySha256: input.bodySha256,
      originalEstimatedTokens: input.originalEstimatedTokens,
      originalBytes: input.originalBytes,
      placeholderReason: 'stale_tool_result_pruned_before_compact',
    }],
    createdFrom: 'gated_archive_retrieval',
  };
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
