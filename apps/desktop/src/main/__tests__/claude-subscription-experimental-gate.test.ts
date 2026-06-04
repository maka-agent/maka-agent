/**
 * Static-analysis gate: experimental kill-switch
 * (kenji `1da909d5` + `45b31e16`).
 *
 * Anthropic's third-party developer terms do not permit offering
 * Claude.ai login on behalf of users. Until product/legal sign-off,
 * the entire feature must be gated:
 *   - Settings UI must NOT render the Claude subscription card
 *     when `MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL=1` is unset.
 *   - Main-process IPC handlers must fail-closed when the flag is
 *     unset (via `experimental_disabled` reason, NOT
 *     `provider_rejected` — kenji `45b31e16`).
 *
 * This test scans source for the required guard wiring.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const SERVICE_SOURCE = resolve(
  REPO_ROOT,
  'apps',
  'desktop',
  'src',
  'main',
  'oauth',
  'claude-subscription-service.ts',
);
const MAIN_SOURCE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'main.ts');
const SETTINGS_SOURCE = resolve(
  REPO_ROOT,
  'apps',
  'desktop',
  'src',
  'renderer',
  'settings',
  'SettingsModal.tsx',
);
const PROVIDERS_PANEL_SOURCE = resolve(
  REPO_ROOT,
  'apps',
  'desktop',
  'src',
  'renderer',
  'settings',
  'ProvidersPanel.tsx',
);
const CORE_TYPES_SOURCE = resolve(REPO_ROOT, 'packages', 'core', 'src', 'oauth-subscription.ts');

describe('experimental kill-switch (kenji 1da909d5 + 45b31e16)', () => {
  it('service exports isSubscriptionExperimentalEnabled tied to the env flag', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /export function isSubscriptionExperimentalEnabled\(\)/,
      'service must export isSubscriptionExperimentalEnabled() for main + tests to consume',
    );
    assert.match(
      src,
      /MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL/,
      'service must reference the MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL env var',
    );
  });

  it('core defines the dedicated experimental_disabled failure reason (kenji 45b31e16)', async () => {
    const src = await readFile(CORE_TYPES_SOURCE, 'utf8');
    assert.match(
      src,
      /'experimental_disabled'/,
      'core SubscriptionActionFailureReason must include experimental_disabled — distinct from provider_rejected so user copy does not confuse a Maka gate with an Anthropic rejection',
    );
  });

  it('main.ts IPC auth handlers re-check the experimental flag (not just UI)', async () => {
    const src = await readFile(MAIN_SOURCE, 'utf8');
    // The handlers MUST not just trust the renderer to hide the
    // card. Each of these handlers must guard with the flag.
    const handlers = [
      'claude-subscription:get-auth-url',
      'claude-subscription:open-auth-url',
      'claude-subscription:complete-authorization',
      'claude-subscription:refresh-quota',
      'claude-subscription:refresh-tokens',
    ];
    for (const handler of handlers) {
      const handlerIdx = src.indexOf(handler);
      assert.notEqual(handlerIdx, -1, `handler ${handler} must be wired in main.ts`);
      // Look at the surrounding 1200 chars for the experimental
      // check. Permissive: either an explicit `isSubscriptionExperimentalEnabled()`
      // call or the shared `experimentalDisabledResponse` constant.
      // The window must be generous because handlers can carry
      // multi-paragraph docstrings explaining the guard choice.
      const region = src.slice(handlerIdx, handlerIdx + 1200);
      const guarded =
        /isSubscriptionExperimentalEnabled\(\)/.test(region) ||
        /experimentalDisabledResponse/.test(region) ||
        /claude-subscription is disabled/.test(region);
      assert.ok(
        guarded,
        `handler ${handler} must re-check isSubscriptionExperimentalEnabled() or return experimentalDisabledResponse`,
      );
    }
  });

  it('main.ts disabled response uses experimental_disabled, not provider_rejected', async () => {
    const src = await readFile(MAIN_SOURCE, 'utf8');
    // The shared disabled response constant must use the dedicated
    // reason. We accept the literal string presence as proxy for
    // the field value.
    assert.match(
      src,
      /reason:\s*'experimental_disabled'\s*as\s*const/,
      'main.ts experimentalDisabledResponse must use experimental_disabled reason (kenji 45b31e16)',
    );
    assert.doesNotMatch(
      src,
      /尚未在此版本启用/,
      'experimental-disabled user copy must describe the current product gate, not version/timeline status',
    );
  });

  it('Settings UI gates the Claude subscription card on isExperimentalEnabled', async () => {
    // PR-CLAUDE-CARD-MOVE-0: the ClaudeSubscriptionCard moved
    // from SettingsModal.tsx → ProvidersPanel.tsx; the source we
    // scan for the self-gate must follow it.
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    // The card component must:
    // 1. Read isExperimentalEnabled() on mount.
    // 2. Return null when the flag is not truthy (no teasing UI).
    assert.match(
      src,
      /isExperimentalEnabled\(\)/,
      'Settings must call claudeSubscription.isExperimentalEnabled() before rendering subscription UI',
    );
    assert.match(
      src,
      /if\s*\(\s*experimentalEnabled\s*!==\s*true\s*\)\s*\{\s*return null;/,
      'ClaudeSubscriptionCard must return null when experimental flag is not true',
    );
    assert.doesNotMatch(
      src,
      /\.catch\(\(\) => \{[\s\S]*setExperimentalEnabled\(false\)/,
      'a thrown experimental-gate probe is unknown/error, not the same as the flag being disabled',
    );
    assert.match(
      src,
      /experimentalGateError[\s\S]*role="alert"[\s\S]*Claude 登录开关读取失败[\s\S]*refreshExperimentalGate\(\)/,
      'experimental-gate probe failures must render a visible retryable error instead of an empty modal',
    );
  });

  it('preload exposes isExperimentalEnabled via the claudeSubscription bridge', async () => {
    const src = await readFile(
      resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'preload', 'preload.ts'),
      'utf8',
    );
    assert.match(
      src,
      /isExperimentalEnabled\s*\(\s*\)\s*:\s*Promise<boolean>/,
      'preload must expose isExperimentalEnabled() so the Settings card can self-gate',
    );
  });

  it('preload openAuthUrl signature takes authRequestId, not URL (kenji 1da909d5)', async () => {
    const src = await readFile(
      resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'preload', 'preload.ts'),
      'utf8',
    );
    assert.match(
      src,
      /openAuthUrl\(\s*authRequestId\s*:\s*string\s*\)/,
      'preload openAuthUrl must take authRequestId (opaque), NOT a renderer-provided URL — main looks up the URL it generated',
    );
  });

  it('service openAuthorizationUrl looks up URL from pending map (kenji 1da909d5)', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /async openAuthorizationUrl\(authRequestId:\s*string\)/,
      'service openAuthorizationUrl must take authRequestId — never accept an arbitrary URL from the renderer',
    );
    assert.match(
      src,
      /shell\.openExternal\(pending\.url\)/,
      'service must open pending.url (main-generated), not a renderer-provided URL',
    );
  });

  it('AuthorizationUrlPayload has NO url field — renderer never holds the URL (kenji 027c93c0)', async () => {
    const src = await readFile(CORE_TYPES_SOURCE, 'utf8');
    // Find the `AuthorizationUrlPayload` interface block and
    // confirm no `url:` field is declared.
    const match = src.match(/export interface AuthorizationUrlPayload\s*\{([\s\S]*?)\}/);
    assert.ok(match, 'AuthorizationUrlPayload export must exist');
    const body = match[1]!;
    assert.doesNotMatch(
      body,
      /\burl\s*:/,
      'AuthorizationUrlPayload must NOT declare a url field (renderer must not hold the auth URL — kenji 027c93c0)',
    );
    // Sanity: the renderer DOES still need authRequestId + stateHint.
    assert.match(body, /authRequestId\s*:\s*string/, 'AuthorizationUrlPayload must still expose authRequestId');
    assert.match(body, /stateHint\s*:\s*string/, 'AuthorizationUrlPayload must still expose stateHint');
  });

  it('Settings UI does not reference payload.url (defensive — payload no longer has it)', async () => {
    // PR-CLAUDE-CARD-MOVE-0: scan both surfaces since the OAuth UI
    // is now split between SettingsModal (login modal for the 3
    // other providers) and ProvidersPanel (full Claude card).
    const [settings, providers] = await Promise.all([
      readFile(SETTINGS_SOURCE, 'utf8'),
      readFile(PROVIDERS_PANEL_SOURCE, 'utf8'),
    ]);
    for (const src of [settings, providers]) {
      assert.doesNotMatch(
        src,
        /payload\.url\b/,
        'Settings UI must not read payload.url — the field is gone',
      );
    }
  });

  it('Settings subscription copy avoids generic unavailable wording', async () => {
    // PR-CLAUDE-CARD-MOVE-0: the Claude-specific copy lives in
    // ProvidersPanel now; SettingsModal only contains the modal
    // for Codex/Cursor/Antigravity.
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    assert.match(src, /无法开始登录/, 'authorization failure toast should describe the concrete failed action');
    assert.match(src, /等待获取配额/, 'quota_unavailable state should read as a refreshable account state');
    assert.doesNotMatch(
      src,
      /登录暂不可用|配额暂不可用|配额接口暂时无法访问/,
      'subscription account copy should avoid generic unavailable/demo-stage wording',
    );
  });

  it('service getAuthorizationUrl return statement does not include url key', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    // Find the getAuthorizationUrl method and check the return
    // expression's keys. The method must return only
    // { stateHint, authRequestId }; a `url` key would put the URL
    // back into the IPC payload.
    const start = src.indexOf('async getAuthorizationUrl');
    assert.notEqual(start, -1, 'getAuthorizationUrl method must exist');
    const end = src.indexOf('async openAuthorizationUrl', start);
    assert.notEqual(end, -1, 'openAuthorizationUrl must follow getAuthorizationUrl');
    const slice = src.slice(start, end);
    // Look for a `return { ...url... }` pattern. The pending map
    // assignment with `url,` shorthand is fine; only the RETURN
    // statement matters.
    const returnMatch = slice.match(/return\s*\{[^}]*\}/);
    assert.ok(returnMatch, 'getAuthorizationUrl must have a return statement with object literal');
    assert.doesNotMatch(
      returnMatch[0]!,
      /\burl\b/,
      'getAuthorizationUrl return statement must NOT include url — pending.url stays in the service',
    );
  });

  it('ProvidersPanel keeps OAuth login out of CATALOG_PROVIDER_TYPES but surfaces it as a real tab', async () => {
    const [src, core] = await Promise.all([
      readFile(PROVIDERS_PANEL_SOURCE, 'utf8'),
      readFile(resolve(REPO_ROOT, 'packages', 'core', 'src', 'llm-connections.ts'), 'utf8'),
    ]);
    const catalogMatch = core.match(/export const CATALOG_PROVIDER_TYPES: ProviderType\[] = \[([\s\S]*?)\];/);
    assert.ok(catalogMatch, 'CATALOG_PROVIDER_TYPES must exist');
    const catalogBody = catalogMatch[1]!;
    for (const provider of ['claude-subscription', 'codex-subscription', 'gemini-cli']) {
      assert.doesNotMatch(
        catalogBody,
        new RegExp(`'${provider}'`),
        `${provider} must stay out of the visible model provider catalog until its send path is actually open`,
      );
    }
    assert.match(src, /\{\s*id:\s*'oauth'[\s\S]*label:\s*'OAuth'/, 'model provider catalog must show OAuth as a peer tab');
    assert.match(
      src,
      /catalogTab === 'oauth'\s*\?\s*\(\s*<ModelOAuthSection\s+onConnectionsChanged=\{reload\}\s*\/>/,
      'OAuth tab must render the real login cards, not an empty roadmap tile',
    );
    assert.doesNotMatch(
      src,
      /即将支持的 OAuth 订阅登录/,
      'provider header must not advertise future OAuth subscription login as a visible model-provider affordance',
    );
  });
});

describe('Claude OAuth authorize URL compatibility', () => {
  it('uses the Alma / upstream shape: code=true and state equals PKCE verifier', async () => {
    const [service, core] = await Promise.all([
      readFile(SERVICE_SOURCE, 'utf8'),
      readFile(CORE_TYPES_SOURCE, 'utf8'),
    ]);
    assert.match(
      core,
      /url\.searchParams\.set\('code',\s*'true'\)/,
      'Claude authorize URL must include code=true like Alma / Claude Code',
    );
    assert.match(
      service,
      /const verifier = base64urlEncode\(randomBytes\(PKCE_VERIFIER_LENGTH_BYTES\)\);\s*[\s\S]*?const state = verifier;/,
      'Claude authorize state must equal the PKCE verifier; Anthropic rejects the shorter unrelated state with Invalid request format',
    );
  });
});

describe('Claude OAuth model connection bridge', () => {
  it('main syncs successful Claude OAuth login into the model connection list', async () => {
    const src = await readFile(MAIN_SOURCE, 'utf8');
    assert.match(
      src,
      /async function syncClaudeSubscriptionConnection\(\)/,
      'main.ts must have a single sync helper that turns Claude OAuth account state into a model connection',
    );
    assert.match(
      src,
      /slug:\s*CLAUDE_SUBSCRIPTION_CONNECTION_SLUG[\s\S]*providerType:\s*'claude-subscription'[\s\S]*enabled:\s*true[\s\S]*lastTestStatus:\s*'verified'/,
      'sync helper must upsert an enabled claude-subscription connection after login',
    );

    const completeIdx = src.indexOf("claude-subscription:complete-authorization");
    assert.notEqual(completeIdx, -1, 'complete-authorization handler must exist');
    const completeRegion = src.slice(completeIdx, completeIdx + 1200);
    assert.match(completeRegion, /if\s*\(\s*result\.ok\s*\)\s*\{[\s\S]*await syncClaudeSubscriptionConnection\(\);[\s\S]*emitConnectionListChanged\(\);/, 'successful OAuth completion must sync the connection and notify renderer');

    const listIdx = src.indexOf("connections:list");
    assert.notEqual(listIdx, -1, 'connections:list handler must exist');
    const listRegion = src.slice(listIdx, listIdx + 500);
    assert.match(listRegion, /await syncOAuthModelConnections\(\);[\s\S]*return connectionStore\.list\(\)/, 'connection list reads must materialize logged-in OAuth model connections');
  });

  it('OAuth model connection sync is per-provider fail-soft', async () => {
    const src = await readFile(MAIN_SOURCE, 'utf8');
    const syncMatch = src.match(/async function syncOAuthModelConnections\(\): Promise<void> \{[\s\S]*?\n\}/);
    assert.ok(syncMatch, 'syncOAuthModelConnections helper must exist');
    assert.match(
      syncMatch[0],
      /Promise\.allSettled\(\[[\s\S]*syncClaudeSubscriptionConnection\(\),[\s\S]*syncCodexSubscriptionConnection\(\),[\s\S]*\]\)/,
      'one OAuth provider state failure must not reject the whole model connection list read',
    );
    assert.doesNotMatch(
      syncMatch[0],
      /Promise\.all\(\[/,
      'OAuth sync must not use Promise.all because a broken Codex token file can block Claude from appearing in enabled models',
    );
  });

  it('model connection IPC resolves Claude OAuth token from the subscription service, not credentialStore api_key', async () => {
    const src = await readFile(MAIN_SOURCE, 'utf8');
    assert.match(
      src,
      /async function resolveConnectionSecret\(slug:\s*string\)[\s\S]*providerType === 'claude-subscription'[\s\S]*claudeSubscription\.getAccessTokenInternal\(\)/,
      'resolveConnectionSecret must map claude-subscription to its stored OAuth access token',
    );
    assert.match(src, /connections:test[\s\S]*const apiKey = await resolveConnectionSecret\(slug\)/, 'connections:test must use resolveConnectionSecret');
    assert.match(src, /connections:fetchModels[\s\S]*const apiKey = await resolveConnectionSecret\(slug\)/, 'connections:fetchModels must use resolveConnectionSecret');
    assert.match(src, /connections:hasSecret[\s\S]*Boolean\(await resolveConnectionSecret\(slug\)\)/, 'connections:hasSecret must report OAuth login presence for claude-subscription');
    assert.match(src, /getApiKey:\s*\(slug:\s*string\)\s*=>\s*resolveConnectionSecret\(slug\)/, 'chat send readiness must use OAuth tokens through resolveConnectionSecret');
  });

  it('model connection IPC does not accept custom baseUrl overrides for OAuth-token providers', async () => {
    const src = await readFile(MAIN_SOURCE, 'utf8');
    assert.match(
      src,
      /function normalizeCreateConnectionInput\(input:\s*CreateConnectionInput\):\s*CreateConnectionInput[\s\S]*defaults\.authKind === 'oauth_token'[\s\S]*baseUrl:\s*defaults\.baseUrl/,
      'create must force OAuth connections back to their provider default baseUrl',
    );
    assert.match(
      src,
      /async function normalizeUpdateConnectionInput\([\s\S]*Promise<UpdateConnectionInput>[\s\S]*PROVIDER_DEFAULTS\[providerType\]\.authKind === 'oauth_token'[\s\S]*baseUrl:\s*PROVIDER_DEFAULTS\[providerType\]\.baseUrl/,
      'update must force existing OAuth connections back to their provider default baseUrl',
    );
    assert.match(
      src,
      /const normalizedInput = normalizeCreateConnectionInput\(input\)/,
      'connections:create must use the provider-aware baseUrl normalizer',
    );
    assert.match(
      src,
      /const normalizedPatch = await normalizeUpdateConnectionInput\(slug,\s*patch\)/,
      'connections:update must use the provider-aware baseUrl normalizer',
    );
  });

  it('main syncs successful Codex OAuth login into the model connection list', async () => {
    const src = await readFile(MAIN_SOURCE, 'utf8');
    assert.match(
      src,
      /async function syncCodexSubscriptionConnection\(\)/,
      'main.ts must turn Codex OAuth account state into a model connection',
    );
    assert.match(
      src,
      /slug:\s*CODEX_SUBSCRIPTION_CONNECTION_SLUG[\s\S]*providerType:\s*'codex-subscription'[\s\S]*enabled:\s*true[\s\S]*lastTestStatus:\s*'verified'/,
      'sync helper must upsert an enabled codex-subscription connection after login',
    );
    assert.match(
      src,
      /normalizeCodexSubscriptionModels\(existing\?\.models, fallbackModels\)/,
      'Codex OAuth sync must migrate stale unsupported model lists',
    );
    assert.match(
      src,
      /normalizeCodexSubscriptionDefaultModel\([\s\S]*existing\?\.defaultModel[\s\S]*defaults\.fallbackModels\[0\]/,
      'Codex OAuth sync must migrate stale unsupported default models',
    );
    assert.match(
      src,
      /CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS\.has\(existingDefaultModel\)/,
      'Codex OAuth migration must explicitly reject ChatGPT-account-unsupported model ids',
    );
    const completeIdx = src.indexOf("codex-subscription:complete-authorization");
    assert.notEqual(completeIdx, -1, 'codex complete-authorization handler must exist');
    const completeRegion = src.slice(completeIdx, completeIdx + 1200);
    assert.match(
      completeRegion,
      /if\s*\(\s*result\.ok\s*\)\s*\{[\s\S]*await syncCodexSubscriptionConnection\(\);[\s\S]*emitConnectionListChanged\(\);/,
      'successful Codex OAuth completion must sync the connection and notify renderer',
    );
    assert.match(
      src,
      /providerType === 'codex-subscription'[\s\S]*codexSubscription\.getAccessTokenInternal\(\)/,
      'resolveConnectionSecret must let the Codex OAuth service apply its normal refresh policy before handing the access token to the send path',
    );
  });

  it('ProvidersPanel treats OAuth model connections as login state, not editable API keys', async () => {
    const src = await readFile(PROVIDERS_PANEL_SOURCE, 'utf8');
    assert.match(src, /const needsApiKey = defaults\.authKind === 'api_key'/, 'ConnectionDetail must distinguish API key providers');
    assert.match(src, /const needsOAuth = defaults\.authKind === 'oauth_token'/, 'ConnectionDetail must distinguish OAuth providers');
    assert.match(src, /\{needsApiKey && \([\s\S]*<PasswordInput/, 'PasswordInput must only render for API-key connections');
    assert.match(src, /\{needsOAuth && \([\s\S]*OAuth 已登录[\s\S]*等待 OAuth 登录/, 'OAuth connections must render login-state copy instead of a token input');
  });
});
