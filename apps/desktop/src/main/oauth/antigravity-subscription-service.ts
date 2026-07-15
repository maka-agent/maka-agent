/**
 * Google Antigravity (Gemini) subscription OAuth service —
 * preview-only placeholder.
 *
 * Structurally mirrors the Claude / Codex services (loopback PKCE,
 * Google OAuth endpoints, safeStorage-encrypted persistence). The
 * preview remains fail-closed because no Google client id is bundled.
 *
 * Status: 'preview'. The card is visible in Settings → 模型, but
 * any attempt to `getAuthorizationUrl()` returns a clear
 * `unknown` failure envelope explaining that the Google
 * client_id is not bundled. Once the client_id question is
 * resolved, this file
 * keeps its shape and only the `GOOGLE_CLIENT_ID` constant gets
 * a real value.
 *
 * Hard gates:
 *   - Renderer NEVER sees access_token / refresh_token / id_token.
 *   - Refresh failure does NOT auto-logout.
 *   - The authorization URL is held in-process when the placeholder
 *     advances to a real implementation.
 */

import { safeStorage, shell } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import {
  PENDING_AUTHORIZATION_TTL_MS,
  PKCE_VERIFIER_LENGTH_BYTES,
  TOKEN_REFRESH_SKEW_MS,
  base64urlEncode,
  constantTimeStringEqual,
  type AuthorizationUrlPayload,
  type SubscriptionActionFailureReason,
  type SubscriptionActionResult,
} from '@maka/core';
import {
  ANTIGRAVITY_MISSING_CLIENT_ID_ENVELOPE,
  ANTIGRAVITY_OAUTH_CONFIG,
  GOOGLE_CLIENT_ID,
  STATUS,
  buildAntigravityAuthorizationUrl,
  pkceChallengeFromVerifier,
} from './antigravity-subscription-helpers.js';

const GOOGLE_AUTHORIZE_ENDPOINT = ANTIGRAVITY_OAUTH_CONFIG.authUrl;
const GOOGLE_TOKEN_ENDPOINT = ANTIGRAVITY_OAUTH_CONFIG.tokenUrl;
const ANTIGRAVITY_CALLBACK_HOST = ANTIGRAVITY_OAUTH_CONFIG.callbackHost;
const ANTIGRAVITY_CALLBACK_PORT = ANTIGRAVITY_OAUTH_CONFIG.callbackPort;
const ANTIGRAVITY_REDIRECT_URI = ANTIGRAVITY_OAUTH_CONFIG.redirectUri;
const ANTIGRAVITY_SCOPES = ANTIGRAVITY_OAUTH_CONFIG.scopes;

const PLAIN_USER_AGENT = 'maka-desktop/0.1.0 (oauth-subscription)';

export { STATUS };

// =============================================================
// Persisted tokens — INTERNAL TO THIS MODULE.
// =============================================================
interface PersistedTokens {
  /* eslint-disable @typescript-eslint/naming-convention -- OAuth protocol field names */
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_at: number;
  /* eslint-enable */
}

interface PendingAuthorization {
  verifier: string;
  state: string;
  createdAt: number;
  url: string;
  codePromise: Promise<{ code: string; state: string }>;
  resolveCode: (value: { code: string; state: string }) => void;
  rejectCode: (err: Error) => void;
  server: Server | null;
}

// =============================================================
// Service class.
// =============================================================

export interface AntigravitySubscriptionServiceDeps {
  /** Absolute path to userData dir; e.g. app.getPath('userData'). */
  userDataDir: string;
  /** Function returning current epoch ms. Injectable for tests. */
  now?: () => number;
  /** fetch implementation. Defaults to global fetch (Node 18+). */
  fetchFn?: typeof fetch;
}

export class AntigravitySubscriptionService {
  private readonly tokenFilePath: string;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;

  private cachedTokens: PersistedTokens | null = null;
  private pending: Map<string, PendingAuthorization> = new Map();

  private lastRefreshFailedMessage: string | null = null;
  private authorizing = false;
  private refreshing = false;

  constructor(deps: AntigravitySubscriptionServiceDeps) {
    this.tokenFilePath = join(deps.userDataDir, '.antigravity_subscription_token');
    this.now = deps.now ?? (() => Date.now());
    this.fetchFn = deps.fetchFn ?? (globalThis.fetch as typeof fetch);
  }

  // -----------------------------------------------------------
  // PUBLIC API
  // -----------------------------------------------------------

  /**
   * Build the PKCE-protected Google authorize URL and start a
   * loopback callback server on port 51121.
   *
   * **Currently disabled.** Until `GOOGLE_CLIENT_ID` is populated
   * with the antigravity-auth plugin's real value, this method
   * returns a clear `unknown` failure envelope. The renderer
   * surfaces the message verbatim in the modal, and the contract
   * test pins the exact reason / wording so a future "oops"
   * accidental enable is obvious in CI.
   */
  async getAuthorizationUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
    if (!GOOGLE_CLIENT_ID) {
      return ANTIGRAVITY_MISSING_CLIENT_ID_ENVELOPE;
    }
    this.pruneExpiredPending();
    const verifier = base64urlEncode(randomBytes(PKCE_VERIFIER_LENGTH_BYTES));
    const state = base64urlEncode(randomBytes(16));
    const authRequestId = randomUUID();

    const challenge = pkceChallengeFromVerifier(verifier);
    const url = buildAntigravityAuthorizationUrl({
      clientId: GOOGLE_CLIENT_ID,
      authorizeEndpoint: GOOGLE_AUTHORIZE_ENDPOINT,
      redirectUri: ANTIGRAVITY_REDIRECT_URI,
      scope: ANTIGRAVITY_SCOPES,
      state,
      challenge,
    });

    let resolveCode!: (value: { code: string; state: string }) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    let server: Server;
    try {
      server = await this.startCallbackServer(state, resolveCode, rejectCode);
    } catch (err) {
      const message = err instanceof Error ? err.message : '回调端口 51121 启动失败。';
      return { ok: false, reason: 'unknown', message };
    }

    this.pending.set(authRequestId, {
      verifier,
      state,
      createdAt: this.now(),
      url,
      codePromise,
      resolveCode,
      rejectCode,
      server,
    });

    return {
      stateHint: state.slice(0, 8),
      authRequestId,
    };
  }

  async openAuthorizationUrl(authRequestId: string): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending) {
      return { ok: false, reason: 'authorization_pending', message: '授权会话不存在，请重新点击“登录 Antigravity”。' };
    }
    if (this.now() - pending.createdAt > PENDING_AUTHORIZATION_TTL_MS) {
      this.disposePending(authRequestId);
      return { ok: false, reason: 'authorization_expired', message: '授权请求已过期，请重新点击“登录 Antigravity”。' };
    }
    try {
      await shell.openExternal(pending.url);
      this.authorizing = true;
      return { ok: true };
    } catch (err) {
      return this.failureFromError('unknown', err);
    }
  }

  async completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending) {
      this.authorizing = false;
      return { ok: false, reason: 'authorization_pending', message: '请先点击“登录 Antigravity”再完成授权。' };
    }
    if (this.now() - pending.createdAt > PENDING_AUTHORIZATION_TTL_MS) {
      this.disposePending(authRequestId);
      this.authorizing = false;
      return { ok: false, reason: 'authorization_expired', message: '授权请求已过期，请重新点击“登录 Antigravity”。' };
    }
    try {
      const { code, state } = await pending.codePromise;
      if (!constantTimeStringEqual(state, pending.state)) {
        this.disposePending(authRequestId);
        this.authorizing = false;
        return { ok: false, reason: 'invalid_paste_code', message: '回调 state 校验失败，请重新登录。' };
      }
      const tokens = await this.exchangeCodeForTokens(code, pending.verifier);
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

  cancelAuthorization(authRequestId?: string): void {
    if (authRequestId !== undefined) {
      this.disposePending(authRequestId);
    } else {
      for (const id of [...this.pending.keys()]) this.disposePending(id);
    }
    this.authorizing = false;
  }

  async getAccountState(): Promise<AntigravityAccountStateSnapshot> {
    const tokens = await this.loadTokens();
    if (!tokens) {
      return {
        provider: 'antigravity-subscription',
        status: STATUS,
        runtimeState: this.authorizing ? 'authorizing' : 'not_logged_in',
      };
    }
    const runtimeState = this.deriveRuntimeState();
    return {
      provider: 'antigravity-subscription',
      status: STATUS,
      runtimeState,
      errorMessage: this.errorForState(runtimeState),
    };
  }

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

  private deriveRuntimeState(): AntigravityRuntimeState {
    if (this.refreshing) return 'refreshing';
    if (this.lastRefreshFailedMessage) return 'refresh_failed';
    return 'authenticated';
  }

  private errorForState(state: AntigravityRuntimeState): string | undefined {
    if (state === 'refresh_failed') return this.lastRefreshFailedMessage ?? undefined;
    return undefined;
  }

  private pruneExpiredPending(): void {
    const cutoff = this.now() - PENDING_AUTHORIZATION_TTL_MS;
    for (const [id, p] of this.pending) {
      if (p.createdAt < cutoff) this.disposePending(id);
    }
  }

  private async startCallbackServer(
    expectedState: string,
    resolveCode: (value: { code: string; state: string }) => void,
    rejectCode: (err: Error) => void,
  ): Promise<Server> {
    return await new Promise<Server>((resolve, reject) => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = req.url ?? '';
        if (!url.startsWith('/callback')) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found.');
          return;
        }
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(url, `http://${ANTIGRAVITY_CALLBACK_HOST}:${ANTIGRAVITY_CALLBACK_PORT}`);
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Invalid callback URL.');
          return;
        }
        const code = parsedUrl.searchParams.get('code');
        const state = parsedUrl.searchParams.get('state');
        const error = parsedUrl.searchParams.get('error');
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`OAuth error: ${error}`);
          rejectCode(new Error(`OAuth provider returned error: ${error}`));
          return;
        }
        if (!code || !state) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Missing code or state.');
          return;
        }
        if (!constantTimeStringEqual(state, expectedState)) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('State mismatch.');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><body><p>登录成功，可关闭此标签页。</p></body></html>');
        resolveCode({ code, state });
      });
      server.on('error', (err) => {
        reject(err);
      });
      // Reject sockets that connect but never finish a request
      // within 10s, so a stuck browser tab can't pin the port.
      server.setTimeout(10_000, (socket) => {
        try { socket.destroy(); } catch { /* best-effort */ }
      });
      server.listen(ANTIGRAVITY_CALLBACK_PORT, ANTIGRAVITY_CALLBACK_HOST, () => {
        resolve(server);
      });
    });
  }

  private disposePending(authRequestId: string): void {
    const pending = this.pending.get(authRequestId);
    if (!pending) return;
    this.pending.delete(authRequestId);
    if (pending.server) {
      try {
        // Drop in-flight sockets first — `close()` alone waits for
        // existing connections to drain, and a browser tab that
        // hangs onto the callback request will pin port 51121 until
        // OS socket timeout. closeAllConnections is Node 18.2+.
        pending.server.closeAllConnections?.();
        pending.server.close();
      } catch {
        // best-effort
      }
    }
    pending.rejectCode(new Error('Authorization cancelled.'));
  }

  private async exchangeCodeForTokens(code: string, verifier: string): Promise<PersistedTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: GOOGLE_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: ANTIGRAVITY_REDIRECT_URI,
    });
    const response = await this.fetchFn(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': PLAIN_USER_AGENT,
      },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new Error(`Token exchange failed (${response.status}).`);
    }
    const payload = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      id_token?: string;
      expires_in: number;
    };
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      id_token: payload.id_token,
      expires_at: this.now() + 1000 * payload.expires_in,
    };
  }

  private async requestRefresh(refreshToken: string): Promise<PersistedTokens> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: GOOGLE_CLIENT_ID,
      refresh_token: refreshToken,
    });
    const response = await this.fetchFn(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': PLAIN_USER_AGENT,
      },
      body: body.toString(),
    });
    if (!response.ok) throw new Error(`Token refresh failed (${response.status}).`);
    const payload = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
      expires_in: number;
    };
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token ?? refreshToken,
      id_token: payload.id_token,
      expires_at: this.now() + 1000 * payload.expires_in,
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
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(this.tokenFilePath);
    } catch {
      return null;
    }
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      const decoded = safeStorage.decryptString(buffer);
      const parsed = JSON.parse(decoded) as PersistedTokens;
      this.cachedTokens = parsed;
      return parsed;
    } catch {
      // Token file exists but is unreadable. Delete to avoid a
      // stuck-corrupt state on the next login attempt.
      try { await fs.unlink(this.tokenFilePath); } catch { /* best-effort */ }
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
// Public IPC payload shape.
// =============================================================
export type AntigravityRuntimeState =
  | 'not_logged_in'
  | 'authorizing'
  | 'authenticated'
  | 'refreshing'
  | 'refresh_failed';

export interface AntigravityAccountStateSnapshot {
  provider: 'antigravity-subscription';
  status: typeof STATUS;
  runtimeState: AntigravityRuntimeState;
  errorMessage?: string;
}

// Re-exports for the IPC handler + tests. Pure helpers live in
// `antigravity-subscription-helpers.ts` so they can be unit-tested
// without dragging in the electron ESM module.
export {
  ANTIGRAVITY_MISSING_CLIENT_ID_ENVELOPE,
  ANTIGRAVITY_OAUTH_CONFIG,
  buildAntigravityAuthorizationUrl,
  isAntigravitySubscriptionExperimentalEnabled,
  pkceChallengeFromVerifier,
} from './antigravity-subscription-helpers.js';
