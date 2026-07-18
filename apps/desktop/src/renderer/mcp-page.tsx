import { useEffect, useMemo, useRef, useState } from 'react';
import type { McpConfigFile, McpServerConfig, McpServerStatus } from '@maka/core/mcp';
import { isMcpStdioConfig } from '@maka/core/mcp';
import {
  Button,
  Chip,
  DialogContent,
  DialogHeader,
  DialogRoot,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  SettingsSwitch as Switch,
  Textarea,
  useMountedRef,
  useToast,
} from '@maka/ui';
import {
  FileCode,
  Globe,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCcw,
  Search,
  Terminal,
  Trash2,
  X,
} from '@maka/ui/icons';
import { MCP_CATALOG, catalogEntryMatches, type McpCatalogEntry } from './mcp-catalog';
import { parseMcpImport } from './mcp-import';
import { settingsActionErrorMessage } from './settings/settings-error-copy';

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

type EditorState =
  | { mode: 'manual'; draft: Draft; editingId: string | null }
  | { mode: 'json'; source: string }
  | null;

const EMPTY_CONFIG: McpConfigFile = { version: 1, mcpServers: {} };
const MIN_INSTALL_INDICATOR_MS = 500;

type InstallPhase = 'installing' | 'cancelling';

export function McpPage() {
  const [config, setConfig] = useState<McpConfigFile>(EMPTY_CONFIG);
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [editor, setEditor] = useState<EditorState>(null);
  const [activeTab, setActiveTab] = useState<'market' | 'installed'>('market');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>('load');
  const [installPhases, setInstallPhases] = useState<Record<string, InstallPhase>>({});
  const cancelledInstalls = useRef(new Set<string>());
  const mounted = useMountedRef();
  const toast = useToast();

  async function reload() {
    setBusy((current) => current ?? 'load');
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
  const entries = Object.entries(config.mcpServers);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const marketEntries = MCP_CATALOG.filter((entry) => catalogEntryMatches(entry, normalizedQuery));
  const installedEntries = entries.filter(([serverId, server]) => {
    if (!normalizedQuery) return true;
    const status = statusById.get(serverId);
    return [serverId, endpointFor(server), ...status?.tools.map((tool) => tool.name) ?? []]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });

  function openManual(draft: Draft = emptyDraft()) {
    setEditor({ mode: 'manual', draft: { ...draft }, editingId: null });
  }

  function openEdit(serverId: string, server: McpServerConfig) {
    setEditor({ mode: 'manual', draft: draftFromConfig(serverId, server), editingId: serverId });
  }

  async function installCatalogEntry(entry: McpCatalogEntry) {
    if (installPhases[entry.id] || config.mcpServers[entry.id]) return;
    cancelledInstalls.current.delete(entry.id);
    setInstallPhases((current) => ({ ...current, [entry.id]: 'installing' }));
    try {
      const minimumIndicator = delay(MIN_INSTALL_INDICATOR_MS);
      const next = await window.maka.mcp.install(entry.id, structuredClone(entry.config));
      await minimumIndicator;
      if (!mounted.current || cancelledInstalls.current.has(entry.id)) return;
      setConfig(next);
      if (entry.setupRequired) {
        toast.success(`${entry.name} 模板已安装`, '请在「已安装」中完成凭据配置，再启用连接。');
      } else {
        toast.success(`${entry.name} 已安装`, '发现的工具会从下一次 agent turn 开始生效。');
      }
    } catch (error) {
      if (mounted.current && !cancelledInstalls.current.has(entry.id)) {
        toast.error(`安装 ${entry.name} 失败`, settingsActionErrorMessage(error));
      }
    } finally {
      const wasCancelled = cancelledInstalls.current.delete(entry.id);
      if (mounted.current && !wasCancelled) {
        setInstallPhases((current) => omitKey(current, entry.id));
      }
    }
  }

  async function cancelCatalogInstall(entry: McpCatalogEntry) {
    if (installPhases[entry.id] !== 'installing') return;
    cancelledInstalls.current.add(entry.id);
    setInstallPhases((current) => ({ ...current, [entry.id]: 'cancelling' }));
    try {
      const next = await window.maka.mcp.cancelInstall(entry.id);
      if (!mounted.current) return;
      setConfig(next);
      setStatuses((current) => current.filter((status) => status.serverId !== entry.id));
      toast.info(`已取消安装 ${entry.name}`);
    } catch (error) {
      cancelledInstalls.current.delete(entry.id);
      if (mounted.current) {
        toast.error(`取消安装 ${entry.name} 失败`, settingsActionErrorMessage(error));
        void reload();
      }
    } finally {
      if (mounted.current) setInstallPhases((current) => omitKey(current, entry.id));
    }
  }

  async function saveDraft(event: React.FormEvent) {
    event.preventDefault();
    if (!editor || editor.mode !== 'manual') return;
    setBusy('save');
    try {
      const next = await window.maka.mcp.upsert(editor.draft.id.trim(), configFromDraft(editor.draft));
      if (!mounted.current) return;
      setConfig(next);
      setEditor(null);
      setActiveTab('installed');
      toast.success('MCP 已保存', '新工具会从下一次 agent turn 开始生效。');
    } catch (error) {
      if (mounted.current) toast.error('保存 MCP 失败', settingsActionErrorMessage(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function importJson(event: React.FormEvent) {
    event.preventDefault();
    if (!editor || editor.mode !== 'json') return;
    setBusy('import');
    try {
      const imported = parseMcpImport(editor.source);
      const next = await window.maka.mcp.setConfig({
        version: 1,
        mcpServers: { ...config.mcpServers, ...imported.mcpServers },
      });
      if (!mounted.current) return;
      setConfig(next);
      setEditor(null);
      setActiveTab('installed');
      toast.success('已导入 MCP', `本次导入 ${Object.keys(imported.mcpServers).length} 个 server。`);
    } catch (error) {
      if (mounted.current) toast.error('导入 MCP 失败', settingsActionErrorMessage(error));
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
      if (mounted.current) toast.error('更新 MCP 失败', settingsActionErrorMessage(error));
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
      else toast.error('MCP 连接失败', result.status.error ?? 'Server 没有返回可用状态。');
    } catch (error) {
      if (mounted.current) toast.error('MCP 测试失败', settingsActionErrorMessage(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function remove(serverId: string) {
    const confirmed = await toast.confirm({
      title: `删除 MCP「${serverId}」？`,
      description: '它提供的工具会从下一次 agent turn 中移除，配置无法自动恢复。',
      confirmLabel: '删除', cancelLabel: '取消', destructive: true,
    });
    if (!confirmed || !mounted.current) return;
    setBusy(`remove:${serverId}`);
    try {
      const next = await window.maka.mcp.remove(serverId);
      if (!mounted.current) return;
      setConfig(next);
      setStatuses((current) => current.filter((status) => status.serverId !== serverId));
      toast.success('MCP 已删除');
    } catch (error) {
      if (mounted.current) toast.error('删除 MCP 失败', settingsActionErrorMessage(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  return (
    <main className="maka-main detailPane maka-module-main maka-mcp-page agents-chat-panel" data-module="mcp" aria-label="MCP">
      <header className="maka-module-main-header maka-mcp-header">
        <div>
          <h2>MCP</h2>
          <p>连接外部应用、数据与服务，为 Maka 安全地扩展新工具。</p>
        </div>
        <div className="maka-module-main-actions">
          <Button size="icon-sm" variant="quiet" aria-label="刷新 MCP" title="刷新" onClick={() => void reload()} disabled={busy === 'load'}>
            <RefreshCcw aria-hidden="true" />
          </Button>
          <Button variant="secondary" onClick={() => setEditor({ mode: 'json', source: exampleJson() })}>
            <FileCode aria-hidden="true" /> JSON 导入
          </Button>
          <Button onClick={() => openManual()}><Plus aria-hidden="true" /> 添加 MCP</Button>
        </div>
      </header>

      <section className="maka-mcp-workspace" aria-label="MCP 市场与已安装项">
        <div className="maka-mcp-hero">
          <div>
            <strong>把 Maka 连接到你的工作环境</strong>
            <span>从精选模板开始，或添加任意 stdio、Streamable HTTP 与 SSE server。</span>
          </div>
          <div className="maka-mcp-hero-signal" aria-hidden="true">
            <Terminal /><span /><Plug /><span /><Globe />
          </div>
        </div>

        <div className="maka-mcp-controls">
          <div className="maka-mcp-tabs" role="tablist" aria-label="MCP 分类">
            <button id="maka-mcp-market-tab" type="button" role="tab" aria-controls="maka-mcp-tab-panel" aria-selected={activeTab === 'market'} data-active={activeTab === 'market'} onClick={() => setActiveTab('market')}>市场</button>
            <button id="maka-mcp-installed-tab" type="button" role="tab" aria-controls="maka-mcp-tab-panel" aria-selected={activeTab === 'installed'} data-active={activeTab === 'installed'} onClick={() => setActiveTab('installed')}>
              已安装 <span>{entries.length}</span>
            </button>
          </div>
          <InputGroup className="maka-mcp-search">
            <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
            <InputGroupInput type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索 MCP…" aria-label="搜索 MCP" />
          </InputGroup>
        </div>

        <div
          id="maka-mcp-tab-panel"
          className="maka-mcp-tab-panel"
          role="tabpanel"
          aria-labelledby={activeTab === 'market' ? 'maka-mcp-market-tab' : 'maka-mcp-installed-tab'}
        >
          {busy === 'load' ? (
            <div className="maka-mcp-loading" role="status">正在读取 MCP 配置…</div>
          ) : activeTab === 'market' ? (
            marketEntries.length > 0 ? (
              <div className="maka-mcp-market-grid">
                {marketEntries.map((entry) => (
                  <McpCatalogCard
                    key={entry.id}
                    entry={entry}
                    installed={Boolean(config.mcpServers[entry.id])}
                    phase={installPhases[entry.id]}
                    onInstall={() => void installCatalogEntry(entry)}
                    onCancel={() => void cancelCatalogInstall(entry)}
                    onManage={() => {
                      const installed = config.mcpServers[entry.id];
                      if (installed) openEdit(entry.id, installed);
                    }}
                  />
                ))}
              </div>
            ) : <McpNoResults query={query} onClear={() => setQuery('')} />
          ) : entries.length === 0 ? (
            <div className="maka-mcp-empty">
              <Plug aria-hidden="true" />
              <strong>还没有安装 MCP</strong>
              <span>从市场选择模板，或手动添加你自己的 server。</span>
              <Button size="sm" onClick={() => setActiveTab('market')}>浏览市场</Button>
            </div>
          ) : installedEntries.length > 0 ? (
            <ul className="maka-mcp-server-list">
              {installedEntries.map(([serverId, server]) => (
                <McpServerRow
                  key={serverId}
                  serverId={serverId}
                  server={server}
                  status={statusById.get(serverId)}
                  busy={busy}
                  onToggle={(enabled) => void toggle(serverId, server, enabled)}
                  onEdit={() => openEdit(serverId, server)}
                  onTest={() => void testServer(serverId)}
                  onRemove={() => void remove(serverId)}
                />
              ))}
            </ul>
          ) : <McpNoResults query={query} onClear={() => setQuery('')} />}
        </div>
      </section>

      {editor && (
        <McpEditorDialog
          state={editor}
          saving={busy === 'save' || busy === 'import'}
          onChange={setEditor}
          onClose={() => setEditor(null)}
          onSave={saveDraft}
          onImport={importJson}
        />
      )}
    </main>
  );
}

function McpCatalogCard(props: {
  entry: McpCatalogEntry;
  installed: boolean;
  phase?: InstallPhase;
  onInstall(): void;
  onCancel(): void;
  onManage(): void;
}) {
  const installing = props.phase === 'installing';
  const cancelling = props.phase === 'cancelling';
  return (
    <article className="maka-mcp-market-card">
      <div className="maka-mcp-market-icon" data-brand={props.entry.id} aria-hidden="true">
        <McpBrandMark entry={props.entry} />
      </div>
      <div className="maka-mcp-market-copy">
        <strong>{props.entry.name}</strong>
        <p>{props.entry.description}</p>
        <small>
          {props.entry.category}
          {props.entry.platform === 'darwin' ? ' · 仅 macOS' : ''}
          {props.entry.setupLabel ? ` · ${props.entry.setupLabel}` : ''}
        </small>
      </div>
      {props.installed ? (
        <Button size="sm" variant="secondary" onClick={props.onManage}>管理</Button>
      ) : (
        <button
          type="button"
          className="maka-mcp-install-button"
          data-phase={props.phase ?? 'idle'}
          aria-label={cancelling ? `正在取消安装 ${props.entry.name}` : installing ? `取消安装 ${props.entry.name}` : `安装 ${props.entry.name}`}
          title={cancelling ? '正在取消…' : installing ? '取消安装' : '安装'}
          onClick={installing ? props.onCancel : props.onInstall}
          disabled={cancelling}
        >
          {props.phase ? (
            <>
              <Loader2 className="maka-mcp-install-spinner animate-spin" aria-hidden="true" />
              <X className="maka-mcp-install-cancel" aria-hidden="true" />
            </>
          ) : <Plus aria-hidden="true" />}
        </button>
      )}
    </article>
  );
}

function McpBrandMark({ entry }: { entry: McpCatalogEntry }) {
  if (entry.id === 'slack') return (
    <svg viewBox="0 0 256 256" aria-hidden="true">
      <path fill="#e01e5a" d="M53.84 161.32c0 14.83-11.99 26.82-26.82 26.82S.2 176.15.2 161.32s11.99-26.82 26.82-26.82h26.82zm13.41 0c0-14.83 11.99-26.82 26.82-26.82s26.82 11.99 26.82 26.82v67.05c0 14.83-11.99 26.82-26.82 26.82s-26.82-11.99-26.82-26.82z" />
      <path fill="#36c5f0" d="M94.07 53.64c-14.83 0-26.82-11.99-26.82-26.82S79.24 0 94.07 0s26.82 11.99 26.82 26.82v26.82zm0 13.61c14.83 0 26.82 11.99 26.82 26.82s-11.99 26.82-26.82 26.82H26.82C11.99 120.89 0 108.9 0 94.07s11.99-26.82 26.82-26.82z" />
      <path fill="#2eb67d" d="M201.55 94.07c0-14.83 11.99-26.82 26.82-26.82s26.82 11.99 26.82 26.82s-11.99 26.82-26.82 26.82h-26.82zm-13.41 0c0 14.83-11.99 26.82-26.82 26.82s-26.82-11.99-26.82-26.82V26.82C134.5 11.99 146.49 0 161.32 0s26.82 11.99 26.82 26.82z" />
      <path fill="#ecb22e" d="M161.32 201.55c14.83 0 26.82 11.99 26.82 26.82s-11.99 26.82-26.82 26.82s-26.82-11.99-26.82-26.82v-26.82zm0-13.41c-14.83 0-26.82-11.99-26.82-26.82s11.99-26.82 26.82-26.82h67.25c14.83 0 26.82 11.99 26.82 26.82s-11.99 26.82-26.82 26.82z" />
    </svg>
  );
  if (entry.id === 'line') return (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.37 9.86a.63.63 0 0 1 0 1.26h-1.76v1.13h1.76a.63.63 0 1 1 0 1.26h-2.39a.63.63 0 0 1-.63-.63V8.11a.63.63 0 0 1 .63-.63h2.39a.63.63 0 0 1 0 1.26h-1.76v1.12zm-3.86 3.02a.63.63 0 0 1-1.14.38l-2.44-3.32v2.94a.63.63 0 0 1-1.26 0V8.11a.63.63 0 0 1 1.12-.38l2.46 3.33V8.11a.63.63 0 0 1 1.26 0zm-5.74 0a.63.63 0 0 1-1.26 0V8.11a.63.63 0 0 1 1.26 0zm-2.47.63H4.92a.63.63 0 0 1-.63-.63V8.11a.63.63 0 0 1 1.26 0v4.14H7.3a.63.63 0 0 1 0 1.26M24 10.31C24 4.94 18.62.57 12 .57S0 4.94 0 10.31c0 4.81 4.27 8.84 10.04 9.61.39.08.92.26 1.06.59.12.3.08.77.04 1.08l-.17 1.02c-.04.3-.24 1.19 1.05.65 1.29-.54 6.92-4.08 9.44-6.98C23.18 14.39 24 12.46 24 10.31" /></svg>
  );
  if (entry.id === 'google-calendar') return (
    <svg viewBox="0 0 256 256" aria-hidden="true">
      <path fill="#fff" d="M195.37 60.63H60.63v134.74h134.74z" /><path fill="#ea4335" d="M195.37 256 256 195.37l-60.63-5.17z" /><path fill="#188038" d="M0 195.37v40.42A20.21 20.21 0 0 0 20.21 256h40.42l6.23-30.32-6.23-30.31z" /><path fill="#1967d2" d="M256 60.63V20.21A20.21 20.21 0 0 0 235.79 0h-40.42l-5.54 33.2 5.54 27.43z" /><path fill="#fbbc04" d="M256 60.63h-60.63v134.74H256z" /><path fill="#34a853" d="M195.37 195.37H60.63V256h134.74z" /><path fill="#4285f4" d="M195.37 0H20.21A20.21 20.21 0 0 0 0 20.21v175.16h60.63V60.63h134.74z" /><path fill="#4285f4" d="M88.27 165.15c-5.04-3.4-8.52-8.37-10.43-14.94l11.69-4.81c2.77 8.49 7.82 12.71 15.12 12.71 7.67 0 13.48-5.28 13.48-12.36 0-8.32-6.88-12.18-14.72-12.18h-6.75V122h6.06c8.09 0 13.29-4.32 13.29-11.34 0-6.21-4.58-10.31-12.14-10.31-6.77 0-11.18 3.64-12.6 9.5l-11.57-4.81c3.55-10.06 12.38-16.49 24.27-16.49 14.2 0 24.83 8.71 24.83 21 0 8.18-4.12 13.79-10.31 17.04v.69c8.27 3.46 13.07 9.97 13.07 19.12 0 14.01-11.25 24.08-26.88 24.08-5.91.02-11.37-1.68-16.41-5.08m71.8-58-12.84 9.28-6.41-9.73 23.02-16.61h8.83v78.33h-12.6z" />
    </svg>
  );
  if (entry.id === 'figma') return (
    <svg viewBox="0 0 256 384" aria-hidden="true"><path fill="#0acf83" d="M64 384a64 64 0 0 0 64-64v-64H64a64 64 0 1 0 0 128" /><path fill="#a259ff" d="M0 192a64 64 0 0 1 64-64h64v128H64a64 64 0 0 1-64-64" /><path fill="#f24e1e" d="M0 64A64 64 0 0 1 64 0h64v128H64A64 64 0 0 1 0 64" /><path fill="#ff7262" d="M128 0h64a64 64 0 1 1 0 128h-64z" /><path fill="#1abcfe" d="M256 192a64 64 0 1 1-128 0 64 64 0 0 1 128 0" /></svg>
  );
  if (entry.id === 'vercel') return <svg viewBox="0 0 256 222" aria-hidden="true"><path fill="currentColor" d="m128 0 128 221.71H0z" /></svg>;
  if (entry.id === 'supabase') return (
    <svg viewBox="0 0 256 263" aria-hidden="true"><path fill="#249361" d="M149.6 258.58c-6.72 8.46-20.34 3.82-20.5-6.98l-2.37-157.98h106.23c19.24 0 29.97 22.22 18.01 37.29z" /><path fill="#3ecf8e" d="M106.4 4.37c6.72-8.46 20.34-3.83 20.5 6.98l1.04 157.98H23.04c-19.24 0-29.97-22.22-18.01-37.29z" /></svg>
  );
  return <span>{entry.mark}</span>;
}

function McpServerRow(props: {
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
  const endpoint = endpointFor(props.server);
  const transportLabel = isMcpStdioConfig(props.server) ? 'Local stdio' : props.server.transport ?? 'auto';
  return (
    <li className="maka-mcp-server-row">
      <div className="maka-mcp-server-summary">
        <span className="maka-mcp-status-dot" data-tone={state.tone} aria-hidden="true" />
        <div className="maka-mcp-server-identity">
          <div><strong>{props.serverId}</strong><Chip size="sm" variant={state.tone}>{state.label}</Chip></div>
          <span>{transportLabel} · <code title={endpoint}>{endpoint}</code></span>
        </div>
        <Switch
          checked={props.server.enabled !== false}
          onChange={props.onToggle}
          disabled={props.busy === `toggle:${props.serverId}`}
          ariaLabel={`${props.serverId} 启用状态`}
        />
        <div className="maka-mcp-server-actions">
          <Button size="sm" variant="secondary" onClick={props.onTest} disabled={props.busy === `test:${props.serverId}`}>
            <RefreshCcw aria-hidden="true" /> {props.busy === `test:${props.serverId}` ? '测试中…' : '测试'}
          </Button>
          <Button size="icon-sm" variant="quiet" aria-label={`编辑 ${props.serverId}`} title="编辑" onClick={props.onEdit}><Pencil aria-hidden="true" /></Button>
          <Button size="icon-sm" variant="quiet" aria-label={`删除 ${props.serverId}`} title="删除" onClick={props.onRemove} disabled={props.busy === `remove:${props.serverId}`}><Trash2 aria-hidden="true" /></Button>
        </div>
      </div>
      {props.status?.error && <div className="maka-mcp-server-error" role="alert">{props.status.error}</div>}
      {(props.status?.tools.length || props.status?.stderrTail?.length) ? (
        <details className="maka-mcp-server-details">
          <summary>{props.status?.tools.length ? `${props.status.tools.length} 个工具` : '连接诊断'}</summary>
          {props.status?.tools.length ? (
            <div className="maka-mcp-tool-list">{props.status.tools.map((tool) => <code key={tool.name}>{tool.name}</code>)}</div>
          ) : null}
          {props.status?.stderrTail?.length ? <pre>{props.status.stderrTail.join('\n')}</pre> : null}
        </details>
      ) : null}
    </li>
  );
}

function McpNoResults(props: { query: string; onClear(): void }) {
  return (
    <div className="maka-mcp-empty">
      <Search aria-hidden="true" />
      <strong>没有找到匹配的 MCP</strong>
      <span>尝试更换关键词，或清空「{props.query}」。</span>
      <Button size="sm" variant="secondary" onClick={props.onClear}>清空搜索</Button>
    </div>
  );
}

function McpEditorDialog(props: {
  state: Exclude<EditorState, null>;
  saving: boolean;
  onChange(next: Exclude<EditorState, null>): void;
  onClose(): void;
  onSave(event: React.FormEvent): void;
  onImport(event: React.FormEvent): void;
}) {
  const titleId = 'maka-mcp-editor-title';
  const editing = props.state.mode === 'manual' && Boolean(props.state.editingId);
  const updateDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    if (props.state.mode !== 'manual') return;
    props.onChange({ ...props.state, draft: { ...props.state.draft, [key]: value } });
  };
  return (
    <DialogRoot open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="maka-modal maka-mcp-editor-dialog" aria-labelledby={titleId} showClose={false}>
        <DialogHeader
          icon={props.state.mode === 'json' ? <FileCode /> : <Plug />}
          title={props.state.mode === 'json' ? '通过 JSON 导入' : editing ? `编辑 ${props.state.draft.id}` : '添加 MCP'}
          titleId={titleId}
          subtitle={props.state.mode === 'json' ? '粘贴 mcpServers 配置，同名 server 会被更新。' : '配置保存在当前工作区的 mcp.json。'}
          onClose={props.onClose}
        />
        {!editing && (
          <div className="maka-mcp-editor-mode" role="group" aria-label="MCP 添加方式">
            <button type="button" aria-pressed={props.state.mode === 'manual'} data-active={props.state.mode === 'manual'} onClick={() => props.onChange({ mode: 'manual', draft: emptyDraft(), editingId: null })}>
              <Terminal aria-hidden="true" /> 手动配置
            </button>
            <button type="button" aria-pressed={props.state.mode === 'json'} data-active={props.state.mode === 'json'} onClick={() => props.onChange({ mode: 'json', source: exampleJson() })}>
              <FileCode aria-hidden="true" /> 粘贴 JSON
            </button>
          </div>
        )}
        {props.state.mode === 'json' ? (
          <form className="maka-mcp-json-form" onSubmit={props.onImport}>
            <label><span>JSON 配置</span><Textarea aria-label="JSON 配置" value={props.state.source} onChange={(event) => props.onChange({ mode: 'json', source: event.currentTarget.value })} spellCheck={false} /></label>
            <p>支持完整 <code>{'{ "mcpServers": { ... } }'}</code> 或直接的 server map。未在本次导入中出现的已有 MCP 会保留。</p>
            <div className="maka-mcp-editor-footer"><Button type="button" variant="ghost" onClick={props.onClose}>取消</Button><Button type="submit" disabled={props.saving}>{props.saving ? '导入中…' : '导入并连接'}</Button></div>
          </form>
        ) : (
          <form className="maka-mcp-manual-form" onSubmit={props.onSave}>
            <div className="maka-mcp-kind-picker" role="group" aria-label="MCP transport 类型">
              <button type="button" aria-pressed={props.state.draft.kind === 'stdio'} data-active={props.state.draft.kind === 'stdio'} onClick={() => updateDraft('kind', 'stdio')}><Terminal aria-hidden="true" /> 本地 stdio</button>
              <button type="button" aria-pressed={props.state.draft.kind === 'remote'} data-active={props.state.draft.kind === 'remote'} onClick={() => updateDraft('kind', 'remote')}><Globe aria-hidden="true" /> 远程 URL</button>
            </div>
            <div className="maka-mcp-form-fields">
              <label className="settingsField"><span>Server ID</span><Input value={props.state.draft.id} onChange={(event) => updateDraft('id', event.currentTarget.value)} disabled={editing} required placeholder="filesystem" /><small>稳定标识，也会进入 tool name。</small></label>
              {props.state.draft.kind === 'stdio' ? (
                <>
                  <label className="settingsField"><span>Command</span><Input value={props.state.draft.command} onChange={(event) => updateDraft('command', event.currentTarget.value)} required placeholder="npx" /></label>
                  <label className="settingsField"><span>Arguments</span><Textarea value={props.state.draft.args} onChange={(event) => updateDraft('args', event.currentTarget.value)} placeholder={'每行一个 argument\n-y\n@modelcontextprotocol/server-filesystem\n/path/to/folder'} /><small>每行作为独立 argument，不经过 shell interpolation。</small></label>
                  <details className="maka-mcp-advanced"><summary>高级设置</summary><div>
                    <label className="settingsField"><span>Working directory</span><Input value={props.state.draft.cwd} onChange={(event) => updateDraft('cwd', event.currentTarget.value)} placeholder="可选，例如 /path/to/project" /></label>
                    <label className="settingsField"><span>Environment</span><Textarea value={props.state.draft.env} onChange={(event) => updateDraft('env', event.currentTarget.value)} placeholder={'KEY=value\nTOKEN=secret'} /><small>每行一个 KEY=value。</small></label>
                  </div></details>
                </>
              ) : (
                <>
                  <label className="settingsField"><span>MCP URL</span><Input type="url" value={props.state.draft.url} onChange={(event) => updateDraft('url', event.currentTarget.value)} required placeholder="https://example.com/mcp" /></label>
                  <details className="maka-mcp-advanced"><summary>高级设置</summary><div>
                    <label className="settingsField"><span>Transport</span><select value={props.state.draft.transport} onChange={(event) => updateDraft('transport', event.currentTarget.value as Draft['transport'])}><option value="auto">Auto fallback</option><option value="streamable-http">Streamable HTTP</option><option value="sse">Legacy SSE</option></select></label>
                    <label className="settingsField"><span>HTTP headers</span><Textarea value={props.state.draft.headers} onChange={(event) => updateDraft('headers', event.currentTarget.value)} placeholder={'Authorization=Bearer …\nX-Workspace=…'} /><small>每行一个 Header=value。</small></label>
                  </div></details>
                </>
              )}
            </div>
            <div className="maka-mcp-editor-footer"><Button type="button" variant="ghost" onClick={props.onClose}>取消</Button><Button type="submit" disabled={props.saving}>{props.saving ? '保存中…' : '保存并连接'}</Button></div>
          </form>
        )}
      </DialogContent>
    </DialogRoot>
  );
}

function emptyDraft(): Draft {
  return { id: '', kind: 'stdio', enabled: true, command: '', args: '', cwd: '', env: '', url: '', transport: 'auto', headers: '' };
}

function draftFromConfig(id: string, config: McpServerConfig): Draft {
  if (isMcpStdioConfig(config)) {
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

function endpointFor(server: McpServerConfig): string {
  return isMcpStdioConfig(server) ? [server.command, ...(server.args ?? [])].join(' ') : server.url;
}

function replaceStatus(statuses: McpServerStatus[], next: McpServerStatus): McpServerStatus[] {
  return [...statuses.filter((status) => status.serverId !== next.serverId), next];
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function presentStatus(status: McpServerStatus | undefined, enabled: boolean): { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive' } {
  if (!enabled || status?.state === 'disabled') return { label: '已停用', tone: 'neutral' };
  if (!status || status.state === 'disconnected') return { label: '未连接', tone: 'neutral' };
  if (status.state === 'connecting') return { label: '连接中', tone: 'info' };
  if (status.state === 'connected') return { label: `${status.toolCount} 个工具`, tone: 'success' };
  return { label: '连接失败', tone: 'destructive' };
}

function exampleJson(): string {
  return JSON.stringify({
    mcpServers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/folder'],
      },
    },
  }, null, 2);
}
