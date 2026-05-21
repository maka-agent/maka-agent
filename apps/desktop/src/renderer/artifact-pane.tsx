/**
 * Right-side ArtifactPane for the chat shell (design-system §9.1.3).
 *
 * Responsibilities — and the five review gates that drive them:
 *
 *  1. **Path-safety boundary**: this component never assembles absolute
 *     paths. It only calls `window.maka.artifacts.{list,readText,readBinary,
 *     delete,subscribeChanges}` and `window.maka.app.openArtifactPath`. The
 *     renderer doesn't even *see* `{workspaceRoot}/artifacts/…` — main
 *     does the realpath prefix check before exposing anything.
 *
 *  2. **HTML sandbox** (delegated to ArtifactPreview): `sandbox="allow-scripts"`
 *     ONLY. The "外部链接已禁用" status bar lives in the preview.
 *
 *  3. **Failure-state coverage** (delegated to ArtifactPreview): all five
 *     `ArtifactReadFailureReason`s have explicit Chinese copy.
 *
 *  4. **Smoke fixture compatibility**: the pane mounts when `sessionId` is
 *     defined AND at least one live artifact exists — per §9.1.3 default
 *     hidden. The `MAKA_VISUAL_SMOKE_FIXTURE=artifact-pane` scenario seeds
 *     3 artifacts, so the pane is visible during the smoke.
 *
 *  5. **Copy/export policy**: only the text-based kinds (`file`, `diff`,
 *     `html`) expose a Copy button. `image` / `pdf` rows do NOT — those are
 *     binary, and silently base64-stuffing a multi-MB PDF into the clipboard
 *     is a footgun. Both kinds still get「在 Finder 中打开」and「另存为」.
 *
 * Layout: collapsible aside. Width is fixed (~360px expanded, ~32px
 * collapsed) — adjustable in the future; the contract gate is that the
 * pane returns `null` when it shouldn't take space.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  FileCode,
  FileImage,
  FileText,
  FileType,
  GitMerge,
  Save,
  FolderOpen,
  Copy,
  Trash2,
} from 'lucide-react';
import type {
  ArtifactKind,
  ArtifactRecord,
} from '@maka/core';
import { useToast } from '@maka/ui';
import { ArtifactPreview } from './artifact-preview';
import { nextArtifactListAction } from './artifact-list-keyboard';
import { openPathFailureCopy } from './open-path';

const COLLAPSE_KEY = 'maka-artifact-pane-collapsed-v1';

export function ArtifactPane(props: { sessionId: string | undefined }) {
  const { sessionId } = props;
  const toast = useToast();
  const [records, setRecords] = useState<ArtifactRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed());

  // ---- live data ---------------------------------------------------------

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setRecords([]);
      return;
    }
    const next = await window.maka.artifacts.list(sessionId);
    setRecords(next);
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    if (!sessionId) return;
    // §9.1.2 subscribeChanges: keep the list in sync without polling. The
    // backend emits `{ reason: 'created' | 'deleted' | 'purged' }` on the
    // `artifacts:changed` channel; we just re-list since the list is bounded
    // (one session's worth) and the metadata is already in memory on main.
    const unsubscribe = window.maka.artifacts.subscribeChanges((event) => {
      if (event.sessionId === sessionId) {
        void refresh();
      }
    });
    return unsubscribe;
  }, [sessionId, refresh]);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* localStorage unavailable — collapse state resets next launch, no behaviour impact */
    }
  }, [collapsed]);

  // Keep selection valid as the list churns. When the selected artifact is
  // deleted/purged we fall back to the newest live record so the preview
  // pane doesn't show stale failure copy on an empty list.
  useEffect(() => {
    if (records.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !records.some((record) => record.id === selectedId)) {
      setSelectedId(records[0]!.id);
    }
  }, [records, selectedId]);

  const selected = useMemo(
    () => records.find((record) => record.id === selectedId) ?? null,
    [records, selectedId],
  );

  // §9.1.3: "默认隐藏；当 session 内至少 1 个 live artifact 时显示". Returning
  // `null` keeps the chat surface flush with the right window edge until
  // the runtime actually produces an artifact.
  if (!sessionId || records.length === 0) {
    return null;
  }

  // ---- actions -----------------------------------------------------------

  async function openInFinder(artifactId: string) {
    const result = await window.maka.app.openArtifactPath(artifactId);
    if (!result.ok) {
      toast.error('无法在 Finder 中打开 artifact', openPathFailureCopy(result.reason));
    }
  }

  async function copyText(artifactId: string) {
    // Only text-backed kinds reach this code path; binary kinds don't render
    // a copy button (review gate #5). We still defensively guard so a stray
    // call doesn't leak base64 into the clipboard.
    const record = records.find((entry) => entry.id === artifactId);
    if (!record || !isTextKind(record.kind)) return;
    const result = await window.maka.artifacts.readText(artifactId);
    if (!result.ok) {
      toast.error('复制失败', '无法读取 artifact 文本内容。');
      return;
    }
    try {
      await navigator.clipboard.writeText(result.text);
      toast.success('已复制 artifact 文本', `${record.name} · ${formatBytes(record.sizeBytes)}`);
    } catch {
      toast.error('复制失败', '剪贴板不可用。');
    }
  }

  async function saveAs(artifactId: string) {
    const result = await window.maka.app.saveArtifactAs(artifactId);
    if (result.ok) {
      const record = records.find((entry) => entry.id === artifactId);
      toast.success('已另存 artifact', record?.name ?? result.saved);
      return;
    }
    if (result.reason === 'canceled') return;
    toast.error('另存失败', saveArtifactFailureCopy(result.reason));
  }

  async function deleteArtifact(artifactId: string) {
    const record = records.find((entry) => entry.id === artifactId);
    const name = record?.name ?? 'artifact';
    const ok = await toast.confirm({
      title: `删除 "${name}"`,
      description: '软删除：metadata 中标记为 deleted，文件保留 6 小时可恢复。',
      confirmLabel: '删除',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    await window.maka.artifacts.delete(artifactId);
    await refresh();
    toast.success(`已删除 ${name}`);
  }

  // ---- render ------------------------------------------------------------

  // @kenji a11y gate #1: artifact list is a SINGLE tab stop. ArrowUp/Down +
  // Home/End move the selected artifact (preview follows). Enter focuses
  // the preview area so a screen-reader user can land there directly. Esc
  // returns focus to the chat composer — does NOT swallow the global
  // Command Palette / modal Esc handler (the list only listens to Esc when
  // its own children have focus).
  const listRef = useRef<HTMLUListElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  function focusComposer() {
    // Defer to the next frame so the Esc handler doesn't unfocus + refocus
    // in the same tick.
    requestAnimationFrame(() => {
      const composer = document.querySelector<HTMLTextAreaElement>(
        '.maka-composer textarea, [data-composer-textarea]',
      );
      composer?.focus();
    });
  }

  function dismissPaneToComposer() {
    setCollapsed(true);
    focusComposer();
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const action = nextArtifactListAction({
      currentSelectedId: selectedId ?? undefined,
      visibleIds: records.map((record) => record.id),
      key: event.key,
    });
    if (action.kind === 'noop') return;
    event.preventDefault();
    event.stopPropagation();
    switch (action.kind) {
      case 'select':
        setSelectedId(action.targetId);
        break;
      case 'activate':
        setSelectedId(action.targetId);
        // §9.1.3 Enter on selected row → focus preview surface so the
        // screen reader announces the artifact contents.
        requestAnimationFrame(() => previewRef.current?.focus());
        break;
      case 'dismiss':
        dismissPaneToComposer();
        break;
    }
  }

  function handlePaneKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape') return;
    const target = event.target;
    if (!(target instanceof Node) || !event.currentTarget.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    dismissPaneToComposer();
  }

  return (
    <aside
      className="maka-artifact-pane"
      data-collapsed={collapsed ? 'true' : 'false'}
      data-layout="responsive-bottom-sheet"
      aria-label="Artifact 预览面板"
      onKeyDown={handlePaneKeyDown}
    >
      <header className="maka-artifact-pane-header">
        <button
          type="button"
          className="maka-artifact-pane-collapse"
          onClick={() => setCollapsed((current) => !current)}
          // @kenji a11y gate #3: aria-expanded reflects the actual visible
          // content state (true when pane shows list + preview + toolbar,
          // false when collapsed to chevron rail). aria-pressed retained
          // since this is still a toggle button (a screen reader announces
          // both "pressed" + "expanded" meaningfully).
          aria-pressed={collapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开 artifact 面板' : '折叠 artifact 面板'}
          title={collapsed ? '展开 artifact 面板' : '折叠 artifact 面板'}
        >
          {collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        </button>
        {!collapsed && (
          <>
            <span className="maka-artifact-pane-title">Artifact</span>
            <span className="maka-artifact-pane-count">{records.length}</span>
          </>
        )}
      </header>
      {!collapsed && (
        <>
          <ul
            ref={listRef}
            className="maka-artifact-list"
            role="listbox"
            aria-label="Artifact 列表"
            aria-activedescendant={selectedId ? `maka-artifact-row-${selectedId}` : undefined}
            tabIndex={0}
            onKeyDown={handleListKeyDown}
          >
            {records.map((record) => (
              <li key={record.id} className="maka-artifact-list-item">
                <button
                  id={`maka-artifact-row-${record.id}`}
                  type="button"
                  className="maka-artifact-row"
                  role="option"
                  aria-selected={record.id === selectedId}
                  // @kenji a11y gate #1: single tab stop in the list. Each
                  // row gets tabIndex=-1 so the user reaches the list via
                  // the list's own tabIndex, then drives selection with
                  // ArrowUp/Down.
                  tabIndex={-1}
                  data-selected={record.id === selectedId ? 'true' : 'false'}
                  data-deleted={record.status === 'deleted' ? 'true' : 'false'}
                  onClick={() => setSelectedId(record.id)}
                >
                  <span className="maka-artifact-row-icon" aria-hidden="true">
                    <KindIcon kind={record.kind} />
                  </span>
                  <span className="maka-artifact-row-name">{record.name}</span>
                  <span className="maka-artifact-row-meta">
                    <span className="maka-artifact-row-size">{formatBytes(record.sizeBytes)}</span>
                    <span className="maka-artifact-row-time">{formatRelative(record.createdAt)}</span>
                  </span>
                  {record.status === 'deleted' && (
                    <span className="maka-artifact-row-badge">已删除</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div
            ref={previewRef}
            className="maka-artifact-preview"
            data-empty={selected ? 'false' : 'true'}
            // @kenji a11y gate #1: Enter from the list focuses this region
            // so screen readers can announce the artifact contents. role +
            // tabIndex=-1 make the div programmatically focusable without
            // adding a Tab stop (the list is the single Tab stop).
            role="region"
            aria-label={selected ? `预览 ${selected.name}` : 'Artifact 预览'}
            tabIndex={-1}
          >
            {selected ? (
              <ArtifactPreview key={selected.id} record={selected} />
            ) : (
              <div className="maka-artifact-preview-empty">选择左侧 artifact 查看预览。</div>
            )}
          </div>
          {selected && (
            <div className="maka-artifact-toolbar" role="toolbar" aria-label="Artifact 操作">
              <button
                type="button"
                className="maka-artifact-toolbar-button"
                onClick={() => void openInFinder(selected.id)}
              >
                <FolderOpen size={14} aria-hidden="true" />
                <span>在 Finder 中打开</span>
              </button>
              <button
                type="button"
                className="maka-artifact-toolbar-button"
                onClick={() => void saveAs(selected.id)}
              >
                <Save size={14} aria-hidden="true" />
                <span>另存为</span>
              </button>
              {isTextKind(selected.kind) && (
                <button
                  type="button"
                  className="maka-artifact-toolbar-button"
                  onClick={() => void copyText(selected.id)}
                >
                  <Copy size={14} aria-hidden="true" />
                  <span>复制文本</span>
                </button>
              )}
              <button
                type="button"
                className="maka-artifact-toolbar-button maka-artifact-toolbar-destructive"
                onClick={() => void deleteArtifact(selected.id)}
              >
                <Trash2 size={14} aria-hidden="true" />
                <span>删除</span>
              </button>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

// ---- helpers ---------------------------------------------------------------

function isTextKind(kind: ArtifactKind): boolean {
  return kind === 'file' || kind === 'diff' || kind === 'html';
}

function saveArtifactFailureCopy(reason: string): string {
  switch (reason) {
    case 'not_found':
      return 'artifact 文件不存在。';
    case 'not_allowed':
      return 'artifact 路径检查未通过。';
    case 'deleted':
      return 'artifact 已删除，不能另存。';
    case 'write_failed':
      return '目标位置无法写入。';
    default:
      return '无法保存 artifact。';
  }
}

function KindIcon(props: { kind: ArtifactKind }) {
  switch (props.kind) {
    case 'file':
      return <FileText size={14} />;
    case 'diff':
      return <GitMerge size={14} />;
    case 'html':
      return <FileCode size={14} />;
    case 'image':
      return <FileImage size={14} />;
    case 'pdf':
      return <FileType size={14} />;
  }
}

function readCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return raw === '1';
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const relativeTimeFormat: Intl.RelativeTimeFormat =
  typeof Intl !== 'undefined'
    ? new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
    : ({ format: (n: number, u: string) => `${n} ${u}` } as unknown as Intl.RelativeTimeFormat);

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffMinutes = Math.max(1, Math.round(diffMs / 60_000));
  if (diffMinutes < 60) return relativeTimeFormat.format(-diffMinutes, 'minute');
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return relativeTimeFormat.format(-diffHours, 'hour');
  return relativeTimeFormat.format(-Math.round(diffHours / 24), 'day');
}
