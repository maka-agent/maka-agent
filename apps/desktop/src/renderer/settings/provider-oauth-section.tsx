import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from '@maka/ui/icons';
import {
  type ProviderType,
} from '@maka/core';
import {
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  useMountedRef,
  useToast,
} from '@maka/ui';
import { ProviderLogo } from './provider-display';
import { ProviderConnectionDialog } from './provider-connection-dialog';
import { ClaudeSubscriptionCard } from './claude-subscription-card';
import {
  useOAuthLoginFlow,
  subscriptionActionErrorMessage,
  subscriptionResultMessage,
  type OAuthLoginFlowBridge,
  type SubscriptionSnapshot,
} from './use-oauth-login-flow';

type OAuthCardId = 'claude' | 'codex' | 'github-copilot';
type OAuthServiceId = OAuthCardId;

interface ModelOAuthCard {
  id: OAuthCardId;
  providerType: ProviderType;
  name: string;
  description: string;
  status: 'available';
  statusLabel: string;
}

const MODEL_OAUTH_CARDS: ReadonlyArray<ModelOAuthCard> = [
  {
    id: 'claude',
    providerType: 'claude-subscription',
    name: 'Claude Code',
    description: 'Claude Pro / Max 订阅账号登录。',
    status: 'available',
    statusLabel: '可用',
  },
  {
    id: 'codex',
    providerType: 'openai-codex',
    name: 'OpenAI Codex',
    description: 'ChatGPT Plus / Pro 订阅账号登录。',
    status: 'available',
    statusLabel: '可用',
  },
  {
    id: 'github-copilot',
    providerType: 'github-copilot',
    name: 'GitHub Copilot',
    description: '导入兼容 GitHub 凭据连接 Copilot 订阅。',
    status: 'available',
    statusLabel: '可用',
  },
];

export function ModelOAuthSection(props: { query?: string; onConnectionsChanged(): Promise<void> }) {
  const [openModal, setOpenModal] = useState<OAuthServiceId | null>(null);
  const [claudeCatalogEnabled, setClaudeCatalogEnabled] = useState<boolean | null>(null);
  const toast = useToast();
  const modelOAuthMountedRef = useMountedRef();
  const modelOAuthRefreshTicketRef = useRef(0);
  // PR-OAUTH-CARD-LIVE-STATE-0 (WAWQAQ msg d79fd115 follow-up):
  // before this lift the 3 button cards stayed at the static
  // "可用 / 预览" label even after the user finished the OAuth
  // flow in the modal — there was no parent re-fetch. We now
  // track a runtimeState + email per service so each card can
  // show "已登录" / the account email inline, and we re-fetch
  // every time the modal closes (success OR cancel — the user
  // may have logged out from inside the modal).
  const [cardStates, setCardStates] = useState<Record<OAuthServiceId, SubscriptionSnapshot | null>>({
    claude: null,
    codex: null,
    'github-copilot': null,
  });
  const [cardRefreshError, setCardRefreshError] = useState<string | null>(null);
  const normalizedQuery = props.query?.trim().toLocaleLowerCase() ?? '';
  const visibleCards = MODEL_OAUTH_CARDS
    .filter((card) => card.id !== 'claude' || claudeCatalogEnabled === true)
    .filter((card) => !normalizedQuery || [card.id, card.name, card.description]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));

  async function refreshAllCards() {
    const ticket = modelOAuthRefreshTicketRef.current + 1;
    modelOAuthRefreshTicketRef.current = ticket;
    const claudeGate = await window.maka.claudeSubscription
      .isExperimentalEnabled()
      .then((enabled) => ({ enabled } as const))
      .catch((error: unknown) => ({ error } as const));
    const claudeEnabledForRefresh = 'enabled' in claudeGate
      ? claudeGate.enabled
      : claudeCatalogEnabled === true;
    const cardsToRefresh = MODEL_OAUTH_CARDS
      .filter((card) => card.id !== 'claude' || claudeEnabledForRefresh)
      .filter((card) => !normalizedQuery || [card.id, card.name, card.description]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));
    const results = await Promise.all(
      cardsToRefresh.map(async (card) => {
        try {
          const snapshot = await getSubscriptionSnapshot(card.id);
          return { id: card.id, snapshot } as const;
        } catch (error) {
          return { id: card.id, error } as const;
        }
      }),
    );
    if (!modelOAuthMountedRef.current || modelOAuthRefreshTicketRef.current !== ticket) return false;
    if ('enabled' in claudeGate) setClaudeCatalogEnabled(claudeGate.enabled);
    const failures = results.filter((result) => 'error' in result);
    setCardStates((prev) => {
      const next = { ...prev };
      for (const result of results) {
        if ('snapshot' in result && result.snapshot !== undefined) next[result.id] = result.snapshot;
      }
      return next;
    });
    if ('error' in claudeGate || failures.length > 0) {
      const firstFailure = failures[0];
      const error = 'error' in claudeGate
        ? claudeGate.error
        : firstFailure && 'error' in firstFailure
          ? firstFailure.error
          : undefined;
      const message = error
        ? subscriptionActionErrorMessage(error)
        : '登录服务暂时不可用，请检查网络后重试。';
      setCardRefreshError(message);
      toast.error('刷新 OAuth 登录状态失败', message);
      return false;
    }
    setCardRefreshError(null);
    return true;
  }

  async function refreshAfterModalClose() {
    const refreshed = await refreshAllCards();
    if (!modelOAuthMountedRef.current || !refreshed) return;
    try {
      await props.onConnectionsChanged();
    } catch (error) {
      if (!modelOAuthMountedRef.current) return;
      toast.error('刷新模型连接失败', subscriptionActionErrorMessage(error));
    }
  }

  useEffect(() => {
    void refreshAllCards();
    return () => {
      modelOAuthRefreshTicketRef.current += 1;
    };
  }, []);

  return (
    <div className="providerOAuthCatalog" aria-label="OAuth 登录" data-provider-category="oauth">
      {cardRefreshError && (
        <div className="providerOAuthError" role="alert">
          OAuth 登录状态暂时没刷新成功，已保留上一次状态。{cardRefreshError}
        </div>
      )}
      <div className="providerOAuthGrid">
        {visibleCards.map((card) => {
          const snapshot = cardStates[card.id];
          const runtimeState = snapshot?.runtimeState ?? 'unknown';
          const isLoggedIn =
            runtimeState === 'authenticated' ||
            runtimeState === 'refreshing' ||
            runtimeState === 'quota_unavailable' ||
            runtimeState === 'provider_rejected';
          const liveBadge = isLoggedIn ? '已登录' : card.statusLabel;
          const liveDescription = isLoggedIn && snapshot?.email
            ? snapshot.email
            : card.description;
          return (
            <Item
              key={card.id}
              className="providerCatalogRow providerOAuthCard"
              data-card-id={card.id}
              data-provider={card.providerType}
              data-status="ready"
              data-oauth-status={card.status}
              data-logged-in={isLoggedIn ? 'true' : undefined}
              aria-label={providerOAuthAriaLabel(card, liveBadge, liveDescription)}
              render={<button type="button" onClick={() => setOpenModal(card.id)} />}
            >
              <ItemMedia>
                <ProviderLogo type={card.providerType} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="providerCatalogTitle">{card.name}</ItemTitle>
                <ItemDescription className="providerCatalogDesc providerOAuthCardDescription">{liveDescription}</ItemDescription>
              </ItemContent>
              <ItemActions className="providerCatalogActions">
                <span className="providerCatalogBadge providerOAuthCardBadge">{liveBadge}</span>
                <ChevronRight className="providerCatalogChevron" size={15} aria-hidden="true" />
              </ItemActions>
            </Item>
          );
        })}
      </div>
      {openModal === 'claude' && (
        <ClaudeSubscriptionModal
          onClose={() => {
            setOpenModal(null);
            void refreshAfterModalClose();
          }}
        />
      )}
      {openModal === 'github-copilot' && (
        <GitHubCopilotSubscriptionModal
          onClose={() => {
            setOpenModal(null);
            void refreshAfterModalClose();
          }}
        />
      )}
      {openModal === 'codex' && (
        <SubscriptionLoginModal
          onClose={() => {
            setOpenModal(null);
            // Always re-fetch after the modal closes — the user may
            // have logged in, logged out, or cancelled.
            void refreshAfterModalClose();
          }}
        />
      )}
    </div>
  );
}

function providerOAuthAriaLabel(card: ModelOAuthCard, badge: string, description: string): string {
  return `打开 OAuth 登录：${card.name}，状态：${badge}，${description.replace(/[。.!！？?]+$/u, '')}`;
}

function ClaudeSubscriptionModal(props: { onClose(): void }) {
  return (
    <ProviderConnectionDialog
      title="连接 Claude Code"
      subtitle="登录 Claude Pro / Max 后，会同步成模型连接。"
      providerType="claude-subscription"
      onClose={props.onClose}
    >
      <ClaudeSubscriptionCard />
    </ProviderConnectionDialog>
  );
}

function SubscriptionLoginModal(props: { onClose(): void }) {
  const display: SubscriptionDisplay = {
    name: 'OpenAI Codex',
    shortName: 'Codex',
    detail: '点击下方按钮打开浏览器登录，授权完成后会自动回写到本机（127.0.0.1:1455）。',
  };
  // The whole browser-loopback login/logout controller (getAuthUrl ->
  // openAuthUrl -> refresh -> completeAuthorization, one authRequestId
  // lifecycle, synchronous pending-action guard, cancellation on unmount,
  // localized toast copy) lives in useOAuthLoginFlow so the model connection
  // connection dialog can drive the exact same flow behind its relogin button.
  const flow = useOAuthLoginFlow({
    bridge: window.maka.openAiCodex as unknown as OAuthLoginFlowBridge,
    display: { name: display.name, shortName: display.shortName },
  });

  return (
    <ProviderConnectionDialog
      title={`连接 ${display.name}`}
      subtitle={display.detail}
      providerType="openai-codex"
      onClose={props.onClose}
    >
        <div className="settingsConnectionRow" data-status={flow.runtimeState}>
          <p className="settingsConnectionDetail">
            {presentSnapshotDetail(flow.state, display)}
          </p>
          {flow.stateHint && (
            <small>提示：state 以 <code>{flow.stateHint}</code> 开头。</small>
          )}
          {flow.errorMessage && (
            <small className="settingsErrorText">{flow.errorMessage}</small>
          )}
          <div className="settingsConnectionActions">
            {!flow.isLoggedIn ? (
              <Button
                type="button"
                onClick={() => void flow.startLogin()}
                disabled={flow.actionBusy}
              >
                {flow.pendingAction === 'login' ? '打开浏览器…' : `登录 ${display.shortName}`}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void flow.logout()}
                disabled={flow.actionBusy}
              >
                {flow.pendingAction === 'logout' ? '退出中…' : '退出登录'}
              </Button>
            )}
          </div>
        </div>
    </ProviderConnectionDialog>
  );
}

async function getSubscriptionSnapshot(serviceId: OAuthServiceId): Promise<SubscriptionSnapshot> {
  if (serviceId === 'claude') {
    const state = await window.maka.claudeSubscription.getAccountState();
    return {
      runtimeState: state.runtimeState,
      email: state.profile?.email,
      errorMessage: state.errorMessage,
    };
  }
  if (serviceId === 'github-copilot') {
    return window.maka.githubCopilotSubscription.getAccountState();
  }
  return (await window.maka.openAiCodex.getAccountState()) as SubscriptionSnapshot;
}

function GitHubCopilotSubscriptionModal(props: { onClose(): void }) {
  // The shared login-flow controller owns the snapshot refresh, the
  // synchronous one-shot pending guard, and the unmount safety; Copilot
  // rides it through the direct account flow (one bridge call per action,
  // no browser loopback, no logout confirm) instead of owning a separate
  // pending-action state machine here (#1042).
  const flow = useOAuthLoginFlow({
    bridge: window.maka.githubCopilotSubscription as unknown as OAuthLoginFlowBridge,
    display: { name: 'GitHub Copilot', shortName: 'GitHub Copilot' },
    direct: {
      login: () => window.maka.githubCopilotSubscription.connectExistingLogin(),
      refreshTokens: () => window.maka.githubCopilotSubscription.refreshTokens(),
    },
  });
  const refreshTokens = flow.refreshTokens;
  const loggedIn = flow.state?.runtimeState === 'authenticated' || flow.state?.runtimeState === 'refreshing';
  return (
    <ProviderConnectionDialog
      title="连接 GitHub Copilot"
      subtitle="导入兼容的 GitHub 登录；token 不会暴露给渲染进程。"
      providerType="github-copilot"
      onClose={props.onClose}
    >
      <div className="settingsConnectionRow" data-status={flow.runtimeState}>
        <p className="settingsConnectionDetail">
          {loggedIn
            ? '已导入 GitHub Copilot 订阅账号。'
            : flow.state?.runtimeState === 'refresh_failed' || flow.state?.runtimeState === 'storage_failed'
              ? flow.state.errorMessage
              : '请配置具有 Copilot Requests 权限的 fine-grained PAT；普通 gh auth login 可能不包含该权限。'}
        </p>
        <div className="settingsConnectionActions">
          <Button type="button" onClick={() => void flow.startLogin()} disabled={flow.actionBusy}>
            {flow.pendingAction === 'login' ? '导入中…' : loggedIn ? '重新导入' : '导入兼容凭据'}
          </Button>
          {loggedIn && (
            <>
              <Button type="button" variant="secondary" onClick={() => void refreshTokens?.()} disabled={flow.actionBusy}>
                {flow.pendingAction === 'refresh' ? '验证中…' : '重新验证'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => void flow.logout()} disabled={flow.actionBusy}>
                {flow.pendingAction === 'logout' ? '移除中…' : '移除本地登录'}
              </Button>
            </>
          )}
        </div>
      </div>
    </ProviderConnectionDialog>
  );
}

interface SubscriptionDisplay {
  name: string;
  shortName: string;
  detail: string;
}

function presentSnapshotDetail(state: SubscriptionSnapshot | null, display: SubscriptionDisplay): string {
  if (!state) return '正在加载账号状态…';
  switch (state.runtimeState) {
    case 'not_logged_in':
      return `${display.name} 尚未登录。`;
    case 'authorizing':
      return '请在弹出的浏览器窗口完成登录。';
    case 'authenticated': {
      const parts = ['已登录'];
      if (state.email) parts.push(state.email);
      if (state.plan) parts.push(state.plan);
      return parts.join(' · ');
    }
    case 'refreshing':
      return '正在刷新访问令牌…';
    case 'refresh_failed':
      return subscriptionResultMessage(state.errorMessage, '令牌刷新失败，请重新登录。');
    case 'storage_failed':
      return subscriptionResultMessage(state.errorMessage, `${display.name} 本地凭据读取失败，请重新登录。`);
    case 'quota_unavailable':
    case 'provider_rejected':
      return subscriptionResultMessage(state.errorMessage, `${display.name} 已登录，但当前 provider 状态不可用。`);
  }
  const _exhaustive: never = state.runtimeState;
  return _exhaustive;
}

