import { ipcMain } from 'electron';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { ConnectionStore } from '@maka/storage';
import {
  type ClaudeSubscriptionService,
  isSubscriptionExperimentalEnabled,
} from './oauth/claude-subscription-service.js';
import {
  type CodexSubscriptionService,
  isCodexSubscriptionExperimentalEnabled,
} from './oauth/codex-subscription-service.js';
import {
  type CursorSubscriptionService,
  isCursorSubscriptionExperimentalEnabled,
} from './oauth/cursor-subscription-service.js';
import {
  type AntigravitySubscriptionService,
  isAntigravitySubscriptionExperimentalEnabled,
} from './oauth/antigravity-subscription-service.js';
import {
  CLAUDE_SUBSCRIPTION_CONNECTION_SLUG,
  CODEX_SUBSCRIPTION_CONNECTION_SLUG,
} from './oauth-model-connections-main.js';

interface SubscriptionIpcDeps {
  connectionStore: ConnectionStore;
  claudeSubscription: ClaudeSubscriptionService;
  codexSubscription: CodexSubscriptionService;
  cursorSubscription: CursorSubscriptionService;
  antigravitySubscription: AntigravitySubscriptionService;
  isClaudeSubscriptionAuthenticatedState(
    state: Awaited<ReturnType<ClaudeSubscriptionService['getAccountState']>>,
  ): boolean;
  isCodexSubscriptionAuthenticatedState(
    state: Awaited<ReturnType<CodexSubscriptionService['getAccountState']>>,
  ): boolean;
  syncClaudeSubscriptionConnection(): Promise<LlmConnection | null>;
  syncCodexSubscriptionConnection(): Promise<LlmConnection | null>;
  emitConnectionListChanged(): void;
}

export function registerSubscriptionIpc(deps: SubscriptionIpcDeps): void {
  const experimentalDisabledResponse = {
    ok: false as const,
    reason: 'experimental_disabled' as const,
    message: 'Claude 订阅账号为内部实验，当前未开启。',
  };
  ipcMain.handle('claude-subscription:get-auth-url', async () => {
    if (!isSubscriptionExperimentalEnabled()) {
      return experimentalDisabledResponse;
    }
    return deps.claudeSubscription.getAuthorizationUrl();
  });
  ipcMain.handle(
    'claude-subscription:open-auth-url',
    async (_event, authRequestId: unknown) => {
      if (!isSubscriptionExperimentalEnabled()) return experimentalDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return deps.claudeSubscription.openAuthorizationUrl(authRequestId);
    },
  );
  ipcMain.handle(
    'claude-subscription:complete-authorization',
    async (_event, authRequestId: unknown, pasted: unknown) => {
      if (!isSubscriptionExperimentalEnabled()) return experimentalDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      const result = await deps.claudeSubscription.completeAuthorization(authRequestId, pasted);
      if (result.ok) {
        await deps.syncClaudeSubscriptionConnection();
        deps.emitConnectionListChanged();
      }
      return result;
    },
  );
  ipcMain.handle(
    'claude-subscription:cancel-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isSubscriptionExperimentalEnabled()) return { ok: true as const };
      deps.claudeSubscription.cancelAuthorization(
        typeof authRequestId === 'string' ? authRequestId : undefined,
      );
      return { ok: true as const };
    },
  );
  ipcMain.handle('claude-subscription:get-account-state', async () => {
    if (!isSubscriptionExperimentalEnabled()) {
      return {
        provider: 'claude-subscription' as const,
        runtimeState: 'not_logged_in' as const,
      };
    }
    const state = await deps.claudeSubscription.getAccountState();
    if (deps.isClaudeSubscriptionAuthenticatedState(state)) {
      await deps.syncClaudeSubscriptionConnection();
    }
    return state;
  });
  ipcMain.handle('claude-subscription:refresh-quota', async () => {
    if (!isSubscriptionExperimentalEnabled()) return experimentalDisabledResponse;
    return deps.claudeSubscription.refreshQuota();
  });
  ipcMain.handle('claude-subscription:refresh-tokens', async () => {
    if (!isSubscriptionExperimentalEnabled()) return experimentalDisabledResponse;
    const result = await deps.claudeSubscription.refreshTokens();
    if (result.ok) {
      await deps.syncClaudeSubscriptionConnection();
      deps.emitConnectionListChanged();
    }
    return result;
  });
  ipcMain.handle('claude-subscription:logout', async () => {
    const result = await deps.claudeSubscription.logout();
    const existing = await deps.connectionStore.get(CLAUDE_SUBSCRIPTION_CONNECTION_SLUG);
    if (existing) {
      await deps.connectionStore.update(existing.slug, {
        enabled: false,
        lastTestStatus: 'needs_reauth',
        lastTestAt: new Date().toISOString(),
        lastTestMessage: 'Claude OAuth 已退出登录。',
      });
      deps.emitConnectionListChanged();
    }
    return result;
  });
  ipcMain.handle('claude-subscription:is-experimental-enabled', async () =>
    isSubscriptionExperimentalEnabled(),
  );

  const codexDisabledResponse = {
    ok: false as const,
    reason: 'experimental_disabled' as const,
    message: 'OpenAI Codex 订阅账号为内部实验，当前未开启。',
  };
  ipcMain.handle('codex-subscription:is-experimental-enabled', async () =>
    isCodexSubscriptionExperimentalEnabled(),
  );
  ipcMain.handle('codex-subscription:get-auth-url', async () => {
    if (!isCodexSubscriptionExperimentalEnabled()) return codexDisabledResponse;
    return deps.codexSubscription.getAuthorizationUrl();
  });
  ipcMain.handle(
    'codex-subscription:open-auth-url',
    async (_event, authRequestId: unknown) => {
      if (!isCodexSubscriptionExperimentalEnabled()) return codexDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return deps.codexSubscription.openAuthorizationUrl(authRequestId);
    },
  );
  ipcMain.handle(
    'codex-subscription:complete-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isCodexSubscriptionExperimentalEnabled()) return codexDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      const result = await deps.codexSubscription.completeAuthorization(authRequestId);
      if (result.ok) {
        await deps.syncCodexSubscriptionConnection();
        deps.emitConnectionListChanged();
      }
      return result;
    },
  );
  ipcMain.handle(
    'codex-subscription:cancel-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isCodexSubscriptionExperimentalEnabled()) return { ok: true as const };
      deps.codexSubscription.cancelAuthorization(
        typeof authRequestId === 'string' ? authRequestId : undefined,
      );
      return { ok: true as const };
    },
  );
  ipcMain.handle('codex-subscription:get-account-state', async () => {
    if (!isCodexSubscriptionExperimentalEnabled()) {
      return {
        provider: 'codex-subscription' as const,
        runtimeState: 'not_logged_in' as const,
      };
    }
    const state = await deps.codexSubscription.getAccountState();
    if (deps.isCodexSubscriptionAuthenticatedState(state)) {
      await deps.syncCodexSubscriptionConnection();
    }
    return state;
  });
  ipcMain.handle('codex-subscription:refresh-tokens', async () => {
    if (!isCodexSubscriptionExperimentalEnabled()) return codexDisabledResponse;
    const result = await deps.codexSubscription.refreshTokens();
    if (result.ok) {
      await deps.syncCodexSubscriptionConnection();
      deps.emitConnectionListChanged();
    }
    return result;
  });
  ipcMain.handle('codex-subscription:logout', async () => {
    const result = await deps.codexSubscription.logout();
    const existing = await deps.connectionStore.get(CODEX_SUBSCRIPTION_CONNECTION_SLUG);
    if (existing) {
      await deps.connectionStore.update(existing.slug, {
        enabled: false,
        lastTestStatus: 'needs_reauth',
        lastTestAt: new Date().toISOString(),
        lastTestMessage: 'Codex OAuth 已退出登录。',
      });
      deps.emitConnectionListChanged();
    }
    return result;
  });

  const cursorDisabledResponse = {
    ok: false as const,
    reason: 'experimental_disabled' as const,
    message: 'Cursor 订阅账号为内部实验，当前未开启。',
  };
  ipcMain.handle('cursor-subscription:is-experimental-enabled', async () =>
    isCursorSubscriptionExperimentalEnabled(),
  );
  ipcMain.handle('cursor-subscription:get-auth-url', async () => {
    if (!isCursorSubscriptionExperimentalEnabled()) return cursorDisabledResponse;
    return deps.cursorSubscription.getAuthorizationUrl();
  });
  ipcMain.handle(
    'cursor-subscription:open-auth-url',
    async (_event, authRequestId: unknown) => {
      if (!isCursorSubscriptionExperimentalEnabled()) return cursorDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return deps.cursorSubscription.openAuthorizationUrl(authRequestId);
    },
  );
  ipcMain.handle(
    'cursor-subscription:complete-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isCursorSubscriptionExperimentalEnabled()) return cursorDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return deps.cursorSubscription.completeAuthorization(authRequestId);
    },
  );
  ipcMain.handle(
    'cursor-subscription:cancel-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isCursorSubscriptionExperimentalEnabled()) return { ok: true as const };
      deps.cursorSubscription.cancelAuthorization(
        typeof authRequestId === 'string' ? authRequestId : undefined,
      );
      return { ok: true as const };
    },
  );
  ipcMain.handle('cursor-subscription:get-account-state', async () => {
    if (!isCursorSubscriptionExperimentalEnabled()) {
      return {
        provider: 'cursor-subscription' as const,
        runtimeState: 'not_logged_in' as const,
      };
    }
    return deps.cursorSubscription.getAccountState();
  });
  ipcMain.handle('cursor-subscription:refresh-tokens', async () => {
    if (!isCursorSubscriptionExperimentalEnabled()) return cursorDisabledResponse;
    return deps.cursorSubscription.refreshTokens();
  });
  ipcMain.handle('cursor-subscription:logout', async () => {
    return deps.cursorSubscription.logout();
  });

  const antigravityDisabledResponse = {
    ok: false as const,
    reason: 'experimental_disabled' as const,
    message: 'Google Antigravity 订阅账号为内部实验，当前未开启。',
  };
  ipcMain.handle('antigravity-subscription:is-experimental-enabled', async () =>
    isAntigravitySubscriptionExperimentalEnabled(),
  );
  ipcMain.handle('antigravity-subscription:get-auth-url', async () => {
    if (!isAntigravitySubscriptionExperimentalEnabled()) return antigravityDisabledResponse;
    return deps.antigravitySubscription.getAuthorizationUrl();
  });
  ipcMain.handle(
    'antigravity-subscription:open-auth-url',
    async (_event, authRequestId: unknown) => {
      if (!isAntigravitySubscriptionExperimentalEnabled()) return antigravityDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return deps.antigravitySubscription.openAuthorizationUrl(authRequestId);
    },
  );
  ipcMain.handle(
    'antigravity-subscription:complete-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isAntigravitySubscriptionExperimentalEnabled()) return antigravityDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return deps.antigravitySubscription.completeAuthorization(authRequestId);
    },
  );
  ipcMain.handle(
    'antigravity-subscription:cancel-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isAntigravitySubscriptionExperimentalEnabled()) return { ok: true as const };
      deps.antigravitySubscription.cancelAuthorization(
        typeof authRequestId === 'string' ? authRequestId : undefined,
      );
      return { ok: true as const };
    },
  );
  ipcMain.handle('antigravity-subscription:get-account-state', async () => {
    if (!isAntigravitySubscriptionExperimentalEnabled()) {
      return {
        provider: 'antigravity-subscription' as const,
        status: 'preview' as const,
        runtimeState: 'not_logged_in' as const,
      };
    }
    return deps.antigravitySubscription.getAccountState();
  });
  ipcMain.handle('antigravity-subscription:refresh-tokens', async () => {
    if (!isAntigravitySubscriptionExperimentalEnabled()) return antigravityDisabledResponse;
    return deps.antigravitySubscription.refreshTokens();
  });
  ipcMain.handle('antigravity-subscription:logout', async () => {
    return deps.antigravitySubscription.logout();
  });
}
