import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { SubscriptionActionResult } from '@maka/core';
import {
  exchangeGitHubCopilotToken,
  parseOAuthSubscriptionTokens,
  resolveOAuthSubscriptionTokens,
  serializeOAuthSubscriptionTokens,
  type OAuthSubscriptionTokens,
} from '@maka/runtime';
import type { CredentialStore } from '@maka/storage';

const GITHUB_COPILOT_CONNECTION_SLUG = 'github-copilot';
const execFileAsync = promisify(execFile);

export interface GitHubCopilotAccountStateSnapshot {
  provider: 'github-copilot';
  runtimeState: 'not_logged_in' | 'authenticated' | 'refreshing' | 'refresh_failed' | 'storage_failed';
  errorMessage?: string;
}

export interface GitHubCopilotSubscriptionServiceDeps {
  credentialStore: Pick<CredentialStore, 'getSecret' | 'setSecret' | 'deleteSecret'>;
  resolveGitHubToken?: () => Promise<string>;
  now?: () => number;
  fetchFn?: typeof fetch;
}

/** Main-process adapter for importing an existing supported `gh` login. */
export class GitHubCopilotSubscriptionService {
  private readonly credentialStore: GitHubCopilotSubscriptionServiceDeps['credentialStore'];
  private readonly resolveGitHubToken: () => Promise<string>;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private refreshing = false;
  private lastRefreshError: string | null = null;
  private lastStorageError: string | null = null;

  constructor(deps: GitHubCopilotSubscriptionServiceDeps) {
    this.credentialStore = deps.credentialStore;
    this.resolveGitHubToken = deps.resolveGitHubToken ?? resolveGitHubCliToken;
    this.now = deps.now ?? (() => Date.now());
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  async connectExistingLogin(): Promise<SubscriptionActionResult> {
    try {
      const githubToken = (await this.resolveGitHubToken()).trim();
      if (githubToken.startsWith('ghp_')) {
        return {
          ok: false,
          reason: 'token_exchange_failed',
          message: 'GitHub Copilot 不支持 classic PAT；请使用 gh auth login 的 OAuth 登录或具有 Copilot Requests 权限的 fine-grained PAT。',
        };
      }
      if (!isSupportedGitHubCopilotAccountToken(githubToken)) {
        return {
          ok: false,
          reason: 'token_exchange_failed',
          message: '当前 GitHub CLI 登录凭据类型不受支持；请重新运行 gh auth login。',
        };
      }
      const tokens = await exchangeGitHubCopilotToken({ githubToken, fetchFn: this.fetchFn });
      await this.saveTokens(tokens);
      this.lastRefreshError = null;
      return { ok: true };
    } catch {
      return {
        ok: false,
        reason: 'token_exchange_failed',
        message: '无法导入 GitHub CLI 登录。请先运行 gh auth login，并确认该账号具有 GitHub Copilot 订阅访问权限。',
      };
    }
  }

  async getAccountState(): Promise<GitHubCopilotAccountStateSnapshot> {
    let tokens: OAuthSubscriptionTokens | null;
    try {
      tokens = await this.loadTokens();
      this.lastStorageError = null;
    } catch {
      this.lastStorageError = 'GitHub Copilot 本地凭据读取失败。';
      tokens = null;
    }
    if (this.lastStorageError) {
      return { provider: 'github-copilot', runtimeState: 'storage_failed', errorMessage: this.lastStorageError };
    }
    if (!tokens) return { provider: 'github-copilot', runtimeState: 'not_logged_in' };
    if (this.refreshing) return { provider: 'github-copilot', runtimeState: 'refreshing' };
    if (this.lastRefreshError) {
      return { provider: 'github-copilot', runtimeState: 'refresh_failed', errorMessage: this.lastRefreshError };
    }
    return { provider: 'github-copilot', runtimeState: 'authenticated' };
  }

  async refreshTokens(): Promise<SubscriptionActionResult> {
    const current = await this.loadTokens().catch(() => null);
    if (!current) return { ok: false, reason: 'refresh_failed', message: '当前未导入 GitHub Copilot 登录。' };
    this.refreshing = true;
    try {
      const next = await exchangeGitHubCopilotToken({
        githubToken: current.refresh_token,
        fetchFn: this.fetchFn,
      });
      await this.saveTokens(next);
      this.lastRefreshError = null;
      return { ok: true };
    } catch {
      this.lastRefreshError = 'GitHub Copilot 凭据刷新失败，请重新导入 GitHub CLI 登录。';
      return { ok: false, reason: 'refresh_failed', message: this.lastRefreshError };
    } finally {
      this.refreshing = false;
    }
  }

  async logout(): Promise<SubscriptionActionResult> {
    try {
      await this.credentialStore.deleteSecret(GITHUB_COPILOT_CONNECTION_SLUG, 'oauth_token');
      this.lastRefreshError = null;
      this.lastStorageError = null;
      return { ok: true };
    } catch {
      return { ok: false, reason: 'storage_failed', message: '删除 GitHub Copilot 本地凭据失败。' };
    }
  }

  async getAccessTokenInternal(): Promise<string | null> {
    const tokens = await resolveOAuthSubscriptionTokens({
      providerType: 'github-copilot',
      slug: GITHUB_COPILOT_CONNECTION_SLUG,
      credentialStore: this.credentialStore,
      now: this.now,
      fetchFn: this.fetchFn,
    });
    return tokens?.access_token ?? null;
  }

  async getTokensInternal(): Promise<OAuthSubscriptionTokens | null> {
    return resolveOAuthSubscriptionTokens({
      providerType: 'github-copilot',
      slug: GITHUB_COPILOT_CONNECTION_SLUG,
      credentialStore: this.credentialStore,
      now: this.now,
      fetchFn: this.fetchFn,
    });
  }

  async hasStoredCredential(): Promise<boolean> {
    return (await this.loadTokens().catch(() => null)) !== null;
  }

  private async loadTokens(): Promise<OAuthSubscriptionTokens | null> {
    const raw = await this.credentialStore.getSecret(GITHUB_COPILOT_CONNECTION_SLUG, 'oauth_token');
    return raw ? parseOAuthSubscriptionTokens(raw) : null;
  }

  private async saveTokens(tokens: OAuthSubscriptionTokens): Promise<void> {
    await this.credentialStore.setSecret(
      GITHUB_COPILOT_CONNECTION_SLUG,
      'oauth_token',
      serializeOAuthSubscriptionTokens(tokens),
    );
  }
}

function isSupportedGitHubCopilotAccountToken(token: string): boolean {
  return token.startsWith('gho_') || token.startsWith('ghu_') || token.startsWith('github_pat_');
}

async function resolveGitHubCliToken(): Promise<string> {
  const result = await execFileAsync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  return result.stdout;
}
