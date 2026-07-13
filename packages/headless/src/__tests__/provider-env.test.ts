import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerCredentialEnv } from '../provider-env.js';

test('MiniMax Coding Plan uses a credential namespace separate from MiniMax direct API', () => {
  assert.deepEqual(providerCredentialEnv('minimax-coding-plan'), {
    apiKeys: ['MINIMAX_CODING_PLAN_API_KEY'],
    apiKeyFile: 'MINIMAX_CODING_PLAN_API_KEY_FILE',
    baseUrls: ['MINIMAX_CODING_PLAN_BASE_URL'],
  });
  assert.deepEqual(providerCredentialEnv('MiniMax'), {
    apiKeys: ['MINIMAX_API_KEY'],
    apiKeyFile: 'MINIMAX_API_KEY_FILE',
    baseUrls: ['MINIMAX_BASE_URL'],
  });
});

test('xAI keeps provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('xai'), {
    apiKeys: ['XAI_API_KEY'],
    apiKeyFile: 'XAI_API_KEY_FILE',
    baseUrls: ['XAI_BASE_URL'],
  });
});
