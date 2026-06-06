/**
 * Static-analysis gate: cloak module isolation.
 *
 * xuan `2c5aa125` G-X4: the cloak header logic MUST live in a
 * separate module AND MUST NOT be statically imported by the
 * default Claude subscription request path.
 *
 * This test scans source files; it does not execute the cloak path.
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
const CLOAK_SOURCE = resolve(
  REPO_ROOT,
  'apps',
  'desktop',
  'src',
  'main',
  'oauth',
  'cloaked-request.ts',
);
const MAIN_SOURCE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'main.ts');

describe('cloaked request module isolation (xuan G-X4)', () => {
  it('cloak module exists at the canonical path', async () => {
    const src = await readFile(CLOAK_SOURCE, 'utf8');
    assert.ok(
      src.includes('buildCloakedRequest'),
      'cloaked-request.ts must export buildCloakedRequest',
    );
  });

  it('subscription service does NOT statically import the cloak module', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    // Allow comment mentions (e.g. "cloaked-request.ts" in a
    // docstring justification), forbid static `import ... from
    // './cloaked-request'`. The forbidden pattern is the literal
    // import statement.
    assert.doesNotMatch(
      src,
      /^\s*import\s+[^;]+from\s+['"]\.\/cloaked-request[^'"]*['"]/m,
      'claude-subscription-service.ts must NOT statically import ./cloaked-request — load dynamically inside the env-gated branch',
    );
  });

  it('cloak module body contains the impersonation strings (positive sanity check)', async () => {
    // If a future patch removed these by accident, the cloak module
    // would silently degrade to a no-op. Confirm the headers are
    // actually built here.
    const src = await readFile(CLOAK_SOURCE, 'utf8');
    assert.match(src, /claude-cli\//, 'cloak module must build the Claude Code UA');
    assert.match(src, /X-Stainless-/, 'cloak module must build Stainless headers');
    assert.match(src, /You are Claude Code/, 'cloak module must inject the Claude Code system prefix');
    // PR-CLAUDE-OAUTH-RUNTIME-VERSION-PIN-0: pin the Runtime-Version
    // to the alma value so a future revert to process.version stays
    // out — Anthropic's gateway may allowlist this string.
    assert.match(
      src,
      /'X-Stainless-Runtime-Version':\s*'v22\.13\.0'/,
      "cloak must hardcode X-Stainless-Runtime-Version to alma's pinned v22.13.0 (readable/main.js:16026)",
    );
    assert.doesNotMatch(
      src,
      /'X-Stainless-Runtime-Version':\s*process\.version/,
      'cloak must NOT use dynamic process.version — gateway allowlist parity with alma',
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
    // dynamic-import the cloak module.
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /MAKA_CLAUDE_SUBSCRIPTION_CLOAK[\s\S]*!==\s*'0'/,
      'service must reference MAKA_CLAUDE_SUBSCRIPTION_CLOAK env flag (xuan G-X4 isolation)',
    );
  });

  it('main wires Claude OAuth sends through the dynamic cloak fetch wrapper by default', async () => {
    const src = await readFile(MAIN_SOURCE, 'utf8');
    assert.match(src, /buildSubscriptionModelFetch\(connection,\s*ctx\.sessionId,\s*model\)/);
    assert.match(src, /isCloakEnabled\(\)[\s\S]*buildClaudeSubscriptionCloakedFetch\(sessionId,\s*modelId\)/);
    assert.match(src, /modelFactory:\s*\(input\)\s*=>\s*getAIModel\(\{\s*\.\.\.input,\s*fetch:\s*modelFetch\s*\}\)/);
    assert.match(src, /import\('\.\/oauth\/cloaked-request\.js'\)/, 'cloak module must be dynamically imported from the send path');
    assert.match(src, /buildCloakedRequest\(\{[\s\S]*deviceId[\s\S]*accountUuid[\s\S]*sessionId/, 'cloak wrapper must stamp Claude Code identity metadata');
    // PR-CLAUDE-OAUTH-XAPIKEY-STRIP-0: alma (`readable/main.js:16521`)
    // explicitly deletes the x-api-key header from the outbound
    // Claude OAuth send so that only `Authorization: Bearer <token>`
    // is presented. AI SDK's Anthropic provider adds an empty
    // x-api-key when `apiKey` isn't set; Anthropic's OAuth endpoint
    // rejects requests that present both an empty x-api-key AND a
    // Bearer header (user-visible as `鉴权失败` / 401-403). Match the
    // alma reference exactly.
    assert.match(src, /headers\.delete\(['"]x-api-key['"]\)/, 'cloak fetch must strip x-api-key to match alma OAuth send (readable/main.js:16521)');
  });

  it('main maps Codex OAuth system prompt into ChatGPT backend instructions', async () => {
    const src = await readFile(MAIN_SOURCE, 'utf8');
    assert.match(src, /providerType === 'codex-subscription'[\s\S]*buildCodexSubscriptionFetch\(sessionId\)/);
    assert.match(
      src,
      /instructions:\s*codexInstructionsFromBody\(parsedBody\)/,
      'Codex OAuth backend rejects requests without top-level instructions',
    );
    assert.match(src, /function codexInstructionsFromBody\(body:\s*Record<string,\s*unknown>\):\s*string/);
    assert.match(src, /typeof body\.system === 'string'/, 'Codex instructions must inherit the AI SDK system prompt when present');
    assert.match(src, /record\.role !== 'system'/, 'Codex instructions must also recover system input items defensively');
    assert.match(src, /You are Maka, a helpful AI assistant\./, 'Codex instructions must have a non-empty fallback');
  });

  it('token exchange uses the pasted OAuth state and can recover the verifier from Claude Code state', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /const parsed = parsePastedAuthorization\(rawPasted\);[\s\S]*?const pending = this\.pending\.get\(authRequestId\)/,
      'completeAuthorization must parse the pasted code#state before treating missing pending state as fatal',
    );
    assert.match(
      src,
      /const recoverFromPastedState = !pending \|\| pendingExpired;/,
      'Claude Code state is the PKCE verifier, so Maka must recover from a lost in-memory pending map',
    );
    assert.match(
      src,
      /const verifier = recoverFromPastedState \? parsed\.state : pending!\.verifier;/,
      'recovered Claude OAuth attempts must use pasted state as code_verifier',
    );
    assert.match(
      src,
      /exchangeCodeForTokens\(parsed\.code,\s*verifier,\s*parsed\.state\)/,
      'completeAuthorization must pass the user-pasted state into token exchange after validating it',
    );
    assert.doesNotMatch(
      src,
      /state:\s*verifier/,
      'token exchange body must not send the PKCE verifier as OAuth state when state and verifier are distinct',
    );
  });

  it('token exchange failures do not consume pending authorization or collapse into generic auth copy', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    const completeStart = src.indexOf('async completeAuthorization(');
    assert.ok(completeStart > 0, 'completeAuthorization must exist');
    const completeRegion = src.slice(completeStart, completeStart + 2600);
    const exchangeIdx = completeRegion.indexOf('exchangeCodeForTokens(parsed.code, verifier, parsed.state)');
    const deleteIdx = completeRegion.indexOf('this.pending.delete(authRequestId)', exchangeIdx);
    assert.ok(exchangeIdx > 0 && deleteIdx > exchangeIdx, 'pending authorization should be consumed only after token exchange succeeds');
    assert.match(
      completeRegion,
      /failureFromError\('token_exchange_failed', err, '授权码已过期、已使用或与本次登录不匹配，请重新点击“登录订阅”获取新的授权码。'\)/,
      'token exchange failures should tell the user to get a fresh authorization code, not surface generic 鉴权失败',
    );
    assert.match(
      src,
      /class ClaudeTokenExchangeError extends Error[\s\S]*readonly status: number/,
      'token endpoint non-2xx responses should be typed before mapping to user copy',
    );
  });

  it('OAuth token endpoint UA matches the claude-cli/X.Y.Z shape Anthropic accepts (PR-CLAUDE-CARD-MOVE-0)', async () => {
    // WAWQAQ msg a62a4c1c reported "Authorization failed / Invalid
    // request format" after login. Root cause was that the OAuth
    // token endpoint (https://console.anthropic.com/v1/oauth/token)
    // rejected our `maka-desktop/0.1.0 (oauth-subscription)` UA. The
    // alma reference at main.js:15919 + 16143 sends
    // `claude-cli/X.Y.Z (external, cli)`. This is distinct from the
    // SEND-PATH cloak UA tested above; OAuth must use this UA
    // unconditionally for the endpoint to accept the request.
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /OAUTH_USER_AGENT\s*=\s*`claude-cli\/\$\{CLAUDE_SUBSCRIPTION_PRODUCT_VERSION\}\s+\(external,\s*cli\)`/,
      'OAuth UA constant must match claude-cli/X.Y.Z (external, cli) shape',
    );
    assert.doesNotMatch(
      src,
      /'maka-desktop\/[^']*\(oauth-subscription\)'/,
      'OAuth UA must NOT advertise maka-desktop — Anthropic rejects non-claude-cli UAs',
    );
    // Every OAuth-related fetch (token exchange, refresh, usage,
    // profile) must reference the OAUTH_USER_AGENT constant, not
    // any inline literal.
    const uaUses = src.match(/'User-Agent':\s*\w+/g) ?? [];
    assert.ok(uaUses.length >= 4,
      `expected at least 4 OAuth fetches to set User-Agent (token / refresh / usage / profile), got ${uaUses.length}`);
    for (const u of uaUses) {
      assert.match(u, /OAUTH_USER_AGENT/, `${u} must reference the OAUTH_USER_AGENT constant`);
    }
  });

  it('token storage fails closed when safeStorage encryption is unavailable', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /safeStorage\.isEncryptionAvailable\(\)\)\s*\{\s*throw new Error\('safeStorage encryption is unavailable\.'\);/s,
      'saveTokens must fail closed instead of writing plaintext when safeStorage is unavailable',
    );
    assert.doesNotMatch(
      src,
      /Buffer\.from\(serialized,\s*['"]utf8['"]\)/,
      'token persistence must not fall back to plaintext Buffer.from(serialized)',
    );
  });
});
