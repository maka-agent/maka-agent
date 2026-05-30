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
    const src = await readFile(SETTINGS_SOURCE, 'utf8');
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
    const src = await readFile(SETTINGS_SOURCE, 'utf8');
    assert.doesNotMatch(
      src,
      /payload\.url\b/,
      'Settings UI must not read payload.url — the field is gone',
    );
  });

  it('Settings subscription copy avoids generic unavailable wording', async () => {
    const src = await readFile(SETTINGS_SOURCE, 'utf8');
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

  it('ProvidersPanel does not surface OAuth subscription roadmap tiles in the model catalog', async () => {
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
    assert.doesNotMatch(src, /\{\s*id:\s*'oauth'/, 'model provider catalog must not show an empty OAuth tab');
    assert.doesNotMatch(
      src,
      /即将支持的 OAuth 订阅登录/,
      'provider header must not advertise future OAuth subscription login as a visible model-provider affordance',
    );
  });
});
