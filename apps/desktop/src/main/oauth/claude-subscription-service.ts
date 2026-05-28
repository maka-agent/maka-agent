/**
 * Claude subscription OAuth service (main-process only).
 *
 * PR-OAUTH-SUBSCRIPTION-0. Gate: `notes/pr-oauth-subscription-0-gate.md`.
 *
 * Responsibilities:
 *   1. PKCE authorize URL generation + pending state (G-X1).
 *   2. Paste-code parsing + state validation (G-X2).
 *   3. Token exchange + refresh + persistence via safeStorage with
 *      explicit mode 0o600 (G-X1 + kenji hard gates).
 *   4. Usage quota fetch (caches with QUOTA_CACHE_TTL_MS).
 *   5. Logout: clears in-memory + deletes token file.
 *   6. Account state snapshot for renderer (no token-shaped fields).
 *
 * Hard gates enforced:
 *   - Renderer NEVER sees access_token / refresh_token. The state
 *     snapshot omits them; this module's public methods return
 *     either `SubscriptionAccountState` or `SubscriptionActionResult`.
 *   - Cloaked headers are loaded ONLY via dynamic import inside the
 *     env-flag-gated branch (xuan G-X4). Tests verify this.
 *   - Refresh failure does NOT auto-logout (kenji `cf41871b`).
 *   - PKCE state matched with constant-time equality (G-X1).
 */

import { safeStorage, shell } from 'electron';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  PENDING_AUTHORIZATION_TTL_MS,
  PKCE_VERIFIER_LENGTH_BYTES,
  QUOTA_CACHE_TTL_MS,
  TOKEN_REFRESH_SKEW_MS,
  base64urlEncode,
  buildClaudeAuthorizationUrl,
  constantTimeStringEqual,
  parsePastedAuthorization,
  type AuthorizationUrlPayload,
  type QuotaSnapshot,
  type Sha256Digest,
  type SubscriptionAccountProfile,
  type SubscriptionAccountState,
  type SubscriptionActionFailureReason,
  type SubscriptionActionResult,
} from '@maka/core';

// =============================================================
// Endpoints + client id — alma's reverse-engineered constants.
// Verified at `~/Downloads/alma-re/readable/main.js:15913-15919`.
// =============================================================
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_AUTHORIZE_ENDPOINT = 'https://claude.ai/oauth/authorize';
const CLAUDE_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const CLAUDE_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_PROFILE_ENDPOINT = 'https://api.anthropic.com/api/oauth/profile';
const CLAUDE_SCOPE = 'org:create_api_key user:profile user:inference';

// Standard OAuth UA — NOT the cloaked Claude Code UA. The cloak
// path lives in a separate module that's only imported when the
// env flag is set (xuan G-X4).
const PLAIN_USER_AGENT = 'maka-desktop/0.1.0 (oauth-subscription)';

// =============================================================
// Token storage — encrypted via safeStorage, mode 0o600.
// =============================================================

/**
 * Tokens persisted to disk. INTERNAL TO THIS MODULE — never crosses
 * the IPC boundary. The renderer only sees the public
 * `SubscriptionAccountState` shape, which omits these fields.
 *
 * Field names use snake_case to match Anthropic's token response;
 * we don't re-key on save.
 *
 * NOTE: this interface intentionally uses string literal property
 * names below to keep the contract-test scan (which forbids
 * `accessToken:` and `refreshToken:` as object-literal keys in
 * preload / renderer code) ergonomic. This file lives in `main/`
 * which is OFF the scan path, and the property names are explicit
 * snake_case OAuth protocol names — not engineering identifiers.
 */
interface PersistedTokens {
  /* eslint-disable @typescript-eslint/naming-convention -- OAuth protocol field names */
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
  scope: string;
  account_uuid: string;
  /* eslint-enable */
}

// =============================================================
// Pending authorization map (PKCE state).
// =============================================================

interface PendingAuthorization {
  verifier: string;
  state: string;
  createdAt: number;
}

// =============================================================
// Node SHA-256 implementation, injected into core's pure helpers.
// =============================================================

const nodeSha256: Sha256Digest = {
  digest(input: string): Uint8Array {
    return new Uint8Array(createHash('sha256').update(input, 'utf8').digest());
  },
};

// =============================================================
// Service class.
// =============================================================

export interface ClaudeSubscriptionServiceDeps {
  /** Absolute path to userData dir; e.g. app.getPath('userData'). */
  userDataDir: string;
  /** Function returning current epoch ms. Injectable for tests. */
  now?: () => number;
  /** fetch implementation. Defaults to global fetch (Node 18+). */
  fetchFn?: typeof fetch;
}

export class ClaudeSubscriptionService {
  private readonly tokenFilePath: string;
  private readonly deviceIdFilePath: string;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;

  private cachedTokens: PersistedTokens | null = null;
  private cachedQuota: QuotaSnapshot | null = null;
  private cachedProfile: SubscriptionAccountProfile | null = null;
  private pending: Map<string, PendingAuthorization> = new Map();

  // Runtime state diagnostics. Used by the snapshot getter.
  private lastRefreshFailedMessage: string | null = null;
  private lastRejectionMessage: string | null = null;
  private quotaFetchFailedMessage: string | null = null;
  private authorizing = false;
  private refreshing = false;

  constructor(deps: ClaudeSubscriptionServiceDeps) {
    this.tokenFilePath = join(deps.userDataDir, '.claude_subscription_token');
    this.deviceIdFilePath = join(deps.userDataDir, '.claude_subscription_device_id');
    this.now = deps.now ?? (() => Date.now());
    this.fetchFn = deps.fetchFn ?? (globalThis.fetch as typeof fetch);
  }

  // -----------------------------------------------------------
  // PUBLIC API — these are what the IPC handlers call.
  // -----------------------------------------------------------

  /**
   * Start an authorization attempt: returns the URL the renderer
   * should open externally, plus an opaque `authRequestId` that's
   * required when the user pastes the redirect code back.
   *
   * The verifier + state are persisted in the in-memory pending
   * map ONLY — never on disk, never to the renderer.
   */
  async getAuthorizationUrl(): Promise<AuthorizationUrlPayload> {
    this.pruneExpiredPending();
    const verifier = base64urlEncode(randomBytes(PKCE_VERIFIER_LENGTH_BYTES));
    const state = base64urlEncode(randomBytes(16));
    const authRequestId = randomUUID();
    this.pending.set(authRequestId, {
      verifier,
      state,
      createdAt: this.now(),
    });
    const url = buildClaudeAuthorizationUrl(
      {
        clientId: CLAUDE_CLIENT_ID,
        authorizeEndpoint: CLAUDE_AUTHORIZE_ENDPOINT,
        redirectUri: CLAUDE_REDIRECT_URI,
        scope: CLAUDE_SCOPE,
      },
      verifier,
      state,
      nodeSha256,
    );
    return {
      url,
      stateHint: state.slice(0, 8),
      authRequestId,
    };
  }

  /**
   * Open the authorization URL in the user's default browser.
   * Called by the renderer right after `getAuthorizationUrl`.
   */
  async openAuthorizationUrl(url: string): Promise<SubscriptionActionResult> {
    try {
      await shell.openExternal(url);
      this.authorizing = true;
      return { ok: true };
    } catch (err) {
      return this.failureFromError('unknown', err);
    }
  }

  /**
   * Validate the pasted code, then exchange for tokens. xuan G-X1 +
   * G-X2: strict shape + state match + TTL + one-shot consumption.
   */
  async completeAuthorization(
    authRequestId: string,
    rawPasted: unknown,
  ): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending) {
      this.authorizing = false;
      return { ok: false, reason: 'authorization_pending', message: '请先点击“登录订阅”再粘贴授权码。' };
    }
    if (this.now() - pending.createdAt > PENDING_AUTHORIZATION_TTL_MS) {
      this.pending.delete(authRequestId);
      this.authorizing = false;
      return { ok: false, reason: 'authorization_expired', message: '授权请求已过期，请重新点击“登录订阅”。' };
    }
    const parsed = parsePastedAuthorization(rawPasted);
    if (!parsed) {
      return {
        ok: false,
        reason: 'invalid_paste_code',
        message: '授权码格式不正确，请粘贴完整字符串（包含 `#` 分隔符）。',
      };
    }
    if (!constantTimeStringEqual(parsed.state, pending.state)) {
      return { ok: false, reason: 'invalid_paste_code', message: '授权码 state 校验失败，请重新登录。' };
    }
    // ONE-SHOT consumption (G-X1): delete BEFORE the network call
    // so a concurrent retry can't replay the same verifier.
    this.pending.delete(authRequestId);

    try {
      const tokens = await this.exchangeCodeForTokens(parsed.code, pending.verifier, parsed.state);
      await this.saveTokens(tokens);
      this.cachedTokens = tokens;
      this.authorizing = false;
      // Kick a profile fetch in the background; failure is non-fatal
      // (the user is authenticated regardless of profile success).
      void this.refreshProfile();
      return { ok: true };
    } catch (err) {
      this.authorizing = false;
      return this.failureFromError('token_exchange_failed', err);
    }
  }

  /**
   * Cancel a pending authorization (user closed the modal).
   */
  cancelAuthorization(authRequestId?: string): void {
    if (authRequestId !== undefined) {
      this.pending.delete(authRequestId);
    } else {
      this.pending.clear();
    }
    this.authorizing = false;
  }

  /**
   * Snapshot of the current account state for the renderer.
   * NO token-shaped fields exposed (xuan G-X3).
   */
  async getAccountState(): Promise<SubscriptionAccountState> {
    const tokens = await this.loadTokens();
    if (!tokens) {
      return {
        provider: 'claude-subscription',
        runtimeState: this.authorizing ? 'authorizing' : 'not_logged_in',
      };
    }
    const runtimeState = this.deriveRuntimeState(tokens);
    return {
      provider: 'claude-subscription',
      runtimeState,
      profile: this.cachedProfile ?? { accountUuid: tokens.account_uuid },
      quota: this.cachedQuota ?? undefined,
      errorMessage: this.errorForState(runtimeState),
    };
  }

  /**
   * Force a token refresh.
   *
   * kenji `cf41871b`: refresh FAILURE does NOT auto-delete the
   * token file. The user sees `refresh_failed` and must click
   * "重新登录".
   */
  async refreshTokens(): Promise<SubscriptionActionResult> {
    const tokens = await this.loadTokens();
    if (!tokens) return { ok: false, reason: 'refresh_failed', message: '当前未登录。' };
    this.refreshing = true;
    try {
      const next = await this.requestRefresh(tokens.refresh_token, tokens.account_uuid);
      await this.saveTokens(next);
      this.cachedTokens = next;
      this.lastRefreshFailedMessage = null;
      this.refreshing = false;
      return { ok: true };
    } catch (err) {
      this.refreshing = false;
      const message = err instanceof Error ? err.message : '刷新失败，请重新登录。';
      this.lastRefreshFailedMessage = message;
      return { ok: false, reason: 'refresh_failed', message };
    }
  }

  /**
   * Refresh the cached quota snapshot. Caller can call this on
   * Settings page mount or after a refresh.
   */
  async refreshQuota(): Promise<SubscriptionActionResult> {
    const accessToken = await this.getAccessTokenInternal();
    if (!accessToken) {
      return { ok: false, reason: 'unknown', message: '当前未登录。' };
    }
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': PLAIN_USER_AGENT,
      };
      const response = await this.fetchFn(CLAUDE_USAGE_ENDPOINT, { headers });
      if (!response.ok) {
        this.quotaFetchFailedMessage = `配额端点返回 ${response.status}。`;
        return { ok: false, reason: 'unknown', message: this.quotaFetchFailedMessage };
      }
      const data = (await response.json()) as {
        five_hour?: { utilization?: number; resets_at?: string };
        seven_day?: { utilization?: number; resets_at?: string };
      };
      const snapshot: QuotaSnapshot = { fetchedAt: this.now() };
      if (data.five_hour && typeof data.five_hour.utilization === 'number') {
        snapshot.fiveHour = {
          utilization: Math.round(data.five_hour.utilization),
          resetsAt: data.five_hour.resets_at ?? '',
        };
      }
      if (data.seven_day && typeof data.seven_day.utilization === 'number') {
        snapshot.sevenDay = {
          utilization: Math.round(data.seven_day.utilization),
          resetsAt: data.seven_day.resets_at ?? '',
        };
      }
      this.cachedQuota = snapshot;
      this.quotaFetchFailedMessage = null;
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : '配额请求失败。';
      this.quotaFetchFailedMessage = message;
      return { ok: false, reason: 'unknown', message };
    }
  }

  /**
   * Logout: clear in-memory + delete token file (kenji `cf41871b`
   * hard gate).
   */
  async logout(): Promise<SubscriptionActionResult> {
    this.cachedTokens = null;
    this.cachedQuota = null;
    this.cachedProfile = null;
    this.lastRefreshFailedMessage = null;
    this.lastRejectionMessage = null;
    this.quotaFetchFailedMessage = null;
    this.pending.clear();
    this.authorizing = false;
    try {
      await fs.unlink(this.tokenFilePath);
    } catch (err) {
      // ENOENT is fine; anything else is suspicious but not fatal.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return { ok: false, reason: 'storage_failed', message: '删除本地凭据失败，请手动清理。' };
      }
    }
    return { ok: true };
  }

  /**
   * Get an access token (refreshing if needed). Caller is
   * responsible for keeping the returned token inside the main
   * process — never IPC it out (G-X3).
   *
   * Used by the future subscription send-path (PR-OAUTH-SUBSCRIPTION-1).
   */
  async getAccessTokenInternal(): Promise<string | null> {
    const tokens = await this.loadTokens();
    if (!tokens) return null;
    if (tokens.expires_at - this.now() <= TOKEN_REFRESH_SKEW_MS) {
      const refreshed = await this.refreshTokens();
      if (!refreshed.ok) return null;
      const next = await this.loadTokens();
      return next?.access_token ?? null;
    }
    return tokens.access_token;
  }

  // -----------------------------------------------------------
  // INTERNALS
  // -----------------------------------------------------------

  private deriveRuntimeState(
    tokens: PersistedTokens,
  ): import('@maka/core').OAuthSubscriptionRuntimeState {
    if (this.refreshing) return 'refreshing';
    if (this.lastRefreshFailedMessage) return 'refresh_failed';
    if (this.lastRejectionMessage) return 'provider_rejected';
    if (this.quotaFetchFailedMessage) return 'quota_unavailable';
    if (tokens.expires_at - this.now() <= TOKEN_REFRESH_SKEW_MS) return 'authenticated';
    return 'authenticated';
  }

  private errorForState(
    state: import('@maka/core').OAuthSubscriptionRuntimeState,
  ): string | undefined {
    switch (state) {
      case 'refresh_failed':
        return this.lastRefreshFailedMessage ?? undefined;
      case 'provider_rejected':
        return this.lastRejectionMessage ?? undefined;
      case 'quota_unavailable':
        return this.quotaFetchFailedMessage ?? undefined;
      default:
        return undefined;
    }
  }

  private pruneExpiredPending(): void {
    const cutoff = this.now() - PENDING_AUTHORIZATION_TTL_MS;
    for (const [id, p] of this.pending) {
      if (p.createdAt < cutoff) this.pending.delete(id);
    }
  }

  private async exchangeCodeForTokens(code: string, verifier: string, state: string): Promise<PersistedTokens> {
    const response = await this.fetchFn(CLAUDE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': PLAIN_USER_AGENT,
      },
      body: JSON.stringify({
        code,
        state,
        grant_type: 'authorization_code',
        client_id: CLAUDE_CLIENT_ID,
        redirect_uri: CLAUDE_REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
    if (!response.ok) {
      throw new Error(`Token exchange failed (${response.status}).`);
    }
    const payload = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
      scope: string;
      account?: { uuid?: string };
    };
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      expires_at: this.now() + 1000 * payload.expires_in,
      token_type: payload.token_type,
      scope: payload.scope,
      account_uuid: payload.account?.uuid ?? '',
    };
  }

  private async requestRefresh(refreshToken: string, prevAccountUuid: string): Promise<PersistedTokens> {
    const response = await this.fetchFn(CLAUDE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': PLAIN_USER_AGENT,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }),
    });
    if (!response.ok) throw new Error(`Token refresh failed (${response.status}).`);
    const payload = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
      scope: string;
      account?: { uuid?: string };
    };
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      expires_at: this.now() + 1000 * payload.expires_in,
      token_type: payload.token_type,
      scope: payload.scope,
      account_uuid: payload.account?.uuid ?? prevAccountUuid,
    };
  }

  private async saveTokens(tokens: PersistedTokens): Promise<void> {
    const serialized = JSON.stringify(tokens);
    const dir = dirname(this.tokenFilePath);
    await fs.mkdir(dir, { recursive: true });
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage encryption is unavailable.');
    }
    const buffer = safeStorage.encryptString(serialized);
    await fs.writeFile(this.tokenFilePath, buffer, { mode: 0o600 });
    // Re-apply mode explicitly in case the existing file had a
    // different mode (writeFile only sets it on create).
    await fs.chmod(this.tokenFilePath, 0o600);
  }

  private async loadTokens(): Promise<PersistedTokens | null> {
    if (this.cachedTokens) return this.cachedTokens;
    try {
      const buffer = await fs.readFile(this.tokenFilePath);
      if (!safeStorage.isEncryptionAvailable()) return null;
      const decoded = safeStorage.decryptString(buffer);
      const parsed = JSON.parse(decoded) as PersistedTokens;
      this.cachedTokens = parsed;
      return parsed;
    } catch {
      return null;
    }
  }

  private async refreshProfile(): Promise<void> {
    const accessToken = await this.getAccessTokenInternal();
    if (!accessToken) return;
    try {
      const response = await this.fetchFn(CLAUDE_PROFILE_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': PLAIN_USER_AGENT,
        },
      });
      if (!response.ok) return;
      const data = (await response.json()) as {
        account?: { uuid?: string; email?: string; email_address?: string; display_name?: string };
      };
      if (data.account) {
        this.cachedProfile = {
          accountUuid: data.account.uuid ?? (this.cachedTokens?.account_uuid ?? ''),
          email: data.account.email ?? data.account.email_address,
          displayName: data.account.display_name,
        };
      }
    } catch {
      // non-fatal
    }
  }

  private failureFromError(
    fallbackReason: SubscriptionActionFailureReason,
    err: unknown,
  ): SubscriptionActionResult {
    const message = err instanceof Error ? err.message : '操作失败。';
    return { ok: false, reason: fallbackReason, message };
  }

  /**
   * Quota cache is fresh if fetched within QUOTA_CACHE_TTL_MS.
   */
  isQuotaCacheFresh(): boolean {
    if (!this.cachedQuota) return false;
    return this.now() - this.cachedQuota.fetchedAt < QUOTA_CACHE_TTL_MS;
  }

  /**
   * Read or create the persistent device ID. 32 hex chars,
   * mode 0o600. Exposed so the future subscription send-path can
   * include it in the cloaked metadata block.
   */
  async getOrCreateDeviceId(): Promise<string> {
    try {
      const existing = (await fs.readFile(this.deviceIdFilePath, 'utf8')).trim();
      if (/^[a-f0-9]{64}$/.test(existing)) return existing;
    } catch {
      // fall through to create
    }
    const next = randomBytes(32).toString('hex');
    try {
      await fs.mkdir(dirname(this.deviceIdFilePath), { recursive: true });
      await fs.writeFile(this.deviceIdFilePath, next, { mode: 0o600 });
      await fs.chmod(this.deviceIdFilePath, 0o600);
    } catch {
      // best-effort persistence; in-memory only if disk failed
    }
    return next;
  }
}

/**
 * Resolve whether the cloak path is enabled. Used by the future
 * subscription send-path to decide whether to dynamic-import the
 * cloaked-request module. Centralized here so the contract test
 * has a single anchor.
 */
export function isCloakEnabled(): boolean {
  return process.env.MAKA_CLAUDE_SUBSCRIPTION_CLOAK === '1';
}
