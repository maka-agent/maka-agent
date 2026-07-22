import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { computeCost } from '../telemetry/cost.js';
import { recordLlmCall } from '../telemetry/record-llm-call.js';
import { recordToolInvocation } from '../telemetry/record-tool-invocation.js';
import type { PersistedLlmCallRecord, PersistedToolInvocationRecord } from '../telemetry/types.js';

describe('computeCost', () => {
  test('charges full input price only for cache-miss input', () => {
    const cost = computeCost(
      {
        inputTokens: 100,
        outputTokens: 50,
        cacheHitInputTokens: 30,
        cacheMissInputTokens: 60,
        cacheWriteInputTokens: 10,
      },
      {
        modelKey: 'deepseek:deepseek-chat',
        inputUsdPer1M: 1,
        outputUsdPer1M: 2,
        cacheReadUsdPer1M: 0.25,
        cacheWriteUsdPer1M: 1.5,
      },
    );

    assert.equal(cost.inputCost, 0.00006);
    assert.equal(cost.cacheReadCost, 0.0000075);
    assert.ok(Math.abs(cost.cacheWriteCost - 0.000015) < 1e-12);
    assert.equal(cost.outputCost, 0.0001);
    assert.ok(Math.abs(cost.totalCost - 0.0001825) < 1e-12);
  });

  test('derives cache miss from total input when explicit miss is absent', () => {
    const cost = computeCost(
      {
        inputTokens: 100,
        outputTokens: 0,
        cacheHitInputTokens: 40,
        cacheWriteInputTokens: 10,
      },
      {
        modelKey: 'deepseek:deepseek-chat',
        inputUsdPer1M: 1,
        outputUsdPer1M: 2,
        cacheReadUsdPer1M: 0.25,
        cacheWriteUsdPer1M: 1.5,
      },
    );

    assert.equal(cost.inputCost, 0.00005);
    assert.equal(cost.cacheReadCost, 0.00001);
    assert.ok(Math.abs(cost.cacheWriteCost - 0.000015) < 1e-12);
    assert.ok(Math.abs(cost.totalCost - 0.000075) < 1e-12);
  });

  test('treats all input as fresh when no cache data exists', () => {
    const cost = computeCost(
      {
        inputTokens: 100,
        outputTokens: 0,
      },
      {
        modelKey: 'deepseek:deepseek-chat',
        inputUsdPer1M: 1,
        outputUsdPer1M: 2,
        cacheReadUsdPer1M: 0.25,
      },
    );

    assert.equal(cost.inputCost, 0.0001);
    assert.equal(cost.cacheReadCost, 0);
    assert.equal(cost.totalCost, 0.0001);
  });
});

describe('recordLlmCall', () => {
  test('preserves a runtime-provided cost fact instead of recomputing it', async () => {
    const inserted: PersistedLlmCallRecord[] = [];

    await recordLlmCall(
      {
        repo: {
          insertLlmCall: async (record) => {
            inserted.push(record);
          },
          insertToolInvocation: async () => {},
        },
        lookupPricing: () => {
          throw new Error('lookup should not run when costUsd is already present');
        },
      },
      {
        turnId: 'turn-1',
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.123,
        latencyMs: 7,
        status: 'success',
        startedAt: 100,
      },
    );

    assert.equal(inserted[0]?.costUsd, 0.123);
  });

  test('settles only after record publication completes', async () => {
    let finishPublication!: () => void;
    const publication = new Promise<void>((resolve) => {
      finishPublication = resolve;
    });
    let settled = false;

    const recording = recordLlmCall(
      {
        repo: {
          insertLlmCall: () => publication,
          insertToolInvocation: async () => {},
        },
        lookupPricing: () => null,
      },
      {
        turnId: 'turn-barrier',
        providerId: 'openai',
        modelId: 'gpt-5',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        status: 'success',
        startedAt: 100,
      },
    );
    void recording.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);

    finishPublication();
    await recording;
    assert.equal(settled, true);
  });
});

describe('recordToolInvocation', () => {
  test('normalizes the tool invocation before publishing it', async () => {
    const inserted: PersistedToolInvocationRecord[] = [];

    const recording = recordToolInvocation(
      {
        repo: {
          insertLlmCall: async () => {},
          insertToolInvocation: async (record) => {
            inserted.push(record);
          },
        },
      },
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        durationMs: 5,
        status: 'success',
        startedAt: 100,
      },
    );
    await recording;

    assert.equal(inserted[0]?.id, 'tool_call-1');
    assert.equal(inserted[0]?.ts, 105);
    assert.equal(inserted[0]?.bytesIn, 0);
    assert.equal(inserted[0]?.bytesOut, 0);
  });

  test('settles only after record publication completes', async () => {
    let finishPublication!: () => void;
    const publication = new Promise<void>((resolve) => {
      finishPublication = resolve;
    });
    let settled = false;

    const recording = recordToolInvocation(
      {
        repo: {
          insertLlmCall: async () => {},
          insertToolInvocation: () => publication,
        },
      },
      {
        toolCallId: 'call-barrier',
        toolName: 'Bash',
        durationMs: 5,
        status: 'success',
        startedAt: 100,
      },
    );
    void recording.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);

    finishPublication();
    await recording;
    assert.equal(settled, true);
  });
});
