/**
 * Static-analysis gate: cloak module isolation.
 *
 * xuan `2c5aa125` G-X4: the cloak header logic MUST live in
 * runtime request construction, not in the desktop OAuth service.
 *
 * Narrow source checks retain the cloak isolation contract; OAuth
 * provider and exchange behavior is exercised through public APIs.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OAUTH_LOGIN_PROVIDER_CONFIG,
  OAuthTokenEndpointError,
  exchangeOAuthAuthorizationCode,
} from '@maka/runtime';
import {
  CODEX_OAUTH_CONFIG,
  buildCodexAuthorizationUrl,
} from '../oauth/openai-codex-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SERVICE_SOURCE = resolve(
  DESKTOP_ROOT,
  'src',
  'main',
  'oauth',
  'claude-subscription-service.ts',
);
const SUBSCRIPTION_MODEL_FETCH_SOURCE = resolve(
  DESKTOP_ROOT,
  'src',
  'main',
  'subscription-model-fetch.ts',
);
describe('cloaked request module isolation (xuan G-X4)', () => {
  it('subscription service does NOT statically import cloak request construction', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.doesNotMatch(
      src,
      /^\s*import\s+[^;]+from\s+['"].*cloaked-request[^'"]*['"]/m,
      'claude-subscription-service.ts must NOT statically import cloak request construction',
    );
  });

  it('getAuthorizationUrl clears prior pending so only one authRequestId is ever valid (PR-CLAUDE-OAUTH-SINGLE-PENDING-0)', async () => {
    // WAWQAQ msg b481e9db: user clicked 登录 multiple times; each
    // click stashed a new pending under a fresh authRequestId, but
    // older pendings stayed valid for 10 min and the modal only
    // remembered the LATEST stateHint. If the user pasted from a
    // browser tab tied to an older Anthropic redirect, the parsed
    // state would not match the latest pending and validation
    // would fail forever. Pinning that getAuthorizationUrl
    // explicitly clears prior pendings keeps this from regressing.
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    const region = src.match(/async getAuthorizationUrl\(\)[\s\S]*?const verifier/);
    assert.ok(region, 'getAuthorizationUrl must exist');
    assert.match(
      region[0],
      /this\.pending\.clear\(\)/,
      'getAuthorizationUrl must clear prior pending so only one authRequestId is valid at a time',
    );
  });

  it('subscription service keeps the MAKA_CLAUDE_SUBSCRIPTION_CLOAK emergency opt-out', async () => {
    // The service should expose `isCloakEnabled()` (or otherwise
    // check the env var) so the send-path can decide whether to
    // delegate to the runtime cloak request builder.
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /MAKA_CLAUDE_SUBSCRIPTION_CLOAK[\s\S]*!==\s*'0'/,
      'service must reference MAKA_CLAUDE_SUBSCRIPTION_CLOAK env flag (xuan G-X4 isolation)',
    );
  });

  it('main wires Claude OAuth sends through the dynamic cloak fetch wrapper by default', async () => {
    const src = await readMainProcessCombinedSource();
    assert.match(src, /buildSubscriptionModelFetch\(connection,\s*ctx\.sessionId,\s*model\)/);
    assert.match(src, /isCloakEnabled\(\)[\s\S]*buildClaudeSubscriptionCloakedFetch\([\s\S]*sessionId,\s*modelId\)/);
    assert.match(src, /modelFactory:\s*\(input\)\s*=>\s*getAIModel\(\{\s*\.\.\.input,\s*fetch:\s*modelFetch\s*\}\)/);
    assert.match(src, /buildRuntimeSubscriptionModelFetch\(\{[\s\S]*connection[\s\S]*sessionId[\s\S]*modelId/);
    assert.match(src, /claudeSubscription\.getOrCreateDeviceId\(\)/);
    assert.match(src, /claude:\s*\{[\s\S]*cloakEnabled:\s*true[\s\S]*deviceId[\s\S]*accountUuid/);
    assert.doesNotMatch(src, /buildCloakedRequest\(/, 'desktop must delegate Claude request construction to runtime');
    assert.doesNotMatch(src, /headers\.delete\(['"]x-api-key['"]\)/, 'x-api-key stripping belongs in runtime request construction');
  });

  it('main delegates Codex OAuth request construction to runtime', async () => {
    const src = await readMainProcessCombinedSource();
    assert.match(src, /providerType === 'openai-codex'[\s\S]*buildRuntimeSubscriptionModelFetch\(\{[\s\S]*connection[\s\S]*sessionId[\s\S]*modelId/);
    assert.doesNotMatch(src, /function buildOpenAiCodexFetch/, 'desktop must not duplicate the Codex fetch adapter');
    assert.doesNotMatch(src, /codexInstructionsFromBody/, 'Codex instruction mapping belongs in runtime');
    assert.doesNotMatch(src, /OpenAI-Beta/, 'Codex subscription headers belong in runtime');
  });

  it('main delegates GitHub Copilot subscription headers to the runtime adapter', async () => {
    const src = await readFile(SUBSCRIPTION_MODEL_FETCH_SOURCE, 'utf8');
    assert.match(
      src,
      /providerType === 'github-copilot'[\s\S]*buildRuntimeSubscriptionModelFetch\(\{[\s\S]*connection[\s\S]*sessionId[\s\S]*modelId/,
    );
    assert.doesNotMatch(src, /Openai-Intent/, 'GitHub Copilot compatibility headers belong in runtime');
    assert.doesNotMatch(src, /Copilot-Vision-Request/, 'GitHub Copilot vision headers belong in runtime');
  });

  it('uses the Runtime-owned Claude OAuth provider contract', () => {
    const config = OAUTH_LOGIN_PROVIDER_CONFIG['claude-subscription'];
    assert.equal(config.authorizationEndpoint, 'https://claude.com/cai/oauth/authorize');
    assert.equal(config.redirectUri, 'https://platform.claude.com/oauth/code/callback');
    assert.equal(config.tokenEndpoint, 'https://platform.claude.com/v1/oauth/token');
    assert.equal(config.scope, 'user:sessions:claude_code user:mcp_servers user:file_upload');
    assert.match(config.tokenUserAgent, /^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
  });

  it('builds the Desktop Codex URL through the closed shared contract', () => {
    const verifier = 'v'.repeat(43);
    const state = 's'.repeat(43);
    const url = new URL(buildCodexAuthorizationUrl({
      redirectUri: CODEX_OAUTH_CONFIG.redirectUri,
      verifier,
      state,
    }));
    const shared = OAUTH_LOGIN_PROVIDER_CONFIG['openai-codex'];
    assert.equal(url.origin + url.pathname, shared.authorizationEndpoint);
    assert.equal(url.searchParams.get('client_id'), shared.clientId);
    assert.equal(url.searchParams.get('redirect_uri'), CODEX_OAUTH_CONFIG.redirectUri);
    assert.equal(url.searchParams.get('state'), state);
  });

  it('does not retain provider response details in typed exchange errors', async () => {
    const providerDetail = 'authorization code belongs to private account';
    await assert.rejects(
      exchangeOAuthAuthorizationCode({
        provider: 'claude-subscription',
        code: 'authorization-code',
        verifier: 'v'.repeat(43),
        state: 's'.repeat(43),
        signal: new AbortController().signal,
        fetchFn: async () => new Response(JSON.stringify({
          error: 'invalid_grant',
          error_description: providerDetail,
        }), { status: 400 }),
      }),
      (error) => {
        assert.ok(error instanceof OAuthTokenEndpointError);
        assert.equal(error.category, 'invalid_grant');
        assert.equal(error.status, 400);
        assert.doesNotMatch(error.message, new RegExp(providerDetail));
        assert.equal('body' in error, false);
        return true;
      },
    );
  });
});
