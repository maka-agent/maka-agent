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
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FileCode,
  FileImage,
  FileText,
  FileType,
  GitMerge,
  RefreshCcw,
  Save,
  FolderOpen,
  Copy,
  Trash2,
} from '@maka/ui/icons';
import type {
  ArtifactKind,
  ArtifactRecord,
} from '@maka/core';
import {
  formatRelativeTimestamp,
  generalizedErrorMessageChinese,
  redactSecrets,
} from '@maka/core';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  formatBytes,
  useToast,
} from '@maka/ui';
import { ArtifactPreview } from './artifact-preview';
import { nextArtifactListAction } from './artifact-list-keyboard';
import { safeLocalStorageGet, safeLocalStorageSet } from './browser-storage';
import { openPathFailureCopy } from './open-path';

const COLLAPSE_KEY = 'maka-artifact-pane-collapsed-v1';

export function ArtifactPane(props: { sessionId: string | undefined }) {
  const { sessionId } = props;
  const toast = useToast();
  const [records, setRecords] = useState<ArtifactRecord[]>([]);
  const [recordsSessionId, setRecordsSessionId] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed());
  const [listError, setListError] = useState<{ sessionId: string; message: string } | null>(null);
  const [pendingArtifactListRetry, setPendingArtifactListRetry] = useState(false);
  const [pendingArtifactAction, setPendingArtifactAction] = useState<string | null>(null);
  const artifactListRequestSeqRef = useRef(0);
  const artifactPaneMountedRef = useRef(true);
  const artifactPaneSessionIdRef = useRef<string | undefined>(sessionId);
  const recordsSessionIdRef = useRef<string | undefined>(undefined);
  const pendingArtifactListRetryRef = useRef(false);
  const pendingArtifactActionRef = useRef<string | null>(null);

  artifactPaneSessionIdRef.current = sessionId;

  // ---- live data ---------------------------------------------------------

  useEffect(() => {
    artifactPaneMountedRef.current = true;
    return () => {
      artifactPaneMountedRef.current = false;
      artifactListRequestSeqRef.current += 1;
      pendingArtifactListRetryRef.current = false;
      pendingArtifactActionRef.current = null;
    };
  }, []);

  const refresh = useCallback(async () => {
    const requestSeq = ++artifactListRequestSeqRef.current;
    if (!sessionId) {
      recordsSessionIdRef.current = undefined;
      setRecordsSessionId(undefined);
      setRecords([]);
      setListError(null);
      return;
    }
    try {
      const next = await window.maka.artifacts.list(sessionId, { includeDeleted: true });
      if (artifactPaneMountedRef.current && requestSeq === artifactListRequestSeqRef.current) {
        recordsSessionIdRef.current = sessionId;
        setRecordsSessionId(sessionId);
        setRecords(next);
        setListError(null);
      }
    } catch (error) {
      if (artifactPaneMountedRef.current && requestSeq === artifactListRequestSeqRef.current) {
        const message = artifactActionErrorMessage(error);
        setListError({ sessionId, message });
        if (recordsSessionIdRef.current !== sessionId) {
          recordsSessionIdRef.current = undefined;
          setRecordsSessionId(undefined);
          setRecords([]);
        } else {
          toast.error('刷新生成文件失败', message);
        }
      }
    }
  }, [sessionId, toast]);

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
    return () => {
      artifactListRequestSeqRef.current += 1;
      unsubscribe();
    };
  }, [sessionId, refresh]);

  useEffect(() => {
    safeLocalStorageSet(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const activeRecords = useMemo(
    () => (recordsSessionId === sessionId ? records.filter((record) => record.source !== 'user_upload') : []),
    [records, recordsSessionId, sessionId],
  );

  // 已删除墓碑记录保持可选，用于展示明确失败态；只有选中 id 彻底消失时才回退到最新 live artifact。
  useEffect(() => {
    if (activeRecords.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !activeRecords.some((record) => record.id === selectedId)) {
      setSelectedId(preferredArtifactSelectionId(activeRecords));
    }
  }, [activeRecords, selectedId]);

  const selected = useMemo(
    () => activeRecords.find((record) => record.id === selectedId) ?? null,
    [activeRecords, selectedId],
  );
  const listRef = useRef<HTMLUListElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const activeListError = listError && listError.sessionId === sessionId ? listError.message : null;
  const hasLiveArtifact = activeRecords.some((record) => record.status !== 'deleted');
  const artifactActionBusy = pendingArtifactAction !== null;

  // §9.1.3: "默认隐藏；当 session 内至少 1 个 live artifact 时显示". Returning
  // `null` keeps the chat surface flush with the right window edge until
  // the runtime actually produces an artifact. A current-session list error is
  // also visible; otherwise "list failed" is indistinguishable from "no files".
  if (!sessionId || (!hasLiveArtifact && !activeListError)) {
    return null;
  }

  // ---- actions -----------------------------------------------------------

  async function runArtifactAction(actionKey: string, action: () => Promise<void>) {
    if (pendingArtifactActionRef.current !== null) return;
    pendingArtifactActionRef.current = actionKey;
    setPendingArtifactAction(actionKey);
    try {
      await action();
    } finally {
      if (pendingArtifactActionRef.current === actionKey) {
        pendingArtifactActionRef.current = null;
        if (artifactPaneMountedRef.current) setPendingArtifactAction(null);
      }
    }
  }

  function isArtifactActionSurfaceActive(actionSessionId: string | undefined): boolean {
    return Boolean(
      actionSessionId &&
        artifactPaneMountedRef.current &&
        artifactPaneSessionIdRef.current === actionSessionId &&
        recordsSessionIdRef.current === actionSessionId,
    );
  }

  async function retryArtifactListRefresh() {
    if (pendingArtifactListRetryRef.current) return;
    pendingArtifactListRetryRef.current = true;
    setPendingArtifactListRetry(true);
    try {
      await refresh();
    } finally {
      pendingArtifactListRetryRef.current = false;
      if (artifactPaneMountedRef.current) setPendingArtifactListRetry(false);
    }
  }

  async function openInFinder(artifactId: string) {
    const actionSessionId = sessionId;
    try {
      const result = await window.maka.app.openArtifactPath(artifactId);
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      if (!result.ok) {
        toast.error('无法在 Finder 中打开生成文件', openPathFailureCopy(result.reason));
      }
    } catch (error) {
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      toast.error('无法在 Finder 中打开生成文件', artifactActionErrorMessage(error));
    }
  }

  async function copyText(artifactId: string) {
    // Only text-backed kinds reach this code path; binary kinds don't render
    // a copy button (review gate #5). We still defensively guard so a stray
    // call doesn't leak base64 into the clipboard.
    const record = activeRecords.find((entry) => entry.id === artifactId);
    if (!record || !isTextKind(record.kind)) return;
    const actionSessionId = sessionId;
    try {
      const result = await window.maka.artifacts.readText(artifactId);
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      if (!result.ok) {
        toast.error('复制失败', '无法读取生成文件文本内容。');
        return;
      }
      await navigator.clipboard.writeText(result.text);
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      toast.success('已复制生成文件文本', `${record.name} · ${formatBytes(record.sizeBytes)}`);
    } catch (error) {
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      toast.error('复制失败', artifactActionErrorMessage(error));
    }
  }

  async function saveAs(artifactId: string) {
    const actionSessionId = sessionId;
    try {
      const result = await window.maka.app.saveArtifactAs(artifactId);
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      if (result.ok) {
        const record = activeRecords.find((entry) => entry.id === artifactId);
        toast.success('已另存生成文件', record?.name ?? result.saved);
        return;
      }
      if (result.reason === 'canceled') return;
      toast.error('另存失败', saveArtifactFailureCopy(result.reason));
    } catch (error) {
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      toast.error('另存失败', artifactActionErrorMessage(error));
    }
  }

  async function deleteArtifact(artifactId: string) {
    const actionSessionId = sessionId;
    const record = activeRecords.find((entry) => entry.id === artifactId);
    const name = record?.name ?? '生成文件';
    const ok = await toast.confirm({
      title: `删除 "${name}"`,
      description: '软删除：在记录中标记为已删除，文件保留 6 小时可恢复。',
      confirmLabel: '删除',
      cancelLabel: '取消',
      destructive: true,
    });
    if (!ok) return;
    if (!isArtifactActionSurfaceActive(actionSessionId)) return;
    try {
      await window.maka.artifacts.delete(artifactId);
      await refresh();
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      toast.success(`已删除 ${name}`);
    } catch (error) {
      if (!isArtifactActionSurfaceActive(actionSessionId)) return;
      toast.error(`删除 ${name} 失败`, artifactActionErrorMessage(error));
    }
  }

  // ---- render ------------------------------------------------------------

  // @kenji a11y gate #1: artifact list is a SINGLE tab stop. ArrowUp/Down +
  // Home/End move the selected artifact (preview follows). Enter focuses
  // the preview area so a screen-reader user can land there directly. Esc
  // returns focus to the chat composer — does NOT swallow the global
  // Command Palette / modal Esc handler (the list only listens to Esc when
  // its own children have focus).
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
      visibleIds: activeRecords.map((record) => record.id),
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
      aria-label="生成文件预览面板"
      onKeyDown={handlePaneKeyDown}
    >
      <header className="maka-artifact-pane-header">
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="quiet" size="icon-sm" />}
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
            aria-label={collapsed ? '展开生成文件面板' : '折叠生成文件面板'}
          >
            {collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
          </TooltipTrigger>
          <TooltipContent>{collapsed ? '展开生成文件面板' : '折叠生成文件面板'}</TooltipContent>
        </Tooltip>
        {!collapsed && (
          <>
            <span className="maka-artifact-pane-title">生成文件</span>
            <span className="maka-artifact-pane-count">{activeRecords.length}</span>
          </>
        )}
      </header>
      {!collapsed && (
        <>
          {activeListError && (
            <Alert variant="error" className="maka-artifact-list-error">
              <AlertTriangle size={14} aria-hidden="true" />
              <AlertTitle>生成文件列表载入失败</AlertTitle>
              <AlertDescription>{activeListError}</AlertDescription>
              <AlertAction>
                <Button
                  className="maka-artifact-error-retry"
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => void retryArtifactListRefresh()}
                  disabled={pendingArtifactListRetry}
                  aria-busy={pendingArtifactListRetry ? 'true' : undefined}
                  data-pending={pendingArtifactListRetry ? 'true' : undefined}
                >
                  <RefreshCcw size={13} aria-hidden="true" />
                  <span>{pendingArtifactListRetry ? '重试中…' : '重试'}</span>
                </Button>
              </AlertAction>
            </Alert>
          )}
          <ul
            ref={listRef}
            className="maka-artifact-list"
            role="listbox"
            aria-label="生成文件列表"
            aria-activedescendant={selectedId ? `maka-artifact-row-${selectedId}` : undefined}
            tabIndex={0}
            onKeyDown={handleListKeyDown}
          >
            {activeRecords.map((record) => (
              <li key={record.id} className="maka-artifact-list-item">
                <Button
                  id={`maka-artifact-row-${record.id}`}
                  type="button"
                  variant="ghost"
                  // size="nav": className owns layout. The default md size
                  // pins h-9 on the button, but deleted rows add a badge on
                  // an implicit second grid row — fixed height + centering
                  // painted the badge over the icon/name.
                  size="nav"
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
                    <span className="maka-artifact-row-time">{formatRelativeTimestamp(record.createdAt)}</span>
                  </span>
                  {record.status === 'deleted' && (
                    <Badge variant="destructive" className="maka-artifact-row-badge">已删除</Badge>
                  )}
                </Button>
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
            aria-label={selected ? `预览 ${selected.name}` : '生成文件预览'}
            tabIndex={-1}
          >
            {selected ? (
              // PR-UI-RENDER-3a: pass the existing openInFinder
              // handler so the Unsupported card (when shown) can
              // render a real "在 Finder 中打开" button. No new IPC.
              <ArtifactPreview
                key={selected.id}
                record={selected}
                onShowInFolder={() => void runArtifactAction(`${selected.id}:open`, () => openInFinder(selected.id))}
              />
            ) : (
              <Empty className="maka-artifact-preview-empty py-10 md:py-12 gap-4">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileText aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>暂未选中文件</EmptyTitle>
                  <EmptyDescription>选择左侧生成文件查看预览。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
          {selected && (
            <Toolbar className="maka-artifact-toolbar" aria-label="生成文件操作">
              <ToolbarGroup className="maka-artifact-toolbar-group">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="maka-artifact-toolbar-button"
                  onClick={() => void runArtifactAction(`${selected.id}:open`, () => openInFinder(selected.id))}
                  disabled={artifactActionBusy}
                  data-pending={pendingArtifactAction === `${selected.id}:open` ? 'true' : undefined}
                  aria-busy={pendingArtifactAction === `${selected.id}:open` ? 'true' : undefined}
                >
                  <FolderOpen size={14} aria-hidden="true" />
                  <span>{pendingArtifactAction === `${selected.id}:open` ? '打开中…' : '在 Finder 中打开'}</span>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="maka-artifact-toolbar-button"
                  onClick={() => void runArtifactAction(`${selected.id}:save`, () => saveAs(selected.id))}
                  disabled={artifactActionBusy}
                  data-pending={pendingArtifactAction === `${selected.id}:save` ? 'true' : undefined}
                  aria-busy={pendingArtifactAction === `${selected.id}:save` ? 'true' : undefined}
                >
                  <Save size={14} aria-hidden="true" />
                  <span>{pendingArtifactAction === `${selected.id}:save` ? '另存中…' : '另存为'}</span>
                </Button>
                {isTextKind(selected.kind) && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="maka-artifact-toolbar-button"
                    onClick={() => void runArtifactAction(`${selected.id}:copy`, () => copyText(selected.id))}
                    disabled={artifactActionBusy}
                    data-pending={pendingArtifactAction === `${selected.id}:copy` ? 'true' : undefined}
                    aria-busy={pendingArtifactAction === `${selected.id}:copy` ? 'true' : undefined}
                  >
                    <Copy size={14} aria-hidden="true" />
                    <span>{pendingArtifactAction === `${selected.id}:copy` ? '复制中…' : '复制'}</span>
                  </Button>
                )}
              </ToolbarGroup>
              <ToolbarSeparator className="maka-artifact-toolbar-separator" orientation="vertical" />
              <ToolbarGroup className="maka-artifact-toolbar-group maka-artifact-toolbar-danger-group">
                <Tooltip>
                  <TooltipTrigger
                    render={<Button type="button" variant="destructive" size="sm" className="maka-artifact-toolbar-button maka-artifact-toolbar-destructive" />}
                    onClick={() => void runArtifactAction(`${selected.id}:delete`, () => deleteArtifact(selected.id))}
                    disabled={artifactActionBusy}
                    data-pending={pendingArtifactAction === `${selected.id}:delete` ? 'true' : undefined}
                    aria-busy={pendingArtifactAction === `${selected.id}:delete` ? 'true' : undefined}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    {/* Icon-only at rest: the visible label wrapped the toolbar
                        onto a second line at 1280 pane width, stranding 删除
                        alone bottom-right. The label span stays for screen
                        readers (visually hidden); the Tooltip mirrors it for
                        mouse hover, replacing the native hover tooltip this
                        button lost in the tooltip migration. */}
                    <span className="maka-artifact-toolbar-destructive-label">{pendingArtifactAction === `${selected.id}:delete` ? '删除中…' : '删除'}</span>
                  </TooltipTrigger>
                  <TooltipContent>{pendingArtifactAction === `${selected.id}:delete` ? '删除中…' : '删除'}</TooltipContent>
                </Tooltip>
              </ToolbarGroup>
            </Toolbar>
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
      return '生成文件不存在。';
    case 'not_allowed':
      return '生成文件路径检查未通过。';
    case 'deleted':
      return '生成文件已删除，不能另存。';
    case 'write_failed':
      return '目标位置无法写入。';
    default:
      return '无法保存生成文件。';
  }
}

function artifactActionErrorMessage(error: unknown): string {
  const raw = redactSecrets(error instanceof Error ? error.message : String(error ?? '')).trim();
  if (!raw) return '生成文件操作失败，请稍后重试。';
  const classified = generalizedErrorMessageChinese(new Error(raw), '');
  if (classified) return classified;
  return /[\u4e00-\u9fff]/.test(raw) ? raw : '生成文件操作失败，请稍后重试。';
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
  return safeLocalStorageGet(COLLAPSE_KEY) === '1';
}

/* PR-FORMAT-BYTES-DEDUP-0 (round 21/30): the local `formatBytes`
   was a less-robust variant of the one in `@maka/ui`
   components.tsx. Removed; we now import the shared helper. */

/* PR-FORMAT-RELATIVE-DEDUP-0 (round 22/30): the local
   `formatRelative` was a less-feature variant of @maka/core's
   `formatRelativeTimestamp` — it missed clock-skew handling,
   the 7-day-then-absolute horizon, and the locale-switching
   formatter cache. Removed; we import the shared helper. */

function preferredArtifactSelectionId(records: readonly ArtifactRecord[]): string | null {
  return (records.find((record) => record.status !== 'deleted') ?? records[0])?.id ?? null;
}
