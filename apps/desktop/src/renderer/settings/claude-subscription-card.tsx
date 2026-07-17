import { useEffect, useRef, useState } from 'react';
import { type SubscriptionAccountState } from '@maka/core';
import {
  Chip,
  Button,
  RelativeTime,
  Textarea,
  useMountedRef,
  useToast,
} from '@maka/ui';
import { type StatusTone } from './settings-status-badge';
import {
  subscriptionActionErrorMessage,
  subscriptionResultMessage,
} from './use-oauth-login-flow';

/**
 * Claude Pro / Max subscription card: the paste-code OAuth flow (browser →
 * copy the `#`-delimited authorization code back) behind the experimental
 * gate. Extracted from provider-oauth-section.tsx (#1042); the browser
 * loopback flow used by the other OAuth providers lives in
 * `useOAuthLoginFlow` — Claude deliberately keeps its own card because it
 * needs the manual authorization-code step and the experimental gate.
 */
export function ClaudeSubscriptionCard() {
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
  const claudeCardMountedRef = useMountedRef();
  useEffect(() => {
    return () => {
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
