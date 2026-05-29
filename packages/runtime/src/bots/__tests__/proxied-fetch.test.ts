import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PROXY_DEFAULTS } from '@maka/core/settings/network-settings';
import { setActiveProxy } from '../../network/active-proxy-state.js';
import { proxiedFetch } from '../proxied-fetch.js';

describe('proxiedFetch', () => {
  test('times out and destroys stuck active proxy dispatchers', async () => {
    setActiveProxy({
      ...PROXY_DEFAULTS,
      enabled: true,
      type: 'http',
      host: 'abc.invalid',
      port: 1,
    });
    const started = Date.now();

    try {
      await assert.rejects(
        () => proxiedFetch('http://example.com', { timeoutMs: 100 }),
        /timeout/i,
      );
      assert.ok(Date.now() - started < 2_000);
    } finally {
      setActiveProxy(null);
    }
  });

  test('timeoutMs 0 disables the internal timeout for streaming callers', async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }, 40);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    try {
      const response = await proxiedFetch(`http://127.0.0.1:${address.port}`, { timeoutMs: 0 });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'ok');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
