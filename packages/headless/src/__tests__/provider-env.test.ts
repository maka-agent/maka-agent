import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerCredentialEnv, requireProviderCredentialEnv } from '../provider-env.js';

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

test('Cerebras credentials stay provider-scoped and support key files', () => {
  assert.deepEqual(providerCredentialEnv('cerebras'), {
    apiKeys: ['CEREBRAS_API_KEY'],
    apiKeyFile: 'CEREBRAS_API_KEY_FILE',
    baseUrls: ['CEREBRAS_BASE_URL'],
  });
});

test('Mistral keeps provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('mistral'), {
    apiKeys: ['MISTRAL_API_KEY'],
    apiKeyFile: 'MISTRAL_API_KEY_FILE',
    baseUrls: ['MISTRAL_BASE_URL'],
  });
});

test('Together AI keeps its official provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('togetherai'), {
    apiKeys: ['TOGETHER_API_KEY'],
    apiKeyFile: 'TOGETHER_API_KEY_FILE',
    baseUrls: ['TOGETHER_BASE_URL'],
  });
});

test('Fireworks AI keeps provider-scoped credential environment names', () => {
  assert.deepEqual(providerCredentialEnv('fireworks-ai'), {
    apiKeys: ['FIREWORKS_API_KEY'],
    apiKeyFile: 'FIREWORKS_API_KEY_FILE',
    baseUrls: ['FIREWORKS_BASE_URL'],
  });
});

test('NVIDIA credentials stay provider-scoped and support key files', () => {
  assert.deepEqual(providerCredentialEnv('nvidia'), {
    apiKeys: ['NVIDIA_API_KEY'],
    apiKeyFile: 'NVIDIA_API_KEY_FILE',
    baseUrls: ['NVIDIA_BASE_URL'],
  });
});

test('Tencent TokenHub keeps direct API credentials separate from Tencent plans', () => {
  assert.deepEqual(providerCredentialEnv('tencent-tokenhub'), {
    apiKeys: ['TENCENT_TOKENHUB_API_KEY'],
    apiKeyFile: 'TENCENT_TOKENHUB_API_KEY_FILE',
    baseUrls: ['TENCENT_TOKENHUB_BASE_URL'],
  });
});

test('Tencent Coding Plan is unavailable to non-interactive headless credential loading', () => {
  assert.equal(providerCredentialEnv('tencent-coding-plan'), undefined);
  assert.throws(
    () => requireProviderCredentialEnv('tencent-coding-plan'),
    /provider does not support API key files: tencent-coding-plan/,
  );
});

test('StepFun China keeps direct API credentials separate from global and plan identities', () => {
  assert.deepEqual(providerCredentialEnv('stepfun'), {
    apiKeys: ['STEPFUN_API_KEY'],
    apiKeyFile: 'STEPFUN_API_KEY_FILE',
    baseUrls: ['STEPFUN_BASE_URL'],
  });
});

test('StepFun Global keeps direct API credentials separate from China and plan identities', () => {
  assert.deepEqual(providerCredentialEnv('stepfun-ai'), {
    apiKeys: ['STEPFUN_AI_API_KEY'],
    apiKeyFile: 'STEPFUN_AI_API_KEY_FILE',
    baseUrls: ['STEPFUN_AI_BASE_URL'],
  });
});

test('Volcengine Ark direct API uses its official credential namespace', () => {
  assert.deepEqual(providerCredentialEnv('volcengine-ark'), {
    apiKeys: ['ARK_API_KEY'],
    apiKeyFile: 'ARK_API_KEY_FILE',
    baseUrls: ['ARK_BASE_URL'],
  });
});
