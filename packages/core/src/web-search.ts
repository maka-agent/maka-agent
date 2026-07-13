/**
 * Pure WebSearch contracts shared by the explicit UI query and agent-tool
 * paths. One configured provider handles a query; failures are returned as
 * closed reasons rather than silently rotating providers.
 *
 * Main owns credentials, provider calls, and the incognito gate. Renderer
 * results contain normalized title, URL, and snippet fields and never expose
 * cleartext credentials or raw provider errors.
 */

/** Closed enum of providers V0.1 will accept. */
export const WEB_SEARCH_PROVIDERS = ['tavily'] as const;
export type WebSearchProvider = typeof WEB_SEARCH_PROVIDERS[number];

/** Renderer-safe result row. No raw HTML, no provider tag soup. */
export interface WebSearchResultRow {
  readonly provider: WebSearchProvider;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** Hostname extracted from `url` so the renderer doesn't reparse. */
  readonly source: string;
}

export type WebSearchErrorReason =
  | 'invalid_query'
  | 'incognito_active'
  | 'not_configured'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'network_error'
  | 'timeout'
  | 'unsupported_provider'
  | 'experimental_disabled';

/** Discriminated response: success = array, error = typed object. */
export type WebSearchResponse =
  | { readonly ok: true; readonly results: ReadonlyArray<WebSearchResultRow> }
  | { readonly ok: false; readonly reason: WebSearchErrorReason; readonly message: string };

export const WEB_SEARCH_QUERY_MAX_CHARS = 200;
export const WEB_SEARCH_DEFAULT_LIMIT = 5;
export const WEB_SEARCH_MAX_LIMIT = 10;

export const WEB_SEARCH_CREDENTIAL_STATUSES = [
  'untested',
  'valid',
  'invalid_credentials',
  'rate_limited',
  'network_error',
  'timeout',
  'not_configured',
] as const;

export type WebSearchCredentialStatus = typeof WEB_SEARCH_CREDENTIAL_STATUSES[number];

export const WEB_SEARCH_CREDENTIAL_SOURCES = ['none', 'saved', 'env'] as const;
export type WebSearchCredentialSource = typeof WEB_SEARCH_CREDENTIAL_SOURCES[number];

/**
 * Settings-layer placeholder for a stored API key. The renderer may
 * see this when the settings store mirrors back the current value;
 * an update that comes back with exactly this token MUST preserve
 * the existing token instead of overwriting it. Same pattern as the
 * existing bot token / proxy password mask in Maka.
 */
export const MASKED_TOKEN_SENTINEL = '••••••';

/** Returns `null` when the raw value isn't a usable query. */
export function normalizeWebSearchQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > WEB_SEARCH_QUERY_MAX_CHARS) {
    return trimmed.slice(0, WEB_SEARCH_QUERY_MAX_CHARS);
  }
  return trimmed;
}

/** Clamps `raw` to `[1, WEB_SEARCH_MAX_LIMIT]`, default `WEB_SEARCH_DEFAULT_LIMIT`. */
export function normalizeWebSearchLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return WEB_SEARCH_DEFAULT_LIMIT;
  const rounded = Math.trunc(raw);
  if (rounded < 1) return 1;
  if (rounded > WEB_SEARCH_MAX_LIMIT) return WEB_SEARCH_MAX_LIMIT;
  return rounded;
}

export function isWebSearchProvider(value: unknown): value is WebSearchProvider {
  return typeof value === 'string' && (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Settings shape persisted in `settings.json`. The `apiKey` field is
 * stored in cleartext on disk (settings store sees the raw value);
 * the IPC store boundary returns the masked sentinel to the renderer
 * for display. An update where `apiKey === MASKED_TOKEN_SENTINEL`
 * means "keep current" — the store preserves it.
 */
export interface WebSearchProviderSettings {
  readonly apiKey: string;
  /** Renderer-safe credential source. Never carries the secret value. */
  readonly credentialSource: WebSearchCredentialSource;
  /**
   * Monotonic local version for saved credentials. Async test/query results
   * carry the version they observed; stale results must not overwrite status
   * for a newer key.
   */
  readonly credentialVersion: number;
  readonly credentialStatus: WebSearchCredentialStatus;
  readonly credentialCheckedAt?: string;
}

export interface WebSearchSettings {
  readonly enabled: boolean;
  readonly defaultProvider: WebSearchProvider;
  readonly providers: { readonly tavily: WebSearchProviderSettings };
}

export function defaultWebSearchSettings(): WebSearchSettings {
  return {
    enabled: false,
    defaultProvider: 'tavily',
    providers: { tavily: { apiKey: '', credentialSource: 'none', credentialVersion: 0, credentialStatus: 'untested' } },
  };
}

/**
 * Helper for the IPC store boundary: given a (possibly stale)
 * persisted token and the renderer-sent update token, choose which
 * to persist. Renderer sending exactly the mask means "keep current".
 */
export function reconcileMaskedToken(persisted: string, candidate: string): string {
  if (candidate === MASKED_TOKEN_SENTINEL) return persisted;
  return candidate;
}

/** Returns the rendered representation (masked when non-empty). */
export function maskedTokenForDisplay(persisted: string): string {
  return persisted.length === 0 ? '' : MASKED_TOKEN_SENTINEL;
}

export function isWebSearchCredentialStatus(value: unknown): value is WebSearchCredentialStatus {
  return (
    typeof value === 'string' &&
    (WEB_SEARCH_CREDENTIAL_STATUSES as readonly string[]).includes(value)
  );
}

export function isWebSearchCredentialSource(value: unknown): value is WebSearchCredentialSource {
  return (
    typeof value === 'string' &&
    (WEB_SEARCH_CREDENTIAL_SOURCES as readonly string[]).includes(value)
  );
}

export function webSearchCredentialSourceFromStoredKey(apiKey: string): WebSearchCredentialSource {
  return apiKey.length > 0 ? 'saved' : 'none';
}

export function webSearchCredentialStatusFromResponse(
  response: WebSearchResponse,
): WebSearchCredentialStatus {
  if (response.ok) return 'valid';
  if (isWebSearchCredentialStatus(response.reason)) return response.reason;
  return 'network_error';
}
