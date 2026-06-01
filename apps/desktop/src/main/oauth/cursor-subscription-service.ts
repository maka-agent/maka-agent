/**
 * Cursor subscription OAuth service (main-process only).
 *
 * PR-MODEL-OAUTH-ALL-0. Cursor's flow is polling-based: no
 * loopback callback server, no paste code. The renderer opens
 * cursor.com/loginDeepControl in the user's default browser; main
 * polls api2.cursor.sh/auth/poll until the user finishes the
 * login. The poll response carries access + refresh tokens
 * directly.
 *
 * Hard gates (shared with the Claude / Codex services):
 *   - Renderer NEVER sees access_token / refresh_token. IPC
 *     payloads are `CursorAccountStateSnapshot`-shaped only.
 *   - Refresh failure does NOT auto-logout.
 *   - The login URL is held in-process; the renderer only
 *     receives an opaque `authRequestId`.
 *
 * Reference: cursor-auth plugin pattern (external reference).
 */

import { safeStorage, shell } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  PENDING_AUTHORIZATION_TTL_MS,
  PKCE_VERIFIER_LENGTH_BYTES,
  base64urlEncode,
  type AuthorizationUrlPayload,
  type SubscriptionActionFailureReason,
  type SubscriptionActionResult,
} from '@maka/core';
import {
  CURSOR_OAUTH_CONFIG,
  buildCursorLoginUrl,
  getTokenExpiry,
  pkceChallengeFromVerifier,
} from './cursor-subscription-helpers.js';

// Endpoint shortcuts so the existing class body reads like the
// Claude / Codex services (constants at the top, lookups inline).
const CURSOR_LOGIN_URL = CURSOR_OAUTH_CONFIG.loginUrl;
const CURSOR_POLL_URL = CURSOR_OAUTH_CONFIG.pollUrl;
const CURSOR_REFRESH_URL = CURSOR_OAUTH_CONFIG.refreshUrl;
const POLL_MAX_ATTEMPTS = CURSOR_OAUTH_CONFIG.pollMaxAttempts;
const POLL_BASE_DELAY_MS = CURSOR_OAUTH_CONFIG.pollBaseDelayMs;
const POLL_MAX_DELAY_MS = CURSOR_OAUTH_CONFIG.pollMaxDelayMs;
const POLL_BACKOFF_MULTIPLIER = CURSOR_OAUTH_CONFIG.pollBackoffMultiplier;
const POLL_MAX_CONSECUTIVE_ERRORS = CURSOR_OAUTH_CONFIG.pollMaxConsecutiveErrors;

const PLAIN_USER_AGENT = 'maka-desktop/0.1.0 (oauth-subscription)';

// =============================================================
// Persisted tokens — INTERNAL TO THIS MODULE. Never crosses IPC.
// =============================================================
interface PersistedTokens {
  /* eslint-disable @typescript-eslint/naming-convention -- OAuth protocol field names */
  access_token: string;
  refresh_token: string;
  expires_at: number;
  /* eslint-enable */
}

interface PendingAuthorization {
  verifier: string;
  challenge: string;
  uuid: string;
  createdAt: number;
  url: string;
  /** Set to true when cancelAuthorization is called; the poll
   *  loop checks this between attempts and exits. */
  cancelled: boolean;
  /** The in-flight poll promise. Resolved with tokens on success,
   *  or rejected on timeout / error / cancellation. */
  pollPromise: Promise<PersistedTokens>;
}

// =============================================================
// Service class.
// =============================================================

export interface CursorSubscriptionServiceDeps {
  /** Absolute path to userData dir; e.g. app.getPath('userData'). */
  userDataDir: string;
  /** Function returning current epoch ms. Injectable for tests. */
  now?: () => number;
  /** fetch implementation. Defaults to global fetch (Node 18+). */
  fetchFn?: typeof fetch;
  /** Sleep function. Injectable for tests so poll loops don't
   *  actually wait. */
  sleepFn?: (ms: number) => Promise<void>;
}

export class CursorSubscriptionService {
  private readonly tokenFilePath: string;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  private cachedTokens: PersistedTokens | null = null;
  private pending: Map<string, PendingAuthorization> = new Map();

  private lastRefreshFailedMessage: string | null = null;
  private authorizing = false;
  private refreshing = false;

  constructor(deps: CursorSubscriptionServiceDeps) {
    this.tokenFilePath = join(deps.userDataDir, '.cursor_subscription_token');
    this.now = deps.now ?? (() => Date.now());
    this.fetchFn = deps.fetchFn ?? (globalThis.fetch as typeof fetch);
    this.sleepFn =
      deps.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  // -----------------------------------------------------------
  // PUBLIC API
  // -----------------------------------------------------------

  /**
   * Build the PKCE-protected login URL and start a background
   * poll against api2.cursor.sh. The poll resolves with tokens
   * once the user completes the in-browser flow.
   */
  async getAuthorizationUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
    this.pruneExpiredPending();
    const verifier = base64urlEncode(randomBytes(PKCE_VERIFIER_LENGTH_BYTES));
    const challenge = pkceChallengeFromVerifier(verifier);
    const uuid = randomUUID();
    const authRequestId = randomUUID();
    const url = buildCursorLoginUrl({
      loginUrl: CURSOR_LOGIN_URL,
      challenge,
      uuid,
    });

    const pendingShell: PendingAuthorization = {
      verifier,
      challenge,
      uuid,
      createdAt: this.now(),
      url,
      cancelled: false,
      // Placeholder; replaced below once the closure is built.
      pollPromise: Promise.reject(new Error('not started')),
    };
    pendingShell.pollPromise.catch(() => {
      /* swallow placeholder rejection */
    });
    pendingShell.pollPromise = this.runPollLoop(pendingShell);
    // Stash a no-op handler so node doesn't unhandled-reject the
    // background poll when the user closes the modal without
    // calling completeAuthorization.
    pendingShell.pollPromise.catch(() => {
      /* surfaced via completeAuthorization */
    });
    this.pending.set(authRequestId, pendingShell);

    return {
      stateHint: uuid.slice(0, 8),
      authRequestId,
    };
  }

  /**
   * Open the authorization URL we generated for a pending request.
   * The renderer hands us only the opaque authRequestId.
   */
  async openAuthorizationUrl(authRequestId: string): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending) {
      return { ok: false, reason: 'authorization_pending', message: '授权会话不存在，请重新点击“登录 Cursor”。' };
    }
    if (this.now() - pending.createdAt > PENDING_AUTHORIZATION_TTL_MS) {
      this.disposePending(authRequestId);
      return { ok: false, reason: 'authorization_expired', message: '授权请求已过期，请重新点击“登录 Cursor”。' };
    }
    try {
      await shell.openExternal(pending.url);
      this.authorizing = true;
      return { ok: true };
    } catch (err) {
      return this.failureFromError('unknown', err);
    }
  }

  /**
   * Await the background poll loop and persist the tokens it
   * returned. Renderer-side this is what's invoked after the
   * "登录 Cursor" button completes the open-external step — the
   * UI then sits on the resulting promise until the user finishes
   * the browser flow.
   */
  async completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending) {
      this.authorizing = false;
      return { ok: false, reason: 'authorization_pending', message: '请先点击“登录 Cursor”再完成授权。' };
    }
    try {
      const tokens = await pending.pollPromise;
      await this.saveTokens(tokens);
      this.cachedTokens = tokens;
      this.disposePending(authRequestId);
      this.authorizing = false;
      return { ok: true };
    } catch (err) {
      this.disposePending(authRequestId);
      this.authorizing = false;
      return this.failureFromError('token_exchange_failed', err);
    }
  }

  /**
   * Cancel a pending authorization. Flags the poll loop so it
   * exits before its next request.
   */
  cancelAuthorization(authRequestId?: string): void {
    if (authRequestId !== undefined) {
      this.disposePending(authRequestId);
    } else {
      for (const id of [...this.pending.keys()]) this.disposePending(id);
    }
    this.authorizing = false;
  }

  /**
   * Snapshot of the current account state for the renderer.
   * Cursor doesn't expose a public profile claim in the JWT, so
   * the snapshot is intentionally minimal — just enough for the
   * UI to render "已登录" / "未登录" + a refresh action.
   */
  async getAccountState(): Promise<CursorAccountStateSnapshot> {
    const tokens = await this.loadTokens();
    if (!tokens) {
      return {
        provider: 'cursor-subscription',
        runtimeState: this.authorizing ? 'authorizing' : 'not_logged_in',
      };
    }
    const runtimeState = this.deriveRuntimeState();
    return {
      provider: 'cursor-subscription',
      runtimeState,
      errorMessage: this.errorForState(runtimeState),
    };
  }

  /**
   * Force a token refresh. Cursor's refresh endpoint
   * (`/auth/exchange_user_api_key`) returns a new access /
   * refresh token pair.
   */
  async refreshTokens(): Promise<SubscriptionActionResult> {
    const tokens = await this.loadTokens();
    if (!tokens) return { ok: false, reason: 'refresh_failed', message: '当前未登录。' };
    this.refreshing = true;
    try {
      const next = await this.requestRefresh(tokens.refresh_token);
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
   * Logout: clear in-memory + delete token file. Local clear only.
   */
  async logout(): Promise<SubscriptionActionResult> {
    this.cachedTokens = null;
    this.lastRefreshFailedMessage = null;
    for (const id of [...this.pending.keys()]) this.disposePending(id);
    this.authorizing = false;
    try {
      await fs.unlink(this.tokenFilePath);
    } catch (err) {
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
   * process — never IPC it out.
   */
  async getAccessTokenInternal(): Promise<string | null> {
    const tokens = await this.loadTokens();
    if (!tokens) return null;
    if (tokens.expires_at <= this.now()) {
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

  private deriveRuntimeState(): CursorRuntimeState {
    if (this.refreshing) return 'refreshing';
    if (this.lastRefreshFailedMessage) return 'refresh_failed';
    return 'authenticated';
  }

  private errorForState(state: CursorRuntimeState): string | undefined {
    if (state === 'refresh_failed') return this.lastRefreshFailedMessage ?? undefined;
    return undefined;
  }

  private pruneExpiredPending(): void {
    const cutoff = this.now() - PENDING_AUTHORIZATION_TTL_MS;
    for (const [id, p] of this.pending) {
      if (p.createdAt < cutoff) this.disposePending(id);
    }
  }

  private async runPollLoop(pending: PendingAuthorization): Promise<PersistedTokens> {
    let delay: number = POLL_BASE_DELAY_MS;
    let consecutiveErrors = 0;
    let lastError: string | undefined;
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      if (pending.cancelled) {
        throw new Error('Authorization cancelled.');
      }
      await this.sleepFn(delay);
      if (pending.cancelled) {
        throw new Error('Authorization cancelled.');
      }
      try {
        const response = await this.fetchFn(
          `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(pending.uuid)}&verifier=${encodeURIComponent(pending.verifier)}`,
          {
            headers: { 'User-Agent': PLAIN_USER_AGENT },
          },
        );
        if (response.status === 404) {
          // Not yet ready. Back off and retry.
          consecutiveErrors = 0;
          delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY_MS);
          continue;
        }
        if (response.ok) {
          const data = (await response.json()) as {
            accessToken: string;
            refreshToken: string;
          };
          return {
            access_token: data.accessToken,
            refresh_token: data.refreshToken,
            expires_at: getTokenExpiry(data.accessToken, this.now()),
          };
        }
        // Non-404, non-200: treat as an error attempt.
        const body = await response.text().catch(() => '');
        throw new Error(`Poll failed: ${response.status}${body ? ` - ${body}` : ''}`);
      } catch (err) {
        consecutiveErrors++;
        lastError = err instanceof Error ? err.message : String(err);
        if (consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) {
          throw new Error(`Cursor auth polling failed: ${lastError}`);
        }
        delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY_MS);
      }
    }
    throw new Error(`Cursor authentication polling timeout${lastError ? `: ${lastError}` : ''}`);
  }

  private disposePending(authRequestId: string): void {
    const pending = this.pending.get(authRequestId);
    if (!pending) return;
    pending.cancelled = true;
    this.pending.delete(authRequestId);
  }

  private async requestRefresh(refreshToken: string): Promise<PersistedTokens> {
    const response = await this.fetchFn(CURSOR_REFRESH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        'Content-Type': 'application/json',
        'User-Agent': PLAIN_USER_AGENT,
      },
      body: '{}',
    });
    if (!response.ok) throw new Error(`Cursor token refresh failed (${response.status}).`);
    const data = (await response.json()) as {
      accessToken: string;
      refreshToken?: string;
    };
    return {
      access_token: data.accessToken,
      refresh_token: data.refreshToken ?? refreshToken,
      expires_at: getTokenExpiry(data.accessToken, this.now()),
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

  private failureFromError(
    fallbackReason: SubscriptionActionFailureReason,
    err: unknown,
  ): SubscriptionActionResult {
    const message = err instanceof Error ? err.message : '操作失败。';
    return { ok: false, reason: fallbackReason, message };
  }
}

// =============================================================
// Public IPC payload shape — `cursor-subscription:get-account-state`.
// =============================================================
export type CursorRuntimeState =
  | 'not_logged_in'
  | 'authorizing'
  | 'authenticated'
  | 'refreshing'
  | 'refresh_failed';

export interface CursorAccountStateSnapshot {
  provider: 'cursor-subscription';
  runtimeState: CursorRuntimeState;
  errorMessage?: string;
}

// Re-exports for the IPC handler + tests. The pure helpers live
// in `cursor-subscription-helpers.ts` so they can be unit-tested
// without dragging in the electron ESM module.
export {
  CURSOR_OAUTH_CONFIG,
  buildCursorLoginUrl,
  getTokenExpiry,
  isCursorSubscriptionExperimentalEnabled,
  pkceChallengeFromVerifier,
} from './cursor-subscription-helpers.js';
