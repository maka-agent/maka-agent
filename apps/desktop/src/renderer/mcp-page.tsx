import { useEffect, useMemo, useRef, useState } from 'react';
import type { McpConfigFile, McpServerConfig, McpServerStatus } from '@maka/core/mcp';
import { isMcpStdioConfig } from '@maka/core/mcp';
import {
  Button,
  Chip,
  DialogContent,
  DialogHeader,
  DialogRoot,
  EmptyState,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  PageHeader,
  SettingsSwitch as Switch,
  TabsList,
  TabsPanel,
  TabsRoot,
  TabsTrigger,
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
import { McpBrandMark, hasMcpBrandMark } from './mcp-brand-marks';
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
      <PageHeader
        className="maka-module-main-header"
        as="h2"
        title="MCP"
        subtitle="连接外部应用、数据与服务，为 Maka 安全地扩展新工具。"
        actions={
          <div className="maka-module-main-actions" role="group" aria-label="MCP 操作">
            <Button variant="secondary" onClick={() => void reload()} disabled={busy === 'load'}>
              <RefreshCcw aria-hidden="true" /> {busy === 'load' ? '刷新中…' : '刷新'}
            </Button>
            <Button variant="secondary" onClick={() => setEditor({ mode: 'json', source: exampleJson() })}>
              <FileCode aria-hidden="true" /> JSON 导入
            </Button>
            <Button variant="default" onClick={() => openManual()}><Plus aria-hidden="true" /> 添加 MCP</Button>
          </div>
        }
      />

      <section className="maka-mcp-workspace" aria-label="MCP 市场与已安装项">
        <div className="maka-mcp-hero">
          <div>
            <strong>把 Maka 连接到你的工作环境</strong>
            <span>从精选模板开始，或添加任意 stdio、Streamable HTTP 与 SSE server。</span>
          </div>
          <div className="maka-mcp-hero-signal" aria-hidden="true">
            <span><Terminal /><small>本地 stdio</small></span>
            <span><Plug /><small>连接管理</small></span>
            <span><Globe /><small>远程 HTTP</small></span>
          </div>
        </div>

        <TabsRoot value={activeTab} onValueChange={(value) => setActiveTab(value as 'market' | 'installed')}>
          <div className="maka-mcp-tabs-bar">
            <TabsList variant="underline" className="maka-mcp-tabs" aria-label="MCP 分类">
              <TabsTrigger className="maka-mcp-tab" value="market">市场 <span>{MCP_CATALOG.length}</span></TabsTrigger>
              <TabsTrigger className="maka-mcp-tab" value="installed">已安装 <span>{entries.length}</span></TabsTrigger>
            </TabsList>
            <InputGroup className="maka-mcp-search">
              <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
              <InputGroupInput type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索 MCP…" aria-label="搜索 MCP" />
            </InputGroup>
          </div>

          <TabsPanel className="maka-mcp-tab-panel" value="market">
            {marketEntries.length > 0 ? (
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
            ) : (
              <EmptyState
                Icon={Search}
                title="没有找到匹配的 MCP"
                body={`换一个关键词，或清空「${query}」查看全部模板。`}
                cta={{ label: '清空搜索', onClick: () => setQuery('') }}
                extraClassName="maka-mcp-empty"
              />
            )}
          </TabsPanel>

          <TabsPanel className="maka-mcp-tab-panel" value="installed">
            {busy === 'load' ? (
              <div className="maka-mcp-loading" role="status">正在读取 MCP 配置…</div>
            ) : entries.length === 0 ? (
              <EmptyState
                Icon={Plug}
                title="还没有安装 MCP"
                body="从市场选择模板，或手动添加你自己的 server。"
                cta={{ label: '浏览市场', onClick: () => setActiveTab('market') }}
                extraClassName="maka-mcp-empty"
              />
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
            ) : (
              <EmptyState
                Icon={Search}
                title="没有匹配的已安装 MCP"
                body={`换一个关键词，或清空「${query}」查看全部已安装项。`}
                cta={{ label: '清空搜索', onClick: () => setQuery('') }}
                extraClassName="maka-mcp-empty"
              />
            )}
          </TabsPanel>
        </TabsRoot>
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
      <div
        className="maka-mcp-market-icon"
        data-brand={props.entry.id}
        data-logo={hasMcpBrandMark(props.entry.id) ? 'true' : undefined}
        aria-hidden="true"
      >
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
        <span className="maka-mcp-status-dot" data-tone={state.exception ? state.tone : 'neutral'} aria-hidden="true" />
        <div className="maka-mcp-server-identity">
          <div>
            <strong>{props.serverId}</strong>
            {/* Status-color restraint (#651): a healthy / expected server stays
                neutral — its label rides plain muted text. Only an error /
                unavailable server raises a toned Chip. */}
            {state.exception
              ? <Chip size="sm" variant={state.tone}>{state.label}</Chip>
              : <span className="maka-mcp-server-state">{state.label}</span>}
          </div>
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

// `exception` marks the states that earn a toned Chip + colored status dot
// (status-color restraint #651). 已停用 / 未连接 / 连接中 / 已连接 are all
// expected states and stay neutral; only 连接失败 raises the destructive tone.
function presentStatus(status: McpServerStatus | undefined, enabled: boolean): { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive'; exception: boolean } {
  if (!enabled || status?.state === 'disabled') return { label: '已停用', tone: 'neutral', exception: false };
  if (!status || status.state === 'disconnected') return { label: '未连接', tone: 'neutral', exception: false };
  if (status.state === 'connecting') return { label: '连接中', tone: 'info', exception: false };
  if (status.state === 'connected') return { label: `${status.toolCount} 个工具`, tone: 'success', exception: false };
  return { label: '连接失败', tone: 'destructive', exception: true };
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
