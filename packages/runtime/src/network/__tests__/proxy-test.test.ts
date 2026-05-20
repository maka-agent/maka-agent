import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '../../test-helpers.js';
import { PROXY_DEFAULTS } from '@maka/core/settings/network-settings';
import { testProxyConnection } from '../proxy-test.js';

describe('testProxyConnection', () => {
  test('returns disabled error when proxy is disabled', async () => {
    const result = await testProxyConnection({});
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Proxy disabled');
  });

  test('returns missing host/port error when enabled but empty', async () => {
    const result = await testProxyConnection({ proxy: { ...PROXY_DEFAULTS, enabled: true, host: '', port: 0 } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/host.*port/i);
  });

  test('returns an error when the proxy host refuses connections', async () => {
    const result = await testProxyConnection({
      proxy: { ...PROXY_DEFAULTS, enabled: true, type: 'http', host: '127.0.0.1', port: 1 },
      url: 'http://example.com',
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error ?? '').toMatch(/ECONNREFUSED|fetch failed|bad port|timeout/i);
  });

  test('times out invalid proxy hosts deterministically', async () => {
    const started = Date.now();
    const result = await testProxyConnection({
      proxy: { ...PROXY_DEFAULTS, enabled: true, type: 'http', host: 'abc.invalid', port: 1 },
      url: 'http://example.com',
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.error ?? '').toMatch(/timeout/i);
    assert.ok(Date.now() - started < 2_000);
  });
});
