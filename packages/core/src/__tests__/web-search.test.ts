import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  MASKED_TOKEN_SENTINEL,
  WEB_SEARCH_DEFAULT_LIMIT,
  WEB_SEARCH_CREDENTIAL_SOURCES,
  WEB_SEARCH_MAX_LIMIT,
  WEB_SEARCH_QUERY_MAX_CHARS,
  WEB_SEARCH_PROVIDERS,
  defaultWebSearchSettings,
  isWebSearchCredentialStatus,
  isWebSearchCredentialSource,
  isWebSearchProvider,
  maskedTokenForDisplay,
  mergeWebSearchSettings,
  normalizeWebSearchLimit,
  normalizeWebSearchQuery,
  normalizeWebSearchSettings,
  reconcileMaskedToken,
  webSearchCredentialStatusFromResponse,
  webSearchCredentialSourceFromStoredKey,
} from '../web-search.js';

describe('normalizeWebSearchQuery', () => {
  it('trims and accepts a typical query', () => {
    assert.equal(normalizeWebSearchQuery('  hello world  '), 'hello world');
  });

  it('rejects empty / whitespace-only / non-string', () => {
    assert.equal(normalizeWebSearchQuery(''), null);
    assert.equal(normalizeWebSearchQuery('   '), null);
    assert.equal(normalizeWebSearchQuery(undefined), null);
    assert.equal(normalizeWebSearchQuery(123), null);
    assert.equal(normalizeWebSearchQuery({}), null);
  });

  it('truncates to the hard cap', () => {
    const long = 'a'.repeat(WEB_SEARCH_QUERY_MAX_CHARS + 100);
    const out = normalizeWebSearchQuery(long);
    assert.ok(out);
    assert.equal(out!.length, WEB_SEARCH_QUERY_MAX_CHARS);
  });
});

describe('normalizeWebSearchLimit', () => {
  it('returns default for non-finite / non-number input', () => {
    assert.equal(normalizeWebSearchLimit(undefined), WEB_SEARCH_DEFAULT_LIMIT);
    assert.equal(normalizeWebSearchLimit(NaN), WEB_SEARCH_DEFAULT_LIMIT);
    assert.equal(normalizeWebSearchLimit('5' as unknown), WEB_SEARCH_DEFAULT_LIMIT);
  });

  it('clamps below 1 to 1 and above max to max', () => {
    assert.equal(normalizeWebSearchLimit(-3), 1);
    assert.equal(normalizeWebSearchLimit(0), 1);
    assert.equal(normalizeWebSearchLimit(WEB_SEARCH_MAX_LIMIT + 99), WEB_SEARCH_MAX_LIMIT);
  });

  it('truncates fractional values', () => {
    assert.equal(normalizeWebSearchLimit(3.7), 3);
  });
});

describe('isWebSearchProvider', () => {
  it('accepts every member of WEB_SEARCH_PROVIDERS', () => {
    for (const p of WEB_SEARCH_PROVIDERS) {
      assert.equal(isWebSearchProvider(p), true);
    }
  });

  it('rejects unknown providers', () => {
    assert.equal(isWebSearchProvider('google'), false);
    assert.equal(isWebSearchProvider(''), false);
    assert.equal(isWebSearchProvider(undefined), false);
  });
});

describe('reconcileMaskedToken', () => {
  it('preserves persisted when candidate is the mask sentinel', () => {
    assert.equal(reconcileMaskedToken('secret-key', MASKED_TOKEN_SENTINEL), 'secret-key');
  });

  it('overwrites persisted when candidate is a real new value', () => {
    assert.equal(reconcileMaskedToken('old', 'new-token'), 'new-token');
  });

  it('clears persisted when candidate is the empty string', () => {
    // Empty string is an explicit clear, not "keep current".
    assert.equal(reconcileMaskedToken('old', ''), '');
  });
});

describe('maskedTokenForDisplay', () => {
  it('returns empty for unset key', () => {
    assert.equal(maskedTokenForDisplay(''), '');
  });

  it('returns the sentinel for any non-empty persisted value', () => {
    assert.equal(maskedTokenForDisplay('any'), MASKED_TOKEN_SENTINEL);
    assert.equal(maskedTokenForDisplay('a'.repeat(64)), MASKED_TOKEN_SENTINEL);
  });
});

describe('defaultWebSearchSettings', () => {
  it('starts disabled with tavily as default provider and empty key', () => {
    const s = defaultWebSearchSettings();
    assert.equal(s.enabled, false);
    assert.equal(s.defaultProvider, 'tavily');
    assert.equal(s.providers.tavily.apiKey, '');
    assert.equal(s.providers.tavily.credentialSource, 'none');
    assert.equal(s.providers.tavily.credentialVersion, 0);
    assert.equal(s.providers.tavily.credentialStatus, 'untested');
  });
});

describe('web search settings reconciliation', () => {
  it('preserves credential status and version across a masked key round-trip', () => {
    const current = mergeWebSearchSettings(defaultWebSearchSettings(), {
      providers: {
        tavily: {
          apiKey: 'stored-key',
          credentialStatus: 'valid',
          credentialCheckedAt: '2026-05-29T00:00:00.000Z',
        },
      },
    });

    const patched = mergeWebSearchSettings(current, {
      providers: { tavily: { apiKey: MASKED_TOKEN_SENTINEL } },
    });

    assert.equal(patched.providers.tavily.apiKey, 'stored-key');
    assert.equal(patched.providers.tavily.credentialSource, 'saved');
    assert.equal(patched.providers.tavily.credentialVersion, 1);
    assert.equal(patched.providers.tavily.credentialStatus, 'valid');
    assert.equal(patched.providers.tavily.credentialCheckedAt, '2026-05-29T00:00:00.000Z');
  });

  it('increments the credential version and clears stale status when the saved key changes', () => {
    const current = mergeWebSearchSettings(defaultWebSearchSettings(), {
      providers: {
        tavily: {
          apiKey: 'old-key',
          credentialStatus: 'valid',
          credentialCheckedAt: '2026-05-29T00:00:00.000Z',
        },
      },
    });

    const patched = mergeWebSearchSettings(current, {
      providers: { tavily: { apiKey: 'new-key' } },
    });

    assert.equal(patched.providers.tavily.apiKey, 'new-key');
    assert.equal(patched.providers.tavily.credentialSource, 'saved');
    assert.equal(patched.providers.tavily.credentialVersion, 2);
    assert.equal(patched.providers.tavily.credentialStatus, 'untested');
    assert.equal(patched.providers.tavily.credentialCheckedAt, undefined);
  });

  it('ignores a credential result for an older key version', () => {
    const current = mergeWebSearchSettings(defaultWebSearchSettings(), {
      providers: { tavily: { apiKey: 'current-key' } },
    });
    const updatedKey = mergeWebSearchSettings(current, {
      providers: { tavily: { apiKey: 'newer-key' } },
    });

    const staleResult = mergeWebSearchSettings(updatedKey, {
      providers: {
        tavily: {
          credentialVersion: current.providers.tavily.credentialVersion,
          credentialStatus: 'invalid_credentials',
          credentialCheckedAt: '2026-05-29T00:00:00.000Z',
        },
      },
    });
    const freshResult = mergeWebSearchSettings(updatedKey, {
      providers: {
        tavily: {
          credentialVersion: updatedKey.providers.tavily.credentialVersion,
          credentialStatus: 'valid',
          credentialCheckedAt: '2026-05-29T00:01:00.000Z',
        },
      },
    });

    assert.equal(updatedKey.providers.tavily.credentialVersion, 2);
    assert.equal(staleResult.providers.tavily.credentialStatus, 'untested');
    assert.equal(staleResult.providers.tavily.credentialCheckedAt, undefined);
    assert.equal(freshResult.providers.tavily.credentialStatus, 'valid');
    assert.equal(freshResult.providers.tavily.credentialCheckedAt, '2026-05-29T00:01:00.000Z');
  });

  it('normalizes malformed persisted credential metadata fail-closed', () => {
    const malformed = {
      enabled: 'yes',
      defaultProvider: 'unknown',
      providers: {
        tavily: {
          apiKey: 'x'.repeat(257),
          credentialSource: 'saved',
          credentialVersion: -1,
          credentialStatus: 'unknown',
          credentialCheckedAt: 'x'.repeat(65),
        },
      },
    } as unknown as Parameters<typeof normalizeWebSearchSettings>[0];

    const normalized = normalizeWebSearchSettings(malformed);

    assert.equal(normalized.enabled, false);
    assert.equal(normalized.defaultProvider, 'tavily');
    assert.equal(normalized.providers.tavily.apiKey, '');
    assert.equal(normalized.providers.tavily.credentialSource, 'none');
    assert.equal(normalized.providers.tavily.credentialVersion, 0);
    assert.equal(normalized.providers.tavily.credentialStatus, 'untested');
    assert.equal(normalized.providers.tavily.credentialCheckedAt, undefined);
  });
});

describe('web search credential status helpers', () => {
  it('accepts only the closed credential status enum', () => {
    assert.equal(isWebSearchCredentialStatus('valid'), true);
    assert.equal(isWebSearchCredentialStatus('invalid_credentials'), true);
    assert.equal(isWebSearchCredentialStatus('unsupported_provider'), false);
    assert.equal(isWebSearchCredentialStatus(''), false);
  });

  it('accepts only the closed credential source enum', () => {
    for (const source of WEB_SEARCH_CREDENTIAL_SOURCES) {
      assert.equal(isWebSearchCredentialSource(source), true);
    }
    assert.equal(isWebSearchCredentialSource('anonymous'), false);
    assert.equal(isWebSearchCredentialSource(''), false);
  });

  it('derives renderer-safe credential source from stored key presence', () => {
    assert.equal(webSearchCredentialSourceFromStoredKey(''), 'none');
    assert.equal(webSearchCredentialSourceFromStoredKey('tvly-secret'), 'saved');
  });

  it('maps test responses to persisted credential status without leaking unsupported provider', () => {
    assert.equal(webSearchCredentialStatusFromResponse({ ok: true, results: [] }), 'valid');
    assert.equal(
      webSearchCredentialStatusFromResponse({
        ok: false,
        reason: 'invalid_credentials',
        message: 'bad',
      }),
      'invalid_credentials',
    );
    assert.equal(
      webSearchCredentialStatusFromResponse({
        ok: false,
        reason: 'unsupported_provider',
        message: 'no',
      }),
      'network_error',
    );
  });
});
