import { fetch as undiciFetch, type Dispatcher } from 'undici';
import type { ProxySettings } from '@maka/core/settings/network-settings';
import { matchesBypassList } from '../network/bypass-matcher.js';
import { buildProxyDispatcher } from '../network/proxy-dispatcher.js';
import { resolveActiveProxy } from '../network/active-proxy-state.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export type ProxiedFetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]> & {
  timeoutMs?: number;
};

export interface ProxiedFetchTransport {
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

export interface ProxiedFetchProxy {
  readonly enabled: boolean;
  readonly type: ProxySettings['type'];
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly bypassList: readonly string[];
}

export function createProxiedFetchTransport(
  proxy: ProxiedFetchProxy | null,
): ProxiedFetchTransport {
  const proxySnapshot: ProxySettings | null = proxy?.enabled
    ? { ...proxy, bypassList: [...proxy.bypassList] }
    : null;
  let dispatcher: Dispatcher | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (closed) throw new Error('Proxied fetch transport is closed');

    const url = input instanceof Request ? input.url : input.toString();
    const useProxy =
      proxySnapshot !== null && !matchesBypassList(new URL(url).hostname, proxySnapshot.bypassList);
    if (useProxy) dispatcher ??= buildProxyDispatcher(proxySnapshot) as Dispatcher;

    return (await undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      {
        ...init,
        dispatcher: useProxy ? dispatcher : undefined,
      } as Parameters<typeof undiciFetch>[1],
    )) as unknown as Response;
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = dispatcher
      ? dispatcher.destroy(new Error('Proxied fetch transport closed')).catch(() => {})
      : Promise.resolve();
    return closePromise;
  };

  return { fetch, close };
}

export async function proxiedFetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init: ProxiedFetchInit = {},
): Promise<Response> {
  const proxy = resolveActiveProxy();
  let dispatcher: Dispatcher | undefined;
  const url = input instanceof Request ? input.url : input.toString();
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
    const request = undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      {
        ...fetchInit,
        dispatcher,
        signal: controller.signal,
      } as Parameters<typeof undiciFetch>[1],
    ).catch((error) => {
      if (timedOut) return new Promise<never>(() => {});
      throw error;
    });
    return timeout
      ? ((await Promise.race([request, timeout])) as unknown as Response)
      : ((await request) as unknown as Response);
  } finally {
    if (timer) clearTimeout(timer);
    await disposeDispatcher(timedOut);
  }
}
