import { useEffect, useRef, useState } from 'react';
import { type ToolResultContent } from '@maka/core';
import { AlertOctagon, Check, Copy, X } from './icons.js';
import { useClipboardCopyFeedback } from './clipboard-feedback.js';
import { detectUiLocale } from './locale-helpers.js';
import { type ToolActivityItem, type ToolOutputChunk } from './materialize.js';
import { Alert, AlertAction, AlertDescription, AlertTitle } from './primitives/alert.js';
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from './primitives/collapsible.js';
import { LiveIndicator, previewVariants, streamVariants, toolVariants } from './primitives/chat.js';
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
  const duration = formatDuration(item.durationMs);
  const errored = item.status === 'errored';
  const permissionDenied = isPermissionDeniedToolResult(item.result);
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
        <div className={toolVariants({ part: 'body' })}>
          {errored && <ToolErrorBanner result={item.result} />}
          {item.intent && !permissionDenied && <p className={toolVariants({ part: 'intent' })}>{formatToolIntent(item.intent)}</p>}
          {item.args !== undefined && !permissionDenied && (
            <pre className={`maka-code ${toolVariants({ part: 'args' })}`}>{formatRedactedJson(item.args)}</pre>
          )}
          {item.outputChunks && item.outputChunks.length > 0 && (
            <ToolOutputStream
              chunks={item.outputChunks}
              live={item.status === 'running' || item.status === 'pending'}
              interrupted={item.status === 'interrupted'}
              truncated={item.outputTruncated === true}
            />
          )}
          {item.result && !permissionDenied && (
            isConnectorTool(item.toolName) && item.result.kind === 'json' ? (
              <LoadToolResultPreview args={item.args} value={item.result.value} />
            ) : (
              <ToolResultPreview content={item.result} />
            )
          )}
        </div>
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
      <AlertOctagon size={16} strokeWidth={2} aria-hidden="true" />
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
        <X size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>关闭</span>
      </UiButton>
      <ToolResultPreview content={props.content} />
    </div>
  );
}

export { formatBytes } from './tool-activity/preview-utils.js';
