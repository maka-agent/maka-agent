import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppSettings,
  ChatDefaultPermissionMode,
  LlmConnection,
  NetworkProxySettings,
  UpdateAppSettingsResult,
} from '@maka/core';
import { generalizedErrorMessageChinese } from '@maka/core';
import type { TestProxyInput } from '@maka/core/settings/network-settings';
import {
  Button,
  Input,
  NumberField,
  NumberFieldInput,
  ModelPicker,
  PermissionModeSelect,
  SettingsSelect,
  SettingsSwitch as Switch,
  modelChoiceValue,
  modelMenuGroups,
  parseModelChoiceValue,
  useToast,
} from '@maka/ui';
import { ProviderLogo } from './ProvidersPanel';
import { buildCatalogChatModelChoices } from '../model-catalog-choices';
import { PasswordInput } from './password-input';
import { SettingsRows } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';

export function GeneralSettingsPage(props: {
  settings: AppSettings;
  connections: readonly LlmConnection[];
  defaultSlug: string | null;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onRefreshConnections(): Promise<void>;
}) {
  const toast = useToast();
  return (
    <div className="settingsStructuredPage">
      <SettingsRows>
        <div className="settingsFormRow">
          <div>
            <strong>隐身模式</strong>
            <small>开启后暂停本地记忆读写、联网搜索和计划提醒触发；关闭后恢复正常工作区状态。</small>
          </div>
          <Switch
            ariaLabel="启用隐身模式"
            checked={props.settings.privacy.incognitoActive}
            onChange={(incognitoActive) => {
              props.onUpdate({ privacy: { incognitoActive } }).catch((error: unknown) => {
                toast.error('隐身模式切换失败', generalizedErrorMessageChinese(error, '设置未生效，请稍后重试'));
              });
            }}
          />
        </div>
      </SettingsRows>
      <GeneralDefaultsCard
        connections={props.connections}
        defaultSlug={props.defaultSlug}
        onRefresh={props.onRefreshConnections}
        permissionMode={props.settings.chatDefaults.permissionMode}
        onUpdate={props.onUpdate}
      />
      <SettingsRows>
        <NetworkProxySection settings={props.settings} onUpdate={props.onUpdate} />
      </SettingsRows>
    </div>
  );
}

/**
 * PR-GENERAL-DEFAULTS-CONFIGURABLE-0 (WAWQAQ msg `d3ea9a33` 2026-06-26):
 * the General page used to ship three read-only `<SettingRow>` lines
 * (启动 / 新对话模式 / 默认模型) that read like settings but had no
 * configurable backing — the static text was the entire UI. Drop the
 * two without backing storage; replace the third with a real
 * `<SettingsSelect>` that lets the user pick the default LLM model
 * inline. The selection is grouped by connection, but the persisted
 * default is the pair `{ slug, model }` via `connections.setDefaultModel`.
 *
 * PR-DEFAULT-PERMISSION-MODE-0: the composer's per-session permission-mode
 * picker (询问权限 / 自动执行 / 跳过确认) always reset new sessions back to
 * 询问权限 -- there was no way to change what a *new* chat starts on. Added
 * a second picker right below 默认模型, backed by
 * `settings.chatDefaults.permissionMode` (persisted via the generic
 * `settings.update` patch, unlike the model picker's dedicated
 * `connections.setDefaultModel` IPC). Renders the shared
 * `PermissionModeSelect` (Base UI Select) so labels, hints, and markup
 * can't drift from the composer picker.
 */
function GeneralDefaultsCard(props: {
  connections: readonly LlmConnection[];
  defaultSlug: string | null;
  onRefresh(): Promise<void>;
  permissionMode: ChatDefaultPermissionMode;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const toast = useToast();
  const mountedRef = useRef(true);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savingPermissionModeRef = useRef(false);
  const [savingPermissionMode, setSavingPermissionMode] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      savingRef.current = false;
      savingPermissionModeRef.current = false;
    };
  }, []);

  const modelChoices = useMemo(() => buildCatalogChatModelChoices(props.connections), [props.connections]);
  const modelGroups = useMemo(() => modelMenuGroups(modelChoices), [modelChoices]);
  const selectedValue = useMemo(() => {
    if (!props.defaultSlug) return '';
    const connection = props.connections.find((candidate) => candidate.slug === props.defaultSlug);
    if (!connection?.defaultModel) return '';
    const value = modelChoiceValue(connection.slug, connection.defaultModel);
    return modelChoices.some((choice) => modelChoiceValue(choice.connectionSlug, choice.model) === value) ? value : '';
  }, [modelChoices, props.connections, props.defaultSlug]);
  const selectedLabel = useMemo(() => {
    if (!selectedValue) return '未设置';
    return modelChoices.find((choice) => modelChoiceValue(choice.connectionSlug, choice.model) === selectedValue)?.label ?? '未设置';
  }, [modelChoices, selectedValue]);

  async function persistDefault(nextValue: string) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const parsed = parseModelChoiceValue(nextValue);
      await window.maka.connections.setDefaultModel(parsed ? {
        slug: parsed.llmConnectionSlug,
        model: parsed.model,
      } : null);
      if (!mountedRef.current) return;
      await props.onRefresh();
    } catch (error) {
      if (mountedRef.current) {
        toast.error('保存默认模型失败', settingsActionErrorMessage(error));
      }
    } finally {
      if (savingRef.current) {
        savingRef.current = false;
      }
      if (mountedRef.current) setSaving(false);
    }
  }

  async function persistPermissionMode(nextMode: ChatDefaultPermissionMode) {
    // Same re-entrancy guard as persistDefault above: the disabled trigger
    // alone can't fully prevent overlapping saves (React disables it a tick
    // after the click), and overlapping settings.update calls have no
    // ordering guarantee.
    if (savingPermissionModeRef.current) return;
    savingPermissionModeRef.current = true;
    setSavingPermissionMode(true);
    try {
      await props.onUpdate({ chatDefaults: { permissionMode: nextMode } });
    } catch (error) {
      if (mountedRef.current) {
        toast.error('保存默认权限模式失败', settingsActionErrorMessage(error));
      }
    } finally {
      savingPermissionModeRef.current = false;
      if (mountedRef.current) setSavingPermissionMode(false);
    }
  }

  return (
    <SettingsRows>
      <div className="settingsRow" data-control-width="select">
        <div>
          <strong>默认模型</strong>
          <small>新对话默认使用的具体模型；按连接分组，不显示 OAuth 账号邮箱。</small>
        </div>
        {/* Shared searchable picker with the composer's model switcher
            (ModelPicker in @maka/ui) so the grouped list, provider marks,
            and search behavior can't drift between the two surfaces. */}
        <ModelPicker
          groups={modelGroups}
          value={selectedValue}
          pinnedItem={{ value: '', label: '未设置' }}
          renderProviderMark={(type) => <ProviderLogo type={type} compact />}
          ariaLabel="默认模型"
          disabled={saving}
          triggerClassName="settingsSelectTrigger max-w-[320px] w-full"
          onValueChange={(value) => {
            void persistDefault(value);
          }}
        >
          <span className="settingsSelectMenuOption">{selectedLabel}</span>
        </ModelPicker>
      </div>
      <div className="settingsRow" data-control-width="select">
        <div>
          <strong>默认权限模式</strong>
          {/* Fixed description of the SETTING (not the selected option's own
              hint — the shared popup already shows every option's hint). */}
          <small>新对话默认使用的权限模式；可在对话内随时切换，仅影响新建对话的初始值。</small>
        </div>
        {/* Shared Base UI Select picker with the composer (PermissionModeSelect)
            — same component, so option markup can't drift between the two
            surfaces. Every option shows its label + hint before picking. */}
        <PermissionModeSelect
          activeMode={props.permissionMode}
          onSelect={(mode) => {
            void persistPermissionMode(mode);
          }}
          align="end"
          disabled={savingPermissionMode}
          ariaLabel="默认权限模式"
          className="settingsSelectTrigger max-w-[320px] w-full justify-between"
        />
      </div>
    </SettingsRows>
  );
}

function NetworkProxySection(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const persistedProxy = props.settings.network.proxy;
  const [proxyDraft, setProxyDraft] = useState<NetworkProxySettings>(persistedProxy);
  const [testing, setTesting] = useState(false);
  const proxyDraftRef = useRef<NetworkProxySettings>(persistedProxy);
  const persistedProxyRef = useRef<NetworkProxySettings>(persistedProxy);
  const proxyPendingSaveCountRef = useRef(0);
  const proxySaveTicketRef = useRef(0);
  const proxyTestRunningRef = useRef(false);
  const networkPageMountedRef = useRef(false);
  const toast = useToast();

  useEffect(() => {
    networkPageMountedRef.current = true;
    return () => {
      networkPageMountedRef.current = false;
      proxySaveTicketRef.current += 1;
      proxyTestRunningRef.current = false;
    };
  }, []);

  function commitProxyDraft(next: NetworkProxySettings) {
    proxyDraftRef.current = next;
    setProxyDraft(next);
  }

  useEffect(() => {
    persistedProxyRef.current = persistedProxy;
    if (proxyPendingSaveCountRef.current === 0) {
      commitProxyDraft(persistedProxy);
    }
  }, [persistedProxy]);

  async function updateProxy(patch: Partial<NetworkProxySettings>) {
    const nextDraft = { ...proxyDraftRef.current, ...patch };
    const ticket = proxySaveTicketRef.current + 1;
    proxySaveTicketRef.current = ticket;
    proxyPendingSaveCountRef.current += 1;
    commitProxyDraft(nextDraft);
    try {
      const result = await props.onUpdate({ network: { proxy: patch } });
      if (networkPageMountedRef.current && ticket === proxySaveTicketRef.current) {
        commitProxyDraft(result.settings.network.proxy);
      }
    } catch (error) {
      if (networkPageMountedRef.current && ticket === proxySaveTicketRef.current) {
        commitProxyDraft(persistedProxyRef.current);
        toast.error('保存网络设置失败', settingsActionErrorMessage(error));
      }
    } finally {
      proxyPendingSaveCountRef.current = Math.max(0, proxyPendingSaveCountRef.current - 1);
    }
  }

  async function testProxy() {
    if (proxyTestRunningRef.current) return;
    proxyTestRunningRef.current = true;
    setTesting(true);
    try {
      const result = await window.maka.settings.testNetworkProxy(toProxyTestInput(proxyDraftRef.current));
      const latency = result.latencyMs !== undefined ? ` · ${result.latencyMs} ms` : '';
      if (result.ok && networkPageMountedRef.current) {
        toast.success('代理可达', `${result.message}${latency}`);
      } else if (networkPageMountedRef.current) {
        toast.error('代理测试失败', result.message);
      }
    } catch (error) {
      if (networkPageMountedRef.current) {
        toast.error('代理测试出错', settingsActionErrorMessage(error));
      }
    } finally {
      proxyTestRunningRef.current = false;
      if (networkPageMountedRef.current) {
        setTesting(false);
      }
    }
  }

  return (
    <>
      <div className="settingsFormRow">
        <div>
          <strong>代理服务器</strong>
          <small>为 AI 模型请求配置网络代理</small>
        </div>
        <Switch
          ariaLabel="启用代理服务器"
          checked={proxyDraft.enabled}
          onChange={(enabled) => void updateProxy({ enabled })}
        />
      </div>

      {proxyDraft.enabled && (
        <>
          <div className="settingsFormGrid settingsFormGridProxy">
            <label>
              <span>代理协议</span>
              <SettingsSelect
                value={proxyDraft.protocol}
                ariaLabel="代理协议"
                options={[
                  ['http', 'HTTP/HTTPS'],
                  ['https', 'HTTPS'],
                  ['socks5', 'SOCKS5'],
                ] satisfies Array<readonly [NetworkProxySettings['protocol'], string]>}
                onChange={(protocol) => void updateProxy({ protocol })}
              />
            </label>
            <label>
              <span>服务器地址</span>
              <Input value={proxyDraft.host} onChange={(event) => void updateProxy({ host: event.currentTarget.value })} placeholder="127.0.0.1" aria-label="代理服务器地址" />
            </label>
            <label>
              <span>端口</span>
              <NumberField value={proxyDraft.port || null} onValueChange={(v) => void updateProxy({ port: v ?? 0 })}>
                <NumberFieldInput placeholder="7890" aria-label="代理端口" />
              </NumberField>
            </label>
          </div>

          <div className="settingsFormRow">
            <div>
              <strong>代理认证</strong>
              <small>需要用户名和密码时开启。</small>
            </div>
            <Switch
              ariaLabel="启用代理认证"
              checked={proxyDraft.authEnabled}
              onChange={(authEnabled) => void updateProxy({ authEnabled })}
            />
          </div>

          {proxyDraft.authEnabled && (
            <div className="settingsFormGrid">
              <label>
                <span>用户名</span>
                <Input value={proxyDraft.username} onChange={(event) => void updateProxy({ username: event.currentTarget.value })} aria-label="代理用户名" />
              </label>
              <label>
                <span>密码</span>
                <PasswordInput value={proxyDraft.password} onChange={(next) => void updateProxy({ password: next })} ariaLabel="代理密码" />
              </label>
            </div>
          )}

          <label className="settingsField">
            <span>代理白名单</span>
            <Input
              value={proxyDraft.bypassList.join(', ')}
              onChange={(event) => void updateProxy({ bypassList: csvList(event.currentTarget.value) })}
              placeholder="metaso.cn, baidu.com"
              aria-label="代理白名单"
            />
            <small>这些域名将绕过代理直连，多个用逗号分隔。</small>
          </label>

          <div className="settingsNotice">
            已自动添加 {proxyDraft.autoBypassDomains.length} 个域名（来自本地和模型供应商）。代理仅作用于 AI 模型请求，不影响应用自身网络。
          </div>

          <div className="settingsActionRow">
            <Button
              type="button"
              disabled={testing}
              aria-busy={testing}
              data-pending={testing ? 'true' : undefined}
              onClick={() => void testProxy()}
            >
              {testing ? '测试中…' : '测试当前配置'}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

function toProxyTestInput(proxy: NetworkProxySettings): TestProxyInput {
  return {
    proxy: {
      enabled: proxy.enabled,
      type: proxy.protocol,
      host: proxy.host.trim(),
      port: proxy.port,
      username: proxy.authEnabled && proxy.username.trim() ? proxy.username.trim() : undefined,
      password: proxy.authEnabled && proxy.password ? proxy.password : undefined,
      bypassList: proxy.bypassList,
    },
  };
}

function csvList(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}
