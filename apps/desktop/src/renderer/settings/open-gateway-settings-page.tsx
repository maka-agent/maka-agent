import { useEffect, useState } from 'react';
import type { AppSettings, OpenGatewayRuntimeStatus, UpdateAppSettingsResult } from '@maka/core';
import { Button, Input, NumberField, NumberFieldInput, SettingsSelect, SettingsSwitch as Switch, Textarea, useToast } from '@maka/ui';
import { PasswordInput } from './password-input';
import { MetricCard } from './settings-metric-card';
import { SettingsRows, SettingRow } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';
import { useActionGuard } from './use-action-guard';
import { useOptimisticSettingsDraft } from './use-optimistic-settings-draft';

export function OpenGatewaySettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const persistedGateway = props.settings.openGateway;
  const [status, setStatus] = useState<OpenGatewayRuntimeStatus | null>(null);
  const [statusLoadError, setStatusLoadError] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState(persistedGateway.token);
  const [eventSessionId, setEventSessionId] = useState('');
  const [copyingGatewayAction, setCopyingGatewayAction] = useState<string | null>(null);
  const gatewayCopyGuard = useActionGuard<string>();
  const toast = useToast();
  const {
    draft: gatewayDraft,
    mountedRef: openGatewayMountedRef,
    saving,
    update,
  } = useOptimisticSettingsDraft<AppSettings['openGateway']>(
    persistedGateway,
    (patch) => props.onUpdate({ openGateway: patch }).then((result) => result.settings.openGateway),
    {
      onError: (error) => toast.error('保存开放网关设置失败', settingsActionErrorMessage(error)),
      onReconcile: (next) => setTokenDraft(next.token),
    },
  );

  useEffect(() => {
    let cancelled = false;
    window.maka.gateway
      .status()
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
          setStatusLoadError(null);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        const message = settingsActionErrorMessage(error);
        setStatusLoadError(message);
        toast.error('读取开放网关状态失败', message);
      });
    const unsubscribe = window.maka.gateway.subscribeStatusChanges((next) => {
      if (!cancelled) {
        setStatus(next);
        setStatusLoadError(null);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  function updateGateway(patch: Partial<AppSettings['openGateway']>): Promise<boolean> {
    return update(patch);
  }

  async function saveToken(nextToken = tokenDraft.trim()) {
    const saved = await updateGateway({ token: nextToken });
    if (!saved || !openGatewayMountedRef.current) return;
    toast.success(nextToken ? '网关 token 已保存' : '网关 token 已清空');
  }

  async function generateToken() {
    const token = generateGatewayToken();
    setTokenDraft(token);
    const saved = await updateGateway({ token });
    if (!saved || !openGatewayMountedRef.current) return;
    toast.success('网关 token 已生成', '本机 API 需要 Authorization Bearer token。');
  }

  async function copyGatewayText(action: string, text: string, successTitle: string, successDetail: string) {
    if (!gatewayCopyGuard.begin(action)) return;
    setCopyingGatewayAction(action);
    try {
      await navigator.clipboard.writeText(text);
      if (openGatewayMountedRef.current) {
        toast.success(successTitle, successDetail);
      }
    } catch {
      if (openGatewayMountedRef.current) {
        toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
      }
    } finally {
      gatewayCopyGuard.finish();
      if (openGatewayMountedRef.current) {
        setCopyingGatewayAction(null);
      }
    }
  }

  async function copyBaseUrl() {
    const baseUrl = status?.baseUrl ?? gatewayBaseUrl(gatewayDraft.host, gatewayDraft.port);
    await copyGatewayText('base-url', baseUrl, '已复制网关地址', baseUrl);
  }

  const baseUrl = status?.baseUrl ?? gatewayBaseUrl(gatewayDraft.host, gatewayDraft.port);
  async function copyOverviewCurl() {
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/state`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('overview-curl', command, '已复制总览 curl', '可在终端验证开放网关状态。');
  }

  async function copyOpenApiCurl() {
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/openapi.json`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('openapi-curl', command, '已复制接口说明 curl', '可交给外部工具发现本机 API。');
  }

  async function copySessionStateCurl() {
    const sessionId = eventSessionId.trim() ? encodeURIComponent(eventSessionId.trim()) : '<SESSION_ID>';
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/sessions/${sessionId}/state`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('session-state-curl', command, '已复制单会话状态 curl', sessionId === '<SESSION_ID>' ? '把 <SESSION_ID> 替换成目标会话 ID 后运行。' : '可在终端查看单个会话状态。');
  }

  async function copyEventStreamCurl() {
    const sessionId = eventSessionId.trim() ? encodeURIComponent(eventSessionId.trim()) : '<SESSION_ID>';
    const command = [
      'curl -N -sS',
      shellSingleQuote(`${baseUrl}/v1/sessions/${sessionId}/events`),
      '-H',
      shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`),
      '-H',
      shellSingleQuote('Accept: text/event-stream'),
    ].join(' ');
    await copyGatewayText('event-stream-curl', command, '已复制事件流 curl', sessionId === '<SESSION_ID>' ? '把 <SESSION_ID> 替换成目标会话 ID 后运行。' : '可在终端观察当前会话事件。');
  }

  async function copyRecentEventsCurl() {
    const sessionId = eventSessionId.trim() ? encodeURIComponent(eventSessionId.trim()) : '<SESSION_ID>';
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/sessions/${sessionId}/events/recent`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('recent-events-curl', command, '已复制最近事件 curl', sessionId === '<SESSION_ID>' ? '把 <SESSION_ID> 替换成目标会话 ID 后运行。' : '可在终端查看最近事件摘要。');
  }

  async function copyRecentRequestsCurl() {
    const command = `curl -sS ${shellSingleQuote(`${baseUrl}/v1/requests/recent`)} -H ${shellSingleQuote(`Authorization: Bearer ${gatewayDraft.token}`)}`;
    await copyGatewayText('recent-requests-curl', command, '已复制最近请求 curl', '可在终端查看网关请求元数据。');
  }

  const state = presentGatewayStatus(status, gatewayDraft);
  const isCopyingGatewayAction = (action: string) => copyingGatewayAction === action;
  const gatewayCopyDisabled = Boolean(copyingGatewayAction);

  return (
    <div className="settingsStructuredPage">
      <div className="settingsUsageSummary" role="group" aria-label="开放网关状态">
        <MetricCard title="状态" value={state.label} detail={state.detail} />
        <MetricCard title="监听地址" value={baseUrl} detail={gatewayDraft.host === '0.0.0.0' ? '局域网可访问' : '仅本机'} />
        <MetricCard title="访问凭据" value={gatewayDraft.token ? '已配置' : '等待 token'} detail="Bearer token 保护所有 /v1 API" />
        <MetricCard title="实时连接" value={String(status?.activeEventStreams ?? 0)} detail="SSE 客户端" />
        <MetricCard title="能力" value="19 个端点" detail="/health · openapi · state · sessions · events · requests" />
      </div>
      {statusLoadError && (
        <div className="settingsNotice" role="alert">
          开放网关运行状态读取失败：{statusLoadError}
        </div>
      )}

      <div className="settingsFormRow">
        <div>
          <strong>开放本机 API 网关</strong>
          <small>启动一个本机 HTTP 服务，让外部工具读取会话、消息和本地搜索结果。</small>
        </div>
        <Switch
          ariaLabel="开放本机 API 网关"
          checked={gatewayDraft.enabled}
          onChange={(enabled) => void updateGateway({ enabled })}
        />
      </div>

      <div className="settingsFormGrid settingsFormGridProxy">
        <label>
          <span>监听地址</span>
          <SettingsSelect
            value={gatewayDraft.host}
            ariaLabel="开放网关监听地址"
            options={[
              ['127.0.0.1', '127.0.0.1'],
              ['0.0.0.0', '0.0.0.0'],
            ] satisfies Array<readonly [AppSettings['openGateway']['host'], string]>}
            onChange={(host) => void updateGateway({ host })}
          />
        </label>
        <label>
          <span>端口</span>
          <NumberField value={gatewayDraft.port} format={{ useGrouping: false }} onValueChange={(v) => void updateGateway({ port: v ?? 3939 })}>
            <NumberFieldInput inputMode="numeric" aria-label="开放网关端口" />
          </NumberField>
        </label>
        <label>
          <span>访问 token</span>
          <PasswordInput
            value={tokenDraft}
            onChange={setTokenDraft}
            disabled={saving}
            onBlur={() => {
              if (tokenDraft !== gatewayDraft.token) void saveToken();
            }}
            placeholder="生成或输入 token"
            ariaLabel="开放网关访问 token"
          />
        </label>
        <label>
          <span>会话 sessionId</span>
          <Input
            value={eventSessionId}
            disabled={saving}
            placeholder="留空则复制 <SESSION_ID> 模板"
            onChange={(event) => setEventSessionId(event.currentTarget.value)}
            aria-label="开放网关会话 sessionId"
          />
        </label>
      </div>

      {gatewayDraft.enabled && !gatewayDraft.token && (
        <div className="settingsNotice" data-tone="passive">
          网关已开启，等待生成访问 token。生成 token 后服务会自动启动。
        </div>
      )}
      {status?.lastError && (
        <div className="settingsNotice">
          启动状态：{gatewayErrorCopy(status.lastError)}
        </div>
      )}

      <div className="settingsActionRow" role="group" aria-label="开放网关操作">
        <Button type="button" disabled={saving} onClick={() => void generateToken()}>
          生成 token
        </Button>
        <Button variant="secondary" type="button" disabled={!gatewayDraft.token || saving} onClick={() => void saveToken('')}>
          清空 token
        </Button>
        <Button variant="secondary" type="button" className="min-w-[4rem]" disabled={gatewayCopyDisabled} onClick={() => void copyBaseUrl()}>
          {isCopyingGatewayAction('base-url') ? '复制中…' : '复制地址'}
        </Button>
      </div>

      <SettingsRows>
        <SettingRow title="健康检查" detail="不需要 token，用于确认网关进程是否启动。" value="GET /health" />
        <SettingRow title="接口说明" detail="需要 Bearer token，返回 OpenAPI 3.1 描述，方便外部工具自动发现开放网关能力。" value="GET /v1/openapi.json" action={<Button variant="secondary" size="sm" className="settingsRowCurlButton min-w-[5rem]" disabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyOpenApiCurl()} aria-label="复制接口说明 curl">{isCopyingGatewayAction('openapi-curl') ? '复制中…' : '复制 curl'}</Button>} />
        <SettingRow title="总览状态" detail="需要 Bearer token，返回网关运行态、会话状态、请求状态、失败索引状态和能力清单，不含正文或预览。" value="GET /v1/state" action={<Button variant="secondary" size="sm" className="settingsRowCurlButton min-w-[5rem]" disabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyOverviewCurl()} aria-label="复制总览 curl">{isCopyingGatewayAction('overview-curl') ? '复制中…' : '复制 curl'}</Button>} />
        <SettingRow title="能力清单" detail="需要 Bearer token，返回当前开放的本机 API 能力。" value="GET /v1/capabilities" />
        <SettingRow title="会话列表" detail="需要 Bearer token，返回本地 session summary。" value="GET /v1/sessions" />
        <SettingRow title="会话状态" detail="需要 Bearer token，返回会话数量、未读数、状态分布和最近失败计数，不含标题或预览。" value="GET /v1/sessions/state" />
        <SettingRow title="单会话状态" detail="需要 Bearer token，返回单个会话的状态、消息计数、事件缓冲和失败计数，不含标题、正文或预览。" value="GET /v1/sessions/:id/state" action={<Button variant="secondary" size="sm" className="settingsRowCurlButton min-w-[5rem]" disabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copySessionStateCurl()} aria-label="复制单会话状态 curl">{isCopyingGatewayAction('session-state-curl') ? '复制中…' : '复制 curl'}</Button>} />
        <SettingRow title="会话消息" detail="需要 Bearer token，按 sessionId 读取本地消息；支持 limit / before 分页。" value="GET /v1/sessions/:id/messages" />
        <SettingRow title="消息状态" detail="需要 Bearer token，返回消息数量和边界摘要，不含正文。" value="GET /v1/sessions/:id/messages/state" />
        <SettingRow title="发送消息" detail="需要 Bearer token，向已有会话追加一条用户消息并返回 turnId。" value="POST /v1/sessions/:id/messages" />
        <SettingRow title="实时事件" detail="需要 Bearer token，SSE 输出当前会话 live 事件；支持 Last-Event-ID / after 补发最近事件。" value="GET /v1/sessions/:id/events" action={<Button variant="secondary" size="sm" className="settingsRowCurlButton min-w-[5rem]" disabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyEventStreamCurl()} aria-label="复制事件流 curl">{isCopyingGatewayAction('event-stream-curl') ? '复制中…' : '复制 curl'}</Button>} />
        <SettingRow title="事件状态" detail="需要 Bearer token，返回当前事件 replay buffer 和实时连接状态，不含事件正文。" value="GET /v1/sessions/:id/events/state" />
        <SettingRow title="最近事件摘要" detail="需要 Bearer token，返回当前会话最近事件的 id、类型、turnId 和时间，不含事件正文。" value="GET /v1/sessions/:id/events/recent" action={<Button variant="secondary" size="sm" className="settingsRowCurlButton min-w-[5rem]" disabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyRecentEventsCurl()} aria-label="复制最近事件 curl">{isCopyingGatewayAction('recent-events-curl') ? '复制中…' : '复制 curl'}</Button>} />
        <SettingRow title="全局事件状态" detail="需要 Bearer token，跨会话返回事件 replay buffer 和实时连接聚合状态，不含事件正文。" value="GET /v1/events/state" />
        <SettingRow title="最近请求" detail="需要 Bearer token，返回最近网关请求的 requestId、方法、路径、状态码和耗时，不含 query、header 或 body。" value="GET /v1/requests/recent" action={<Button variant="secondary" size="sm" className="settingsRowCurlButton min-w-[5rem]" disabled={!gatewayDraft.token || gatewayCopyDisabled} onClick={() => void copyRecentRequestsCurl()} aria-label="复制最近请求 curl">{isCopyingGatewayAction('recent-requests-curl') ? '复制中…' : '复制 curl'}</Button>} />
        <SettingRow title="失败记录" detail="需要 Bearer token，返回最近错误和中断摘要，用于外部恢复面板。" value="GET /v1/sessions/:id/incidents" />
        <SettingRow title="失败索引" detail="需要 Bearer token，跨会话返回最近错误和中断摘要。" value="GET /v1/incidents" />
        <SettingRow title="失败索引状态" detail="需要 Bearer token，跨会话返回最近失败总数、涉及会话数和边界摘要。" value="GET /v1/incidents/state" />
        <SettingRow title="本地搜索" detail="需要 Bearer token，复用 Maka 的 thread search。" value="GET /v1/search/thread?q=..." />
      </SettingsRows>

      <p className="settingsHelpText">
        /v1 接口默认关闭且都需要 token；发送消息会走当前会话的模型和权限边界。把监听地址设成 0.0.0.0 会让同一局域网设备可访问，请只在可信网络中使用。
      </p>
    </div>
  );
}

function gatewayBaseUrl(host: AppSettings['openGateway']['host'], port: number): string {
  return `http://${host}:${port}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function presentGatewayStatus(
  status: OpenGatewayRuntimeStatus | null,
  settings: AppSettings['openGateway'],
): { label: string; detail: string } {
  if (!settings.enabled) return { label: '已关闭', detail: '设置开关关闭' };
  if (!settings.token) return { label: '等待 token', detail: '生成访问 token 后服务会自动启动' };
  if (!status) return { label: '读取中', detail: '正在读取运行状态' };
  if (status.running) return { label: '运行中', detail: status.startedAt ? '本机 API 已启动' : '服务已监听' };
  return { label: '启动失败', detail: gatewayErrorCopy(status.lastError ?? 'gateway_start_failed') };
}

function gatewayErrorCopy(error: string): string {
  if (error === 'missing_token') return '等待生成访问 token';
  if (error === 'start_failed' || error === 'gateway_start_failed') return '开放网关暂时无法启动，请检查监听地址和端口。';
  if (error.includes('EADDRINUSE')) return '端口已被占用';
  return '开放网关暂时无法启动，请检查监听地址和端口。';
}

function generateGatewayToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
