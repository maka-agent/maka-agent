import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ChevronRight,
} from '@maka/ui/icons';
import type {
  AppSettings,
  BotChannelSettings,
  BotProvider,
  BotReadinessState,
  LlmConnection,
  UpdateAppSettingsResult,
} from '@maka/core';
import type { BotStatus } from '@maka/runtime';
import { BOT_PROVIDERS, MAX_ALLOWED_USER_IDS, parseAllowedUserIdsFromText } from '@maka/core/settings';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
  BOT_BRAND,
  BotBrandLogo as BotBrandMark,
  Button,
  Chip,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  RelativeTime,
  SettingsSelect,
  SettingsSwitch as Switch,
  Textarea,
  useToast,
} from '@maka/ui';
import { PasswordInput } from './password-input';
import { settingsActionErrorMessage } from './settings-error-copy';
import { BotWeChatFields, WeChatScanLoginModal, WechatQrLoginModal } from './bot-wechat-login';
import { deriveBotChannelViewState } from './bot-settings-view-model';

/**
 * Per-platform brand presentation.
 *
 * History:
 * - PR-BOT-SETTINGS-UI-0 (WAWQAQ msg `51c7b4ff`) shipped single-char
 *   monograms (T / 飞 / 企 / 微 / D / 钉 / Q) tinted with the brand color
 *   as a license/asset-hygiene compromise.
 * - WAWQAQ msg `c8a9fc6f` 2026-06-25 reversed this: "IM 的渠道，这一些
 *   显然应该用真实的图标，而不是用字。就像现在模型的这一些图标都是
 *   用的真实对应公司的图标。" → swap the monogram for the real brand
 *   icon, the same way model providers already use their actual logos.
 *
 * Implementation: `BotBrandMark` renders a local provider SVG. The icons
 * render synchronously offline; `glyph` stays only as metadata for text
 * fallback contexts.
 *
 * `configDocUrl` is the official developer doc surfaced inline as a
 * "查看配置文档" link.
 */
// BOT_BRAND moved to `packages/ui/src/bot-brand.ts` so the Plan Reminder
// delivery picker can use the same brand metadata as Settings here (@kenji
// audit 2026-06-25 msg `e4cfbfb0` finding #2). Imported via `@maka/ui`.

// PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `2fa6ada6`): help copy
// rewritten per reference screenshots — short product sentence pointing
// at where to provision credentials; not a runtime technical breakdown.
const BOT_LABELS: Record<BotProvider, { label: string; help: string; support: 'runtime' | 'credentials' | 'planned' }> = {
  telegram: {
    label: 'Telegram',
    help: '通过 @BotFather 创建 Bot 并获取 Token',
    support: 'runtime',
  },
  feishu: {
    label: '飞书',
    help: '在飞书开放平台创建应用并获取凭证',
    support: 'credentials',
  },
  wecom: {
    label: '企业微信',
    help: '通过企业微信 AI 应用接入，使用 WebSocket 长连接',
    support: 'credentials',
  },
  wechat: {
    label: '微信',
    help: '通过本机 wechat-bridge 接入个人微信，需 iOS / Android 微信 8.0.70+。',
    support: 'credentials',
  },
  discord: {
    label: 'Discord',
    help: '在 Discord Developer Portal 创建 Bot',
    support: 'runtime',
  },
  dingtalk: {
    label: '钉钉',
    help: '在钉钉开发者后台创建机器人应用',
    support: 'runtime',
  },
  qq: {
    label: 'QQ',
    help: '在 QQ 开放平台创建机器人并获取 AppID 和 AppSecret',
    support: 'runtime',
  },
};

const BOT_READINESS_COPY: Record<BotReadinessState, { label: string; detail: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive' }> = {
  unscaffolded: { label: '未开放', detail: '该平台当前不可作为远程接入渠道。', tone: 'neutral' },
  scaffolded: { label: '待配置', detail: '等待补齐这个平台需要的凭据配置。', tone: 'neutral' },
  configured: { label: '已配置', detail: '已填写配置；等待完成凭据或运行态验证。', tone: 'info' },
  credentials_valid: { label: '凭据有效', detail: '凭据探测通过；这不代表已能收发消息。', tone: 'warning' },
  operational: { label: '运行可用', detail: '最近一次真实运行探测成功。', tone: 'success' },
  degraded: { label: '运行降级', detail: '之前可用，但最近运行态探测失败。', tone: 'destructive' },
};

const BOT_PLANNED_COPY = {
  label: '未开放',
  detail: '该平台当前不会保存为远程接入渠道或计划提醒投递目标。',
  tone: 'neutral' as const,
};

function botReadinessCopyForSupport(support: 'runtime' | 'credentials' | 'planned', readiness: BotReadinessState) {
  if (support === 'planned') return BOT_PLANNED_COPY;
  return BOT_READINESS_COPY[readiness] ?? BOT_READINESS_COPY.scaffolded;
}

function canEnableBotChannel(readiness: BotReadinessState): boolean {
  return readiness === 'credentials_valid' || readiness === 'operational' || readiness === 'degraded';
}

/** Shared provider logo, compact in the overview and larger in channel detail. */
function BotBrandLogo(props: { provider: BotProvider; size?: 'compact' | 'large' }) {
  const isLarge = props.size === 'large';
  return (
    <span
      className="settingsBotLogo"
      data-large={isLarge ? 'true' : undefined}
      data-provider={props.provider}
      aria-hidden="true"
    >
      {/* PR-BOT-LOGO-NEUTRAL-PLATE-0 (WAWQAQ msg `f3d263b4`
          2026-06-26): real iOS-app-icon style. The brand SVG carries
          the brand-color disc + white official mark (Telegram blue
          gradient + paper plane, WeChat green + double-bubble,
          Discord blurple + Clyde, Feishu 3-color staircase, …) —
          see `packages/ui/src/bot-brand-logo.tsx`. width/height
          100% so the brand tile fills `.settingsBotLogo` edge-to-
          edge; the parent plate is transparent so the brand-color
          disc IS the visible tile. */}
      <BotBrandMark
        provider={props.provider}
        width="100%"
        height="100%"
        aria-hidden="true"
      />
    </span>
  );
}

export function BotChatSettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReload(): Promise<void>;
}) {
  type BotPendingActionName = 'test' | 'connect' | 'restart' | 'disconnect';
  type BotPendingAction = { provider: BotProvider; action: BotPendingActionName };

  const [selected, setSelected] = useState<BotProvider>('telegram');
  const [detailOpen, setDetailOpen] = useState(false);
  const [pendingBotAction, setPendingBotAction] = useState<BotPendingAction | null>(null);
  const [scanLoginOpen, setScanLoginOpen] = useState(false);
  const [wechatQrOpen, setWechatQrOpen] = useState(false);
  const [statuses, setStatuses] = useState<Record<BotProvider, BotStatus> | null>(null);
  const [statusLoadError, setStatusLoadError] = useState<string | null>(null);
  const channel = props.settings.botChat.channels[selected];
  const toast = useToast();
  const selectedStatus = statuses?.[selected];
  const pendingBotActionRef = useRef<BotPendingAction | null>(null);
  const botPageMountedRef = useRef(false);
  const botActionBusy = pendingBotAction !== null;
  const selectedBotActionPending = pendingBotAction?.provider === selected ? pendingBotAction.action : null;
  const testing = selectedBotActionPending === 'test' || selectedBotActionPending === 'connect';
  const restarting = selectedBotActionPending === 'restart';

  useEffect(() => {
    botPageMountedRef.current = true;
    return () => {
      botPageMountedRef.current = false;
      pendingBotActionRef.current = null;
    };
  }, []);

  function beginBotAction(provider: BotProvider, action: BotPendingActionName): boolean {
    if (pendingBotActionRef.current !== null) return false;
    const next = { provider, action };
    pendingBotActionRef.current = next;
    setPendingBotAction(next);
    return true;
  }

  function finishBotAction(provider: BotProvider, action: BotPendingActionName) {
    const current = pendingBotActionRef.current;
    if (!current || current.provider !== provider || current.action !== action) return;
    pendingBotActionRef.current = null;
    if (botPageMountedRef.current) {
      setPendingBotAction(null);
    }
  }

  async function updateChannelFor(provider: BotProvider, patch: Partial<typeof channel>): Promise<boolean> {
    try {
      await props.onUpdate({ botChat: { channels: { [provider]: patch } } });
      if (!botPageMountedRef.current) return false;
      return true;
    } catch (error) {
      if (botPageMountedRef.current) {
        toast.error(`${BOT_LABELS[provider].label} 保存失败`, settingsActionErrorMessage(error));
      }
      return false;
    }
  }

  async function updateChannel(patch: Partial<typeof channel>): Promise<boolean> {
    return updateChannelFor(selected, patch);
  }

  useEffect(() => {
    let active = true;
    void window.maka.settings.bots.listStatuses().then((next) => {
      if (!active) return;
      setStatuses(next);
      setStatusLoadError(null);
    }).catch((error) => {
      if (!active) return;
      const message = settingsActionErrorMessage(error);
      setStatusLoadError(message);
      toast.error('载入远程接入状态失败', message);
    });
    const unsubscribe = window.maka.settings.bots.subscribeStatusChanges((status) => {
      if (!botPageMountedRef.current) return;
      setStatusLoadError(null);
      setStatuses((current) => ({
        ...(current ?? ({} as Record<BotProvider, BotStatus>)),
        [status.platform]: status,
      }));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function testChannel() {
    const provider = selected;
    if (!beginBotAction(provider, 'test')) return;
    try {
      const result = await window.maka.settings.testBotChannel(provider);
      if (!botPageMountedRef.current) return;
      const platform = BOT_LABELS[provider].label;
      if (result.ok) {
        // PR-BOT-CHAT-POLISH-0: title now matches kenji boundary 2's
        // 5-state readiness chain — a successful test PROVES
        // `credentials_valid`, NOT `operational`. The detail copy
        // still carries the IPC-side message so the user can see
        // latency / identity etc.
        toast.success(`${platform} 凭据已验证`, result.message);
      } else {
        toast.error(`${platform} 凭据测试失败`, result.message);
      }
      await refreshBotStatuses();
    } catch (error) {
      if (botPageMountedRef.current) {
        toast.error(`${BOT_LABELS[provider].label} 测试出错`, settingsActionErrorMessage(error));
      }
    } finally {
      finishBotAction(provider, 'test');
    }
  }

  /**
   * PR-BOT-SETTINGS-UI-0 (WAWQAQ msg `51c7b4ff`): combined "测试并连接"
   * action mirrors the reference design's primary CTA. Runs credential
   * test, then on success flips the enable toggle on and starts the
   * listener. On test failure stops at the credential step — does NOT
   * flip the toggle, so the user can fix the credentials and retry.
   */
  async function testAndConnect() {
    const provider = selected;
    const providerChannel = props.settings.botChat.channels[provider];
    const providerSupport = BOT_LABELS[provider].support;
    if (!beginBotAction(provider, 'connect')) return;
    let testOk = false;
    try {
      const result = await window.maka.settings.testBotChannel(provider);
      if (!botPageMountedRef.current) return;
      const platform = BOT_LABELS[provider].label;
      testOk = result.ok;
      if (result.ok) {
        toast.success(`${platform} 凭据已验证`, result.message);
      } else {
        toast.error(`${platform} 凭据测试失败`, result.message);
      }
      await refreshBotStatuses();
    } catch (error) {
      if (botPageMountedRef.current) {
        toast.error(`${BOT_LABELS[provider].label} 测试出错`, settingsActionErrorMessage(error));
      }
      finishBotAction(provider, 'connect');
      return;
    }
    try {
      if (!botPageMountedRef.current) return;
      if (!testOk || providerSupport !== 'runtime') return;
      if (!providerChannel.enabled) {
        const saved = await updateChannelFor(provider, { enabled: true });
        if (!saved) return;
      }
      if (!botPageMountedRef.current) return;
      await restartBotProvider(provider);
    } finally {
      finishBotAction(provider, 'connect');
    }
  }

  async function restartBotProvider(provider: BotProvider): Promise<boolean> {
    if (!botPageMountedRef.current) return false;
    try {
      const status = await window.maka.settings.bots.restart(provider);
      if (!botPageMountedRef.current) return status.running;
      setStatuses((current) => ({
        ...(current ?? ({} as Record<BotProvider, BotStatus>)),
        [status.platform]: status,
      }));
      // PR-BOT-CHAT-POLISH-0: tone follows actual runtime state, not
      // the bare fact that the restart command returned. A restarted
      // bot that immediately stops (e.g. token rejected, network
      // down) was previously surfaced as a green success toast.
      const platform = BOT_LABELS[provider].label;
      if (status.running) {
        toast.success(`${platform} 已开始监听`, botStatusDetail(status));
      } else {
        toast.error(`${platform} 启动后未进入监听`, botStatusDetail(status));
      }
      return status.running;
    } catch (error) {
      if (!botPageMountedRef.current) return false;
      const message = settingsActionErrorMessage(error);
      toast.error(`${BOT_LABELS[provider].label} 启动失败`, message);
      return false;
    }
  }

  async function restartChannel() {
    const provider = selected;
    if (!beginBotAction(provider, 'restart')) return;
    try {
      await restartBotProvider(provider);
    } finally {
      finishBotAction(provider, 'restart');
    }
  }

  async function refreshBotStatuses(): Promise<boolean> {
    if (!botPageMountedRef.current) return false;
    try {
      await props.onReload();
      if (!botPageMountedRef.current) return false;
      const nextStatuses = await window.maka.settings.bots.listStatuses();
      if (!botPageMountedRef.current) return false;
      setStatuses(nextStatuses);
      setStatusLoadError(null);
      return true;
    } catch (error) {
      if (!botPageMountedRef.current) return false;
      const message = settingsActionErrorMessage(error);
      setStatusLoadError(message);
      toast.error('刷新远程接入状态失败', message);
      return false;
    }
  }

  async function disconnectWechatLogin() {
    const provider = selected;
    const providerChannel = props.settings.botChat.channels[provider];
    if (!beginBotAction(provider, 'disconnect')) return;
    try {
      const ok = await toast.confirm({
        title: '断开微信登录？',
        description: '将清除本机保存的扫码登录凭据，之后需要重新扫码才能继续使用微信渠道。',
        confirmLabel: '断开登录',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!ok) return;
      const isIlink = providerChannel.webhookUrl?.trim().startsWith('https://ilinkai.weixin.qq.com') ?? false;
      const saved = await updateChannelFor(provider, {
        token: '',
        ...(isIlink ? { webhookUrl: '' } : {}),
        botUserId: undefined,
        connected: false,
        readiness: 'scaffolded',
        readinessReason: undefined,
        readinessUpdatedAt: Date.now(),
        lastError: undefined,
      });
      if (!saved) return;
      if (!botPageMountedRef.current) return;
      await refreshBotStatuses();
      if (botPageMountedRef.current) {
        toast.success('微信登录已断开', '本机扫码登录凭据已清除。');
      }
    } finally {
      finishBotAction(provider, 'disconnect');
    }
  }

  const support = BOT_LABELS[selected].support;
  const selectedViewState = deriveBotChannelViewState({ channel, status: selectedStatus });
  const readiness = selectedViewState.readiness;
  const copy = botReadinessCopyForSupport(support, readiness);
  const enableSwitchDisabled = support === 'planned' || (!channel.enabled && !canEnableBotChannel(readiness));
  const enableSwitchHint = support === 'planned'
    ? '该平台未开放，暂不能启用。'
    : !channel.enabled && !canEnableBotChannel(readiness)
      ? '先测试并连接后才能启用。'
      : undefined;
  const enableSwitchHintId = `settings-bot-enable-hint-${selected}`;

  const overviewChannels = BOT_PROVIDERS.map((provider, index) => {
    const providerChannel = props.settings.botChat.channels[provider];
    const providerStatus = statuses?.[provider];
    const providerSupport = BOT_LABELS[provider].support;
    const providerViewState = deriveBotChannelViewState({
      channel: providerChannel,
      status: providerStatus,
    });
    const providerCopy = botReadinessCopyForSupport(providerSupport, providerViewState.readiness);
    return {
      provider,
      index,
      channel: providerChannel,
      status: providerStatus,
      support: providerSupport,
      copy: providerCopy,
      configured: providerViewState.configured,
      needsAttention: providerViewState.needsAttention,
      currentError: providerViewState.currentError,
    };
  });
  const activeChannels = overviewChannels
    .filter((entry) => entry.configured)
    .sort((left, right) => {
      if (left.needsAttention !== right.needsAttention) return left.needsAttention ? -1 : 1;
      const activityDelta = (right.status?.lastEventAt ?? 0) - (left.status?.lastEventAt ?? 0);
      return activityDelta || left.index - right.index;
    });
  const availableChannels = overviewChannels.filter((entry) => !entry.configured);

  function openChannel(provider: BotProvider) {
    setSelected(provider);
    setDetailOpen(true);
  }

  if (!detailOpen) {
    return (
      <div className="settingsRemoteAccessOverview">
        {statusLoadError && (
          <Alert variant="error">
            <AlertTitle>远程接入状态载入失败</AlertTitle>
            <AlertDescription>{statusLoadError}</AlertDescription>
            <AlertAction>
              <Button type="button" variant="secondary" onClick={() => void refreshBotStatuses()}>
                重新载入
              </Button>
            </AlertAction>
          </Alert>
        )}

        <section className="settingsRemoteAccessSection" aria-labelledby="remote-access-active-heading">
          <div className="settingsRemoteAccessSectionHeader">
            <h3 id="remote-access-active-heading">正在使用</h3>
            <span>按需要处理、最近活动排序</span>
          </div>
          <div className="settingsRemoteAccessActiveList">
            {activeChannels.length === 0 ? (
              <Item className="settingsRemoteAccessEmptyRow" interactive={false}>
                <ItemContent>
                  <ItemTitle>还没有正在使用的渠道</ItemTitle>
                  <ItemDescription>从下方选择一个消息平台开始配置。</ItemDescription>
                </ItemContent>
              </Item>
            ) : activeChannels.map((entry) => (
              <Item
                key={entry.provider}
                className="settingsRemoteAccessChannelRow"
                data-attention={entry.needsAttention ? 'true' : undefined}
                render={(
                  <button
                    type="button"
                    aria-label={`管理 ${BOT_LABELS[entry.provider].label}，${entry.copy.label}`}
                    onClick={() => openChannel(entry.provider)}
                  />
                )}
              >
                <ItemMedia><BotBrandLogo provider={entry.provider} /></ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {BOT_LABELS[entry.provider].label}
                    <Chip dot size="sm" variant={entry.copy.tone}>{entry.copy.label}</Chip>
                  </ItemTitle>
                  <ItemDescription>{botOverviewDetail(entry.status, entry.currentError, entry.copy.detail)}</ItemDescription>
                </ItemContent>
                <ItemActions><ChevronRight size={16} aria-hidden="true" /></ItemActions>
              </Item>
            ))}
          </div>
        </section>

        <section className="settingsRemoteAccessSection" aria-labelledby="remote-access-available-heading">
          <div className="settingsRemoteAccessSectionHeader">
            <h3 id="remote-access-available-heading">接入更多渠道</h3>
            <span>选择平台开始配置</span>
          </div>
          <div className="settingsRemoteAccessCatalog">
            {availableChannels.map((entry) => (
              <Item
                key={entry.provider}
                className="settingsRemoteAccessCatalogRow"
                data-support={entry.support}
                render={(
                  <button
                    type="button"
                    aria-label={`接入 ${BOT_LABELS[entry.provider].label}`}
                    onClick={() => openChannel(entry.provider)}
                  />
                )}
              >
                <ItemMedia><BotBrandLogo provider={entry.provider} /></ItemMedia>
                <ItemContent>
                  <ItemTitle>{BOT_LABELS[entry.provider].label}</ItemTitle>
                  <ItemDescription>{BOT_LABELS[entry.provider].help}</ItemDescription>
                </ItemContent>
                <ItemActions><ChevronRight size={16} aria-hidden="true" /></ItemActions>
              </Item>
            ))}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="settingsRemoteAccessDetail">
      <Button
        type="button"
        variant="quiet"
        className="settingsRemoteAccessBack"
        aria-label="返回远程接入"
        disabled={botActionBusy}
        onClick={() => setDetailOpen(false)}
      >
        <ArrowLeft size={16} aria-hidden="true" />
        返回远程接入
      </Button>
      <section className="settingsBotDetail">
        <header className="settingsBotDetailHeader" data-support={support}>
          <BotBrandLogo provider={selected} size="large" />
          <div className="settingsBotDetailHeaderBody">
            <h3>
              {BOT_LABELS[selected].label}
              <Chip dot size="sm" variant={copy.tone}>{copy.label}</Chip>
            </h3>
            <p>
              {BOT_LABELS[selected].help}
              {BOT_BRAND[selected].configDocUrl && (
                <>
                  {' '}
                  <a
                    className="settingsBotConfigDocLink"
                    href={BOT_BRAND[selected].configDocUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    查看配置文档
                  </a>
                </>
              )}
            </p>
            {enableSwitchHint && (
              <small id={enableSwitchHintId} className="settingsBotEnableHint">
                {enableSwitchHint}
              </small>
            )}
          </div>
          <Switch
            ariaLabel={`启用${BOT_LABELS[selected].label}渠道`}
            ariaDescribedBy={enableSwitchHint ? enableSwitchHintId : undefined}
            checked={channel.enabled}
            onChange={(enabled) => updateChannel({ enabled })}
            disabled={enableSwitchDisabled || botActionBusy}
          />
        </header>

        <section className="settingsBotRuntime" aria-labelledby="settings-bot-runtime-heading">
          <div className="settingsBotRuntimeHeader">
            <div>
              <h4 id="settings-bot-runtime-heading">{selectedStatus?.running ? '正在监听新消息' : copy.label}</h4>
              <p>{selectedStatus?.running ? '连接正常，无需处理。' : copy.detail}</p>
            </div>
            <div className="settingsBotActionStack" role="group" aria-label={`${BOT_LABELS[selected].label}渠道操作`}>
              {selected === 'wechat' ? (
                <>
                  <Button type="button" variant="secondary" disabled={botActionBusy} onClick={() => setScanLoginOpen(true)}>
                    扫码登录
                  </Button>
                  {(channel.token || selectedStatus?.identity) && (
                    <Button type="button" variant="secondary" disabled={botActionBusy} onClick={() => void disconnectWechatLogin()}>
                      {selectedBotActionPending === 'disconnect' ? '断开中…' : '断开微信登录'}
                    </Button>
                  )}
                  <Button type="button" variant="secondary" disabled={botActionBusy} onClick={() => setWechatQrOpen(true)}>
                    本机桥接二维码
                  </Button>
                  <Button type="button" variant="secondary" disabled={botActionBusy} onClick={testChannel}>
                    {selectedBotActionPending === 'test' ? '测试中…' : '测试连接'}
                  </Button>
                </>
              ) : support === 'runtime' && !selectedStatus?.running ? (
                <Button type="button" disabled={botActionBusy} onClick={testAndConnect}>
                  {selectedBotActionPending === 'connect' ? '连接中…' : '测试并连接'}
                </Button>
              ) : (
                <Button type="button" variant="secondary" disabled={botActionBusy || support === 'planned'} onClick={testChannel}>
                  {selectedBotActionPending === 'test' ? '测试中…' : support === 'runtime' ? '测试连接' : '测试并连接'}
                </Button>
              )}
              {support === 'runtime' && (selectedStatus?.running || restarting) && selected !== 'wechat' && (
                <Button type="button" variant="secondary" disabled={botActionBusy} onClick={restartChannel}>
                  {restarting ? '重启中…' : '重启监听'}
                </Button>
              )}
            </div>
          </div>

          <dl className="settingsBotStatusGrid" aria-label={`${BOT_LABELS[selected].label}运行状态`}>
            <div><dt>身份</dt><dd>{selectedStatus?.identity?.username ?? selectedStatus?.identity?.displayName ?? '未获取'}</dd></div>
            <div><dt>通道类型</dt><dd>{botConnectionLabel(selectedStatus?.connection ?? 'none')}</dd></div>
            <div><dt>最近事件</dt><dd>{selectedStatus?.lastEventAt ? <RelativeTime ts={selectedStatus.lastEventAt} className="settingsBotMetaTime" /> : '暂无'}</dd></div>
            <div><dt>最近一次测试</dt><dd>{channel.lastTestAt ? <RelativeTime ts={channel.lastTestAt} className="settingsBotMetaTime" /> : '从未测试'}</dd></div>
          </dl>
        </section>

        {statusLoadError && (
          <Alert variant="error">
            <AlertTitle>运行状态刷新失败</AlertTitle>
            <AlertDescription>{statusLoadError}</AlertDescription>
          </Alert>
        )}
        {selectedStatus?.reason && channel.enabled && !selectedStatus.running && (
          <Alert variant="warning">
            <AlertTitle>{botStatusDetail(selectedStatus)}</AlertTitle>
            <AlertDescription>{copy.detail}</AlertDescription>
          </Alert>
        )}
        {selectedViewState.currentError && support !== 'planned' && (
          <Alert variant="error">
            <AlertTitle>上次测试失败</AlertTitle>
            <AlertDescription>{selectedViewState.currentError}</AlertDescription>
          </Alert>
        )}

        <div className="settingsBotConfigurationHeader">
          <h4>连接配置</h4>
          <span>自动保存</span>
        </div>

        {/* PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `2fa6ada6` screenshots):
            each platform's fields, labels, placeholders and notices
            rewritten to match the reference design 1:1. The previous
            implementations diverged with technical wording, extra
            fields, and missing TUN-mode amber notices. */}
        {selected === 'telegram' && (
          <>
            <label className="settingsField">
              <span>Bot Token</span>
              <PasswordInput value={channel.token} onChange={(next) => updateChannel({ token: next })} placeholder="123456:ABC-DEF..." ariaLabel="Telegram Bot Token" />
            </label>
            <label className="settingsField">
              <span>代理地址 <em className="settingsFieldHint">(国内网络必填)</em></span>
              <Input value={channel.proxyUrl} onChange={(event) => updateChannel({ proxyUrl: event.currentTarget.value })} placeholder="http://127.0.0.1:7890" aria-label="Telegram 代理地址" />
            </label>
            <BotAllowedUserIdsField
              value={channel.allowedUserIds}
              onChange={(next) => updateChannel({ allowedUserIds: next })}
            />
            <div className="settingsBotInfoNotice">
              <span className="settingsBotInfoNoticeIcon" aria-hidden="true">ⓘ</span>
              <span>请打开网络的 TUN 模式后重启应用，以便完成 Telegram Bot 设置</span>
            </div>
          </>
        )}

        {selected === 'feishu' && (
          <>
            <label className="settingsField">
              <span>App ID</span>
              <Input aria-label="飞书凭据 ID" value={channel.appId ?? ''} onChange={(event) => updateChannel({ appId: event.currentTarget.value })} placeholder="cli_xxxx" />
            </label>
            <label className="settingsField">
              <span>App Secret</span>
              <PasswordInput value={channel.appSecret ?? ''} onChange={(next) => updateChannel({ appSecret: next })} placeholder="xxxx" ariaLabel="飞书 App Secret" />
            </label>
            <label className="settingsField">
              <span>域名</span>
              <SettingsSelect
                value={channel.domain ?? 'feishu.cn'}
                ariaLabel="飞书域名"
                options={[
                  ['feishu.cn', '飞书 (feishu.cn)'],
                  ['larksuite.com', 'Lark (larksuite.com)'],
                ]}
                onChange={(domain) => updateChannel({ domain })}
              />
            </label>
          </>
        )}

        {selected === 'discord' && (
          <>
            <label className="settingsField">
              <span>Bot Token</span>
              <PasswordInput value={channel.token} onChange={(next) => updateChannel({ token: next })} placeholder="MTAx..." ariaLabel="Discord Bot Token" />
            </label>
            <label className="settingsField">
              <span>代理地址 <em className="settingsFieldHint">(仅用于 Bot 鉴权)</em></span>
              <Input value={channel.proxyUrl} onChange={(event) => updateChannel({ proxyUrl: event.currentTarget.value })} placeholder="http://127.0.0.1:7890" aria-label="Discord 代理地址" />
            </label>
            <div className="settingsBotInfoNotice">
              <span className="settingsBotInfoNoticeIcon" aria-hidden="true">ⓘ</span>
              <span>国内网络访问 Discord：上方代理仅作用于 Bot 鉴权请求，消息收发走 WebSocket 长连接需要系统级代理。请打开网络的 TUN 模式后重启应用。</span>
            </div>
          </>
        )}

        {selected === 'dingtalk' && (
          <>
            <label className="settingsField">
              <span>Client ID (AppKey)</span>
              <Input aria-label="钉钉应用密钥" value={channel.appId ?? ''} onChange={(event) => updateChannel({ appId: event.currentTarget.value })} placeholder="dingxxxxxxxx" />
            </label>
            <label className="settingsField">
              <span>Client Secret (AppSecret)</span>
              <PasswordInput value={channel.appSecret ?? ''} onChange={(next) => updateChannel({ appSecret: next })} placeholder="xxxx" ariaLabel="钉钉 Client Secret" />
            </label>
          </>
        )}

        {selected === 'wecom' && (
          <>
            <label className="settingsField">
              <span>Bot ID</span>
              <Input value={channel.appId ?? ''} onChange={(event) => updateChannel({ appId: event.currentTarget.value })} placeholder="企业微信 AI 应用 Bot ID" aria-label="企业微信 Bot ID" />
            </label>
            <label className="settingsField">
              <span>Secret</span>
              <PasswordInput value={channel.appSecret ?? ''} onChange={(next) => updateChannel({ appSecret: next })} placeholder="AI 应用 Secret" ariaLabel="企业微信 Secret" />
            </label>
          </>
        )}

        {/* PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `1d9c412e`): WeChat
            personal account integration. Reference design uses ONE
            Bot Token field for the local bridge connection + a
            scan-login affordance. 公众号 (App ID / App Secret) and
            advanced bridge URL stay available behind a collapsed
            「高级设置」section so runtime backward compatibility is
            preserved. */}
        {selected === 'wechat' && (
          <BotWeChatFields channel={channel} updateChannel={updateChannel} />
        )}

        {selected === 'qq' && (
          <>
            <label className="settingsField">
              <span>AppID</span>
              <Input aria-label="QQ 应用编号" value={channel.appId ?? ''} onChange={(event) => updateChannel({ appId: event.currentTarget.value })} placeholder="102xxxxxx" />
            </label>
            <label className="settingsField">
              <span>AppSecret</span>
              <PasswordInput value={channel.appSecret ?? ''} onChange={(next) => updateChannel({ appSecret: next })} placeholder="xxxx" ariaLabel="QQ AppSecret" />
            </label>
          </>
        )}

        {support === 'planned' && (
          <div className="settingsNotice" data-tone="passive">
            这个平台当前只作为平台清单展示，不会进入可用渠道，也不会保存为计划提醒投递目标。
          </div>
        )}

        {/* WeChat keeps scan login as a first-class action, separate from
            connection testing, because QR generation and listener readiness
            are different states. */}
        {scanLoginOpen && (
          <WeChatScanLoginModal
            onClose={() => setScanLoginOpen(false)}
            onConfirmed={async (credentials) => {
              const saved = await updateChannel({
                token: credentials.botToken,
                webhookUrl: credentials.baseUrl,
                botUserId: credentials.botId,
              });
              if (!saved) return;
              await props.onReload();
              if (!botPageMountedRef.current) return;
              setScanLoginOpen(false);
              toast.success('微信已扫码登录', credentials.botId ? `Bot ID ${credentials.botId}` : '凭据已保存');
            }}
          />
        )}
        {wechatQrOpen && (
          <WechatQrLoginModal
            onClose={() => setWechatQrOpen(false)}
            onRefreshStatuses={refreshBotStatuses}
          />
        )}
      </section>
    </div>
  );
}

/**
 * PR-BOT-USER-ALLOWLIST-UI-0 — textarea bound to
 * `BotChannelSettings.allowedUserIds`. Empty / blank lines are stripped;
 * duplicates are dedup'd; entries are trimmed; the list is capped at
 * `MAX_ALLOWED_USER_IDS`. Empty array is forwarded as `undefined` so the
 * settings persist layer sees the "no restriction" default sentinel.
 *
 * Local-only buffer state: the user can type a value mid-edit (e.g.
 * `1234567`) without the in-progress short ID being dropped by the
 * parse function. We only emit the parsed array on commit (onBlur).
 */
function BotAllowedUserIdsField(props: {
  value: ReadonlyArray<string> | undefined;
  onChange(next: ReadonlyArray<string> | undefined): void;
}): ReactNode {
  const persisted = props.value ?? [];
  const [buffer, setBuffer] = useState<string>(persisted.join('\n'));

  // Reset the buffer when the persisted value changes from outside
  // (e.g. settings reload). Compare by join so identity differences
  // do not cause noisy resets.
  useEffect(() => {
    const next = persisted.join('\n');
    if (next !== buffer) {
      setBuffer(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persisted.join('\n')]);

  const parsed = useMemo(() => parseAllowedUserIdsFromText(buffer), [buffer]);
  const atCap = parsed.length >= MAX_ALLOWED_USER_IDS;
  // PR-BOT-ALLOWLIST-INVALID-ID-WARN-0: Telegram user IDs are decimal
  // integers (e.g. `123456789`). Common mistake is pasting `@alice`
  // (username) instead — that string will persist and silently never
  // match anyone. Surface the invalid entries so the user can fix them.
  // Persistence is NOT enforced here (normalize still accepts any
  // non-empty string) — the gate is informational so a power user
  // tracking a non-Telegram platform later is not blocked.
  const invalidEntries = useMemo(
    () => parsed.filter((id) => !/^[0-9]+$/.test(id)),
    [parsed],
  );

  const commit = (): void => {
    const next = parsed.length === 0 ? undefined : parsed;
    const same =
      (next?.length ?? 0) === persisted.length &&
      (next ?? []).every((id, idx) => id === persisted[idx]);
    if (!same) props.onChange(next);
  };

  return (
    <label className="settingsField">
      <span>允许的用户 ID（{parsed.length} / {MAX_ALLOWED_USER_IDS}）</span>
      <Textarea
        value={buffer}
        onChange={(event) => setBuffer(event.currentTarget.value)}
        onBlur={commit}
        rows={3}
        spellCheck={false}
        placeholder={'每行一个用户 ID，留空表示不限\n例如：123456789'}
        aria-label="允许的用户 ID"
      />
      <small>
        Telegram 用户 ID 是 64 位整数；填入后只接收列表里这些 ID 的来信，其它人发的消息会被静默忽略（不会回弹任何提示）。
        {atCap && <strong>（已达到上限）</strong>}
        {invalidEntries.length > 0 && (
          <span className="settingsFieldWarning" data-tone="warning">
            下列不是数字 ID，可能是用户名之类的输入，匹配不到任何人：{invalidEntries.slice(0, 3).join('、')}
            {invalidEntries.length > 3 && ` 等 ${invalidEntries.length} 项`}
          </span>
        )}
      </small>
    </label>
  );
}

function botOverviewDetail(
  status: BotStatus | undefined,
  currentError: string | undefined,
  fallback: string,
): ReactNode {
  const identity = status?.identity?.username ?? status?.identity?.displayName;
  if (status?.running) {
    return (
      <>
        监听中{identity ? ` · ${identity}` : ''}
        {status.lastEventAt ? <> · <RelativeTime ts={status.lastEventAt} /></> : ''}
      </>
    );
  }
  if (currentError) return currentError;
  if (status?.reason) return botStatusDetail(status);
  return fallback;
}

function botConnectionLabel(connection: BotStatus['connection']): string {
  switch (connection) {
    case 'polling': return '长轮询';
    case 'gateway': return '事件通道';
    case 'webhook': return 'Webhook';
    case 'none': return '无';
  }
}

function botStatusDetail(status: BotStatus): string {
  switch (status.reason) {
    case 'disabled': return '开关关闭';
    case 'no-token': return '等待填写 Bot Token';
    case 'missing-feishu-credentials': return '等待填写飞书 App ID 或 App Secret';
    case 'feishu-domain-required': return '飞书凭据有效，等待填写事件订阅域名';
    case 'feishu-events-not-connected': return '飞书凭据有效，等待事件回调接入';
    case 'scaffold-only': return '该平台当前不可作为远程接入渠道';
    case 'unimplemented': return '该平台当前不可作为远程接入渠道';
    case 'stopped': return '监听已停止';
    // PR-BOT-CHAT-POLISH-0: the previous fallback `status.reason ??
    // '暂无运行细节'` would surface a raw reason code (e.g.
    // `polling-timeout`) for any unmapped state. That's noise the
    // user can't act on; collapse to a generalized copy.
    default: return '运行态详情请见日志';
  }
}

function csvList(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}
