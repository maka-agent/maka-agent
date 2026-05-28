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
  });

  it('subscription service references the env flag MAKA_CLAUDE_SUBSCRIPTION_CLOAK', async () => {
    // The service should expose `isCloakEnabled()` (or otherwise
    // check the env var) so the send-path can decide whether to
    // dynamic-import the cloak module.
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /MAKA_CLAUDE_SUBSCRIPTION_CLOAK/,
      'service must reference MAKA_CLAUDE_SUBSCRIPTION_CLOAK env flag (xuan G-X4 isolation)',
    );
  });

  it('token exchange uses the pasted OAuth state, not the verifier', async () => {
    const src = await readFile(SERVICE_SOURCE, 'utf8');
    assert.match(
      src,
      /exchangeCodeForTokens\(parsed\.code,\s*pending\.verifier,\s*parsed\.state\)/,
      'completeAuthorization must pass the user-pasted state into token exchange after validating it',
    );
    assert.doesNotMatch(
      src,
      /state:\s*verifier/,
      'token exchange body must not send the PKCE verifier as OAuth state when state and verifier are distinct',
    );
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
