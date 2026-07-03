import { useEffect, useRef } from 'react';
import { normalizeSearchUrl, type ToolResultContent } from '@maka/core';
import { AlertOctagon, Check, Copy, X } from './icons.js';
import { useClipboardCopyFeedback } from './clipboard-feedback.js';
import { detectUiLocale } from './locale-helpers.js';
import { type ToolActivityItem, type ToolOutputChunk } from './materialize.js';
import { Alert, AlertAction, AlertDescription, AlertTitle } from './primitives/alert.js';
import { LiveIndicator, previewVariants, streamVariants, toolVariants } from './primitives/chat.js';
import { redactSecrets } from './redact.js';
import { Button as UiButton, cn } from './ui.js';
import { describeLoadToolResult, formatRedactedJson, formatToolIntent, loadToolDisplayName } from './tool-format.js';

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
    return <OverlayPreview content={{ kind: 'json', value: props.value }} />;
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

function formatUserVisibleToolText(text: string): string {
  return text.replace(/\bUser denied permission\b/g, '用户已拒绝权限请求');
}

function isPermissionDeniedToolResult(result: ToolActivityItem['result']): boolean {
  return result?.kind === 'text' && formatUserVisibleToolText(result.text).trim() === '用户已拒绝权限请求';
}

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms < 0) return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function ToolActivity(props: { items: ToolActivityItem[] }) {
  return (
    <section className={toolVariants({ part: 'container' })} aria-label="工具调用记录">
      <header className={toolVariants({ part: 'container-header' })}>
        <strong>工具调用</strong>
        <span className={toolVariants({ part: 'count' })} aria-label={`${props.items.length} 次调用`}>{props.items.length}</span>
      </header>
      {props.items.map((item) => {
        const duration = formatDuration(item.durationMs);
        const errored = item.status === 'errored';
        const permissionDenied = isPermissionDeniedToolResult(item.result);
        return (
          <details
            key={item.toolUseId}
            data-slot="tool"
            className={toolVariants({ part: 'item' })}
            data-status={item.status}
            open={isOpenByDefault(item.status)}
          >
            <summary className={toolVariants({ part: 'header' })}>
              <span className={toolVariants({ part: 'dot' })} data-status={item.status} aria-hidden="true" />
              <span className={toolVariants({ part: 'name' })}>{resolveToolDisplayName(item)}</span>
              <span className={toolVariants({ part: 'meta' })}>
                {duration && <span className={toolVariants({ part: 'duration' })}>{duration}</span>}
                <span className={toolVariants({ part: 'status-label' })}>{STATUS_LABEL[item.status]}</span>
              </span>
            </summary>
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
                  <OverlayPreview content={item.result} />
                )
              )}
            </div>
          </details>
        );
      })}
    </section>
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
        <AlertDescription className="[font-family:var(--font-mono)] text-[12px] leading-[1.5] whitespace-pre-wrap [word-break:break-word]">
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
      <OverlayPreview content={props.content} />
    </div>
  );
}

/**
 * Renders a ToolResultContent payload with kind-specific presentation:
 * - `file_diff`: line-level red/green diff coloring
 * - `terminal`: stdout + stderr split with exit-code badge + stderr in
 *   destructive tone
 * - `office_document`: Office adapter stdout/stderr/diagnostic cards
 * - `explore_agent`: bounded read-only subagent findings
 * - `subagent`: foreground child-agent run summary
 * - `json`: pretty-printed in a code block
 * - `text` / others: plain `<pre>` fallback
 *
 * All variants are height-bounded by the `@maka/ui` previewVariants `overlay`
 * part (the retired `.maka-overlay-preview` base) to keep kilobyte outputs from
 * pushing the composer off-screen.
 */
/**
 * Cap displayed line count to keep a giant tool output (10k-line stderr from
 * a failing test run) from creating 10k React elements and from drowning the
 * chat surface visually. We slice, then append a single explainer line that
 * lets the user know the rest exists.
 */
const TOOL_LINE_CAP = 500;

function capLines(text: string): { body: string; capped: number } {
  const lines = text.split('\n');
  if (lines.length <= TOOL_LINE_CAP) return { body: text, capped: 0 };
  return {
    body: lines.slice(0, TOOL_LINE_CAP).join('\n'),
    capped: lines.length - TOOL_LINE_CAP,
  };
}

function OverlayPreview(props: { content: ToolResultContent }) {
  const { content } = props;

  if (content.kind === 'file_diff') {
    return <FileDiffPreview diff={content.diff} paths={content.paths} />;
  }

  if (content.kind === 'web_search') {
    return (
      <WebSearchPreview query={content.query} provider={content.provider} rows={content.rows} />
    );
  }

  if (content.kind === 'web_search_error') {
    return (
      <WebSearchErrorPreview
        query={content.query}
        provider={content.provider}
        reason={content.reason}
        message={content.message}
        credentialSource={content.credentialSource}
      />
    );
  }

  if (content.kind === 'terminal') {
    return (
      <TerminalPreview
        cwd={content.cwd}
        cmd={content.cmd}
        exitCode={content.exitCode}
        stdout={content.stdout}
        stderr={content.stderr}
      />
    );
  }

  if (content.kind === 'office_document') {
    return <OfficeDocumentPreview result={content} />;
  }

  if (content.kind === 'explore_agent') {
    return <ExploreAgentPreview result={content} />;
  }

  if (content.kind === 'subagent') {
    return <SubagentPreview result={content} />;
  }

  if (content.kind === 'rive_workflow') {
    return <RiveWorkflowPreview result={content} />;
  }

  if (content.kind === 'json') {
    let body: string;
    try {
      body = JSON.stringify(content.value, null, 2);
    } catch {
      body = String(content.value);
    }
    // JSON shouldn't contain secrets persisted by Maka (settings + telemetry
    // are sanitized at write-time), but apply the renderer redactor as a
    // second-layer defense in case a tool returned raw provider response.
    return <pre className={previewVariants({ part: 'overlay' })} data-kind="json">{formatUserVisibleToolText(redactSecrets(body))}</pre>;
  }

  if (content.kind === 'text') {
    const { body, capped } = capLines(formatUserVisibleToolText(redactSecrets(content.text)));
    return (
      <pre className={previewVariants({ part: 'overlay' })} data-kind="text">
        {body}
        {capped > 0 && `\n\n… 已隐藏 ${capped} 行`}
      </pre>
    );
  }

  // file_write / image / summary / unknown — show a compact descriptor so the
  // user knows what kind landed without dumping binary or storage refs.
  return (
    <pre className={previewVariants({ part: 'overlay' })} data-kind={content.kind}>
      [{content.kind}]
    </pre>
  );
}

function RiveWorkflowPreview(props: {
  result: Extract<ToolResultContent, { kind: 'rive_workflow' }>;
}) {
  const { result } = props;
  const rows = [
    ['动作', result.action],
    ['状态', result.state ?? result.projection?.state],
    ['workflow_run', result.ids.workflowRunId ?? result.projection?.workflowRunId],
    ['scheduler_run', result.ids.schedulerRunId ?? result.projection?.schedulerRunId],
    ['root_work', result.ids.rootWorkNodeId ?? result.projection?.rootWorkNodeId],
    ['scheduler_state', result.projection?.schedulerState],
    ['root_state', result.projection?.rootState],
  ].filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0);
  const nodes = (result.nodes ?? []).slice(0, 12);
  const failureLines = result.error
    ? [
        '',
        '错误',
        `reason: ${result.error.reason}`,
        `message: ${result.error.message}`,
        result.error.code ? `code: ${result.error.code}` : '',
        result.error.suggestedAction ? `suggested_action: ${result.error.suggestedAction}` : '',
      ].filter(Boolean)
    : [];
  const diagnosticLines = [
    result.stdoutTail ? `stdout_tail:\n${redactSecrets(result.stdoutTail)}` : '',
    result.stderrTail ? `stderr_tail:\n${redactSecrets(result.stderrTail)}` : '',
  ].filter(Boolean);
  const body = [
    result.ok ? 'Rive workflow completed' : 'Rive workflow failed',
    result.summary,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...(nodes.length > 0 ? ['', '节点摘要', ...nodes.map(formatRiveWorkflowNode)] : []),
    ...failureLines,
    ...(diagnosticLines.length > 0 ? ['', '诊断片段', ...diagnosticLines] : []),
  ].join('\n');
  const cappedPreview = capLines(body);
  return (
    <pre className={previewVariants({ part: 'overlay' })} data-kind="rive_workflow">
      {cappedPreview.body}
      {cappedPreview.capped > 0 && `\n\n… 已隐藏 ${cappedPreview.capped} 行`}
    </pre>
  );
}

function formatRiveWorkflowNode(node: NonNullable<Extract<ToolResultContent, { kind: 'rive_workflow' }>['nodes']>[number]): string {
  const label = node.title ?? node.templateId ?? node.id ?? 'node';
  const attrs = [
    node.state,
    node.runner ? `runner=${node.runner}` : '',
    node.worker ? `worker=${node.worker}` : '',
  ].filter(Boolean).join(' · ');
  return attrs ? `- ${label}: ${attrs}` : `- ${label}`;
}

type SubagentResult = Extract<ToolResultContent, { kind: 'subagent' }>;

const SUBAGENT_STATUS_LABEL: Record<SubagentResult['status'], string> = {
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  running: '运行中',
  waiting_permission: '等待权限',
};

function SubagentPreview(props: {
  result: SubagentResult;
}) {
  const { result } = props;
  const duration = formatDuration(result.durationMs);
  const status = presentSubagentStatus(result.status);
  const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
  const artifactCount = result.artifactIds.length;
  const meta = [
    status,
    presentSubagentPermission(result.permissionMode),
    duration ? `耗时 ${duration}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'agent' }))} data-kind="subagent" data-status={result.status}>
      <header className={previewVariants({ part: 'agent-head' })}>
        <strong>{redactSecrets(result.agentName || 'Subagent')}</strong>
        <small>{meta}</small>
      </header>
      {summary.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="子代理结果摘要">
          <strong>结果摘要</strong>
          <p>{redactSecrets(summary)}</p>
        </section>
      )}
      {result.failureClass && (
        <div className={previewVariants({ part: 'agent-message' })} role="note">
          {redactSecrets(result.failureClass)}
        </div>
      )}
      {artifactCount > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="子代理产物">
          <strong>产物</strong>
          <p>{artifactCount} 个</p>
        </section>
      )}
    </div>
  );
}

function presentSubagentStatus(status: SubagentResult['status']): string {
  return SUBAGENT_STATUS_LABEL[status] ?? status;
}

function presentSubagentPermission(permissionMode: SubagentResult['permissionMode']): string {
  if (permissionMode === 'explore') return '只读';
  return permissionMode;
}

function ExploreAgentPreview(props: {
  result: Extract<ToolResultContent, { kind: 'explore_agent' }>;
}) {
  const { result } = props;
  const copyFeedback = useClipboardCopyFeedback();
  const candidateFiles = result.candidateFiles.slice(0, 8);
  const matches = result.matches.slice(0, 8);
  const processLines = Array.isArray(result.recentEvents) && result.recentEvents.length > 0
    ? result.recentEvents.slice(0, 20).map((event) => formatExploreAgentEvent(event, result.startedAt))
    : (result.progress ?? []).slice(0, 12);
  const progress = processLines.slice(0, 6);
  const evidence = (result.evidence ?? []).slice(0, 6);
  const resultSummary = typeof result.summary === 'string' ? result.summary.trim() : '';
  const reportText = typeof result.report === 'string' ? result.report.trim() : '';
  const terminalStatus = presentExploreAgentTerminalStatus(result.terminalStatus, result.ok, result.partial === true, result.reason);
  const status = result.ok
    ? '已完成'
    : result.reason === 'aborted' && result.partial === true
      ? '已取消 · 保留部分结果'
      : presentExploreAgentReason(result.reason) ?? '未完成';
  const reportLines = reportText.split('\n').filter((line) => line.trim().length > 0).slice(0, 8);
  const notes = result.notes.slice(0, 4);
  const roots = result.roots.length > 0 ? result.roots.join(', ') : '.';
  const queries = result.queries.length > 0 ? result.queries.join(', ') : '未指定';
  const ignoredPaths = Array.isArray(result.ignoredPaths) && result.ignoredPaths.length > 0
    ? result.ignoredPaths.join(', ')
    : '';
  const stoppingCondition = typeof result.stoppingCondition === 'string'
    ? result.stoppingCondition.trim()
    : '';
  const limitReasons = Array.isArray(result.limitReasons)
    ? result.limitReasons.map(presentExploreAgentLimitReason).filter(Boolean).join('、')
    : '';
  const filesDiscovered = typeof result.filesDiscovered === 'number' && Number.isFinite(result.filesDiscovered)
    ? Math.max(0, Math.floor(result.filesDiscovered))
    : result.filesInspected;
  const skippedSummary = result.sensitiveFilesSkipped && result.sensitiveFilesSkipped > 0
    ? `跳过 ${result.filesSkipped} 个（含敏感 ${result.sensitiveFilesSkipped} 个）`
    : `跳过 ${result.filesSkipped} 个`;
  const duration = formatDuration(result.durationMs);
  const summaryText = resultSummary.length > 0
    ? [
      `状态：${status}`,
      `终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `摘要：${resultSummary}`,
      `范围：${roots}`,
      `查询：${queries}`,
      `发现/读取：${filesDiscovered} / ${result.filesInspected} 个文件`,
      duration ? `耗时：${duration}` : '',
      ignoredPaths ? `忽略：${ignoredPaths}` : '',
      stoppingCondition ? `停止条件：${stoppingCondition}` : '',
      limitReasons ? `预算边界：${limitReasons}` : '',
    ].filter((line) => line.length > 0).join('\n')
    : '';
  const processText = [
    summaryText,
    processLines.length > 0 ? `事件：${processLines.length}` : '',
    processLines.join('\n'),
  ].filter((line) => line.trim().length > 0).join('\n').trim();
  const evidenceText = evidence.length > 0
    ? [
      `状态：${status}`,
      `终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `证据：${evidence.length}`,
      ...evidence.map((item) => [
        `- ${item.path}${typeof item.line === 'number' ? `:${item.line}` : ''}`,
        item.label,
        typeof item.score === 'number' ? `分数 ${item.score}` : '',
      ].filter(Boolean).join(' — ')),
    ].join('\n')
    : '';
  const candidateText = candidateFiles.length > 0
    ? [
      `状态：${status}`,
      `终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `发现/读取：${filesDiscovered} / ${result.filesInspected} 个文件`,
      `候选：${candidateFiles.length}`,
      ...candidateFiles.map((file) => [
        `- ${file.path}`,
        `分数 ${file.score}`,
        file.reasons.length > 0 ? presentExploreAgentCandidateReasons(file.reasons) : '',
      ].filter(Boolean).join(' — ')),
    ].join('\n')
    : '';
  const matchesText = matches.length > 0
    ? [
      `状态：${status}`,
      `终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `查询：${queries}`,
      `命中片段：${matches.length}`,
      ...matches.map((match) => `- ${match.path}:${match.line} [${match.query}] ${match.snippet}`),
    ].join('\n')
    : '';
  const needsContinuation =
    result.partial === true ||
    !result.ok ||
    Boolean(limitReasons) ||
    result.terminalStatus === 'completed_empty';
  const continuationReason = needsContinuation
    ? presentExploreAgentContinuationReason({
      partial: result.partial === true,
      ok: result.ok,
      hasLimitReasons: Boolean(limitReasons),
      terminalStatus: result.terminalStatus,
    })
    : '';
  const continuationText = needsContinuation
    ? [
      '继续这次只读探索，不要修改文件。',
      continuationReason ? `续研原因：${continuationReason}` : '',
      `上一轮状态：${status}`,
      `上一轮终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `范围：${roots}`,
      `查询：${queries}`,
      `发现/读取：${filesDiscovered} / ${result.filesInspected} 个文件`,
      duration ? `上一轮耗时：${duration}` : '',
      ignoredPaths ? `继续忽略：${ignoredPaths}` : '',
      stoppingCondition ? `停止条件：${stoppingCondition}` : '',
      limitReasons ? `上一轮预算边界：${limitReasons}` : '',
      resultSummary ? `上一轮摘要：${resultSummary}` : '',
      candidateFiles.length > 0
        ? [
          '优先补读候选：',
          ...candidateFiles.slice(0, 5).map((file) => `- ${file.path}（分数 ${file.score}）`),
        ].join('\n')
        : '',
      matches.length > 0
        ? [
          '已有命中片段：',
          ...matches.slice(0, 5).map((match) => `- ${match.path}:${match.line} [${match.query}] ${match.snippet}`),
        ].join('\n')
        : '',
      '请只读检查仍缺证据的部分，输出新的证据锚点、候选文件、结论和下一步 gate。',
    ].filter((line) => line.trim().length > 0).join('\n')
    : '';

  function copyButtonState(key: string, idleLabel: string, copiedAria: string) {
    const phase = copyFeedback.phaseFor(key);
    return {
      phase,
      disabled: copyFeedback.isPending,
      label: phase === 'pending'
        ? '复制中…'
        : phase === 'copied'
          ? '已复制'
          : phase === 'failed'
            ? '复制失败'
            : idleLabel,
      ariaLabel: phase === 'pending'
        ? `${idleLabel}中`
        : phase === 'copied'
          ? copiedAria
          : phase === 'failed'
            ? `${idleLabel}失败`
            : idleLabel,
    };
  }

  const summaryCopy = copyButtonState('summary', '复制摘要', '已复制探索摘要');
  const continuationCopy = copyButtonState('continuation', '复制续研提示', '已复制续研提示');
  const processCopy = copyButtonState('process', '复制过程', '已复制探索过程');
  const evidenceCopy = copyButtonState('evidence', '复制证据', '已复制证据锚点');
  const reportCopy = copyButtonState('report', '复制报告', '已复制研究报告');
  const candidateCopy = copyButtonState('candidate', '复制候选', '已复制候选文件');
  const matchesCopy = copyButtonState('matches', '复制片段', '已复制命中片段');

  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'agent' }))} data-kind="explore_agent" data-ok={result.ok ? 'true' : 'false'}>
      <header className={previewVariants({ part: 'agent-head' })}>
        <strong>{redactSecrets(result.objective || '只读探索')}</strong>
        <small>
          {status} · 发现/读 {filesDiscovered} / {result.filesInspected} 个文件 · {skippedSummary} · {formatBytes(result.bytesRead)}
          {limitReasons ? ' · 受预算限制' : ''}
          {continuationReason ? ` · 建议续研：${continuationReason}` : ''}
          {duration ? ` · 耗时 ${duration}` : ''}
        </small>
        {resultSummary.length > 0 && (
          <div className={previewVariants({ part: 'agent-summary-line' })}>
            <small>{redactSecrets(resultSummary)}</small>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('summary', summaryText)}
              disabled={summaryCopy.disabled}
              aria-label={summaryCopy.ariaLabel}
              aria-busy={summaryCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={summaryCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={summaryCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={summaryCopy.phase === 'failed' ? 'true' : undefined}
            >
              {summaryCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{summaryCopy.label}</span>
            </UiButton>
          </div>
        )}
        {continuationText.length > 0 && (
          <div className={previewVariants({ part: 'agent-actions' })} aria-label="只读探索后续操作">
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('continuation', continuationText)}
              disabled={continuationCopy.disabled}
              aria-label={continuationCopy.ariaLabel}
              aria-busy={continuationCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={continuationCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={continuationCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={continuationCopy.phase === 'failed' ? 'true' : undefined}
              title="复制一段可继续只读探索的提示"
            >
              {continuationCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{continuationCopy.label}</span>
            </UiButton>
          </div>
        )}
      </header>
      {!result.ok && (
        <div className={previewVariants({ part: 'agent-message' })} role="note">
          {redactSecrets(result.message ?? '只读探索未完成。')}
        </div>
      )}
      <dl className={previewVariants({ part: 'agent-meta' })}>
        <div>
          <dt>终态</dt>
          <dd>{terminalStatus}</dd>
        </div>
        <div>
          <dt>发现/读</dt>
          <dd>{filesDiscovered} / {result.filesInspected} 个文件</dd>
        </div>
        <div>
          <dt>范围</dt>
          <dd>{redactSecrets(roots)}</dd>
        </div>
        <div>
          <dt>查询</dt>
          <dd>{redactSecrets(queries)}</dd>
        </div>
        {ignoredPaths && (
          <div>
            <dt>忽略</dt>
            <dd>{redactSecrets(ignoredPaths)}</dd>
          </div>
        )}
        {stoppingCondition && (
          <div>
            <dt>停止</dt>
            <dd>{redactSecrets(stoppingCondition)}</dd>
          </div>
        )}
        {limitReasons && (
          <div>
            <dt>边界</dt>
            <dd>{redactSecrets(limitReasons)}</dd>
          </div>
        )}
        {continuationReason && (
          <div>
            <dt>后续</dt>
            <dd>建议续研：{redactSecrets(continuationReason)}</dd>
          </div>
        )}
      </dl>
      {progress.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="探索过程">
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>过程</strong>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('process', processText)}
              disabled={processCopy.disabled}
              aria-label={processCopy.ariaLabel}
              aria-busy={processCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={processCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={processCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={processCopy.phase === 'failed' ? 'true' : undefined}
            >
              {processCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{processCopy.label}</span>
            </UiButton>
          </div>
          <ul>
            {progress.map((item, index) => (
              <li key={`${index}:${item.slice(0, 24)}`}>
                <span>{redactSecrets(item)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {evidence.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="证据锚点">
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>证据锚点</strong>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('evidence', evidenceText)}
              disabled={evidenceCopy.disabled}
              aria-label={evidenceCopy.ariaLabel}
              aria-busy={evidenceCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={evidenceCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={evidenceCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={evidenceCopy.phase === 'failed' ? 'true' : undefined}
            >
              {evidenceCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{evidenceCopy.label}</span>
            </UiButton>
          </div>
          <ul>
            {evidence.map((item, index) => (
              <li key={`${item.path}:${item.line ?? 'file'}:${index}`}>
                <code>
                  {redactSecrets(item.path)}
                  {typeof item.line === 'number' ? `:${item.line}` : ''}
                </code>
                <small>
                  {redactSecrets(item.label)}
                  {typeof item.score === 'number' ? ` · 分数 ${item.score}` : ''}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {reportLines.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="研究报告">
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>研究报告</strong>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('report', reportText)}
              disabled={reportCopy.disabled}
              aria-label={reportCopy.ariaLabel}
              aria-busy={reportCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={reportCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={reportCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={reportCopy.phase === 'failed' ? 'true' : undefined}
            >
              {reportCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{reportCopy.label}</span>
            </UiButton>
          </div>
          <ul>
            {reportLines.map((line, index) => (
              <li key={`${index}:${line.slice(0, 24)}`}>
                <span>{redactSecrets(line)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {candidateFiles.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="候选文件">
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>候选文件</strong>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('candidate', candidateText)}
              disabled={candidateCopy.disabled}
              aria-label={candidateCopy.ariaLabel}
              aria-busy={candidateCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={candidateCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={candidateCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={candidateCopy.phase === 'failed' ? 'true' : undefined}
            >
              {candidateCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{candidateCopy.label}</span>
            </UiButton>
          </div>
          <ul>
            {candidateFiles.map((file) => (
              <li key={file.path}>
                <code>{redactSecrets(file.path)}</code>
                <small>
                  分数 {file.score}
                  {file.reasons.length > 0 ? ` · ${presentExploreAgentCandidateReasons(file.reasons)}` : ''}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {matches.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="命中片段">
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>命中片段</strong>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('matches', matchesText)}
              disabled={matchesCopy.disabled}
              aria-label={matchesCopy.ariaLabel}
              aria-busy={matchesCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={matchesCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={matchesCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={matchesCopy.phase === 'failed' ? 'true' : undefined}
            >
              {matchesCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{matchesCopy.label}</span>
            </UiButton>
          </div>
          <ul>
            {matches.map((match, index) => (
              <li key={`${match.path}:${match.line}:${index}`}>
                <code>{redactSecrets(match.path)}:{match.line}</code>
                <small>{redactSecrets(match.query)}</small>
                <p>{redactSecrets(match.snippet)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {notes.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="探索说明">
          <strong>说明</strong>
          <ul>
            {notes.map((note, index) => (
              <li key={`${index}:${note.slice(0, 24)}`}>
                <span>{redactSecrets(note)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function presentExploreAgentTerminalStatus(
  terminalStatus: Extract<ToolResultContent, { kind: 'explore_agent' }>['terminalStatus'],
  ok: boolean,
  partial: boolean,
  reason: Extract<ToolResultContent, { kind: 'explore_agent' }>['reason'],
): string {
  switch (terminalStatus) {
    case 'completed':
      return '完成，有证据';
    case 'completed_empty':
      return '完成，无证据';
    case 'failed':
      return '失败';
    case 'canceled':
      return '已取消';
    case 'canceled_partial':
      return '已取消，有部分结果';
    case undefined:
      if (reason === 'aborted' && partial) return '已取消，有部分结果';
      if (reason === 'aborted') return '已取消';
      if (!ok) return '失败';
      return '完成';
    default:
      return '未知终态';
  }
}

function presentExploreAgentReason(
  reason: Extract<ToolResultContent, { kind: 'explore_agent' }>['reason'],
): string | undefined {
  switch (reason) {
    case 'invalid_objective':
      return '目标无效';
    case 'invalid_root':
      return '范围无效';
    case 'no_readable_roots':
      return '没有可读取范围';
    case 'aborted':
      return '已取消';
    case undefined:
      return undefined;
    default:
      return '未知诊断';
  }
}

function presentExploreAgentLimitReason(reason: string): string {
  switch (reason) {
    case 'candidate_budget':
      return '候选文件预算已满';
    case 'file_budget':
      return '读取文件预算已满';
    case 'match_budget':
      return '命中预算已满';
    case 'byte_budget':
      return '读取字节预算已满';
    default:
      return '';
  }
}

function presentExploreAgentContinuationReason(input: {
  partial: boolean;
  ok: boolean;
  hasLimitReasons: boolean;
  terminalStatus: Extract<ToolResultContent, { kind: 'explore_agent' }>['terminalStatus'];
}): string {
  if (input.partial) return '已有部分结果，仍需补证据';
  if (!input.ok) return '上一轮未完成';
  if (input.hasLimitReasons) return '达到预算边界';
  if (input.terminalStatus === 'completed_empty') return '没有找到证据';
  return '仍缺证据';
}

function formatExploreAgentEvent(event: { type: string; message: string; at?: number }, startedAt?: number): string {
  const label = presentExploreAgentEventType(event.type);
  const message = typeof event.message === 'string' ? event.message.trim() : '';
  const offset = formatExploreAgentEventOffset(event.at, startedAt);
  const prefix = [label, offset].filter(Boolean).join(' ');
  return prefix ? `${prefix}：${message}` : message;
}

function formatExploreAgentEventOffset(at: number | undefined, startedAt: number | undefined): string {
  if (typeof at !== 'number' || typeof startedAt !== 'number') return '';
  if (!Number.isFinite(at) || !Number.isFinite(startedAt)) return '';
  const delta = Math.max(0, Math.floor(at - startedAt));
  const formatted = formatDuration(delta);
  return formatted ? `+${formatted}` : '';
}

function presentExploreAgentEventType(type: string): string {
  switch (type) {
    case 'started':
      return '开始';
    case 'scope_resolved':
      return '范围';
    case 'scan':
      return '扫描';
    case 'read':
      return '读取';
    case 'checkpoint':
      return '进度';
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'aborted':
      return '取消';
    default:
      return '';
  }
}

function presentExploreAgentCandidateReasons(reasons: string[]): string {
  return reasons.map((reason) => {
    if (reason === 'content match') return '内容命中';
    if (reason === 'project manifest') return '项目配置';
    if (reason === 'project documentation') return '项目文档';
    if (reason === 'project entrypoint') return '入口文件';
    if (reason === 'project test surface') return '测试线索';
    if (reason === 'project source surface') return '源码线索';
    const pathMatch = reason.match(/^path contains "(.+)"$/);
    if (pathMatch) return `路径命中 ${redactSecrets(pathMatch[1] ?? '')}`;
    return '探索线索';
  }).join(', ');
}

/* PR-FORMAT-BYTES-DEDUP-0 (round 21/30): made exported so
   `apps/desktop/src/renderer/artifact-pane.tsx` can drop its
   local duplicate. Standardized on KB/MB labels (artifact-pane
   was already user-visible with KB/MB) plus the robust
   non-finite/<=0 guard from the previous components.tsx form.
   Both consumers now produce identical output for the same
   `bytes` input. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function OfficeDocumentPreview(props: {
  result: Extract<ToolResultContent, { kind: 'office_document' }>;
}) {
  const { result } = props;
  const stdout = capLines(redactSecrets(result.stdout ?? ''));
  const stderr = capLines(redactSecrets(result.stderr ?? ''));
  const message = result.message ? redactSecrets(result.message) : '';
  const args = result.args?.map((arg) => redactSecrets(arg)).join(' ');
  const title = result.path ? redactSecrets(result.path) : 'Office 文档';
  const operation = result.operation ? redactSecrets(result.operation) : '未执行';
  const reason = presentOfficeDocumentReason(result.reason);
  const hasOutput = stdout.body.length > 0 || stderr.body.length > 0;

  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'office' }))} data-kind="office_document" data-ok={result.ok ? 'true' : 'false'}>
      <header className={previewVariants({ part: 'office-head' })}>
        <strong>{title}</strong>
        <small>
          {operation}
          {result.ok ? ' · 已完成' : ' · 未完成'}
          {result.truncated ? ' · 输出已截断' : ''}
        </small>
      </header>
      {args && <code className={previewVariants({ part: 'office-args' })}>officecli {args}</code>}
      {!result.ok && (
        <div className={previewVariants({ part: 'office-message' })} role="note">
          <span>{message || 'Office 文档操作未完成。'}</span>
          {reason && <small>诊断：{reason}</small>}
        </div>
      )}
      {result.ok && !hasOutput && <p className={previewVariants({ part: 'office-empty' })}>（无输出）</p>}
      {stdout.body.length > 0 && (
        <pre className={previewVariants({ part: 'office-stream' })} data-stream="stdout">
          {stdout.body}
          {stdout.capped > 0 && `\n\n… stdout 已隐藏 ${stdout.capped} 行`}
        </pre>
      )}
      {stderr.body.length > 0 && (
        <pre className={previewVariants({ part: 'office-stream' })} data-stream="stderr">
          {stderr.body}
          {stderr.capped > 0 && `\n\n… stderr 已隐藏 ${stderr.capped} 行`}
        </pre>
      )}
    </div>
  );
}

function presentOfficeDocumentReason(reason: string | undefined): string | undefined {
  switch (reason) {
    case 'invalid_operation':
      return '操作不支持';
    case 'invalid_path':
      return '路径无效';
    case 'unsupported_extension':
      return '文件类型不支持';
    case 'missing_file':
      return '文件不存在';
    case 'not_file':
      return '不是文件';
    case 'symlink_escape':
      return '符号链接被拒绝';
    case 'invalid_selector':
      return '选择器无效';
    case 'invalid_query':
      return '查询表达式无效';
    case 'invalid_props':
      return '属性无效';
    case 'file_exists':
      return '文件已存在';
    case 'officecli_missing':
      return 'officecli 未安装';
    case 'officecli_timeout':
      return '操作超时';
    case 'officecli_failed':
      return '操作失败';
    case undefined:
      return undefined;
    default:
      return '未知诊断';
  }
}

/**
 * Line-level diff coloring. Splits the unified-diff text on newlines and
 * tags each line with `data-line="add" | "del" | "hunk" | "meta" | "ctx"`
 * for CSS to color. Doesn't try to parse the hunk semantics — we leave
 * that to a future inline editor view; this is just a readable preview.
 */
/**
 * PR-CHAT-WEB-SEARCH-RENDER-0 — plain-text card list for the gated
 * WebSearch agent tool result. Matches the Settings → 联网搜索 live-query
 * verification layout so the user gets the same shape whether the search came
 * from a manual verification run or the agent. Never renders markdown / HTML;
 * each cell is `redactSecrets`'d as a belt-and-braces guard against
 * a provider response that happened to echo a token.
 */
function WebSearchPreview(props: {
  query: string;
  provider: string;
  rows: ReadonlyArray<{ title: string; url: string; snippet: string; source: string }>;
}) {
  const rows = props.rows
    .map((row) => {
      const normalizedUrl = normalizeSearchUrl(row.url);
      if (!normalizedUrl.ok) return null;
      return { ...row, url: redactSecrets(normalizedUrl.value) };
    })
    .filter((row): row is { title: string; url: string; snippet: string; source: string } => row !== null);

  if (rows.length === 0) {
    return (
      <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'web-search' }))} data-kind="web_search">
        <header>
          <strong>{redactSecrets(props.query)}</strong>
          <small>{props.provider} · 没有结果</small>
        </header>
      </div>
    );
  }
  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'web-search' }))} data-kind="web_search">
      <header>
        <strong>{redactSecrets(props.query)}</strong>
        <small>
          {props.provider} · {rows.length} 条结果
        </small>
      </header>
      <ul>
        {rows.map((row, idx) => (
          <li key={`${row.url}-${idx}`}>
            <a href={row.url} target="_blank" rel="noreferrer noopener">
              {redactSecrets(row.title)}
            </a>
            <small>{redactSecrets(row.source)}</small>
            <p>{redactSecrets(row.snippet)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WebSearchErrorPreview(props: {
  query?: string;
  provider: string;
  reason: string;
  message: string;
  credentialSource?: string;
}) {
  const sourceCopy =
    props.credentialSource === 'env'
      ? '环境变量'
      : props.credentialSource === 'saved'
        ? '本机已保存 key'
        : props.credentialSource === 'none'
          ? '未配置'
          : '来源未知';
  const repairCopy =
    props.reason === 'invalid_credentials' && props.credentialSource === 'env'
      ? '请检查 TAVILY_API_KEY / MAKA_TAVILY_API_KEY 后重启。'
      : props.reason === 'invalid_credentials'
        ? '请在 设置 · 联网搜索 中更新 Tavily key。'
        : props.reason === 'rate_limited'
          ? 'Tavily 当前限流，请稍后重试或更换可用凭据。'
          : props.reason === 'not_configured'
            ? '请先完成联网搜索配置后再重试。'
            : props.reason === 'timeout'
              ? '请求超时，请稍后重试。'
              : props.reason === 'incognito_active'
                ? '隐私模式下不会发起联网搜索。'
                : '请检查网络或稍后重试。';
  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'web-search' }), previewVariants({ part: 'web-search-error' }))} data-kind="web_search_error">
      <header>
        <strong>{redactSecrets(props.query ?? '联网搜索')}</strong>
        <small>{redactSecrets(props.provider)} · 搜索失败 · {sourceCopy}</small>
      </header>
      <p className={previewVariants({ part: 'web-search-error-message' })}>{redactSecrets(props.message)}</p>
      <p className={previewVariants({ part: 'web-search-error-repair' })}>{repairCopy}</p>
    </div>
  );
}

function FileDiffPreview(props: { diff: string; paths: string[] }) {
  // Apply UI-level redaction then cap the displayed lines. Both are
  // @kenji's PR76 review items: never echo a token a tool happened to dump
  // into a diff (commit body, .env file diff, etc.), and never let a
  // 10k-line diff create 10k React elements.
  const { body, capped } = capLines(redactSecrets(props.diff));
  const lines = body.split('\n');
  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'diff' }))} data-kind="file_diff">
      {props.paths.length > 0 && (
        <div className={previewVariants({ part: 'diff-paths' })}>
          {props.paths.map((path) => (
            <code key={path}>{path}</code>
          ))}
        </div>
      )}
      <pre className={previewVariants({ part: 'diff-body' })}>
        {lines.map((line, index) => (
          <span
            key={`${index}:${line.slice(0, 16)}`}
            className={previewVariants({ part: 'diff-line' })}
            data-line={diffLineKind(line)}
          >
            {line || ' '}
            {'\n'}
          </span>
        ))}
        {capped > 0 && (
          <span className={previewVariants({ part: 'diff-line' })} data-line="meta">
            {`\n… 已隐藏 ${capped} 行\n`}
          </span>
        )}
      </pre>
    </div>
  );
}

function diffLineKind(line: string): 'add' | 'del' | 'hunk' | 'meta' | 'ctx' {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

/**
 * Terminal output preview. Shows the command + working directory header,
 * an exit-code badge tinted by success/failure, then stdout and stderr
 * in separate blocks (stderr only rendered when non-empty, in destructive
 * tone). Empty output gets an explicit "(no output)" placeholder so a
 * silent successful command doesn't look like a render bug.
 */
function TerminalPreview(props: {
  cwd: string;
  cmd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}) {
  const copyFeedback = useClipboardCopyFeedback();
  const succeeded = props.exitCode === 0;
  const hasOutput = props.stdout.length > 0 || props.stderr.length > 0;
  // Redact + cap stdout/stderr independently. `npm test` against a misconfigured
  // provider can dump megabytes of stderr; we keep the first TOOL_LINE_CAP
  // lines and append a hidden-count marker.
  const stdout = capLines(redactSecrets(props.stdout));
  const stderr = capLines(redactSecrets(props.stderr));
  // The cmd line is also user-runtime text — don't echo a `--api-key=...`
  // arg into the chat without masking it.
  const safeCmd = redactSecrets(props.cmd);
  const safeCwd = redactSecrets(props.cwd);
  const hiddenLines = stdout.capped + stderr.capped;
  const handoffText = [
    '终端输出需要继续研读',
    `工作目录：${safeCwd}`,
    `命令：${safeCmd}`,
    `退出码：${props.exitCode}`,
    `截断：stdout 已隐藏 ${stdout.capped} 行，stderr 已隐藏 ${stderr.capped} 行`,
    stdout.body.length > 0 ? `stdout 预览：\n${stdout.body}` : '',
    stderr.body.length > 0 ? `stderr 预览：\n${stderr.body}` : '',
    '请在深度研究 / 只读探索里结合相关路径确认完整输出影响和下一步。',
  ].filter((line) => line.length > 0).join('\n\n');

  const handoffCopyPhase = copyFeedback.phaseFor('handoff');
  const handoffCopyLabel = handoffCopyPhase === 'pending'
    ? '复制中…'
    : handoffCopyPhase === 'copied'
      ? '已复制'
      : handoffCopyPhase === 'failed'
        ? '复制失败'
        : '复制研读提示';
  const handoffCopyAria = handoffCopyPhase === 'pending'
    ? '复制终端研读提示中'
    : handoffCopyPhase === 'copied'
      ? '已复制终端研读提示'
      : handoffCopyPhase === 'failed'
        ? '复制终端研读提示失败'
        : '复制终端研读提示';

  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'terminal' }))} data-kind="terminal">
      <header className={previewVariants({ part: 'terminal-head' })}>
        <code className={previewVariants({ part: 'terminal-cwd' })}>{safeCwd}</code>
        <code className={previewVariants({ part: 'terminal-cmd' })}>$ {safeCmd}</code>
        <span
          className={previewVariants({ part: 'terminal-exit' })}
          data-ok={succeeded ? 'true' : 'false'}
          aria-label={`退出码 ${props.exitCode}`}
        >
          退出码 {props.exitCode}
        </span>
      </header>
      {!hasOutput && <p className={previewVariants({ part: 'terminal-empty' })}>（无输出）</p>}
      {props.stdout.length > 0 && (
        <pre className={previewVariants({ part: 'terminal-stream' })} data-stream="stdout">
          {stdout.body}
          {stdout.capped > 0 && `\n\n… stdout 已隐藏 ${stdout.capped} 行`}
        </pre>
      )}
      {props.stderr.length > 0 && (
        <pre className={previewVariants({ part: 'terminal-stream' })} data-stream="stderr">
          {stderr.body}
          {stderr.capped > 0 && `\n\n… stderr 已隐藏 ${stderr.capped} 行`}
        </pre>
      )}
      {hiddenLines > 0 && (
        <div className={previewVariants({ part: 'terminal-truncated-note' })}>
          <span>
            输出较长，当前只展示每路输出的前 {TOOL_LINE_CAP} 行。需要继续研读时，可以切到深度研究并把命令、相关路径和想确认的问题交给只读探索。
          </span>
          <UiButton
            type="button"
            variant="ghost"
            size="sm"
            className={previewVariants({ part: 'terminal-copy' })}
            onClick={() => void copyFeedback.copy('handoff', handoffText)}
            disabled={handoffCopyPhase === 'pending'}
            aria-label={handoffCopyAria}
            aria-busy={handoffCopyPhase === 'pending' ? 'true' : undefined}
            data-pending={handoffCopyPhase === 'pending' ? 'true' : undefined}
            data-copied={handoffCopyPhase === 'copied' ? 'true' : 'false'}
            data-copy-error={handoffCopyPhase === 'failed' ? 'true' : undefined}
          >
            {handoffCopyPhase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
            <span>{handoffCopyLabel}</span>
          </UiButton>
        </div>
      )}
    </div>
  );
}
