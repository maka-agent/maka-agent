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
  trowNeedsAttention,
  type TrowActivityKind,
} from './tool-activity/trow-summary.js';
import { deriveToolRowMotion, isToolRowRunning } from './tool-activity/tool-row-motion.js';
import {
  createToolDisclosureState,
  deriveToolActivityPresentation,
  isConnectorTool,
  resolveToolDisplayName,
  setToolDisclosureOpen,
  syncToolDisclosureState,
  type ToolActivityPresentation,
} from './tool-activity/presentation.js';
import { Alert, AlertAction, AlertDescription, AlertTitle } from './primitives/alert.js';
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from './primitives/collapsible.js';
import { previewVariants, TextShimmer, toolVariants } from './primitives/chat.js';
import { redactSecrets } from './redact.js';
import { Button as UiButton, cn } from './ui.js';
import { describeLoadToolResult, formatToolIntent } from './tool-format.js';
import { formatDuration, formatUserVisibleToolText } from './tool-activity/preview-utils.js';
import {
  formatQuietJsonValue,
  formatToolInvocationLine,
} from './tool-activity/builtin-preview.js';
import {
  TOOL_OUTPUT_BODY_CLASS,
  TOOL_OUTPUT_COMMAND_CLASS,
  TOOL_OUTPUT_NOTE_CLASS,
  TOOL_OUTPUT_PANEL_CLASS,
  ToolResultPreview,
} from './tool-activity/tool-result-preview.js';

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
          自动化任务已创建：{redactSecrets(created[1] ?? '')}
        </p>
        {schedule && <p className={previewVariants({ part: 'load-tool-count' })}>{redactSecrets(schedule)}</p>}
        {nextFire && nextFire !== 'N/A' && <p className={previewVariants({ part: 'load-tool-tools' })}>下次触发：{redactSecrets(nextFire)}</p>}
        <p className={previewVariants({ part: 'load-tool-footer' })}>{redactSecrets(created[2] ?? '')}</p>
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
              {redactSecrets(head)}
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

function useToolDisclosure(presentation: ToolActivityPresentation) {
  const [disclosure, setDisclosure] = useState(() => createToolDisclosureState(presentation));
  useEffect(() => {
    setDisclosure((current) => syncToolDisclosureState(current, presentation));
  }, [presentation.needsAttention]);
  return {
    open: disclosure.open,
    setOpen: (open: boolean) => setDisclosure((current) => setToolDisclosureOpen(current, open)),
  };
}

function extractErrorText(result: ToolActivityItem['result']): string {
  if (!result) return '';
  switch (result.kind) {
    case 'text':
      return result.text;
    case 'json': {
      // Same quiet formatter as the panel — never dump escaped JSON braces.
      const quiet = formatQuietJsonValue(result.value);
      return quiet.headline ? `${quiet.headline}\n${quiet.body}` : quiet.body;
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
 * Result kinds (or tool-specific cards) that already paint their own chrome —
 * never nest them inside the shared quiet well.
 */
function resultOwnsOwnPanel(item: ToolActivityItem): boolean {
  const result = item.result;
  if (!result) return false;
  if (isAutomationTool(item.toolName) && result.kind === 'text') return true;
  if (isConnectorTool(item.toolName) && result.kind === 'json') return true;
  switch (result.kind) {
    case 'terminal':
    case 'shell_run':
    case 'subagent':
    case 'explore_agent':
    case 'web_search':
    case 'web_search_error':
    case 'file_diff':
    case 'office_document':
    case 'rive_workflow':
      return true;
    default:
      return false;
  }
}

function isCancelledToolResult(result: ToolActivityItem['result']): boolean {
  if (!result) return false;
  if (result.kind === 'terminal' || result.kind === 'shell_run') {
    return result.status === 'cancelled';
  }
  return false;
}

function resultHasCapturedStreams(result: ToolActivityItem['result']): boolean {
  if (!result) return false;
  if (result.kind === 'terminal' || result.kind === 'shell_run') {
    return (result.stdout?.length ?? 0) > 0 || (result.stderr?.length ?? 0) > 0;
  }
  return true;
}

/**
 * Background Bash yields an empty shell_run body; keep the live chunks the
 * user already saw by filling empty stdout/stderr from outputChunks. Also
 * forward truncation / redaction hints so settled preview matches live.
 */
function withLiveStreamFallback(
  result: NonNullable<ToolActivityItem['result']>,
  chunks: ToolActivityItem['outputChunks'] | undefined,
  options?: { truncated?: boolean },
): NonNullable<ToolActivityItem['result']> {
  if (result.kind !== 'terminal' && result.kind !== 'shell_run') return result;
  if (resultHasCapturedStreams(result)) return result;

  let stdout = '';
  let stderr = '';
  let anyRedacted = false;
  for (const chunk of chunks ?? []) {
    if (chunk.redacted) anyRedacted = true;
    if (chunk.stream === 'stderr') stderr += chunk.text;
    else stdout += chunk.text;
  }
  const truncated = result.stdoutTruncated === true || options?.truncated === true;
  // Empty redacted/truncated live buffer still carries diagnosis — do not
  // early-return and drop "已脱敏" / "输出已截断".
  if (!stdout && !stderr && !anyRedacted && !truncated) return result;

  // Match live stream's "[已脱敏]" marker when a chunk was redacted
  // (including empty bodies that only suppressed secrets).
  if (anyRedacted) {
    if (stdout.length > 0) stdout = `${stdout}${stdout.endsWith('\n') ? '' : '\n'}[已脱敏]`;
    else if (stderr.length > 0) stderr = `${stderr}${stderr.endsWith('\n') ? '' : '\n'}[已脱敏]`;
    else stdout = '[已脱敏]';
  }
  return {
    ...result,
    stdout,
    stderr,
    stdoutTruncated: truncated,
  };
}

function toolStatusLabel(item: ToolActivityItem): string {
  // Outer label follows call status. Panel notes still show task cancel state.
  if (item.status === 'interrupted' && isCancelledToolResult(item.result)) return '已取消';
  if (
    (item.result?.kind === 'terminal' || item.result?.kind === 'shell_run')
    && item.result.status === 'timed_out'
    && item.status !== 'completed'
  ) {
    return '已超时';
  }
  return STATUS_LABEL[item.status];
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
  // Ordinary work stays summarized. A new permission/error state opens the
  // diagnostics, while an explicit user toggle survives later ordinary status
  // changes. See disclosure-collapsible-contract: defaultOpen is banned here.
  const presentation = deriveToolActivityPresentation(item);
  const disclosure = useToolDisclosure(presentation);
  const duration = formatDuration(item.durationMs);
  return (
    <Collapsible
      data-slot="tool"
      className={toolVariants({ part: 'item' })}
      data-status={item.status}
      open={disclosure.open}
      onOpenChange={disclosure.setOpen}
    >
      <CollapsibleTrigger className={toolVariants({ part: 'header' })}>
        <span className={toolVariants({ part: 'dot' })} data-status={item.status} aria-hidden="true" />
        <span className={toolVariants({ part: 'name' })}>{resolveToolDisplayName(item)}</span>
        <span className={toolVariants({ part: 'meta' })}>
          {duration && <span className={toolVariants({ part: 'duration' })}>{duration}</span>}
          <span className={toolVariants({ part: 'status-label' })}>{toolStatusLabel(item)}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ToolCardBody item={item} />
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * The tool detail body — error banner + one Codex-like output well for
 * command/args, live stream, and structured results. Shared by the boxed
 * `ToolActivityCard` and flat trow rows. Args/results route through
 * quiet formatters (tool-args-redaction-contract / quiet-panel contracts).
 */
function ToolCardBody({ item }: { item: ToolActivityItem }) {
  const cancelled = isCancelledToolResult(item.result);
  // Cancel maps to interrupted at materialize/live-projection; keep defensive
  // checks so a stale errored+cancelled item still does not look like failure.
  const errored = item.status === 'errored' && !cancelled;
  const permissionDenied = isPermissionDeniedToolResult(item.result);
  const running = item.status === 'running' || item.status === 'pending';
  // Rich kinds + tool-specific cards own their chrome — never nest in the shared well.
  const ownsPanel = resultOwnsOwnPanel(item);
  const showErrorBanner = errored;
  // Every tool: human invocation line from args — never pretty-printed JSON.
  // Skip when the result panel already prints the command (terminal/shell_run).
  const invocationLine = !permissionDenied && !ownsPanel
    ? formatToolInvocationLine(item)
    : undefined;
  // While running the live stream is the output; once a structured result
  // preview exists it is the single quiet output block — never render both.
  // Owned terminal/shell_run panels absorb empty-body yield via
  // withLiveStreamFallback (never a second live panel).
  const showLiveStream = !!item.outputChunks
    && item.outputChunks.length > 0
    && !ownsPanel
    && (running || !item.result);
  const showResult = !!item.result && !permissionDenied;
  const displayResult = showResult && item.result
    ? withLiveStreamFallback(item.result, item.outputChunks, {
      truncated: item.outputTruncated === true,
    })
    : undefined;
  const quietJson =
    displayResult?.kind === 'json'
      ? formatQuietJsonValue(displayResult.value)
      : undefined;
  // Keep the invocation line whenever args yield one. Only add a result
  // headline when it says something different (avoids dropping Write/Edit paths
  // when path === path).
  const showInvocation = invocationLine !== undefined;
  const resultHeadline = quietJson?.headline
    && quietJson.headline !== invocationLine
    ? quietJson.headline
    : undefined;
  // Owned-panel kinds render alone. Everything else shares one quiet well.
  const hasSharedPanelContent =
    !ownsPanel && (
      showInvocation
      || !!resultHeadline
      || showLiveStream
      || showResult
      || (!!item.args && !permissionDenied && !invocationLine && !showResult && !showLiveStream)
    );

  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {showErrorBanner && <ToolErrorBanner result={displayResult ?? item.result} />}
      {showResult && ownsPanel && displayResult && (
        isConnectorTool(item.toolName) && displayResult.kind === 'json' ? (
          <LoadToolResultPreview args={item.args} value={displayResult.value} />
        ) : isAutomationTool(item.toolName) && displayResult.kind === 'text' ? (
          <AutomationResultPreview text={displayResult.text} />
        ) : (
          <ToolResultPreview content={displayResult} />
        )
      )}
      {hasSharedPanelContent && (
        <div
          data-slot="tool-output"
          className={cn(TOOL_OUTPUT_PANEL_CLASS, errored && 'border-[oklch(from_var(--destructive)_l_c_h_/_0.28)]')}
        >
          {showInvocation && (
            <code className={TOOL_OUTPUT_COMMAND_CLASS}>{invocationLine}</code>
          )}
          {resultHeadline && (
            <code className={TOOL_OUTPUT_COMMAND_CLASS}>{resultHeadline}</code>
          )}
          {/* No formatRedactedJson dump — if invocation failed, quiet-format args. */}
          {!showInvocation && !resultHeadline && item.args !== undefined && !permissionDenied && !showResult && (
            <pre className={cn(TOOL_OUTPUT_BODY_CLASS, 'max-h-40')}>
              {formatQuietJsonValue(item.args).body}
            </pre>
          )}
          {showLiveStream && (
            <ToolOutputStream
              chunks={item.outputChunks!}
              live={running}
              truncated={item.outputTruncated === true}
            />
          )}
          {showResult && !ownsPanel && displayResult && (
            quietJson ? (
              <pre className={TOOL_OUTPUT_BODY_CLASS}>{quietJson.body}</pre>
            ) : (
              <ToolResultPreview content={displayResult} />
            )
          )}
        </div>
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

// #646 run→done seam: the one-shot settle "landing". Reuses the whitelisted
// `maka-stream-fade-in` keyframe (opacity 0→1, one-shot `both`) — no new keyframe
// (design-406 governance) — and rides `var(--duration-emphasized)` /
// `var(--ease-out-strong)` so it converges with the motion tokens. Applied only
// when `motion.settling` (the row was seen running here and just settled), so a
// replayed transcript's rows stay static. Auto-frozen under reduced-motion /
// visual-smoke by the global rules in styles/base.css.
const SETTLE_FADE = '[animation:maka-stream-fade-in_var(--duration-emphasized)_var(--ease-out-strong)_both]';

/**
 * Codex-style tool trow (streaming UI rework): one contiguous run of tool
 * activity rendered as a single flat, borderless disclosure — replacing the
 * boxed "工具调用 N" card stack inside a turn. The summary disclosure is the
 * stable root for both one and many tools, so a second call appends inside the
 * same component instead of replacing an expanded row with a collapsed group.
 */
export function ToolTrow({ items }: { items: ToolActivityItem[] }) {
  if (items.length === 0) return null;
  return <ToolTrowGroup items={items} />;
}

function ToolTrowGroup({ items }: { items: ToolActivityItem[] }) {
  const running = isTrowRunning(items);
  const attention = trowNeedsAttention(items);
  const active = activeTrowTool(items) ?? items[0]!;
  const activePresentation = deriveToolActivityPresentation(active);
  // Groups share the same disclosure state as a single row: ordinary work is
  // summarized; a new permission/error state opens diagnostics; manual choice
  // survives ordinary status changes.
  const disclosure = useToolDisclosure({ ...activePresentation, needsAttention: attention });
  // #646: a group settles when all its tools do; the settle fade plays only if
  // the group was ever seen running here (not a replayed transcript). The
  // delayed shimmer de-flickers a group whose tools all finish sub-second.
  const everRunningRef = useRef(false);
  if (running) everRunningRef.current = true;
  const settled = !running;
  const settling = settled && everRunningRef.current;
  const hasError = items.some((item) => item.status === 'errored');
  const SummaryIcon = TROW_KIND_ICON[activePresentation.kind];
  const summary = running
    ? activePresentation.summary
    : summarizeTrowTools(items);
  return (
    <Collapsible className="flex flex-col" data-trow="group" data-settled={settled ? 'true' : undefined} open={disclosure.open} onOpenChange={disclosure.setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 py-0.5 text-left">
        <SummaryIcon size={16} aria-hidden="true" className={cn('shrink-0', hasError ? 'text-[color:var(--destructive)]' : 'text-[color:var(--muted-foreground)]')} />
        {running ? (
          <TextShimmer active delayed className="min-w-0 truncate text-[length:var(--font-size-base)]">{summary}</TextShimmer>
        ) : (
          <span className={cn('min-w-0 truncate text-[length:var(--font-size-base)]', hasError ? 'text-[color:var(--destructive)]' : 'text-[color:var(--muted-foreground)]', settling && SETTLE_FADE)}>{summary}</span>
        )}
        <ChevronRight
          size={14}
          aria-hidden="true"
          className="shrink-0 text-[color:var(--muted-foreground)] opacity-0 [transition:transform_var(--duration-quick)_var(--ease-out-strong),opacity_var(--duration-quick)_var(--ease-out-strong)] group-hover:opacity-100 group-data-[panel-open]:rotate-90 group-data-[panel-open]:opacity-100"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {items.length === 1 ? (
          <ToolCardBody item={items[0]!} />
        ) : (
          <div className="mt-0.5 ml-2 flex flex-col gap-0.5 border-l border-[var(--border)] pl-2.5">
            {items.map((item) => (
              <ToolTrowRow key={item.toolUseId} item={item} />
            ))}
          </div>
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * A single flat, borderless tool row inside a multi-tool trow. Ordinary work
 * is collapsed; permission prompts and errors open for attention, and a user's
 * manual choice survives later ordinary status changes. No card frame
 * (`toolVariants({item})`), per the flat trow visual language.
 */
function ToolTrowRow({ item }: { item: ToolActivityItem }) {
  const presentation = deriveToolActivityPresentation(item);
  const disclosure = useToolDisclosure(presentation);
  const duration = formatDuration(item.durationMs);
  // #646 run→done seam: `everRunning` is sticky across this row's renders so the
  // settle fade fires only for a tool that ran here, never for a replayed row
  // mounted already terminal. The delayed shimmer + one-shot fade share the same
  // ~200ms window, so a sub-second tool neither sweeps nor lands — it just appears.
  const everRunningRef = useRef(false);
  if (isToolRowRunning(item.status)) everRunningRef.current = true;
  const motion = deriveToolRowMotion({ status: item.status, everRunning: everRunningRef.current });
  const errored = item.status === 'errored';
  const RowIcon = TROW_KIND_ICON[presentation.kind];
  // One row language with the multi-tool summary row: a kind icon + a
  // user-language phrase, never the old status-dot + mono tool-name + status
  // word. Running shimmers the model's intent (or the friendly tool name);
  // settled prefers the intent, falls back to the display name.
  const summaryTone = errored ? 'text-[color:var(--destructive)]' : 'text-[color:var(--muted-foreground)]';
  const settleFade = motion.settling ? SETTLE_FADE : undefined;
  return (
    <Collapsible className="flex flex-col" data-trow="row" data-status={item.status} data-settled={motion.settled ? 'true' : undefined} open={disclosure.open} onOpenChange={disclosure.setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 py-0.5 text-left">
        <RowIcon
          size={16}
          aria-hidden="true"
          className={cn('shrink-0', errored ? 'text-[color:var(--destructive)]' : 'text-[color:var(--muted-foreground)]')}
        />
        {motion.shimmer ? (
          <TextShimmer active delayed className="min-w-0 truncate text-[length:var(--font-size-base)]">{presentation.summary}</TextShimmer>
        ) : item.intent ? (
          <span className={cn('min-w-0 truncate text-[length:var(--font-size-base)]', summaryTone, settleFade)}>{formatToolIntent(item.intent)}</span>
        ) : (
          <span className={cn('min-w-0 truncate text-[length:var(--font-size-base)]', summaryTone, settleFade)}>{resolveToolDisplayName(item)}</span>
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
 * Live stdout/stderr body for the unified tool-output panel.
 *
 * No second card shell and no "实时输出" header — the parent panel is the
 * only chrome. Chunks keep stream tags so stderr can tint destructive.
 * Redacted chunks still surface an inline "[已脱敏]" hint. Truncation is a
 * quiet footer note, not a flag row.
 *
 * Auto-scroll: while `live` is true, anchor to the bottom on every chunk
 * update; stop once the tool settles so the user can scroll history.
 */
function ToolOutputStream(props: {
  chunks: ToolOutputChunk[];
  live: boolean;
  truncated: boolean;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!props.live) return;
    const el = preRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [props.chunks, props.live]);

  return (
    <>
      <pre ref={preRef} className={TOOL_OUTPUT_BODY_CLASS} data-live={props.live ? 'true' : undefined}>
        {props.chunks.map((chunk) => (
          <span
            key={chunk.seq}
            className={cn(
              'contents',
              chunk.stream === 'stderr' && 'text-[color:var(--destructive)]',
              chunk.redacted && 'opacity-[0.65]',
            )}
            data-stream={chunk.stream}
            data-redacted={chunk.redacted ? 'true' : undefined}
          >
            {chunk.text}
            {chunk.redacted && (
              <span className="inline ml-0.5 text-[color:var(--warning-text,var(--info-text))]" aria-label="已脱敏">
                {' '}[已脱敏]
              </span>
            )}
          </span>
        ))}
      </pre>
      {props.truncated && (
        <p className={TOOL_OUTPUT_NOTE_CLASS}>输出已截断</p>
      )}
    </>
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
