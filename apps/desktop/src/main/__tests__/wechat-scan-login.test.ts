import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { fetchWeChatQrcode, pollWeChatQrcodeStatus } from '../wechat-scan-login.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('wechat-scan-login abort signal (PR1197 review P2-10)', () => {
  test('fetchWeChatQrcode composes the caller signal so cancel aborts the in-flight request', async () => {
    let captured: AbortSignal | undefined;
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => {
      captured = init?.signal;
      return new Promise((_resolve, reject) => {
        captured?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }) as typeof fetch;

    const controller = new AbortController();
    const pending = fetchWeChatQrcode(controller.signal);
    controller.abort();
    await assert.rejects(() => pending);
    assert.equal(captured?.aborted, true, 'the caller signal must be threaded into the request');
  });

  test('pollWeChatQrcodeStatus composes the caller signal into the request', async () => {
    let captured: AbortSignal | undefined;
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) => {
      captured = init?.signal;
      return new Promise((_resolve, reject) => {
        captured?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }) as typeof fetch;

    const controller = new AbortController();
    const pending = pollWeChatQrcodeStatus('token-123', controller.signal);
    controller.abort();
    await assert.rejects(() => pending);
    assert.equal(captured?.aborted, true, 'the caller signal must be threaded into the request');
  });
});
