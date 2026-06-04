import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { testConnection } from '../test-connection.js';

describe('Claude subscription runtime wiring', () => {
  test('testConnection treats resolved Claude OAuth token as a usable login', async () => {
    const result = await testConnection(claudeOAuthConnection(), 'oauth-access-token');
    assert.equal(result.ok, true);
  });

  test('testConnection never burns Claude OAuth quota with a synthetic messages probe', async () => {
    const src = await readFile(new URL('../../src/test-connection.ts', import.meta.url), 'utf8');
    const branchIdx = src.indexOf("connection.providerType === 'claude-subscription'");
    assert.notEqual(branchIdx, -1, 'Claude OAuth test branch must exist');
    const branchRegion = src.slice(branchIdx, src.indexOf("const r = await proxiedFetch", branchIdx));
    assert.match(
      branchRegion,
      /return \{ ok: true, latencyMs: Date\.now\(\) - t0, modelTested: model \}/,
      'Claude OAuth connection test should validate stored login presence without calling the chat endpoint',
    );
    assert.doesNotMatch(branchRegion, /anthropicV1Url\(baseUrl, '\/messages'\)/);
    assert.doesNotMatch(branchRegion, /messages:\s*\[\{ role: 'user', content: 'Hi' \}\]/);
  });

  test('model factory constructs Anthropic with authToken for claude-subscription', async () => {
    const src = await readFile(new URL('../../src/model-factory.ts', import.meta.url), 'utf8');
    const caseIdx = src.indexOf("case 'claude-subscription'");
    assert.notEqual(caseIdx, -1, 'claude-subscription case must exist');
    const caseRegion = src.slice(caseIdx, src.indexOf("case 'codex-subscription'", caseIdx));
    assert.match(caseRegion, /createAnthropic\(\{[\s\S]*authToken:\s*apiKey/, 'Claude OAuth must use AI SDK Anthropic authToken');
    assert.match(caseRegion, /baseURL:\s*anthropicV1BaseUrl\(baseURL\)/, 'Claude OAuth must pass the AI SDK a /v1 Anthropic base URL');
    assert.match(caseRegion, /fetch,/, 'Claude OAuth must accept the desktop cloak fetch wrapper');
    assert.doesNotMatch(caseRegion, /throw new Error/, 'Claude OAuth must not remain in the experimental throw branch');
    assert.match(caseRegion, /anthropic-beta[\s\S]*CLAUDE_SUBSCRIPTION_BETA/, 'Claude OAuth must send the Claude Code beta header set');
  });

  test('model factory gives API-key Anthropic the /v1 SDK base without changing Kimi', async () => {
    const src = await readFile(new URL('../../src/model-factory.ts', import.meta.url), 'utf8');
    const anthropicCase = src.slice(src.indexOf("case 'anthropic'"), src.indexOf("case 'kimi-coding-plan'"));
    const kimiCase = src.slice(src.indexOf("case 'kimi-coding-plan'"), src.indexOf("case 'claude-subscription'"));

    assert.match(anthropicCase, /baseURL:\s*anthropicV1BaseUrl\(baseURL\)/, 'Anthropic API-key sends must use the SDK /v1 base URL');
    assert.match(kimiCase, /baseURL,\s*[\s\S]*headers:/, 'Kimi Anthropic-compatible endpoint must keep its provider-specific base URL');
    assert.doesNotMatch(kimiCase, /anthropicV1BaseUrl/, 'Kimi endpoint must not be blindly rewritten to /v1');
  });

  test('model factory wires codex-subscription to OpenAI Responses with account-scoped fetch/header shape', async () => {
    const src = await readFile(new URL('../../src/model-factory.ts', import.meta.url), 'utf8');
    const caseIdx = src.indexOf("case 'codex-subscription'");
    assert.notEqual(caseIdx, -1, 'codex-subscription case must exist');
    const caseRegion = src.slice(caseIdx, src.indexOf("case 'gemini-cli'", caseIdx));
    assert.match(caseRegion, /createOpenAI\(\{[\s\S]*apiKey/, 'Codex OAuth must use OpenAI client with OAuth token');
    assert.match(caseRegion, /fetch,/, 'Codex OAuth must accept the desktop ChatGPT backend fetch wrapper');
    assert.match(caseRegion, /codexSubscriptionHeaders\(apiKey\)/, 'Codex OAuth must attach account-scoped headers');
    assert.match(caseRegion, /\.responses\(modelId\)/, 'Codex OAuth must use Responses API');
    assert.doesNotMatch(caseRegion, /throw new Error/, 'Codex OAuth must not remain in the experimental throw branch');
  });

  test('testConnection treats resolved Codex OAuth token as a usable login', async () => {
    const result = await testConnection(codexOAuthConnection(), codexAccessToken('acct_test'));
    assert.equal(result.ok, true);
    assert.equal(result.modelTested, 'gpt-5.5');
  });

  test('Codex OAuth headers include ChatGPT Responses beta and account id', async () => {
    const src = await readFile(new URL('../../src/subscription-auth.ts', import.meta.url), 'utf8');
    assert.match(src, /OpenAI-Beta['"]:\s*['"]responses=experimental/, 'Codex OAuth must opt into ChatGPT Responses beta');
    assert.equal(
      (await import('../subscription-auth.js')).codexSubscriptionHeaders(codexAccessToken('acct_test'))['ChatGPT-Account-Id'],
      'acct_test',
    );
  });

  test('Codex OAuth headers do not fall back to JWT sub as ChatGPT account id', async () => {
    const { codexSubscriptionHeaders } = await import('../subscription-auth.js');
    const headers = codexSubscriptionHeaders(codexAccessTokenWithoutChatGptAccount('sub_not_account'));
    assert.equal(headers['ChatGPT-Account-Id'], undefined);
  });

  test('Codex OAuth provider options use non-persistent ChatGPT backend defaults', async () => {
    const src = await readFile(new URL('../../src/model-factory.ts', import.meta.url), 'utf8');
    const fnIdx = src.indexOf('export function buildProviderOptions');
    const caseIdx = src.indexOf("case 'codex-subscription'", fnIdx);
    const caseRegion = src.slice(caseIdx, src.indexOf("case 'openai'", caseIdx));
    assert.match(caseRegion, /store:\s*false/, 'Codex OAuth sends must not persist Responses API inputs by default');
    assert.match(caseRegion, /textVerbosity:\s*['"]medium['"]/, 'Codex OAuth sends must use the ChatGPT backend text verbosity shape');
  });
});

function claudeOAuthConnection(): LlmConnection {
  return {
    slug: 'claude-subscription',
    name: 'Claude OAuth',
    providerType: 'claude-subscription',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function codexOAuthConnection(): LlmConnection {
  return {
    slug: 'codex-subscription',
    name: 'Codex OAuth',
    providerType: 'codex-subscription',
    defaultModel: 'gpt-5.5',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function codexAccessToken(accountId: string): string {
  return [
    base64url({ alg: 'none', typ: 'JWT' }),
    base64url({
      sub: 'sub_fallback',
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
      },
    }),
    'signature',
  ].join('.');
}

function codexAccessTokenWithoutChatGptAccount(sub: string): string {
  return [
    base64url({ alg: 'none', typ: 'JWT' }),
    base64url({ sub }),
    'signature',
  ].join('.');
}

function base64url(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
