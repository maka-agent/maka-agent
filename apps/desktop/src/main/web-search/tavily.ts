/**
 * PR-WEB-SEARCH-TAVILY-0 — Tavily HTTP client. Lives in main process
 * only; renderer never imports this file or sees the API key.
 *
 * The IPC handler is the only caller. We do not retry, do not cache,
 * and do not log the query / response. Errors map to the closed
 * `WebSearchErrorReason` set so the renderer can pick a generalized
 * Chinese copy without ever reading provider body bytes.
 */

import {
  WEB_SEARCH_DEFAULT_LIMIT,
  WEB_SEARCH_MAX_LIMIT,
  normalizeWebSearchLimit,
  type WebSearchResponse,
  type WebSearchResultRow,
} from '@maka/core';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const TAVILY_TIMEOUT_MS = 10_000;

interface TavilyRawResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

interface TavilyRawResponse {
  results?: unknown;
}

function safeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function mapTavilyRows(raw: unknown, limit: number): WebSearchResultRow[] {
  if (!raw || typeof raw !== 'object') return [];
  const arr = (raw as TavilyRawResponse).results;
  if (!Array.isArray(arr)) return [];
  const rows: WebSearchResultRow[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const row = item as TavilyRawResult;
    const url = safeString(row.url);
    if (!url.startsWith('http://') && !url.startsWith('https://')) continue;
    const title = safeString(row.title, url);
    const snippet = safeString(row.content);
    rows.push({
      provider: 'tavily',
      title: title.slice(0, 240),
      url,
      snippet: snippet.slice(0, 400),
      source: hostnameOf(url),
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

export interface QueryTavilyInput {
  apiKey: string;
  query: string;
  limit: number;
}

/**
 * Calls Tavily and returns a `WebSearchResponse`. Pure failure mapping —
 * no exceptions thrown to the IPC handler. Network errors / timeouts
 * collapse to `network_error` / `timeout`; HTTP 401 collapses to
 * `invalid_credentials`; HTTP 429 collapses to `rate_limited`.
 */
export async function queryTavily(input: QueryTavilyInput): Promise<WebSearchResponse> {
  const trimmedKey = input.apiKey.trim();
  if (trimmedKey.length === 0) {
    return { ok: false, reason: 'not_configured', message: '等待配置 Tavily API key 后启用联网搜索。' };
  }
  const limit = Math.min(WEB_SEARCH_MAX_LIMIT, normalizeWebSearchLimit(input.limit));
  const body = JSON.stringify({
    api_key: trimmedKey,
    query: input.query,
    max_results: limit,
    search_depth: 'basic',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS);
  try {
    const response = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason: 'invalid_credentials',
        message: 'Tavily 拒绝了当前 API key。请检查后重试。',
      };
    }
    if (response.status === 429) {
      return {
        ok: false,
        reason: 'rate_limited',
        message: 'Tavily 返回限流，请稍后再试。',
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: 'network_error',
        message: `Tavily 返回 HTTP ${response.status}。`,
      };
    }
    const json = (await response.json()) as unknown;
    const rows = mapTavilyRows(json, limit);
    return { ok: true, results: rows };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        ok: false,
        reason: 'timeout',
        message: `Tavily 请求超过 ${Math.round(TAVILY_TIMEOUT_MS / 1000)}s 未返回。`,
      };
    }
    return {
      ok: false,
      reason: 'network_error',
      message: '联网搜索请求失败，请检查网络后重试。',
    };
  } finally {
    clearTimeout(timer);
  }
}

export const TAVILY_TEST_QUERY = 'maka ai assistant';
export const TAVILY_TEST_LIMIT = WEB_SEARCH_DEFAULT_LIMIT;
