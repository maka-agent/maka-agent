import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from '@maka/ui/icons';
import {
  generalizedErrorMessageChinese,
  redactSecrets,
  type ProviderType,
  type SubscriptionAccountState,
} from '@maka/core';
import {
  Chip,
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  RelativeTime,
  Textarea,
  useToast,
} from '@maka/ui';
import { type StatusTone } from './settings-status-badge';
import { ProviderLogo } from './provider-display';
import { ProviderSheet } from './provider-config-sheet';

type OAuthCardId = 'claude' | 'codex' | 'antigravity' | 'cursor';
type OAuthServiceId = OAuthCardId;
type BrowserOAuthServiceId = Exclude<OAuthServiceId, 'claude'>;

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
    providerType: 'codex-subscription',
    name: 'OpenAI Codex',
    description: 'ChatGPT Plus / Pro 订阅账号登录。',
    status: 'available',
    statusLabel: '可用',
  },
  {
    id: 'antigravity',
    providerType: 'gemini-cli',
    name: 'Google Antigravity',
    description: 'Google 账号登录 Gemini。',
    status: 'available',
    statusLabel: '预览',
  },
  {
    id: 'cursor',
    providerType: 'openai-compatible',
    name: 'Cursor',
    description: 'Cursor 订阅账号登录。',
    status: 'available',
    statusLabel: '可用',
  },
];

export function ModelOAuthSection(props: { onConnectionsChanged(): Promise<void> }) {
  const [openModal, setOpenModal] = useState<OAuthServiceId | null>(null);
  const toast = useToast();
  const modelOAuthMountedRef = useRef(false);
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
    cursor: null,
    antigravity: null,
  });
  const [cardRefreshError, setCardRefreshError] = useState<string | null>(null);

  async function refreshAllCards() {
    const ticket = modelOAuthRefreshTicketRef.current + 1;
    modelOAuthRefreshTicketRef.current = ticket;
    const results = await Promise.all(
      MODEL_OAUTH_CARDS.map(async (card) => {
        try {
          const snapshot = await getSubscriptionSnapshot(card.id);
          return { id: card.id, snapshot } as const;
        } catch (error) {
          return { id: card.id, error } as const;
        }
      }),
    );
    if (!modelOAuthMountedRef.current || modelOAuthRefreshTicketRef.current !== ticket) return false;
    const failures = results.filter((result) => 'error' in result);
    setCardStates((prev) => {
      const next = { ...prev };
      for (const result of results) {
        if ('snapshot' in result && result.snapshot !== undefined) next[result.id] = result.snapshot;
      }
      return next;
    });
    if (failures.length > 0) {
      const firstFailure = failures[0];
      const message = firstFailure && 'error' in firstFailure
        ? subscriptionActionErrorMessage(firstFailure.error)
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
    modelOAuthMountedRef.current = true;
    void refreshAllCards();
    return () => {
      modelOAuthMountedRef.current = false;
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
        {MODEL_OAUTH_CARDS.map((card) => {
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
              className="providerCatalogRow providerOAuthCard rounded-none"
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
      {openModal !== null && openModal !== 'claude' && (
        <SubscriptionLoginModal
          serviceId={openModal}
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

/**
 * Inline modal that drives a Codex / Cursor / Antigravity OAuth
 * flow against the matching `window.maka.<service>Subscription`
 * bridge. Mirrors the ClaudeSubscriptionCard pattern (Settings →
 * 账号) but does NOT expose a paste-code field — these flows are
 * loopback (Codex / Antigravity) or polling (Cursor) so the
 * browser handoff is enough.
 *
 * Tokens never enter the renderer; this component reads only
 * account-state snapshots returned by getAccountState().
 */
function ClaudeSubscriptionModal(props: { onClose(): void }) {
  return (
    <ProviderSheet onClose={props.onClose} ariaLabel="Claude Code 登录" dataSubscription="claude">
        <header className="providerConfigHeader">
          <div>
            <h3>Claude Code</h3>
            <p>登录 Claude Pro / Max 后，会同步成模型连接。</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={props.onClose}
            aria-label="关闭"
          >
            ×
          </Button>
        </header>
        <ClaudeSubscriptionCard />
      </ProviderSheet>
    );
}

function SubscriptionLoginModal(props: { serviceId: BrowserOAuthServiceId; onClose(): void }) {
  const toast = useToast();
  const bridge = pickSubscriptionBridge(props.serviceId);
  const [state, setState] = useState<SubscriptionSnapshot | null>(null);
  const [authRequestId, setAuthRequestId] = useState<string | null>(null);
  const [stateHint, setStateHint] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<BrowserSubscriptionPendingAction | null>(null);
  const pendingActionRef = useRef<BrowserSubscriptionPendingAction | null>(null);
  const authRequestIdRef = useRef<string | null>(null);
  const browserSubscriptionMountedRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const display = subscriptionDisplay(props.serviceId);

  async function refresh(): Promise<boolean> {
    try {
      const next = (await bridge.getAccountState()) as SubscriptionSnapshot;
      if (!browserSubscriptionMountedRef.current) return false;
      setState(next);
      setErrorMessage(null);
    } catch (error) {
      if (!browserSubscriptionMountedRef.current) return false;
      const message = subscriptionActionErrorMessage(error);
      toast.error('刷新登录状态失败', message);
      setErrorMessage(message);
    }
    return true;
  }

  useEffect(() => {
    browserSubscriptionMountedRef.current = true;
    void refresh();
    return () => {
      browserSubscriptionMountedRef.current = false;
      pendingActionRef.current = null;
      const pendingAuthRequestId = authRequestIdRef.current;
      authRequestIdRef.current = null;
      if (pendingAuthRequestId) void bridge.cancelAuthorization(pendingAuthRequestId);
    };
  }, []);

  function beginPendingAction(action: BrowserSubscriptionPendingAction): boolean {
    if (pendingActionRef.current !== null) return false;
    pendingActionRef.current = action;
    setPendingAction(action);
    return true;
  }

  function finishPendingAction() {
    pendingActionRef.current = null;
    if (browserSubscriptionMountedRef.current) setPendingAction(null);
  }

  async function startLogin() {
    if (!beginPendingAction('login')) return;
    setErrorMessage(null);
    try {
      const payload = await bridge.getAuthUrl();
      if ('ok' in payload) {
        if (!browserSubscriptionMountedRef.current) return;
        const failureMessage = payload.ok ? '请稍后再试。' : subscriptionResultMessage(payload.message, '无法开始登录，请稍后再试。');
        toast.error('无法开始登录', failureMessage);
        setErrorMessage(failureMessage);
        return;
      }
      authRequestIdRef.current = payload.authRequestId;
      if (!browserSubscriptionMountedRef.current) {
        authRequestIdRef.current = null;
        void bridge.cancelAuthorization(payload.authRequestId);
        return;
      }
      setAuthRequestId(payload.authRequestId);
      setStateHint(payload.stateHint);
      const opened = await bridge.openAuthUrl(payload.authRequestId);
      if (!browserSubscriptionMountedRef.current) return;
      if (!opened.ok) {
        const message = subscriptionResultMessage(opened.message, '无法打开浏览器，请稍后重试。');
        toast.error('无法打开浏览器', message);
        setErrorMessage(message);
        void bridge.cancelAuthorization(payload.authRequestId);
        authRequestIdRef.current = null;
        setAuthRequestId(null);
        setStateHint(null);
        return;
      }
      const refreshed = await refresh();
      if (!browserSubscriptionMountedRef.current || !refreshed) return;
      // Loopback / polling — wait for the backend to complete.
      const result = await bridge.completeAuthorization(payload.authRequestId);
      if (!browserSubscriptionMountedRef.current) return;
      authRequestIdRef.current = null;
      setAuthRequestId(null);
      setStateHint(null);
      if (result.ok) {
        toast.success('登录成功', `${display.name} 已绑定本机。`);
        await refresh();
      } else {
        const message = subscriptionResultMessage(result.message, '登录未完成，请重新打开浏览器授权。');
        toast.error('登录未完成', message);
        setErrorMessage(message);
      }
    } catch (error) {
      if (!browserSubscriptionMountedRef.current) return;
      const pendingAuthRequestId = authRequestIdRef.current;
      authRequestIdRef.current = null;
      if (pendingAuthRequestId) void bridge.cancelAuthorization(pendingAuthRequestId);
      setAuthRequestId(null);
      setStateHint(null);
      const message = subscriptionActionErrorMessage(error);
      toast.error('登录失败', message);
      setErrorMessage(message);
    } finally {
      finishPendingAction();
    }
  }

  async function logout() {
    if (!beginPendingAction('logout')) return;
    try {
      const ok = await toast.confirm({
        title: `退出 ${display.name} 登录？`,
        description: '将删除本机保存的订阅凭据，之后需要重新登录才能继续使用这些 OAuth 模型。',
        confirmLabel: '退出登录',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!ok) return;
      const result = await bridge.logout();
      if (!browserSubscriptionMountedRef.current) return;
      if (result.ok) {
        toast.success('已退出登录', '本地凭据已清除。');
        await refresh();
      } else {
        toast.error('退出失败', subscriptionResultMessage(result.message, '退出登录失败，请稍后重试。'));
      }
    } catch (error) {
      if (!browserSubscriptionMountedRef.current) return;
      toast.error('退出失败', subscriptionActionErrorMessage(error));
    } finally {
      finishPendingAction();
    }
  }

  const runtimeState = state?.runtimeState ?? 'loading';
  const isLoggedIn = runtimeState === 'authenticated' || runtimeState === 'refreshing';
  const actionBusy = pendingAction !== null;

  return (
    <ProviderSheet onClose={props.onClose} ariaLabel={`${display.name} 登录`} dataSubscription={props.serviceId}>
        <header className="providerConfigHeader">
          <div>
            <h3>{display.name}</h3>
            <p>{display.detail}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={props.onClose}
            aria-label="关闭"
          >
            ×
          </Button>
        </header>
        <div className="settingsConnectionRow" data-status={runtimeState}>
          <p className="settingsConnectionDetail">
            {presentSnapshotDetail(state, display)}
          </p>
          {stateHint && (
            <small>提示：state 以 <code>{stateHint}</code> 开头。</small>
          )}
          {errorMessage && (
            <small className="settingsErrorText">{errorMessage}</small>
          )}
          <div className="settingsConnectionActions">
            {!isLoggedIn ? (
              <Button
                type="button"
                onClick={() => void startLogin()}
                disabled={actionBusy}
              >
                {pendingAction === 'login' ? '打开浏览器…' : `登录 ${display.shortName}`}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void logout()}
                disabled={actionBusy}
              >
                {pendingAction === 'logout' ? '退出中…' : '退出登录'}
              </Button>
            )}
          </div>
        </div>
      </ProviderSheet>
    );
}

type BrowserSubscriptionPendingAction = 'login' | 'logout';

interface SubscriptionSnapshot {
  runtimeState:
    | 'not_logged_in'
    | 'authorizing'
    | 'authenticated'
    | 'refreshing'
    | 'refresh_failed'
    | 'storage_failed'
    | 'quota_unavailable'
    | 'provider_rejected';
  email?: string;
  plan?: string;
  status?: 'preview';
  errorMessage?: string;
}

interface SubscriptionBridge {
  getAuthUrl(): Promise<
    { authRequestId: string; stateHint: string } | { ok: boolean; reason?: string; message: string }
  >;
  openAuthUrl(authRequestId: string): Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
  completeAuthorization(authRequestId: string): Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
  cancelAuthorization(authRequestId?: string): Promise<{ ok: true }>;
  getAccountState(): Promise<unknown>;
  logout(): Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
}

function subscriptionActionErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  return subscriptionResultMessage(message, '登录服务暂时不可用，请检查网络后重试。');
}

function subscriptionResultMessage(message: string | undefined, fallback: string): string {
  const raw = redactSecrets(message ?? '').trim();
  if (!raw) return fallback;
  const classified = generalizedErrorMessageChinese(new Error(raw), '');
  if (classified) return classified;
  return /[\u4e00-\u9fff]/.test(raw) ? raw : fallback;
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
  return (await pickSubscriptionBridge(serviceId).getAccountState()) as SubscriptionSnapshot;
}

function pickSubscriptionBridge(serviceId: BrowserOAuthServiceId): SubscriptionBridge {
  switch (serviceId) {
    case 'codex':
      return window.maka.codexSubscription as unknown as SubscriptionBridge;
    case 'cursor':
      return window.maka.cursorSubscription as unknown as SubscriptionBridge;
    case 'antigravity':
      return window.maka.antigravitySubscription as unknown as SubscriptionBridge;
  }
}

interface SubscriptionDisplay {
  name: string;
  shortName: string;
  detail: string;
}

function subscriptionDisplay(serviceId: BrowserOAuthServiceId): SubscriptionDisplay {
  switch (serviceId) {
    case 'codex':
      return {
        name: 'OpenAI Codex',
        shortName: 'Codex',
        detail: '点击下方按钮打开浏览器登录，授权完成后会自动回写到本机（127.0.0.1:1455）。',
      };
    case 'cursor':
      return {
        name: 'Cursor',
        shortName: 'Cursor',
        detail: '点击下方按钮打开浏览器登录；Maka 会自动等待 Cursor 后端确认凭据。',
      };
    case 'antigravity':
      return {
        name: 'Google Antigravity',
        shortName: 'Antigravity',
        // OAuth flow + token persistence + IPC handlers ARE wired
        // and tested; the only thing gating real login is the
        // Google client_id constant (no public upstream plugin source
        // exposes it). When the user clicks 登录 the service surfaces
        // that exact reason via its envelope, so this card-level
        // copy stays factual without claiming the whole thing is
        // unimplemented.
        detail: '使用 Google 账号登录给 Gemini 模型。当前为预览状态：需要 Google client_id 后才能完成登录。',
      };
  }
  const _exhaustive: never = serviceId;
  return _exhaustive;
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

function ClaudeSubscriptionCard() {
  const [experimentalEnabled, setExperimentalEnabled] = useState<boolean | null>(null);
  const [experimentalGateError, setExperimentalGateError] = useState<string | null>(null);
  const [state, setState] = useState<SubscriptionAccountState | null>(null);
  const [pendingAction, setPendingAction] = useState<ClaudeSubscriptionPendingAction | null>(null);
  const pendingActionRef = useRef<ClaudeSubscriptionPendingAction | null>(null);
  const [authRequestId, setAuthRequestId] = useState<string | null>(null);
  const claudeAuthRequestIdRef = useRef<string | null>(null);
  const [stateHint, setStateHint] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const toast = useToast();
  // PR-FE-BUG-HUNT-1 (kenji bug-hunt 2026-06-24): ClaudeSubscriptionCard
  // launches a browser OAuth flow that takes seconds-to-minutes to
  // complete. Closing the Settings modal while a `startLogin` /
  // `submitPaste` / `logout` / `refreshQuota` call was in flight
  // would `setState` on an unmounted component (loud warning in dev,
  // masks real bugs in prod). Mirror the `mountedRef` pattern other
  // settings sub-cards in this file use.
  const claudeCardMountedRef = useRef(true);
  useEffect(() => {
    claudeCardMountedRef.current = true;
    return () => {
      claudeCardMountedRef.current = false;
      const pendingAuthRequestId = claudeAuthRequestIdRef.current;
      claudeAuthRequestIdRef.current = null;
      if (pendingAuthRequestId) void window.maka.claudeSubscription.cancelAuthorization(pendingAuthRequestId);
    };
  }, []);

  const refresh = async () => {
    try {
      const next = await window.maka.claudeSubscription.getAccountState();
      if (!claudeCardMountedRef.current) return;
      setState(next);
      setPasteError(null);
    } catch (error) {
      const message = subscriptionActionErrorMessage(error);
      if (!claudeCardMountedRef.current) return;
      toast.error('刷新登录状态失败', message);
      setPasteError(message);
    }
  };

  const refreshExperimentalGate = async () => {
    try {
      const flag = await window.maka.claudeSubscription.isExperimentalEnabled();
      if (!claudeCardMountedRef.current) return;
      setExperimentalEnabled(flag);
      setExperimentalGateError(null);
      if (flag) void refresh();
    } catch (error) {
      const message = subscriptionActionErrorMessage(error);
      if (!claudeCardMountedRef.current) return;
      setExperimentalEnabled(null);
      setExperimentalGateError(message);
      toast.error('读取 Claude 登录开关失败', message);
    }
  };

  useEffect(() => {
    // kenji `1da909d5` blocking concern: Anthropic does not permit
    // third-party developers to offer Claude.ai login on behalf of
    // users. Until product/legal sign-off, gate the whole UI behind
    // `MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL=1`. Loading state also
    // renders nothing — no teasing UI.
    let cancelled = false;
    void window.maka.claudeSubscription
      .isExperimentalEnabled()
      .then((flag) => {
        if (cancelled) return;
        setExperimentalEnabled(flag);
        setExperimentalGateError(null);
        if (flag) void refresh();
      })
      .catch((error) => {
        if (cancelled) return;
        const message = subscriptionActionErrorMessage(error);
        setExperimentalEnabled(null);
        setExperimentalGateError(message);
        toast.error('读取 Claude 登录开关失败', message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (experimentalGateError) {
    return (
      <div className="settingsConnectionRow" data-status="error">
        <div className="settingsConnectionRowHead">
          <div className="settingsConnectionRowText">
            <div className="settingsConnectionRowName">
              <strong>Claude 订阅 (Pro / Max)</strong>
            </div>
            <small>无法确认 Claude OAuth 是否可用。没有登录动作会被执行。</small>
          </div>
          <Chip variant="destructive">读取失败</Chip>
        </div>
        <small className="settingsErrorText" role="alert">
          Claude 登录开关读取失败：{experimentalGateError}
        </small>
        <div className="settingsConnectionActions">
          <Button
            type="button"
            onClick={() => void refreshExperimentalGate()}
          >
            重试
          </Button>
        </div>
      </div>
    );
  }

  if (experimentalEnabled !== true) {
    return null;
  }

  function beginPendingAction(action: ClaudeSubscriptionPendingAction): boolean {
    if (pendingActionRef.current !== null) return false;
    pendingActionRef.current = action;
    setPendingAction(action);
    return true;
  }

  function finishPendingAction() {
    pendingActionRef.current = null;
    setPendingAction(null);
  }

  async function startLogin() {
    if (!beginPendingAction('login')) return;
    try {
      // kenji `027c93c0` + xuan `2e5be5a`: getAuthUrl now returns
      // a union — `AuthorizationUrlPayload` on success, or a
      // `SubscriptionActionResult` envelope when fail-closed
      // (e.g. experimental flag flipped off after the card
      // mounted). Discriminate by checking for the `ok` field; the
      // envelope variant has it, the success payload does not.
      const payload = await window.maka.claudeSubscription.getAuthUrl();
      if ('ok' in payload) {
        if (!claudeCardMountedRef.current) return;
        // Envelope variant. `ok: true` shouldn't happen for
        // getAuthUrl (success returns the payload, not an envelope),
        // so this branch is the failure case in practice.
        toast.error('无法开始登录', payload.ok ? '请稍后再试。' : subscriptionResultMessage(payload.message, '无法开始登录，请稍后再试。'));
        return;
      }
      claudeAuthRequestIdRef.current = payload.authRequestId;
      if (!claudeCardMountedRef.current) {
        claudeAuthRequestIdRef.current = null;
        void window.maka.claudeSubscription.cancelAuthorization(payload.authRequestId);
        return;
      }
      setAuthRequestId(payload.authRequestId);
      setStateHint(payload.stateHint);
      setPasteValue('');
      setPasteError(null);
      // kenji `1da909d5` hardening: pass the opaque authRequestId,
      // NOT the URL. Main looks up the URL it generated.
      const opened = await window.maka.claudeSubscription.openAuthUrl(payload.authRequestId);
      if (!claudeCardMountedRef.current) return;
      if (!opened.ok) {
        toast.error('无法打开浏览器', subscriptionResultMessage(opened.message, '无法打开浏览器，请稍后重试。'));
        claudeAuthRequestIdRef.current = null;
        void window.maka.claudeSubscription.cancelAuthorization(payload.authRequestId);
        setAuthRequestId(null);
        setStateHint(null);
      }
      await refresh();
    } catch (error) {
      const pendingAuthRequestId = claudeAuthRequestIdRef.current;
      claudeAuthRequestIdRef.current = null;
      if (pendingAuthRequestId) void window.maka.claudeSubscription.cancelAuthorization(pendingAuthRequestId);
      const message = subscriptionActionErrorMessage(error);
      if (!claudeCardMountedRef.current) return;
      setAuthRequestId(null);
      setStateHint(null);
      toast.error('无法开始登录', message);
      setPasteError(message);
    } finally {
      if (claudeCardMountedRef.current) finishPendingAction();
    }
  }

  async function submitPaste() {
    if (!authRequestId) return;
    if (!beginPendingAction('submit')) return;
    setPasteError(null);
    try {
      const result = await window.maka.claudeSubscription.completeAuthorization(
        authRequestId,
        pasteValue,
      );
      if (!claudeCardMountedRef.current) return;
      if (result.ok) {
        toast.success('登录成功', '已绑定 Claude 订阅。');
        claudeAuthRequestIdRef.current = null;
        setAuthRequestId(null);
        setStateHint(null);
        setPasteValue('');
        await refresh();
      } else {
        setPasteError(subscriptionResultMessage(result.message, '授权码提交失败，请重新登录后再试。'));
      }
    } catch (error) {
      const message = subscriptionActionErrorMessage(error);
      if (!claudeCardMountedRef.current) return;
      toast.error('授权码提交失败', message);
      setPasteError(message);
    } finally {
      if (claudeCardMountedRef.current) finishPendingAction();
    }
  }

  async function cancelLogin() {
    if (!authRequestId) return;
    if (!beginPendingAction('cancel')) return;
    try {
      await window.maka.claudeSubscription.cancelAuthorization(authRequestId);
      if (!claudeCardMountedRef.current) return;
      claudeAuthRequestIdRef.current = null;
      setAuthRequestId(null);
      setStateHint(null);
      setPasteValue('');
      setPasteError(null);
      await refresh();
    } catch (error) {
      if (!claudeCardMountedRef.current) return;
      toast.error('取消登录失败', subscriptionActionErrorMessage(error));
    } finally {
      if (claudeCardMountedRef.current) finishPendingAction();
    }
  }

  async function logout() {
    if (!beginPendingAction('logout')) return;
    try {
      const ok = await toast.confirm({
        title: '退出 Claude Code 登录？',
        description: '将删除本机保存的订阅凭据，之后需要重新登录才能继续使用 Claude OAuth 模型。',
        confirmLabel: '退出登录',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!ok) return;
      const result = await window.maka.claudeSubscription.logout();
      if (!claudeCardMountedRef.current) return;
      if (result.ok) {
        toast.success('已退出登录', '本地凭据已清除。');
        await refresh();
      } else {
        toast.error('退出失败', subscriptionResultMessage(result.message, '退出登录失败，请稍后重试。'));
      }
    } catch (error) {
      if (!claudeCardMountedRef.current) return;
      toast.error('退出失败', subscriptionActionErrorMessage(error));
    } finally {
      if (claudeCardMountedRef.current) finishPendingAction();
    }
  }

  async function refreshQuota() {
    if (!beginPendingAction('quota')) return;
    try {
      await window.maka.claudeSubscription.refreshQuota();
      if (!claudeCardMountedRef.current) return;
      await refresh();
    } catch (error) {
      if (!claudeCardMountedRef.current) return;
      toast.error('刷新配额失败', subscriptionActionErrorMessage(error));
    } finally {
      if (claudeCardMountedRef.current) finishPendingAction();
    }
  }

  // Closed-state render mapping per the runtime state enum.
  const presentation = state ? presentSubscriptionState(state) : { label: '加载中…', tone: 'neutral' as const, detail: '' };
  const canStartClaudeLogin =
    state?.runtimeState === 'not_logged_in' ||
    state?.runtimeState === 'refresh_failed' ||
    state?.runtimeState === 'storage_failed';
  const claudeLoginPending = authRequestId !== null || state?.runtimeState === 'authorizing';
  const actionBusy = pendingAction !== null;

  return (
    <>
    <h3 className="settingsSubheading">订阅</h3>
    <div className="settingsConnectionRow" data-status={state?.runtimeState ?? 'loading'}>
      <div className="settingsConnectionRowHead">
        <div className="settingsConnectionRowText">
          <div className="settingsConnectionRowName">
            <strong>Claude 订阅 (Pro / Max)</strong>
          </div>
          <small>
            通过 Anthropic 官方 OAuth 登录使用订阅配额。
            {state?.profile?.email ? ` · ${state.profile.email}` : ''}
          </small>
        </div>
        <Chip variant={presentation.tone}>
          {presentation.label}
        </Chip>
      </div>
      <p className="settingsConnectionDetail">{presentation.detail}</p>
      {pasteError && !authRequestId && (
        <small className="settingsErrorText" role="alert">{pasteError}</small>
      )}

      {state?.quota && (state.quota.fiveHour || state.quota.sevenDay) && (
        <div className="settingsQuotaSection">
          {state.quota.fiveHour && (
            <div className="settingsQuotaRow">
              <span>5 小时窗口</span>
              <span>{state.quota.fiveHour.utilization}%</span>
            </div>
          )}
          {state.quota.sevenDay && (
            <div className="settingsQuotaRow">
              <span>7 天窗口</span>
              <span>{state.quota.sevenDay.utilization}%</span>
            </div>
          )}
          <small className="settingsHelpText">
            数据更新于 <RelativeTime ts={state.quota.fetchedAt} className="settingsHelpInlineTime" />
          </small>
        </div>
      )}

      <div className="settingsConnectionActions">
        {canStartClaudeLogin || claudeLoginPending ? (
          <Button
            type="button"
            onClick={() => void startLogin()}
            disabled={actionBusy || claudeLoginPending}
          >
            {pendingAction === 'login'
              ? '打开浏览器…'
              : claudeLoginPending
              ? '登录中…'
              : state?.runtimeState === 'refresh_failed' || state?.runtimeState === 'storage_failed'
                ? '重新登录'
                : '登录订阅'}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              onClick={() => void refreshQuota()}
              disabled={actionBusy}
            >
              {pendingAction === 'quota' ? '刷新中…' : '刷新配额'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void logout()}
              disabled={actionBusy}
            >
              {pendingAction === 'logout' ? '退出中…' : '退出登录'}
            </Button>
          </>
        )}
      </div>

      {authRequestId && (
        <div className="settingsOauthPastePanel" role="region" aria-label="粘贴授权码">
          <p>
            在 Claude.ai 完成登录后，会跳转到 Anthropic 控制台显示一段授权码（含 <code>#</code> 分隔符），
            把它粘贴到下面：
          </p>
          {stateHint && (
            <small>提示：你的 state 以 <code>{stateHint}</code> 开头。</small>
          )}
          <Textarea
            value={pasteValue}
            onChange={(event) => setPasteValue(event.currentTarget.value)}
            placeholder="粘贴授权码（格式：xxx#yyy）"
            aria-label="授权码"
            rows={3}
            spellCheck={false}
            autoComplete="off"
          />
          {pasteError && <small className="settingsErrorText">{pasteError}</small>}
          <div className="settingsConnectionActions">
            <Button
              type="button"
              onClick={() => void submitPaste()}
              disabled={actionBusy || pasteValue.trim().length === 0}
            >
              {pendingAction === 'submit' ? '提交中…' : '提交授权码'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void cancelLogin()}
              disabled={actionBusy}
            >
              {pendingAction === 'cancel' ? '取消中…' : '取消'}
            </Button>
          </div>
        </div>
      )}
    </div>
    </>
  );
}

type ClaudeSubscriptionPendingAction = 'login' | 'submit' | 'cancel' | 'logout' | 'quota';

interface SubscriptionStatePresentation {
  label: string;
  tone: StatusTone;
  detail: string;
}

function presentSubscriptionState(state: SubscriptionAccountState): SubscriptionStatePresentation {
  switch (state.runtimeState) {
    case 'not_logged_in':
      return { label: '未登录', tone: 'neutral', detail: '使用 Claude 订阅配额前需要先登录。' };
    case 'authorizing':
      return { label: '登录中…', tone: 'info', detail: '请在弹出的浏览器窗口完成登录并粘贴授权码。' };
    case 'authenticated':
      return {
        label: '已登录',
        tone: 'success',
        detail: '已绑定 Claude 订阅，并会同步到“模型连接”。',
      };
    case 'refreshing':
      return { label: '刷新中…', tone: 'info', detail: '正在刷新访问令牌。' };
    case 'refresh_failed':
      return {
        label: '刷新失败',
        tone: 'warning',
        detail: subscriptionResultMessage(state.errorMessage, '令牌刷新失败，请重新登录。'),
      };
    case 'storage_failed':
      return {
        label: '凭据读取失败',
        tone: 'warning',
        detail: subscriptionResultMessage(state.errorMessage, '本地 OAuth 凭据读取失败，请重新登录。'),
      };
    case 'quota_unavailable':
      return {
        label: '等待获取配额',
        tone: 'warning',
        detail: subscriptionResultMessage(state.errorMessage, '已登录；配额接口当前没有返回可用数据。'),
      };
    case 'provider_rejected':
      return {
        label: '订阅 API 拒绝',
        tone: 'destructive',
        detail: subscriptionResultMessage(state.errorMessage, '订阅端点拒绝了请求，可能需要重新登录。'),
      };
    default:
      return { label: '未知状态', tone: 'neutral', detail: '' };
  }
}
