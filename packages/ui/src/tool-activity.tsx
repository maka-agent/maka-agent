import { useEffect, useRef, useState, type ComponentType } from 'react';
import { type ToolResultContent } from '@maka/core';
import {
  AlertOctagon,
  Check,
  ChevronRight,
  Clock,
  Copy,
  FileText,
  Globe,
  Repeat,
  Search,
  Settings,
  SquarePen,
  Terminal,
  X,
  type LucideProps,
} from './icons.js';
import { useClipboardCopyFeedback } from './clipboard-feedback.js';
import { detectUiLocale } from './locale-helpers.js';
import { type ToolActivityItem, type ToolOutputChunk } from './materialize.js';
import {
  activeTrowTool,
  isTrowRunning,
  summarizeTrowTools,
  trowActivityKind,
  trowNeedsAttention,
  type TrowActivityKind,
} from './tool-activity/trow-summary.js';
import { Alert, AlertAction, AlertDescription, AlertTitle } from './primitives/alert.js';
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from './primitives/collapsible.js';
import { LiveIndicator, previewVariants, streamVariants, TextShimmer, toolVariants } from './primitives/chat.js';
import { redactSecrets } from './redact.js';
import { Button as UiButton, cn } from './ui.js';
import { describeLoadToolResult, formatRedactedJson, formatToolIntent, loadToolDisplayName } from './tool-format.js';
import { formatDuration, formatUserVisibleToolText } from './tool-activity/preview-utils.js';
import { ToolResultPreview } from './tool-activity/tool-result-preview.js';

// Mirror of runtime's LOAD_TOOLS_NAME. @maka/ui must not depend on @maka/runtime,
// so the always-on group-activation connector's name is duplicated here as the
// single hook for its friendly, locale-aware presentation. The pre-unification
// name `load_tool` (PR #30) is also matched — it shipped and returns the same
// `{ loaded: [...] }` shape, so replayed old sessions still render friendly.
// `connect_tool_source` (PR #34) is intentionally NOT here: it never shipped and
// its `{ tools: [...] }` result shape this card does not render.
const CONNECTOR_TOOL_NAMES: ReadonlySet<string> = new Set(['load_tools', 'load_tool']);

function isConnectorTool(name: string): boolean {
  return CONNECTOR_TOOL_NAMES.has(name);
}

/** Friendly tool name: an explicit displayName wins; the connector gets a localized name. */
function resolveToolDisplayName(item: ToolActivityItem): string {
  if (item.displayName) return item.displayName;
  if (isConnectorTool(item.toolName)) return loadToolDisplayName(detectUiLocale());
  return item.toolName;
}

/** Friendly card for a `load_tools` result; falls back to JSON on unexpected shapes. */
function LoadToolResultPreview(props: { args: unknown; value: unknown }) {
  const desc = describeLoadToolResult(props.args, props.value, detectUiLocale());
  if (!desc) {
    return <ToolResultPreview content={{ kind: 'json', value: props.value }} />;
  }
  return (
    <div className={previewVariants({ part: 'load-tool' })} data-kind="load_tool">
      <p className={previewVariants({ part: 'load-tool-title' })}>{desc.title}</p>
      <p className={previewVariants({ part: 'load-tool-count' })}>{desc.countLabel}</p>
      <p className={previewVariants({ part: 'load-tool-tools' })}>{desc.toolsText}</p>
      <p className={previewVariants({ part: 'load-tool-footer' })}>{desc.footer}</p>
    </div>
  );
}

// ── Automation result preview ───────────────────────────────────────────────

// Mirror of runtime's AUTOMATION_TOOL_NAME. @maka/ui must not depend on
// @maka/runtime, so the unified Automation tool's name is duplicated here as
// the single hook for its friendly card (same pattern as CONNECTOR_TOOL_NAMES).
const AUTOMATION_TOOL_NAME = 'Automation';

function isAutomationTool(name: string): boolean {
  return name === AUTOMATION_TOOL_NAME;
}

/** Icon for one automation description: recurring schedules cycle, one-shots tick. */
function automationScheduleIcon(text: string): ComponentType<LucideProps> {
  return /Schedule: (every |cron )/.test(text) ? Repeat : Clock;
}

/**
 * Compact preview card for the unified Automation tool's text results
 * (created / deleted / listed). The tool returns human-readable text, so this
 * parses its stable first-line shapes; anything unrecognized (pause/resume,
 * errors) falls back to the generic text preview.
 */
function AutomationResultPreview(props: { text: string }) {
  const text = props.text;

  // mode:create success — "Automation created: "NAME" (kind[, durable])\nID: …\nSchedule: …\nNext fire: …"
  const created = text.match(/^Automation created: "(.+?)" \((.+?)\)\n/);
  if (created) {
    const schedule = text.match(/^Schedule: (.+)$/m)?.[1];
    const nextFire = text.match(/^Next fire: (.+)$/m)?.[1];
    const Icon = automationScheduleIcon(text);
    return (
      <div className={previewVariants({ part: 'load-tool' })} data-kind="automation_create">
        <p className={previewVariants({ part: 'load-tool-title' })}>
          <Icon size={14} aria-hidden="true" style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 4 }} />
          自动化任务已创建：{created[1]}
        </p>
        {schedule && <p className={previewVariants({ part: 'load-tool-count' })}>{schedule}</p>}
        {nextFire && nextFire !== 'N/A' && <p className={previewVariants({ part: 'load-tool-tools' })}>下次触发：{nextFire}</p>}
        <p className={previewVariants({ part: 'load-tool-footer' })}>{created[2]}</p>
      </div>
    );
  }

  // mode:delete — "Automation "id" deleted." / not-found message
  const deleted = text.match(/^Automation "(.+?)" (deleted\.|not found or not owned by this session\.)$/);
  if (deleted) {
    const ok = deleted[2] === 'deleted.';
    return (
      <div className={previewVariants({ part: 'load-tool' })} data-kind="automation_delete">
        <p className={previewVariants({ part: 'load-tool-title' })}>
          <Check size={14} aria-hidden="true" style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 4 }} />
          {ok ? '自动化任务已删除' : '未找到该任务（可能已完成或已删除）'}
        </p>
      </div>
    );
  }

  // mode:list — automation blocks separated by "---", or the empty-list message.
  const isList = text === 'No automations for this session.' || /^\[[A-Z]+\] .+ \((heartbeat|cron)/.test(text);
  if (isList) {
    const blocks = text === 'No automations for this session.' ? [] : text.split('\n---\n');
    return (
      <div className={previewVariants({ part: 'load-tool' })} data-kind="automation_list">
        <p className={previewVariants({ part: 'load-tool-title' })}>
          <Clock size={14} aria-hidden="true" style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 4 }} />
          自动化任务列表 ({blocks.length})
        </p>
        {blocks.length === 0 && <p className={previewVariants({ part: 'load-tool-count' })}>当前会话暂无自动化任务</p>}
        {blocks.slice(0, 5).map((block, i) => {
          const head = block.split('\n')[0] ?? '';
          const BlockIcon = automationScheduleIcon(block);
          return (
            <p key={i} className={previewVariants({ part: 'load-tool-tools' })}>
              <BlockIcon size={12} aria-hidden="true" style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 3 }} />
              {head}
            </p>
          );
        })}
      </div>
    );
  }

  // Fallback for pause/resume confirmations, errors, or unexpected shapes.
  return <ToolResultPreview content={{ kind: 'text', text }} />;
}

const STATUS_LABEL: Record<ToolActivityItem['status'], string> = {
  pending: '排队中',
  waiting_permission: '等待权限',
  running: '运行中',
  completed: '已完成',
  errored: '失败',
  interrupted: '已中断',
};

function isOpenByDefault(status: ToolActivityItem['status']): boolean {
  // Show details inline while the call is in flight or blocking the user; also
  // for errored calls so the failure is visible without an extra click. Settled
  // success / interruption collapse so completed history doesn't drown the chat.
  return (
    status === 'pending' ||
    status === 'waiting_permission' ||
    status === 'running' ||
    status === 'errored'
  );
}

function extractErrorText(result: ToolActivityItem['result']): string {
  if (!result) return '';
  switch (result.kind) {
    case 'text':
      return result.text;
    case 'json':
      try {
        return JSON.stringify(result.value, null, 2);
      } catch {
        return String(result.value);
      }
    case 'terminal':
      return result.stderr || result.stdout || `exit ${result.exitCode}`;
    case 'file_diff':
      return result.diff;
    case 'rive_workflow':
      return result.error
        ? [result.summary, result.error.reason, result.error.message].filter(Boolean).join('\n')
        : result.summary;
    default:
      return result.kind;
  }
}

function isPermissionDeniedToolResult(result: ToolActivityItem['result']): boolean {
  return result?.kind === 'text' && formatUserVisibleToolText(result.text).trim() === '用户已拒绝权限请求';
}

/**
 * Pull the shell command string out of a command-tool's args (bash / shell).
 * Used to render a single `$ <command>` invocation line while the tool is in
 * flight — the settled terminal result preview already prints the command in
 * its header, so this only fills the running gap. Returns undefined for a
 * non-command shape so the caller falls back to the compact redacted-args view.
 */
function extractToolCommand(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const record = args as Record<string, unknown>;
  const raw = record.command ?? record.cmd ?? record.script;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined;
}

export function ToolActivity(props: { items: ToolActivityItem[] }) {
  return (
    <section className={toolVariants({ part: 'container' })} aria-label="工具调用记录">
      <header className={toolVariants({ part: 'container-header' })}>
        <strong>工具调用</strong>
        <span className={toolVariants({ part: 'count' })} aria-label={`${props.items.length} 次调用`}>{props.items.length}</span>
      </header>
      {props.items.map((item) => (
        <ToolActivityCard key={item.toolUseId} item={item} />
      ))}
    </section>
  );
}

function ToolActivityCard({ item }: { item: ToolActivityItem }) {
  // Controlled open that follows item.status: a card that defaults open while
  // pending/running auto-collapses when it settles to completed/interrupted
  // (restoring the pre-Collapsible native-disclosure behavior, where
  // open={isOpenByDefault(status)} re-evaluated every render). The user can
  // still toggle in between — onOpenChange updates local state, and the next
  // status change re-syncs. See disclosure-collapsible-contract: defaultOpen
  // is banned here.
  const [open, setOpen] = useState(isOpenByDefault(item.status));
  useEffect(() => {
    setOpen(isOpenByDefault(item.status));
  }, [item.status]);
  const duration = formatDuration(item.durationMs);
  return (
    <Collapsible
      data-slot="tool"
      className={toolVariants({ part: 'item' })}
      data-status={item.status}
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger className={toolVariants({ part: 'header' })}>
        <span className={toolVariants({ part: 'dot' })} data-status={item.status} aria-hidden="true" />
        <span className={toolVariants({ part: 'name' })}>{resolveToolDisplayName(item)}</span>
        <span className={toolVariants({ part: 'meta' })}>
          {duration && <span className={toolVariants({ part: 'duration' })}>{duration}</span>}
          <span className={toolVariants({ part: 'status-label' })}>{STATUS_LABEL[item.status]}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ToolCardBody item={item} />
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * The tool detail body — error banner, intent, args, live output stream, and
 * result preview — shared by the boxed `ToolActivityCard` and the flat trow
 * rows. Extracted so the trow can render the same details without the card
 * frame. Args/intent stay routed through `formatRedactedJson` /
 * `formatToolIntent` (tool-args-redaction-contract).
 */
function ToolCardBody({ item }: { item: ToolActivityItem }) {
  const errored = item.status === 'errored';
  const permissionDenied = isPermissionDeniedToolResult(item.result);
  const running = item.status === 'running' || item.status === 'pending';
  const command = trowActivityKind(item.toolName) === 'command' ? extractToolCommand(item.args) : undefined;
  // A terminal result preview already prints `$ cmd` + cwd + exit in its head,
  // so the invocation line only fills the in-flight gap (and any non-terminal
  // result). The compact redacted-args fallback still routes through
  // formatRedactedJson (tool-args-redaction-contract).
  const resultIsTerminal = item.result?.kind === 'terminal';
  const showInvocation = !permissionDenied && !resultIsTerminal && (command !== undefined || item.args !== undefined);
  // While running the live stream is the output; once a structured result
  // preview exists it is the single quiet output block — never render both
  // (the old body double-printed stdout as stream + preview).
  const showLiveStream = !!item.outputChunks && item.outputChunks.length > 0 && (running || !item.result);
  return (
    // Flat, left-border-indented detail area — one visual language with the
    // 深度思考 disclosure body. No nested card frame, no per-row rounded boxes.
    <div className="mt-1 ml-2 flex flex-col gap-1.5 border-l border-[var(--border)] pl-2.5 pb-1">
      {errored && <ToolErrorBanner result={item.result} />}
      {showInvocation && (
        command !== undefined ? (
          <code className="[font-family:var(--font-mono)] [font-variant-ligatures:none] text-[length:var(--font-size-caption)] text-[color:var(--foreground-secondary)] [white-space:pre-wrap] [word-break:break-word]">
            <span className="select-none text-[color:var(--muted-foreground)]">$ </span>
            {redactSecrets(command)}
          </code>
        ) : (
          <pre className="m-0 max-h-40 overflow-auto [font-family:var(--font-mono)] [font-variant-ligatures:none] text-[length:var(--font-size-caption)] leading-normal text-[color:var(--foreground-secondary)] [white-space:pre-wrap] [word-break:break-word]">{formatRedactedJson(item.args)}</pre>
        )
      )}
      {showLiveStream && (
        <ToolOutputStream
          chunks={item.outputChunks!}
          live={running}
          interrupted={item.status === 'interrupted'}
          truncated={item.outputTruncated === true}
        />
      )}
      {item.result && !permissionDenied && (
        isConnectorTool(item.toolName) && item.result.kind === 'json' ? (
          <LoadToolResultPreview args={item.args} value={item.result.value} />
        ) : isAutomationTool(item.toolName) && item.result.kind === 'text' ? (
          <AutomationResultPreview text={item.result.text} />
        ) : (
          <ToolResultPreview content={item.result} />
        )
      )}
    </div>
  );
}

// Per-bucket icon for a trow's summary row + flat tool rows. Kept here (not in
// the pure summary module) because icons are React components.
const TROW_KIND_ICON: Record<TrowActivityKind, ComponentType<LucideProps>> = {
  read: FileText,
  search: Search,
  websearch: Globe,
  webfetch: Globe,
  edit: SquarePen,
  command: Terminal,
  explore: Search,
  browser: Globe,
  tool: Settings,
};

function trowKindIcon(toolName: string): ComponentType<LucideProps> {
  return TROW_KIND_ICON[trowActivityKind(toolName)];
}

/**
 * Codex-style tool trow (streaming UI rework): one contiguous run of tool
 * activity rendered as a single flat, borderless disclosure — replacing the
 * boxed "工具调用 N" card stack inside a turn. A single-tool group is just that
 * tool's own row (no double nesting); a multi-tool group adds a summary line
 * (shimmering active-tool description while running; bucketed counts once
 * settled) that expands to the flat-stacked tool rows.
 */
export function ToolTrow({ items }: { items: ToolActivityItem[] }) {
  if (items.length === 0) return null;
  if (items.length === 1) return <ToolTrowRow item={items[0]!} />;
  return <ToolTrowGroup items={items} />;
}

function ToolTrowGroup({ items }: { items: ToolActivityItem[] }) {
  const running = isTrowRunning(items);
  const attention = trowNeedsAttention(items);
  const active = activeTrowTool(items) ?? items[0]!;
  // Controlled open: default collapsed, but a waiting_permission or errored
  // tool forces the group open — a permission prompt must not hide behind the
  // summary line, and an error banner must stay diagnosable (the old boxed
  // cards kept errored tools expanded). The user's manual collapse sticks
  // while `attention` stays true. No defaultOpen
  // (disclosure-collapsible-contract) — controlled open re-syncs from status,
  // like ToolActivityCard.
  const [open, setOpen] = useState(attention);
  useEffect(() => {
    if (attention) setOpen(true);
  }, [attention]);
  const hasError = items.some((item) => item.status === 'errored');
  const SummaryIcon = trowKindIcon(active.toolName);
  const summary = running
    ? formatUserVisibleToolText(active.intent ?? '') || resolveToolDisplayName(active)
    : summarizeTrowTools(items);
  return (
    <Collapsible className="flex flex-col" data-trow="group" open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 py-0.5 text-left">
        <SummaryIcon size={16} aria-hidden="true" className={cn('shrink-0', hasError ? 'text-[color:var(--destructive)]' : 'text-[color:var(--muted-foreground)]')} />
        {running ? (
          <TextShimmer active={running} className="min-w-0 truncate text-[length:var(--font-size-base)]">{summary}</TextShimmer>
        ) : (
          <span className={cn('min-w-0 truncate text-[length:var(--font-size-base)]', hasError ? 'text-[color:var(--destructive)]' : 'text-[color:var(--muted-foreground)]')}>{summary}</span>
        )}
        <ChevronRight
          size={14}
          aria-hidden="true"
          className="shrink-0 text-[color:var(--muted-foreground)] opacity-0 [transition:transform_var(--duration-quick)_var(--ease-out-strong),opacity_var(--duration-quick)_var(--ease-out-strong)] group-hover:opacity-100 group-data-[panel-open]:rotate-90 group-data-[panel-open]:opacity-100"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="mt-0.5 ml-2 flex flex-col gap-0.5 border-l border-[var(--border)] pl-2.5">
          {items.map((item) => (
            <ToolTrowRow key={item.toolUseId} item={item} />
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * A single flat, borderless tool row inside a trow (or a whole single-tool
 * trow). A caption/mono weak-color header (status dot + name + duration/status)
 * expands to the shared `ToolCardBody`. Controlled open by status —
 * waiting_permission / running / errored open, settled collapsed — so a
 * permission prompt is never hidden. No card frame (`toolVariants({item})`),
 * per the flat trow visual language.
 */
function ToolTrowRow({ item }: { item: ToolActivityItem }) {
  const [open, setOpen] = useState(isOpenByDefault(item.status));
  useEffect(() => {
    setOpen(isOpenByDefault(item.status));
  }, [item.status]);
  const duration = formatDuration(item.durationMs);
  const running = item.status === 'running' || item.status === 'pending' || item.status === 'waiting_permission';
  const errored = item.status === 'errored';
  const RowIcon = trowKindIcon(item.toolName);
  // One row language with the multi-tool summary row: a kind icon + a
  // user-language phrase, never the old status-dot + mono tool-name + status
  // word. Running shimmers the model's intent (or the friendly tool name);
  // settled prefers the intent, falls back to the display name.
  const runningSummary = formatUserVisibleToolText(item.intent ?? '') || resolveToolDisplayName(item);
  const summaryTone = errored ? 'text-[color:var(--destructive)]' : 'text-[color:var(--muted-foreground)]';
  return (
    <Collapsible className="flex flex-col" data-trow="row" data-status={item.status} open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 py-0.5 text-left">
        <RowIcon
          size={16}
          aria-hidden="true"
          className={cn('shrink-0', errored ? 'text-[color:var(--destructive)]' : 'text-[color:var(--muted-foreground)]')}
        />
        {running ? (
          <TextShimmer active={running} className="min-w-0 truncate text-[length:var(--font-size-base)]">{runningSummary}</TextShimmer>
        ) : item.intent ? (
          <span className={cn('min-w-0 truncate text-[length:var(--font-size-base)]', summaryTone)}>{formatToolIntent(item.intent)}</span>
        ) : (
          <span className={cn('min-w-0 truncate text-[length:var(--font-size-base)]', summaryTone)}>{resolveToolDisplayName(item)}</span>
        )}
        {/* Quiet meta sits right after the label (near the text, not pinned to
            the far edge): duration + chevron ride in on hover / open, matching
            the multi-tool summary row — status is carried by the shimmer /
            destructive tint, so no always-on status word. */}
        <span className="inline-flex shrink-0 items-center gap-2 text-[length:var(--font-size-caption)] text-[color:var(--muted-foreground)] opacity-0 [transition:opacity_var(--duration-quick)_var(--ease-out-strong)] group-hover:opacity-100 group-data-[panel-open]:opacity-100">
          {duration && <span className="[font-variant-numeric:tabular-nums]">{duration}</span>}
          <ChevronRight
            size={14}
            aria-hidden="true"
            className="[transition:transform_var(--duration-quick)_var(--ease-out-strong)] group-data-[panel-open]:rotate-90"
          />
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ToolCardBody item={item} />
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * PR-UI-12 — live stdout/stderr stream from PR-REAL-4 `tool_output_delta`.
 *
 * Renders chunks in their original seq order (already sorted in main.tsx
 * before this component sees them) so interleaved stdout+stderr reads
 * the way a human would expect from a real terminal. Each chunk keeps
 * its stream tag so stderr can render in a destructive tone — a
 * single mono `<pre>` would lose that visual signal.
 *
 * `redacted: true` chunks render as a small inline hint "[已脱敏]"
 * instead of pretending the chunk arrived clean. Empty redacted
 * chunks (runtime suppressed everything) collapse to just the hint.
 *
 * `truncated: true` (PR-UI-12 fixup #2, @kenji A3 msg 365ff8b9) flips
 * a "已截断" pill in the header counts row. This means
 * `applyToolOutputChunk` dropped chunks (per-tool count or
 * total-char cap) or tail-truncated a single oversize chunk. Users
 * see explicitly that the displayed stream is bounded — they should
 * use Finder / external viewer if they need the full output.
 *
 * Auto-scroll: while `live` is true, we anchor to the bottom on every
 * chunk update so users see the latest output. Once the tool reaches
 * terminal (`tool_result`), auto-scroll stops so users can scroll up
 * to read history without being yanked back.
 */
function ToolOutputStream(props: {
  chunks: ToolOutputChunk[];
  live: boolean;
  interrupted: boolean;
  truncated: boolean;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!props.live) return;
    const el = preRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [props.chunks, props.live]);

  const stdoutCount = props.chunks.filter((c) => c.stream === 'stdout').length;
  const stderrCount = props.chunks.filter((c) => c.stream === 'stderr').length;
  const redactedCount = props.chunks.filter((c) => c.redacted).length;

  return (
    <div className={streamVariants({ part: 'container' })} data-live={props.live ? 'true' : undefined}>
      <header className={streamVariants({ part: 'header' })}>
        <span className={streamVariants({ part: 'label' })}>
          {props.live ? (
            <>
              <LiveIndicator />
              <span>实时输出</span>
            </>
          ) : props.interrupted ? (
            <span>已中断 · 已收到的输出</span>
          ) : (
            <span>工具输出</span>
          )}
        </span>
        <span className={streamVariants({ part: 'counts' })}>
          {stdoutCount > 0 && <span className={streamVariants({ part: 'count' })}>stdout {stdoutCount}</span>}
          {stderrCount > 0 && <span className={streamVariants({ part: 'count' })} data-stream="stderr">stderr {stderrCount}</span>}
          {redactedCount > 0 && <span className={streamVariants({ part: 'count' })} data-redacted="true">已脱敏 {redactedCount}</span>}
          {props.truncated && (
            <span
              className={streamVariants({ part: 'count' })}
              data-truncated="true"
              title="部分输出已截断；如需完整输出请查看对应工具结果或生成的 artifact"
            >
              已截断
            </span>
          )}
        </span>
      </header>
      <pre ref={preRef} className={streamVariants({ part: 'body' })}>
        {props.chunks.map((chunk) => (
          <span
            key={chunk.seq}
            className={streamVariants({ part: 'chunk' })}
            data-stream={chunk.stream}
            data-redacted={chunk.redacted ? 'true' : undefined}
          >
            {chunk.text}
            {chunk.redacted && (
              <span className={streamVariants({ part: 'redacted-tag' })} aria-label="已脱敏">
                {' '}[已脱敏]
              </span>
            )}
          </span>
        ))}
      </pre>
    </div>
  );
}

// Preserve the retired `.maka-tool-error*` leaf utilities onto Alert (#332 PR3c) —
// Alert owns the shell; these are the few declarations it doesn't set, kept arbitrary
// so they map 1:1 to the old CSS (`[align-self:start]`, not Tailwind's `flex-start`).
function ToolErrorBanner(props: { result: ToolActivityItem['result'] }) {
  // Tool stderr / raw provider errors occasionally slip credential paths,
  // bearer tokens, or API keys through main-side redaction. Apply a
  // defensive UI-level mask before display *and* before clipboard copy so
  // the user can't accidentally paste a credential into a bug report.
  const errorText = formatUserVisibleToolText(redactSecrets(extractErrorText(props.result)));
  const copyFeedback = useClipboardCopyFeedback();
  const copyPhase = copyFeedback.phaseFor('tool-error');
  const copyPending = copyPhase === 'pending';
  const copyLabel = copyPhase === 'pending'
    ? '复制中…'
    : copyPhase === 'copied'
      ? '已复制'
      : copyPhase === 'failed'
        ? '复制失败'
        : '复制';

  async function copy() {
    if (!errorText) return;
    await copyFeedback.copy('tool-error', errorText);
  }

  return (
    <Alert variant="error" className="mb-2.5">
      <AlertOctagon size={16} aria-hidden="true" />
      <AlertTitle>工具调用失败</AlertTitle>
      {errorText && (
        <AlertDescription className="[font-family:var(--font-mono)] text-xs leading-normal whitespace-pre-wrap [word-break:break-word]">
          {errorText.length > 240 ? `${errorText.slice(0, 240)}…` : errorText}
        </AlertDescription>
      )}
      {errorText && (
        <AlertAction>
          <UiButton
            type="button"
            variant="ghost"
            size="sm"
            className="maka-button [align-self:start] data-[pending=true]:cursor-progress data-[copy-feedback=copied]:text-[color:var(--link)] data-[copy-feedback=copied]:border-[oklch(from_var(--link)_l_c_h_/_0.35)] data-[copy-feedback=failed]:text-[color:var(--destructive)] data-[copy-feedback=failed]:border-[oklch(from_var(--destructive)_l_c_h_/_0.35)]"
            data-pending={copyPending ? 'true' : undefined}
            data-copy-feedback={copyPhase ?? undefined}
            aria-label={`${copyLabel}错误信息`}
            aria-busy={copyPending ? 'true' : undefined}
            disabled={copyPending}
            onClick={() => void copy()}
          >
            {copyPhase === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            <span>{copyLabel}</span>
          </UiButton>
        </AlertAction>
      )}
    </Alert>
  );
}

export function OverlayHost(props: { content?: ToolResultContent; onClose(): void }) {
  if (!props.content) return null;
  return (
    <div className="maka-modal-backdrop overlay">
      <UiButton
        className={cn('maka-button', previewVariants({ part: 'close' }))}
        type="button"
        variant="ghost"
        onClick={props.onClose}
        aria-label="关闭预览"
      >
        <X size={14} aria-hidden="true" />
        <span>关闭</span>
      </UiButton>
      <ToolResultPreview content={props.content} />
    </div>
  );
}

export { formatBytes } from './tool-activity/preview-utils.js';
