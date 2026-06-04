/**
 * OpenAI Codex subscription OAuth service (main-process only).
 *
 * PR-MODEL-OAUTH-ALL-0. Sibling to the Claude subscription service;
 * mirrors its shape:
 *   - PKCE authorize URL generation + pending state.
 *   - Loopback callback server (port 1455) captures the redirect.
 *   - Token exchange + refresh + safeStorage-encrypted persistence
 *     under `app.getPath('userData')` with mode 0o600.
 *   - Account state snapshot for renderer — never exposes tokens.
 *
 * Hard gates (shared with the Claude service):
 *   - Renderer NEVER sees access_token / refresh_token / id_token.
 *     IPC payloads are `SubscriptionAccountState`-shaped only.
 *   - Refresh failure does NOT auto-logout — user must click 重新登录.
 *   - PKCE state matched with constant-time equality.
 *   - The authorization URL is held in-process; the renderer only
 *     receives an opaque `authRequestId` plus an 8-char `stateHint`.
 *
 * Reference: openai-codex-auth plugin pattern (external reference);
 * endpoint constants pinned to that file's values.
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
  CODEX_OAUTH_CONFIG,
  buildCodexAuthorizationUrl,
  extractAccountClaims,
  pkceChallengeFromVerifier,
  safeExtractAccountClaims,
  type CodexAccountClaims,
} from './codex-subscription-helpers.js';

// Endpoint shortcuts so the existing class body keeps reading
// like the Claude service (constants at the top, lookups inline).
const CODEX_CLIENT_ID = CODEX_OAUTH_CONFIG.clientId;
const CODEX_AUTHORIZE_ENDPOINT = CODEX_OAUTH_CONFIG.authUrl;
const CODEX_TOKEN_ENDPOINT = CODEX_OAUTH_CONFIG.tokenUrl;
const CODEX_CALLBACK_HOST = CODEX_OAUTH_CONFIG.callbackHost;
const CODEX_CALLBACK_PORT = CODEX_OAUTH_CONFIG.callbackPort;
const CODEX_REDIRECT_URI = CODEX_OAUTH_CONFIG.redirectUri;
const CODEX_SCOPES = CODEX_OAUTH_CONFIG.scopes;
const CODEX_EXTRA_PARAMS = CODEX_OAUTH_CONFIG.extras;

const PLAIN_USER_AGENT = 'maka-desktop/0.1.0 (oauth-subscription)';

// =============================================================
// Persisted tokens — INTERNAL TO THIS MODULE. Never crosses IPC.
// Snake_case field names match auth.openai.com's response body.
// =============================================================
interface PersistedTokens {
  /* eslint-disable @typescript-eslint/naming-convention -- OAuth protocol field names */
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_at: number;
  account_id: string;
  /* eslint-enable */
}

type AccountClaims = CodexAccountClaims;

interface PendingAuthorization {
  verifier: string;
  state: string;
  createdAt: number;
  /**
   * Authorization URL we generated. Kept in-process so the renderer
   * only ever hands us an opaque authRequestId — never a URL.
   */
  url: string;
  /**
   * Promise that resolves with the captured authorization code once
   * the loopback callback server fires, or rejects on timeout /
   * shutdown. Stored here so `completeAuthorization` can await it.
   */
  codePromise: Promise<{ code: string; state: string }>;
  /** Resolve / reject hooks bound to `codePromise`. */
  resolveCode: (value: { code: string; state: string }) => void;
  rejectCode: (err: Error) => void;
  /** Local loopback HTTP server. Closed on completion / cancel. */
  server: Server | null;
}

// =============================================================
// Service class.
// =============================================================

export interface CodexSubscriptionServiceDeps {
  /** Absolute path to userData dir; e.g. app.getPath('userData'). */
  userDataDir: string;
  /** Function returning current epoch ms. Injectable for tests. */
  now?: () => number;
  /** fetch implementation. Defaults to global fetch (Node 18+). */
  fetchFn?: typeof fetch;
}

export class CodexSubscriptionService {
  private readonly tokenFilePath: string;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;

  private cachedTokens: PersistedTokens | null = null;
  private cachedClaims: AccountClaims | null = null;
  private pending: Map<string, PendingAuthorization> = new Map();

  private lastRefreshFailedMessage: string | null = null;
  private authorizing = false;
  private refreshing = false;

  constructor(deps: CodexSubscriptionServiceDeps) {
    this.tokenFilePath = join(deps.userDataDir, '.codex_subscription_token');
    this.now = deps.now ?? (() => Date.now());
    this.fetchFn = deps.fetchFn ?? (globalThis.fetch as typeof fetch);
  }

  // -----------------------------------------------------------
  // PUBLIC API
  // -----------------------------------------------------------

  /**
   * Build the PKCE-protected authorize URL and start a loopback
   * callback server on port 1455. The returned `authRequestId`
   * scopes the eventual openAuthUrl / completeAuthorization /
   * cancelAuthorization calls.
   */
  async getAuthorizationUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
    this.pruneExpiredPending();
    const verifier = base64urlEncode(randomBytes(PKCE_VERIFIER_LENGTH_BYTES));
    const state = base64urlEncode(randomBytes(16));
    const authRequestId = randomUUID();

    const challenge = pkceChallengeFromVerifier(verifier);
    const url = buildCodexAuthorizationUrl({
      clientId: CODEX_CLIENT_ID,
      authorizeEndpoint: CODEX_AUTHORIZE_ENDPOINT,
      redirectUri: CODEX_REDIRECT_URI,
      scope: CODEX_SCOPES,
      state,
      challenge,
      extras: CODEX_EXTRA_PARAMS,
    });

    let resolveCode!: (value: { code: string; state: string }) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    // Start a single-shot loopback HTTP server. Bound only to
    // 127.0.0.1 so the OS firewall sees a local-only listener; the
    // browser's redirect to http://localhost:1455 hits this socket.
    let server: Server;
    try {
      server = await this.startCallbackServer(state, resolveCode, rejectCode);
    } catch (err) {
      const message = err instanceof Error ? err.message : '回调端口 1455 启动失败。';
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

  /**
   * Open the authorization URL we generated for a pending request.
   * The renderer hands us only the opaque authRequestId — main
   * looks up the URL it built earlier.
   */
  async openAuthorizationUrl(authRequestId: string): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending) {
      return { ok: false, reason: 'authorization_pending', message: '授权会话不存在，请重新点击“登录 Codex”。' };
    }
    if (this.now() - pending.createdAt > PENDING_AUTHORIZATION_TTL_MS) {
      this.disposePending(authRequestId);
      return { ok: false, reason: 'authorization_expired', message: '授权请求已过期，请重新点击“登录 Codex”。' };
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
   * Complete the authorization by awaiting the loopback callback,
   * then exchanging the captured code for tokens. The renderer
   * does not need to paste anything — the browser redirects to
   * 127.0.0.1:1455 which the callback server captures.
   */
  async completeAuthorization(
    authRequestId: string,
  ): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending) {
      this.authorizing = false;
      return { ok: false, reason: 'authorization_pending', message: '请先点击“登录 Codex”再完成授权。' };
    }
    if (this.now() - pending.createdAt > PENDING_AUTHORIZATION_TTL_MS) {
      this.disposePending(authRequestId);
      this.authorizing = false;
      return { ok: false, reason: 'authorization_expired', message: '授权请求已过期，请重新点击“登录 Codex”。' };
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
      this.cachedClaims = extractAccountClaims(tokens.access_token, tokens.id_token);
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
   * Cancel a pending authorization (user closed the modal or
   * pressed Cancel). Tears down the loopback server.
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
   * No token-shaped fields exposed.
   */
  async getAccountState(): Promise<CodexAccountStateSnapshot> {
    const tokens = await this.loadTokens();
    if (!tokens) {
      return {
        provider: 'codex-subscription',
        runtimeState: this.authorizing ? 'authorizing' : 'not_logged_in',
      };
    }
    const claims = this.cachedClaims ?? safeExtractAccountClaims(tokens.access_token, tokens.id_token);
    const runtimeState = this.deriveRuntimeState();
    return {
      provider: 'codex-subscription',
      runtimeState,
      accountId: tokens.account_id || claims?.accountId,
      email: claims?.email,
      plan: claims?.plan,
      picture: claims?.picture,
      errorMessage: this.errorForState(runtimeState),
    };
  }

  /**
   * Force a token refresh. Refresh failure does NOT auto-delete
   * the token file — the user sees `refresh_failed` and must
   * click 重新登录.
   */
  async refreshTokens(): Promise<SubscriptionActionResult> {
    const tokens = await this.loadTokens();
    if (!tokens) return { ok: false, reason: 'refresh_failed', message: '当前未登录。' };
    this.refreshing = true;
    try {
      const next = await this.requestRefresh(tokens);
      await this.saveTokens(next);
      this.cachedTokens = next;
      this.cachedClaims = extractAccountClaims(next.access_token, next.id_token);
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
   * Logout: clear in-memory + delete token file. Local clear only;
   * no remote revocation (auth.openai.com does not publicly expose
   * an RFC 7009 endpoint we can rely on).
   */
  async logout(): Promise<SubscriptionActionResult> {
    this.cachedTokens = null;
    this.cachedClaims = null;
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
  async getAccessTokenInternal(options: { forceRefresh?: boolean } = {}): Promise<string | null> {
    const tokens = await this.loadTokens();
    if (!tokens) return null;
    if (options.forceRefresh || tokens.expires_at - this.now() <= TOKEN_REFRESH_SKEW_MS) {
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

  private deriveRuntimeState(): CodexRuntimeState {
    if (this.refreshing) return 'refreshing';
    if (this.lastRefreshFailedMessage) return 'refresh_failed';
    return 'authenticated';
  }

  private errorForState(state: CodexRuntimeState): string | undefined {
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
        if (!url.startsWith('/auth/callback')) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not found.');
          return;
        }
        // Parse the query string. We only trust `code` + `state`.
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(url, `http://${CODEX_CALLBACK_HOST}:${CODEX_CALLBACK_PORT}`);
        } catch {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Invalid callback URL.');
          return;
        }
        const code = parsedUrl.searchParams.get('code');
        const state = parsedUrl.searchParams.get('state');
        const error = parsedUrl.searchParams.get('error');
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(callbackErrorHtml(error));
          rejectCode(new Error(`OAuth provider returned error: ${error}`));
          return;
        }
        if (!code || !state) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Missing code or state.');
          return;
        }
        // Constant-time state compare here to short-circuit invalid
        // callbacks before they reach the network exchange. The
        // service-level compare in completeAuthorization is the
        // authoritative one; this is defense in depth.
        if (!constantTimeStringEqual(state, expectedState)) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('State mismatch.');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackSuccessHtml());
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
      server.listen(CODEX_CALLBACK_PORT, CODEX_CALLBACK_HOST, () => {
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
        // hangs onto the callback request will pin port 1455 until
        // OS socket timeout. closeAllConnections is Node 18.2+; the
        // optional-chain guards older Electron runtimes.
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
      client_id: CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: CODEX_REDIRECT_URI,
    });
    const response = await this.fetchFn(CODEX_TOKEN_ENDPOINT, {
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
    const claims = extractAccountClaims(payload.access_token, payload.id_token);
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      id_token: payload.id_token,
      expires_at: this.now() + 1000 * payload.expires_in,
      account_id: claims.accountId,
    };
  }

  private async requestRefresh(tokens: PersistedTokens): Promise<PersistedTokens> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CODEX_CLIENT_ID,
      refresh_token: tokens.refresh_token,
    });
    const response = await this.fetchFn(CODEX_TOKEN_ENDPOINT, {
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
    const nextIdToken = payload.id_token ?? tokens.id_token;
    const claims = extractAccountClaims(payload.access_token, nextIdToken);
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token ?? tokens.refresh_token,
      id_token: nextIdToken,
      expires_at: this.now() + 1000 * payload.expires_in,
      account_id: claims.accountId || tokens.account_id,
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
      // Token file exists but is unreadable (keychain rolled, file
      // corrupted, JSON shape drifted). Delete it so the next login
      // flow doesn't observe a stuck-corrupt state. Best-effort.
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
// Public IPC payload shape — `codex-subscription:get-account-state`.
//
// Mirrors the Claude service's SubscriptionAccountState shape so
// the renderer can reuse a single presentation helper, but uses
// the OpenAI-specific provider tag and JWT claim fields. The
// renderer NEVER sees raw tokens; this is the entire surface.
// =============================================================
export type CodexRuntimeState =
  | 'not_logged_in'
  | 'authorizing'
  | 'authenticated'
  | 'refreshing'
  | 'refresh_failed';

export interface CodexAccountStateSnapshot {
  provider: 'codex-subscription';
  runtimeState: CodexRuntimeState;
  accountId?: string;
  email?: string;
  plan?: string;
  picture?: string;
  errorMessage?: string;
}

// =============================================================
// Re-exports for the IPC handler + tests. The pure helpers live
// in `codex-subscription-helpers.ts` so they can be unit-tested
// without dragging in the electron ESM module.
// =============================================================
export { buildCodexAuthorizationUrl, extractAccountClaims, pkceChallengeFromVerifier };

function callbackSuccessHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>登录成功</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 48px; color: #1f2937; }
  h1 { font-size: 22px; margin-bottom: 8px; }
  p { color: #4b5563; }
</style></head>
<body>
  <h1>登录成功</h1>
  <p>OpenAI Codex 授权已完成，你可以关闭这个标签页并回到 Maka。</p>
</body></html>`;
}

function callbackErrorHtml(error: string): string {
  const safe = error.replace(/[<>&"']/g, '');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>登录失败</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 48px; color: #1f2937; }
  h1 { font-size: 22px; margin-bottom: 8px; }
  p { color: #b91c1c; }
</style></head>
<body>
  <h1>登录失败</h1>
  <p>OAuth 返回错误：${safe}</p>
  <p>请关闭此标签页并在 Maka 重试。</p>
</body></html>`;
}

// `isCodexSubscriptionExperimentalEnabled` and `CODEX_OAUTH_CONFIG`
// live in `codex-subscription-helpers.ts` — re-export so the IPC
// handler in main.ts and contract tests have a single import path.
export { CODEX_OAUTH_CONFIG, isCodexSubscriptionExperimentalEnabled } from './codex-subscription-helpers.js';
