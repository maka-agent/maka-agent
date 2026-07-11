import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseRuntimePolicyAbExecutionProfile } from '../runtime-policy-ab-profile.js';

test('checked-in runtime A/B profile pins DeepSeek Flash identity, pricing, and safety limits', async () => {
  const path = new URL('../../harbor/runtime-policy-ab-profiles/deepseek-v4-flash.json', import.meta.url);
  const profile = parseRuntimePolicyAbExecutionProfile(JSON.parse(await readFile(path, 'utf8')));

  assert.equal(profile.model, 'deepseek/deepseek-v4-flash');
  assert.equal(profile.pricing.source, 'deepseek-v4-flash');
  assert.equal(profile.costCeilingUsd, 20);
  assert.equal(profile.maxConcurrentAttempts, 4);
});

test('profile parser rejects the old ambiguous attempt concurrency', () => {
  assert.throws(
    () => parseRuntimePolicyAbExecutionProfile({
      schemaVersion: 1,
      id: 'bad',
      llmConnectionSlug: 'deepseek',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek/deepseek-v4-flash',
      pricing: { inputUsdPer1M: 1, outputUsdPer1M: 1, cacheReadUsdPer1M: 0, cacheWriteUsdPer1M: 0, source: 'bad' },
      taskBudgetSec: 1800,
      harborTimeoutMs: 2_100_000,
      costCeilingUsd: 20,
      maxConcurrentAttempts: 3,
    }),
    /maxConcurrentAttempts must be an even integer of at least 2/,
  );
});
