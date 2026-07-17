import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft } from '@maka/ui/icons';
import type { BotChannelSettings, BotProvider, BotReadinessState } from '@maka/core';
import type { BotStatus } from '@maka/runtime';
import { MAX_ALLOWED_USER_IDS, parseAllowedUserIdsFromText } from '@maka/core/settings';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  BOT_BRAND,
  Button,
  Chip,
  Input,
  RelativeTime,
  SettingsSelect,
  SettingsSwitch as Switch,
  Textarea,
  useMountedRef,
  useToast,
} from '@maka/ui';
import { PasswordInput } from './password-input';
import { BotWeChatFields, WeChatScanLoginModal, WechatQrLoginModal } from './bot-wechat-login';
import { deriveBotChannelViewState } from './bot-settings-view-model';
import {
  BOT_LABELS,
  BotBrandLogo,
  botReadinessCopyForSupport,
  botStatusDetail,
  type BotPendingActionName,
} from './bot-chat-shared';

function canEnableBotChannel(readiness: BotReadinessState): boolean {
  return readiness === 'credentials_valid' || readiness === 'operational' || readiness === 'degraded';
}

/**
 * Remote-access channel detail: header with the enable switch, runtime
 * status + action stack, and the auto-saving credential form for the
 * selected platform. The page owns the async action lifecycles and status
 * fetching; this component owns only its local modal state and derives the
 * render values from the channel/status props.
 */
export function BotChatChannelDetail(props: {
  provider: BotProvider;
  channel: BotChannelSettings;
  status: BotStatus | undefined;
  statusLoadError: string | null;
  actionBusy: boolean;
  pendingAction: BotPendingActionName | null;
  restarting: boolean;
  onBack(): void;
  onUpdateChannel(patch: Partial<BotChannelSettings>): Promise<boolean>;
  onTest(): void;
  onTestAndConnect(): void;
  onRestart(): void;
  onDisconnectWechat(): void;
  onReload(): Promise<void>;
  onRefreshStatuses(): Promise<boolean>;
}) {
  const { provider, channel, status } = props;
  const [scanLoginOpen, setScanLoginOpen] = useState(false);
  const [wechatQrOpen, setWechatQrOpen] = useState(false);
  const botDetailMountedRef = useMountedRef();
  const toast = useToast();

  const support = BOT_LABELS[provider].support;
  const viewState = deriveBotChannelViewState({ channel, status });
  const readiness = viewState.readiness;
  const copy = botReadinessCopyForSupport(support, readiness);
  const enableSwitchDisabled = support === 'planned' || (!channel.enabled && !canEnableBotChannel(readiness));
  const enableSwitchHint = support === 'planned'
    ? '该平台未开放，暂不能启用。'
    : !channel.enabled && !canEnableBotChannel(readiness)
      ? '先测试并连接后才能启用。'
      : undefined;
  const enableSwitchHintId = `settings-bot-enable-hint-${provider}`;

  return (
    <div className="settingsRemoteAccessDetail">
      <Button
        type="button"
        variant="quiet"
        className="settingsRemoteAccessBack"
        aria-label="返回远程接入"
        disabled={props.actionBusy}
        onClick={props.onBack}
      >
        <ArrowLeft size={16} aria-hidden="true" />
        返回远程接入
      </Button>
      <section className="settingsBotDetail">
        <header className="settingsBotDetailHeader" data-support={support}>
          <BotBrandLogo provider={provider} size="large" />
          <div className="settingsBotDetailHeaderBody">
            <h3>
              {BOT_LABELS[provider].label}
              <Chip dot size="sm" variant={copy.tone}>{copy.label}</Chip>
            </h3>
            <p>
              {BOT_LABELS[provider].help}
              {BOT_BRAND[provider].configDocUrl && (
                <>
                  {' '}
                  <a
                    className="settingsBotConfigDocLink"
                    href={BOT_BRAND[provider].configDocUrl}
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
            ariaLabel={`启用${BOT_LABELS[provider].label}渠道`}
            ariaDescribedBy={enableSwitchHint ? enableSwitchHintId : undefined}
            checked={channel.enabled}
            onChange={(enabled) => props.onUpdateChannel({ enabled })}
            disabled={enableSwitchDisabled || props.actionBusy}
          />
        </header>

        <section className="settingsBotRuntime" aria-labelledby="settings-bot-runtime-heading">
          <div className="settingsBotRuntimeHeader">
            <div>
              <h4 id="settings-bot-runtime-heading">{viewState.liveOperational ? '正在监听新消息' : copy.label}</h4>
              <p>{viewState.liveOperational ? '连接正常，无需处理。' : copy.detail}</p>
            </div>
            <div className="settingsBotActionStack" role="group" aria-label={`${BOT_LABELS[provider].label}渠道操作`}>
              {provider === 'wechat' ? (
                <>
                  <Button type="button" variant="secondary" disabled={props.actionBusy} onClick={() => setScanLoginOpen(true)}>
                    扫码登录
                  </Button>
                  {(channel.token || status?.identity) && (
                    <Button type="button" variant="secondary" disabled={props.actionBusy} onClick={() => void props.onDisconnectWechat()}>
                      {props.pendingAction === 'disconnect' ? '断开中…' : '断开微信登录'}
                    </Button>
                  )}
                  <Button type="button" variant="secondary" disabled={props.actionBusy} onClick={() => setWechatQrOpen(true)}>
                    本机桥接二维码
                  </Button>
                  <Button type="button" variant="secondary" disabled={props.actionBusy} onClick={() => void props.onTest()}>
                    {props.pendingAction === 'test' ? '测试中…' : '测试连接'}
                  </Button>
                </>
              ) : support === 'runtime' && !status?.running ? (
                <Button type="button" disabled={props.actionBusy} onClick={() => void props.onTestAndConnect()}>
                  {props.pendingAction === 'connect' ? '连接中…' : '测试并连接'}
                </Button>
              ) : (
                <Button type="button" variant="secondary" disabled={props.actionBusy || support === 'planned'} onClick={() => void props.onTest()}>
                  {props.pendingAction === 'test' ? '测试中…' : support === 'runtime' ? '测试连接' : '测试并连接'}
                </Button>
              )}
              {support === 'runtime' && (status?.running || props.restarting) && provider !== 'wechat' && (
                <Button type="button" variant="secondary" disabled={props.actionBusy} onClick={() => void props.onRestart()}>
                  {props.restarting ? '重启中…' : '重启监听'}
                </Button>
              )}
            </div>
          </div>

          <dl className="settingsBotStatusGrid" aria-label={`${BOT_LABELS[provider].label}运行状态`}>
            <div><dt>身份</dt><dd>{status?.identity?.username ?? status?.identity?.displayName ?? '未获取'}</dd></div>
            <div><dt>通道类型</dt><dd>{botConnectionLabel(status?.connection ?? 'none')}</dd></div>
            <div><dt>最近事件</dt><dd>{status?.lastEventAt ? <RelativeTime ts={status.lastEventAt} className="settingsBotMetaTime" /> : '暂无'}</dd></div>
            <div><dt>最近一次测试</dt><dd>{channel.lastTestAt ? <RelativeTime ts={channel.lastTestAt} className="settingsBotMetaTime" /> : '从未测试'}</dd></div>
          </dl>
        </section>

        {props.statusLoadError && (
          <Alert variant="error">
            <AlertTitle>运行状态刷新失败</AlertTitle>
            <AlertDescription>{props.statusLoadError}</AlertDescription>
          </Alert>
        )}
        {status?.reason && channel.enabled && !viewState.liveOperational && (
          <Alert variant="warning">
            <AlertTitle>{botStatusDetail(status)}</AlertTitle>
            <AlertDescription>{copy.detail}</AlertDescription>
          </Alert>
        )}
        {viewState.currentError && support !== 'planned' && (
          <Alert variant="error">
            <AlertTitle>最近一次失败</AlertTitle>
            <AlertDescription>{viewState.currentError}</AlertDescription>
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
        <BotCredentialFields
          provider={provider}
          channel={channel}
          onUpdateChannel={props.onUpdateChannel}
        />

        {/* PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `1d9c412e`): WeChat
            personal account integration. Reference design uses ONE
            Bot Token field for the local bridge connection + a
            scan-login affordance. 公众号 (App ID / App Secret) and
            advanced bridge URL stay available behind a collapsed
            「高级设置」section so runtime backward compatibility is
            preserved. */}
        {provider === 'wechat' && (
          <BotWeChatFields channel={channel} updateChannel={props.onUpdateChannel} />
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
              const saved = await props.onUpdateChannel({
                token: credentials.botToken,
                webhookUrl: credentials.baseUrl,
                botUserId: credentials.botId,
              });
              if (!saved) return;
              await props.onReload();
              if (!botDetailMountedRef.current) return;
              setScanLoginOpen(false);
              toast.success('微信已扫码登录', credentials.botId ? `Bot ID ${credentials.botId}` : '凭据已保存');
            }}
          />
        )}
        {wechatQrOpen && (
          <WechatQrLoginModal
            onClose={() => setWechatQrOpen(false)}
            onRefreshStatuses={props.onRefreshStatuses}
          />
        )}
      </section>
    </div>
  );
}

/**
 * Per-platform credential form descriptors (#1042). The per-provider
 * credential blocks were structurally identical hand-written JSX branches;
 * the uniform fields are data-driven from this table (like BOT_LABELS).
 * WeChat keeps its bespoke `BotWeChatFields` because of the collapsed
 * advanced section, and `planned` platforms render no fields at all.
 */
type BotCredentialField =
  | {
      kind: 'text' | 'password';
      key: 'token' | 'proxyUrl' | 'appId' | 'appSecret';
      label: ReactNode;
      placeholder: string;
      ariaLabel: string;
    }
  | {
      kind: 'select';
      key: 'domain';
      label: ReactNode;
      ariaLabel: string;
      defaultValue: string;
      options: ReadonlyArray<readonly [string, string]>;
    }
  | { kind: 'allowed-user-ids' }
  | { kind: 'notice'; text: string };

const BOT_CREDENTIAL_FIELDS: Partial<Record<BotProvider, ReadonlyArray<BotCredentialField>>> = {
  telegram: [
    { kind: 'password', key: 'token', label: 'Bot Token', placeholder: '123456:ABC-DEF...', ariaLabel: 'Telegram Bot Token' },
    {
      kind: 'text',
      key: 'proxyUrl',
      label: <>代理地址 <em className="settingsFieldHint">(国内网络必填)</em></>,
      placeholder: 'http://127.0.0.1:7890',
      ariaLabel: 'Telegram 代理地址',
    },
    { kind: 'allowed-user-ids' },
    { kind: 'notice', text: '请打开网络的 TUN 模式后重启应用，以便完成 Telegram Bot 设置' },
  ],
  feishu: [
    { kind: 'text', key: 'appId', label: 'App ID', placeholder: 'cli_xxxx', ariaLabel: '飞书凭据 ID' },
    { kind: 'password', key: 'appSecret', label: 'App Secret', placeholder: 'xxxx', ariaLabel: '飞书 App Secret' },
    {
      kind: 'select',
      key: 'domain',
      label: '域名',
      ariaLabel: '飞书域名',
      defaultValue: 'feishu.cn',
      options: [
        ['feishu.cn', '飞书 (feishu.cn)'],
        ['larksuite.com', 'Lark (larksuite.com)'],
      ],
    },
  ],
  discord: [
    { kind: 'password', key: 'token', label: 'Bot Token', placeholder: 'MTAx...', ariaLabel: 'Discord Bot Token' },
    {
      kind: 'text',
      key: 'proxyUrl',
      label: <>代理地址 <em className="settingsFieldHint">(仅用于 Bot 鉴权)</em></>,
      placeholder: 'http://127.0.0.1:7890',
      ariaLabel: 'Discord 代理地址',
    },
    { kind: 'notice', text: '国内网络访问 Discord：上方代理仅作用于 Bot 鉴权请求，消息收发走 WebSocket 长连接需要系统级代理。请打开网络的 TUN 模式后重启应用。' },
  ],
  dingtalk: [
    { kind: 'text', key: 'appId', label: 'Client ID (AppKey)', placeholder: 'dingxxxxxxxx', ariaLabel: '钉钉应用密钥' },
    { kind: 'password', key: 'appSecret', label: 'Client Secret (AppSecret)', placeholder: 'xxxx', ariaLabel: '钉钉 Client Secret' },
  ],
  wecom: [
    { kind: 'text', key: 'appId', label: 'Bot ID', placeholder: '企业微信 AI 应用 Bot ID', ariaLabel: '企业微信 Bot ID' },
    { kind: 'password', key: 'appSecret', label: 'Secret', placeholder: 'AI 应用 Secret', ariaLabel: '企业微信 Secret' },
  ],
  qq: [
    { kind: 'text', key: 'appId', label: 'AppID', placeholder: '102xxxxxx', ariaLabel: 'QQ 应用编号' },
    { kind: 'password', key: 'appSecret', label: 'AppSecret', placeholder: 'xxxx', ariaLabel: 'QQ AppSecret' },
  ],
};

function BotCredentialFields(props: {
  provider: BotProvider;
  channel: BotChannelSettings;
  onUpdateChannel(patch: Partial<BotChannelSettings>): Promise<boolean>;
}) {
  const fields = BOT_CREDENTIAL_FIELDS[props.provider];
  if (!fields) return null;
  return (
    <>
      {fields.map((field, index) => {
        switch (field.kind) {
          case 'text':
            return (
              <label key={field.key} className="settingsField">
                <span>{field.label}</span>
                <Input
                  value={props.channel[field.key] ?? ''}
                  onChange={(event) => props.onUpdateChannel({ [field.key]: event.currentTarget.value })}
                  placeholder={field.placeholder}
                  aria-label={field.ariaLabel}
                />
              </label>
            );
          case 'password':
            return (
              <label key={field.key} className="settingsField">
                <span>{field.label}</span>
                <PasswordInput
                  value={props.channel[field.key] ?? ''}
                  onChange={(next) => props.onUpdateChannel({ [field.key]: next })}
                  placeholder={field.placeholder}
                  ariaLabel={field.ariaLabel}
                />
              </label>
            );
          case 'select':
            return (
              <label key={field.key} className="settingsField">
                <span>{field.label}</span>
                <SettingsSelect
                  value={props.channel[field.key] ?? field.defaultValue}
                  ariaLabel={field.ariaLabel}
                  options={field.options}
                  onChange={(next) => props.onUpdateChannel({ [field.key]: next })}
                />
              </label>
            );
          case 'allowed-user-ids':
            return (
              <BotAllowedUserIdsField
                key="allowed-user-ids"
                value={props.channel.allowedUserIds}
                onChange={(next) => props.onUpdateChannel({ allowedUserIds: next })}
              />
            );
          case 'notice':
            return (
              <div key={`notice-${index}`} className="settingsBotInfoNotice">
                <span className="settingsBotInfoNoticeIcon" aria-hidden="true">ⓘ</span>
                <span>{field.text}</span>
              </div>
            );
        }
      })}
    </>
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

function botConnectionLabel(connection: BotStatus['connection']): string {
  switch (connection) {
    case 'polling': return '长轮询';
    case 'gateway': return '事件通道';
    case 'webhook': return 'Webhook';
    case 'none': return '无';
  }
}
