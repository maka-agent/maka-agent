import { useEffect, useMemo, useState } from 'react';
import type {
  McpConfigFile,
  McpServerConfig,
  McpServerStatus,
} from '@maka/core/mcp';
import { isMcpStdioConfig } from '@maka/core/mcp';
import { Button, Chip, Input, SettingsSwitch as Switch, Textarea, useMountedRef, useToast } from '@maka/ui';
import { Pencil, Plus, RefreshCcw, Trash2 } from '@maka/ui/icons';
import { SettingsRows } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';

type Draft = {
  id: string;
  kind: 'stdio' | 'remote';
  enabled: boolean;
  command: string;
  args: string;
  cwd: string;
  env: string;
  url: string;
  transport: 'auto' | 'streamable-http' | 'sse';
  headers: string;
};

const EMPTY_CONFIG: McpConfigFile = { version: 1, mcpServers: {} };

export function McpSettingsPage() {
  const [config, setConfig] = useState<McpConfigFile>(EMPTY_CONFIG);
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>('load');
  const mounted = useMountedRef();
  const toast = useToast();

  async function reload() {
    try {
      const [nextConfig, nextStatuses] = await Promise.all([
        window.maka.mcp.getConfig(),
        window.maka.mcp.listStatuses(),
      ]);
      if (!mounted.current) return;
      setConfig(nextConfig);
      setStatuses(nextStatuses);
    } catch (error) {
      if (mounted.current) toast.error('载入 MCP 失败', settingsActionErrorMessage(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  useEffect(() => {
    void reload();
    return window.maka.mcp.subscribeChanges((next) => {
      if (mounted.current) setStatuses(next);
    });
  }, []);

  const statusById = useMemo(
    () => new Map(statuses.map((status) => [status.serverId, status])),
    [statuses],
  );

  function beginAdd() {
    setEditingId(null);
    setDraft(emptyDraft());
  }

  function beginEdit(serverId: string, server: McpServerConfig) {
    setEditingId(serverId);
    setDraft(draftFromConfig(serverId, server));
  }

  async function saveDraft(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy('save');
    try {
      const next = await window.maka.mcp.upsert(draft.id.trim(), configFromDraft(draft));
      if (!mounted.current) return;
      setConfig(next);
      setDraft(null);
      setEditingId(null);
      toast.success('MCP server 已保存', '新工具会从下一次 agent turn 开始生效。');
    } catch (error) {
      if (mounted.current) toast.error('保存 MCP server 失败', settingsActionErrorMessage(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function toggle(serverId: string, server: McpServerConfig, enabled: boolean) {
    setBusy(`toggle:${serverId}`);
    try {
      const next = await window.maka.mcp.upsert(serverId, { ...server, enabled });
      if (mounted.current) setConfig(next);
    } catch (error) {
      if (mounted.current) toast.error('更新 MCP server 失败', settingsActionErrorMessage(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function testServer(serverId: string) {
    setBusy(`test:${serverId}`);
    try {
      const result = await window.maka.mcp.test(serverId);
      if (!mounted.current) return;
      setStatuses((current) => replaceStatus(current, result.status));
      if (result.ok) toast.success('MCP 连接正常', `${result.status.toolCount} 个工具 · ${result.latencyMs} ms`);
      else toast.error('MCP 连接失败', result.status.error ?? 'server 没有返回可用状态。');
    } catch (error) {
      if (mounted.current) toast.error('MCP 测试失败', settingsActionErrorMessage(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function remove(serverId: string) {
    if (!window.confirm(`删除 MCP server “${serverId}”？`)) return;
    setBusy(`remove:${serverId}`);
    try {
      const next = await window.maka.mcp.remove(serverId);
      if (!mounted.current) return;
      setConfig(next);
      setStatuses((current) => current.filter((status) => status.serverId !== serverId));
      toast.success('MCP server 已删除');
    } catch (error) {
      if (mounted.current) toast.error('删除 MCP server 失败', settingsActionErrorMessage(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  const entries = Object.entries(config.mcpServers);
  return (
    <div className="settingsStructuredPage mcpSettingsPage">
      <div className="mcpPageToolbar">
        <div>
          <strong>{entries.length} 个 server</strong>
          <small>支持 stdio、Streamable HTTP 与 legacy SSE fallback。</small>
        </div>
        <Button size="sm" onClick={beginAdd} disabled={Boolean(draft)}>
          <Plus size={15} aria-hidden="true" /> 添加 server
        </Button>
      </div>

      {draft && (
        <McpEditor
          draft={draft}
          setDraft={setDraft}
          editing={Boolean(editingId)}
          saving={busy === 'save'}
          onSubmit={saveDraft}
          onCancel={() => { setDraft(null); setEditingId(null); }}
        />
      )}

      {busy === 'load' ? (
        <SettingsRows><div className="mcpEmptyState">正在读取 MCP 配置…</div></SettingsRows>
      ) : entries.length === 0 && !draft ? (
        <SettingsRows>
          <div className="mcpEmptyState">
            <strong>还没有 MCP server</strong>
            <span>添加 local stdio command 或 remote MCP URL，连接后工具会进入 Maka 的 permission boundary。</span>
            <Button size="sm" variant="secondary" onClick={beginAdd}><Plus size={15} /> 添加第一个 server</Button>
          </div>
        </SettingsRows>
      ) : (
        entries.map(([serverId, server]) => (
          <McpServerCard
            key={serverId}
            serverId={serverId}
            server={server}
            status={statusById.get(serverId)}
            busy={busy}
            onToggle={(enabled) => void toggle(serverId, server, enabled)}
            onEdit={() => beginEdit(serverId, server)}
            onTest={() => void testServer(serverId)}
            onRemove={() => void remove(serverId)}
          />
        ))
      )}
    </div>
  );
}

function McpServerCard(props: {
  serverId: string;
  server: McpServerConfig;
  status?: McpServerStatus;
  busy: string | null;
  onToggle(enabled: boolean): void;
  onEdit(): void;
  onTest(): void;
  onRemove(): void;
}) {
  const state = presentStatus(props.status, props.server.enabled !== false);
  let endpoint: string;
  let transportLabel: string;
  if (isMcpStdioConfig(props.server)) {
    endpoint = [props.server.command, ...(props.server.args ?? [])].join(' ');
    transportLabel = 'Local stdio';
  } else {
    endpoint = props.server.url;
    transportLabel = props.server.transport ?? 'auto';
  }
  return (
    <SettingsRows className="mcpServerCard">
      <div className="mcpServerHeader">
        <div className="mcpServerIdentity">
          <span className="mcpStatusDot" data-tone={state.tone} aria-hidden="true" />
          <div><strong>{props.serverId}</strong><small>{transportLabel}</small></div>
        </div>
        <div className="mcpServerHeaderActions">
          <Chip variant={state.tone}>{state.label}</Chip>
          <Switch
            checked={props.server.enabled !== false}
            onChange={props.onToggle}
            disabled={props.busy === `toggle:${props.serverId}`}
            ariaLabel={`${props.serverId} 启用状态`}
          />
        </div>
      </div>
      <div className="mcpServerEndpoint" title={endpoint}>{endpoint}</div>
      {props.status?.error && <div className="mcpServerError" role="alert">{props.status.error}</div>}
      {props.status?.stderrTail?.length ? (
        <pre className="mcpStderrTail">{props.status.stderrTail.join('\n')}</pre>
      ) : null}
      <div className="mcpToolShelf" aria-label={`${props.serverId} 工具`}>
        {props.status?.tools.length
          ? props.status.tools.map((tool) => <span key={tool.name}>{tool.name}</span>)
          : <small>{props.server.enabled === false ? 'server 已停用' : '尚未发现工具'}</small>}
      </div>
      <div className="mcpServerActions">
        <Button size="sm" variant="secondary" onClick={props.onTest} disabled={props.busy === `test:${props.serverId}`}>
          <RefreshCcw size={14} /> {props.busy === `test:${props.serverId}` ? '测试中…' : '测试连接'}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onEdit}><Pencil size={14} /> 编辑</Button>
        <Button size="sm" variant="ghost" onClick={props.onRemove} disabled={props.busy === `remove:${props.serverId}`}>
          <Trash2 size={14} /> 删除
        </Button>
      </div>
    </SettingsRows>
  );
}

function McpEditor(props: {
  draft: Draft;
  setDraft(next: Draft): void;
  editing: boolean;
  saving: boolean;
  onSubmit(event: React.FormEvent): void;
  onCancel(): void;
}) {
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => props.setDraft({ ...props.draft, [key]: value });
  return (
    <SettingsRows className="mcpEditorCard">
      <form onSubmit={props.onSubmit}>
        <div className="mcpEditorHeading">
          <div><strong>{props.editing ? `编辑 ${props.draft.id}` : '添加 MCP server'}</strong><small>配置保存在当前 Maka workspace 的 mcp.json。</small></div>
          <div className="mcpKindPicker" role="group" aria-label="MCP transport 类型">
            <Button type="button" size="sm" variant={props.draft.kind === 'stdio' ? 'default' : 'ghost'} onClick={() => update('kind', 'stdio')}>stdio</Button>
            <Button type="button" size="sm" variant={props.draft.kind === 'remote' ? 'default' : 'ghost'} onClick={() => update('kind', 'remote')}>Remote</Button>
          </div>
        </div>
        <div className="mcpEditorGrid">
          <label className="settingsField"><span>Server ID</span><Input value={props.draft.id} onChange={(event) => update('id', event.target.value)} disabled={props.editing} required placeholder="filesystem" /><small>稳定 identity，也会进入 tool name。</small></label>
          {props.draft.kind === 'stdio' ? (
            <>
              <label className="settingsField"><span>Command</span><Input value={props.draft.command} onChange={(event) => update('command', event.target.value)} required placeholder="npx" /></label>
              <label className="settingsField"><span>Working directory</span><Input value={props.draft.cwd} onChange={(event) => update('cwd', event.target.value)} placeholder="可选，例如 /tmp" /></label>
              <label className="settingsField mcpFieldWide"><span>Arguments</span><Textarea value={props.draft.args} onChange={(event) => update('args', event.target.value)} placeholder={'每行一个 argument\n-y\n@modelcontextprotocol/server-filesystem\n/tmp'} /><small>每行作为一个独立 argument，不经过 shell interpolation。</small></label>
              <label className="settingsField mcpFieldWide"><span>Environment</span><Textarea value={props.draft.env} onChange={(event) => update('env', event.target.value)} placeholder={'KEY=value\nTOKEN=secret'} /><small>仅显式变量和安全 system allowlist 会传给 child process。</small></label>
            </>
          ) : (
            <>
              <label className="settingsField mcpFieldWide"><span>MCP URL</span><Input type="url" value={props.draft.url} onChange={(event) => update('url', event.target.value)} required placeholder="https://example.com/mcp" /></label>
              <label className="settingsField"><span>Transport</span><select value={props.draft.transport} onChange={(event) => update('transport', event.target.value as Draft['transport'])}><option value="auto">Auto fallback</option><option value="streamable-http">Streamable HTTP</option><option value="sse">Legacy SSE</option></select></label>
              <label className="settingsField mcpFieldWide"><span>HTTP headers</span><Textarea value={props.draft.headers} onChange={(event) => update('headers', event.target.value)} placeholder={'Authorization=Bearer …\nX-Workspace=…'} /><small>V1 以 owner-only 0600 文件保存；后续迁移到 Keychain。</small></label>
            </>
          )}
        </div>
        <div className="mcpEditorActions"><Button type="button" variant="ghost" onClick={props.onCancel}>取消</Button><Button type="submit" disabled={props.saving}>{props.saving ? '保存中…' : '保存并连接'}</Button></div>
      </form>
    </SettingsRows>
  );
}

function emptyDraft(): Draft {
  return { id: '', kind: 'stdio', enabled: true, command: '', args: '', cwd: '', env: '', url: '', transport: 'auto', headers: '' };
}

function draftFromConfig(id: string, config: McpServerConfig): Draft {
  if ('command' in config) {
    return { ...emptyDraft(), id, enabled: config.enabled !== false, command: config.command, args: (config.args ?? []).join('\n'), cwd: config.cwd ?? '', env: formatMap(config.env) };
  }
  return { ...emptyDraft(), id, kind: 'remote', enabled: config.enabled !== false, url: config.url, transport: config.transport ?? 'auto', headers: formatMap(config.headers) };
}

function configFromDraft(draft: Draft): McpServerConfig {
  if (draft.kind === 'stdio') {
    return {
      enabled: draft.enabled,
      command: draft.command.trim(),
      args: draft.args.split(/\r?\n/u).filter((line) => line.length > 0),
      ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
      env: parseMap(draft.env),
    };
  }
  return { enabled: draft.enabled, url: draft.url.trim(), transport: draft.transport, headers: parseMap(draft.headers) };
}

function parseMap(value: string): Record<string, string> {
  return Object.fromEntries(value.split(/\r?\n/u).filter((line) => line.trim()).map((line, index) => {
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`第 ${index + 1} 行应为 KEY=value`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1)];
  }));
}

function formatMap(value?: Record<string, string>): string {
  return Object.entries(value ?? {}).map(([key, item]) => `${key}=${item}`).join('\n');
}

function replaceStatus(statuses: McpServerStatus[], next: McpServerStatus): McpServerStatus[] {
  return [...statuses.filter((status) => status.serverId !== next.serverId), next];
}

function presentStatus(status: McpServerStatus | undefined, enabled: boolean): { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive' } {
  if (!enabled || status?.state === 'disabled') return { label: '已停用', tone: 'neutral' };
  if (!status || status.state === 'disconnected') return { label: '未连接', tone: 'neutral' };
  if (status.state === 'connecting') return { label: '连接中', tone: 'info' };
  if (status.state === 'connected') return { label: `${status.toolCount} tools`, tone: 'success' };
  return { label: '连接失败', tone: 'destructive' };
}
