import { describe, expect, test } from 'bun:test';
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
});
