import { fetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici';
import { matchesBypassList } from '../network/bypass-matcher.js';
import { buildProxyDispatcher } from '../network/proxy-dispatcher.js';
import { resolveActiveProxy } from '../network/active-proxy-state.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export type ProxiedFetchInit = UndiciRequestInit & {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export async function proxiedFetch(url: string, init: ProxiedFetchInit = {}): Promise<Response> {
  const proxy = resolveActiveProxy();
  let dispatcher: Dispatcher | undefined;
  if (proxy && !matchesBypassList(new URL(url).hostname, proxy.bypassList)) {
    dispatcher = buildProxyDispatcher(proxy) as Dispatcher;
  }
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...fetchInit } = init;
  const timeoutEnabled = timeoutMs > 0;
  const controller = new AbortController();
  let timedOut = false;

  const disposeDispatcher = async (force = false) => {
    const disposable = dispatcher as
      | {
          close?: () => Promise<void>;
          destroy?: (error?: Error) => void | Promise<void>;
        }
      | undefined;
    if (!disposable) return;
    if (force && typeof disposable.destroy === 'function') {
      await Promise.resolve(disposable.destroy.call(dispatcher, new Error('Fetch timeout'))).catch(
        () => {},
      );
      return;
    }
    if (typeof disposable.close === 'function')
      await disposable.close.call(dispatcher).catch(() => {});
  };

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = timeoutEnabled
    ? new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error('Fetch timeout'));
          void disposeDispatcher(true);
          reject(new Error('Fetch timeout'));
        }, timeoutMs);
        controller.signal.addEventListener(
          'abort',
          () => {
            if (timer) clearTimeout(timer);
          },
          { once: true },
        );
      })
    : undefined;

  try {
    const request = fetch(url, { ...fetchInit, dispatcher, signal: controller.signal }).catch(
      (error) => {
        if (timedOut) return new Promise<never>(() => {});
        throw error;
      },
    );
    return timeout
      ? ((await Promise.race([request, timeout])) as unknown as Response)
      : ((await request) as unknown as Response);
  } finally {
    if (timer) clearTimeout(timer);
    await disposeDispatcher(timedOut);
  }
}
