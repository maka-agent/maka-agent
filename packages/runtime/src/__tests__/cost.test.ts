import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { computeCost } from '../telemetry/cost.js';

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
        cachedInputTokens: 40,
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
