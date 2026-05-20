import { parseProxyConfig } from './proxy-parser.js';
import { buildProxyDispatcher } from './proxy-dispatcher.js';
import type {
  ProxySettings,
  TestProxyInput,
  TestProxyResult,
} from '@maka/core/settings/network-settings';

const DEFAULT_PROBE_URL = 'https://icanhazip.com';
const DEFAULT_TIMEOUT_MS = 8_000;

export async function testProxyConnection(
  input: TestProxyInput = {},
  storedProxy?: ProxySettings,
): Promise<TestProxyResult> {
  const proxy = parseProxyConfig(input.proxy ?? storedProxy);
  const probeUrl = input.url ?? DEFAULT_PROBE_URL;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!proxy.enabled) return { ok: false, latencyMs: 0, error: 'Proxy disabled' };
  if (!proxy.host || !proxy.port) return { ok: false, latencyMs: 0, error: 'Proxy host/port required' };

  const dispatcher = buildProxyDispatcher(proxy);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Proxy test timeout')), timeoutMs);
  const startedAt = Date.now();

  try {
    // @ts-expect-error undici fetch accepts dispatcher.
    const response = await fetch(probeUrl, { dispatcher, signal: controller.signal });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) return { ok: false, status: response.status, latencyMs, error: `HTTP ${response.status}` };

    const ip = (await response.text()).trim() || undefined;
    const countryCode = ip ? await lookupCountry(ip, dispatcher, controller.signal) : undefined;
    const countryFlag = countryCode && countryCode.length === 2
      ? String.fromCodePoint(...countryCode.toUpperCase().split('').map((char) => 127_397 + char.charCodeAt(0)))
      : undefined;

    return { ok: true, status: response.status, latencyMs, ip, countryCode, countryFlag };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    const close = (dispatcher as { close?: () => Promise<void> }).close;
    if (typeof close === 'function') await close.call(dispatcher).catch(() => {});
  }
}

async function lookupCountry(
  ip: string,
  dispatcher: unknown,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    // @ts-expect-error undici fetch accepts dispatcher.
    const response = await fetch(`https://api.country.is/${encodeURIComponent(ip)}`, { dispatcher, signal });
    if (!response.ok) return undefined;
    const json = (await response.json()) as { country?: string };
    return json.country;
  } catch {
    return undefined;
  }
}
